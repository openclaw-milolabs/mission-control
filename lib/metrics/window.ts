/**
 * Time-window resolver for the Metrics module.
 *
 * Turns a window name (or custom range) into:
 *   - `since`: Date marking the start of the window
 *   - `until`: Date marking the end (now, or user-provided)
 *   - `bucket`: MySQL DATE_FORMAT mask sized to the window
 *
 * These are bound as positional `?` params via bindNamedParams in sql-guard.ts.
 */

export type WindowName = "daily" | "weekly" | "monthly" | "yearly" | "custom";

export type ResolvedWindow = {
  window: WindowName;
  since: Date;
  until: Date;
  bucket: string;
};

const DEFAULT_BUCKETS: Record<Exclude<WindowName, "custom">, string> = {
  daily: "%Y-%m-%d %H:00",
  weekly: "%Y-%m-%d",
  monthly: "%Y-%m-%d",
  yearly: "%Y-%m",
};

function startOfWindow(window: WindowName, until: Date): Date {
  const d = new Date(until.getTime());
  switch (window) {
    case "daily":
      d.setDate(d.getDate() - 1);
      return d;
    case "weekly":
      d.setDate(d.getDate() - 7);
      return d;
    case "monthly":
      d.setDate(d.getDate() - 30);
      return d;
    case "yearly":
      d.setFullYear(d.getFullYear() - 1);
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
      else bucket = "%Y-%m";
    } else {
      bucket = DEFAULT_BUCKETS[input.window];
    }
  }

  return { window: input.window, since, until, bucket };
}

export function isValidWindow(value: unknown): value is WindowName {
  return value === "daily" || value === "weekly" || value === "monthly" || value === "yearly" || value === "custom";
}
