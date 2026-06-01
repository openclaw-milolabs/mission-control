import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { guardSelectOnly, bindNamedParams } from "@/lib/metrics/sql-guard";
import { executeMetricQuery } from "@/lib/metrics/mysql";
import { isValidWindow, resolveWindow, type WindowName } from "@/lib/metrics/window";

export const dynamic = "force-dynamic";

/* eslint-disable @typescript-eslint/no-explicit-any -- action-based route */
type Json = Record<string, any>;
const ok = (data: Json = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

async function workspaceId(sql: ReturnType<typeof getSql>) {
  const rows = await sql`select id from workspaces order by created_at asc limit 1`;
  return rows[0]?.id ?? null;
}

let _schemaEnsured = false;
async function ensureSchema(sql: ReturnType<typeof getSql>) {
  if (_schemaEnsured) return;
  // Mirrors the canonical db/schema.sql definition.
  await sql`
    CREATE TABLE IF NOT EXISTS metrics (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name text NOT NULL,
      description text,
      sql_text text NOT NULL,
      chart_type text NOT NULL DEFAULT 'bar',
      x_column text NOT NULL DEFAULT '',
      y_columns text[] NOT NULL DEFAULT '{}'::text[],
      default_window text NOT NULL DEFAULT 'monthly',
      position integer NOT NULL DEFAULT 0,
      created_by_email text,
      created_by_name text,
      updated_by_email text,
      updated_by_name text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS metrics_workspace_idx ON metrics(workspace_id)`;
  await sql`CREATE INDEX IF NOT EXISTS metrics_position_idx ON metrics(workspace_id, position)`;
  await sql`
    CREATE TABLE IF NOT EXISTS metric_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      metric_id uuid REFERENCES metrics(id) ON DELETE CASCADE,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      ran_by_email text,
      ran_by_name text,
      window text NOT NULL DEFAULT 'monthly',
      since timestamptz,
      until timestamptz,
      status text NOT NULL DEFAULT 'success',
      error_message text,
      row_count integer,
      duration_ms integer,
      occurred_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS metric_runs_metric_idx ON metric_runs(metric_id, occurred_at desc)`;
  _schemaEnsured = true;
}

const VALID_CHART_TYPES = new Set(["bar", "line", "area", "pie", "donut", "kpi"]);

function sanitizeYColumns(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((v) => String(v || "").trim())
    .filter((v) => v.length > 0 && v.length < 100)
    .slice(0, 10);
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("metrics"))) {
      return fail("Metrics module is disabled. Enable it in Settings.", 503);
    }
    const sql = getSql();
    await ensureSchema(sql);
    const wid = await workspaceId(sql);
    if (!wid) return ok({ metrics: [] });

    const rows = await sql`
      select
        id::text, name, description, sql_text, chart_type, x_column, y_columns,
        default_window, position,
        created_by_name, created_by_email,
        updated_by_name, updated_by_email,
        created_at, updated_at
      from metrics
      where workspace_id = ${wid}
      order by position asc, created_at asc
    `;
    return ok({ metrics: rows });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to list metrics", 500);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("metrics"))) {
      return fail("Metrics module is disabled. Enable it in Settings.", 503);
    }

    const sql = getSql();
    await ensureSchema(sql);
    const wid = await workspaceId(sql);
    if (!wid) return fail("Workspace not found", 500);

    const body = (await request.json()) as Json;
    const action = String(body.action || "");
    const actor = { name: session.name?.trim() || null, email: session.email.toLowerCase() };

    if (action === "createMetric") {
      const name = String(body.name || "").trim();
      const description = body.description ? String(body.description).trim() : null;
      const sqlText = String(body.sql || body.sqlText || "").trim();
      const chartType = String(body.chartType || "bar");
      const xColumn = String(body.xColumn || "").trim();
      const yColumns = sanitizeYColumns(body.yColumns);
      const defaultWindow = isValidWindow(body.defaultWindow) ? (body.defaultWindow as WindowName) : "monthly";
      if (!name) return fail("Name is required.");
      if (!sqlText) return fail("SQL is required.");
      if (!VALID_CHART_TYPES.has(chartType)) return fail(`Invalid chart type: ${chartType}`);
      const guard = guardSelectOnly(sqlText);
      if (!guard.ok) return fail(guard.reason);

      const posRow = await sql`select coalesce(max(position), -1) + 1 as pos from metrics where workspace_id=${wid}`;
      const position = Number((posRow as Array<{ pos: number }>)[0]?.pos ?? 0);
      const rows = await sql`
        insert into metrics (
          workspace_id, name, description, sql_text, chart_type, x_column, y_columns,
          default_window, position, created_by_email, created_by_name, updated_by_email, updated_by_name
        ) values (
          ${wid}, ${name}, ${description}, ${guard.cleaned}, ${chartType}, ${xColumn}, ${sql.array(yColumns)},
          ${defaultWindow}, ${position}, ${actor.email}, ${actor.name}, ${actor.email}, ${actor.name}
        )
        returning id::text, name, chart_type
      `;
      return ok({ metric: (rows as Array<Record<string, unknown>>)[0] });
    }

    if (action === "updateMetric") {
      const id = String(body.id || "");
      if (!id) return fail("Metric id is required.");
      const patch: Record<string, unknown> = {};
      if (typeof body.name === "string") patch.name = body.name.trim();
      if (body.description !== undefined) patch.description = body.description ? String(body.description) : null;
      if (typeof body.sql === "string" || typeof body.sqlText === "string") {
        const sqlText = String(body.sql ?? body.sqlText).trim();
        const guard = guardSelectOnly(sqlText);
        if (!guard.ok) return fail(guard.reason);
        patch.sql_text = guard.cleaned;
      }
      if (typeof body.chartType === "string") {
        if (!VALID_CHART_TYPES.has(body.chartType)) return fail(`Invalid chart type: ${body.chartType}`);
        patch.chart_type = body.chartType;
      }
      if (typeof body.xColumn === "string") patch.x_column = body.xColumn.trim();
      if (Array.isArray(body.yColumns)) patch.y_columns = sanitizeYColumns(body.yColumns);
      if (isValidWindow(body.defaultWindow)) patch.default_window = body.defaultWindow;

      if (Object.keys(patch).length === 0) return fail("Nothing to update.");

      // Build update dynamically — using individual statements keeps the query
      // parameterised. (We don't accept attacker-controlled column names.)
      if (patch.name !== undefined) await sql`update metrics set name = ${patch.name as string} where id = ${id}`;
      if (patch.description !== undefined) await sql`update metrics set description = ${patch.description as string | null} where id = ${id}`;
      if (patch.sql_text !== undefined) await sql`update metrics set sql_text = ${patch.sql_text as string} where id = ${id}`;
      if (patch.chart_type !== undefined) await sql`update metrics set chart_type = ${patch.chart_type as string} where id = ${id}`;
      if (patch.x_column !== undefined) await sql`update metrics set x_column = ${patch.x_column as string} where id = ${id}`;
      if (patch.y_columns !== undefined) await sql`update metrics set y_columns = ${sql.array(patch.y_columns as string[])} where id = ${id}`;
      if (patch.default_window !== undefined) await sql`update metrics set default_window = ${patch.default_window as string} where id = ${id}`;
      await sql`update metrics set updated_at = now(), updated_by_email = ${actor.email}, updated_by_name = ${actor.name} where id = ${id}`;
      return ok();
    }

    if (action === "deleteMetric") {
      const id = String(body.id || "");
      if (!id) return fail("Metric id is required.");
      await sql`delete from metrics where id = ${id}`;
      return ok();
    }

    if (action === "reorderMetrics") {
      const ids = Array.isArray(body.orderedIds) ? body.orderedIds.map(String) : [];
      for (let i = 0; i < ids.length; i += 1) {
        await sql`update metrics set position = ${i}, updated_at = now() where id = ${ids[i]}`;
      }
      return ok();
    }

    if (action === "runMetric" || action === "previewSql") {
      const isPreview = action === "previewSql";
      const window = isValidWindow(body.window) ? (body.window as WindowName) : "monthly";
      const resolved = resolveWindow({
        window,
        since: body.since ?? null,
        until: body.until ?? null,
        bucket: body.bucket ?? null,
      });

      let sqlText: string;
      let metricId: string | null = null;
      if (isPreview) {
        sqlText = String(body.sql || "").trim();
        if (!sqlText) return fail("SQL is required.");
      } else {
        metricId = String(body.metricId || "");
        if (!metricId) return fail("Metric id is required.");
        const rows = await sql`select sql_text from metrics where id = ${metricId} limit 1` as Array<{ sql_text: string }>;
        if (!rows[0]) return fail("Metric not found.", 404);
        sqlText = rows[0].sql_text;
      }

      const guard = guardSelectOnly(sqlText);
      if (!guard.ok) return fail(guard.reason);
      const { sql: boundSql, values } = bindNamedParams(guard.cleaned, {
        since: resolved.since,
        until: resolved.until,
        bucket: resolved.bucket,
      });

      const t0 = Date.now();
      const result = await executeMetricQuery(boundSql, values);
      const durationMs = Date.now() - t0;
      if (!isPreview && metricId) {
        await sql`
          insert into metric_runs (
            metric_id, workspace_id, ran_by_email, ran_by_name,
            window, since, until, status, error_message, row_count, duration_ms
          ) values (
            ${metricId}, ${wid}, ${actor.email}, ${actor.name},
            ${window}, ${resolved.since.toISOString()}, ${resolved.until.toISOString()},
            ${result.ok ? "success" : "failed"},
            ${result.ok ? null : result.error},
            ${result.ok ? result.rowCount : 0},
            ${durationMs}
          )
        `.catch(() => null);
      }

      if (!result.ok) return fail(result.error, 422);
      return ok({
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
        truncated: result.truncated,
        durationMs: result.durationMs,
        window: {
          name: window,
          since: resolved.since.toISOString(),
          until: resolved.until.toISOString(),
          bucket: resolved.bucket,
        },
      });
    }

    return fail(`Unsupported action: ${action}`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Metrics operation failed", 500);
  }
}
