/**
 * Time-window resolver for the Metrics module.
 *
 * Turns a window name (or custom range) into:
 *   - `since`: Date marking the start of the window
 *   - `until`: Date marking the end (now, or user-provided)
 *   - `bucket`: MySQL DATE_FORMAT mask sized to the window
 *
 * Each window's bucket granularity matches its name:
 *   hourly  → hourly buckets over the last 48h
 *   daily   → daily buckets over the last 30 days
 *   weekly  → ISO-week buckets over the last 12 weeks
 *   monthly → calendar-month buckets over the last 12 months
 *   yearly  → year buckets over the last 5 years
 *
 * These are bound as positional `?` params via bindNamedParams in sql-guard.ts.
 */

export type WindowName = "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "custom";

export type ResolvedWindow = {
  window: WindowName;
  since: Date;
  until: Date;
  bucket: string;
};

const DEFAULT_BUCKETS: Record<Exclude<WindowName, "custom">, string> = {
  hourly: "%Y-%m-%d %H:00",
  daily: "%Y-%m-%d",
  weekly: "%x-W%v",
  monthly: "%Y-%m",
  yearly: "%Y",
};

function startOfWindow(window: WindowName, until: Date): Date {
  const d = new Date(until.getTime());
  switch (window) {
    case "hourly":
      d.setHours(d.getHours() - 48);
      return d;
    case "daily":
      d.setDate(d.getDate() - 30);
      return d;
    case "weekly":
      d.setDate(d.getDate() - 7 * 12);
      return d;
    case "monthly":
      d.setMonth(d.getMonth() - 12);
      return d;
    case "yearly":
      d.setFullYear(d.getFullYear() - 5);
      return d;
    case "custom":
      // Caller provides since explicitly; not reached when window === 'custom'
      return d;
  }
}

export function resolveWindow(input: {
  window: WindowName;
  since?: string | Date | null;
  until?: string | Date | null;
  bucket?: string | null;
}): ResolvedWindow {
  const untilParsed = input.until ? new Date(input.until) : new Date();
  const until = Number.isFinite(untilParsed.getTime()) ? untilParsed : new Date();

  let since: Date;
  if (input.window === "custom") {
    const sinceParsed = input.since ? new Date(input.since) : new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000);
    since = Number.isFinite(sinceParsed.getTime()) ? sinceParsed : new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else {
    since = startOfWindow(input.window, until);
  }

  let bucket = input.bucket && input.bucket.trim() ? input.bucket.trim() : "";
  if (!bucket) {
    if (input.window === "custom") {
      // Pick a sensible default for the span.
      const days = Math.max(1, Math.round((until.getTime() - since.getTime()) / 86_400_000));
      if (days <= 2) bucket = "%Y-%m-%d %H:00";
      else if (days <= 90) bucket = "%Y-%m-%d";
      else if (days <= 730) bucket = "%Y-%m";
      else bucket = "%Y";
    } else {
      bucket = DEFAULT_BUCKETS[input.window];
    }
  }

  return { window: input.window, since, until, bucket };
}

export function isValidWindow(value: unknown): value is WindowName {
  return value === "hourly" || value === "daily" || value === "weekly" || value === "monthly" || value === "yearly" || value === "custom";
}

/**
 * Does this metric's SQL actually respond to the window controls?
 *
 * A query is "windowed" when it references at least one of the window
 * placeholders — `:since`, `:until`, or `:bucket`. Queries that reference none
 * of them (e.g. a lifetime breakdown) produce identical results regardless of
 * the selected window, so the UI hides the Hour/Day/Week/Month/Year pills for
 * them. Matched as `:word` so `created_at` or `::cast` never trip it.
 */
export function usesWindow(sql: string): boolean {
  return /(?<![:\w]):(?:since|until|bucket)\b/i.test(sql);
}

/**
 * Does this metric actually bucket BY TIME?
 *
 * Only queries that reference `:bucket` are genuine time series, where the
 * Hour/Day/Week/Month/Year *granularity* is meaningful (it picks the DATE_FORMAT
 * mask). A query that uses `:since`/`:until` but NO `:bucket` is a windowed
 * snapshot — e.g. a category donut grouped by platform. For those, granularity
 * does nothing; only the lookback length matters, so the UI shows a single range
 * selector instead of granularity pills. Matched as `:word` so `::cast` / column
 * names never trip it.
 */
export function usesBucket(sql: string): boolean {
  return /(?<![:\w]):bucket\b/i.test(sql);
}

/**
 * Human-readable summary of a resolved window for card UI:
 *   "Last 48 hours · hourly"
 *   "Last 12 weeks · weekly"
 *   "Last 12 months · monthly"
 *   "Last 5 years · yearly"
 */
export function describeWindow(window: WindowName): { range: string; granularity: string } {
  switch (window) {
    case "hourly":
      return { range: "Last 48 hours", granularity: "hourly" };
    case "daily":
      return { range: "Last 30 days", granularity: "daily" };
    case "weekly":
      return { range: "Last 12 weeks", granularity: "weekly" };
    case "monthly":
      return { range: "Last 12 months", granularity: "monthly" };
    case "yearly":
      return { range: "Last 5 years", granularity: "yearly" };
    case "custom":
      return { range: "Custom range", granularity: "custom" };
  }
}
