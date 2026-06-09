import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/local-db", () => ({ getSql: vi.fn() }));
vi.mock("@/lib/mobile-apps/config", () => ({ loadMobileReviewsConfig: vi.fn() }));
vi.mock("@/lib/mobile-apps/providers", () => ({ getProvider: vi.fn() }));
vi.mock("@/lib/mobile-apps/ensure-schema", () => ({ ensureMobileAppsSchema: vi.fn(async () => {}) }));

// Keep the real DIMENSIONS constants and mappers; only stub the GCS listing calls
// so the heavy download path is observable without touching Cloud Storage.
vi.mock("@/lib/mobile-apps/providers/google-play-reports", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mobile-apps/providers/google-play-reports")>(
    "@/lib/mobile-apps/providers/google-play-reports",
  );
  return { ...actual, listReportFiles: vi.fn(async () => []), listReviewReportFiles: vi.fn(async () => []) };
});

vi.mock("@/lib/mobile-apps/providers/app-store-ratings", () => ({
  fetchAppleTerritoryRatings: vi.fn(async () => []),
  fetchAppleAppMetadata: vi.fn(async () => null),
}));

import { getSql } from "@/lib/local-db";
import { loadMobileReviewsConfig } from "@/lib/mobile-apps/config";
import { getProvider } from "@/lib/mobile-apps/providers";
import { listReportFiles } from "@/lib/mobile-apps/providers/google-play-reports";
import { fetchAppleTerritoryRatings } from "@/lib/mobile-apps/providers/app-store-ratings";
import type { RawReview } from "@/lib/mobile-apps/types";
import { syncApp } from "@/lib/mobile-apps/sync";

type Listing = { id: string; store: string; store_app_id: string; country: string; last_synced_at: string | null };

function makeFakeSql(listings: Listing[]) {
  let runs = 0;
  const sql = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const q = strings.join(" ");
    if (q.includes("from mobile_app_listings") && q.includes("store_app_id")) return Promise.resolve(listings);
    if (q.includes("insert into app_review_sync_runs")) return Promise.resolve([{ id: `run-${++runs}` }]);
    if (q.includes("insert into app_reviews")) return Promise.resolve([{ inserted: true }]);
    return Promise.resolve([]);
  };
  return sql;
}

const review = (id: string): RawReview => ({
  storeReviewId: id, author: "a", rating: 5, title: null, body: "ok",
  appVersion: null, country: "us", submittedAt: "2024-01-01T00:00:00Z", storeResponse: null, raw: { id },
});

function config(fullStorefrontScan: "off" | "forced" | "always") {
  return {
    google: { reportsBucket: "pubsite_prod_rev_x", reportsLookbackMonths: 3, reportsMaxFileBytes: 48 * 1024 * 1024 },
    apple: { fullStorefrontScan, storefrontScanConcurrency: 2, storefrontScanDelayMs: 0 },
    sync: { maxPages: 10, concurrency: 2, negativeThreshold: 3 },
  };
}

const googleListing: Listing = { id: "L1", store: "google", store_app_id: "com.x", country: "us", last_synced_at: null };
const appleListing: Listing = { id: "L2", store: "apple", store_app_id: "9999", country: "us", last_synced_at: null };

afterEach(() => vi.clearAllMocks());

describe("syncApp report-sync gating", () => {
  it("defaults syncReports to false: force:true does NOT list Google report CSVs", async () => {
    vi.mocked(getSql).mockReturnValue(makeFakeSql([googleListing]) as never);
    vi.mocked(loadMobileReviewsConfig).mockReturnValue(config("off") as never);
    vi.mocked(getProvider).mockReturnValue({ fetchReviews: vi.fn(async () => [review("r1")]) } as never);

    await syncApp("app1", { force: true });

    expect(listReportFiles).not.toHaveBeenCalled();
  });

  it("syncReports:true lists Google report CSVs", async () => {
    vi.mocked(getSql).mockReturnValue(makeFakeSql([googleListing]) as never);
    vi.mocked(loadMobileReviewsConfig).mockReturnValue(config("off") as never);
    vi.mocked(getProvider).mockReturnValue({ fetchReviews: vi.fn(async () => [review("r1")]) } as never);

    await syncApp("app1", { force: true, syncReports: true });

    expect(listReportFiles).toHaveBeenCalled();
  });
});

describe("syncApp Apple full-storefront-scan gating", () => {
  it("force:true alone does NOT trigger the full storefront scan, even when mode is 'always'", async () => {
    vi.mocked(getSql).mockReturnValue(makeFakeSql([appleListing]) as never);
    vi.mocked(loadMobileReviewsConfig).mockReturnValue(config("always") as never);
    vi.mocked(getProvider).mockReturnValue({ fetchReviews: vi.fn(async () => [review("a1")]) } as never);

    await syncApp("app1", { force: true });

    expect(fetchAppleTerritoryRatings).toHaveBeenCalled();
    const opts = vi.mocked(fetchAppleTerritoryRatings).mock.calls[0]![2];
    expect(opts?.fullScan).toBe(false);
  });

  it("syncAppleStorefronts:true with mode 'always' triggers the full scan", async () => {
    vi.mocked(getSql).mockReturnValue(makeFakeSql([appleListing]) as never);
    vi.mocked(loadMobileReviewsConfig).mockReturnValue(config("always") as never);
    vi.mocked(getProvider).mockReturnValue({ fetchReviews: vi.fn(async () => [review("a1")]) } as never);

    await syncApp("app1", { force: true, syncAppleStorefronts: true });

    const opts = vi.mocked(fetchAppleTerritoryRatings).mock.calls[0]![2];
    expect(opts?.fullScan).toBe(true);
  });

  it("syncAppleStorefronts:true with mode 'off' still does NOT full scan (config wins)", async () => {
    vi.mocked(getSql).mockReturnValue(makeFakeSql([appleListing]) as never);
    vi.mocked(loadMobileReviewsConfig).mockReturnValue(config("off") as never);
    vi.mocked(getProvider).mockReturnValue({ fetchReviews: vi.fn(async () => [review("a1")]) } as never);

    await syncApp("app1", { force: true, syncAppleStorefronts: true });

    const opts = vi.mocked(fetchAppleTerritoryRatings).mock.calls[0]![2];
    expect(opts?.fullScan).toBe(false);
  });
});
