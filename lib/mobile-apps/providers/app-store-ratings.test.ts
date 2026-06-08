import { describe, expect, it } from "vitest";
import { parseiTunesLookup, APPLE_STOREFRONTS } from "@/lib/mobile-apps/providers/app-store-ratings";

describe("APPLE_STOREFRONTS", () => {
  it("covers the full storefront list (incl ro/ru), not just major countries", () => {
    expect(APPLE_STOREFRONTS).toContain("ro");
    expect(APPLE_STOREFRONTS).toContain("ru");
    expect(APPLE_STOREFRONTS).toContain("tr");
    expect(APPLE_STOREFRONTS).toContain("nl");
    expect(APPLE_STOREFRONTS.length).toBeGreaterThan(100);
    expect(new Set(APPLE_STOREFRONTS).size).toBe(APPLE_STOREFRONTS.length); // no dupes
  });
});

describe("parseiTunesLookup", () => {
  it("reads the official averageUserRating + userRatingCount Apple returns", () => {
    const json = {
      resultCount: 1,
      results: [{ averageUserRating: 4.66667, userRatingCount: 14, trackName: "Altinstar" }],
    };
    expect(parseiTunesLookup(json)).toEqual({ avg: 4.66667, count: 14 });
  });

  it("returns nulls when the storefront has no rating", () => {
    expect(parseiTunesLookup({ resultCount: 0, results: [] })).toEqual({ avg: null, count: null });
    expect(parseiTunesLookup(null)).toEqual({ avg: null, count: null });
  });
});
