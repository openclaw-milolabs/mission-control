import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/local-db", () => ({ getSql: vi.fn() }));

import { reapStaleReportJobs, enqueueReportSyncJob } from "@/lib/mobile-apps/report-jobs";

function recordingSql(rows: unknown[] = []) {
  const calls: Array<{ q: string; values: unknown[] }> = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ q: strings.join(" ? "), values });
    return Promise.resolve(rows);
  }) as unknown as ReturnType<typeof import("@/lib/local-db").getSql>;
  return { fn, calls, joined: () => calls.map((c) => c.q).join("\n") };
}

afterEach(() => vi.clearAllMocks());

describe("reapStaleReportJobs", () => {
  it("marks running jobs with a stale heartbeat as failed and returns how many", async () => {
    const { fn, calls } = recordingSql([{ id: "j1" }, { id: "j2" }]);
    const reaped = await reapStaleReportJobs(fn as never, { staleMs: 300_000 });

    expect(reaped).toBe(2);
    const update = calls[0]!;
    expect(update.q).toMatch(/update mobile_app_report_sync_jobs/i);
    expect(update.q).toMatch(/status = 'failed'/i);
    expect(update.q).toMatch(/status = 'running'/i); // only touches running jobs
    expect(update.q).toMatch(/heartbeat_at/i);
    // staleMs is parameterised so the threshold is configurable.
    expect(update.values).toContain(300_000);
  });

  it("treats a job with no heartbeat by falling back to started_at/created_at", async () => {
    const { fn, joined } = recordingSql([]);
    await reapStaleReportJobs(fn as never);
    expect(joined()).toMatch(/coalesce\(\s*heartbeat_at\s*,\s*started_at\s*,\s*created_at\s*\)/i);
  });
});

/** Router fake: returns different rows depending on the SQL verb/table. */
function routerSql(opts: { existing?: unknown[]; inserted?: unknown[] } = {}) {
  const calls: Array<{ q: string; values: unknown[] }> = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join(" ? ");
    calls.push({ q, values });
    if (/update mobile_app_report_sync_jobs/i.test(q) && /status = 'failed'/i.test(q)) return Promise.resolve([]); // reap
    if (/^\s*select/i.test(q) && /from mobile_app_report_sync_jobs/i.test(q)) return Promise.resolve(opts.existing ?? []);
    if (/insert into mobile_app_report_sync_jobs/i.test(q)) return Promise.resolve(opts.inserted ?? [{ id: "new-job", status: "queued" }]);
    return Promise.resolve([]);
  }) as unknown as ReturnType<typeof import("@/lib/local-db").getSql>;
  return { fn, calls, joined: () => calls.map((c) => c.q).join("\n") };
}

describe("enqueueReportSyncJob", () => {
  it("reaps stale jobs and inserts a new queued job when none is active", async () => {
    const { fn, calls, joined } = routerSql({ inserted: [{ id: "job-1", status: "queued" }] });
    const result = await enqueueReportSyncJob(fn as never, { appId: "A1", store: "google", mode: "incremental" });

    expect(result.reused).toBe(false);
    expect(result.job).toMatchObject({ id: "job-1", status: "queued" });
    // Reap happens before the duplicate check.
    const reapIdx = calls.findIndex((c) => /status = 'failed'/i.test(c.q));
    const selectIdx = calls.findIndex((c) => /^\s*select/i.test(c.q) && /from mobile_app_report_sync_jobs/i.test(c.q));
    expect(reapIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThan(reapIdx);
    expect(joined()).toMatch(/insert into mobile_app_report_sync_jobs/i);
  });

  it("reuses an existing queued/running job instead of inserting a duplicate", async () => {
    const { fn, joined } = routerSql({ existing: [{ id: "running-1", status: "running" }] });
    const result = await enqueueReportSyncJob(fn as never, { appId: "A1", store: "google", mode: "incremental" });

    expect(result.reused).toBe(true);
    expect(result.job).toMatchObject({ id: "running-1", status: "running" });
    expect(joined()).not.toMatch(/insert into mobile_app_report_sync_jobs/i);
  });

  it("tolerates a concurrent-insert race: on unique violation, returns the winner as reused", async () => {
    // First active-job SELECT → none; INSERT → throws (partial unique index fired);
    // second active-job SELECT → the job the racing request created.
    let selects = 0;
    const calls: string[] = [];
    const fn = ((strings: TemplateStringsArray) => {
      const q = strings.join(" ? ");
      calls.push(q);
      if (/status = 'failed'/i.test(q)) return Promise.resolve([]); // reap
      if (/^\s*select/i.test(q) && /from mobile_app_report_sync_jobs/i.test(q)) {
        selects += 1;
        return selects === 1 ? Promise.resolve([]) : Promise.resolve([{ id: "winner", status: "queued" }]);
      }
      if (/insert into mobile_app_report_sync_jobs/i.test(q)) return Promise.reject(new Error("duplicate key value violates unique constraint"));
      return Promise.resolve([]);
    }) as unknown as ReturnType<typeof import("@/lib/local-db").getSql>;

    const result = await enqueueReportSyncJob(fn as never, { appId: "A1", mode: "incremental" });
    expect(result.reused).toBe(true);
    expect(result.job).toMatchObject({ id: "winner" });
  });

  it("dedupe check is scoped to active statuses only", async () => {
    const { fn, calls } = routerSql();
    await enqueueReportSyncJob(fn as never, { appId: "A1", mode: "incremental" });
    const select = calls.find((c) => /^\s*select/i.test(c.q) && /from mobile_app_report_sync_jobs/i.test(c.q))!;
    expect(select.q).toMatch(/status in \('queued','running'\)/i);
  });
});
