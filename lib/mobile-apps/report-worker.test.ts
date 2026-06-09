import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/local-db", () => ({ getSql: vi.fn() }));
// Keep the real report-jobs (reap is pure SQL) — only sync/rollups are injected.

import {
  acquireWorkerLock,
  claimQueuedJobs,
  finishJob,
  processQueuedJobs,
  type WorkerDeps,
} from "@/lib/mobile-apps/report-worker";

/** Router fake that returns rows by query shape and records calls + values. */
function routerSql(opts: { locked?: boolean; claimed?: unknown[] } = {}) {
  const calls: Array<{ q: string; values: unknown[] }> = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join(" ? ");
    calls.push({ q, values });
    if (/pg_try_advisory_lock/i.test(q)) return Promise.resolve([{ locked: opts.locked ?? true }]);
    if (/update mobile_app_report_sync_jobs/i.test(q) && /status\s*=\s*'running'/i.test(q))
      return Promise.resolve(opts.claimed ?? []);
    return Promise.resolve([]);
  }) as unknown as ReturnType<typeof import("@/lib/local-db").getSql>;
  return { fn, calls, find: (re: RegExp) => calls.filter((c) => re.test(c.q)) };
}

afterEach(() => vi.clearAllMocks());

describe("worker advisory lock", () => {
  it("acquireWorkerLock returns true when the lock is granted", async () => {
    const { fn } = routerSql({ locked: true });
    expect(await acquireWorkerLock(fn as never)).toBe(true);
  });
  it("acquireWorkerLock returns false when another worker holds it", async () => {
    const { fn } = routerSql({ locked: false });
    expect(await acquireWorkerLock(fn as never)).toBe(false);
  });
});

describe("claimQueuedJobs", () => {
  it("flips queued jobs to running and returns them", async () => {
    const { fn, find } = routerSql({ claimed: [{ id: "j1", mode: "incremental", store: "google", mobileAppId: "A1", listingId: null }] });
    const jobs = await claimQueuedJobs(fn as never);
    expect(jobs).toHaveLength(1);
    const claim = find(/update mobile_app_report_sync_jobs/i)[0]!;
    expect(claim.q).toMatch(/status\s*=\s*'running'/i);
    expect(claim.q).toMatch(/where status\s*=\s*'queued'/i);
  });
});

describe("finishJob", () => {
  it("sets the terminal status and finished_at", async () => {
    const { fn, calls } = routerSql();
    await finishJob(fn as never, "j1", { status: "success" });
    const upd = calls[0]!;
    expect(upd.q).toMatch(/finished_at\s*=\s*now\(\)/i);
    expect(upd.values).toContain("success");
  });
});

describe("processQueuedJobs orchestration", () => {
  it("runs the HEAVY sync path, refreshes rollups, and finishes the job success", async () => {
    const { fn, calls } = routerSql({
      claimed: [{ id: "j1", mode: "incremental", store: "google", mobileAppId: "A1", listingId: null }],
    });
    const syncApp = vi.fn(async () => [
      { listingId: "L1", store: "google", status: "success", reportWarnings: [], fetched: 3, inserted: 1 },
    ]);
    const refreshReportRollups = vi.fn(async () => {});
    const deps: WorkerDeps = { syncApp: syncApp as never, refreshReportRollups };

    const result = await processQueuedJobs(fn as never, deps);

    expect(result.processed).toBe(1);
    // Heavy flags are ON in the worker (the whole point — this is the only caller allowed to).
    expect(syncApp).toHaveBeenCalledTimes(1);
    const opts = (syncApp.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(opts).toMatchObject({ force: true, syncReports: true, syncAppleStorefronts: true });
    // Rollups refreshed for the google listing.
    expect(refreshReportRollups).toHaveBeenCalledWith(fn, "L1");
    // Job finished success.
    const finish = calls.find((c) => /update mobile_app_report_sync_jobs/i.test(c.q) && c.values.includes("success"));
    expect(finish, "a success finish update was issued").toBeTruthy();
    // UI notified.
    expect(calls.some((c) => /pg_notify\('mobile_apps_change'/i.test(c.q))).toBe(true);
  });

  it("marks the job failed when the sync throws, and does not crash the loop", async () => {
    const { fn, calls } = routerSql({
      claimed: [{ id: "j1", mode: "incremental", store: "google", mobileAppId: "A1", listingId: null }],
    });
    const deps: WorkerDeps = {
      syncApp: (async () => {
        throw new Error("boom");
      }) as never,
      refreshReportRollups: vi.fn(async () => {}),
    };
    const result = await processQueuedJobs(fn as never, deps);
    expect(result.processed).toBe(1);
    const finish = calls.find((c) => /update mobile_app_report_sync_jobs/i.test(c.q) && c.values.includes("failed"));
    expect(finish, "a failed finish update was issued").toBeTruthy();
  });
});
