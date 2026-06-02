"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Loader2Icon, MoreHorizontalIcon, PencilIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { MetricChart } from "@/components/metrics/metric-chart";
import { describeWindow } from "@/lib/metrics/window";

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

type WindowName = "daily" | "weekly" | "monthly" | "yearly" | "custom";

type Props = {
  metric: MetricDef;
  globalWindow: WindowName;
  onEdit: () => void;
  onDelete: () => void;
};

const WINDOW_LABEL: Record<WindowName, string> = {
  daily: "Day",
  weekly: "Week",
  monthly: "Month",
  yearly: "Year",
  custom: "Custom",
};

const WINDOW_PILLS: Array<{ key: WindowName; label: string }> = [
  { key: "daily", label: "Day" },
  { key: "weekly", label: "Week" },
  { key: "monthly", label: "Month" },
  { key: "yearly", label: "Year" },
];

export function MetricCard({ metric, globalWindow, onEdit, onDelete }: Props) {
  const [override, setOverride] = useState<WindowName | "inherit">("inherit");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ durationMs: number; rowCount: number; truncated: boolean } | null>(null);

  const effectiveWindow: WindowName =
    override !== "inherit"
      ? override
      : globalWindow;

  // We cache per-window so re-pressing a pill doesn't re-hit MySQL.
  const cache = useRef<Map<string, { rows: Record<string, unknown>[]; meta: NonNullable<typeof meta> }>>(new Map());

  const load = useCallback(async (window: WindowName, fresh = false) => {
    if (!fresh) {
      const cached = cache.current.get(window);
      if (cached) {
        setRows(cached.rows);
        setMeta(cached.meta);
        setError(null);
        return;
      }
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/metrics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "runMetric", metricId: metric.id, window }),
      });
      const j = await res.json();
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
              {describeWindow(effectiveWindow).range} · {describeWindow(effectiveWindow).granularity} · {meta.rowCount} rows · {meta.durationMs}ms{meta.truncated ? " · truncated" : ""}
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

      <div className="flex-1 min-h-[260px] p-3">
        {error ? (
          <pre className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-[11px] text-destructive whitespace-pre-wrap">
            {error}
          </pre>
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
