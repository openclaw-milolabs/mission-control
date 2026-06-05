import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { resolveListing } from "@/lib/mobile-apps/resolve";
import { getProvider } from "@/lib/mobile-apps/providers";
import { syncApp } from "@/lib/mobile-apps/sync";

export const dynamic = "force-dynamic";

const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

async function workspaceId(sql: ReturnType<typeof getSql>) {
  const rows = (await sql`select id from workspaces order by created_at asc limit 1`) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

let _schemaEnsured = false;
async function ensureSchema(sql: ReturnType<typeof getSql>) {
  if (_schemaEnsured) return;
  await sql`
    CREATE TABLE IF NOT EXISTS mobile_apps (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name text NOT NULL,
      icon_url text,
      notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS mobile_apps_workspace_idx ON mobile_apps(workspace_id)`;
  await sql`
    CREATE TABLE IF NOT EXISTS mobile_app_listings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mobile_app_id uuid NOT NULL REFERENCES mobile_apps(id) ON DELETE CASCADE,
      store text NOT NULL,
      store_app_id text NOT NULL,
      country text NOT NULL DEFAULT 'us',
      current_rating numeric(3,2),
      ratings_count integer,
      last_synced_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (mobile_app_id, store)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS mobile_app_listings_app_idx ON mobile_app_listings(mobile_app_id)`;
  await sql`
    CREATE TABLE IF NOT EXISTS app_reviews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      listing_id uuid NOT NULL REFERENCES mobile_app_listings(id) ON DELETE CASCADE,
      store_review_id text NOT NULL,
      author text,
      rating integer,
      title text,
      body text,
      app_version text,
      country text,
      submitted_at timestamptz,
      store_response text,
      sentiment text,
      themes text[],
      fetched_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (listing_id, store_review_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS app_reviews_listing_idx ON app_reviews(listing_id, submitted_at desc)`;
  await sql`
    CREATE TABLE IF NOT EXISTS app_rating_snapshots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      listing_id uuid NOT NULL REFERENCES mobile_app_listings(id) ON DELETE CASCADE,
      captured_at timestamptz NOT NULL DEFAULT now(),
      avg_rating numeric(3,2),
      ratings_count integer,
      histogram jsonb
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS app_rating_snapshots_listing_idx ON app_rating_snapshots(listing_id, captured_at desc)`;
  await sql`
    CREATE TABLE IF NOT EXISTS app_review_digests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mobile_app_id uuid NOT NULL REFERENCES mobile_apps(id) ON DELETE CASCADE,
      period_start timestamptz,
      period_end timestamptz,
      summary_md text NOT NULL,
      sentiment_score numeric(4,3),
      top_themes jsonb,
      generated_by_agent_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS app_review_digests_app_idx ON app_review_digests(mobile_app_id, created_at desc)`;
  await sql`
    CREATE TABLE IF NOT EXISTS app_alert_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mobile_app_id uuid REFERENCES mobile_apps(id) ON DELETE CASCADE,
      metric text NOT NULL,
      operator text NOT NULL DEFAULT 'lt',
      threshold numeric NOT NULL,
      window text NOT NULL DEFAULT 'daily',
      channel_ids text[] NOT NULL DEFAULT '{}'::text[],
      enabled boolean NOT NULL DEFAULT true,
      last_fired_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  _schemaEnsured = true;
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const sql = getSql();
    await ensureSchema(sql);
    const wid = await workspaceId(sql);
    if (!wid) return ok({ apps: [] });

    const apps = await sql`
      select
        a.id::text,
        a.name,
        a.icon_url,
        a.notes,
        coalesce(
          json_agg(
            json_build_object(
              'id', l.id::text,
              'store', l.store,
              'storeAppId', l.store_app_id,
              'country', l.country,
              'currentRating', l.current_rating,
              'ratingsCount', l.ratings_count,
              'lastSyncedAt', l.last_synced_at
            )
          ) filter (where l.id is not null),
          '[]'
        ) as listings
      from mobile_apps a
      left join mobile_app_listings l on l.mobile_app_id = a.id
      where a.workspace_id = ${wid}::uuid
      group by a.id
      order by a.created_at asc
    `;
    return ok({ apps });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to list apps", 500);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const sql = getSql();
    await ensureSchema(sql);
    const wid = await workspaceId(sql);
    if (!wid) return fail("Workspace not found", 500);

    const body = (await request.json()) as { name?: string; refs?: string[] };
    const refs = (Array.isArray(body.refs) ? body.refs : []).map((s) => String(s || "").trim()).filter(Boolean);
    if (refs.length === 0) return fail("Provide at least one App Store or Play Store URL/ID.");

    // Resolve all refs first so a bad one fails before we create anything.
    let resolved: ReturnType<typeof resolveListing>[];
    try {
      resolved = refs.map(resolveListing);
    } catch (e) {
      return fail(e instanceof Error ? e.message : "Invalid app reference", 400);
    }

    // Discover a display name/icon from the first listing's provider.
    let name = String(body.name || "").trim();
    let iconUrl: string | null = null;
    try {
      const first = resolved[0];
      const summary = await getProvider(first.store).fetchRatingSummary(first);
      if (!name) name = summary.name || "Untitled app";
      iconUrl = summary.iconUrl ?? null;
    } catch {
      if (!name) name = "Untitled app";
    }

    const appRows = (await sql`
      insert into mobile_apps (workspace_id, name, icon_url)
      values (${wid}::uuid, ${name}, ${iconUrl})
      returning id::text
    `) as unknown as Array<{ id: string }>;
    const appId = appRows[0].id;

    for (const r of resolved) {
      await sql`
        insert into mobile_app_listings (mobile_app_id, store, store_app_id, country)
        values (${appId}::uuid, ${r.store}, ${r.storeAppId}, ${r.country})
        on conflict (mobile_app_id, store) do nothing
      `;
    }

    // Kick off an immediate forced sync so the app isn't empty on first view.
    await syncApp(appId, { force: true }).catch(() => null);

    return ok({ id: appId, name });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to add app", 500);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const sql = getSql();
    await ensureSchema(sql);
    const wid = await workspaceId(sql);
    if (!wid) return fail("Workspace not found", 500);
    const body = (await request.json()) as { id?: string };
    const id = String(body.id || "");
    if (!id) return fail("App id is required.");
    await sql`delete from mobile_apps where id = ${id}::uuid and workspace_id = ${wid}::uuid`;
    return ok();
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to delete app", 500);
  }
}
