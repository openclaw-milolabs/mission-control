/**
 * Period-over-period delta for time-series metrics.
 *
 * Computes the change between the last two **complete** buckets — never the raw
 * last two. On the backup DB the most recent bucket(s) haven't synced yet, so a
 * naive "latest minus previous" reads a fake drop. We use the data-freshness
 * timestamp `asOf` to exclude any bucket whose period isn't fully in the past,
 * then diff the two newest survivors. Pure + framework-free so it's unit-tested.
 */

import type { WindowName } from "@/lib/metrics/window";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Parse a raw DB datetime string ("YYYY-MM-DD HH:MM:SS") as local wall-clock. */
export function parseDbDateTime(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

/** Monday of an ISO-8601 week (MySQL %x-W%v). */
function isoWeekStart(isoYear: number, isoWeek: number): Date {
  const jan4 = new Date(isoYear, 0, 4);
  const jan4Dow = (jan4.getDay() + 6) % 7; // 0 = Monday
  const week1Monday = new Date(jan4.getTime());
  week1Monday.setDate(jan4.getDate() - jan4Dow);
  const d = new Date(week1Monday.getTime());
  d.setDate(week1Monday.getDate() + (isoWeek - 1) * 7);
  return d;
}

/** Parse a bucket label into its start instant, per the window's DATE_FORMAT. */
export function parseBucketStart(label: string, window: WindowName): Date | null {
  const s = String(label ?? "").trim();
  switch (window) {
    case "hourly": {
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2})/);
      return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4]) : null;
    }
    case "daily": {
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
    }
    case "weekly": {
      const m = s.match(/^(\d{4})-W(\d{2})$/);
      return m ? isoWeekStart(+m[1], +m[2]) : null;
    }
    case "monthly": {
      const m = s.match(/^(\d{4})-(\d{2})$/);
      return m ? new Date(+m[1], +m[2] - 1, 1) : null;
    }
    case "yearly": {
      const m = s.match(/^(\d{4})$/);
      return m ? new Date(+m[1], 0, 1) : null;
    }
    default:
      return null;
  }
}

/** End instant (exclusive) of a bucket that starts at `start`. */
export function bucketEnd(start: Date, window: WindowName): Date {
  const d = new Date(start.getTime());
  switch (window) {
    case "hourly": d.setHours(d.getHours() + 1); break;
    case "daily": d.setDate(d.getDate() + 1); break;
    case "weekly": d.setDate(d.getDate() + 7); break;
    case "monthly": d.setMonth(d.getMonth() + 1); break;
    case "yearly": d.setFullYear(d.getFullYear() + 1); break;
    default: break;
  }
  return d;
}

/** Short, human bucket label for the delta chip ("14:00", "8 Jun", "W23", "Jun '26", "2026"). */
export function formatBucketLabel(label: string, window: WindowName): string {
  const s = String(label ?? "").trim();
  if (window === "hourly") {
    const m = s.match(/(\d{2}):\d{2}\s*$/);
    return m ? `${m[1]}:00` : s;
  }
  if (window === "daily") {
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${+m[3]} ${MONTHS[+m[2] - 1]}` : s;
  }
  if (window === "weekly") {
    const m = s.match(/^(\d{4})-W(\d{2})$/);
    return m ? `W${+m[2]}` : s;
  }
  if (window === "monthly") {
    const m = s.match(/^(\d{4})-(\d{2})$/);
    return m ? `${MONTHS[+m[2] - 1]} '${s.slice(2, 4)}` : s;
  }
  return s;
}

export type BucketDelta = {
  current: number;
  previous: number;
  delta: number;
  currentLabel: string;
  previousLabel: string;
  /** How many trailing buckets were excluded as incomplete (not-yet-synced/in-progress). */
  excluded: number;
};

/**
 * Delta between the last two complete buckets for `yColumn`.
 *
 * - With `asOf`: a bucket counts only if its whole period ended at/before `asOf`.
 * - Without `asOf`: conservatively drop the single final (in-progress) bucket.
 * Returns null when there aren't two complete buckets to compare.
 */
export function computeBucketDelta(opts: {
  rows: Array<Record<string, unknown>>;
  xColumn: string;
  yColumn: string;
  window: WindowName;
  asOf: Date | null;
}): BucketDelta | null {
  const { rows, xColumn, yColumn, window, asOf } = opts;
  if (!Array.isArray(rows) || rows.length < 2) return null;

  const parsed = rows
    .map((r) => ({ label: String(r[xColumn] ?? ""), start: parseBucketStart(String(r[xColumn] ?? ""), window), value: toNum(r[yColumn]) }))
    .filter((p): p is { label: string; start: Date; value: number } => p.start != null)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  if (parsed.length < 2) return null;

  let complete: typeof parsed;
  if (asOf) {
    complete = parsed.filter((p) => bucketEnd(p.start, window).getTime() <= asOf.getTime());
  } else {
    complete = parsed.slice(0, -1);
  }
  if (complete.length < 2) return null;

  const cur = complete[complete.length - 1];
  const prev = complete[complete.length - 2];
  return {
    current: cur.value,
    previous: prev.value,
    delta: cur.value - prev.value,
    currentLabel: cur.label,
    previousLabel: prev.label,
    excluded: parsed.length - complete.length,
  };
}
