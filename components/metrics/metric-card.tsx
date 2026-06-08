"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDownIcon, Loader2Icon, MoreHorizontalIcon, PencilIcon, RefreshCwIcon, Trash2Icon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { MetricChart } from "@/components/metrics/metric-chart";
import { describeWindow, usesWindow, usesBucket } from "@/lib/metrics/window";
import { computeBucketDelta, formatBucketLabel, parseDbDateTime } from "@/lib/metrics/delta";
import { makeLimiter } from "@/lib/metrics/limiter";

// Shared across every card instance: load a few at a time instead of firing
// one request per card the moment the page mounts. Pairs with the server-side
// gate in lib/metrics/mysql.ts.
const cardGate = makeLimiter(3);

export type MetricDef = {
  id: string;
  name: string;
  description: string | null;
  sql_text: string;
  chart_type: "bar" | "line" | "area" | "pie" | "donut" | "kpi";
  x_column: string;
  y_columns: string[];
  default_window: WindowName;
  updated_by_name: string | null;
  updated_at: string;
};

type WindowName = "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "custom";

type Props = {
  metric: MetricDef;
  globalWindow: WindowName;
  /** Backup-DB freshness (max timestamp), so deltas ignore not-yet-synced buckets. */
  dataAsOf?: string | null;
  onEdit: () => void;
  onDelete: () => void;
};

const WINDOW_PILLS: Array<{ key: WindowName; label: string }> = [
  { key: "hourly", label: "Hour" },
  { key: "daily", label: "Day" },
  { key: "weekly", label: "Week" },
  { key: "monthly", label: "Month" },
  { key: "yearly", label: "Year" },
];

// Snapshot lookback options (no time bucket): the same windows, framed as a
// range to look back over rather than a granularity to bucket by.
const LOOKBACK_OPTIONS: WindowName[] = ["hourly", "daily", "weekly", "monthly", "yearly"];

