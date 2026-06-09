import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mobile-apps/api-auth", () => ({ requireMobileAppsApiAuth: vi.fn() }));
vi.mock("@/lib/modules/state", () => ({ isModuleEnabled: vi.fn() }));
vi.mock("@/lib/mobile-apps/ensure-schema", () => ({ ensureMobileAppsSchema: vi.fn(async () => {}) }));
vi.mock("@/lib/local-db", () => ({ getSql: vi.fn() }));

import { requireMobileAppsApiAuth } from "@/lib/mobile-apps/api-auth";
import { isModuleEnabled } from "@/lib/modules/state";
import { getSql } from "@/lib/local-db";
import { GET } from "@/app/api/mobile-apps/reports/status/route";

const APP = "11111111-1111-4111-8111-111111111111";

function routerSql() {
  const calls: string[] = [];
  const fn = ((strings: TemplateStringsArray) => {
    const q = strings.join(" ? ");
    calls.push(q);
    if (/from mobile_app_report_sync_jobs/i.test(q)) return Promise.resolve([{ id: "job-1", status: "queued" }]);
    if (/from mobile_app_report_freshness/i.test(q)) return Promise.resolve([{ listing_id: "L1", status: "fresh" }]);
    return Promise.resolve([]);
  }) as unknown as ReturnType<typeof getSql>;
  return { fn, calls };
}

beforeEach(() => {
  vi.mocked(requireMobileAppsApiAuth).mockResolvedValue({ type: "token", email: null });
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
});
afterEach(() => vi.clearAllMocks());

describe("GET /api/mobile-apps/reports/status", () => {
  it("returns recent jobs and freshness for an appId", async () => {
    const { fn, calls } = routerSql();
    vi.mocked(getSql).mockReturnValue(fn);
    const res = await GET(new Request(`http://localhost/api/mobile-apps/reports/status?appId=${APP}`));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.jobs).toEqual([{ id: "job-1", status: "queued" }]);
    expect(json.freshness).toEqual([{ listing_id: "L1", status: "fresh" }]);
    expect(calls.some((q) => /from mobile_app_report_sync_jobs/i.test(q))).toBe(true);
  });

  it("rejects unauthenticated callers with 401", async () => {
    vi.mocked(requireMobileAppsApiAuth).mockResolvedValue(null);
    vi.mocked(getSql).mockReturnValue(routerSql().fn);
    const res = await GET(new Request("http://localhost/api/mobile-apps/reports/status?jobId=job-1"));
    expect(res.status).toBe(401);
  });
});
