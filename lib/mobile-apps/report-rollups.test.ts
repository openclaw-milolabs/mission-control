import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/local-db", () => ({ getSql: vi.fn() }));

import { refreshReportRollups, readReportRollups, readLatestBreakdowns } from "@/lib/mobile-apps/report-rollups";

/** Recording tagged-template stub. Returns `rows` for any query; records SQL + values. */
function recordingSql(rows: unknown[] = []) {
  const calls: Array<{ q: string; values: unknown[] }> = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ q: strings.join(" ? "), values });
    return Promise.resolve(rows);
  }) as unknown as ReturnType<typeof import("@/lib/local-db").getSql> & { array: (v: unknown[]) => unknown };
  // postgres.js sql.array(...) helper — identity is fine for recording.
  (fn as unknown as { array: (v: unknown[]) => unknown }).array = (v: unknown[]) => v;
  return { fn, calls, joined: () => calls.map((c) => c.q).join("\n") };
}

afterEach(() => vi.clearAllMocks());

describe("refreshReportRollups dimension contracts", () => {
  it("clears the listing's rollups/breakdowns before rebuilding (idempotent rebuild)", async () => {
    const { fn, joined } = recordingSql();
    await refreshReportRollups(fn as never, "L1");
    const all = joined();
    expect(all).toMatch(/delete from mobile_app_report_daily_rollups/i);
    expect(all).toMatch(/delete from mobile_app_report_latest_breakdowns/i);
  });

  it("installs/crashes rollups use the overview dimension only (no double-count)", async () => {
    const { fn, calls } = recordingSql();
    await refreshReportRollups(fn as never, "L1");
    const overviewInsert = calls.find(
      (c) =>
        /insert into mobile_app_report_daily_rollups/i.test(c.q) &&
        /report in \('installs','crashes'\)/i.test(c.q),
    );
    expect(overviewInsert, "an installs/crashes rollup insert exists").toBeTruthy();
    expect(overviewInsert!.q).toMatch(/dimension = 'overview'/i);
  });

  it("store_performance rollup sums the country dimension", async () => {
    const { fn, calls } = recordingSql();
    await refreshReportRollups(fn as never, "L1");
    const storePerf = calls.find(
      (c) =>
        /insert into mobile_app_report_daily_rollups/i.test(c.q) &&
        /store_performance/i.test(c.q),
    );
    expect(storePerf, "a store_performance rollup insert exists").toBeTruthy();
    expect(storePerf!.q).toMatch(/dimension = 'country'/i);
    expect(storePerf!.q).toMatch(/jsonb_each_text/i);
  });

  it("latest breakdowns exclude overview AND ratings", async () => {
    const { fn, calls } = recordingSql();
    await refreshReportRollups(fn as never, "L1");
    const breakdown = calls.find((c) => /insert into mobile_app_report_latest_breakdowns/i.test(c.q));
    expect(breakdown, "a latest-breakdowns insert exists").toBeTruthy();
    expect(breakdown!.q).toMatch(/dimension <> 'overview'/i);
    expect(breakdown!.q).toMatch(/report <> 'ratings'/i);
  });
});

describe("read helpers read from rollup tables, not raw metrics", () => {
  it("readReportRollups selects from mobile_app_report_daily_rollups and parses jsonb metrics", async () => {
    const { fn, joined } = recordingSql([
      { listing_id: "L1", report: "installs", date: "2026-06-01", metrics: '{"daily_device_installs":10}', source: "s" },
    ]);
    const rows = await readReportRollups(fn as never, ["L1"]);
    expect(joined()).toMatch(/from mobile_app_report_daily_rollups/i);
    expect(joined()).not.toMatch(/from mobile_app_report_metrics/i);
    expect(rows[0]!.metrics).toEqual({ daily_device_installs: 10 });
  });

  it("readLatestBreakdowns selects from the breakdown table and applies a bounded limit", async () => {
    const { fn, joined } = recordingSql([]);
    await readLatestBreakdowns(fn as never, ["L1"], { limit: 200 });
    const all = joined();
    expect(all).toMatch(/from mobile_app_report_latest_breakdowns/i);
    expect(all).toMatch(/limit/i);
  });

  it("readReportRollups returns [] for empty listing set without querying", async () => {
    const { fn, calls } = recordingSql();
    const rows = await readReportRollups(fn as never, []);
    expect(rows).toEqual([]);
    expect(calls.length).toBe(0);
  });
});
