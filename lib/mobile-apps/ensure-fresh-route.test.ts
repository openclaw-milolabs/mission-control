import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/modules/state", () => ({ isModuleEnabled: vi.fn() }));
vi.mock("@/lib/mobile-apps/ensure-schema", () => ({ ensureMobileAppsSchema: vi.fn(async () => {}) }));
vi.mock("@/lib/local-db", () => ({ getSql: vi.fn() }));
vi.mock("@/lib/mobile-apps/sync", () => ({ syncApp: vi.fn(async () => []) }));
vi.mock("@/lib/mobile-apps/report-freshness", () => ({
  checkOfficialReportFreshness: vi.fn(),
  readStoredFreshness: vi.fn(async () => []),
}));
vi.mock("@/lib/mobile-apps/report-jobs", () => ({ enqueueReportSyncJob: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { getSql } from "@/lib/local-db";
import { syncApp } from "@/lib/mobile-apps/sync";
import { checkOfficialReportFreshness } from "@/lib/mobile-apps/report-freshness";
import { enqueueReportSyncJob } from "@/lib/mobile-apps/report-jobs";
import { POST } from "@/app/api/mobile-apps/[id]/ensure-fresh/route";

const APP = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id: APP });

function fakeSql() {
  const fn = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const q = strings.join(" ");
    if (q.includes("from workspaces")) return Promise.resolve([{ id: "w1" }]);
    if (q.includes("from mobile_apps where id")) return Promise.resolve([{ id: "app1" }]);
    if (q.includes("from mobile_app_listings")) return Promise.resolve([{ id: "L1", store: "google" }]);
    return Promise.resolve([]);
  };
  (fn as unknown as { array: (a: unknown) => unknown }).array = (a: unknown) => a;
  return fn;
}

const fresh = { status: "fresh", needsWorker: false, latestOfficialYyyyMm: "202606", latestProcessedYyyyMm: "202606", latestOfficialGeneration: "100", latestProcessedGeneration: "100", activeJobId: null, warnings: [] };
const stale = { ...fresh, status: "stale", needsWorker: true, latestProcessedYyyyMm: "202605", latestProcessedGeneration: "90" };

function req(body: unknown) {
  return new Request(`http://localhost/api/mobile-apps/${APP}/ensure-fresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(getSession).mockResolvedValue({ sub: "s", name: "n", email: "u@example.com" });
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
  vi.mocked(getSql).mockReturnValue(fakeSql() as never);
  vi.mocked(enqueueReportSyncJob).mockResolvedValue({ job: { id: "job-1", status: "queued", mode: "incremental", store: "google", mobileAppId: APP, listingId: null }, reused: false });
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/mobile-apps/[id]/ensure-fresh", () => {
  it("always runs a LIGHT sync (never heavy report flags)", async () => {
    vi.mocked(checkOfficialReportFreshness).mockResolvedValue(fresh as never);
    await POST(req({ consistency: "available" }), { params });
    expect(syncApp).toHaveBeenCalledTimes(1);
    const opts = (vi.mocked(syncApp).mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(opts).toMatchObject({ force: true, syncReports: false, syncAppleStorefronts: false });
  });

  it("strict + stale → 202 refreshing, enqueues a worker, returns jobId, no stale charts", async () => {
    vi.mocked(checkOfficialReportFreshness).mockResolvedValue(stale as never);
    const res = await POST(req({ consistency: "strict" }), { params });
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.fresh).toBe(false);
    expect(json.status).toBe("refreshing");
    expect(json.jobId).toBe("job-1");
    expect(enqueueReportSyncJob).toHaveBeenCalledTimes(1);
  });

  it("strict + fresh → 200 fresh, no worker enqueued", async () => {
    vi.mocked(checkOfficialReportFreshness).mockResolvedValue(fresh as never);
    const res = await POST(req({ consistency: "strict" }), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.fresh).toBe(true);
    expect(json.status).toBe("fresh");
    expect(enqueueReportSyncJob).not.toHaveBeenCalled();
  });

  it("available + stale → 200 with reportsFresh:false (UI may show last charts, labeled)", async () => {
    vi.mocked(checkOfficialReportFreshness).mockResolvedValue(stale as never);
    const res = await POST(req({ consistency: "available" }), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.reportsFresh).toBe(false);
    expect(enqueueReportSyncJob).toHaveBeenCalledTimes(1);
  });

  it("requires authentication", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await POST(req({}), { params });
    expect(res.status).toBe(401);
    expect(syncApp).not.toHaveBeenCalled();
  });
});
