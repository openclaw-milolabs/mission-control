#!/usr/bin/env tsx
/**
 * Detached, cron-drained worker for heavy Google Play report ETL.
 *
 * This is the ONLY place heavy CSV downloads / parsing / rollups run. It is never
 * invoked from a Next.js request — the API only enqueues jobs in
 * mobile_app_report_sync_jobs, and this worker drains them under a Postgres
 * advisory lock so two heavy syncs can never overlap.
 *
 * Usage (via package scripts):
 *   npm run mobile:reports:worker                 # drain queued jobs only
 *   npm run mobile:reports:sync:incremental       # enqueue an incremental job + drain
 *   npm run mobile:reports:sync:backfill          # enqueue a backfill job + drain
 *
 * Flags: --mode incremental|backfill  --app-id <uuid>  --listing-id <uuid>
 *        --store google|apple  --reason <text>  --drain-only
 */
import { existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

// Load env BEFORE importing anything that reads process.env at module-eval time
// (lib/local-db captures DATABASE_URL on first import). process.env already-set
// values win, matching the app's precedence.
for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) loadDotenv({ path: file });
}

type Args = {
  mode?: "incremental" | "backfill";
  appId?: string;
  listingId?: string;
  store?: "google" | "apple";
  reason?: string;
  drainOnly: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { drainOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--mode") out.mode = next() as Args["mode"];
    else if (a === "--app-id") out.appId = next();
    else if (a === "--listing-id") out.listingId = next();
    else if (a === "--store") out.store = next() as Args["store"];
    else if (a === "--reason") out.reason = next();
    else if (a === "--drain-only") out.drainOnly = true;
  }
  return out;
}

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), worker: "mobile-reports-sync", msg, ...extra }));

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { getSql, closeSql } = await import("@/lib/local-db");
  const { ensureMobileAppsSchema } = await import("@/lib/mobile-apps/ensure-schema");
  const { acquireWorkerLock, releaseWorkerLock, processQueuedJobs } = await import("@/lib/mobile-apps/report-worker");
  const { enqueueReportSyncJob } = await import("@/lib/mobile-apps/report-jobs");

  const sql = getSql();
  await ensureMobileAppsSchema(sql);

  const locked = await acquireWorkerLock(sql);
  if (!locked) {
    log("another worker holds the advisory lock; exiting", { skipped: true });
    await closeSql();
    return; // exit 0 — not an error
  }

  try {
    // Enqueue a job from CLI intent unless we are a pure drain pass. Bare
    // `--drain-only` (or no targeting flags) just drains whatever is queued.
    const shouldEnqueue = !args.drainOnly && (args.mode != null || args.appId != null || args.listingId != null);
    if (shouldEnqueue) {
      const { job, reused } = await enqueueReportSyncJob(sql, {
        appId: args.appId ?? null,
        listingId: args.listingId ?? null,
        store: args.store ?? null,
        mode: args.mode ?? "incremental",
        reason: args.reason ?? "cron",
        requestedBy: "worker",
      });
      log("enqueued job", { jobId: job.id, mode: job.mode, reused });
    }

    const result = await processQueuedJobs(sql);
    log("drained queued jobs", result);
  } finally {
    await releaseWorkerLock(sql);
    await closeSql();
  }
}

main().catch((error) => {
  log("worker crashed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
