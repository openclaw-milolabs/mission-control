import type { ListingRef, RatingSummary, RawReview, ReviewProvider } from "@/lib/mobile-apps/types";

type GpReview = {
  id?: string;
  userName?: string;
  score?: number;
  title?: string | null;
  text?: string | null;
  version?: string | null;
  date?: string | Date | null;
  replyText?: string | null;
};

type GpApp = {
  title?: string;
  score?: number;
  ratings?: number;
  icon?: string;
  histogram?: Record<string | number, number>;
};

function round2(n: number | null): number | null {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}

/** Pure: map google-play-scraper review objects to RawReview[]. */
export function mapGoogleReviews(raw: GpReview[], country: string): RawReview[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && r.id)
    .map((r) => ({
      storeReviewId: String(r.id),
      author: r.userName ?? null,
      rating: typeof r.score === "number" ? r.score : null,
      title: r.title ?? null,
      body: r.text ?? null,
      appVersion: r.version ?? null,
      country,
      submittedAt: r.date ? new Date(r.date).toISOString() : null,
      storeResponse: r.replyText ?? null,
    }));
}

/** Pure: map a google-play-scraper app object to a RatingSummary. */
export function mapGoogleApp(app: GpApp): RatingSummary {
  const hist = app?.histogram
    ? Object.fromEntries(Object.entries(app.histogram).map(([k, v]) => [String(k), Number(v)]))
    : null;
  return {
    avgRating: round2(typeof app?.score === "number" ? app.score : null),
    ratingsCount: typeof app?.ratings === "number" ? app.ratings : null,
    histogram: hist,
    name: typeof app?.title === "string" ? app.title : null,
    iconUrl: typeof app?.icon === "string" ? app.icon : null,
  };
}

export class GoogleProvider implements ReviewProvider {
  async fetchReviews(ref: ListingRef): Promise<RawReview[]> {
    const gplay = (await import("google-play-scraper")).default;
    // sort.NEWEST = 2 per the package's own enum definition
    const NEWEST = 2 as Parameters<typeof gplay.reviews>[0]["sort"];
    const result = await gplay.reviews({
      appId: ref.storeAppId,
      country: ref.country,
      sort: NEWEST,
      num: 200,
    });
    const data = Array.isArray(result) ? result : (result?.data ?? []);
    return mapGoogleReviews(data as GpReview[], ref.country);
  }

  async fetchRatingSummary(ref: ListingRef): Promise<RatingSummary> {
    const gplay = (await import("google-play-scraper")).default;
    const app = await gplay.app({ appId: ref.storeAppId, country: ref.country });
    return mapGoogleApp(app as GpApp);
  }
}
