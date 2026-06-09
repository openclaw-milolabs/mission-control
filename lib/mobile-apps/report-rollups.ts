import { getSql } from "@/lib/local-db";

type Sql = ReturnType<typeof getSql>;

/** jsonb may arrive as an object or a JSON string depending on the driver path. */
function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

export type DailyRollupRow = {
  listingId: string;
  report: string;
  date: string;
  metrics: Record<string, unknown>;
  source: string | null;
};

export type BreakdownRow = {
  listingId: string;
  report: string;
  dimension: string;
  dimensionValue: string;
  date: string;
  metrics: Record<string, unknown>;
  dimensions: unknown;
  source: string | null;
};

/**
 * Rebuild the pre-aggregated rollups for one listing from its raw report metrics.
 * All aggregation happens in SQL (never summed in Node), and the listing's rollup
 * rows are deleted first so a re-run converges to the latest official data without
 * leaving stale keys behind. Idempotent: same input → same output.
 *
 * Dimension contract (this is the whole point — avoids double-counting):
 *   installs / crashes   → `overview` dimension only
 *   store_performance    → sum across the `country` dimension
 *   latest breakdowns    → every non-overview dimension EXCEPT ratings
 */
export async function refreshReportRollups(sql: Sql, listingId: string): Promise<void> {
  await sql`delete from mobile_app_report_daily_rollups where listing_id = ${listingId}::uuid`;
  await sql`delete from mobile_app_report_latest_breakdowns where listing_id = ${listingId}::uuid`;

  // installs + crashes: the report's own 'overview' row is already the daily total.
  // Summing other dimensions (country/device/app_version) double-counts the same
  // installs, so we take overview only.
  await sql`
    insert into mobile_app_report_daily_rollups (listing_id, report, metric_date, metrics, source, updated_at)
    select listing_id, report, metric_date, metrics, max(source), now()
    from mobile_app_report_metrics
    where listing_id = ${listingId}::uuid
      and report in ('installs','crashes')
      and dimension = 'overview'
    group by listing_id, report, metric_date, metrics
    on conflict (listing_id, report, metric_date)
    do update set metrics = excluded.metrics, source = excluded.source, updated_at = now()
  `;

  // store_performance has no overview row; sum the per-country rows into a daily
  // total. Only well-formed numeric values are summed.
  await sql`
    with numeric_metrics as (
      select m.listing_id, m.report, m.metric_date, e.key, sum(e.value::numeric) as value
      from mobile_app_report_metrics m
      cross join lateral jsonb_each_text(m.metrics) e(key, value)
      where m.listing_id = ${listingId}::uuid
        and m.report = 'store_performance'
        and m.dimension = 'country'
        and e.value ~ '^-?[0-9]+(\.[0-9]+)?$'
      group by m.listing_id, m.report, m.metric_date, e.key
    ),
    daily as (
      select listing_id, report, metric_date, jsonb_object_agg(key, value) as metrics
      from numeric_metrics
      group by listing_id, report, metric_date
    )
    insert into mobile_app_report_daily_rollups (listing_id, report, metric_date, metrics, source, updated_at)
    select listing_id, report, metric_date, metrics, 'google_play_console_store_performance_report', now()
    from daily
    on conflict (listing_id, report, metric_date)
    do update set metrics = excluded.metrics, source = excluded.source, updated_at = now()
  `;

  // Latest row per non-overview breakdown so the detail payload can show
  // country/device/app_version/... breakdowns bounded. Ratings are excluded: they
  // are loaded into the listing's official ratings, not used as a chart breakdown.
  await sql`
    insert into mobile_app_report_latest_breakdowns
      (listing_id, report, dimension, dimension_value, metric_date, metrics, dimensions, source, updated_at)
    select distinct on (listing_id, report, dimension, dimension_value)
      listing_id, report, dimension, dimension_value, metric_date, metrics, dimensions, source, now()
    from mobile_app_report_metrics
    where listing_id = ${listingId}::uuid
      and dimension <> 'overview'
      and report <> 'ratings'
    order by listing_id, report, dimension, dimension_value, metric_date desc
    on conflict (listing_id, report, dimension, dimension_value)
    do update set
      metric_date = excluded.metric_date,
      metrics = excluded.metrics,
      dimensions = excluded.dimensions,
      source = excluded.source,
      updated_at = now()
  `;
}

/** Bounded daily series for charts, read from the pre-aggregated rollup table. */
export async function readReportRollups(sql: Sql, listingIds: string[]): Promise<DailyRollupRow[]> {
  if (listingIds.length === 0) return [];
  const rows = (await sql`
    select listing_id::text, report, to_char(metric_date, 'YYYY-MM-DD') as date, metrics, source
    from mobile_app_report_daily_rollups
    where listing_id = any(${sql.array(listingIds)}::uuid[])
      and report in ('installs','crashes','store_performance')
    order by report, metric_date asc
  `) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    listingId: String(r.listing_id),
    report: String(r.report),
    date: String(r.date),
    metrics: asObject(r.metrics),
    source: r.source == null ? null : String(r.source),
  }));
}

/** Latest non-overview breakdowns, bounded so the detail payload can't blow up. */
export async function readLatestBreakdowns(
  sql: Sql,
  listingIds: string[],
  opts: { limit?: number } = {},
): Promise<BreakdownRow[]> {
  if (listingIds.length === 0) return [];
  const limit = Math.min(Math.max(1, opts.limit ?? 500), 2000);
  const rows = (await sql`
    select listing_id::text, report, dimension, dimension_value,
           to_char(metric_date, 'YYYY-MM-DD') as date, metrics, dimensions, source
    from mobile_app_report_latest_breakdowns
    where listing_id = any(${sql.array(listingIds)}::uuid[])
    order by report, dimension, dimension_value
    limit ${limit}
  `) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    listingId: String(r.listing_id),
    report: String(r.report),
    dimension: String(r.dimension),
    dimensionValue: String(r.dimension_value ?? ""),
    date: String(r.date),
    metrics: asObject(r.metrics),
    dimensions: r.dimensions ?? null,
    source: r.source == null ? null : String(r.source),
  }));
}
