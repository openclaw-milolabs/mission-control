import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/modules/state", () => ({ isModuleEnabled: vi.fn() }));
vi.mock("@/lib/mobile-apps/sync", () => ({ syncApp: vi.fn(async () => []) }));
vi.mock("@/lib/local-db", () => ({ getSql: vi.fn(() => () => Promise.resolve([])) }));

import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { syncApp } from "@/lib/mobile-apps/sync";
import { POST } from "@/app/api/mobile-apps/sync/route";

const APP = "11111111-1111-4111-8111-111111111111";

function req(body: unknown) {
  return new Request("http://localhost/api/mobile-apps/sync", {
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

describe("light sync route rejects heavy report syncs", () => {
  it("rejects syncReports:true with 409 and does not call syncApp", async () => {
    const res = await POST(req({ appId: APP, syncReports: true }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.code).toBe("HEAVY_SYNC_NOT_ALLOWED_IN_WEB_ROUTE");
    expect(syncApp).not.toHaveBeenCalled();
  });

  it("rejects refreshReports:true with 409 and does not call syncApp", async () => {
    const res = await POST(req({ appId: APP, refreshReports: true }));
    expect(res.status).toBe(409);
    expect(syncApp).not.toHaveBeenCalled();
  });

  it("allows a light sync and forces syncReports:false + syncAppleStorefronts:false", async () => {
    const res = await POST(req({ appId: APP, force: true }));
    expect(res.status).toBe(200);
    expect(syncApp).toHaveBeenCalledTimes(1);
    const passedOpts = vi.mocked(syncApp).mock.calls[0]![1];
    expect(passedOpts).toMatchObject({ force: true, syncReports: false, syncAppleStorefronts: false });
  });
});
