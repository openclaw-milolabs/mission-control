import { getSql } from "@/lib/local-db";
import { getProvider } from "@/lib/mobile-apps/providers";
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
  inserted: number;
  ratingCaptured: boolean;
  skipped: boolean;
  error: string | null;
};

const DEFAULT_DEDUPE_MS = 60_000;

/**
 * Sync one app: for each of its listings, fetch reviews + rating summary,
 * upsert reviews (dedup on store_review_id), write a fresh rating snapshot,
 * and update the listing's current_rating / last_synced_at.
 *
 * @param force when true, ignore the de-dupe window (manual "Refresh now").
 */
export async function syncApp(
  appId: string,
  opts: { force?: boolean; dedupeMs?: number } = {},
): Promise<SyncResult[]> {
  const sql: Sql = getSql();
  const dedupeMs = opts.dedupeMs ?? DEFAULT_DEDUPE_MS;
  const listings = (await sql`
    select id::text, store, store_app_id, country, last_synced_at
    from mobile_app_listings
    where mobile_app_id = ${appId}
  `) as unknown as ListingRow[];

  const results: SyncResult[] = [];
  for (const l of listings) {
    const store = l.store as Store;
    const recentlySynced =
      l.last_synced_at && Date.now() - new Date(l.last_synced_at).getTime() < dedupeMs;
    if (!opts.force && recentlySynced) {
      results.push({ listingId: l.id, store, inserted: 0, ratingCaptured: false, skipped: true, error: null });
      continue;
    }

    try {
      const provider = getProvider(store);
      const ref = { store, storeAppId: l.store_app_id, country: l.country };
      const [reviews, summary] = await Promise.all([
        provider.fetchReviews(ref),
        provider.fetchRatingSummary(ref),
      ]);

      let inserted = 0;
      for (const r of reviews) {
        const res = await sql`
          insert into app_reviews (
            listing_id, store_review_id, author, rating, title, body,
            app_version, country, submitted_at, store_response
          ) values (
            ${l.id}, ${r.storeReviewId}, ${r.author}, ${r.rating}, ${r.title}, ${r.body},
            ${r.appVersion}, ${r.country}, ${r.submittedAt}, ${r.storeResponse}
          )
          on conflict (listing_id, store_review_id) do update
            set store_response = excluded.store_response
          returning (xmax = 0) as inserted
        `;
        if ((res as unknown as Array<{ inserted: boolean }>)[0]?.inserted) inserted += 1;
      }

      await sql`
        insert into app_rating_snapshots (listing_id, avg_rating, ratings_count, histogram)
        values (${l.id}, ${summary.avgRating}, ${summary.ratingsCount}, ${
          summary.histogram ? JSON.stringify(summary.histogram) : null
        })
      `;

      await sql`
        update mobile_app_listings
        set current_rating = ${summary.avgRating},
            ratings_count = ${summary.ratingsCount},
            last_synced_at = now()
        where id = ${l.id}
      `;

      results.push({ listingId: l.id, store, inserted, ratingCaptured: true, skipped: false, error: null });
    } catch (err) {
      results.push({
        listingId: l.id,
        store,
        inserted: 0,
        ratingCaptured: false,
        skipped: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Notify SSE listeners that this app changed.
  await sql`select pg_notify('mobile_apps_change', ${JSON.stringify({ appId })})`.catch(() => null);
  return results;
}
