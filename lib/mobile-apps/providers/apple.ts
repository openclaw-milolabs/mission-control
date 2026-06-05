import type { ListingRef, RatingSummary, RawReview, ReviewProvider } from "@/lib/mobile-apps/types";

type AppleEntry = {
  id?: { label?: string };
  author?: { name?: { label?: string } };
  "im:rating"?: { label?: string };
  "im:version"?: { label?: string };
  title?: { label?: string };
  content?: { label?: string };
  updated?: { label?: string };
};

function round2(n: number | null): number | null {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}

/** Pure: turn an Apple customer-reviews RSS JSON object into RawReview[]. */
export function parseAppleReviews(feedJson: unknown, country: string): RawReview[] {
  const feed = (feedJson as { feed?: { entry?: AppleEntry | AppleEntry[] } })?.feed;
  if (!feed?.entry) return [];
  const entries = Array.isArray(feed.entry) ? feed.entry : [feed.entry];

  const out: RawReview[] = [];
  for (const e of entries) {
    const ratingLabel = e["im:rating"]?.label;
    // The app-metadata entry has no im:rating — skip it.
    if (ratingLabel == null) continue;
    const id = e.id?.label;
    if (!id) continue;
    out.push({
      storeReviewId: String(id),
      author: e.author?.name?.label ?? null,
      rating: Number.isFinite(Number(ratingLabel)) ? Number(ratingLabel) : null,
      title: e.title?.label ?? null,
      body: e.content?.label ?? null,
      appVersion: e["im:version"]?.label ?? null,
      country,
      submittedAt: e.updated?.label ? new Date(e.updated.label).toISOString() : null,
      storeResponse: null,
    });
  }
  return out;
}

/** Pure: turn an iTunes Lookup response into a RatingSummary. */
export function parseiTunesLookup(lookupJson: unknown): RatingSummary {
  const r = (lookupJson as { results?: Array<Record<string, unknown>> })?.results?.[0];
  if (!r) return { avgRating: null, ratingsCount: null, histogram: null };
  return {
    avgRating: round2(typeof r.averageUserRating === "number" ? r.averageUserRating : null),
    ratingsCount: typeof r.userRatingCount === "number" ? r.userRatingCount : null,
    histogram: null, // iTunes Lookup does not expose a per-star histogram
    name: typeof r.trackName === "string" ? r.trackName : null,
    iconUrl:
      (typeof r.artworkUrl512 === "string" && r.artworkUrl512) ||
      (typeof r.artworkUrl100 === "string" && r.artworkUrl100) ||
      null,
  };
}

export class AppleProvider implements ReviewProvider {
  async fetchReviews(ref: ListingRef): Promise<RawReview[]> {
    // Apple paginates 1..10; pull the first few pages of most-recent reviews.
    const all: RawReview[] = [];
    for (let page = 1; page <= 5; page++) {
      const url = `https://itunes.apple.com/${encodeURIComponent(ref.country)}/rss/customerreviews/page=${page}/id=${encodeURIComponent(ref.storeAppId)}/sortby=mostrecent/json`;
      const res = await fetch(url, { headers: { "User-Agent": "MissionControl/1.0" } });
      if (!res.ok) break;
      const json = await res.json();
      const batch = parseAppleReviews(json, ref.country);
      if (batch.length === 0) break;
      all.push(...batch);
    }
    return all;
  }

  async fetchRatingSummary(ref: ListingRef): Promise<RatingSummary> {
    const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(ref.storeAppId)}&country=${encodeURIComponent(ref.country)}`;
    const res = await fetch(url, { headers: { "User-Agent": "MissionControl/1.0" } });
    if (!res.ok) return { avgRating: null, ratingsCount: null, histogram: null };
    return parseiTunesLookup(await res.json());
  }
}
