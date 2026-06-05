import { getSql } from "@/lib/local-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const sql = getSql();
  const encoder = new TextEncoder();
  const { signal } = request;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let cleanupStarted = false;

      const cleanup = () => {
        if (cleanupStarted) return;
        cleanupStarted = true;
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        if (unlistenMobileApps) unlistenMobileApps().catch(() => {});
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const send = (event: string, data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          cleanup();
        }
      };

      // Heartbeat every 25s
      const heartbeat = setInterval(() => send("ping", "keepalive"), 25_000);

      let unlistenMobileApps: (() => Promise<void>) | null = null;

      signal.addEventListener("abort", cleanup, { once: true });

      // Send initial connected event
      send("connected", JSON.stringify({ ts: Date.now() }));

      // Listen for mobile app sync changes
      try {
        const meta = await sql.listen("mobile_apps_change", (payload: string) => {
          send("change", String(payload || "{}"));
        });
        unlistenMobileApps = () => meta.unlisten();
      } catch {
        /* graceful degradation */
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
