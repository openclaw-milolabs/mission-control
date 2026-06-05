import { getSql } from "@/lib/local-db";

export type AlertMetric = "avg_rating" | "one_star_spike" | "review_volume";
export type AlertOperator = "lt" | "lte" | "gt" | "gte" | "eq";

export type AlertRule = {
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
};

export type AppAlertSignals = {
  avgRating: number | null;
  oneStarToday: number;
  reviewsToday: number;
};

/** Pure: does this rule trip given the current signals? */
export function evaluateRule(rule: AlertRule, signals: AppAlertSignals): boolean {
  const value =
    rule.metric === "avg_rating"
      ? signals.avgRating
      : rule.metric === "one_star_spike"
        ? signals.oneStarToday
        : signals.reviewsToday;
  if (value == null || !Number.isFinite(value)) return false;
  switch (rule.operator) {
    case "lt": return value < rule.threshold;
    case "lte": return value <= rule.threshold;
    case "gt": return value > rule.threshold;
    case "gte": return value >= rule.threshold;
    case "eq": return value === rule.threshold;
    default: return false;
  }
}

type Sql = ReturnType<typeof getSql>;

/** Compute current alert signals for an app from listings + today's reviews. */
export async function computeSignals(sql: Sql, appId: string): Promise<AppAlertSignals> {
  const ratingRows = (await sql`
    select avg(current_rating)::numeric(3,2) as avg
    from mobile_app_listings where mobile_app_id = ${appId} and current_rating is not null
  `) as unknown as Array<{ avg: string | number | null }>;
  const todayRows = (await sql`
    select
      count(*) filter (where r.rating = 1)::int as one_star,
      count(*)::int as total
    from app_reviews r
    join mobile_app_listings l on l.id = r.listing_id
    where l.mobile_app_id = ${appId}
      and r.submitted_at >= date_trunc('day', now())
  `) as unknown as Array<{ one_star: number; total: number }>;
  const rawAvg = ratingRows[0]?.avg;
  const avgRating = rawAvg == null ? null : Number(rawAvg);
  return {
    avgRating: avgRating != null && Number.isFinite(avgRating) ? avgRating : null,
    oneStarToday: Number(todayRows[0]?.one_star ?? 0),
    reviewsToday: Number(todayRows[0]?.total ?? 0),
  };
}

/**
 * Evaluate all enabled rules for an app after a sync; fire notifications via
 * notification_channels for any that trip (debounced: not refired within 6h).
 */
export async function evaluateAndFire(appId: string): Promise<void> {
  const sql = getSql();
  // NOTE: a global rule (mobile_app_id IS NULL) shares one last_fired_at across all apps,
  // so its 6h debounce is global, not per-app. The C3 UI only creates per-app rules, so this
  // does not manifest in v1; revisit with per-(rule,app) tracking if global rules are exposed.
  const rules = (await sql`
    select id::text, metric, operator, threshold::float8 as threshold, channel_ids, last_fired_at
    from app_alert_rules
    where enabled = true and (mobile_app_id = ${appId} or mobile_app_id is null)
  `) as unknown as Array<{
    id: string; metric: AlertMetric; operator: AlertOperator; threshold: number;
    channel_ids: string[]; last_fired_at: string | null;
  }>;
  if (rules.length === 0) return;

  const signals = await computeSignals(sql, appId);
  const appRows = (await sql`select name from mobile_apps where id = ${appId} limit 1`) as unknown as Array<{ name: string }>;
  const appName = appRows[0]?.name ?? "App";

  for (const rule of rules) {
    const trips = evaluateRule(rule, signals);
    if (!trips) continue;
    const recentlyFired = rule.last_fired_at && Date.now() - new Date(rule.last_fired_at).getTime() < 6 * 60 * 60 * 1000;
    if (recentlyFired) continue;

    const message = `📱 ${appName}: alert "${rule.metric} ${rule.operator} ${rule.threshold}" tripped (avg ${signals.avgRating ?? "?"}, 1★ today ${signals.oneStarToday}, reviews today ${signals.reviewsToday}).`;
    const delivered = await notifyChannels(sql, rule.channel_ids, message).catch(() => false);
    if (delivered) {
      await sql`update app_alert_rules set last_fired_at = now() where id = ${rule.id}`.catch(() => null);
    }
  }
}

/**
 * Deliver a message to the given notification_channels rows. v1 logs to
 * activity_logs as a guaranteed sink; provider-specific delivery (Telegram/Slack)
 * is wired in a later task.
 *
 * activity_logs columns used: workspace_id, source, event, details, level
 * (level is plain text, not an enum — 'warning' is a valid value per schema.sql)
 */
async function notifyChannels(sql: Sql, channelIds: string[], message: string): Promise<boolean> {
  void channelIds; // provider-specific delivery (Telegram/Slack) wired in Task C3
  const wid = (await sql`select id from workspaces order by created_at asc limit 1`) as unknown as Array<{ id: string }>;
  const workspaceId = wid[0]?.id;
  if (!workspaceId) return false;
  try {
    await sql`
      insert into activity_logs (workspace_id, source, event, details, level)
      values (${workspaceId}, 'Mobile Applications', 'alert', ${message}, 'warning')
    `;
    return true;
  } catch {
    return false;
  }
}
