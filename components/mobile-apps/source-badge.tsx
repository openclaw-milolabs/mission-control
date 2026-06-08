"use client";

/**
 * Explicit data-provenance tag. Every metric on the page should say where it came
 * from so "official live API" is never confused with "delayed CSV export" or a
 * number we computed ourselves.
 *
 * - official-api → live official store endpoint (Apple App Store Connect / iTunes
 *   Lookup / Google Play Reviews API).
 * - csv          → Google Play Console CSV export from the GCS bucket. Delayed
 *   (daily/monthly), NOT live.
 * - derived      → calculated by Mission Control from the above (averages, rates,
 *   approximations). Not a value any store hands us directly.
 */
export type SourceKind = "official-api" | "csv" | "derived";

const META: Record<SourceKind, { label: string; cls: string; title: string }> = {
  "official-api": {
    label: "Official API",
    cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
    title: "Live data from the store's official API.",
  },
  csv: {
    label: "CSV export",
    cls: "bg-amber-500/10 text-amber-700 dark:text-amber-500 border-amber-500/20",
    title: "Downloaded from Google Play Console CSV exports — delayed (daily/monthly), not a live API.",
  },
  derived: {
    label: "Derived",
    cls: "bg-muted text-muted-foreground border-transparent",
    title: "Calculated by Mission Control from the underlying sources — not a value the store returns directly.",
  },
};

export function SourceBadge({
  kind,
  label,
  title,
  className = "",
}: {
  kind: SourceKind;
  /** Override the default text (e.g. "API + CSV", "CSV-derived"). */
  label?: string;
  /** Override the default tooltip with a specific endpoint/source. */
  title?: string;
  className?: string;
}) {
  const m = META[kind];
  return (
    <span
      title={title ?? m.title}
      className={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${m.cls} ${className}`}
    >
      {label ?? m.label}
    </span>
  );
}
