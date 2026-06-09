import { NextResponse } from "next/server";
import { z } from "zod";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { ensureMobileAppsSchema } from "@/lib/mobile-apps/ensure-schema";
import { syncApp } from "@/lib/mobile-apps/sync";
import { checkOfficialReportFreshness, type FreshnessResult } from "@/lib/mobile-apps/report-freshness";
import { enqueueReportSyncJob } from "@/lib/mobile-apps/report-jobs";

export const dynamic = "force-dynamic";

const fail = (message: string, status = 400) => NextResponse.json({ ok: false, error: message }, { status });

async function workspaceId(sql: ReturnType<typeof getSql>) {
  const rows = (await sql`select id from workspaces order by created_at asc limit 1`) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

const bodySchema = z.object({
  consistency: z.enum(["strict", "available"]).default("available"),
  includeReports: z.boolean().default(true),
});

// Worst-first so the headline status reflects whatever needs attention.
const STATUS_ORDER: FreshnessResult["status"][] = ["failed", "stale", "refreshing", "unknown", "not_configured", "fresh"];
const NOT_FRESH = new Set<FreshnessResult["status"]>(["failed", "stale", "refreshing"]);

/**
 * The API-first freshness control plane. Refreshes light live sources (reviews +
 * primary rating) immediately, then cheaply checks whether the heavy Google Play
 * reports are fresh. If they are stale it queues the detached worker. It never does
 * heavy ETL itself and — in strict mode — never returns stale report data as fresh.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const { id } = await params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return fail("Invalid ensure-fresh request.", 422);
    const { consistency, includeReports } = parsed.data;

    const sql = getSql();
    await ensureMobileAppsSchema(sql);
    const wid = await workspaceId(sql);
    if (!wid) return fail("App not found", 404);
    const appRows = (await sql`
      select id from mobile_apps where id = ${id}::uuid and workspace_id = ${wid}::uuid limit 1
    `) as unknown as Array<{ id: string }>;
    if (!appRows[0]) return fail("App not found", 404);

    const listings = (await sql`
      select id::text, store from mobile_app_listings where mobile_app_id = ${id}::uuid
    `) as unknown as Array<{ id: string; store: string }>;
    const googleListings = listings.filter((l) => l.store === "google");

    // 1. Light live sync — reviews + primary rating only, both stores. Never heavy.
    await syncApp(id, { force: true, syncReports: false, syncAppleStorefronts: false }).catch(() => null);

    // 2. Cheap official-report freshness check per Google listing (metadata only).
    const results: Array<{ listingId: string } & FreshnessResult> = [];
    if (includeReports) {
      for (const l of googleListings) {
        const r = await checkOfficialReportFreshness(sql, l.id).catch(
          () =>
            ({
              status: "unknown",
              needsWorker: false,
              latestOfficialYyyyMm: null,
              latestProcessedYyyyMm: null,
              latestOfficialGeneration: null,
              latestProcessedGeneration: null,
              activeJobId: null,
              warnings: [],
            }) satisfies FreshnessResult,
        );
        results.push({ listingId: l.id, ...r });
      }
    }

    const worst = STATUS_ORDER.find((s) => results.some((r) => r.status === s)) ?? "fresh";
    const reportsFresh = !NOT_FRESH.has(worst);

    // 3. Queue the worker if any listing is stale (not on 'failed' — avoid retry spam).
    let jobId: string | null = results.find((r) => r.status === "refreshing")?.activeJobId ?? null;
    if (results.some((r) => r.status === "stale")) {
      const { job } = await enqueueReportSyncJob(sql, {
        appId: id,
        store: "google",
        mode: "incremental",
        reason: "ensure-fresh",
        requestedBy: session.email,
      });
      jobId = job.id;
    }

    const freshness = {
      googleReports: {
        status: worst,
        reportsFresh,
        listings: results.map((r) => ({
          listingId: r.listingId,
          status: r.status,
          latestOfficialMonth: r.latestOfficialYyyyMm,
          latestProcessedMonth: r.latestProcessedYyyyMm,
        })),
      },
    };

    if (consistency === "strict") {
      if (reportsFresh) {
        return NextResponse.json({ ok: true, status: "fresh", fresh: true, freshness });
      }
      if (worst === "failed") {
        return NextResponse.json(
          { ok: false, status: "failed", fresh: false, error: "Latest official report exists but could not be processed.", freshness },
          { status: 503 },
        );
      }
      return NextResponse.json(
        {
          ok: true,
          status: "refreshing",
          fresh: false,
          jobId,
          retryAfterSeconds: 5,
          message: "Live data is fresh. Google Play reports are refreshing from the latest official CSVs.",
          freshness,
        },
        { status: 202 },
      );
    }

    // available: never block; report the truth so the UI can label "refreshing".
    return NextResponse.json({ ok: true, status: worst, fresh: reportsFresh, reportsFresh, jobId, freshness });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to ensure freshness", 500);
  }
}
