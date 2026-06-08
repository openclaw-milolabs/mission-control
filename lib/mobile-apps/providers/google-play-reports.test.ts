import { describe, expect, it } from "vitest";
import {
  parseRatingsCsv,
  parseReportCsv,
  parseReportRecordsMulti,
  parseCsvRecords,
  reportObjectPath,
  reportCandidatePaths,
  normalizeBucketName,
  ReportError,
} from "@/lib/mobile-apps/providers/google-play-reports";

const csv = [
  "Date,Package Name,Country,Daily Average Rating,Total Average Rating",
  "2026-06-01,com.x,US,4.10,4.05",
  "2026-06-02,com.x,US,4.20,4.07",
  "2026-06-01,com.x,TR,3.50,3.60",
  "2026-06-02,com.x,NL,,4.70",
].join("\r\n");

describe("parseRatingsCsv (Play Console ratings report)", () => {
  it("returns the latest Total Average Rating per country", () => {
    const rows = parseRatingsCsv(csv);
    const us = rows.find((r) => r.territory === "us");
    const tr = rows.find((r) => r.territory === "tr");
    const nl = rows.find((r) => r.territory === "nl");
    expect(us).toEqual({ territory: "us", avg: 4.07, asOf: "2026-06-02" });
    expect(tr).toEqual({ territory: "tr", avg: 3.6, asOf: "2026-06-01" });
    expect(nl).toEqual({ territory: "nl", avg: 4.7, asOf: "2026-06-02" });
  });

  it("strips a UTF BOM and ignores blank lines", () => {
    const rows = parseRatingsCsv("﻿" + csv + "\r\n");
    expect(rows.length).toBe(3);
  });

  it("returns [] for empty / header-only input", () => {
    expect(parseRatingsCsv("")).toEqual([]);
    expect(parseRatingsCsv("Date,Package Name,Country,Daily Average Rating,Total Average Rating")).toEqual([]);
  });
});

describe("reportObjectPath", () => {
  it("builds the documented monthly report paths", () => {
    expect(reportObjectPath("ratings", "com.x", "202606", "country")).toBe(
      "stats/ratings/ratings_com.x_202606_country.csv",
    );
    expect(reportObjectPath("installs", "com.x", "202606", "overview")).toBe(
      "stats/installs/installs_com.x_202606_overview.csv",
    );
    expect(reportObjectPath("crashes", "com.x", "202606", "app_version")).toBe(
      "stats/crashes/crashes_com.x_202606_app_version.csv",
    );
  });
});

describe("parseReportCsv (generic installs/crashes parser)", () => {
  it("parses an overview installs report (no dimension) into dated numeric metrics", () => {
    const csv = [
      "Date,Package Name,Daily Device Installs,Daily Device Uninstalls,Active Device Installs",
      "2026-06-01,com.x,120,30,5400",
      "2026-06-02,com.x,140,25,5515",
    ].join("\r\n");
    const rows = parseReportCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      date: "2026-06-01",
      dimensionValue: "",
      values: { daily_device_installs: 120, daily_device_uninstalls: 30, active_device_installs: 5400 },
    });
  });

  it("captures the breakdown dimension (e.g. App Version) for crashes", () => {
    const csv = [
      "Date,Package Name,App Version,Daily Crashes,Daily ANRs",
      "2026-06-02,com.x,2.1.0,4,1",
    ].join("\n");
    const [r] = parseReportCsv(csv);
    expect(r.dimensionValue).toBe("2.1.0");
    expect(r.values).toEqual({ daily_crashes: 4, daily_anrs: 1 });
  });

  it("decodes a value that came from a UTF-16 BOM-stripped string", () => {
    const csv = "﻿Date,Package Name,Daily Crashes\r\n2026-06-02,com.x,7\r\n";
    const [r] = parseReportCsv(csv);
    expect(r.values.daily_crashes).toBe(7);
  });

  it("parses store-performance country rows (visitors, acquisitions, conversion %)", () => {
    const csv = [
      "Date,Package Name,Country,Store Listing Visitors,Store Listing Acquisitions,Store Listing Conversion Rate",
      "2026-06-02,com.x,TR,1000,40,4.00%",
    ].join("\r\n");
    const [r] = parseReportCsv(csv);
    expect(r.dimensionValue).toBe("tr");
    expect(r.values.store_listing_visitors).toBe(1000);
    expect(r.values.store_listing_acquisitions).toBe(40);
    expect(r.values.store_listing_conversion_rate).toBe(4); // trailing % stripped
  });
});

describe("parseCsvRecords", () => {
  it("respects quoted commas and embedded newlines", () => {
    const csv = 'a,b,c\r\n"x,1","line1\nline2","y""z"\r\n';
    const rows = parseCsvRecords(csv);
    expect(rows[0]).toEqual(["a", "b", "c"]);
    expect(rows[1]).toEqual(["x,1", "line1\nline2", 'y"z']);
  });
});

describe("normalizeBucketName", () => {
  it("extracts the bucket id from a plain id, gs:// uri, or full path", () => {
    expect(normalizeBucketName("pubsite_prod_rev_1")).toBe("pubsite_prod_rev_1");
    expect(normalizeBucketName("gs://pubsite_prod_rev_1")).toBe("pubsite_prod_rev_1");
    expect(normalizeBucketName("gs://pubsite_prod_rev_1/stats/ratings/")).toBe("pubsite_prod_rev_1");
    expect(normalizeBucketName(null)).toBe("");
  });
});

describe("parseReportRecordsMulti (Store Performance traffic_source)", () => {
  it("preserves all text dimensions, even with quoted commas and newlines", () => {
    const csv = [
      "Date,Package Name,Traffic Source,Search Term,UTM Source,UTM Campaign,Store Listing Visitors,Store Listing Acquisitions,Store Listing Conversion Rate",
      '2026-06-02,com.x,"Google (organic)","okey, online","src,1","camp\nA",500,50,0.1',
    ].join("\r\n");
    const [r] = parseReportRecordsMulti(csv);
    expect(r.dimensions.traffic_source).toBe("Google (organic)");
    expect(r.dimensions.search_term).toBe("okey, online"); // quoted comma preserved
    expect(r.dimensions.utm_source).toBe("src,1");
    expect(r.dimensions.utm_campaign).toBe("camp\nA"); // quoted newline preserved
    expect(r.values.store_listing_visitors).toBe(500);
    expect(r.values.store_listing_acquisitions).toBe(50);
    expect(r.values.store_listing_conversion_rate).toBe(0.1);
  });
});

describe("report discovery candidates", () => {
  it("lists fallback object paths in order, so discovery can fall back when overview is missing", () => {
    const paths = reportCandidatePaths("installs", "com.x", "202606", ["overview", "country", "app_version"]);
    expect(paths[0]).toBe("stats/installs/installs_com.x_202606_overview.csv");
    expect(paths).toContain("stats/installs/installs_com.x_202606_country.csv");
    expect(paths).toContain("stats/installs/installs_com.x_202606_app_version.csv");
    expect(paths.length).toBe(3);
  });
});

describe("ReportError distinguishes failure kinds", () => {
  it("carries a permission kind + a clear message, distinct from not-found wording", () => {
    const perm = new ReportError("permission denied for the reports bucket (grant read access)", "permission");
    expect(perm.kind).toBe("permission");
    expect(perm.message).toMatch(/permission denied/);
    // "not found" is reported as a plain warning string (no ReportError), so the two never collide.
    expect(perm.message).not.toMatch(/not found/);
  });
});
