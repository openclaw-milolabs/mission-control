import { describe, expect, it } from "vitest";
import { ensureMobileAppsSchema } from "@/lib/mobile-apps/ensure-schema";

function recordingSql() {
  const queries: string[] = [];
  const fn = (strings: TemplateStringsArray): Promise<unknown[]> => {
    queries.push(strings.join(" "));
    return Promise.resolve([]);
  };
  return { fn, queries };
}

describe("ensureMobileAppsSchema rollup/jobs/freshness tables", () => {
  it("creates the worker job, freshness, daily-rollup and latest-breakdown tables", async () => {
    const { fn, queries } = recordingSql();
    await ensureMobileAppsSchema(fn as never);
    const all = queries.join("\n");

    expect(all).toContain("CREATE TABLE IF NOT EXISTS mobile_app_report_sync_jobs");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS mobile_app_report_freshness");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS mobile_app_report_daily_rollups");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS mobile_app_report_latest_breakdowns");

    // Job/freshness status domains are constrained.
    expect(all).toContain("status text NOT NULL DEFAULT 'queued'");
    expect(all).toMatch(/queued'\s*,\s*'running'\s*,\s*'success'\s*,\s*'partial'\s*,\s*'failed'\s*,\s*'skipped'/);

    // Rollups keyed for upsert convergence.
    expect(all).toContain("PRIMARY KEY (listing_id, report, metric_date)");
    expect(all).toContain("PRIMARY KEY (listing_id, report, dimension, dimension_value)");

    // Helpful read/lookup indexes.
    expect(all).toContain("mobile_app_report_sync_jobs_status_idx");
    expect(all).toContain("mobile_app_report_metrics_listing_report_dim_date_idx");
    expect(all).toContain("mobile_app_report_files_generation_idx");
  });
});
