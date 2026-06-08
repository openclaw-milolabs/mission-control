import { loadMobileReviewsConfig } from "@/lib/mobile-apps/config";
import {
  APPSTORE_CONNECT_BASE_URL,
  createAppStoreConnectToken,
} from "@/lib/mobile-apps/providers/app-store-client";
import type { ListingRef, RawReview, ReviewProvider } from "@/lib/mobile-apps/types";

type AppleReviewResource = {
  id?: string;
  attributes?: {
    rating?: number;
    title?: string | null;
    body?: string | null;
    reviewerNickname?: string | null;
    createdDate?: string | null;
    territory?: string | null;
  };
};

type CustomerReviewsResponse = {
  data?: AppleReviewResource[];
  links?: { next?: string | null };
};

function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Pure: map official App Store Connect `customerReviews` resources to the
 * internal RawReview shape. Developer responses live in a separate relationship
 * we do not fetch (view-only), so storeResponse is always null.
 */
export function mapAppleReviews(resources: AppleReviewResource[]): RawReview[] {
  if (!Array.isArray(resources)) return [];
  const out: RawReview[] = [];
  for (const r of resources) {
    if (!r || !r.id) continue;
    const a = r.attributes ?? {};
    out.push({
      storeReviewId: String(r.id),
      author: a.reviewerNickname ?? null,
      rating: typeof a.rating === "number" ? a.rating : null,
      title: a.title ?? null,
      body: a.body ?? null,
      appVersion: null,
      country: a.territory ?? null,
      language: null,
      submittedAt: toIso(a.createdDate),
      storeResponse: null,
      raw: r,
    });
  }
  return out;
}

function cleanAppleError(status: number, appId: string): Error {
  if (status === 401) return new Error("App Store Connect authentication failed (check key id / issuer id / .p8 key).");
  if (status === 403)
    return new Error(`App Store Connect denied access to app "${appId}". Confirm the API key role can read reviews.`);
  if (status === 404) return new Error(`App Store Connect app "${appId}" was not found.`);
  if (status === 429) return new Error("App Store Connect rate limit reached. Try again shortly.");
  return new Error(`App Store Connect API error (HTTP ${status}).`);
}

export class AppleProvider implements ReviewProvider {
  async fetchReviews(ref: ListingRef): Promise<RawReview[]> {
    const cfg = loadMobileReviewsConfig();
    if (!cfg.apple.enabled) throw new Error("App Store integration is disabled (APPSTORE_CONNECT_ENABLED=false).");
    if (!cfg.apple.configured) throw new Error(cfg.apple.error ?? "App Store Connect is not configured.");

    const appId = ref.storeAppId;
    const token = await createAppStoreConnectToken(cfg.apple);

    const all: RawReview[] = [];
    let url: string | null = `${APPSTORE_CONNECT_BASE_URL}/v1/apps/${encodeURIComponent(
      appId,
    )}/customerReviews?limit=200&sort=-createdDate`;

    for (let page = 0; page < cfg.sync.maxPages && url; page++) {
      const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw cleanAppleError(res.status, appId);
      const json = (await res.json()) as CustomerReviewsResponse;
      all.push(...mapAppleReviews(json.data ?? []));
      url = json.links?.next ?? null;
    }
    return all;
  }
}
