import assert from "node:assert/strict";
import { evaluateRule } from "../../lib/mobile-apps/alerts.ts";

// avg_rating below threshold → trips
assert.equal(
  evaluateRule(
    { metric: "avg_rating", operator: "lt", threshold: 4.0 },
    { avgRating: 3.8, oneStarToday: 0, reviewsToday: 5 },
  ),
  true,
);
// avg_rating at/above threshold → no trip
assert.equal(
  evaluateRule(
    { metric: "avg_rating", operator: "lt", threshold: 4.0 },
    { avgRating: 4.2, oneStarToday: 0, reviewsToday: 5 },
  ),
  false,
);
// one_star_spike gt threshold → trips
assert.equal(
  evaluateRule(
    { metric: "one_star_spike", operator: "gt", threshold: 3 },
    { avgRating: 4.5, oneStarToday: 7, reviewsToday: 20 },
  ),
  true,
);
// review_volume gt threshold → trips
assert.equal(
  evaluateRule(
    { metric: "review_volume", operator: "gt", threshold: 50 },
    { avgRating: 4.5, oneStarToday: 1, reviewsToday: 60 },
  ),
  true,
);
// null metric value never trips
assert.equal(
  evaluateRule(
    { metric: "avg_rating", operator: "lt", threshold: 4.0 },
    { avgRating: null, oneStarToday: 0, reviewsToday: 0 },
  ),
  false,
);

console.log("ok - evaluateRule");
