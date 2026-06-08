import { createHash } from "node:crypto";
import pLimit from "p-limit";
import { getSql } from "@/lib/local-db";
import { loadMobileReviewsConfig } from "@/lib/mobile-apps/config";
import { summarizeReviews } from "@/lib/mobile-apps/metrics";
import { getProvider } from "@/lib/mobile-apps/providers";
import { fetchAppleTerritoryRatings, type TerritoryRating } from "@/lib/mobile-apps/providers/app-store-ratings";
import {
  fetchGooglePlayCountryRatings,
  fetchInstalls,
  fetchCrashes,
  fetchStorePerformanceCountry,
  fetchStorePerformanceTrafficSource,
  reportNotFoundWarning,
  RATINGS_DIMENSIONS,
  INSTALLS_DIMENSIONS,
  CRASHES_DIMENSIONS,
  STORE_PERFORMANCE_COUNTRY_DIMENSIONS,
  STORE_PERFORMANCE_TRAFFIC_SOURCE_DIMENSIONS,
  ReportError,
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

/** Upsert single-dimension daily report rows under the dimension that was found. */
async function persistReports(
  sql: Sql,
  listingId: string,
  report: string,
  dimension: string,
  records: ReportRecord[],
  source: string,
): Promise<void> {
  for (const r of records) {
    if (!r.date) continue;
    await sql`
      insert into mobile_app_report_metrics (listing_id, report, dimension, dimension_value, metric_date, metrics, source)
      values (${listingId}, ${report}, ${dimension}, ${r.dimensionValue}, ${r.date}, ${JSON.stringify(r.values)}, ${source})
      on conflict (listing_id, report, dimension, dimension_value, metric_date) do update
        set metrics = excluded.metrics, source = excluded.source, captured_at = now()
    `;
  }
}

/** Upsert multi-dimension rows (Store Performance traffic_source), preserving the text dimensions. */
async function persistMultiReports(
  sql: Sql,
  listingId: string,
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
      insert into mobile_app_report_metrics (listing_id, report, dimension, dimension_value, metric_date, metrics, dimensions, source)
      values (${listingId}, 'store_performance', 'traffic_source', ${dimValue}, ${r.date}, ${JSON.stringify(r.values)}, ${JSON.stringify(r.dimensions)}, ${source})
      on conflict (listing_id, report, dimension, dimension_value, metric_date) do update
        set metrics = excluded.metrics, dimensions = excluded.dimensions, source = excluded.source, captured_at = now()
    `;
  }
}

/** Fetch + persist one single-dimension report; returns a clean warning, else null. */
async function syncReport(
  sql: Sql,
  listingId: string,
  report: string,
  source: string,
  fetcher: () => Promise<{ records: ReportRecord[]; dimension: string } | null>,
  notFoundWarning: string,
): Promise<string | null> {
  const label = report.replace(/_/g, " ");
  try {
    const found = await fetcher();
    if (!found) return notFoundWarning;
    if (found.records.length === 0) return `${label} report: no rows after parsing`;
    await persistReports(sql, listingId, report, found.dimension, found.records, source);
    return null;
  } catch (err) {
    return `${label} report: ${reportErrMessage(err)}`;
  }
}

/** Fetch + persist the multi-dimension traffic-source report; returns a clean warning, else null. */
async function syncTrafficSource(
  sql: Sql,
  listingId: string,
  source: string,
  fetcher: () => Promise<{ records: ReportMultiRecord[]; dimension: string } | null>,
  notFoundWarning: string,
): Promise<string | null> {
  try {
    const found = await fetcher();
    if (!found) return notFoundWarning;
    if (found.records.length === 0) return `store performance (traffic source) report: no rows after parsing`;
    await persistMultiReports(sql, listingId, found.records, source);
    return null;
  } catch (err) {
    return `store performance (traffic source) report: ${reportErrMessage(err)}`;
  }
}

/** Sync a single listing: fetch official reviews, upsert, snapshot, record the run. */
async function syncListing(
  sql: Sql,
  listing: ListingRow,
  opts: { force: boolean; dedupeMs: number },
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

    // Star distribution snapshot from the fetched reviews (history only — this is
    // NOT presented as the store rating).
    const summary = summarizeReviews(reviews);
    await sql`
      insert into app_rating_snapshots (listing_id, avg_rating, ratings_count, histogram)
      values (${listing.id}, ${summary.avgRating}, ${summary.ratingsCount}, ${JSON.stringify(summary.histogram)})
    `;

    // The headline rating is the OFFICIAL value the store returns, never one we
    // compute (except the explicit Google review-average fallback below).
    const cfg = loadMobileReviewsConfig();
    const reportWarnings: string[] = [];
    let reportAttempts = 0;
    let officialRatings: TerritoryRating[] = [];
    let currentRating: number | null = null;
    let ratingsCount: number | null = null;
    let ratingSource: RatingSource | null = null;
    let ratingAsOf: string | null = null;
    if (store === "apple") {
      // Apple exposes the official displayed per-storefront average via iTunes Lookup.
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
      // Google: the official per-country averages come from the Play Console ratings
      // report (GCS). reviews.list excludes rating-only feedback, so it can't give the
      // aggregate. Fall back to the fetched-review average only if no report bucket.
      let usedReport = false;
      if (cfg.google.reportsBucket) {
        reportAttempts++;
        try {
          const report = await fetchGooglePlayCountryRatings(cfg.google, appIdentifier);
          if (report && report.territories.length > 0) {
            officialRatings = report.territories.map((t) => ({ territory: t.territory, avg: t.avg, count: null }));
            const primary =
              officialRatings.find((t) => t.territory === toAlpha2(listing.country)) ?? officialRatings[0] ?? null;
            currentRating = primary?.avg ?? null;
            ratingsCount = null; // the report has no per-country count
            ratingSource = "google_play_console_ratings_report";
            ratingAsOf = report.asOf;
            usedReport = true;
          } else {
            reportWarnings.push(reportNotFoundWarning("ratings", cfg.google, appIdentifier, RATINGS_DIMENSIONS));
          }
        } catch (err) {
          reportWarnings.push(`ratings report: ${reportErrMessage(err)}`);
        }
      }
      if (!usedReport) {
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
    // Play Console bulk reports: installs, crashes, store-performance time series.
    // Best-effort — never fail the review sync — but surface warnings instead of
    // swallowing them, so a bad bucket / permission shows up in the UI.
    if (store === "google" && cfg.google.reportsBucket) {
      reportAttempts += 4;
      const sp = "google_play_console_store_performance_report";
      const warnings = await Promise.all([
        syncReport(
          sql,
          listing.id,
          "installs",
          "google_play_console_stats_report",
          () => fetchInstalls(cfg.google, appIdentifier),
          reportNotFoundWarning("installs", cfg.google, appIdentifier, INSTALLS_DIMENSIONS),
        ),
        syncReport(
          sql,
          listing.id,
          "crashes",
          "google_play_console_crashes_report",
          () => fetchCrashes(cfg.google, appIdentifier),
          reportNotFoundWarning("crashes", cfg.google, appIdentifier, CRASHES_DIMENSIONS),
        ),
        syncReport(
          sql,
          listing.id,
          "store_performance",
          sp,
          () => fetchStorePerformanceCountry(cfg.google, appIdentifier),
          reportNotFoundWarning("store performance country", cfg.google, appIdentifier, STORE_PERFORMANCE_COUNTRY_DIMENSIONS),
        ),
        syncTrafficSource(
          sql,
          listing.id,
          sp,
          () => fetchStorePerformanceTrafficSource(cfg.google, appIdentifier),
          reportNotFoundWarning("store performance traffic source", cfg.google, appIdentifier, STORE_PERFORMANCE_TRAFFIC_SOURCE_DIMENSIONS),
        ),
      ]);
      for (const w of warnings) if (w) reportWarnings.push(w);
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
  opts: { force?: boolean; dedupeMs?: number; store?: Store } = {},
): Promise<SyncResult[]> {
  const sql: Sql = getSql();
  await ensureMobileAppsSchema(sql); // safe if a cron/job syncs before any route inits the schema
  const cfg = loadMobileReviewsConfig();
  const dedupeMs = opts.dedupeMs ?? DEFAULT_DEDUPE_MS;
  const force = Boolean(opts.force);

  const listings = (await sql`
    select id::text, store, store_app_id, country, last_synced_at
    from mobile_app_listings
    where mobile_app_id = ${appId}
      and (${opts.store ?? null}::text is null or store = ${opts.store ?? null})
  `) as unknown as ListingRow[];

  const limit = pLimit(Math.max(1, cfg.sync.concurrency));
  const results = await Promise.all(listings.map((l) => limit(() => syncListing(sql, l, { force, dedupeMs }))));

  // Notify SSE listeners that this app changed.
  await sql`select pg_notify('mobile_apps_change', ${JSON.stringify({ appId })})`.catch(() => null);
  return results;
}
