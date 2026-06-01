import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";
import { MODULES, type ModuleId } from "@/lib/modules/registry";
import { invalidateModuleCache, readModuleSnapshot } from "@/lib/modules/state";
import { documentsHandler } from "@/lib/modules/handlers/documents";

export const dynamic = "force-dynamic";

type Json = Record<string, unknown>;

const ok = (data: Json = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

// Only non-core modules have handlers right now. Core modules can't be disabled
// so they never need preview/cleanup/setup logic.
const HANDLERS: Partial<Record<ModuleId, typeof documentsHandler>> = {
  documents: documentsHandler,
};

async function workspaceId(sql: ReturnType<typeof getSql>) {
  const rows = await sql`select id from workspaces order by created_at asc limit 1`;
  return rows[0]?.id ?? null;
}

async function logActivity(
  sql: ReturnType<typeof getSql>,
  wid: string,
  actor: { name: string | null; email: string | null },
  event: string,
  details: string,
  level: "info" | "success" | "warning" = "info",
) {
  await sql`
    insert into activity_logs (workspace_id, source, event, details, level, actor_name, actor_email)
    values (${wid}, 'Modules', ${event}, ${details}, ${level}, ${actor.name}, ${actor.email})
  `.catch(() => null);
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);

    const sql = getSql();
    const snap = await readModuleSnapshot(true); // bypass cache for the settings page

    const rows = await sql`
      select module_id, enabled, enabled_at, disabled_at,
             enabled_by_name, enabled_by_email,
             disabled_by_name, disabled_by_email, updated_at
      from module_state
    `.catch(() => []) as Array<{
      module_id: string;
      enabled: boolean;
      enabled_at: string | null;
      disabled_at: string | null;
      enabled_by_name: string | null;
      enabled_by_email: string | null;
      disabled_by_name: string | null;
      disabled_by_email: string | null;
      updated_at: string;
    }>;
    const rowById = new Map(rows.map((r) => [r.module_id, r]));

    const modules = MODULES.map((m) => {
      const r = rowById.get(m.id);
      return {
        id: m.id,
        name: m.name,
        description: m.description,
        core: m.core,
        navUrl: m.nav?.url || null,
        navTitle: m.nav?.title || null,
        enabled: r ? r.enabled : true,
        enabledAt: r?.enabled_at || null,
        disabledAt: r?.disabled_at || null,
        enabledByName: r?.enabled_by_name || null,
        disabledByName: r?.disabled_by_name || null,
        updatedAt: r?.updated_at || null,
      };
    });

    return ok({ modules, enabledIds: Array.from(snap.enabled) });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to list modules", 500);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);

    const sql = getSql();
    const wid = await workspaceId(sql);
    if (!wid) return fail("Workspace not found", 500);

    const body = (await request.json()) as Json;
    const action = String(body.action || "");
    const moduleId = String(body.moduleId || "") as ModuleId;
    const def = MODULES.find((m) => m.id === moduleId);
    if (!def) return fail(`Unknown module: ${moduleId}`);
    const actor = { name: session.name?.trim() || null, email: session.email.toLowerCase() };

    if (action === "previewDisable") {
      if (def.core) return fail("Core modules cannot be disabled.");
      const handler = HANDLERS[moduleId];
      if (!handler) return ok({ counts: [], bytesOnDisk: null, sampleAffected: [], finalWarning: "" });
      const preview = await handler.preview(sql);
      return ok({ preview });
    }

    if (action === "disable") {
      if (def.core) return fail("Core modules cannot be disabled.");
      const confirmName = String(body.confirmName || "").trim();
      if (confirmName !== moduleId) {
        return fail(`Type "${moduleId}" exactly to confirm.`);
      }
      const handler = HANDLERS[moduleId];
      if (handler) await handler.cleanup(sql);
      await sql`
        insert into module_state (module_id, enabled, disabled_at, disabled_by_email, disabled_by_name, updated_at)
        values (${moduleId}, false, now(), ${actor.email}, ${actor.name}, now())
        on conflict (module_id) do update
        set enabled = false,
            disabled_at = now(),
            disabled_by_email = ${actor.email},
            disabled_by_name = ${actor.name},
            updated_at = now()
      `;
      invalidateModuleCache();
      await logActivity(sql, wid, actor, "Module disabled", def.name, "warning");
      return ok();
    }

    if (action === "enable") {
      const handler = HANDLERS[moduleId];
      if (handler) await handler.setup(sql);
      await sql`
        insert into module_state (module_id, enabled, enabled_at, enabled_by_email, enabled_by_name, updated_at)
        values (${moduleId}, true, now(), ${actor.email}, ${actor.name}, now())
        on conflict (module_id) do update
        set enabled = true,
            enabled_at = now(),
            enabled_by_email = ${actor.email},
            enabled_by_name = ${actor.name},
            updated_at = now()
      `;
      invalidateModuleCache();
      await logActivity(sql, wid, actor, "Module enabled", def.name, "success");
      return ok();
    }

    return fail(`Unsupported action: ${action}`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Module operation failed", 500);
  }
}
