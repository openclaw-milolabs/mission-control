import { describe, expect, it } from "vitest";
import { mapAppleReviews, indexAppleResponses } from "@/lib/mobile-apps/providers/apple";

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

  it("maps a developer response from the included payload (read-only)", () => {
    const review = {
      id: "rev-1",
      attributes: { rating: 1, body: "broken" },
      relationships: { response: { data: { id: "resp-1" } } },
    };
    const responses = indexAppleResponses([
      { type: "customerReviewResponses", id: "resp-1", attributes: { responseBody: "We pushed a fix." } },
    ]);
    const [r] = mapAppleReviews([review], responses);
    expect(r.storeResponse).toBe("We pushed a fix.");
  });

  it("leaves storeResponse null when there is no response relationship", () => {
    const [r] = mapAppleReviews([resource], indexAppleResponses([]));
    expect(r.storeResponse).toBeNull();
  });
});
