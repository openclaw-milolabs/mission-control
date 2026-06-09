import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

import { getSession } from "@/lib/auth/session";
import { requireMobileAppsApiAuth } from "@/lib/mobile-apps/api-auth";

function req(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/mobile-apps/reports/sync", { method: "POST", headers });
}

const ORIG = process.env.MOBILE_APPS_API_TOKEN;
beforeEach(() => vi.mocked(getSession).mockResolvedValue(null));
afterEach(() => {
  vi.clearAllMocks();
  if (ORIG === undefined) delete process.env.MOBILE_APPS_API_TOKEN;
  else process.env.MOBILE_APPS_API_TOKEN = ORIG;
});

describe("requireMobileAppsApiAuth", () => {
  it("accepts a logged-in session", async () => {
    vi.mocked(getSession).mockResolvedValue({ sub: "s", name: "n", email: "u@example.com" });
    const auth = await requireMobileAppsApiAuth(req());
    expect(auth).toEqual({ type: "session", email: "u@example.com" });
  });

  it("accepts a matching bearer token when no session", async () => {
    process.env.MOBILE_APPS_API_TOKEN = "sekret-token";
    const auth = await requireMobileAppsApiAuth(req({ authorization: "Bearer sekret-token" }));
    expect(auth).toEqual({ type: "token", email: null });
  });

  it("rejects a wrong bearer token", async () => {
    process.env.MOBILE_APPS_API_TOKEN = "sekret-token";
    const auth = await requireMobileAppsApiAuth(req({ authorization: "Bearer nope" }));
    expect(auth).toBeNull();
  });

  it("rejects when neither session nor token present", async () => {
    delete process.env.MOBILE_APPS_API_TOKEN;
    const auth = await requireMobileAppsApiAuth(req({ authorization: "Bearer anything" }));
    expect(auth).toBeNull();
  });

  it("does not accept an empty configured token (treats unset token as disabled)", async () => {
    process.env.MOBILE_APPS_API_TOKEN = "   ";
    const auth = await requireMobileAppsApiAuth(req({ authorization: "Bearer " }));
    expect(auth).toBeNull();
  });
});
