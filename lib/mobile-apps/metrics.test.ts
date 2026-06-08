import { describe, expect, it } from "vitest";
import { averageRatingTrend, countNegative, summarizeReviews } from "@/lib/mobile-apps/metrics";

const reviews = [
  { rating: 5, submittedAt: "2024-01-01T10:00:00Z" },
  { rating: 4, submittedAt: "2024-01-01T18:00:00Z" },
  { rating: 1, submittedAt: "2024-01-02T09:00:00Z" },
  { rating: 3, submittedAt: "2024-01-08T09:00:00Z" },
  { rating: null, submittedAt: null },
];

describe("summarizeReviews", () => {
  it("computes average, count and a 1-5 histogram from fetched reviews", () => {
    const s = summarizeReviews(reviews);
    expect(s.ratingsCount).toBe(4); // null rating excluded
    expect(s.avgRating).toBe(3.25); // (5+4+1+3)/4
    expect(s.histogram).toEqual({ "1": 1, "2": 0, "3": 1, "4": 1, "5": 1 });
  });

  it("returns nulls/zero histogram for no rated reviews", () => {
    const s = summarizeReviews([{ rating: null }]);
    expect(s.avgRating).toBeNull();
    expect(s.ratingsCount).toBe(0);
    expect(s.histogram).toEqual({ "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 });
  });
});

describe("countNegative", () => {
  it("counts reviews at or below the threshold", () => {
    expect(countNegative(reviews, 3)).toBe(2); // ratings 1 and 3
    expect(countNegative(reviews, 2)).toBe(1); // rating 1
    expect(countNegative(reviews, 5)).toBe(4);
  });
});

describe("averageRatingTrend", () => {
  it("buckets average rating by day", () => {
    const trend = averageRatingTrend(reviews, "day");
    expect(trend).toEqual([
      { period: "2024-01-01", avg: 4.5, count: 2 },
      { period: "2024-01-02", avg: 1, count: 1 },
      { period: "2024-01-08", avg: 3, count: 1 },
    ]);
  });

  it("buckets average rating by ISO week", () => {
    const trend = averageRatingTrend(reviews, "week");
    // 2024-01-01..02 are ISO week 2024-W01; 2024-01-08 is 2024-W02
    expect(trend.length).toBe(2);
    expect(trend[0].count).toBe(3);
    expect(trend[1].count).toBe(1);
  });
});
