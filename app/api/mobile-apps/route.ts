import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { resolveListing } from "@/lib/mobile-apps/resolve";
import { syncApp } from "@/lib/mobile-apps/sync";
import { ensureMobileAppsSchema } from "@/lib/mobile-apps/ensure-schema";

export const dynamic = "force-dynamic";

const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

async function workspaceId(sql: ReturnType<typeof getSql>) {
  const rows = (await sql`select id from workspaces order by created_at asc limit 1`) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const sql = getSql();
    await ensureMobileAppsSchema(sql);
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
    await ensureMobileAppsSchema(sql);
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

    // The official publisher APIs are review-only and expose no store listing
    // metadata, so we name the app from the provided name or its store id.
    const name = String(body.name || "").trim() || resolved[0].storeAppId || "Untitled app";
    const iconUrl: string | null = null;

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
    await ensureMobileAppsSchema(sql);
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
