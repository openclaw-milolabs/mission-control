import { describe, expect, it } from "vitest";
import { parseBucketStart, bucketEnd, formatBucketLabel, computeBucketDelta, parseDbDateTime } from "@/lib/metrics/delta";

describe("parseBucketStart / bucketEnd", () => {
  it("parses hourly buckets and advances one hour", () => {
    const start = parseBucketStart("2026-06-08 14:00", "hourly")!;
    expect(start.getHours()).toBe(14);
    expect(bucketEnd(start, "hourly").getHours()).toBe(15);
  });
  it("parses ISO week buckets to the Monday", () => {
    // 2026-W01 → the Monday of ISO week 1.
    const start = parseBucketStart("2026-W01", "weekly")!;
    expect(start.getDay()).toBe(1); // Monday
  });
  it("parses monthly + yearly", () => {
    expect(parseBucketStart("2026-06", "monthly")!.getMonth()).toBe(5);
    expect(parseBucketStart("2026", "yearly")!.getFullYear()).toBe(2026);
  });
  it("returns null for a label that doesn't match the window", () => {
    expect(parseBucketStart("not-a-date", "hourly")).toBeNull();
  });
});

describe("formatBucketLabel", () => {
  it("shortens labels per granularity", () => {
    expect(formatBucketLabel("2026-06-08 14:00", "hourly")).toBe("14:00");
    expect(formatBucketLabel("2026-06-08", "daily")).toBe("8 Jun");
    expect(formatBucketLabel("2026-W23", "weekly")).toBe("W23");
    expect(formatBucketLabel("2026-06", "monthly")).toBe("Jun '26");
    expect(formatBucketLabel("2026", "yearly")).toBe("2026");
  });
});

describe("computeBucketDelta", () => {
  const rows = [
    { bucket: "2026-06-08 11:00", Registrations: 100 },
    { bucket: "2026-06-08 12:00", Registrations: 120 },
    { bucket: "2026-06-08 13:00", Registrations: 140 },
    { bucket: "2026-06-08 14:00", Registrations: 5 }, // partial: backup hasn't finished syncing 14:00
  ];

  it("diffs the last two COMPLETE buckets, excluding the in-progress one", () => {
    // Backup synced through 14:05 → the 13:00 bucket is fully elapsed (ends 14:00),
    // but the 14:00 bucket (ends 15:00) is still in progress and must be excluded.
    const asOf = parseDbDateTime("2026-06-08 14:05:00");
    const d = computeBucketDelta({ rows, xColumn: "bucket", yColumn: "Registrations", window: "hourly", asOf })!;
    // last complete = 13:00 (140), previous = 12:00 (120) → +20
    expect(d.current).toBe(140);
    expect(d.previous).toBe(120);
    expect(d.delta).toBe(20);
    expect(d.currentLabel).toBe("2026-06-08 13:00");
    expect(d.excluded).toBe(1);
  });

  it("does NOT let the unsynced bucket fake a negative drop", () => {
    const asOf = parseDbDateTime("2026-06-08 14:05:00");
    const d = computeBucketDelta({ rows, xColumn: "bucket", yColumn: "Registrations", window: "hourly", asOf })!;
    expect(d.delta).toBeGreaterThan(0); // +20, not 5-140 = -135
  });

  it("falls back to dropping the final bucket when no freshness is known", () => {
    const d = computeBucketDelta({ rows, xColumn: "bucket", yColumn: "Registrations", window: "hourly", asOf: null })!;
    expect(d.current).toBe(140); // 14:00 dropped as in-progress
    expect(d.delta).toBe(20);
  });

  it("returns null when there aren't two complete buckets", () => {
    const asOf = parseDbDateTime("2026-06-08 11:30:00");
    expect(computeBucketDelta({ rows, xColumn: "bucket", yColumn: "Registrations", window: "hourly", asOf })).toBeNull();
  });
});
