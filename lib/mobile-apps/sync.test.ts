import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/local-db", () => ({ getSql: vi.fn() }));
vi.mock("@/lib/mobile-apps/config", () => ({ loadMobileReviewsConfig: vi.fn() }));
vi.mock("@/lib/mobile-apps/providers", () => ({ getProvider: vi.fn() }));

import { getSql } from "@/lib/local-db";
import { loadMobileReviewsConfig } from "@/lib/mobile-apps/config";
import { getProvider } from "@/lib/mobile-apps/providers";
import type { RawReview } from "@/lib/mobile-apps/types";
import { syncApp } from "@/lib/mobile-apps/sync";

type Listing = { id: string; store: string; store_app_id: string; country: string; last_synced_at: string | null };

/** Minimal postgres.js-shaped tagged-template stub that records app_reviews inserts. */
function makeFakeSql(listings: Listing[]) {
  const seen = new Set<string>();
  const inserts: string[] = [];
  let runs = 0;
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const q = strings.join(" ");
    if (q.includes("from mobile_app_listings") && q.includes("store_app_id")) return Promise.resolve(listings);
    if (q.includes("insert into app_review_sync_runs")) return Promise.resolve([{ id: `run-${++runs}` }]);
    if (q.includes("insert into app_reviews")) {
      const key = `${values[0]}:${values[1]}`;
      const isNew = !seen.has(key);
      seen.add(key);
      inserts.push(key);
      return Promise.resolve([{ inserted: isNew }]);
    }
    return Promise.resolve([]);
  };
  // syncApp calls `.catch` on pg_notify; Promise already has it.
  return { sql, seen, inserts };
}

const review = (id: string): RawReview => ({
  storeReviewId: id,
  author: "a",
  rating: 5,
  title: null,
  body: "ok",
  appVersion: null,
  country: null,
  submittedAt: "2024-01-01T00:00:00Z",
  storeResponse: null,
  raw: { id },
});

const baseConfig = { sync: { maxPages: 10, concurrency: 2, negativeThreshold: 3 } };

afterEach(() => vi.restoreAllMocks());

describe("syncApp upsert + dedupe", () => {
  it("counts new inserts and does not double-insert duplicates on a second sync", async () => {
    const fake = makeFakeSql([{ id: "L1", store: "google", store_app_id: "com.x", country: "us", last_synced_at: null }]);
    vi.mocked(getSql).mockReturnValue(fake.sql as never);
    vi.mocked(loadMobileReviewsConfig).mockReturnValue(baseConfig as never);
    const fetchReviews = vi.fn(async () => [review("r1"), review("r2")]);
    vi.mocked(getProvider).mockReturnValue({ fetchReviews } as never);

    const first = await syncApp("app1", { force: true });
    expect(first[0].status).toBe("success");
    expect(first[0].fetched).toBe(2);
    expect(first[0].inserted).toBe(2);

    const second = await syncApp("app1", { force: true });
    expect(second[0].fetched).toBe(2);
    expect(second[0].inserted).toBe(0); // duplicates -> no new rows
  });
});

describe("syncApp store isolation", () => {
  it("one store failing does not break the other", async () => {
    const fake = makeFakeSql([
      { id: "L1", store: "google", store_app_id: "com.x", country: "us", last_synced_at: null },
      { id: "L2", store: "apple", store_app_id: "9999", country: "us", last_synced_at: null },
    ]);
    vi.mocked(getSql).mockReturnValue(fake.sql as never);
    vi.mocked(loadMobileReviewsConfig).mockReturnValue(baseConfig as never);
    vi.mocked(getProvider).mockImplementation(
      (store: string) =>
        ({
          fetchReviews:
            store === "apple"
              ? vi.fn(async () => {
                  throw new Error("App Store Connect authentication failed");
                })
              : vi.fn(async () => [review("g1")]),
        }) as never,
    );

    const results = await syncApp("app1", { force: true });
    const google = results.find((r) => r.store === "google");
    const apple = results.find((r) => r.store === "apple");
    expect(google?.status).toBe("success");
    expect(google?.inserted).toBe(1);
    expect(apple?.status).toBe("failed");
    expect(apple?.error).toMatch(/authentication failed/);
  });
});
