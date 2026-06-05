import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";

export const dynamic = "force-dynamic";

const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

const VALID_METRICS = new Set(["avg_rating", "one_star_spike", "review_volume"]);
const VALID_OPS = new Set(["lt", "lte", "gt", "gte", "eq"]);

async function ensureAlertRulesTable(sql: ReturnType<typeof getSql>) {
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
}

export async function GET() {
  const session = await getSession();
  if (!session?.email) return fail("Not authenticated", 401);
  if (!(await isModuleEnabled("mobile-apps"))) return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);
  const sql = getSql();
  await ensureAlertRulesTable(sql);
  const rules = await sql`
    select id::text, mobile_app_id::text, metric, operator, threshold::float8 as threshold,
           window, channel_ids, enabled, last_fired_at
    from app_alert_rules order by created_at asc
  `;
  return ok({ rules });
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.email) return fail("Not authenticated", 401);
  if (!(await isModuleEnabled("mobile-apps"))) return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);
  const body = (await request.json()) as {
    mobileAppId?: string | null; metric?: string; operator?: string;
    threshold?: number; window?: string; channelIds?: string[];
  };
  if (!VALID_METRICS.has(String(body.metric))) return fail("Invalid metric");
  if (!VALID_OPS.has(String(body.operator))) return fail("Invalid operator");
  if (typeof body.threshold !== "number" || !Number.isFinite(body.threshold)) return fail("threshold must be a number");
  const sql = getSql();
  const metric = body.metric as string;
  const operator = body.operator as string;
  const threshold = body.threshold as number;
  const window = body.window ?? "daily";
  const channelIds = body.channelIds ?? [];
  const rows = (await sql`
    insert into app_alert_rules (mobile_app_id, metric, operator, threshold, window, channel_ids)
    values (
      ${body.mobileAppId ?? null}, ${metric}, ${operator}, ${threshold},
      ${window}, ${sql.array(channelIds)}
    )
    returning id::text
  `) as unknown as Array<{ id: string }>;
  return ok({ id: rows[0].id });
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session?.email) return fail("Not authenticated", 401);
  if (!(await isModuleEnabled("mobile-apps"))) return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);
  const body = (await request.json()) as { id?: string; enabled?: boolean; threshold?: number };
  const id = String(body.id || "");
  if (!id) return fail("id required");
  const sql = getSql();
  if (typeof body.enabled === "boolean") {
    await sql`update app_alert_rules set enabled = ${body.enabled} where id = ${id}::uuid`;
  }
  if (typeof body.threshold === "number" && Number.isFinite(body.threshold)) {
    await sql`update app_alert_rules set threshold = ${body.threshold} where id = ${id}::uuid`;
  }
  return ok();
}

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session?.email) return fail("Not authenticated", 401);
  if (!(await isModuleEnabled("mobile-apps"))) return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);
  const body = (await request.json()) as { id?: string };
  const id = String(body.id || "");
  if (!id) return fail("id required");
  const sql = getSql();
  await sql`delete from app_alert_rules where id = ${id}::uuid`;
  return ok();
}
