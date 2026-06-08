import { describe, expect, it } from "vitest";
import { ratingSourceCopy } from "@/lib/mobile-apps/rating-source";

describe("ratingSourceCopy", () => {
  it("explains that Google report lookback is not a rating period", () => {
    const copy = ratingSourceCopy({ store: "google", source: "google_play_console_ratings_report", asOf: "2026-06-03T00:00:00Z" });
    expect(copy.sourceLabel).toBe("Google Play · Play Console report");
    expect(copy.freshnessLabel).toBe("As of 2026-06-03 · report delayed 3–7 days");
    expect(copy.helperText).toMatch(/lookback setting only controls how far back we search/i);
    expect(copy.helperText).toMatch(/does not mean the rating is limited/i);
  });

  it("labels Apple ratings as current storefront lookups", () => {
    const copy = ratingSourceCopy({ store: "apple", source: "apple_app_store_lookup" });
    expect(copy.sourceLabel).toBe("Apple App Store · Storefront lookup");
    expect(copy.headline).toBe("Current country storefront rating");
    expect(copy.helperText).toMatch(/current App Store storefront lookup/i);
  });

  it("keeps Google fetched-review fallback visibly separate from official ratings", () => {
    const copy = ratingSourceCopy({ store: "google", source: "google_reviews_api_fetched_reviews" });
    expect(copy.sourceLabel).toBe("Google Play · written reviews only");
    expect(copy.freshnessLabel).toBe("Not a store-wide aggregate");
    expect(copy.helperText).toMatch(/excludes rating-only feedback/i);
  });
});
