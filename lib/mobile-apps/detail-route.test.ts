import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/modules/state", () => ({ isModuleEnabled: vi.fn() }));
vi.mock("@/lib/mobile-apps/ensure-schema", () => ({ ensureMobileAppsSchema: vi.fn(async () => {}) }));
vi.mock("@/lib/local-db", () => ({ getSql: vi.fn() }));
vi.mock("@/lib/mobile-apps/config", () => ({ loadMobileReviewsConfig: vi.fn(() => ({ sync: { negativeThreshold: 3 } })) }));
vi.mock("@/lib/mobile-apps/report-rollups", () => ({ readReportRollups: vi.fn(async () => []), readLatestBreakdowns: vi.fn(async () => []) }));
vi.mock("@/lib/mobile-apps/report-freshness", () => ({ checkOfficialReportFreshness: vi.fn(), readStoredFreshness: vi.fn(async () => []) }));
vi.mock("@/lib/mobile-apps/report-jobs", () => ({ enqueueReportSyncJob: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { getSql } from "@/lib/local-db";
import { checkOfficialReportFreshness, readStoredFreshness } from "@/lib/mobile-apps/report-freshness";
import { enqueueReportSyncJob } from "@/lib/mobile-apps/report-jobs";
import { GET } from "@/app/api/mobile-apps/[id]/route";

const APP = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id: APP });

function fakeSql() {
  const fn = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const q = strings.join(" ");
    if (q.includes("from workspaces")) return Promise.resolve([{ id: "w1" }]);
    if (q.includes("from mobile_apps where id")) return Promise.resolve([{ id: "app1", name: "MyApp" }]);
    if (q.includes("from mobile_app_listings where mobile_app_id"))
      return Promise.resolve([{ id: "L1", store: "google", last_synced_at: "2026-06-09T08:00:00Z", official_ratings: [] }]);
    return Promise.resolve([]);
  };
  (fn as unknown as { array: (a: unknown) => unknown }).array = (a: unknown) => a;
  return fn;
}

const result = (status: string, needsWorker: boolean) => ({
  status, needsWorker,
  latestOfficialYyyyMm: "202606", latestProcessedYyyyMm: status === "fresh" ? "202606" : "202605",
  latestOfficialGeneration: "100", latestProcessedGeneration: status === "fresh" ? "100" : "90",
  activeJobId: status === "refreshing" ? "job-x" : null, warnings: [],
});

beforeEach(() => {
  vi.mocked(getSession).mockResolvedValue({ sub: "s", name: "n", email: "u@example.com" });
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
  vi.mocked(getSql).mockReturnValue(fakeSql() as never);
  vi.mocked(enqueueReportSyncJob).mockResolvedValue({ job: { id: "job-1", status: "queued", mode: "incremental", store: "google", mobileAppId: APP, listingId: null }, reused: false });
});
afterEach(() => vi.clearAllMocks());

const req = (qs = "") => new Request(`http://localhost/api/mobile-apps/${APP}${qs}`);

describe("GET /api/mobile-apps/[id] freshness contract", () => {
  it("available (default): 200 with freshness attached, never calls live GCS check", async () => {
    vi.mocked(readStoredFreshness).mockResolvedValue([
      { listingId: "L1", status: "fresh", latestOfficialYyyyMm: "202606", latestProcessedYyyyMm: "202606", checkedAt: "x", processedAt: "y", activeJobId: null, errorMessage: null },
    ]);
    const res = await GET(req("?consistency=available"), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.freshness.googleReports.status).toBe("fresh");
    expect(json.reports).toBeDefined();
    expect(checkOfficialReportFreshness).not.toHaveBeenCalled();
  });

  it("strict + stale: 202 refreshing, omits report charts, enqueues worker", async () => {
    vi.mocked(checkOfficialReportFreshness).mockResolvedValue(result("stale", true) as never);
    const res = await GET(req("?consistency=strict"), { params });
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.fresh).toBe(false);
    expect(json.reports).toBeUndefined(); // no stale charts presented as fresh
    expect(json.freshness.googleReports.status).toBe("stale");
    expect(enqueueReportSyncJob).toHaveBeenCalledTimes(1);
  });

  it("strict + fresh: 200 with reports", async () => {
    vi.mocked(checkOfficialReportFreshness).mockResolvedValue(result("fresh", false) as never);
    const res = await GET(req("?consistency=strict"), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.reports).toBeDefined();
    expect(json.reportsFresh).toBe(true);
    expect(enqueueReportSyncJob).not.toHaveBeenCalled();
  });
});
