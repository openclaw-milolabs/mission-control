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

function makeFakeSql(
  listings: Listing[],
  extra: { storedOfficialRatings?: unknown; googleReportRatings?: unknown[] } = {},
) {
  let runs = 0;
  const calls: Array<{ q: string; values: unknown[] }> = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join(" ");
    calls.push({ q, values });
    if (q.includes("from mobile_app_listings") && q.includes("store_app_id")) return Promise.resolve(listings);
    if (q.includes("select official_ratings from mobile_app_listings"))
      return Promise.resolve([{ official_ratings: extra.storedOfficialRatings ?? null }]);
    if (q.includes("from mobile_app_report_metrics")) return Promise.resolve(extra.googleReportRatings ?? []);
    if (q.includes("insert into app_review_sync_runs")) return Promise.resolve([{ id: `run-${++runs}` }]);
    if (q.includes("insert into app_reviews")) return Promise.resolve([{ inserted: true }]);
    return Promise.resolve([]);
  };
  return Object.assign(sql, { calls });
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

describe("syncApp backfill month window", () => {
  it("allReportMonths:true lists ALL months; default stays lookback-bounded", async () => {
    vi.mocked(getSql).mockReturnValue(makeFakeSql([googleListing]) as never);
    vi.mocked(loadMobileReviewsConfig).mockReturnValue(config("off") as never);
    vi.mocked(getProvider).mockReturnValue({ fetchReviews: vi.fn(async () => [review("r1")]) } as never);

    await syncApp("app1", { force: true, syncReports: true, allReportMonths: true });
    for (const call of vi.mocked(listReportFiles).mock.calls) {
      expect(call[4]).toMatchObject({ allMonths: true });
    }

    vi.mocked(listReportFiles).mockClear();
    await syncApp("app1", { force: true, syncReports: true });
    for (const call of vi.mocked(listReportFiles).mock.calls) {
      expect(call[4]).toMatchObject({ allMonths: false });
    }
  });
});

describe("syncApp light-sync rating stability", () => {
  it("Apple light sync MERGES its one-country probe into the stored By-country list", async () => {
    const fake = makeFakeSql([appleListing], {
      storedOfficialRatings: [
        { territory: "nl", avg: 4.5, count: 50 },
        { territory: "us", avg: 4.7, count: 90 },
      ],
    });
    vi.mocked(getSql).mockReturnValue(fake as never);
    vi.mocked(loadMobileReviewsConfig).mockReturnValue(config("always") as never);
    vi.mocked(getProvider).mockReturnValue({ fetchReviews: vi.fn(async () => [review("a1")]) } as never);
    vi.mocked(fetchAppleTerritoryRatings).mockResolvedValue([{ territory: "us", avg: 4.8, count: 100 }]);

    await syncApp("app1", { force: true }); // light: no syncAppleStorefronts

    const update = fake.calls.find((c) => c.q.includes("update mobile_app_listings"));
    expect(update, "listing update was issued").toBeTruthy();
    const ratings = JSON.parse(String(update!.values[2])) as Array<{ territory: string; avg: number; count: number }>;
    // The stored nl row survives; the probed us row is refreshed in place.
    expect(ratings.map((r) => r.territory).sort()).toEqual(["nl", "us"]);
    expect(ratings.find((r) => r.territory === "us")).toMatchObject({ avg: 4.8, count: 100 });
    expect(ratings.find((r) => r.territory === "nl")).toMatchObject({ avg: 4.5, count: 50 });
  });

  it("Apple light sync keeps the stored list intact when the storefront probe fails", async () => {
    const fake = makeFakeSql([appleListing], {
      storedOfficialRatings: [{ territory: "nl", avg: 4.5, count: 50 }],
    });
    vi.mocked(getSql).mockReturnValue(fake as never);
    vi.mocked(loadMobileReviewsConfig).mockReturnValue(config("always") as never);
    vi.mocked(getProvider).mockReturnValue({ fetchReviews: vi.fn(async () => [review("a1")]) } as never);
    vi.mocked(fetchAppleTerritoryRatings).mockRejectedValue(new Error("rate limited"));

    await syncApp("app1", { force: true });

    const update = fake.calls.find((c) => c.q.includes("update mobile_app_listings"));
    const ratings = JSON.parse(String(update!.values[2])) as Array<{ territory: string }>;
    expect(ratings.map((r) => r.territory)).toEqual(["nl"]);
  });

  it("Google light sync keeps the Play Console report rating from the DB (no downgrade to written-review average)", async () => {
    const fake = makeFakeSql([googleListing], {
      googleReportRatings: [{ territory: "us", avg: 4.3, as_of: "2026-06-01" }],
    });
    vi.mocked(getSql).mockReturnValue(fake as never);
    vi.mocked(loadMobileReviewsConfig).mockReturnValue(config("off") as never);
    vi.mocked(getProvider).mockReturnValue({ fetchReviews: vi.fn(async () => [review("r1")]) } as never);

    const [res] = await syncApp("app1", { force: true }); // light: no syncReports

    expect(listReportFiles).not.toHaveBeenCalled(); // still no heavy GCS work
    expect(res.ratingSource).toBe("google_play_console_ratings_report");
    expect(res.ratingAsOf).toBe("2026-06-01");
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
