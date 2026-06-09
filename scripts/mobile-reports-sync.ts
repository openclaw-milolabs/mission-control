#!/usr/bin/env tsx
/**
 * Detached worker for heavy Google Play report ETL.
 *
 * This is the ONLY place heavy CSV downloads / parsing / rollups run. It is never
 * invoked from a Next.js request — the API only enqueues jobs in
 * mobile_app_report_sync_jobs, and this worker drains them under a Postgres
 * advisory lock so two heavy syncs can never overlap.
 *
 * Modes:
 *   --watch                resident service: every interval, enqueue an incremental
 *                          pass + drain the queue. Managed by mc-services.sh so it
 *                          starts/stops with Mission Control (no cron needed).
 *   --drain-only           one-shot: drain whatever is queued, then exit.
 *   --mode incremental     one-shot: enqueue an incremental pass + drain, then exit.
 *   --mode backfill        one-shot: enqueue a backfill pass + drain, then exit.
 *
 * Other flags: --app-id <uuid> --listing-id <uuid> --store google|apple
 *              --reason <text> --interval-ms <n> (watch only)
 *
 * Watch interval: --interval-ms, else $MOBILE_REPORTS_WORKER_INTERVAL_MS, else 30min.
 */
import { existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

// Load env BEFORE importing anything that reads process.env at module-eval time
// (lib/local-db captures DATABASE_URL on first import). Already-set values win.
for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) loadDotenv({ path: file });
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_INTERVAL_MS = 60 * 1000; // never hammer GCS faster than once a minute

type Args = {
  mode?: "incremental" | "backfill";
  appId?: string;
  listingId?: string;
  store?: "google" | "apple";
  reason?: string;
  drainOnly: boolean;
  watch: boolean;
  intervalMs?: number;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { drainOnly: false, watch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--mode") out.mode = next() as Args["mode"];
    else if (a === "--app-id") out.appId = next();
    else if (a === "--listing-id") out.listingId = next();
    else if (a === "--store") out.store = next() as Args["store"];
    else if (a === "--reason") out.reason = next();
    else if (a === "--interval-ms") out.intervalMs = Number(next());
    else if (a === "--drain-only") out.drainOnly = true;
    else if (a === "--watch") out.watch = true;
  }
  return out;
}

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), worker: "mobile-reports-sync", msg, ...extra }));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Deps = Awaited<ReturnType<typeof loadDeps>>;

async function loadDeps() {
  const { getSql, closeSql } = await import("@/lib/local-db");
  const { ensureMobileAppsSchema } = await import("@/lib/mobile-apps/ensure-schema");
  const { acquireWorkerLock, releaseWorkerLock, processQueuedJobs } = await import("@/lib/mobile-apps/report-worker");
  const { enqueueReportSyncJob } = await import("@/lib/mobile-apps/report-jobs");
  return { getSql, closeSql, ensureMobileAppsSchema, acquireWorkerLock, releaseWorkerLock, processQueuedJobs, enqueueReportSyncJob };
}

// One pass: grab the lock (so two workers never overlap), optionally enqueue an
// incremental job, drain the queue, release the lock. The advisory lock is
// session-scoped, so even an abrupt kill releases it when the connection drops.
async function runTick(deps: Deps, args: Args, opts: { enqueue: boolean }): Promise<void> {
  const sql = deps.getSql();
  await deps.ensureMobileAppsSchema(sql); // idempotent + cached; safe to call each tick
  const locked = await deps.acquireWorkerLock(sql);
  if (!locked) {
    log("another worker holds the advisory lock; skipping this tick", { skipped: true });
    return;
  }
  try {
    if (opts.enqueue) {
      const { job, reused } = await deps.enqueueReportSyncJob(sql, {
        appId: args.appId ?? null,
        listingId: args.listingId ?? null,
        store: args.store ?? null,
        mode: args.mode ?? "incremental",
        reason: args.reason ?? (args.watch ? "cron" : "manual"),
        requestedBy: "worker",
      });
      log("enqueued job", { jobId: job.id, mode: job.mode, reused });
    }
    const result = await deps.processQueuedJobs(sql);
    log("drained queued jobs", result);
  } finally {
    await deps.releaseWorkerLock(sql);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const deps = await loadDeps();

  if (args.watch) {
    const intervalMs = Math.max(MIN_INTERVAL_MS, args.intervalMs || Number(process.env.MOBILE_REPORTS_WORKER_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
    log("watch mode started", { intervalMs });
    let stop = false;
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stop = true; });
    // Resident loop: each tick enqueues an incremental pass (so Google's newly
    // published reports are pulled even for apps nobody is viewing) and drains.
    while (!stop) {
      try {
        await runTick(deps, args, { enqueue: true });
      } catch (error) {
        log("tick failed (continuing)", { error: error instanceof Error ? error.message : String(error) });
      }
      // Interruptible sleep so SIGTERM stops promptly instead of after a full interval.
      for (let waited = 0; waited < intervalMs && !stop; waited += 1000) await sleep(Math.min(1000, intervalMs - waited));
    }
    log("watch mode stopping");
    await deps.closeSql();
    return;
  }

  // One-shot: enqueue from CLI intent unless we are a pure drain pass.
  const shouldEnqueue = !args.drainOnly && (args.mode != null || args.appId != null || args.listingId != null);
  try {
    await runTick(deps, args, { enqueue: shouldEnqueue });
  } finally {
    await deps.closeSql();
  }
}

main().catch((error) => {
  log("worker crashed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
