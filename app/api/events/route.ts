import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

function sse(data: unknown, event = "message") {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET() {
  const sql = getSql();
  const encoder = new TextEncoder();

  let keepAlive: ReturnType<typeof setInterval> | null = null;
  let listenerActivity: { unlisten: () => Promise<void> } | null = null;
  let listenerNotification: { unlisten: () => Promise<void> } | null = null;
  let closed = false;

  // Capture the current user once at stream start so we can scope notification fanout.
  const session = await getSession().catch(() => null);
  const recipientEmail = session?.email?.toLowerCase() || null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const cleanup = async () => {
        if (closed) return;
        closed = true;
        if (keepAlive) clearInterval(keepAlive);
        keepAlive = null;
        if (listenerActivity) await listenerActivity.unlisten().catch(() => {});
        listenerActivity = null;
        if (listenerNotification) await listenerNotification.unlisten().catch(() => {});
        listenerNotification = null;
        try { controller.close(); } catch { /* already closed */ }
      };

      const send = async (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          await cleanup();
        }
      };

      await send(sse({ connected: true }, "ready"));

      keepAlive = setInterval(() => {
        void send(sse({ ok: true }, "ping"));
      }, 20000);

      // Note: worker_tick listener removed in v2 (BullMQ/Redis removed; execution via openclaw cron)

      // Listen for ticket activity notifications (by ID)
      listenerActivity = await sql.listen("ticket_activity", async (payload) => {
        const id = String(payload || "").trim();
        if (!id) return;
        try {
          const rows = await sql`
            select
              ta.id,
              ta.ticket_id,
              ta.source,
              ta.event,
              ta.details,
              ta.level,
              ta.actor_name,
              ta.actor_email,
              ta.occurred_at,
              t.title as ticket_title,
              t.board_id
            from ticket_activity ta
            left join tickets t on t.id = ta.ticket_id
            where ta.id::text = ${id}
            limit 1
          `;
          const row = rows[0] || null;
          if (!row) return;
          await send(sse({ row }, "ticket_activity"));
        } catch {
          // ignore
        }
      });

      // Listen for notifications scoped to this session user.
      if (recipientEmail) {
        listenerNotification = await sql.listen("notification", async (payload) => {
          const id = String(payload || "").trim();
          if (!id) return;
          try {
            const rows = await sql`
              select
                n.id,
                n.kind,
                n.actor_name,
                n.actor_email,
                n.board_id,
                n.ticket_id,
                n.comment_id,
                n.preview,
                n.read_at,
                n.created_at,
                t.title as ticket_title,
                b.name as board_name
              from notifications n
              left join tickets t on t.id = n.ticket_id
              left join boards b on b.id = n.board_id
              where n.id::text = ${id} and lower(n.recipient_email) = ${recipientEmail}
              limit 1
            `;
            const row = rows[0] || null;
            if (!row) return;
            await send(sse({ row }, "notification"));
          } catch {
            // ignore
          }
        });
      }
    },
    async cancel() {
      closed = true;
      if (keepAlive) clearInterval(keepAlive);
      keepAlive = null;
      if (listenerActivity) await listenerActivity.unlisten().catch(() => {});
      listenerActivity = null;
      if (listenerNotification) await listenerNotification.unlisten().catch(() => {});
      listenerNotification = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
