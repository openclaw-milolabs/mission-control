import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { ensureMobileAppsSchema } from "@/lib/mobile-apps/ensure-schema";
import { loadMobileReviewsConfig } from "@/lib/mobile-apps/config";

export const dynamic = "force-dynamic";

const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

async function workspaceId(sql: ReturnType<typeof getSql>) {
  const rows = (await sql`select id from workspaces order by created_at asc limit 1`) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const { id } = await params;
    const sql = getSql();
    await ensureMobileAppsSchema(sql);
    const wid = await workspaceId(sql);
    if (!wid) return fail("App not found", 404);
    const url = new URL(request.url);
    const store = url.searchParams.get("store"); // 'apple' | 'google' | null
    const minRatingRaw = Number(url.searchParams.get("minRating") || "0");
    const minRating = Number.isFinite(minRatingRaw) ? minRatingRaw : 0;
    const limitRaw = Number(url.searchParams.get("limit") || "100");
    const limit = Math.min(Number.isFinite(limitRaw) ? limitRaw : 100, 500);

    const appRows = (await sql`
      select id::text, name, icon_url, notes from mobile_apps where id = ${id}::uuid and workspace_id = ${wid}::uuid limit 1
    `) as unknown as Array<Record<string, unknown>>;
    if (!appRows[0]) return fail("App not found", 404);

    const listings = (await sql`
      select id::text, store, store_app_id, country, current_rating::float8 as current_rating, ratings_count, last_synced_at
      from mobile_app_listings where mobile_app_id = ${id}::uuid
    `) as unknown as Array<{ id: string; store: string }>;
    const listingIds = listings.map((l) => l.id);

    const reviews =
      listingIds.length === 0
        ? []
        : await sql`
            select
              r.id::text, r.listing_id::text, l.store, r.author, r.rating, r.title, r.body,
              r.app_version, r.country, r.submitted_at, r.store_response, r.sentiment, r.themes
            from app_reviews r
            join mobile_app_listings l on l.id = r.listing_id
            where r.listing_id = any(${sql.array(listingIds)}::uuid[])
              and (${store}::text is null or l.store = ${store})
              and (r.rating is null or r.rating >= ${minRating})
            order by r.submitted_at desc nulls last
            limit ${limit}
          `;

    const snapshots =
      listingIds.length === 0
        ? []
        : await sql`
            select s.listing_id::text, l.store, s.captured_at, s.avg_rating::float8 as avg_rating, s.ratings_count, s.histogram
            from app_rating_snapshots s
            join mobile_app_listings l on l.id = s.listing_id
            where s.listing_id = any(${sql.array(listingIds)}::uuid[])
            order by s.captured_at asc
          `;

    // Latest sync run per listing → "last sync status/error per store".
    const syncRuns =
      listingIds.length === 0
        ? []
        : await sql`
            select distinct on (run.listing_id)
              run.listing_id::text, run.store, run.status, run.started_at, run.finished_at,
              run.fetched_count, run.upserted_count, run.error_message
            from app_review_sync_runs run
            where run.listing_id = any(${sql.array(listingIds)}::uuid[])
            order by run.listing_id, run.started_at desc
          `;

    // Server-computed per-store summary over ALL stored reviews (not just the
    // page returned above). Negative threshold comes from secrets.env config.
    const negativeThreshold = loadMobileReviewsConfig().sync.negativeThreshold;
    const summary =
      listingIds.length === 0
        ? []
        : await sql`
            select
              l.store,
              count(r.*)::int as total,
              round(avg(r.rating)::numeric, 2)::float8 as avg_rating,
              count(*) filter (where r.rating = 1)::int as r1,
              count(*) filter (where r.rating = 2)::int as r2,
              count(*) filter (where r.rating = 3)::int as r3,
              count(*) filter (where r.rating = 4)::int as r4,
              count(*) filter (where r.rating = 5)::int as r5,
              count(*) filter (where r.rating is not null and r.rating <= ${negativeThreshold})::int as negative,
              max(r.submitted_at) as latest_review_at
            from app_reviews r
            join mobile_app_listings l on l.id = r.listing_id
            where r.listing_id = any(${sql.array(listingIds)}::uuid[])
            group by l.store
          `;

    return ok({ app: appRows[0], listings, reviews, snapshots, syncRuns, summary, negativeThreshold });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to load app", 500);
  }
}
