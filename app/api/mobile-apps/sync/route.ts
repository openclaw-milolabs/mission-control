import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { syncApp } from "@/lib/mobile-apps/sync";
import { getSql } from "@/lib/local-db";

export const dynamic = "force-dynamic";

const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const body = (await request.json().catch(() => ({}))) as { appId?: string; force?: boolean };
    const force = Boolean(body.force);

    const sql = getSql();
    let appIds: string[];
    if (body.appId) {
      appIds = [body.appId];
    } else {
      const rows = (await sql`select id::text from mobile_apps`) as unknown as Array<{ id: string }>;
      appIds = rows.map((r) => r.id);
    }

    const results = [];
    for (const id of appIds) {
      results.push({ appId: id, listings: await syncApp(id, { force }) });
    }
    return ok({ results });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Sync failed", 500);
  }
}
