import { describe, expect, it } from "vitest";
import { usesWindow, usesBucket } from "@/lib/metrics/window";

// Representative shapes from the real exported metrics.
const TIME_SERIES = "SELECT DATE_FORMAT(`start`, :bucket) AS bucket, COUNT(*) FROM PlayerSession WHERE `start` BETWEEN :since AND :until GROUP BY bucket";
const SNAPSHOT_DONUT = "SELECT CASE WHEN clientDevice LIKE '%iPhone%' THEN 'iPhone' ELSE 'Other' END AS Platform, COUNT(*) FROM PlayerSession WHERE `start` BETWEEN :since AND :until GROUP BY Platform";
const LIFETIME_DONUT = "SELECT authType, COUNT(*) FROM Player WHERE authType <> 'PRIVATE' GROUP BY authType";

describe("usesWindow", () => {
  it("is true when the query references any window placeholder", () => {
    expect(usesWindow(TIME_SERIES)).toBe(true);
    expect(usesWindow(SNAPSHOT_DONUT)).toBe(true);
  });
  it("is false for a lifetime query with no placeholders", () => {
    expect(usesWindow(LIFETIME_DONUT)).toBe(false);
  });
  it("is not tripped by ::casts or column names", () => {
    expect(usesWindow("SELECT created_at, x::int FROM t")).toBe(false);
  });
});

describe("usesBucket", () => {
  it("is true ONLY for genuine time series that bucket by :bucket", () => {
    expect(usesBucket(TIME_SERIES)).toBe(true);
  });
  it("is false for a windowed snapshot (since/until but no bucket) — the donut bug", () => {
    // This is exactly why Platform Mix should NOT get Hour/Day/Week/Month/Year pills.
    expect(usesBucket(SNAPSHOT_DONUT)).toBe(false);
    expect(usesWindow(SNAPSHOT_DONUT)).toBe(true);
  });
  it("is false for a lifetime query", () => {
    expect(usesBucket(LIFETIME_DONUT)).toBe(false);
  });
  it("is not tripped by ::casts or column names", () => {
    expect(usesBucket("SELECT bucket_col, x::int FROM t")).toBe(false);
  });
});
