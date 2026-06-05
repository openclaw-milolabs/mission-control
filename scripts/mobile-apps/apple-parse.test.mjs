import assert from "node:assert/strict";
import { parseAppleReviews, parseiTunesLookup } from "../../lib/mobile-apps/providers/apple.ts";

const rssFeed = {
  feed: {
    entry: [
      // First entry in Apple's review RSS is app metadata (no im:rating) — must be skipped
      { "im:name": { label: "Demo App" }, id: { label: "310633997" } },
      {
        id: { label: "1234567890" },
        author: { name: { label: "Jane" } },
        "im:rating": { label: "5" },
        title: { label: "Love it" },
        content: { label: "Works great" },
        "im:version": { label: "2.1.0" },
        updated: { label: "2026-06-01T10:00:00-07:00" },
      },
    ],
  },
};

const reviews = parseAppleReviews(rssFeed, "us");
assert.equal(reviews.length, 1);
assert.equal(reviews[0].storeReviewId, "1234567890");
assert.equal(reviews[0].author, "Jane");
assert.equal(reviews[0].rating, 5);
assert.equal(reviews[0].title, "Love it");
assert.equal(reviews[0].body, "Works great");
assert.equal(reviews[0].appVersion, "2.1.0");
assert.equal(reviews[0].country, "us");
assert.ok(reviews[0].submittedAt?.startsWith("2026-06-01"));
assert.equal(reviews[0].storeResponse, null);

// Empty / single-entry feed → no reviews, no throw
assert.deepEqual(parseAppleReviews({ feed: {} }, "us"), []);

const lookup = {
  resultCount: 1,
  results: [
    {
      trackName: "Demo App",
      averageUserRating: 4.567,
      userRatingCount: 1234,
      version: "2.1.0",
      artworkUrl512: "https://example/icon.png",
    },
  ],
};
const summary = parseiTunesLookup(lookup);
assert.equal(summary.name, "Demo App");
assert.equal(summary.avgRating, 4.57); // rounded to 2dp
assert.equal(summary.ratingsCount, 1234);
assert.equal(summary.iconUrl, "https://example/icon.png");

console.log("ok - apple parsers");
