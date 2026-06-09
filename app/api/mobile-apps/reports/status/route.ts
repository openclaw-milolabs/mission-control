import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { isModuleEnabled } from "@/lib/modules/state";
import { ensureMobileAppsSchema } from "@/lib/mobile-apps/ensure-schema";
import { requireMobileAppsApiAuth } from "@/lib/mobile-apps/api-auth";

export const dynamic = "force-dynamic";

const fail = (message: string, status = 400) => NextResponse.json({ ok: false, error: message }, { status });

const uuidOrNull = (v: string | null) => (v && /^[0-9a-fA-F-]{36}$/.test(v) ? v : null);

/**
 * Poll endpoint for UI and future skills. Returns recent report-sync jobs and the
 * per-listing freshness rows, filtered by jobId / appId / listingId. Read-only.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireMobileAppsApiAuth(request);
    if (!auth) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const { searchParams } = new URL(request.url);
    const jobId = uuidOrNull(searchParams.get("jobId"));
    const appId = uuidOrNull(searchParams.get("appId"));
    const listingId = uuidOrNull(searchParams.get("listingId"));

    const sql = getSql();
    await ensureMobileAppsSchema(sql);

    const jobs = await sql`
      select id::text, status, mode, store, reason,
             mobile_app_id::text as "appId", listing_id::text as "listingId",
             to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "createdAt",
             to_char(started_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "startedAt",
             to_char(heartbeat_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "heartbeatAt",
             to_char(finished_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "finishedAt",
             error_message as "errorMessage", warnings, stats
      from mobile_app_report_sync_jobs
      where (${jobId}::uuid is null or id = ${jobId}::uuid)
        and (${appId}::uuid is null or mobile_app_id = ${appId}::uuid)
        and (${listingId}::uuid is null or listing_id = ${listingId}::uuid)
      order by created_at desc
      limit 20
    `;

    // Freshness is per-listing, so it is only meaningful when scoped to an app or
    // listing (avoids dumping every listing's row for a bare jobId query).
    const freshness =
      appId || listingId
        ? await sql`
            select listing_id::text, status,
                   latest_official_yyyy_mm, latest_processed_yyyy_mm,
                   latest_official_generation, latest_processed_generation,
                   to_char(checked_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "checkedAt",
                   to_char(processed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "processedAt",
                   active_job_id::text as "activeJobId", error_message as "errorMessage", warnings
            from mobile_app_report_freshness
            where (${listingId}::uuid is null or listing_id = ${listingId}::uuid)
              and (${appId}::uuid is null or listing_id in (
                select id from mobile_app_listings where mobile_app_id = ${appId}::uuid
              ))
          `
        : [];

    return NextResponse.json({ ok: true, jobs, freshness });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to read report status", 500);
  }
}
