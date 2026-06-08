import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/modules/state", () => ({ isModuleEnabled: vi.fn() }));
vi.mock("@/lib/mobile-apps/config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mobile-apps/config")>("@/lib/mobile-apps/config");
  return { ...actual, loadMobileReviewsConfig: vi.fn() };
});

import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { loadMobileReviewsConfig } from "@/lib/mobile-apps/config";
import { GET as configStatusGET } from "@/app/api/mobile-apps/config-status/route";

const session = vi.mocked(getSession);
const moduleEnabled = vi.mocked(isModuleEnabled);
const loadCfg = vi.mocked(loadMobileReviewsConfig);

afterEach(() => vi.restoreAllMocks());

describe("config-status route auth", () => {
  it("requires authentication (401 with no session)", async () => {
    session.mockResolvedValue(null);
    const res = await configStatusGET();
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("requires the mobile-apps module to be enabled (503)", async () => {
    session.mockResolvedValue({ sub: "s", name: "n", email: "u@example.com" });
    moduleEnabled.mockResolvedValue(false);
    const res = await configStatusGET();
    expect(res.status).toBe(503);
  });
});

describe("config-status never leaks secrets to the frontend", () => {
  it("returns only enabled/configured/error per store", async () => {
    session.mockResolvedValue({ sub: "s", name: "n", email: "u@example.com" });
    moduleEnabled.mockResolvedValue(true);
    loadCfg.mockReturnValue({
      google: {
        enabled: true,
        configured: true,
        error: null,
        packageName: "com.secret.package",
        serviceAccountJsonPath: "/secret/path/sa.json",
        serviceAccountJsonBase64: "U0VDUkVU",
        reportsBucket: "pubsite_prod_rev_secret",
        reportsLookbackMonths: 3,
      },
      apple: {
        enabled: true,
        configured: true,
        error: null,
        appId: "9999",
        issuerId: "iss-secret-id",
        keyId: "KEYSECRET",
        privateKeyPath: "/secret/AuthKey.p8",
        privateKeyBase64: "U0VDUkVU",
      },
      sync: { maxPages: 10, concurrency: 2, negativeThreshold: 3 },
      translate: { configured: true, email: null },
    });

    const res = await configStatusGET();
    expect(res.status).toBe(200);
    const json = await res.json();
    const serialized = JSON.stringify(json);
    for (const secret of ["com.secret.package", "/secret/path/sa.json", "iss-secret-id", "KEYSECRET", "/secret/AuthKey.p8", "U0VDUkVU"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(json.stores.google).toEqual({ enabled: true, configured: true, error: null });
    expect(json.stores.apple).toEqual({ enabled: true, configured: true, error: null });
  });
});
