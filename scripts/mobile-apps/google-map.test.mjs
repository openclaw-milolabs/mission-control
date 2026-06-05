import assert from "node:assert/strict";
import { mapGoogleReviews, mapGoogleApp } from "../../lib/mobile-apps/providers/google.ts";

const rawReviews = [
  {
    id: "gp:AOqpTOabc",
    userName: "Sam",
    score: 4,
    title: null,
    text: "Pretty good",
    version: "3.0.1",
    date: "2026-05-30T08:00:00.000Z",
    replyText: "Thanks Sam!",
  },
];
const mapped = mapGoogleReviews(rawReviews, "nl");
assert.equal(mapped.length, 1);
assert.equal(mapped[0].storeReviewId, "gp:AOqpTOabc");
assert.equal(mapped[0].author, "Sam");
assert.equal(mapped[0].rating, 4);
assert.equal(mapped[0].body, "Pretty good");
assert.equal(mapped[0].appVersion, "3.0.1");
assert.equal(mapped[0].country, "nl");
assert.equal(mapped[0].storeResponse, "Thanks Sam!");

const app = {
  title: "Demo App",
  score: 4.321,
  ratings: 9876,
  icon: "https://example/icon.png",
  histogram: { 1: 100, 2: 50, 3: 200, 4: 1000, 5: 8526 },
};
const summary = mapGoogleApp(app);
assert.equal(summary.name, "Demo App");
assert.equal(summary.avgRating, 4.32);
assert.equal(summary.ratingsCount, 9876);
assert.deepEqual(summary.histogram, { "1": 100, "2": 50, "3": 200, "4": 1000, "5": 8526 });

console.log("ok - google mappers");
