import { getSql } from "@/lib/local-db";
import { syncApp } from "@/lib/mobile-apps/sync";
import { refreshReportRollups } from "@/lib/mobile-apps/report-rollups";
import { reapStaleReportJobs } from "@/lib/mobile-apps/report-jobs";
import { checkOfficialReportFreshness } from "@/lib/mobile-apps/report-freshness";

type Sql = ReturnType<typeof getSql>;

/** Single advisory-lock key so only one heavy worker runs cluster-wide. */
export const WORKER_LOCK_KEY = "mobile_reports_sync_worker";

export type ClaimedJob = {
  id: string;
  mode: "incremental" | "backfill";
  store: "google" | "apple" | null;
  mobileAppId: string | null;
  listingId: string | null;
  reason?: string | null;
};

export type JobOutcome = {
  status: "success" | "partial" | "failed" | "skipped";
  error?: string | null;
  warnings?: string[];
  stats?: Record<string, unknown>;
};

export type WorkerDeps = {
  syncApp: typeof syncApp;
  refreshReportRollups: (sql: Sql, listingId: string) => Promise<void>;
  updateFreshness: (sql: Sql, listingId: string) => Promise<void>;
};

const defaultDeps: WorkerDeps = {
  syncApp,
  refreshReportRollups,
  // Recompute the real freshness verdict from GCS generations after processing, so
  // the row reflects exactly what was just parsed (fresh when caught up).
  updateFreshness: async (sql, listingId) => {
    await checkOfficialReportFreshness(sql, listingId);
  },
};

/** Try to grab the global worker lock. Returns false if another worker holds it. */
export async function acquireWorkerLock(sql: Sql): Promise<boolean> {
  const rows = (await sql`select pg_try_advisory_lock(hashtext(${WORKER_LOCK_KEY})) as locked`) as unknown as Array<{
    locked: boolean;
  }>;
  return rows[0]?.locked === true;
}

export async function releaseWorkerLock(sql: Sql): Promise<void> {
  await sql`select pg_advisory_unlock(hashtext(${WORKER_LOCK_KEY}))`.catch(() => null);
}

/** Atomically flip up to `limit` queued jobs to running and return them. */
export async function claimQueuedJobs(sql: Sql, limit = 10): Promise<ClaimedJob[]> {
  const rows = (await sql`
    update mobile_app_report_sync_jobs
    set status = 'running', started_at = coalesce(started_at, now()), heartbeat_at = now()
    where id in (
      select id from mobile_app_report_sync_jobs
      where status = 'queued'
      order by created_at asc
      for update skip locked
      limit ${limit}
    )
    returning id::text, mode, store,
              mobile_app_id::text as "mobileAppId", listing_id::text as "listingId", reason
  `) as unknown as ClaimedJob[];
  return rows;
}

export async function heartbeatJob(sql: Sql, jobId: string): Promise<void> {
  await sql`update mobile_app_report_sync_jobs set heartbeat_at = now() where id = ${jobId}::uuid`.catch(() => null);
}

/**
 * Heartbeat interval while a job runs. Must be comfortably under STALE_JOB_MS
 * (report-jobs.ts) or a long single-app CSV sync — which has no internal await
 * points where we could beat manually — gets reaped as stalled mid-run.
 */
const HEARTBEAT_INTERVAL_MS = 60_000;

export async function finishJob(sql: Sql, jobId: string, outcome: JobOutcome): Promise<void> {
  await sql`
    update mobile_app_report_sync_jobs
    set status = ${outcome.status},
        finished_at = now(),
        heartbeat_at = now(),
        error_message = ${outcome.error ?? null},
        warnings = ${JSON.stringify(outcome.warnings ?? [])}::jsonb,
        stats = ${JSON.stringify(outcome.stats ?? {})}::jsonb
    where id = ${jobId}::uuid
  `;
}

/** Resolve which app ids a job targets. */
async function resolveAppIds(sql: Sql, job: ClaimedJob): Promise<string[]> {
  if (job.mobileAppId) return [job.mobileAppId];
  if (job.listingId) {
    const rows = (await sql`
      select mobile_app_id::text as id from mobile_app_listings where id = ${job.listingId}::uuid
    `) as unknown as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }
  // No target → process every app that has at least one listing (incremental cron).
  const rows = (await sql`
    select distinct mobile_app_id::text as id from mobile_app_listings
  `) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Run one job's heavy work. This is the ONLY place that runs syncApp with the
 * heavy flags on (syncReports + syncAppleStorefronts). After each app syncs its
 * reports into the raw metrics table, rollups are rebuilt in SQL and freshness is
 * updated. Idempotent: sync skips unchanged GCS generations and rollups converge.
 */
export async function runReportSyncJob(sql: Sql, job: ClaimedJob, deps: WorkerDeps = defaultDeps): Promise<JobOutcome> {
  // Timer-based heartbeat for the whole job: per-step beats are not enough because
  // one syncApp call can stream CSVs for longer than the stale threshold.
  const beat = setInterval(() => void heartbeatJob(sql, job.id), HEARTBEAT_INTERVAL_MS);
  try {
    const appIds = await resolveAppIds(sql, job);
    const warnings: string[] = [];
    const stats: Record<string, unknown> = { apps: appIds.length };
    let fetched = 0;
    let inserted = 0;
    let failures = 0;
    const googleListingIds = new Set<string>();

    for (const appId of appIds) {
      await heartbeatJob(sql, job.id);
      const results = await deps.syncApp(appId, {
        force: true,
        syncReports: true,
        syncAppleStorefronts: true,
        refreshReports: job.mode === "backfill",
        store: job.store ?? undefined,
      });
      for (const r of results) {
        fetched += r.fetched ?? 0;
        inserted += r.inserted ?? 0;
        if (r.status === "failed") failures += 1;
        if (Array.isArray(r.reportWarnings)) warnings.push(...r.reportWarnings);
        if (r.store === "google" && r.listingId) googleListingIds.add(r.listingId);
      }
    }

    // Rebuild rollups + recompute real freshness for every Google listing we touched.
    for (const listingId of googleListingIds) {
      await heartbeatJob(sql, job.id);
      await deps.refreshReportRollups(sql, listingId);
      await deps.updateFreshness(sql, listingId);
    }

    stats.fetched = fetched;
    stats.inserted = inserted;
    stats.googleListings = googleListingIds.size;

    const status: JobOutcome["status"] = failures === 0 ? "success" : failures < appIds.length ? "partial" : "failed";
    return { status, warnings, stats, error: failures > 0 ? `${failures} listing sync(s) failed` : null };
  } finally {
    clearInterval(beat);
  }
}

async function notifyChange(sql: Sql, appId: string | null): Promise<void> {
  await sql`select pg_notify('mobile_apps_change', ${JSON.stringify({ appId })})`.catch(() => null);
}

/**
 * Drain all currently-queued jobs sequentially (never concurrently — each job's
 * CSV parse is memory-heavy). Caller must already hold the advisory lock.
 */
export async function processQueuedJobs(
  sql: Sql,
  deps: WorkerDeps = defaultDeps,
): Promise<{ processed: number; jobIds: string[] }> {
  await reapStaleReportJobs(sql);
  const jobs = await claimQueuedJobs(sql);
  for (const job of jobs) {
    try {
      const outcome = await runReportSyncJob(sql, job, deps);
      await finishJob(sql, job.id, outcome);
    } catch (error) {
      await finishJob(sql, job.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await notifyChange(sql, job.mobileAppId);
  }
  return { processed: jobs.length, jobIds: jobs.map((j) => j.id) };
}
