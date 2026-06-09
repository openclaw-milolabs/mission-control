import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/modules/state", () => ({ isModuleEnabled: vi.fn() }));
vi.mock("@/lib/mobile-apps/ensure-schema", () => ({ ensureMobileAppsSchema: vi.fn(async () => {}) }));
vi.mock("@/lib/local-db", () => ({ getSql: vi.fn(() => () => Promise.resolve([])) }));
vi.mock("@/lib/mobile-apps/report-jobs", () => ({ enqueueReportSyncJob: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { enqueueReportSyncJob } from "@/lib/mobile-apps/report-jobs";
import { POST } from "@/app/api/mobile-apps/reports/sync/route";

const APP = "11111111-1111-4111-8111-111111111111";

function req(body: unknown) {
  return new Request("http://localhost/api/mobile-apps/reports/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(getSession).mockResolvedValue({ sub: "s", name: "n", email: "u@example.com" });
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/mobile-apps/reports/sync", () => {
  it("queues a job and returns 202 + jobId + poll url", async () => {
    vi.mocked(enqueueReportSyncJob).mockResolvedValue({
      job: { id: "job-1", status: "queued", mode: "incremental", store: "google", mobileAppId: APP, listingId: null },
      reused: false,
    });
    const res = await POST(req({ appId: APP, store: "google", mode: "incremental" }));
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, status: "queued", jobId: "job-1" });
    expect(json.poll).toContain("/api/mobile-apps/reports/status?jobId=job-1");
    expect(enqueueReportSyncJob).toHaveBeenCalledTimes(1);
  });

  it("reports a running job (reused) without creating a duplicate", async () => {
    vi.mocked(enqueueReportSyncJob).mockResolvedValue({
      job: { id: "run-1", status: "running", mode: "incremental", store: "google", mobileAppId: APP, listingId: null },
      reused: true,
    });
    const res = await POST(req({ appId: APP }));
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.status).toBe("running");
    expect(json.jobId).toBe("run-1");
    expect(json.message).toMatch(/already running/i);
  });

  it("rejects unauthenticated callers with 401 and does not enqueue", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await POST(req({ appId: APP }));
    expect(res.status).toBe(401);
    expect(enqueueReportSyncJob).not.toHaveBeenCalled();
  });

  it("validates the body (bad store → 422, no enqueue)", async () => {
    const res = await POST(req({ appId: APP, store: "nintendo" }));
    expect(res.status).toBe(422);
    expect(enqueueReportSyncJob).not.toHaveBeenCalled();
  });
});
