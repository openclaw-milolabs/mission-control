"use client";

import { useMemo, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import {
  IconBrandGooglePlay,
  IconDownload,
  IconBug,
  IconTrendingUp,
  IconRefresh,
  IconDatabase,
  IconDeviceMobile,
  IconWorld,
  IconChevronDown,
} from "@tabler/icons-react";
import { SourceBadge } from "@/components/mobile-apps/source-badge";

export type ReportPoint = { date: string; metrics: unknown; source?: string | null };
export type TrafficSource = { dimensions: unknown; metrics: unknown };
export type ReportFileRow = {
  report: string;
  dimension: string;
  object_path: string;
  yyyy_mm: string | null;
  size_bytes: number | string | null;
  downloaded_at: string | null;
  rows_count: number | string | null;
  status: string | null;
  error_message?: string | null;
};
export type ReportBreakdown = {
  report: string;
  dimension: string;
  dimension_value: string;
  date: string;
  metrics: unknown;
  dimensions?: unknown;
};
export type ReportFreshness = {
  status: string;
  latestOfficialMonth: string | null;
  latestProcessedMonth: string | null;
  processedAt: string | null;
  checkedAt: string | null;
};

function fmtMonth(yyyymm: string | null): string {
  if (!yyyymm || yyyymm.length !== 6) return yyyymm ?? "—";
  return `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}`;
}

/**
 * Freshness pill: tells the user whether the Google reports shown are up to date,
 * being refreshed, behind, or failed — so last-processed charts are never mistaken
 * for the very latest. Maps the API's freshness.googleReports.status.
 */
function FreshnessBadge({ freshness }: { freshness: ReportFreshness }) {
  const { status } = freshness;
  const map: Record<string, { label: string; cls: string; pulse?: boolean }> = {
    fresh: { label: "Up to date", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
    refreshing: { label: "Refreshing…", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400", pulse: true },
    stale: { label: "Update available", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
    failed: { label: "Refresh failed", cls: "bg-red-500/10 text-red-600 dark:text-red-400" },
    not_configured: { label: "Not configured", cls: "bg-muted text-muted-foreground" },
    unknown: { label: "Checking…", cls: "bg-muted text-muted-foreground" },
  };
  const m = map[status] ?? map.unknown;
  const months =
    freshness.latestOfficialMonth || freshness.latestProcessedMonth
      ? `official ${fmtMonth(freshness.latestOfficialMonth)} · processed ${fmtMonth(freshness.latestProcessedMonth)}`
      : null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${m.cls}`}
      title={months ? `Google Play reports — ${months}${freshness.processedAt ? ` · processed at ${freshness.processedAt}` : ""}` : "Google Play report freshness"}
    >
      <span className={`size-1.5 rounded-full bg-current ${m.pulse ? "animate-pulse" : ""}`} />
      {m.label}
      {months ? <span className="font-normal opacity-70">· {months}</span> : null}
    </span>
  );
}

type Metrics = Record<string, number | null>;
type Dims = Record<string, string>;

function asDims(v: unknown): Dims {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Dims;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" ? (p as Dims) : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Google's conversion rate may be a fraction (0.1 = 10%) or already a percent. */
function formatConversion(raw: number | null): string {
  if (raw == null) return "—";
  const pct = raw <= 1 ? raw * 100 : raw;
  return `${pct.toFixed(1)}%`;
}

/** jsonb may arrive as an object or a JSON string depending on the driver. */
function asMetrics(v: unknown): Metrics {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Metrics;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" ? (p as Metrics) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function pick(m: Metrics, ...keys: string[]): number | null {
  for (const k of keys) if (typeof m[k] === "number") return m[k] as number;
  return null;
}

function fmtChartDate(day: string): string {
  const normalized = String(day ?? "").trim();
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;

  const d = new Date(normalized);
  return Number.isNaN(d.getTime())
    ? normalized
    : d.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });
}

function formatBytes(raw: number | string | null): string {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (!n || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / 1024 / 102.4) / 10} MB`;
}

function nice(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function MiniArea({
  data,
  series,
}: {
  data: Array<Record<string, number | string | null>>;
  series: { key: string; color: string }[];
}) {
  if (data.length < 2) {
    return <div className="flex h-24 items-center justify-center text-xs text-muted-foreground/60">Not enough data yet</div>;
  }
  return (
    <div className="h-24">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 2, bottom: 0, left: 2 }}>
          <XAxis dataKey="date" tickFormatter={fmtChartDate} tickLine={false} axisLine={false} minTickGap={56} tick={{ fontSize: 9, fill: "var(--muted-foreground)" }} />
          <Tooltip
            contentStyle={{ borderRadius: 10, border: "1px solid var(--border)", background: "var(--popover)", fontSize: 11 }}
            labelFormatter={(l) => fmtChartDate(String(l))}
          />
          {series.map((s) => (
            <Area key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={1.75} fill={s.color} fillOpacity={0.12} dot={false} isAnimationActive={false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function metricSummary(report: string, metrics: Metrics): string {
  if (report === "ratings") {
    const rating = pick(metrics, "total_average_rating", "daily_average_rating");
    return rating != null ? rating.toFixed(2) : "—";
  }
  if (report === "installs") {
    const active = pick(metrics, "active_device_installs", "current_device_installs", "total_user_installs");
    const daily = pick(metrics, "daily_device_installs", "daily_user_installs");
    return `${active != null ? active.toLocaleString() : "—"} active · ${daily != null ? daily.toLocaleString() : "—"} daily`;
  }
  if (report === "crashes") {
    return `${pick(metrics, "daily_crashes")?.toLocaleString() ?? "—"} crashes · ${pick(metrics, "daily_anrs")?.toLocaleString() ?? "—"} ANRs`;
  }
  const acq = pick(metrics, "store_listing_acquisitions");
  const visitors = pick(metrics, "store_listing_visitors");
  const conv = pick(metrics, "store_listing_conversion_rate");
  return `${acq?.toLocaleString() ?? "—"} acq · ${visitors?.toLocaleString() ?? "—"} visitors · ${formatConversion(conv)}`;
}

function labelForBreakdown(row: ReportBreakdown): string {
  const dims = asDims(row.dimensions);
  return dims.traffic_source || dims.search_term || dims.utm_source || dims.utm_campaign || row.dimension_value || "overview";
}

function groupFiles(files: ReportFileRow[]) {
  const out = new Map<string, Map<string, ReportFileRow[]>>();
  for (const f of files) {
    const ym = f.yyyy_mm ?? "unknown";
    const year = ym.length >= 4 ? ym.slice(0, 4) : "unknown";
    const month = ym.length >= 6 ? ym.slice(4, 6) : "unknown";
    const months = out.get(year) ?? new Map<string, ReportFileRow[]>();
    months.set(month, [...(months.get(month) ?? []), f]);
    out.set(year, months);
  }
  return [...out.entries()].sort(([a], [b]) => b.localeCompare(a));
}

export function PlayReportsCard({
  installs = [],
  crashes = [],
  storePerformance = [],
  trafficSources = [],
  files = [],
  breakdowns = [],
  onRefresh,
  refreshing = false,
  freshness = null,
}: {
  installs?: ReportPoint[];
  crashes?: ReportPoint[];
  storePerformance?: ReportPoint[];
  trafficSources?: TrafficSource[];
  files?: ReportFileRow[];
  breakdowns?: ReportBreakdown[];
  onRefresh?: () => void;
  refreshing?: boolean;
  freshness?: ReportFreshness | null;
}) {
  const installData = useMemo(
    () =>
      installs.map((p) => {
        const m = asMetrics(p.metrics);
        return {
          date: p.date,
          installs: pick(m, "daily_device_installs", "daily_user_installs"),
          uninstalls: pick(m, "daily_device_uninstalls", "daily_user_uninstalls"),
        };
      }),
    [installs],
  );
  const crashData = useMemo(
    () =>
      crashes.map((p) => {
        const m = asMetrics(p.metrics);
        return { date: p.date, crashes: pick(m, "daily_crashes"), anrs: pick(m, "daily_anrs") };
      }),
    [crashes],
  );

  const lastInstall = installs.length ? asMetrics(installs[installs.length - 1].metrics) : {};
  const activeInstalls = pick(lastInstall, "active_device_installs", "current_device_installs", "total_user_installs");
  const dailyInstalls = pick(lastInstall, "daily_device_installs", "daily_user_installs");
  const dailyUninstalls = pick(lastInstall, "daily_device_uninstalls", "daily_user_uninstalls");
  const uninstallRate = dailyInstalls && dailyUninstalls != null ? (dailyUninstalls / dailyInstalls) * 100 : null;
  const lastCrash = crashes.length ? asMetrics(crashes[crashes.length - 1].metrics) : {};
  const dailyCrashes = pick(lastCrash, "daily_crashes");
  const dailyAnrs = pick(lastCrash, "daily_anrs");
  // Approximate stability rate: report APIs give counts, not Google's official
  // vitals rate. crashes ÷ active installs × 1000 is a useful proxy, clearly labeled.
  const crashesPer1k = activeInstalls && dailyCrashes != null ? (dailyCrashes / activeInstalls) * 1000 : null;

  const spData = useMemo(
    () =>
      storePerformance.map((p) => {
        const m = asMetrics(p.metrics);
        const v = pick(m, "store_listing_visitors");
        const a = pick(m, "store_listing_acquisitions");
        return { date: p.date, visitors: v, conversion: v && a != null ? (a / v) * 100 : null };
      }),
    [storePerformance],
  );
  const lastSp = storePerformance.length ? asMetrics(storePerformance[storePerformance.length - 1].metrics) : {};
  const spVisitors = pick(lastSp, "store_listing_visitors");
  const spAcq = pick(lastSp, "store_listing_acquisitions");
  const conversion = spVisitors && spAcq != null ? (spAcq / spVisitors) * 100 : null;

  const groupedBreakdowns = useMemo(() => {
    const map = new Map<string, ReportBreakdown[]>();
    for (const b of breakdowns) map.set(`${b.report}:${b.dimension}`, [...(map.get(`${b.report}:${b.dimension}`) ?? []), b]);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [breakdowns]);

  const groupedFiles = useMemo(() => groupFiles(files), [files]);
  const [open, setOpen] = useState(false);

  const hasData =
    installs.length > 0 || crashes.length > 0 || storePerformance.length > 0 || trafficSources.length > 0 || files.length > 0;
  // Render even with no data when reports are actively being worked on, so the user
  // sees "Refreshing…" instead of an empty void. Stay hidden only when there is
  // nothing to show and nothing happening.
  const activeStatus = freshness && ["refreshing", "stale", "failed"].includes(freshness.status);
  if (!hasData && !activeStatus) return null;

  return (
    <section className="w-full rounded-2xl border bg-card p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold">
            <IconBrandGooglePlay className="size-4" />
            Google Play Console reports
            <SourceBadge kind="csv" title="All figures here come from Google Play Console CSV exports in your GCS bucket — delayed (daily/monthly), not a live API." />
            {freshness ? <FreshnessBadge freshness={freshness} /> : null}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Downloaded from official Play Console CSV exports. Refresh re-lists the bucket and downloads changed/missing files, including monthly reviews CSVs.
          </p>
          {freshness && freshness.status === "refreshing" && hasData ? (
            <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-400">
              Showing the last processed Google report while the latest official CSV is being processed.
            </p>
          ) : null}
          {freshness && !hasData && activeStatus ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {freshness.status === "failed"
                ? "The latest official report could not be processed. Try Refresh reports."
                : "Fetching the latest official Google Play reports…"}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
            aria-expanded={open}
          >
            <IconChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
            {open ? "Hide reports" : "Show reports"}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={!onRefresh || refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            <IconRefresh className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Refreshing…" : "Refresh reports"}
          </button>
        </div>
      </div>

      {!open ? (
        <div className="mt-4 rounded-xl border bg-background/40 px-4 py-3 text-xs text-muted-foreground">
          Reports are collapsed. Click <span className="font-medium text-foreground">Show reports</span> to view installs, crashes, store performance, breakdowns, reviews CSVs, and downloaded CSVs.
        </div>
      ) : (
        <>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-xl border bg-background/40 p-4">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <IconDownload className="size-3.5" /> Installs
          </div>
          <div className="mb-1 text-2xl font-semibold tabular-nums">
            {activeInstalls != null ? activeInstalls.toLocaleString() : "—"}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">active</span>
          </div>
          <MiniArea data={installData} series={[{ key: "installs", color: "var(--chart-3)" }, { key: "uninstalls", color: "var(--destructive)" }]} />
          <p className="mt-1 text-[10px] text-muted-foreground/60">
            Daily installs vs uninstalls{uninstallRate != null ? ` · ${uninstallRate.toFixed(0)}% uninstall rate` : ""}
          </p>
        </div>

        <div className="rounded-xl border bg-background/40 p-4">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <IconBug className="size-3.5" /> Stability
          </div>
          <div className="mb-1 text-2xl font-semibold tabular-nums">
            {dailyCrashes != null ? dailyCrashes.toLocaleString() : "—"}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">crashes/day</span>
            {dailyAnrs != null ? <span className="ml-2 text-sm text-muted-foreground">· {dailyAnrs.toLocaleString()} ANRs</span> : null}
          </div>
          <MiniArea data={crashData} series={[{ key: "crashes", color: "var(--destructive)" }, { key: "anrs", color: "var(--chart-4)" }]} />
          <p className="mt-1 text-[10px] text-muted-foreground/60">
            Daily crashes &amp; ANRs{crashesPer1k != null ? ` · ~${crashesPer1k.toFixed(1)}/1k installs (approx)` : ""}
          </p>
        </div>

        <div className="rounded-xl border bg-background/40 p-4">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <IconTrendingUp className="size-3.5" /> Store performance
          </div>
          <div className="mb-1 text-2xl font-semibold tabular-nums">
            {conversion != null ? `${conversion.toFixed(1)}%` : "—"}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">conversion</span>
          </div>
          <MiniArea data={spData} series={[{ key: "visitors", color: "var(--chart-2)" }]} />
          <p className="mt-1 text-[10px] text-muted-foreground/60">Store listing visitors · acquisitions ÷ visitors</p>
        </div>
      </div>

      {trafficSources.length > 0 ? (
        <div className="mt-5 rounded-xl border bg-background/40 p-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Top acquisition sources</p>
          <ul className="grid gap-1 sm:grid-cols-2">
            {trafficSources.map((t, i) => {
              const d = asDims(t.dimensions);
              const m = asMetrics(t.metrics);
              const name = d.traffic_source || d.search_term || d.utm_source || d.utm_campaign || "—";
              return (
                <li key={i} className="flex items-center gap-2 rounded-lg bg-muted/30 px-2 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate text-foreground/80">{name}</span>
                  <span className="w-16 text-right tabular-nums text-muted-foreground">{pick(m, "store_listing_acquisitions")?.toLocaleString() ?? "—"} acq</span>
                  <span className="w-14 text-right tabular-nums text-muted-foreground">{formatConversion(pick(m, "store_listing_conversion_rate"))}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {groupedBreakdowns.length > 0 ? (
        <div className="mt-5 rounded-xl border bg-background/40 p-4">
          <div className="mb-3 flex items-center gap-2">
            <IconDeviceMobile className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Breakdowns from downloaded CSVs</h3>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {groupedBreakdowns.map(([key, rows]) => {
              const [report, dimension] = key.split(":");
              const sample = rows.slice(0, 8);
              return (
                <div key={key} className="rounded-lg border bg-card p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold">{nice(report)} · {nice(dimension)}</p>
                    <span className="text-[10px] text-muted-foreground">{rows.length.toLocaleString()} rows</span>
                  </div>
                  <ul className="space-y-1">
                    {sample.map((r, i) => (
                      <li key={`${r.report}-${r.dimension}-${r.dimension_value}-${i}`} className="flex items-center gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate text-foreground/80">{labelForBreakdown(r)}</span>
                        <span className="w-20 shrink-0 text-right text-muted-foreground tabular-nums">{r.date}</span>
                        <span className="w-32 shrink-0 truncate text-right text-muted-foreground tabular-nums">{metricSummary(r.report, asMetrics(r.metrics))}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {groupedFiles.length > 0 ? (
        <div className="mt-5 rounded-xl border bg-background/40 p-4">
          <div className="mb-3 flex items-center gap-2">
            <IconDatabase className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Downloaded CSV cache by year/month</h3>
          </div>
          <div className="space-y-3">
            {groupedFiles.map(([year, months]) => (
              <div key={year}>
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold"><IconWorld className="size-3.5" /> {year}</p>
                <div className="grid gap-2 md:grid-cols-2">
                  {[...months.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([month, rows]) => (
                    <div key={`${year}-${month}`} className="rounded-lg border bg-card p-2.5">
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-xs font-medium">{year}-{month}</span>
                        <span className="text-[10px] text-muted-foreground">{rows.length} CSVs</span>
                      </div>
                      <ul className="space-y-1">
                        {rows.map((f) => (
                          <li key={f.object_path} className="flex items-center gap-2 text-[11px]">
                            <span className="min-w-0 flex-1 truncate" title={f.object_path}>{nice(f.report)} · {nice(f.dimension)}</span>
                            <span className="text-muted-foreground tabular-nums">{Number(f.rows_count ?? 0).toLocaleString()} rows</span>
                            <span className="text-muted-foreground">{formatBytes(f.size_bytes)}</span>
                            <span className={`rounded-full px-1.5 py-0.5 ${f.status === "failed" ? "bg-red-500/10 text-red-600" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"}`}>
                              {f.status ?? "parsed"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
        </>
      )}
    </section>
  );
}
