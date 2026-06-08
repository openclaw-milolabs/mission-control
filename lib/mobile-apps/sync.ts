import { createHash } from "node:crypto";
import pLimit from "p-limit";
import { getSql } from "@/lib/local-db";
import { loadMobileReviewsConfig, type GoogleConfig } from "@/lib/mobile-apps/config";
import { summarizeReviews } from "@/lib/mobile-apps/metrics";
import { getProvider } from "@/lib/mobile-apps/providers";
import { fetchAppleTerritoryRatings, type TerritoryRating } from "@/lib/mobile-apps/providers/app-store-ratings";
import {
  downloadReportFile,
  listReportFiles,
  parseRatingsCsv,
  parseReportCsv,
  parseReportRecordsMulti,
  reportNotFoundWarning,
  RATINGS_DIMENSIONS,
  INSTALLS_DIMENSIONS,
  CRASHES_DIMENSIONS,
  STORE_PERFORMANCE_COUNTRY_DIMENSIONS,
  STORE_PERFORMANCE_TRAFFIC_SOURCE_DIMENSIONS,
  ReportError,
  type ReportFile,
  type ReportKind,
  type ReportRecord,
  type ReportMultiRecord,
} from "@/lib/mobile-apps/providers/google-play-reports";
import { toAlpha2 } from "@/lib/mobile-apps/country-codes";
import { ensureMobileAppsSchema } from "@/lib/mobile-apps/ensure-schema";
import { ratingSourceCopy, type RatingSource } from "@/lib/mobile-apps/rating-source";
import type { Store } from "@/lib/mobile-apps/types";

type Sql = ReturnType<typeof getSql>;

type ListingRow = {
  id: string;
  store: string;
  store_app_id: string;
  country: string;
  last_synced_at: string | null;
};

export type ReportsStatus = "success" | "partial" | "failed" | "not_configured";

export type SyncResult = {
  listingId: string;
  store: Store;
  appIdentifier: string;
  inserted: number;
  fetched: number;
  ratingCaptured: boolean;
  skipped: boolean;
  status: "success" | "failed" | "skipped";
  error: string | null;
  reportsStatus: ReportsStatus;
  reportWarnings: string[];
  /** Machine-readable source of the headline/current rating. */
  ratingSource: RatingSource | null;
  /** Freshness date when the source exposes one, e.g. Google Play Console report date. */
  ratingAsOf: string | null;
  /** Admin/UI-safe source label, e.g. Google Play · Play Console report. */
  ratingSourceLabel: string;
  ratingFreshnessLabel: string | null;
  ratingSourceHelperText: string;
};

const DEFAULT_DEDUPE_MS = 60_000;

