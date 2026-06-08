import { describe, expect, it } from "vitest";
import { mapAppleReviews } from "@/lib/mobile-apps/providers/apple";

const resource = {
  type: "customerReviews",
  id: "11111111-2222-3333-4444-555555555555",
  attributes: {
    rating: 2,
    title: "Keeps logging me out",
    body: "Frustrating since the update.",
    reviewerNickname: "appfan99",
    createdDate: "2023-11-01T12:00:00-07:00",
    territory: "USA",
  },
};

describe("mapAppleReviews", () => {
  it("normalizes an official App Store Connect customerReview", () => {
    const [r] = mapAppleReviews([resource]);
    expect(r.storeReviewId).toBe("11111111-2222-3333-4444-555555555555");
    expect(r.author).toBe("appfan99");
    expect(r.rating).toBe(2);
    expect(r.title).toBe("Keeps logging me out");
    expect(r.body).toBe("Frustrating since the update.");
    expect(r.country).toBe("USA");
    expect(r.submittedAt).toBe(new Date("2023-11-01T12:00:00-07:00").toISOString());
    expect(r.storeResponse).toBeNull();
    expect(r.raw).toBeDefined();
  });

  it("skips resources without an id", () => {
    expect(mapAppleReviews([{ attributes: { rating: 5 } } as never])).toEqual([]);
  });

  it("returns [] for non-array input", () => {
    expect(mapAppleReviews(null as never)).toEqual([]);
  });
});
