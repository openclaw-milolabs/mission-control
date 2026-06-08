"use client";

import { useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { IconBrandGooglePlay, IconDownload, IconBug, IconTrendingUp } from "@tabler/icons-react";

export type ReportPoint = { date: string; metrics: unknown; source?: string | null };
export type TrafficSource = { dimensions: unknown; metrics: unknown };

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

function fmtDay(day: string): string {
  const d = new Date(day);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
          <XAxis dataKey="date" tickFormatter={fmtDay} tickLine={false} axisLine={false} minTickGap={32} tick={{ fontSize: 9, fill: "var(--muted-foreground)" }} />
          <Tooltip
            contentStyle={{ borderRadius: 10, border: "1px solid var(--border)", background: "var(--popover)", fontSize: 11 }}
            labelFormatter={(l) => fmtDay(String(l))}
          />
          {series.map((s) => (
            <Area key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={1.75} fill={s.color} fillOpacity={0.12} dot={false} isAnimationActive={false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function PlayReportsCard({
  installs = [],
  crashes = [],
  storePerformance = [],
  trafficSources = [],
}: {
  installs?: ReportPoint[];
  crashes?: ReportPoint[];
  storePerformance?: ReportPoint[];
  trafficSources?: TrafficSource[];
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
  const lastCrash = crashes.length ? asMetrics(crashes[crashes.length - 1].metrics) : {};
  const dailyCrashes = pick(lastCrash, "daily_crashes");
  const dailyAnrs = pick(lastCrash, "daily_anrs");

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

  if (installs.length === 0 && crashes.length === 0 && storePerformance.length === 0 && trafficSources.length === 0)
    return null;

  return (
    <section className="rounded-xl border bg-card p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <IconBrandGooglePlay className="size-4" />
          Play Console reports
        </h2>
        <span className="text-[11px] text-muted-foreground/70">Google Play Console report · delayed 3–7 days</span>
      </div>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <IconDownload className="size-3.5" /> Installs
          </div>
          <div className="mb-1 text-2xl font-semibold tabular-nums">
            {activeInstalls != null ? activeInstalls.toLocaleString() : "—"}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">active</span>
          </div>
          <MiniArea
            data={installData}
            series={[
              { key: "installs", color: "var(--chart-3)" },
              { key: "uninstalls", color: "var(--destructive)" },
            ]}
          />
          <p className="mt-1 text-[10px] text-muted-foreground/60">Daily installs vs uninstalls</p>
        </div>

        <div>
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <IconBug className="size-3.5" /> Stability
          </div>
          <div className="mb-1 text-2xl font-semibold tabular-nums">
            {dailyCrashes != null ? dailyCrashes.toLocaleString() : "—"}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">crashes/day</span>
            {dailyAnrs != null ? <span className="ml-2 text-sm text-muted-foreground">· {dailyAnrs.toLocaleString()} ANRs</span> : null}
          </div>
          <MiniArea
            data={crashData}
            series={[
              { key: "crashes", color: "var(--destructive)" },
              { key: "anrs", color: "var(--chart-4)" },
            ]}
          />
          <p className="mt-1 text-[10px] text-muted-foreground/60">Daily crashes &amp; ANRs</p>
        </div>

        {storePerformance.length > 0 ? (
          <div>
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <IconTrendingUp className="size-3.5" /> Store performance
            </div>
            <div className="mb-1 text-2xl font-semibold tabular-nums">
              {conversion != null ? `${conversion.toFixed(1)}%` : "—"}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">conversion</span>
            </div>
            <MiniArea data={spData} series={[{ key: "visitors", color: "var(--chart-2)" }]} />
            <p className="mt-1 text-[10px] text-muted-foreground/60">
              Store listing visitors · acquisitions ÷ visitors
            </p>
          </div>
        ) : null}
      </div>

      {trafficSources.length > 0 ? (
        <div className="mt-4 border-t pt-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Top acquisition sources
          </p>
          <ul className="space-y-1">
            {trafficSources.map((t, i) => {
              const d = asDims(t.dimensions);
              const m = asMetrics(t.metrics);
              const name = d.traffic_source || d.search_term || d.utm_source || d.utm_campaign || "—";
              return (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-foreground/80">{name}</span>
                  <span className="w-16 text-right tabular-nums text-muted-foreground">
                    {pick(m, "store_listing_acquisitions")?.toLocaleString() ?? "—"} acq
                  </span>
                  <span className="w-12 text-right tabular-nums text-muted-foreground">
                    {formatConversion(pick(m, "store_listing_conversion_rate"))}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