/** Compact "data through" timestamp for the freshness note. */
function fmtAsOf(d: Date): string {
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function MetricCard({ metric, globalWindow, dataAsOf = null, onEdit, onDelete }: Props) {
  const [override, setOverride] = useState<WindowName | "inherit">("inherit");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  // Start true: a load always fires on mount (often queued behind the shared
  // gate), so the body should show "Loading…" rather than "No rows to render".
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ durationMs: number; rowCount: number; truncated: boolean } | null>(null);

  // Three control modes, by what the SQL actually references:
  //  - bucketed  (:bucket)            → real time series → granularity pills
  //  - windowed  (:since/:until only) → snapshot         → single range selector
  //  - neither                        → lifetime         → no control at all
  // Windowless metrics ignore the window entirely (identical result regardless),
  // so we pin to a stable value to keep the per-window cache key constant.
  const windowed = usesWindow(metric.sql_text);
  const bucketed = usesBucket(metric.sql_text);

  const effectiveWindow: WindowName = !windowed
    ? "monthly"
    : override !== "inherit"
      ? override
      : globalWindow;

  // Period-over-period delta (time-series only): change between the last two
  // COMPLETE buckets, excluding any the backup hasn't fully synced yet.
  const asOf = useMemo(() => parseDbDateTime(dataAsOf), [dataAsOf]);
  const yCol = metric.y_columns[0] ?? "";
  const delta = useMemo(
    () => (bucketed && yCol ? computeBucketDelta({ rows, xColumn: metric.x_column, yColumn: yCol, window: effectiveWindow, asOf }) : null),
    [bucketed, yCol, rows, metric.x_column, effectiveWindow, asOf],
  );

  // We cache per-window so re-pressing a pill doesn't re-hit MySQL.
  const cache = useRef<Map<string, { rows: Record<string, unknown>[]; meta: NonNullable<typeof meta> }>>(new Map());

  const load = useCallback(async (window: WindowName, fresh = false) => {
    if (!fresh) {
      const cached = cache.current.get(window);
      if (cached) {
        setRows(cached.rows);
        setMeta(cached.meta);
        setError(null);
        setLoading(false);
        return;
      }
    }
    setLoading(true);
    setError(null);
    try {
      const j = await cardGate(async () => {
        const res = await fetch("/api/metrics", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "runMetric", metricId: metric.id, window }),
        });
        return res.json();
      });
      if (!j.ok) {
        setError(j.error || "Query failed.");
        setRows([]);
        return;
      }
      const next = j.rows || [];
      const m = { durationMs: j.durationMs ?? 0, rowCount: j.rowCount ?? 0, truncated: Boolean(j.truncated) };
      cache.current.set(window, { rows: next, meta: m });
      setRows(next);
      setMeta(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed.");
    } finally {
      setLoading(false);
    }
  }, [metric.id]);

  useEffect(() => {
    void load(effectiveWindow);
  }, [effectiveWindow, load]);

  return (
    <div className="flex flex-col rounded-xl border bg-card overflow-hidden">
      <header className="flex items-start gap-3 px-4 py-3 border-b">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{metric.name}</h3>
          {metric.description && (
            <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{metric.description}</p>
          )}
          {meta && (
            <p className="mt-1 text-[10px] text-muted-foreground/70 tabular-nums">
              {bucketed
                ? `${describeWindow(effectiveWindow).range} · ${describeWindow(effectiveWindow).granularity} · `
                : windowed
                  ? `${describeWindow(effectiveWindow).range} · `
                  : ""}{meta.rowCount} rows · {meta.durationMs}ms{meta.truncated ? " · truncated" : ""}
            </p>
          )}
          {delta && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-semibold tabular-nums",
                  delta.delta > 0
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : delta.delta < 0
                      ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                      : "bg-muted text-muted-foreground",
                )}
                title={`${yCol}: ${delta.previous.toLocaleString()} → ${delta.current.toLocaleString()}`}
              >
                {delta.delta > 0 ? <TrendingUpIcon className="size-3" /> : delta.delta < 0 ? <TrendingDownIcon className="size-3" /> : null}
                {delta.delta > 0 ? "+" : ""}{delta.delta.toLocaleString()}
              </span>
              <span className="text-muted-foreground/70">
                {formatBucketLabel(delta.previousLabel, effectiveWindow)} → {formatBucketLabel(delta.currentLabel, effectiveWindow)}
              </span>
            </div>
          )}
          {bucketed && asOf && (
            <p className="mt-0.5 text-[10px] text-muted-foreground/55 tabular-nums">
              data through {fmtAsOf(asOf)}
              {delta && delta.excluded > 0 ? ` · ${delta.excluded} in-progress bucket${delta.excluded > 1 ? "s" : ""} excluded` : ""}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void load(effectiveWindow, true)}
            disabled={loading}
            aria-label="Refresh"
            title="Refresh"
          >
            {loading
              ? <Loader2Icon className="size-3.5 animate-spin" />
              : <RefreshCwIcon className="size-3.5" />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="More"><MoreHorizontalIcon className="size-3.5" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}><PencilIcon className="size-3.5" /> Edit</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2Icon className="size-3.5" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {bucketed ? (
        // Real time series: pick how to bucket time.
        <div className="flex items-center gap-1 border-b bg-muted/[0.04] px-3 py-2">
          {WINDOW_PILLS.map((p) => {
            const active = effectiveWindow === p.key;
            return (
              <button
                key={p.key}
                onClick={() => setOverride(p.key)}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors",
                  active
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      ) : windowed ? (
        // Windowed snapshot (e.g. a category donut): no time buckets exist, so a
        // granularity picker would be misleading. Offer the lookback range only.
        <div className="flex items-center gap-2 border-b bg-muted/[0.04] px-3 py-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">Range</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-medium text-foreground transition-colors hover:bg-accent"
                title="How far back to look — this metric has no time buckets, so only the range matters"
              >
                {describeWindow(effectiveWindow).range}
                <ChevronDownIcon className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {LOOKBACK_OPTIONS.map((w) => (
                <DropdownMenuItem key={w} onClick={() => setOverride(w)}>
                  {describeWindow(w).range}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}

      <div className="flex-1 min-h-[260px] p-3">
        {error ? (
          <pre className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-[11px] text-destructive whitespace-pre-wrap">
            {error}
          </pre>
        ) : loading && rows.length === 0 ? (
          <div className="flex h-full min-h-[180px] items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Loading…
          </div>
        ) : (
          <MetricChart
            type={metric.chart_type}
            xColumn={metric.x_column}
            yColumns={metric.y_columns}
            rows={rows}
          />
        )}
      </div>
    </div>
  );
}
