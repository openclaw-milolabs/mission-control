import { loadMobileReviewsConfig } from "@/lib/mobile-apps/config";
import {
  APPSTORE_CONNECT_BASE_URL,
  createAppStoreConnectToken,
} from "@/lib/mobile-apps/providers/app-store-client";
import { fetchWithRetry } from "@/lib/mobile-apps/http";
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
  relationships?: { response?: { data?: { id?: string } | null } };
};

type AppleIncluded = { type?: string; id?: string; attributes?: { responseBody?: string | null } };

type CustomerReviewsResponse = {
  data?: AppleReviewResource[];
  included?: AppleIncluded[];
  links?: { next?: string | null };
};

function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Pure: map official App Store Connect `customerReviews` resources to the
 * internal RawReview shape. Developer responses are READ (via the `response`
 * relationship + the `included` payload) — reading is allowed; we still never
 * create or modify responses.
 */
export function mapAppleReviews(
  resources: AppleReviewResource[],
  responsesById: Map<string, string> = new Map(),
): RawReview[] {
  if (!Array.isArray(resources)) return [];
  const out: RawReview[] = [];
  for (const r of resources) {
    if (!r || !r.id) continue;
    const a = r.attributes ?? {};
    const responseId = r.relationships?.response?.data?.id ?? null;
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
      storeResponse: responseId ? responsesById.get(responseId) ?? null : null,
      raw: r,
    });
  }
  return out;
}

/** Build a responseId -> responseBody map from the `included` payload. */
export function indexAppleResponses(included: AppleIncluded[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const inc of included ?? []) {
    if (inc?.type === "customerReviewResponses" && inc.id && inc.attributes?.responseBody) {
      m.set(inc.id, inc.attributes.responseBody);
    }
  }
  return m;
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
    // include=response pulls developer replies into the `included` payload, and
    // fields[customerReviewResponses]=responseBody scopes them to just the body
    // we map. Read-only — we never create or modify responses.
    let url: string | null = `${APPSTORE_CONNECT_BASE_URL}/v1/apps/${encodeURIComponent(
      appId,
    )}/customerReviews?limit=200&sort=-createdDate&include=response&fields[customerReviewResponses]=responseBody`;

    for (let page = 0; page < cfg.sync.maxPages && url; page++) {
      const res: Response = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw cleanAppleError(res.status, appId);
      const json = (await res.json()) as CustomerReviewsResponse;
      all.push(...mapAppleReviews(json.data ?? [], indexAppleResponses(json.included)));
      url = json.links?.next ?? null;
    }
    return all;
  }
}
