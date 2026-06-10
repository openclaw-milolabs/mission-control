import { getSql } from "@/lib/local-db";
import { loadMobileReviewsConfig, type GoogleConfig } from "@/lib/mobile-apps/config";
import {
  listReportFiles,
  listReviewReportFiles,
  RATINGS_DIMENSIONS,
  INSTALLS_DIMENSIONS,
  CRASHES_DIMENSIONS,
  STORE_PERFORMANCE_COUNTRY_DIMENSIONS,
  STORE_PERFORMANCE_TRAFFIC_SOURCE_DIMENSIONS,
  type ReportKind,
} from "@/lib/mobile-apps/providers/google-play-reports";
import { reapStaleReportJobs } from "@/lib/mobile-apps/report-jobs";

type Sql = ReturnType<typeof getSql>;

export type ReportFreshnessState = "fresh" | "refreshing" | "stale" | "failed" | "unknown" | "not_configured";

export type FreshnessResult = {
  status: ReportFreshnessState;
  needsWorker: boolean;
  latestOfficialYyyyMm: string | null;
  latestProcessedYyyyMm: string | null;
  latestOfficialGeneration: string | null;
  latestProcessedGeneration: string | null;
  activeJobId: string | null;
  warnings: string[];
};

export type FreshnessDeps = {
  loadConfig: () => { google: GoogleConfig };
  listReportFiles: typeof listReportFiles;
  listReviewReportFiles: typeof listReviewReportFiles;
};

const defaultDeps: FreshnessDeps = {
  loadConfig: loadMobileReviewsConfig,
  listReportFiles,
  listReviewReportFiles,
};

// The report kinds + dimensions the worker actually processes. Freshness compares
// the newest GCS generation of each against what we have parsed.
const KIND_DIMENSIONS: Array<{ kind: ReportKind; dimensions: readonly string[] }> = [
  { kind: "ratings", dimensions: RATINGS_DIMENSIONS },
  { kind: "installs", dimensions: INSTALLS_DIMENSIONS },
  { kind: "crashes", dimensions: CRASHES_DIMENSIONS },
  {
    kind: "store_performance",
    dimensions: [...STORE_PERFORMANCE_COUNTRY_DIMENSIONS, ...STORE_PERFORMANCE_TRAFFIC_SOURCE_DIMENSIONS],
  },
];

type OfficialObject = { path: string; generation: string | null; yyyyMM: string };

const EMPTY = {
  latestOfficialYyyyMm: null,
  latestProcessedYyyyMm: null,
  latestOfficialGeneration: null,
  latestProcessedGeneration: null,
  activeJobId: null,
};

async function writeFreshness(
  sql: Sql,
  listingId: string,
  result: Omit<FreshnessResult, "needsWorker">,
  errorMessage: string | null,
): Promise<void> {
  // processed_at advances only when we are actually fresh; otherwise keep the prior value.
  const processedAtNow = result.status === "fresh";
  await sql`
    insert into mobile_app_report_freshness
      (listing_id, status, latest_official_yyyy_mm, latest_processed_yyyy_mm,
       latest_official_generation, latest_processed_generation,
       checked_at, processed_at, active_job_id, error_message, warnings, updated_at)
    values (${listingId}::uuid, ${result.status},
            ${result.latestOfficialYyyyMm}, ${result.latestProcessedYyyyMm},
            ${result.latestOfficialGeneration}, ${result.latestProcessedGeneration},
            now(), ${processedAtNow ? new Date().toISOString() : null}::timestamptz,
            ${result.activeJobId}::uuid, ${errorMessage},
            ${JSON.stringify(result.warnings)}::jsonb, now())
    on conflict (listing_id) do update set
      status = excluded.status,
      latest_official_yyyy_mm = excluded.latest_official_yyyy_mm,
      latest_processed_yyyy_mm = excluded.latest_processed_yyyy_mm,
      latest_official_generation = excluded.latest_official_generation,
      latest_processed_generation = excluded.latest_processed_generation,
      checked_at = now(),
      processed_at = coalesce(excluded.processed_at, mobile_app_report_freshness.processed_at),
      active_job_id = excluded.active_job_id,
      error_message = excluded.error_message,
      warnings = excluded.warnings,
      updated_at = now()
  `.catch(() => null);
}

/**
 * Cheaply decide whether a Google listing's official Play Console reports are fresh,
 * WITHOUT downloading any CSV. It only lists GCS object metadata (generations) and
 * compares them against the generations we have already parsed. Updates the
 * mobile_app_report_freshness row and returns the verdict. Apple listings have no
 * Play-reports concept, so they resolve to not_configured (best-effort, never blocks).
 */
