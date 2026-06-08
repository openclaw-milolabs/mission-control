import pLimit from "p-limit";
import { getSql } from "@/lib/local-db";
import { loadMobileReviewsConfig } from "@/lib/mobile-apps/config";
import { summarizeReviews } from "@/lib/mobile-apps/metrics";
import { getProvider } from "@/lib/mobile-apps/providers";
import { fetchAppleTerritoryRatings, type TerritoryRating } from "@/lib/mobile-apps/providers/app-store-ratings";
import { toAlpha2 } from "@/lib/mobile-apps/country-codes";
import { ensureMobileAppsSchema } from "@/lib/mobile-apps/ensure-schema";
import type { Store } from "@/lib/mobile-apps/types";

type Sql = ReturnType<typeof getSql>;

type ListingRow = {
  id: string;
  store: string;
  store_app_id: string;
  country: string;
  last_synced_at: string | null;
};

export type SyncResult = {
  listingId: string;
  store: Store;
  appIdentifier: string;
  inserted: number;
  fetched: number;
  ratingCaptured: boolean;
  skipped: boolean;
  status: "success" | "failed" | "skipped";
  error: string | null;
};

const DEFAULT_DEDUPE_MS = 60_000;

/** Sync a single listing: fetch official reviews, upsert, snapshot, record the run. */
async function syncListing(
  sql: Sql,
  listing: ListingRow,
  opts: { force: boolean; dedupeMs: number },
): Promise<SyncResult> {
  const store = listing.store as Store;
  const appIdentifier = listing.store_app_id;
  const base = { listingId: listing.id, store, appIdentifier };

  const recentlySynced =
    listing.last_synced_at && Date.now() - new Date(listing.last_synced_at).getTime() < opts.dedupeMs;
  if (!opts.force && recentlySynced) {
    return { ...base, inserted: 0, fetched: 0, ratingCaptured: false, skipped: true, status: "skipped", error: null };
  }

  const runRows = (await sql`
    insert into app_review_sync_runs (listing_id, store, app_identifier, status)
    values (${listing.id}::uuid, ${store}, ${appIdentifier}, 'running')
    returning id::text
  `) as unknown as Array<{ id: string }>;
  const runId = runRows[0]?.id;

  try {
    const provider = getProvider(store);
    const reviews = await provider.fetchReviews({ store, storeAppId: appIdentifier, country: listing.country });

    let inserted = 0;
    for (const r of reviews) {
      const res = await sql`
        insert into app_reviews (
          listing_id, store_review_id, author, rating, title, body,
          app_version, country, submitted_at, store_response, language, device, raw_json
        ) values (
          ${listing.id}, ${r.storeReviewId}, ${r.author}, ${r.rating}, ${r.title}, ${r.body},
          ${r.appVersion}, ${r.country}, ${r.submittedAt}, ${r.storeResponse}, ${r.language ?? null},
          ${r.device ?? null}, ${r.raw ? JSON.stringify(r.raw) : null}
        )
        on conflict (listing_id, store_review_id) do update
          set author = excluded.author,
              rating = excluded.rating,
              title = excluded.title,
              body = excluded.body,
              app_version = excluded.app_version,
              country = excluded.country,
              submitted_at = excluded.submitted_at,
              store_response = excluded.store_response,
              language = excluded.language,
              device = excluded.device,
              raw_json = excluded.raw_json,
              fetched_at = now()
        returning (xmax = 0) as inserted
      `;
      if ((res as unknown as Array<{ inserted: boolean }>)[0]?.inserted) inserted += 1;
    }

    // Star distribution snapshot from the fetched reviews (history only — this is
    // NOT presented as the store rating).
    const summary = summarizeReviews(reviews);
    await sql`
      insert into app_rating_snapshots (listing_id, avg_rating, ratings_count, histogram)
      values (${listing.id}, ${summary.avgRating}, ${summary.ratingsCount}, ${JSON.stringify(summary.histogram)})
    `;

    // The headline rating is the OFFICIAL value the store API returns, never one
    // we compute. Apple exposes per-storefront averages via iTunes Lookup; Google
    // has no official aggregate API, so it stays blank (reviews/distribution only).
    let officialRatings: TerritoryRating[] = [];
    let currentRating: number | null = null;
    let ratingsCount: number | null = null;
    if (store === "apple") {
      // Apple exposes the official displayed per-storefront average via iTunes Lookup.
      const territories = [...reviews.map((r) => r.country ?? ""), listing.country];
      officialRatings = await fetchAppleTerritoryRatings(appIdentifier, territories).catch(() => []);
      const primary =
        officialRatings.find((t) => t.territory === toAlpha2(listing.country)) ?? officialRatings[0] ?? null;
      currentRating = primary?.avg ?? null;
      ratingsCount = primary?.count ?? null;
    } else {
      // Google's Android Publisher reviews API returns per-review star ratings but
      // no store-wide aggregate, so the headline is the average of those reviews.
      currentRating = summary.avgRating;
      ratingsCount = summary.ratingsCount;
    }
    await sql`
      update mobile_app_listings
      set current_rating = ${currentRating},
          ratings_count = ${ratingsCount},
          official_ratings = ${officialRatings.length ? JSON.stringify(officialRatings) : null},
          last_synced_at = now()
      where id = ${listing.id}
    `;
    if (runId) {
      await sql`
        update app_review_sync_runs
        set status = 'success', finished_at = now(), fetched_count = ${reviews.length}, upserted_count = ${inserted}
        where id = ${runId}::uuid
      `;
    }
    return {
      ...base,
      inserted,
      fetched: reviews.length,
      ratingCaptured: true,
      skipped: false,
      status: "success",
      error: null,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (runId) {
      await sql`
        update app_review_sync_runs
        set status = 'failed', finished_at = now(), error_message = ${error}
        where id = ${runId}::uuid
      `.catch(() => null);
    }
    return { ...base, inserted: 0, fetched: 0, ratingCaptured: false, skipped: false, status: "failed", error };
  }
}

/**
 * Sync one app: for each of its listings (optionally filtered to a single store),
 * fetch reviews via the official APIs and upsert. Listings are processed with a
 * small concurrency limit so one store failing never blocks the other.
 */
export async function syncApp(
  appId: string,
  opts: { force?: boolean; dedupeMs?: number; store?: Store } = {},
): Promise<SyncResult[]> {
  const sql: Sql = getSql();
  await ensureMobileAppsSchema(sql); // safe if a cron/job syncs before any route inits the schema
  const cfg = loadMobileReviewsConfig();
  const dedupeMs = opts.dedupeMs ?? DEFAULT_DEDUPE_MS;
  const force = Boolean(opts.force);

  const listings = (await sql`
    select id::text, store, store_app_id, country, last_synced_at
    from mobile_app_listings
    where mobile_app_id = ${appId}
      and (${opts.store ?? null}::text is null or store = ${opts.store ?? null})
  `) as unknown as ListingRow[];

  const limit = pLimit(Math.max(1, cfg.sync.concurrency));
  const results = await Promise.all(listings.map((l) => limit(() => syncListing(sql, l, { force, dedupeMs }))));

  // Notify SSE listeners that this app changed.
  await sql`select pg_notify('mobile_apps_change', ${JSON.stringify({ appId })})`.catch(() => null);
  return results;
}
