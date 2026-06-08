import { describe, expect, it } from "vitest";
import { ensureMobileAppsSchema } from "@/lib/mobile-apps/ensure-schema";

/** Records every SQL string ensureMobileAppsSchema issues. */
function recordingSql() {
  const queries: string[] = [];
  const fn = (strings: TemplateStringsArray): Promise<unknown[]> => {
    queries.push(strings.join(" "));
    return Promise.resolve([]);
  };
  return { fn, queries };
}

describe("ensureMobileAppsSchema store constraints", () => {
  it("adds store CHECKs only-if-missing and never DROPs them", async () => {
    const { fn, queries } = recordingSql();
    await ensureMobileAppsSchema(fn as never);
    const all = queries.join("\n");

    // Both tables get a store check.
    expect(all).toContain("mobile_app_listings_store_check");
    expect(all).toContain("app_review_sync_runs_store_check");
    expect(all).toContain("store IN ('apple','google')");

    // Idempotent add-if-missing, never a drop+re-add (no window without the constraint).
    expect(all).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint");
    expect(all).not.toMatch(/DROP CONSTRAINT/);
  });
});
