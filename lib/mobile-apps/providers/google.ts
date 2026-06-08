import type { androidpublisher_v3 } from "@googleapis/androidpublisher";
import { loadMobileReviewsConfig } from "@/lib/mobile-apps/config";
import { createAndroidPublisherClient } from "@/lib/mobile-apps/providers/google-play-client";
import type { ListingRef, RawReview, ReviewProvider } from "@/lib/mobile-apps/types";

type GpReview = androidpublisher_v3.Schema$Review;

function toIsoFromSeconds(seconds: string | null | undefined): string | null {
  if (seconds == null) return null;
  const n = Number(seconds);
  if (!Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString();
}

/**
 * Pure: map official Google Play Android Publisher `reviews.list` objects to the
 * internal RawReview shape. Google Play reviews carry no title.
 */
export function mapGoogleReviews(raw: GpReview[]): RawReview[] {
  if (!Array.isArray(raw)) return [];
  const out: RawReview[] = [];
  for (const r of raw) {
    if (!r || !r.reviewId) continue;
    // Google's `comments[]` is a union: each entry holds EITHER a userComment OR a
    // developerComment (not both). Scan for the latest of each rather than assuming
    // comments[0] carries both, otherwise developer replies get dropped.
    const comments = r.comments ?? [];
    const user = [...comments].reverse().find((c) => c.userComment)?.userComment;
    const dev = [...comments].reverse().find((c) => c.developerComment)?.developerComment;
    out.push({
      storeReviewId: String(r.reviewId),
      author: r.authorName ?? null,
      rating: typeof user?.starRating === "number" ? user.starRating : null,
      title: null,
      body: user?.text ?? null,
      appVersion: user?.appVersionName ?? null,
      country: null,
      language: user?.reviewerLanguage ?? null,
      device: user?.device ?? null,
      submittedAt: toIsoFromSeconds(user?.lastModified?.seconds),
      storeResponse: dev?.text ?? null,
      raw: r,
    });
  }
  return out;
}

/** Turn a googleapis/Gaxios error into a clean, secret-free message. */
function cleanGoogleError(err: unknown, packageName: string): Error {
  const e = err as { code?: number | string; response?: { status?: number }; message?: string };
  const status = Number(e?.response?.status ?? e?.code);
  if (status === 401 || status === 403)
    return new Error(
      `Google Play API rejected the request for "${packageName}" (auth/permission). Confirm the service account is linked to this app with review access.`,
    );
  if (status === 429) return new Error("Google Play API rate limit reached. Try again shortly.");
  if (status === 404) return new Error(`Google Play app "${packageName}" was not found for this service account.`);
  return new Error(e?.message ? `Google Play API error: ${e.message}` : "Google Play API request failed.");
}

export class GoogleProvider implements ReviewProvider {
  async fetchReviews(ref: ListingRef): Promise<RawReview[]> {
    const cfg = loadMobileReviewsConfig();
    if (!cfg.google.enabled) throw new Error("Google Play integration is disabled (GOOGLE_PLAY_ENABLED=false).");
    if (!cfg.google.configured) throw new Error(cfg.google.error ?? "Google Play is not configured.");

    // Use the listing's package name as the target. The service-account auth
    // enforces that only apps it owns return data, so this also matches the
    // configured GOOGLE_PLAY_PACKAGE_NAME for the owned app.
    const packageName = ref.storeAppId;
    const client = createAndroidPublisherClient(cfg.google);

    const all: RawReview[] = [];
    let token: string | undefined;
    try {
      for (let page = 0; page < cfg.sync.maxPages; page++) {
        const res = await client.reviews.list({ packageName, maxResults: 100, token }, { timeout: 30_000 });
        all.push(...mapGoogleReviews(res.data.reviews ?? []));
        token = res.data.tokenPagination?.nextPageToken ?? undefined;
        if (!token) break;
      }
    } catch (err) {
      throw cleanGoogleError(err, packageName);
    }
    return all;
  }
}
