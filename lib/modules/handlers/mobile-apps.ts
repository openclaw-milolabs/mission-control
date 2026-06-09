import type { getSql } from "@/lib/local-db";
import { ensureMobileAppsSchema, resetMobileAppsSchemaCache } from "@/lib/mobile-apps/ensure-schema";

type Sql = ReturnType<typeof getSql>;

/**
 * Creates / drops the tables exclusively owned by the Mobile Applications module.
 * Mirrors the metricsHandler shape (preview/cleanup/setup) wired in app/api/modules/route.ts.
 */
export const mobileAppsHandler = {
  async preview(sql: Sql) {
    const [apps, reviews] = await Promise.all([
      sql`select count(*)::int as n from mobile_apps`.catch(() => [{ n: 0 }]),
      sql`select count(*)::int as n from app_reviews`.catch(() => [{ n: 0 }]),
    ]);
    const sampleApps = (await sql`
      select name from mobile_apps order by created_at desc limit 5
    `.catch(() => [])) as Array<{ name: string }>;

    return {
      counts: [
        { icon: "📱", label: "tracked apps", n: Number((apps as Array<{ n: number }>)[0]?.n ?? 0) },
        { icon: "⭐", label: "fetched reviews", n: Number((reviews as Array<{ n: number }>)[0]?.n ?? 0) },
      ],
      bytesOnDisk: null,
      sampleAffected: sampleApps.map((a) => ({ kind: "app", label: a.name })),
      finalWarning:
        "Disabling Mobile Applications permanently deletes every tracked app, fetched review, rating snapshot, digest, and alert rule. The app stores are not affected.",
    };
  },

  async cleanup(sql: Sql): Promise<void> {
    // Drop every table owned by the module, including the report/job/freshness/
    // rollup tables added later. Children first; CASCADE covers any stragglers so
    // none are left orphaned with dangling FKs.
    for (const table of [
      "mobile_app_report_latest_breakdowns",
      "mobile_app_report_daily_rollups",
      "mobile_app_report_freshness",
      "mobile_app_report_sync_jobs",
      "mobile_app_report_files",
      "mobile_app_report_metrics",
      "app_review_sync_runs",
      "app_alert_rules",
      "app_review_digests",
      "app_rating_snapshots",
      "app_reviews",
      "mobile_app_listings",
      "mobile_apps",
    ]) {
      await sql`DROP TABLE IF EXISTS ${sql(table)} CASCADE`;
    }
    // Tables are gone — clear the ensure memo so a re-enable recreates them.
    resetMobileAppsSchemaCache();
  },

  async setup(sql: Sql): Promise<void> {
    // Single schema authority: ensureMobileAppsSchema creates the full, current set
    // of tables (base + report/job/freshness/rollup) idempotently, so module setup
    // can never report "done" against a stale/partial schema.
    await ensureMobileAppsSchema(sql);
  },
};
