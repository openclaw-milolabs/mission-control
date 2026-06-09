import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/local-db", () => ({ getSql: vi.fn() }));

import { reapStaleReportJobs } from "@/lib/mobile-apps/report-jobs";

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
