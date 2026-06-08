import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileReviewsConfig } from "@/lib/mobile-apps/config";

// Mock the credential-loading modules so no real keys/files are touched.
vi.mock("@/lib/mobile-apps/config", () => ({ loadMobileReviewsConfig: vi.fn() }));
vi.mock("@/lib/mobile-apps/providers/google-play-client", () => ({
  ANDROID_PUBLISHER_SCOPE: "scope",
  createAndroidPublisherClient: vi.fn(),
}));
vi.mock("@/lib/mobile-apps/providers/app-store-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mobile-apps/providers/app-store-client")>(
    "@/lib/mobile-apps/providers/app-store-client",
  );
  return { ...actual, createAppStoreConnectToken: vi.fn() };
});

import { loadMobileReviewsConfig } from "@/lib/mobile-apps/config";
import { createAndroidPublisherClient } from "@/lib/mobile-apps/providers/google-play-client";
import { createAppStoreConnectToken } from "@/lib/mobile-apps/providers/app-store-client";
import { GoogleProvider } from "@/lib/mobile-apps/providers/google";
import { AppleProvider } from "@/lib/mobile-apps/providers/apple";

function cfg(overrides: Partial<MobileReviewsConfig> = {}): MobileReviewsConfig {
  return {
    google: {
      enabled: true,
      configured: true,
      error: null,
      packageName: "com.example.app",
      serviceAccountJsonPath: "/x.json",
      serviceAccountJsonBase64: null,
    },
    apple: {
      enabled: true,
      configured: true,
      error: null,
      appId: "9999",
      issuerId: "iss",
      keyId: "kid",
      privateKeyPath: "/x.p8",
      privateKeyBase64: null,
    },
    sync: { maxPages: 10, concurrency: 2, negativeThreshold: 3 },
    translate: { configured: true, email: null },
    ...overrides,
  };
}

const loadCfg = vi.mocked(loadMobileReviewsConfig);
const makeClient = vi.mocked(createAndroidPublisherClient);
const makeToken = vi.mocked(createAppStoreConnectToken);

afterEach(() => vi.restoreAllMocks());

describe("GoogleProvider.fetchReviews (official Android Publisher API)", () => {
  it("calls reviews.list and NEVER reviews.reply", async () => {
    loadCfg.mockReturnValue(cfg());
    const list = vi.fn(async () => ({
      data: { reviews: [{ reviewId: "r1", comments: [{ userComment: { starRating: 5 } }] }], tokenPagination: {} },
    }));
    const reply = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    makeClient.mockReturnValue({ reviews: { list, reply } } as any);

    const reviews = await new GoogleProvider().fetchReviews({ store: "google", storeAppId: "com.example.app", country: "us" });

    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: "com.example.app" }),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(reply).not.toHaveBeenCalled();
    expect(reviews).toHaveLength(1);
  });

  it("throws a clean error when Google is not configured", async () => {
    loadCfg.mockReturnValue(cfg({ google: { ...cfg().google, configured: false, error: "Missing required Google Play config: GOOGLE_PLAY_PACKAGE_NAME" } }));
    await expect(
      new GoogleProvider().fetchReviews({ store: "google", storeAppId: "com.example.app", country: "us" }),
    ).rejects.toThrow(/Missing required Google Play config/);
  });
});

describe("AppleProvider.fetchReviews (official App Store Connect API)", () => {
  it("GETs /customerReviews and NEVER /customerReviewResponses", async () => {
    loadCfg.mockReturnValue(cfg());
    makeToken.mockResolvedValue("test-token");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "a1", attributes: { rating: 4 } }], links: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const reviews = await new AppleProvider().fetchReviews({ store: "apple", storeAppId: "9999", country: "us" });

    const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes("/v1/apps/9999/customerReviews"))).toBe(true);
    expect(calledUrls.some((u) => u.includes("customerReviewResponses"))).toBe(false);
    expect(reviews).toHaveLength(1);
  });

  it("throws a clean error when Apple is not configured", async () => {
    loadCfg.mockReturnValue(cfg({ apple: { ...cfg().apple, configured: false, error: "Missing required App Store Connect config: APPSTORE_CONNECT_ISSUER_ID" } }));
    await expect(
      new AppleProvider().fetchReviews({ store: "apple", storeAppId: "9999", country: "us" }),
    ).rejects.toThrow(/Missing required App Store Connect config/);
  });
});
