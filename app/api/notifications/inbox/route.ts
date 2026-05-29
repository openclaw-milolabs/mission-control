import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type Json = Record<string, unknown>;

const ok = (data: Json = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

async function workspaceId(sql: ReturnType<typeof getSql>) {
  const rows = await sql`select id from workspaces order by created_at asc limit 1`;
  return rows[0]?.id ?? null;
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);

    const sql = getSql();
    const wid = await workspaceId(sql);
    if (!wid) return ok({ notifications: [], unread: 0 });

    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 30), 1), 100);
    const recipient = session.email.toLowerCase();

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
      where lower(n.recipient_email) = ${recipient} and n.workspace_id = ${wid}
      order by n.read_at is null desc, n.created_at desc
      limit ${limit}
    `;

    const unreadRow = await sql`
      select count(*)::int as count
      from notifications
      where lower(recipient_email) = ${recipient} and workspace_id = ${wid} and read_at is null
    `;

    // Backfill recipient_sub on first read by anyone with this email — cheap and idempotent.
    if (session.sub) {
      await sql`
        update notifications
        set recipient_sub = ${session.sub}
        where lower(recipient_email) = ${recipient} and (recipient_sub is null or recipient_sub = '')
      `;
    }

    return ok({ notifications: rows, unread: Number(unreadRow[0]?.count || 0) });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to load inbox", 500);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);

    const sql = getSql();
    const wid = await workspaceId(sql);
    if (!wid) return ok();

    const body = (await request.json()) as Json;
    const action = String(body.action || "");
    const recipient = session.email.toLowerCase();

    if (action === "markRead") {
      const notificationId = String(body.notificationId || "");
      if (!notificationId) return fail("notificationId is required.");
      await sql`
        update notifications set read_at = now()
        where id = ${notificationId} and lower(recipient_email) = ${recipient} and read_at is null
      `;
      return ok();
    }

    if (action === "markAllRead") {
      await sql`
        update notifications set read_at = now()
        where lower(recipient_email) = ${recipient} and workspace_id = ${wid} and read_at is null
      `;
      return ok();
    }

    return fail(`Unsupported action: ${action}`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Inbox operation failed", 500);
  }
}
