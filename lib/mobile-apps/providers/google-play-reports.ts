import { Storage } from "@google-cloud/storage";
import type { GoogleConfig } from "@/lib/mobile-apps/config";
import { loadServiceAccount } from "@/lib/mobile-apps/providers/google-play-client";

export type CountryRating = { territory: string; avg: number | null; asOf: string | null };

/** Single-dimension report row (installs/crashes/store_performance country). */
export type ReportRecord = { date: string | null; dimensionValue: string; values: Record<string, number | null> };

/** Multi-dimension report row (store_performance traffic_source: source + search term + utm…). */
export type ReportMultiRecord = {
  date: string | null;
  dimensions: Record<string, string>;
  values: Record<string, number | null>;
};

export type ReportKind = "installs" | "crashes" | "ratings" | "store_performance";

export type ReportFile = {
  kind: ReportKind;
  dimension: string;
  yyyyMM: string;
  path: string;
  generation: string | null;
  sizeBytes: number | null;
  updated: string | null;
};

/**
 * READ-ONLY scope so the Storage client can never mutate the bucket. This module
 * only ever LISTS/DOWNLOADS CSVs from Google Play Console's existing
 * `pubsite_prod_rev_...` bucket. It never uploads, creates buckets, copies report
 * files back, or touches BigQuery.
 */
export const STORAGE_READONLY_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";

export const RATINGS_DIMENSIONS = ["country"] as const;
export const INSTALLS_DIMENSIONS = ["overview", "country", "app_version", "carrier", "device", "language", "os_version"] as const;
export const CRASHES_DIMENSIONS = ["overview", "app_version", "device", "os_version"] as const;
export const STORE_PERFORMANCE_COUNTRY_DIMENSIONS = ["country"] as const;
export const STORE_PERFORMANCE_TRAFFIC_SOURCE_DIMENSIONS = ["traffic_source"] as const;
export const ALL_REPORT_DIMENSIONS = {
  installs: INSTALLS_DIMENSIONS,
  crashes: CRASHES_DIMENSIONS,
  ratings: RATINGS_DIMENSIONS,
  store_performance: [...STORE_PERFORMANCE_COUNTRY_DIMENSIONS, ...STORE_PERFORMANCE_TRAFFIC_SOURCE_DIMENSIONS],
} as const;

// Header names that are breakdown dimensions (string), not numeric metrics.
const DIMENSION_HEADERS = new Set([
  "country", "country/region", "region", "app version", "device", "os version", "android os version",
  "language", "carrier", "tablets", "traffic source", "search term", "utm source", "utm campaign",
]);

function stripBom(text: string): string {
  return (text || "").replace(/^﻿/, "");
}

