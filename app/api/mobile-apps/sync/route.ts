import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { syncApp } from "@/lib/mobile-apps/sync";
import { getSql } from "@/lib/local-db";

export const dynamic = "force-dynamic";

const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

const bodySchema = z.object({
  appId: z.string().uuid().optional(),
  force: z.boolean().optional(),
  // Force re-download of Google Play Console report CSVs instead of using the DB cache.
  refreshReports: z.boolean().optional(),
  // Set false for quick page/tab syncs so the heavy Google Play report scan does not block the UI.
  syncReports: z.boolean().optional(),
  // "all" (default) syncs every store; otherwise restrict to one store.
  store: z.enum(["google", "apple", "all"]).optional(),
});

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return fail("Invalid sync request.", 422);
    const { appId, force, refreshReports, syncReports } = parsed.data;
    const storeFilter = parsed.data.store && parsed.data.store !== "all" ? parsed.data.store : undefined;

    const sql = getSql();
    let appIds: string[];
    if (appId) {
      appIds = [appId];
    } else {
      const rows = (await sql`select id::text from mobile_apps`) as unknown as Array<{ id: string }>;
      appIds = rows.map((r) => r.id);
    }

    const results = [];
    for (const id of appIds) {
      results.push({
        appId: id,
        listings: await syncApp(id, {
          force: Boolean(force),
          refreshReports: Boolean(refreshReports),
          syncReports,
          store: storeFilter,
        }),
      });
    }

    // Roll the per-listing results up by store so the client can show
    // google/apple status, fetched + upserted counts, and any failure reason.
    const byStore: Record<
      string,
      { fetched: number; upserted: number; failed: number; skipped: number; error: string | null }
    > = {};
    for (const app of results) {
      for (const l of app.listings) {
        const s = (byStore[l.store] ??= { fetched: 0, upserted: 0, failed: 0, skipped: 0, error: null });
        s.fetched += l.fetched;
        s.upserted += l.inserted;
        if (l.status === "failed") {
          s.failed += 1;
          s.error = s.error ?? l.error;
        }
        if (l.status === "skipped") s.skipped += 1;
      }
    }

    return ok({ results, byStore });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Sync failed", 500);
  }
}
