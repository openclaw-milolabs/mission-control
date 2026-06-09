import { getSql } from "@/lib/local-db";

type Sql = ReturnType<typeof getSql>;

export type ReportSyncMode = "incremental" | "backfill";
export type ReportStore = "google" | "apple";

export type ReportSyncJob = {
  id: string;
  status: "queued" | "running" | "success" | "partial" | "failed" | "skipped";
  mode: ReportSyncMode;
  store: ReportStore | null;
  mobileAppId: string | null;
  listingId: string | null;
  createdAt?: string;
};

export type EnqueueReportSyncInput = {
  appId?: string | null;
  listingId?: string | null;
  store?: ReportStore | null;
  mode?: ReportSyncMode;
  reason?: string;
  requestedBy?: string | null;
};

export type EnqueueResult = { job: ReportSyncJob; reused: boolean };

/**
 * How long a 'running' job may go without a heartbeat before it is considered
 * dead. The worker writes heartbeat_at periodically; if the process crashes, the
 * row would otherwise stay 'running' forever and freshness checks would report
 * 'refreshing' indefinitely.
 */
export const STALE_JOB_MS = 5 * 60 * 1000;

/**
 * Reap stalled report-sync jobs: any 'running' job whose last heartbeat (falling
 * back to started_at, then created_at) is older than `staleMs` is marked 'failed'
 * so it stops blocking freshness and can be retried by the next enqueue. Returns
 * the number of jobs reaped. Safe to call from cron and from freshness checks.
 */
export async function reapStaleReportJobs(sql: Sql, opts: { staleMs?: number } = {}): Promise<number> {
  const staleMs = Math.max(1, opts.staleMs ?? STALE_JOB_MS);
  const rows = (await sql`
    update mobile_app_report_sync_jobs
    set status = 'failed',
        finished_at = now(),
        error_message = coalesce(error_message, 'Worker stalled: no heartbeat within threshold'),
        warnings = warnings || '["reaped: stale heartbeat"]'::jsonb
    where status = 'running'
      and coalesce(heartbeat_at, started_at, created_at) < now() - (${staleMs}::bigint * interval '1 millisecond')
    returning id
  `) as unknown as Array<{ id: string }>;
  return rows.length;
}

/**
 * Enqueue a heavy report-sync job for the detached cron-drained worker, or reuse an
 * already-active one. This NEVER does report work itself — it only writes a row.
 *
 *  1. Reap stalled jobs first, so a crashed worker's 'running' row doesn't wedge
 *     the dedupe check forever.
 *  2. If a queued/running job already exists for the same app/listing/store/mode,
 *     return it (reused) instead of creating a duplicate.
 *  3. Otherwise insert a fresh 'queued' job.
 */
export async function enqueueReportSyncJob(sql: Sql, input: EnqueueReportSyncInput): Promise<EnqueueResult> {
  const appId = input.appId ?? null;
  const listingId = input.listingId ?? null;
  const store = input.store ?? null;
  const mode: ReportSyncMode = input.mode ?? "incremental";
  const reason = input.reason ?? "manual";
  const requestedBy = input.requestedBy ?? null;

  await reapStaleReportJobs(sql);

  const existing = (await sql`
    select id::text, status, mode, store,
           mobile_app_id::text as "mobileAppId", listing_id::text as "listingId",
           to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "createdAt"
    from mobile_app_report_sync_jobs
    where status in ('queued','running')
      and mobile_app_id is not distinct from ${appId}::uuid
      and listing_id is not distinct from ${listingId}::uuid
      and store is not distinct from ${store}
      and mode = ${mode}
    order by created_at asc
    limit 1
  `) as unknown as ReportSyncJob[];
  if (existing[0]) return { job: existing[0], reused: true };

  const inserted = (await sql`
    insert into mobile_app_report_sync_jobs (mobile_app_id, listing_id, store, mode, reason, requested_by, status)
    values (${appId}::uuid, ${listingId}::uuid, ${store}, ${mode}, ${reason}, ${requestedBy}, 'queued')
    returning id::text, status, mode, store,
              mobile_app_id::text as "mobileAppId", listing_id::text as "listingId",
              to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "createdAt"
  `) as unknown as ReportSyncJob[];
  return { job: inserted[0]!, reused: false };
}
