export type Store = "apple" | "google";

/** A review as returned by a provider, before it is persisted. */
export type RawReview = {
  storeReviewId: string;
  author: string | null;
  rating: number | null;
  title: string | null;
  body: string | null;
  appVersion: string | null;
  country: string | null;
  submittedAt: string | null; // ISO 8601
  storeResponse: string | null;
};

export type RatingSummary = {
  avgRating: number | null;
  ratingsCount: number | null;
  /** 1->5 star counts, e.g. { "1": 3, "2": 1, "3": 0, "4": 8, "5": 42 } */
  histogram: Record<string, number> | null;
  /** Provider-discovered display name / icon, used when first adding an app. */
  name?: string | null;
  iconUrl?: string | null;
};

export type ListingRef = {
  store: Store;
  storeAppId: string;
  country: string;
};

export interface ReviewProvider {
  fetchReviews(ref: ListingRef): Promise<RawReview[]>;
  fetchRatingSummary(ref: ListingRef): Promise<RatingSummary>;
}

/** Result of parsing a pasted store URL or raw id. */
export type ResolvedListing = {
  store: Store;
  storeAppId: string;
  country: string;
};
