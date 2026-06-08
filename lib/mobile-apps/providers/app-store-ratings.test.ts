import { describe, expect, it } from "vitest";
import { parseiTunesLookup, parseiTunesMetadata, APPLE_STOREFRONTS } from "@/lib/mobile-apps/providers/app-store-ratings";

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

describe("parseiTunesMetadata", () => {
  it("extracts the real metadata Apple returns and we used to discard", () => {
    const json = {
      resultCount: 1,
      results: [{
        version: "2.3.10",
        releaseDate: "2019-04-01T07:00:00Z",
        currentVersionReleaseDate: "2026-05-01T07:00:00Z",
        releaseNotes: "Bug fixes",
        fileSizeBytes: "123456789",
        primaryGenreName: "Games",
        genres: ["Games", "Card"],
        trackContentRating: "12+",
        formattedPrice: "Free",
        currency: "USD",
        sellerName: "Redwinx",
        minimumOsVersion: "13.0",
        languageCodesISO2A: ["EN", "TR", "NL"],
        screenshotUrls: ["a", "b", "c"],
        artworkUrl512: "https://example/art.png",
        averageUserRatingForCurrentVersion: 4.2,
        userRatingCountForCurrentVersion: 88,
      }],
    };
    expect(parseiTunesMetadata(json)).toEqual({
      version: "2.3.10",
      releaseDate: "2019-04-01T07:00:00Z",
      currentVersionReleaseDate: "2026-05-01T07:00:00Z",
      releaseNotes: "Bug fixes",
      fileSizeBytes: 123456789,
      primaryGenre: "Games",
      genres: ["Games", "Card"],
      contentRating: "12+",
      formattedPrice: "Free",
      currency: "USD",
      sellerName: "Redwinx",
      minimumOsVersion: "13.0",
      languages: ["EN", "TR", "NL"],
      screenshotCount: 3,
      artworkUrl: "https://example/art.png",
      currentVersionAvg: 4.2,
      currentVersionCount: 88,
    });
  });

  it("returns null when there is no result", () => {
    expect(parseiTunesMetadata({ resultCount: 0, results: [] })).toBeNull();
    expect(parseiTunesMetadata(null)).toBeNull();
  });
});
