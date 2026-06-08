import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { ensureMobileAppsSchema } from "@/lib/mobile-apps/ensure-schema";
import { loadMobileReviewsConfig } from "@/lib/mobile-apps/config";

export const dynamic = "force-dynamic";

const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

async function workspaceId(sql: ReturnType<typeof getSql>) {
  const rows = (await sql`select id from workspaces order by created_at asc limit 1`) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/** jsonb metrics may arrive as an object or a JSON string depending on the driver. */
function asMetricsObject(v: unknown): Record<string, number | null> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, number | null>;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" ? (p as Record<string, number | null>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const { id } = await params;
    const sql = getSql();
    await ensureMobileAppsSchema(sql);
    const wid = await workspaceId(sql);
    if (!wid) return fail("App not found", 404);

    const appRows = (await sql`
      select id::text, name, icon_url, notes from mobile_apps where id = ${id}::uuid and workspace_id = ${wid}::uuid limit 1
    `) as unknown as Array<Record<string, unknown>>;
    if (!appRows[0]) return fail("App not found", 404);

    const listings = (await sql`
      select id::text, store, store_app_id, country, current_rating::float8 as current_rating, ratings_count,
             official_ratings, rating_source, rating_as_of, last_synced_at
      from mobile_app_listings where mobile_app_id = ${id}::uuid
    `) as unknown as Array<{ id: string; store: string }>;
    const listingIds = listings.map((l) => l.id);

    // Review-based daily average rating per store (clean trend, no snapshot noise).
    const trend =
      listingIds.length === 0
        ? []
        : await sql`
            select
              l.store,
              to_char(date_trunc('day', r.submitted_at), 'YYYY-MM-DD') as day,
              round(avg(r.rating)::numeric, 2)::float8 as avg,
              count(*)::int as count
            from app_reviews r
            join mobile_app_listings l on l.id = r.listing_id
            where r.listing_id = any(${sql.array(listingIds)}::uuid[])
              and r.submitted_at is not null and r.rating is not null
            group by l.store, date_trunc('day', r.submitted_at)
            order by day asc
          `;

    // Latest sync run per listing → "last sync status/error per store".
    const syncRuns =
      listingIds.length === 0
        ? []
        : await sql`
            select distinct on (run.listing_id)
              run.listing_id::text, run.store, run.status, run.started_at, run.finished_at,
              run.fetched_count, run.upserted_count, run.error_message, run.report_status, run.report_warnings
            from app_review_sync_runs run
            where run.listing_id = any(${sql.array(listingIds)}::uuid[])
            order by run.listing_id, run.started_at desc
          `;

    // Server-computed per-store summary over ALL stored reviews (not just the
    // page returned above). Negative threshold comes from secrets.env config.
    const negativeThreshold = loadMobileReviewsConfig().sync.negativeThreshold;
    const summary =
      listingIds.length === 0
        ? []
        : await sql`
            select
              l.store,
              count(r.*)::int as total,
              round(avg(r.rating)::numeric, 2)::float8 as avg_rating,
              count(*) filter (where r.rating = 1)::int as r1,
              count(*) filter (where r.rating = 2)::int as r2,
              count(*) filter (where r.rating = 3)::int as r3,
              count(*) filter (where r.rating = 4)::int as r4,
              count(*) filter (where r.rating = 5)::int as r5,
              count(*) filter (where r.rating is not null and r.rating <= ${negativeThreshold})::int as negative,
              max(r.submitted_at) as latest_review_at
            from app_reviews r
            join mobile_app_listings l on l.id = r.listing_id
            where r.listing_id = any(${sql.array(listingIds)}::uuid[])
            group by l.store
          `;

    // Play Console bulk-report data is Google-only. It is intentionally not
    // mixed into the App Store view because Google reports are monthly CSV exports
    // with dimensions, while Apple uses storefront lookup/reviews APIs.
    const reports: Record<string, Array<Record<string, unknown>>> = {};
    const googleListingIds = listings.filter((l) => l.store === "google").map((l) => l.id);
    if (googleListingIds.length > 0) {
      const seriesRows = (await sql`
        select report, to_char(metric_date, 'YYYY-MM-DD') as date, metrics
        from mobile_app_report_metrics
        where listing_id = any(${sql.array(googleListingIds)}::uuid[])
          and report in ('installs','crashes')
        order by metric_date asc
      `) as unknown as Array<{ report: string; date: string; metrics: unknown }>;
      const rollup = new Map<string, Map<string, Record<string, number>>>();
      for (const r of seriesRows) {
        const m = asMetricsObject(r.metrics);
        const dates = rollup.get(r.report) ?? new Map<string, Record<string, number>>();
        const agg = dates.get(r.date) ?? {};
        for (const [k, v] of Object.entries(m)) if (typeof v === "number") agg[k] = (agg[k] ?? 0) + v;
        dates.set(r.date, agg);
        rollup.set(r.report, dates);
      }
      for (const [report, dates] of rollup) {
        reports[report] = [...dates.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([date, metrics]) => ({ date, metrics }));
      }

      const storePerf = (await sql`
        select to_char(metric_date, 'YYYY-MM-DD') as date,
               sum((metrics->>'store_listing_visitors')::numeric)::float8 as visitors,
               sum((metrics->>'store_listing_acquisitions')::numeric)::float8 as acquisitions
        from mobile_app_report_metrics
        where listing_id = any(${sql.array(googleListingIds)}::uuid[])
          and report = 'store_performance'
          and dimension = 'country'
        group by metric_date order by metric_date asc
      `) as unknown as Array<{ date: string; visitors: number | null; acquisitions: number | null }>;
      if (storePerf.length > 0) {
        reports.store_performance = storePerf.map((r) => ({
          date: r.date,
          metrics: { store_listing_visitors: r.visitors, store_listing_acquisitions: r.acquisitions },
        }));
      }

      // Top acquisition traffic sources (latest available date).
      const traffic = (await sql`
        select dimensions, metrics
        from mobile_app_report_metrics
        where listing_id = any(${sql.array(googleListingIds)}::uuid[])
          and report = 'store_performance' and dimension = 'traffic_source'
          and metric_date = (
            select max(metric_date) from mobile_app_report_metrics
            where listing_id = any(${sql.array(googleListingIds)}::uuid[])
              and report = 'store_performance' and dimension = 'traffic_source'
          )
        order by (metrics->>'store_listing_acquisitions')::numeric desc nulls last
        limit 12
      `) as unknown as Array<{ dimensions: unknown; metrics: unknown }>;
      if (traffic.length > 0) reports.traffic_sources = traffic.map((r) => ({ dimensions: r.dimensions, metrics: r.metrics }));

      // Latest row for every downloaded report/dimension/value so the Google Play
      // layout can show device/country/app-version/language/OS breakdowns.
      const breakdowns = (await sql`
        select * from (
          select distinct on (report, dimension, dimension_value)
            report, dimension, dimension_value, to_char(metric_date, 'YYYY-MM-DD') as date, metrics, dimensions
          from mobile_app_report_metrics
          where listing_id = any(${sql.array(googleListingIds)}::uuid[])
          order by report, dimension, dimension_value, metric_date desc
        ) latest
        order by report, dimension, dimension_value
        limit 1000
      `) as unknown as Array<Record<string, unknown>>;
      if (breakdowns.length > 0) reports.breakdowns = breakdowns;

      // CSV cache index grouped in the UI by year/month. No raw CSV/key material is returned.
      const files = (await sql`
        select report, dimension, object_path, yyyy_mm, generation, size_bytes,
               to_char(downloaded_at, 'YYYY-MM-DD HH24:MI') as downloaded_at,
               to_char(parsed_at, 'YYYY-MM-DD HH24:MI') as parsed_at,
               rows_count, status, error_message
        from mobile_app_report_files
        where listing_id = any(${sql.array(googleListingIds)}::uuid[])
        order by yyyy_mm desc nulls last, report asc, dimension asc, object_path asc
        limit 2000
      `) as unknown as Array<Record<string, unknown>>;
      if (files.length > 0) reports.files = files;
    }

    return ok({ app: appRows[0], listings, trend, syncRuns, summary, negativeThreshold, reports });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to load app", 500);
  }
}