export async function checkOfficialReportFreshness(
  sql: Sql,
  listingId: string,
  deps: FreshnessDeps = defaultDeps,
): Promise<FreshnessResult> {
  const warnings: string[] = [];

  const listingRows = (await sql`
    select store, store_app_id, mobile_app_id::text as "mobileAppId"
    from mobile_app_listings where id = ${listingId}::uuid
  `) as unknown as Array<{ store: string; store_app_id: string; mobileAppId: string }>;
  const listing = listingRows[0];
  const cfg = deps.loadConfig();

  if (!listing || listing.store !== "google" || !cfg.google.reportsBucket) {
    const result = { status: "not_configured" as const, ...EMPTY, warnings };
    await writeFreshness(sql, listingId, result, null);
    return { ...result, needsWorker: false };
  }

  // 1. Gather official object generations (metadata only — NO downloads).
  const official: OfficialObject[] = [];
  try {
    for (const { kind, dimensions } of KIND_DIMENSIONS) {
      const files = await deps.listReportFiles(cfg.google, kind, listing.store_app_id, dimensions);
      for (const f of files) official.push({ path: f.path, generation: f.generation, yyyyMM: f.yyyyMM });
    }
    const reviews = await deps.listReviewReportFiles(cfg.google, listing.store_app_id);
    for (const f of reviews) official.push({ path: f.path, generation: f.generation, yyyyMM: f.yyyyMM });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(msg);
    const result = { status: "failed" as const, ...EMPTY, warnings };
    await writeFreshness(sql, listingId, result, msg);
    return { ...result, needsWorker: false };
  }

  // Dedupe by object path (one generation per path in GCS).
  const officialByPath = new Map<string, OfficialObject>();
  for (const o of official) officialByPath.set(o.path, o);
  const officialObjects = [...officialByPath.values()];

  // Reap stalled jobs first so a crashed 'running' row doesn't read as refreshing.
  await reapStaleReportJobs(sql);

  // 2. What have we already parsed?
  const processedRows = (await sql`
    select object_path, generation, yyyy_mm
    from mobile_app_report_files
    where listing_id = ${listingId}::uuid and status = 'parsed'
  `) as unknown as Array<{ object_path: string; generation: string | null; yyyy_mm: string | null }>;
  const processedSet = new Set(processedRows.map((r) => `${r.object_path}@${r.generation ?? ""}`));

  const unprocessed = officialObjects.filter((o) => !processedSet.has(`${o.path}@${o.generation ?? ""}`));

  // Summary fields (loose; the real verdict uses the full-set comparison above).
  const newestOfficial = [...officialObjects].sort((a, b) => b.yyyyMM.localeCompare(a.yyyyMM))[0] ?? null;
  const newestProcessed = [...processedRows].sort((a, b) => (b.yyyy_mm ?? "").localeCompare(a.yyyy_mm ?? ""))[0] ?? null;
  const summary = {
    latestOfficialYyyyMm: newestOfficial?.yyyyMM ?? null,
    latestProcessedYyyyMm: newestProcessed?.yyyy_mm ?? null,
    latestOfficialGeneration: newestOfficial?.generation ?? null,
    latestProcessedGeneration: newestProcessed?.generation ?? null,
  };

  // 3. Is a job already in flight, or did the last one fail? Global jobs (no app,
  // no listing — the worker's periodic incremental pass) cover every listing, so
  // they count too; otherwise we'd report 'stale' and enqueue duplicate work while
  // the global pass is already processing this listing.
  const recentRows = (await sql`
    select id::text, status from mobile_app_report_sync_jobs
    where (listing_id = ${listingId}::uuid
       or mobile_app_id = ${listing.mobileAppId}::uuid
       or (listing_id is null and mobile_app_id is null))
    order by created_at desc limit 1
  `) as unknown as Array<{ id: string; status: string }>;
  const recent = recentRows[0];

  let status: ReportFreshnessState;
  let needsWorker = false;
  let activeJobId: string | null = null;

  if (recent && (recent.status === "queued" || recent.status === "running")) {
    status = "refreshing";
    activeJobId = recent.id;
  } else if (unprocessed.length > 0) {
    needsWorker = true;
    status = recent && recent.status === "failed" ? "failed" : "stale";
  } else if (officialObjects.length === 0 && processedRows.length === 0) {
    status = "unknown";
  } else {
    // No unprocessed official objects → the latest published report is processed.
    status = "fresh";
  }

  const result = { status, ...summary, activeJobId, warnings };
  await writeFreshness(sql, listingId, result, status === "failed" ? (recent ? "Last report sync failed." : null) : null);
  return { ...result, needsWorker };
}

export type StoredFreshnessRow = {
  listingId: string;
  status: ReportFreshnessState;
  latestOfficialYyyyMm: string | null;
  latestProcessedYyyyMm: string | null;
  checkedAt: string | null;
  processedAt: string | null;
  activeJobId: string | null;
  errorMessage: string | null;
};

/** Cheap DB read of the last-known freshness rows. No network, no GCS. */
export async function readStoredFreshness(sql: Sql, listingIds: string[]): Promise<StoredFreshnessRow[]> {
  if (listingIds.length === 0) return [];
  const rows = (await sql`
    select listing_id::text as "listingId", status,
           latest_official_yyyy_mm as "latestOfficialYyyyMm",
           latest_processed_yyyy_mm as "latestProcessedYyyyMm",
           to_char(checked_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "checkedAt",
           to_char(processed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "processedAt",
           active_job_id::text as "activeJobId", error_message as "errorMessage"
    from mobile_app_report_freshness
    where listing_id = any(${sql.array(listingIds)}::uuid[])
  `) as unknown as StoredFreshnessRow[];
  return rows;
}
