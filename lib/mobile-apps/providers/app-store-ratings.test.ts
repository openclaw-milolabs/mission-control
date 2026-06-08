import { describe, expect, it } from "vitest";
import { parseiTunesLookup } from "@/lib/mobile-apps/providers/app-store-ratings";

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
