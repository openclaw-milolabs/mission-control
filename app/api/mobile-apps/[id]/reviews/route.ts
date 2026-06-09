import { NextResponse } from "next/server";
import { z } from "zod";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { ensureMobileAppsSchema } from "@/lib/mobile-apps/ensure-schema";

export const dynamic = "force-dynamic";

const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

async function workspaceId(sql: ReturnType<typeof getSql>) {
  const rows = (await sql`select id from workspaces order by created_at asc limit 1`) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

// Accept either a full ISO timestamp (2026-06-09T00:00:00Z) or a date (2026-06-09);
// both parse to a timestamptz in SQL. Powers "reviews of today" windows for crons.
const dateLike = z
  .string()
  .trim()
  .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date/time");

const querySchema = z.object({
  store: z.enum(["apple", "google"]).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  sort: z.enum(["newest", "oldest", "lowest", "highest"]).default("newest"),
  q: z.string().trim().max(200).optional(),
  // Filter by review submission time. `since` is inclusive, `until` exclusive.
  since: dateLike.optional(),
  until: dateLike.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Paginated, filterable, searchable review feed for one app. Replaces the old
 * "dump up to 100 reviews" behaviour: the client pages through with offset.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const { id } = await params;
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return fail("Invalid review query.", 422);
    const { store, rating, sort, q, since, until, limit, offset } = parsed.data;

    const sql = getSql();
    await ensureMobileAppsSchema(sql);
    const wid = await workspaceId(sql);
    if (!wid) return fail("App not found", 404);

    const appRows = (await sql`
      select id from mobile_apps where id = ${id}::uuid and workspace_id = ${wid}::uuid limit 1
    `) as unknown as Array<{ id: string }>;
    if (!appRows[0]) return fail("App not found", 404);

    const listings = (await sql`
      select id::text from mobile_app_listings where mobile_app_id = ${id}::uuid
    `) as unknown as Array<{ id: string }>;
    const listingIds = listings.map((l) => l.id);
    if (listingIds.length === 0) return ok({ reviews: [], total: 0, hasMore: false, nextOffset: null });

    const like = q ? `%${q}%` : null;
    const order =
      sort === "oldest"
        ? sql`order by r.submitted_at asc nulls last, r.id asc`
        : sort === "lowest"
          ? sql`order by r.rating asc nulls last, r.submitted_at desc nulls last`
          : sort === "highest"
            ? sql`order by r.rating desc nulls last, r.submitted_at desc nulls last`
            : sql`order by r.submitted_at desc nulls last, r.id desc`;

    const where = sql`
      where r.listing_id = any(${sql.array(listingIds)}::uuid[])
        and (${store ?? null}::text is null or l.store = ${store ?? null})
        and (${rating ?? null}::int is null or r.rating = ${rating ?? null})
        and (${since ?? null}::timestamptz is null or r.submitted_at >= ${since ?? null}::timestamptz)
        and (${until ?? null}::timestamptz is null or r.submitted_at < ${until ?? null}::timestamptz)
        and (${like}::text is null or r.title ilike ${like} or r.body ilike ${like} or r.author ilike ${like})
    `;

    const countRows = (await sql`
      select count(*)::int as total
      from app_reviews r join mobile_app_listings l on l.id = r.listing_id
      ${where}
    `) as unknown as Array<{ total: number }>;
    const total = countRows[0]?.total ?? 0;

    const reviews = await sql`
      select
        r.id::text, l.store, r.author, r.rating, r.title, r.body,
        r.app_version, r.country, r.language, r.submitted_at, r.store_response
      from app_reviews r join mobile_app_listings l on l.id = r.listing_id
      ${where}
      ${order}
      limit ${limit} offset ${offset}
    `;

    const hasMore = offset + limit < total;
    return ok({ reviews, total, hasMore, nextOffset: hasMore ? offset + limit : null });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to load reviews", 500);
  }
}
