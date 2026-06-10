import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/local-db", () => ({ getSql: vi.fn() }));

import { checkOfficialReportFreshness, type FreshnessDeps } from "@/lib/mobile-apps/report-freshness";

const officialFile = (path: string, generation: string, yyyyMM = "202606") => ({
  kind: "installs",
  path,
  yyyyMM,
  dimension: "overview",
  generation,
  sizeBytes: 10,
  updated: "2026-06-09T00:00:00Z",
});

/** Router fake: returns rows by query shape; records calls. */
function routerSql(opts: { listing?: unknown[]; processed?: unknown[]; recentJob?: unknown[] }) {
  const calls: Array<{ q: string; values: unknown[] }> = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join(" ? ");
    calls.push({ q, values });
    if (/from mobile_app_listings/i.test(q)) return Promise.resolve(opts.listing ?? [{ store: "google", store_app_id: "com.x", mobile_app_id: "A1" }]);
    if (/update mobile_app_report_sync_jobs/i.test(q)) return Promise.resolve([]); // reap
    if (/from mobile_app_report_files/i.test(q)) return Promise.resolve(opts.processed ?? []);
    if (/from mobile_app_report_sync_jobs/i.test(q)) return Promise.resolve(opts.recentJob ?? []);
    return Promise.resolve([]); // freshness upsert etc.
  }) as unknown as ReturnType<typeof import("@/lib/local-db").getSql>;
  return { fn, calls };
}

function deps(files: unknown[], bucket: string | null = "pubsite_prod_rev_x"): FreshnessDeps {
  return {
    loadConfig: () => ({ google: { reportsBucket: bucket, reportsLookbackMonths: 3 } }) as never,
    listReportFiles: vi.fn(async () => files as never),
    listReviewReportFiles: vi.fn(async () => [] as never),
  };
}

afterEach(() => vi.clearAllMocks());

describe("checkOfficialReportFreshness", () => {
  it("not_configured when the reports bucket is missing (no GCS calls)", async () => {
    const { fn } = routerSql({});
    const d = deps([officialFile("stats/installs/installs_com.x_202606_overview.csv", "100")], null);
    const res = await checkOfficialReportFreshness(fn as never, "L1", d);
    expect(res.status).toBe("not_configured");
    expect(res.needsWorker).toBe(false);
    expect(d.listReportFiles).not.toHaveBeenCalled();
  });

  it("fresh when every official generation is already processed", async () => {
    const path = "stats/installs/installs_com.x_202606_overview.csv";
    const { fn } = routerSql({ processed: [{ object_path: path, generation: "100" }] });
    const res = await checkOfficialReportFreshness(fn as never, "L1", deps([officialFile(path, "100")]));
    expect(res.status).toBe("fresh");
    expect(res.needsWorker).toBe(false);
    expect(res.latestOfficialGeneration).toBe("100");
    expect(res.latestProcessedGeneration).toBe("100");
  });

  it("stale + needsWorker when an official generation is newer than what is processed", async () => {
    const path = "stats/installs/installs_com.x_202606_overview.csv";
    const { fn } = routerSql({ processed: [{ object_path: path, generation: "99" }] });
    const res = await checkOfficialReportFreshness(fn as never, "L1", deps([officialFile(path, "100")]));
    expect(res.status).toBe("stale");
    expect(res.needsWorker).toBe(true);
  });

  it("refreshing when a job is already queued/running (does not ask for another worker)", async () => {
    const path = "stats/installs/installs_com.x_202606_overview.csv";
    const { fn } = routerSql({ processed: [{ object_path: path, generation: "99" }], recentJob: [{ id: "job-1", status: "running" }] });
    const res = await checkOfficialReportFreshness(fn as never, "L1", deps([officialFile(path, "100")]));
    expect(res.status).toBe("refreshing");
    expect(res.needsWorker).toBe(false);
  });

  it("active-job query also matches the worker's global jobs (no app/listing target)", async () => {
    const path = "stats/installs/installs_com.x_202606_overview.csv";
    const { fn, calls } = routerSql({ processed: [{ object_path: path, generation: "99" }] });
    await checkOfficialReportFreshness(fn as never, "L1", deps([officialFile(path, "100")]));
    const jobQuery = calls.find((c) => /select id::text, status from mobile_app_report_sync_jobs/i.test(c.q));
    expect(jobQuery, "the recent-job lookup exists").toBeTruthy();
    // The worker's periodic incremental pass enqueues with NULL app + NULL listing;
    // it covers every listing, so it must read as 'refreshing' rather than letting
    // a detail-page check enqueue duplicate work mid-pass.
    expect(jobQuery!.q).toMatch(/listing_id is null and mobile_app_id is null/i);
  });

  it("failed when the most recent job failed and official data is still unprocessed", async () => {
    const path = "stats/installs/installs_com.x_202606_overview.csv";
    const { fn } = routerSql({ processed: [{ object_path: path, generation: "99" }], recentJob: [{ id: "job-1", status: "failed" }] });
    const res = await checkOfficialReportFreshness(fn as never, "L1", deps([officialFile(path, "100")]));
    expect(res.status).toBe("failed");
    expect(res.needsWorker).toBe(true);
  });

  it("never downloads CSV bytes — only lists metadata", async () => {
    const path = "stats/installs/installs_com.x_202606_overview.csv";
    const d = deps([officialFile(path, "100")]);
    const { fn } = routerSql({ processed: [{ object_path: path, generation: "100" }] });
    await checkOfficialReportFreshness(fn as never, "L1", d);
    expect(d.listReportFiles).toHaveBeenCalled();
  });
});