function reportErrMessage(err: unknown): string {
  if (err instanceof ReportError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Upsert single-dimension daily report rows under the dimension from the CSV file. */
async function persistReports(
  sql: Sql,
  listingId: string,
  report: string,
  dimension: string,
  reportMonth: string | null,
  records: ReportRecord[],
  source: string,
): Promise<void> {
  for (const r of records) {
    if (!r.date) continue;
    await sql`
      insert into mobile_app_report_metrics (listing_id, report, dimension, dimension_value, metric_date, report_month, metrics, source)
      values (${listingId}, ${report}, ${dimension}, ${r.dimensionValue}, ${r.date}, ${reportMonth}, ${JSON.stringify(r.values)}, ${source})
      on conflict (listing_id, report, dimension, dimension_value, metric_date) do update
        set metrics = excluded.metrics, report_month = excluded.report_month, source = excluded.source, captured_at = now()
    `;
  }
}

/** Upsert multi-dimension rows (Store Performance traffic_source), preserving the text dimensions. */
async function persistMultiReports(
  sql: Sql,
  listingId: string,
  reportMonth: string | null,
  records: ReportMultiRecord[],
  source: string,
): Promise<void> {
  for (const r of records) {
    if (!r.date) continue;
    // Stable hash of the (canonically ordered) dimensions so distinct
    // source/search-term/utm combinations never collide on the unique key. The
    // full dimensions object is kept in the jsonb column for display/debugging.
    const canonical = JSON.stringify(Object.keys(r.dimensions).sort().map((k) => [k, r.dimensions[k]]));
    const dimValue = createHash("sha1").update(canonical).digest("hex");
    await sql`
      insert into mobile_app_report_metrics (listing_id, report, dimension, dimension_value, metric_date, report_month, metrics, dimensions, source)
      values (${listingId}, 'store_performance', 'traffic_source', ${dimValue}, ${r.date}, ${reportMonth}, ${JSON.stringify(r.values)}, ${JSON.stringify(r.dimensions)}, ${source})
      on conflict (listing_id, report, dimension, dimension_value, metric_date) do update
        set metrics = excluded.metrics, dimensions = excluded.dimensions, report_month = excluded.report_month, source = excluded.source, captured_at = now()
    `;
  }
}

type CachedReportFile = { generation: string | null; status: string | null };

async function cachedReportFile(sql: Sql, listingId: string, objectPath: string): Promise<CachedReportFile | null> {
  const rows = (await sql`
    select generation, status from mobile_app_report_files
    where listing_id = ${listingId}::uuid and object_path = ${objectPath}
    limit 1
  `) as unknown as CachedReportFile[];
  return rows[0] ?? null;
}

function cacheMatches(file: ReportFile, cached: CachedReportFile | null): boolean {
  if (!cached || cached.status !== "parsed") return false;
  // Generation is the best GCS cache key. Some test/mocked clients may not expose
  // it; in that case object_path + parsed status is still enough to avoid repeated downloads.
  return !file.generation || cached.generation === file.generation;
}

async function markReportFile(
  sql: Sql,
  listingId: string,
  file: ReportFile,
  status: "parsed" | "empty" | "failed",
  rowsCount: number,
  errorMessage: string | null,
): Promise<void> {
  await sql`
    insert into mobile_app_report_files (
      listing_id, report, dimension, object_path, yyyy_mm, generation, size_bytes,
      downloaded_at, parsed_at, rows_count, status, error_message, updated_at
    ) values (
      ${listingId}::uuid, ${file.kind}, ${file.dimension}, ${file.path}, ${file.yyyyMM}, ${file.generation}, ${file.sizeBytes},
      now(), now(), ${rowsCount}, ${status}, ${errorMessage}, now()
    )
    on conflict (listing_id, object_path) do update
      set report = excluded.report,
          dimension = excluded.dimension,
          yyyy_mm = excluded.yyyy_mm,
          generation = excluded.generation,
          size_bytes = excluded.size_bytes,
          downloaded_at = excluded.downloaded_at,
          parsed_at = excluded.parsed_at,
          rows_count = excluded.rows_count,
          status = excluded.status,
          error_message = excluded.error_message,
          updated_at = now()
  `;
}

type ReportSyncStats = { warnings: string[]; groupsAttempted: number; filesFound: number; filesDownloaded: number; filesSkipped: number };

async function listFilesOrWarning(
  cfg: GoogleConfig,
  kind: ReportKind,
  appIdentifier: string,
  dimensions: readonly string[],
  label: string,
): Promise<{ files: ReportFile[]; warning: string | null }> {
  try {
    const files = await listReportFiles(cfg, kind, appIdentifier, dimensions);
    return { files, warning: files.length ? null : reportNotFoundWarning(label, cfg, appIdentifier, dimensions) };
  } catch (err) {
    return { files: [], warning: `${label} report: ${reportErrMessage(err)}` };
  }
}

async function syncSingleDimensionReportFiles(
  sql: Sql,
  listingId: string,
  cfg: GoogleConfig,
  appIdentifier: string,
  report: ReportKind,
  label: string,
  dimensions: readonly string[],
  source: string,
  forceReports: boolean,
): Promise<ReportSyncStats> {
  const warnings: string[] = [];
  const { files, warning } = await listFilesOrWarning(cfg, report, appIdentifier, dimensions, label);
  if (warning) warnings.push(warning);
  let filesDownloaded = 0;
  let filesSkipped = 0;

  for (const file of files) {
    const cached = await cachedReportFile(sql, listingId, file.path);
    if (!forceReports && cacheMatches(file, cached)) {
      filesSkipped++;
      continue;
    }
    try {
      const text = await downloadReportFile(cfg, file);
      const records = report === "ratings" ? parseRatingsCsv(text).map((r) => ({
        date: r.asOf,
        dimensionValue: r.territory,
        values: { total_average_rating: r.avg },
      } satisfies ReportRecord)) : parseReportCsv(text);
      if (records.length > 0) await persistReports(sql, listingId, report, file.dimension, file.yyyyMM, records, source);
      await markReportFile(sql, listingId, file, records.length > 0 ? "parsed" : "empty", records.length, null);
      filesDownloaded++;
    } catch (err) {
      const msg = reportErrMessage(err);
      await markReportFile(sql, listingId, file, "failed", 0, msg).catch(() => null);
      warnings.push(`${label} ${file.yyyyMM} ${file.dimension}: ${msg}`);
    }
  }
  return { warnings, groupsAttempted: 1, filesFound: files.length, filesDownloaded, filesSkipped };
}

async function syncTrafficSourceFiles(
  sql: Sql,
  listingId: string,
  cfg: GoogleConfig,
  appIdentifier: string,
  forceReports: boolean,
): Promise<ReportSyncStats> {
  const warnings: string[] = [];
  const label = "store performance traffic source";
  const { files, warning } = await listFilesOrWarning(cfg, "store_performance", appIdentifier, STORE_PERFORMANCE_TRAFFIC_SOURCE_DIMENSIONS, label);
  if (warning) warnings.push(warning);
  let filesDownloaded = 0;
  let filesSkipped = 0;

  for (const file of files) {
    const cached = await cachedReportFile(sql, listingId, file.path);
    if (!forceReports && cacheMatches(file, cached)) {
      filesSkipped++;
      continue;
    }
    try {
      const text = await downloadReportFile(cfg, file);
      const records = parseReportRecordsMulti(text);
      if (records.length > 0) await persistMultiReports(sql, listingId, file.yyyyMM, records, "google_play_console_store_performance_report");
      await markReportFile(sql, listingId, file, records.length > 0 ? "parsed" : "empty", records.length, null);
      filesDownloaded++;
    } catch (err) {
      const msg = reportErrMessage(err);
      await markReportFile(sql, listingId, file, "failed", 0, msg).catch(() => null);
      warnings.push(`${label} ${file.yyyyMM}: ${msg}`);
    }
  }
  return { warnings, groupsAttempted: 1, filesFound: files.length, filesDownloaded, filesSkipped };
}

async function loadGoogleRatingsFromDb(sql: Sql, listingId: string): Promise<{ territories: TerritoryRating[]; asOf: string | null }> {
  const rows = (await sql`
    select distinct on (dimension_value)
      dimension_value as territory,
      (metrics->>'total_average_rating')::float8 as avg,
      to_char(metric_date, 'YYYY-MM-DD') as as_of
    from mobile_app_report_metrics
    where listing_id = ${listingId}::uuid
      and report = 'ratings'
      and dimension = 'country'
      and metrics ? 'total_average_rating'
    order by dimension_value, metric_date desc
  `) as unknown as Array<{ territory: string; avg: number | null; as_of: string | null }>;
  const territories = rows.map((r) => ({ territory: r.territory, avg: r.avg, count: null }));
  const asOf = rows.map((r) => r.as_of).filter(Boolean).sort().at(-1) ?? null;
  return { territories, asOf };
}

/** Sync a single listing: fetch official reviews, upsert, snapshot, record the run. */
async function syncListing(
  sql: Sql,
  listing: ListingRow,
  opts: { force: boolean; dedupeMs: number; refreshReports: boolean; syncReports: boolean },
): Promise<SyncResult> {
  const store = listing.store as Store;
  const appIdentifier = listing.store_app_id;
  const base = { listingId: listing.id, store, appIdentifier };

  const recentlySynced =
    listing.last_synced_at && Date.now() - new Date(listing.last_synced_at).getTime() < opts.dedupeMs;
  if (!opts.force && recentlySynced) {
    return {
      ...base,
      inserted: 0,
      fetched: 0,
      ratingCaptured: false,
      skipped: true,
      status: "skipped",
      error: null,
      reportsStatus: "not_configured",
      reportWarnings: [],
      ratingSource: null,
      ratingAsOf: null,
      ratingSourceLabel: "Rating not refreshed",
      ratingFreshnessLabel: null,
      ratingSourceHelperText: "This listing was skipped because it was synced recently.",
    };
  }

  const runRows = (await sql`
    insert into app_review_sync_runs (listing_id, store, app_identifier, status)
    values (${listing.id}::uuid, ${store}, ${appIdentifier}, 'running')
    returning id::text
  `) as unknown as Array<{ id: string }>;
  const runId = runRows[0]?.id;

  try {
    const provider = getProvider(store);
    const reviews = await provider.fetchReviews({ store, storeAppId: appIdentifier, country: listing.country });

    let inserted = 0;
    for (const r of reviews) {
      const res = await sql`
        insert into app_reviews (
          listing_id, store_review_id, author, rating, title, body,
          app_version, country, submitted_at, store_response, language, device, raw_json
        ) values (
          ${listing.id}, ${r.storeReviewId}, ${r.author}, ${r.rating}, ${r.title}, ${r.body},
          ${r.appVersion}, ${r.country}, ${r.submittedAt}, ${r.storeResponse}, ${r.language ?? null},
          ${r.device ?? null}, ${r.raw ? JSON.stringify(r.raw) : null}
        )
        on conflict (listing_id, store_review_id) do update
          set author = excluded.author,
              rating = excluded.rating,
              title = excluded.title,
              body = excluded.body,
              app_version = excluded.app_version,
              country = excluded.country,
              submitted_at = excluded.submitted_at,
              store_response = excluded.store_response,
              language = excluded.language,
              device = excluded.device,
              raw_json = excluded.raw_json,
              fetched_at = now()
        returning (xmax = 0) as inserted
      `;
      if ((res as unknown as Array<{ inserted: boolean }>)[0]?.inserted) inserted += 1;
    }

    // Star distribution snapshot from fetched reviews only (history; not headline store rating).
    const summary = summarizeReviews(reviews);
    await sql`
      insert into app_rating_snapshots (listing_id, avg_rating, ratings_count, histogram)
      values (${listing.id}, ${summary.avgRating}, ${summary.ratingsCount}, ${JSON.stringify(summary.histogram)})
    `;

    const cfg = loadMobileReviewsConfig();
    const reportWarnings: string[] = [];
    let reportAttempts = 0;
    let officialRatings: TerritoryRating[] = [];
    let currentRating: number | null = null;
    let ratingsCount: number | null = null;
    let ratingSource: RatingSource | null = null;
    let ratingAsOf: string | null = null;

    if (store === "apple") {
      const territories = [...reviews.map((r) => r.country ?? ""), listing.country];
      const mode = cfg.apple.fullStorefrontScan;
      const fullScan = mode === "always" || (mode === "forced" && opts.force);
      officialRatings = await fetchAppleTerritoryRatings(appIdentifier, territories, {
        fullScan,
        concurrency: cfg.apple.storefrontScanConcurrency,
        delayMs: cfg.apple.storefrontScanDelayMs,
      }).catch(() => []);
      const primary =
        officialRatings.find((t) => t.territory === toAlpha2(listing.country)) ?? officialRatings[0] ?? null;
      currentRating = primary?.avg ?? null;
      ratingsCount = primary?.count ?? null;
      ratingSource = "apple_app_store_lookup";
    } else {
      if (opts.syncReports && cfg.google.reportsBucket) {
        const ratingsStats = await syncSingleDimensionReportFiles(
          sql,
          listing.id,
          cfg.google,
          appIdentifier,
          "ratings",
          "ratings",
          RATINGS_DIMENSIONS,
          "google_play_console_ratings_report",
          opts.refreshReports,
        );
        reportAttempts += ratingsStats.groupsAttempted;
        reportWarnings.push(...ratingsStats.warnings);
        const ratingReport = await loadGoogleRatingsFromDb(sql, listing.id);
        if (ratingReport.territories.length > 0) {
          officialRatings = ratingReport.territories;
          const primary =
            officialRatings.find((t) => t.territory === toAlpha2(listing.country)) ?? officialRatings[0] ?? null;
          currentRating = primary?.avg ?? null;
          ratingsCount = null; // Play Console ratings report does not expose per-country rating count.
          ratingSource = "google_play_console_ratings_report";
          ratingAsOf = ratingReport.asOf;
        }
      }
      if (!ratingSource) {
        currentRating = summary.avgRating;
        ratingsCount = summary.ratingsCount;
        ratingSource = "google_reviews_api_fetched_reviews";
      }
    }

    await sql`
      update mobile_app_listings
      set current_rating = ${currentRating},
          ratings_count = ${ratingsCount},
          official_ratings = ${officialRatings.length ? JSON.stringify(officialRatings) : null},
          rating_source = ${ratingSource},
          rating_as_of = ${ratingAsOf},
          last_synced_at = now()
      where id = ${listing.id}
    `;

    // Google Play Console bulk reports are intentionally optional per sync.
    // Page/tab syncs pass syncReports=false so heavy all-year CSV scans do not block the UI.
    // The reports refresh button passes syncReports=true and refreshReports=true.
    if (opts.syncReports && store === "google" && cfg.google.reportsBucket) {
      const stats = await Promise.all([
        syncSingleDimensionReportFiles(
          sql,
          listing.id,
          cfg.google,
          appIdentifier,
          "installs",
          "installs",
          INSTALLS_DIMENSIONS,
          "google_play_console_stats_report",
          opts.refreshReports,
        ),
        syncSingleDimensionReportFiles(
          sql,
          listing.id,
          cfg.google,
          appIdentifier,
          "crashes",
          "crashes",
          CRASHES_DIMENSIONS,
          "google_play_console_crashes_report",
          opts.refreshReports,
        ),
        syncSingleDimensionReportFiles(
          sql,
          listing.id,
          cfg.google,
          appIdentifier,
          "store_performance",
          "store performance country",
          STORE_PERFORMANCE_COUNTRY_DIMENSIONS,
          "google_play_console_store_performance_report",
          opts.refreshReports,
        ),
        syncTrafficSourceFiles(sql, listing.id, cfg.google, appIdentifier, opts.refreshReports),
      ]);
      for (const s of stats) {
        reportAttempts += s.groupsAttempted;
        reportWarnings.push(...s.warnings);
      }
    }

    const ratingCaptured = currentRating != null || officialRatings.length > 0;
    const sourceCopy = ratingSourceCopy({ store, source: ratingSource, asOf: ratingAsOf });
    const reportsStatus: ReportsStatus =
      reportAttempts === 0
        ? "not_configured"
        : reportWarnings.length === 0
          ? "success"
          : reportWarnings.length >= reportAttempts
            ? "failed"
            : "partial";

    if (runId) {
      await sql`
        update app_review_sync_runs
        set status = 'success', finished_at = now(), fetched_count = ${reviews.length}, upserted_count = ${inserted},
            report_status = ${reportsStatus}, report_warnings = ${JSON.stringify(reportWarnings)}
        where id = ${runId}::uuid
      `;
    }
    return {
      ...base,
      inserted,
      fetched: reviews.length,
      ratingCaptured,
      skipped: false,
      status: "success",
      error: null,
      reportsStatus,
      reportWarnings,
      ratingSource,
      ratingAsOf,
      ratingSourceLabel: sourceCopy.sourceLabel,
      ratingFreshnessLabel: sourceCopy.freshnessLabel,
      ratingSourceHelperText: sourceCopy.helperText,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (runId) {
      await sql`
        update app_review_sync_runs
        set status = 'failed', finished_at = now(), error_message = ${error}
        where id = ${runId}::uuid
      `.catch(() => null);
    }
    return {
      ...base,
      inserted: 0,
      fetched: 0,
      ratingCaptured: false,
      skipped: false,
      status: "failed",
      error,
      reportsStatus: "not_configured",
      reportWarnings: [],
      ratingSource: null,
      ratingAsOf: null,
      ratingSourceLabel: "Rating not refreshed",
      ratingFreshnessLabel: null,
      ratingSourceHelperText: "The sync failed before a rating source could be refreshed.",
    };
  }
}

/**
 * Sync one app: for each of its listings (optionally filtered to a single store),
 * fetch reviews via the official APIs and upsert. Listings are processed with a
 * small concurrency limit so one store failing never blocks the other.
 */
export async function syncApp(
  appId: string,
  opts: { force?: boolean; dedupeMs?: number; store?: Store; refreshReports?: boolean; syncReports?: boolean } = {},
): Promise<SyncResult[]> {
  const sql: Sql = getSql();
  await ensureMobileAppsSchema(sql); // safe if a cron/job syncs before any route inits the schema
  const cfg = loadMobileReviewsConfig();
  const dedupeMs = opts.dedupeMs ?? DEFAULT_DEDUPE_MS;
  const force = Boolean(opts.force);
  const refreshReports = Boolean(opts.refreshReports);
  const syncReports = opts.syncReports ?? true;

  const listings = (await sql`
    select id::text, store, store_app_id, country, last_synced_at
    from mobile_app_listings
    where mobile_app_id = ${appId}
      and (${opts.store ?? null}::text is null or store = ${opts.store ?? null})
  `) as unknown as ListingRow[];

  const limit = pLimit(Math.max(1, cfg.sync.concurrency));
  const results = await Promise.all(
    listings.map((l) => limit(() => syncListing(sql, l, { force, dedupeMs, refreshReports, syncReports }))),
  );

  // Notify SSE listeners that this app changed.
  await sql`select pg_notify('mobile_apps_change', ${JSON.stringify({ appId })})`.catch(() => null);
  return results;
}
