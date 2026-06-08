import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { parse } from "csv-parse";
import { Storage } from "@google-cloud/storage";
import type { GoogleConfig } from "@/lib/mobile-apps/config";
import { loadServiceAccount } from "@/lib/mobile-apps/providers/google-play-client";
import type { RawReview } from "@/lib/mobile-apps/types";

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

export type ReviewCsvFile = {
  kind: "reviews";
  dimension: "monthly";
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

function headerIndex(header: string[], names: string[]): number {
  const normalized = header.map(normalizeKey);
  const candidates = names.map(normalizeKey);
  return normalized.findIndex((h) => candidates.includes(h));
}

function valueAt(cols: string[], header: string[], names: string[]): string | null {
  const idx = headerIndex(header, names);
  const value = idx >= 0 ? cols[idx] : null;
  return value && value.trim() ? value.trim() : null;
}

function isoFromEpochMillis(raw: string | null): string | null {
  if (!raw) return null;
  const n = Number(raw.replace(/[^0-9]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isoFromDateString(raw: string | null): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function extractReviewIdFromLink(link: string | null): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    const qp = url.searchParams.get("reviewId") ?? url.searchParams.get("reviewid") ?? url.searchParams.get("id");
    if (qp) return qp;
  } catch {
    // Some exports can contain a non-URL token. Fall through to regex/hash.
  }
  const m = link.match(/reviewId=([^&\s]+)/i) ?? link.match(/reviewid[/:=]([^&\s]+)/i);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function stableGoogleReviewCsvId(row: Record<string, string | null>): string {
  const link = row.reviewLink ?? null;
  const fromLink = extractReviewIdFromLink(link);
  if (fromLink) return fromLink;
  if (link) return `csv-link:${link}`;
  const payload = JSON.stringify(row);
  return `csv-hash:${createHash("sha1").update(payload).digest("hex")}`;
}

/**
 * Pure: parse the official Google Play Console monthly reviews CSV export.
 *
 * This is different from androidpublisher.reviews.list: the API only returns a
 * recent window, while these bucket files are historical monthly CSVs. The CSV
 * format has changed slightly over the years, so this parser accepts the common
 * header variants documented/observed by Play Console.
 */
export function parseGooglePlayReviewsCsv(text: string): RawReview[] {
  const records = parseCsvRecords(text);
  if (records.length < 2) return [];
  const header = records[0];
  const out: RawReview[] = [];

  for (let r = 1; r < records.length; r++) {
    const cols = records[r];
    const reviewLink = valueAt(cols, header, ["Review Link", "Review URL", "Review Url"]);
    const submitMillis = valueAt(cols, header, ["Review Submit Millis Since Epoch", "Review Submit Millis"]);
    const submitDate = valueAt(cols, header, ["Review Submit Date and Time", "Review Submit Date", "Date"]);
    const replyMillis = valueAt(cols, header, ["Developer Reply Millis Since Epoch", "Developer Reply Millis"]);
    const replyDate = valueAt(cols, header, ["Developer Reply Date and Time", "Developer Reply Date"]);
    const rowForId = {
      reviewLink,
      submitMillis,
      submitDate,
      language: valueAt(cols, header, ["Reviewer Language", "Language"]),
      device: valueAt(cols, header, ["Device"]),
      rating: valueAt(cols, header, ["Star Rating", "Rating"]),
      title: valueAt(cols, header, ["Review Title", "Title"]),
      body: valueAt(cols, header, ["Review Text", "Review", "Body"]),
    };
    const rating = toNumber(rowForId.rating ?? undefined);
    const submittedAt = isoFromEpochMillis(submitMillis) ?? isoFromDateString(submitDate);
    const rawRow: Record<string, string | null> = {};
    for (let c = 0; c < header.length; c++) rawRow[normalizeKey(header[c])] = cols[c] ?? null;

    out.push({
      storeReviewId: stableGoogleReviewCsvId(rowForId),
      author: valueAt(cols, header, ["Author", "Reviewer", "Reviewer Name"]),
      rating: typeof rating === "number" ? Math.round(rating) : null,
      title: rowForId.title,
      body: rowForId.body,
      appVersion: valueAt(cols, header, ["App Version Name", "App Version", "Version Name"]),
      country: valueAt(cols, header, ["Country", "Country/Region", "Region"]),
      submittedAt,
      storeResponse: valueAt(cols, header, ["Developer Reply Text", "Developer Reply", "Reply Text"]),
      language: rowForId.language,
      device: rowForId.device,
      raw: { source: "google_play_console_reviews_csv", replyDate: isoFromEpochMillis(replyMillis) ?? isoFromDateString(replyDate), row: rawRow },
    });
  }
  return out.filter((r) => r.rating != null || r.body || r.title);
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

export function reviewsObjectPath(packageName: string, yyyyMM: string): string {
  return `reviews/reviews_${packageName}_${yyyyMM}.csv`;
}

function reviewsPathMatch(packageName: string, path: string): { yyyyMM: string } | null {
  const re = new RegExp(`^reviews/reviews_${escapeRegExp(packageName)}_(\\d{6})\\.csv$`);
  const m = path.match(re);
  return m ? { yyyyMM: m[1] } : null;
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
    // Bound the scan to the configured lookback window. The bucket can hold YEARS
    // of CSVs; downloading + parsing them all at once is what OOM-kills the server.
    const allowedMonths = new Set(checkedReportMonths(cfg.reportsLookbackMonths));
    return files
      .map((file) => {
        const path = file.name;
        const hit = reportPathMatch(kind, packageName, path);
        if (!hit || !allowed.has(hit.dimension) || !allowedMonths.has(hit.yyyyMM)) return null;
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

/**
 * List every Google Play Console monthly reviews CSV for this package.
 * Path format: reviews/reviews_${packageName}_YYYYMM.csv
 */
export async function listReviewReportFiles(cfg: GoogleConfig, packageName: string): Promise<ReviewCsvFile[]> {
  const bucketName = normalizeBucketName(cfg.reportsBucket);
  if (!bucketName) return [];
  const bucket = reportsBucket(cfg);
  const prefix = `reviews/reviews_${packageName}_`;
  try {
    const [files] = await bucket.getFiles({ prefix });
    // Same lookback bound as the stats reports — never parse the whole history.
    const allowedMonths = new Set(checkedReportMonths(cfg.reportsLookbackMonths));
    return files
      .map((file) => {
        const path = file.name;
        const hit = reviewsPathMatch(packageName, path);
        if (!hit || !allowedMonths.has(hit.yyyyMM)) return null;
        return { kind: "reviews", dimension: "monthly", path, yyyyMM: hit.yyyyMM, ...fileMeta(file) } satisfies ReviewCsvFile;
      })
      .filter((f): f is ReviewCsvFile => Boolean(f))
      .sort((a, b) => b.yyyyMM.localeCompare(a.yyyyMM));
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 403) throw new ReportError(`permission denied for reviews reports bucket ${bucketName} package ${packageName}`, "permission");
    throw new ReportError(
      `could not list reviews reports from bucket ${bucketName} package ${packageName}: ${err instanceof Error ? err.message : String(err)}`,
      "unknown",
    );
  }
}

/** Download one already-listed report object. Read-only. */
export async function downloadReportFile(cfg: GoogleConfig, file: Pick<ReportFile | ReviewCsvFile, "path" | "kind">): Promise<string> {
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

// ── Streaming ingestion (bounded memory) ─────────────────────────────────────
// Large monthly CSVs (esp. the reviews export) must never be fully buffered +
// parsed into arrays — that is what OOM-kills the server. These helpers stream
// rows incrementally so the caller can batch-insert and discard as it goes.

/** Decode a byte stream as UTF-16LE (Google's report encoding) or UTF-8, incrementally. */
function createDecodeTransform(): Transform {
  let decoder: TextDecoder | null = null;
  return new Transform({
    decodeStrings: false,
    transform(chunk: Buffer, _enc, cb) {
      try {
        if (!decoder) {
          const utf16 = chunk.length >= 2 && chunk[0] === 0xff && chunk[1] === 0xfe;
          decoder = new TextDecoder(utf16 ? "utf-16le" : "utf-8");
        }
        cb(null, decoder.decode(chunk, { stream: true }));
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb) {
      try {
        cb(null, decoder ? decoder.decode() : "");
      } catch (e) {
        cb(e as Error);
      }
    },
  });
}

/**
 * Stream a CSV object as header-keyed rows. READ-ONLY (createReadStream).
 * Memory stays flat regardless of file size. Maps GCS errors to ReportError.
 */
export async function* streamCsvRows(cfg: GoogleConfig, objectPath: string): AsyncGenerator<Record<string, string>> {
  const bucketName = normalizeBucketName(cfg.reportsBucket);
  const read = reportsBucket(cfg).file(objectPath).createReadStream();
  const parser = parse({ columns: true, skip_empty_lines: true, trim: true, relax_column_count: true, relax_quotes: true });
  read.on("error", (e) => parser.destroy(e));
  read.pipe(createDecodeTransform()).pipe(parser);
  try {
    for await (const rec of parser) yield rec as Record<string, string>;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 404) throw new ReportError(`report file not found: ${objectPath}`, "missing");
    if (code === 403) throw new ReportError(`permission denied for reports bucket ${bucketName} (tried ${objectPath})`, "permission");
    throw new ReportError(`could not stream report ${objectPath}: ${err instanceof Error ? err.message : String(err)}`, "unknown");
  } finally {
    read.destroy();
  }
}

function rowKeysOrdered(row: Record<string, string>): string[] {
  return Object.keys(row);
}

/** Pure: map one header-keyed row to a single-dimension ReportRecord. */
export function mapReportRecord(row: Record<string, string>): ReportRecord {
  const keys = rowKeysOrdered(row);
  const iDate = keys.findIndex((k) => k.toLowerCase() === "date");
  const iDim = keys.findIndex((k) => DIMENSION_HEADERS.has(k.toLowerCase()));
  const values: Record<string, number | null> = {};
  keys.forEach((k, c) => {
    if (c === iDate || c === iDim || k.toLowerCase() === "package name") return;
    values[normalizeKey(k)] = toNumber(row[k]);
  });
  return {
    date: iDate >= 0 ? row[keys[iDate]] || null : null,
    dimensionValue: (iDim >= 0 ? row[keys[iDim]] || "" : "").toLowerCase(),
    values,
  };
}

/** Pure: map one header-keyed row to a multi-dimension ReportMultiRecord. */
export function mapReportMultiRecord(row: Record<string, string>): ReportMultiRecord {
  const keys = rowKeysOrdered(row);
  const iDate = keys.findIndex((k) => k.toLowerCase() === "date");
  const dimensions: Record<string, string> = {};
  const values: Record<string, number | null> = {};
  keys.forEach((k, c) => {
    const lc = k.toLowerCase();
    if (c === iDate || lc === "package name") return;
    if (DIMENSION_HEADERS.has(lc)) dimensions[normalizeKey(k)] = row[k] ?? "";
    else values[normalizeKey(k)] = toNumber(row[k]);
  });
  return { date: iDate >= 0 ? row[keys[iDate]] || null : null, dimensions, values };
}

function caseInsensitiveGetter(row: Record<string, string>): (names: string[]) => string | null {
  const lc = new Map<string, string>();
  for (const k of Object.keys(row)) lc.set(k.toLowerCase(), k);
  return (names) => {
    for (const n of names) {
      const k = lc.get(n.toLowerCase());
      const v = k != null ? row[k]?.trim() : undefined;
      if (v) return v;
    }
    return null;
  };
}

/**
 * Pure: map one reviews-CSV row to a RawReview. Keeps a SLIM `raw` (source +
 * reply date) — never the whole CSV row, which is the memory killer.
 */
export function mapReviewRecord(row: Record<string, string>): RawReview | null {
  const get = caseInsensitiveGetter(row);
  const reviewLink = get(["Review Link", "Review URL", "Review Url"]);
  const submitMillis = get(["Review Submit Millis Since Epoch", "Review Submit Millis"]);
  const submitDate = get(["Review Submit Date and Time", "Review Submit Date", "Date"]);
  const replyMillis = get(["Developer Reply Millis Since Epoch", "Developer Reply Millis"]);
  const replyDate = get(["Developer Reply Date and Time", "Developer Reply Date"]);
  const ratingRaw = get(["Star Rating", "Rating"]);
  const rating = toNumber(ratingRaw ?? undefined);
  const title = get(["Review Title", "Title"]);
  const body = get(["Review Text", "Review", "Body"]);
  const submittedAt = isoFromEpochMillis(submitMillis) ?? isoFromDateString(submitDate);
  const review: RawReview = {
    storeReviewId: stableGoogleReviewCsvId({
      reviewLink,
      submitMillis,
      submitDate,
      language: get(["Reviewer Language", "Language"]),
      device: get(["Device"]),
      rating: ratingRaw,
      title,
      body,
    }),
    author: get(["Author", "Reviewer", "Reviewer Name"]),
    rating: typeof rating === "number" ? Math.round(rating) : null,
    title,
    body,
    appVersion: get(["App Version Name", "App Version", "Version Name"]),
    country: get(["Country", "Country/Region", "Region"]),
    submittedAt,
    storeResponse: get(["Developer Reply Text", "Developer Reply", "Reply Text"]),
    language: get(["Reviewer Language", "Language"]),
    device: get(["Device"]),
    raw: { source: "google_play_console_reviews_csv", replyDate: isoFromEpochMillis(replyMillis) ?? isoFromDateString(replyDate) },
  };
  return review.rating != null || review.body || review.title ? review : null;
}
