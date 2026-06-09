import { getSql } from "@/lib/local-db";

type Sql = ReturnType<typeof getSql>;

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
