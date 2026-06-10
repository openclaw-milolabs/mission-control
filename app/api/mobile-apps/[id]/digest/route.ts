import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { generateDigest } from "@/lib/mobile-apps/digest";
import { ensureMobileAppsSchema } from "@/lib/mobile-apps/ensure-schema";
import { isUuid } from "@/lib/mobile-apps/ids";

export const dynamic = "force-dynamic";

const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

async function workspaceId(sql: ReturnType<typeof getSql>) {
  const rows = (await sql`select id from workspaces order by created_at asc limit 1`) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);
    const { id } = await params;
    if (!isUuid(id)) return fail("App not found", 404);
    const sql = getSql();
    await ensureMobileAppsSchema(sql);
    const wid = await workspaceId(sql);
    if (!wid) return ok({ digests: [] });
    const digests = await sql`
      select d.id::text, d.period_start, d.period_end, d.summary_md, d.sentiment_score, d.top_themes, d.generated_by_agent_id, d.created_at
      from app_review_digests d
      join mobile_apps a on a.id = d.mobile_app_id
      where d.mobile_app_id = ${id}::uuid and a.workspace_id = ${wid}::uuid
      order by d.created_at desc
      limit 20
    `;
    return ok({ digests });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to load digests", 500);
  }
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);
    const { id } = await params;
    if (!isUuid(id)) return fail("App not found", 404);
    const sql = getSql();
    await ensureMobileAppsSchema(sql);
    const wid = await workspaceId(sql);
    if (!wid) return fail("App not found", 404);
    const owned = (await sql`select 1 from mobile_apps where id = ${id}::uuid and workspace_id = ${wid}::uuid limit 1`) as unknown as Array<unknown>;
    if (owned.length === 0) return fail("App not found", 404);
    const digestId = await generateDigest(id);
    return ok({ id: digestId });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to generate digest", 500);
  }
}
