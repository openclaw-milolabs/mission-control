import { describe, expect, it } from "vitest";
import { mapGoogleReviews } from "@/lib/mobile-apps/providers/google";

// Realistic shape: comments[] is a union — one entry has userComment, a
// SEPARATE entry has developerComment.
const sample = {
  reviewId: "gp:AOqpTOabc123",
  authorName: "Jane Doe",
  comments: [
    {
      userComment: {
        text: "Crashes on launch since the last update.",
        lastModified: { seconds: "1700000000", nanos: 0 },
        starRating: 2,
        reviewerLanguage: "en",
        device: "Pixel 7",
        androidOsVersion: 33,
        appVersionCode: 1234,
        appVersionName: "2.1.0",
      },
    },
    {
      developerComment: {
        text: "Sorry to hear that, please email support.",
        lastModified: { seconds: "1700001000" },
      },
    },
  ],
};

describe("mapGoogleReviews", () => {
  it("normalizes an official Android Publisher review", () => {
    const [r] = mapGoogleReviews([sample]);
    expect(r.storeReviewId).toBe("gp:AOqpTOabc123");
    expect(r.author).toBe("Jane Doe");
    expect(r.rating).toBe(2);
    expect(r.title).toBeNull(); // Google Play reviews have no title
    expect(r.body).toBe("Crashes on launch since the last update.");
    expect(r.appVersion).toBe("2.1.0");
    expect(r.language).toBe("en");
    expect(r.device).toBe("Pixel 7");
    expect(r.storeResponse).toBe("Sorry to hear that, please email support.");
    expect(r.submittedAt).toBe(new Date(1700000000 * 1000).toISOString());
    expect(r.raw).toBeDefined();
  });

  it("skips entries without a reviewId", () => {
    expect(mapGoogleReviews([{ authorName: "x", comments: [] } as never])).toEqual([]);
  });

  it("returns [] for non-array input", () => {
    expect(mapGoogleReviews(undefined as never)).toEqual([]);
  });

  it("handles a review with no developer reply", () => {
    const noReply = { ...sample, comments: [{ userComment: sample.comments[0].userComment }] };
    const [r] = mapGoogleReviews([noReply]);
    expect(r.storeResponse).toBeNull();
  });

  it("maps the developer reply even when it is a separate later comment entry", () => {
    const [r] = mapGoogleReviews([sample]);
    expect(r.storeResponse).toBe("Sorry to hear that, please email support.");
    expect(r.body).toBe("Crashes on launch since the last update.");
  });
});