function normalizeKey(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function toNumber(raw: string | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw.replace(/[%,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * UI/helper: Google Store Listing Conversion Rate is usually exported as a
 * decimal (0.264 = 26.4%). Some CSVs/tools may include a percent-looking value
 * already (4.00% parses to 4), so values > 1 are treated as already-percent.
 */
export function formatStoreListingConversionRate(raw: number | null | undefined): string {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return "—";
  const pct = raw <= 1 ? raw * 100 : raw;
  const rounded = Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

/**
 * Pure: tokenize CSV text into rows, correctly handling quoted fields that
 * contain commas, embedded newlines, and escaped double-quotes.
 */
export function parseCsvRecords(text: string): string[][] {
  const s = stripBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch === "\r") {
      if (s[i + 1] !== "\n") pushRow();
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c.length > 0));
}

/** Pure: single-dimension parse — Date + one breakdown column + numeric metrics. */
export function parseReportCsv(text: string): ReportRecord[] {
  const records = parseCsvRecords(text);
  if (records.length < 2) return [];
  const header = records[0];
  const lower = header.map((h) => h.toLowerCase());
  const iDate = lower.indexOf("date");
  const iDim = lower.findIndex((h) => DIMENSION_HEADERS.has(h));
  const iPkg = lower.indexOf("package name");
  const out: ReportRecord[] = [];
  for (let r = 1; r < records.length; r++) {
    const cols = records[r];
    const values: Record<string, number | null> = {};
    for (let c = 0; c < header.length; c++) {
      if (c === iDate || c === iDim || c === iPkg) continue;
      values[normalizeKey(header[c])] = toNumber(cols[c]);
    }
    out.push({ date: iDate >= 0 ? cols[iDate] || null : null, dimensionValue: (iDim >= 0 ? cols[iDim] || "" : "").toLowerCase(), values });
  }
  return out;
}

/**
 * Pure: multi-dimension parse — keeps ALL breakdown columns (traffic source,
 * search term, utm source/campaign, …) as string dimensions, plus numeric
 * metrics. Used for Store Performance traffic_source.
 */
export function parseReportRecordsMulti(text: string): ReportMultiRecord[] {
  const records = parseCsvRecords(text);
  if (records.length < 2) return [];
  const header = records[0];
  const lower = header.map((h) => h.toLowerCase());
  const iDate = lower.indexOf("date");
  const iPkg = lower.indexOf("package name");
  const out: ReportMultiRecord[] = [];
  for (let r = 1; r < records.length; r++) {
    const cols = records[r];
    const dimensions: Record<string, string> = {};
    const values: Record<string, number | null> = {};
    for (let c = 0; c < header.length; c++) {
      if (c === iDate || c === iPkg) continue;
      const key = normalizeKey(header[c]);
      if (DIMENSION_HEADERS.has(lower[c])) dimensions[key] = cols[c] ?? "";
      else values[key] = toNumber(cols[c]);
    }
    out.push({ date: iDate >= 0 ? cols[iDate] || null : null, dimensions, values });
  }
  return out;
}

/** Object path of a monthly Play Console report inside the developer's GCS bucket. */
export function reportObjectPath(kind: ReportKind, packageName: string, yyyyMM: string, dimension: string): string {
  return `stats/${kind}/${kind}_${packageName}_${yyyyMM}_${dimension}.csv`;
}

/** All candidate object paths for a report month, across the preferred dimensions. */
export function reportCandidatePaths(kind: ReportKind, packageName: string, yyyyMM: string, dimensions: readonly string[]): string[] {
  return dimensions.map((d) => reportObjectPath(kind, packageName, yyyyMM, d));
}

/** Accept a bucket id, a gs:// URI, or a full gs:// path; return just the bucket id. */
export function normalizeBucketName(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/^gs:\/\//i, "").split("/")[0].trim();
}

/** The exact report months checked, newest first. */
export function checkedReportMonths(lookbackMonths: number, now = new Date()): string[] {
  const count = Math.min(Math.max(Number.isFinite(lookbackMonths) ? lookbackMonths : 3, 1), 12);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

/** Admin-safe warning for a missing report; no credentials/key material included. */
export function reportNotFoundWarning(
  label: string,
  cfg: Pick<GoogleConfig, "reportsBucket" | "reportsLookbackMonths">,
  packageName: string,
  dimensions: readonly string[],
): string {
  const bucket = normalizeBucketName(cfg.reportsBucket) || "not configured";
  return `No ${label} CSV reports found in bucket ${bucket} for package ${packageName} across dimensions ${dimensions.join(",")}. The sync scans all available years/months returned by Google Play Console.`;
}

/** Pure: the latest Total Average Rating per country from a ratings report. */
export function parseRatingsCsv(text: string): CountryRating[] {
  const records = parseCsvRecords(text);
  if (records.length < 2) return [];
  const header = records[0].map((h) => h.toLowerCase());
  const iCountry = header.indexOf("country");
  const iTotal = header.indexOf("total average rating");
  const iDate = header.indexOf("date");
  if (iCountry === -1 || iTotal === -1) return [];
  const latest = new Map<string, { avg: number | null; asOf: string | null }>();
  for (let r = 1; r < records.length; r++) {
    const cols = records[r];
    const country = (cols[iCountry] || "").toLowerCase();
    if (!country) continue;
    const asOf = iDate >= 0 ? cols[iDate] || null : null;
    const avg = toNumber(cols[iTotal]);
    const prev = latest.get(country);
    if (!prev || (asOf ?? "") >= (prev.asOf ?? "")) latest.set(country, { avg, asOf });
  }
  return [...latest.entries()].map(([territory, v]) => ({ territory, avg: v.avg, asOf: v.asOf }));
}

/** Google Play reports are UTF-16LE with a BOM; fall back to UTF-8. */
function decodeReportBuffer(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  return buf.toString("utf8");
}

function reportsBucket(cfg: GoogleConfig) {
  const credentials = loadServiceAccount(cfg);
  const storage = new Storage({
    credentials: credentials as Record<string, string>,
    projectId: typeof credentials.project_id === "string" ? credentials.project_id : undefined,
    scopes: [STORAGE_READONLY_SCOPE],
  });
  return storage.bucket(normalizeBucketName(cfg.reportsBucket));
}


function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function reportPathMatch(kind: ReportKind, packageName: string, path: string): { yyyyMM: string; dimension: string } | null {
  const re = new RegExp(`^stats/${kind}/${kind}_${escapeRegExp(packageName)}_(\\d{6})_(.+)\\.csv$`);
  const m = path.match(re);
  return m ? { yyyyMM: m[1], dimension: m[2] } : null;
}

function fileMeta(file: { name?: string; metadata?: Record<string, unknown> }): Pick<ReportFile, "generation" | "sizeBytes" | "updated"> {
  const md = file.metadata ?? {};
  const sizeRaw = md.size;
  const sizeBytes = typeof sizeRaw === "number" ? sizeRaw : typeof sizeRaw === "string" ? Number(sizeRaw) : null;
  return {
    generation: typeof md.generation === "string" ? md.generation : null,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
    updated: typeof md.updated === "string" ? md.updated : null,
  };
}

/**
 * List every Play Console CSV for a package/report across all available years.
 * This is read-only: it only uses GCS list metadata, never upload/write APIs.
 */
export async function listReportFiles(
  cfg: GoogleConfig,
  kind: ReportKind,
  packageName: string,
  dimensions: readonly string[],
): Promise<ReportFile[]> {
  const bucketName = normalizeBucketName(cfg.reportsBucket);
  if (!bucketName) return [];
  const bucket = reportsBucket(cfg);
  const prefix = `stats/${kind}/${kind}_${packageName}_`;
  try {
    const [files] = await bucket.getFiles({ prefix });
    const allowed = new Set(dimensions);
    return files
      .map((file) => {
        const path = file.name;
        const hit = reportPathMatch(kind, packageName, path);
        if (!hit || !allowed.has(hit.dimension)) return null;
        return { kind, path, yyyyMM: hit.yyyyMM, dimension: hit.dimension, ...fileMeta(file) } satisfies ReportFile;
      })
      .filter((f): f is ReportFile => Boolean(f))
      .sort((a, b) => (a.yyyyMM === b.yyyyMM ? a.dimension.localeCompare(b.dimension) : b.yyyyMM.localeCompare(a.yyyyMM)));
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 403) throw new ReportError(`permission denied for reports bucket ${bucketName} package ${packageName}`, "permission");
    throw new ReportError(
      `could not list ${kind} reports from bucket ${bucketName} package ${packageName}: ${err instanceof Error ? err.message : String(err)}`,
      "unknown",
    );
  }
}

/** Download one already-listed report object. Read-only. */
export async function downloadReportFile(cfg: GoogleConfig, file: Pick<ReportFile, "path" | "kind">): Promise<string> {
  const bucketName = normalizeBucketName(cfg.reportsBucket);
  if (!bucketName) throw new ReportError("reports bucket is not configured", "missing");
  try {
    const [buf] = await reportsBucket(cfg).file(file.path).download();
    return decodeReportBuffer(buf);
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 404) throw new ReportError(`report file not found: ${file.path}`, "missing");
    if (code === 403) throw new ReportError(`permission denied for reports bucket ${bucketName} (tried ${file.path})`, "permission");
    throw new ReportError(
      `could not download ${file.kind} report ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
      "unknown",
    );
  }
}

/** Raised when a report can't be read (vs simply not existing yet). */
export class ReportError extends Error {
  constructor(message: string, readonly kind: "permission" | "missing" | "parse" | "unknown") {
    super(message);
    this.name = "ReportError";
  }
}

/**
 * Find + download the most recent report, trying each preferred dimension within
 * each month (most-recent month first). Returns the text + the dimension that hit,
 * or null if nothing exists in the window (attempted paths are logged). Throws
 * ReportError on permission/credential failures.
 */
export async function downloadLatestReport(
  cfg: GoogleConfig,
  kind: ReportKind,
  packageName: string,
  dimensions: readonly string[],
): Promise<{ text: string; yyyyMM: string; dimension: string } | null> {
  const bucketName = normalizeBucketName(cfg.reportsBucket);
  if (!bucketName) return null;
  const bucket = reportsBucket(cfg);
  const attempted: string[] = [];
  for (const yyyyMM of checkedReportMonths(cfg.reportsLookbackMonths)) {
    for (const dimension of dimensions) {
      const path = reportObjectPath(kind, packageName, yyyyMM, dimension);
      attempted.push(path);
      try {
        const [buf] = await bucket.file(path).download();
        return { text: decodeReportBuffer(buf), yyyyMM, dimension };
      } catch (err) {
        const code = (err as { code?: number }).code;
        if (code === 404) continue;
        if (code === 403)
          throw new ReportError(
            `permission denied for reports bucket ${bucketName} package ${packageName} (tried ${path})`,
            "permission",
          );
        throw new ReportError(
          `could not read ${kind} report from bucket ${bucketName} package ${packageName}: ${err instanceof Error ? err.message : String(err)}`,
          "unknown",
        );
      }
    }
  }
  // Server-side log of the attempted object paths for debugging. No credentials included.
  console.warn(
    `[mobile-apps] no ${kind} report found in bucket ${bucketName} for package ${packageName}. Tried: ${attempted.join(", ")}`,
  );
  return null;
}

/** Official per-country average ratings from the Play Console ratings report. */
export async function fetchGooglePlayCountryRatings(
  cfg: GoogleConfig,
  packageName: string,
): Promise<{ territories: CountryRating[]; asOf: string | null } | null> {
  // Ratings averages are only meaningful in the country file.
  const dl = await downloadLatestReport(cfg, "ratings", packageName, RATINGS_DIMENSIONS);
  if (!dl) return null;
  const territories = parseRatingsCsv(dl.text);
  if (territories.length === 0) return null;
  const asOf = territories.map((t) => t.asOf).filter(Boolean).sort().at(-1) ?? null;
  return { territories, asOf };
}

/** Single-dimension report fetch (installs / crashes / store_performance country). */
export async function fetchSingleReport(
  cfg: GoogleConfig,
  kind: ReportKind,
  packageName: string,
  dimensions: readonly string[],
): Promise<{ records: ReportRecord[]; dimension: string } | null> {
  const dl = await downloadLatestReport(cfg, kind, packageName, dimensions);
  return dl ? { records: parseReportCsv(dl.text), dimension: dl.dimension } : null;
}

export const fetchInstalls = (cfg: GoogleConfig, packageName: string) =>
  fetchSingleReport(cfg, "installs", packageName, INSTALLS_DIMENSIONS);

export const fetchCrashes = (cfg: GoogleConfig, packageName: string) =>
  fetchSingleReport(cfg, "crashes", packageName, CRASHES_DIMENSIONS);

export const fetchStorePerformanceCountry = (cfg: GoogleConfig, packageName: string) =>
  fetchSingleReport(cfg, "store_performance", packageName, STORE_PERFORMANCE_COUNTRY_DIMENSIONS);

/** Multi-dimension Store Performance traffic-source fetch (source/search term/utm…). */
export async function fetchStorePerformanceTrafficSource(
  cfg: GoogleConfig,
  packageName: string,
): Promise<{ records: ReportMultiRecord[]; dimension: string } | null> {
  const dl = await downloadLatestReport(cfg, "store_performance", packageName, STORE_PERFORMANCE_TRAFFIC_SOURCE_DIMENSIONS);
  return dl ? { records: parseReportRecordsMulti(dl.text), dimension: "traffic_source" } : null;
}
