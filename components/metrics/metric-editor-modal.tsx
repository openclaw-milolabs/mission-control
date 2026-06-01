"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { PlayIcon, Loader2Icon, BookOpenIcon, ChartBarIcon, LineChartIcon, AreaChartIcon, PieChartIcon, HashIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { MetricChart } from "@/components/metrics/metric-chart";

const MonacoCodeEditor = dynamic(
  () => import("@/components/documents/monaco-code-editor").then((m) => m.MonacoCodeEditor),
  { ssr: false, loading: () => <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading editor…</div> },
);

export type MetricFormData = {
  id?: string;
  name: string;
  description: string;
  sql: string;
  chartType: "bar" | "line" | "area" | "pie" | "donut" | "kpi";
  xColumn: string;
  yColumns: string[];
  defaultWindow: "daily" | "weekly" | "monthly" | "yearly";
};

type Step = 1 | 2 | 3;

type Props = {
  open: boolean;
  initial?: MetricFormData;
  onClose: () => void;
  onSaved: () => void;
};

const WINDOW_OPTIONS: Array<{ key: MetricFormData["defaultWindow"]; label: string; desc: string }> = [
  { key: "daily",   label: "Day",   desc: "Last 24h" },
  { key: "weekly",  label: "Week",  desc: "Last 7 days" },
  { key: "monthly", label: "Month", desc: "Last 30 days" },
  { key: "yearly",  label: "Year",  desc: "Last 12 months" },
];

const CHART_TYPES: Array<{ key: MetricFormData["chartType"]; label: string; icon: React.ReactNode; desc: string }> = [
  { key: "line",  label: "Line",  icon: <LineChartIcon  className="size-5" />, desc: "Trends over time" },
  { key: "bar",   label: "Bar",   icon: <ChartBarIcon   className="size-5" />, desc: "Compare values" },
  { key: "area",  label: "Area",  icon: <AreaChartIcon  className="size-5" />, desc: "Volume over time" },
  { key: "pie",   label: "Pie",   icon: <PieChartIcon   className="size-5" />, desc: "Part of whole" },
  { key: "donut", label: "Donut", icon: <PieChartIcon   className="size-5" />, desc: "Ring chart" },
  { key: "kpi",   label: "KPI",   icon: <HashIcon       className="size-5" />, desc: "Single number" },
];

const STARTER_SQL = `SELECT
  DATE_FORMAT(created_at, :bucket) AS period,
  COUNT(*) AS count
FROM your_table
WHERE created_at BETWEEN :since AND :until
GROUP BY period
ORDER BY period`;

const EMPTY: MetricFormData = {
  name: "",
  description: "",
  sql: STARTER_SQL,
  chartType: "bar",
  xColumn: "",
  yColumns: [],
  defaultWindow: "monthly",
};

type Column = { name: string; type: string | null };
type Row = Record<string, unknown>;

const STEP_LABELS = ["Basics", "Query", "Chart"] as const;

export function MetricEditorModal({ open, initial, onClose, onSaved }: Props) {
  const isEdit = Boolean(initial?.id);
  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState<MetricFormData>(initial || EMPTY);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [previewColumns, setPreviewColumns] = useState<Column[]>([]);
  const [previewRows, setPreviewRows] = useState<Row[]>([]);
  const [previewRowCount, setPreviewRowCount] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(initial || EMPTY);
    setStep(1);
    setError("");
    setPreviewColumns([]);
    setPreviewRows([]);
    setPreviewRowCount(null);
  }, [open, initial]);

  const update = useCallback(<K extends keyof MetricFormData>(key: K, value: MetricFormData[K]) => {
    setForm((p) => ({ ...p, [key]: value }));
  }, []);

  const runPreview = async () => {
    setRunning(true);
    setError("");
    try {
      const res = await fetch("/api/metrics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "previewSql", sql: form.sql, window: form.defaultWindow }),
      });
      const j = await res.json();
      if (!j.ok) {
        setError(j.error || "Query failed.");
        setPreviewColumns([]);
        setPreviewRows([]);
        return;
      }
      setPreviewColumns(j.columns || []);
      setPreviewRows(j.rows || []);
      setPreviewRowCount(j.rowCount ?? null);
      if (!form.xColumn && j.columns?.[0]) update("xColumn", j.columns[0].name);
      if ((form.yColumns?.length ?? 0) === 0 && j.columns?.length > 1)
        update("yColumns", j.columns.slice(1).map((c: Column) => c.name));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run query.");
    } finally {
      setRunning(false);
    }
  };

  const save = async () => {
    if (!form.name.trim()) { setError("Name is required."); return; }
    if (!form.sql.trim())  { setError("SQL is required.");  return; }
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/metrics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: isEdit ? "updateMetric" : "createMetric",
          id: form.id,
          name: form.name,
          description: form.description,
          sql: form.sql,
          chartType: form.chartType,
          xColumn: form.xColumn,
          yColumns: form.yColumns,
          defaultWindow: form.defaultWindow,
        }),
      });
      const j = await res.json();
      if (!j.ok) { setError(j.error || "Failed to save."); return; }
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const xCandidates = useMemo(() => previewColumns.map((c) => c.name), [previewColumns]);
  const yCandidates = useMemo(
    () => previewColumns.filter((c) => c.name !== form.xColumn).map((c) => c.name),
    [previewColumns, form.xColumn],
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="sm:max-w-[700px] p-0 gap-0">

        {/* Step indicator */}
        <div className="flex items-center gap-0 border-b px-6 py-4">
          {STEP_LABELS.map((label, i) => {
            const n = (i + 1) as Step;
            const done = step > n;
            const current = step === n;
            return (
              <div key={label} className="flex items-center">
                {i > 0 && <div className={cn("w-8 h-px mx-2", done ? "bg-primary/60" : "bg-border")} />}
                <button
                  type="button"
                  onClick={() => { if (done) setStep(n); }}
                  disabled={!done && !current}
                  className={cn(
                    "flex items-center gap-2 text-xs font-medium transition-colors",
                    current ? "text-foreground" : done ? "text-primary cursor-pointer hover:text-primary/80" : "text-muted-foreground",
                  )}
                >
                  <span className={cn(
                    "flex size-6 items-center justify-center rounded-full text-[11px] font-bold transition-colors",
                    current ? "bg-foreground text-background" : done ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
                  )}>
                    {done ? "✓" : n}
                  </span>
                  {label}
                </button>
              </div>
            );
          })}
          <p className="ml-auto text-xs text-muted-foreground">{isEdit ? "Edit metric" : "New metric"}</p>
        </div>

        {/* Step content */}
        <div className="min-h-[420px] overflow-auto">

          {/* ── Step 1: Basics ── */}
          {step === 1 && (
            <div className="flex flex-col gap-6 p-6">
              <div>
                <h2 className="text-base font-semibold">What are you tracking?</h2>
                <p className="text-sm text-muted-foreground mt-1">Give your metric a name and choose the default time range.</p>
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Metric name *</label>
                <Input
                  value={form.name}
                  onChange={(e) => update("name", e.target.value)}
                  placeholder="e.g. Daily Active Players"
                  className="h-11 text-base"
                  autoFocus
                />
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-muted-foreground">
                  Description <span className="font-normal">(optional)</span>
                </label>
                <Textarea
                  value={form.description}
                  onChange={(e) => update("description", e.target.value)}
                  rows={2}
                  placeholder="Short description of what this measures"
                  className="resize-none"
                />
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">Default time range</label>
                <p className="text-xs text-muted-foreground">How far back should this chart look by default?</p>
                <div className="grid grid-cols-4 gap-2 mt-1">
                  {WINDOW_OPTIONS.map((w) => (
                    <button
                      key={w.key}
                      type="button"
                      onClick={() => update("defaultWindow", w.key)}
                      className={cn(
                        "flex flex-col items-center gap-1 rounded-xl border-2 p-3 transition-all",
                        form.defaultWindow === w.key
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
                      )}
                    >
                      <span className="text-sm font-semibold">{w.label}</span>
                      <span className="text-[10px] opacity-70">{w.desc}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── Step 2: Query ── */}
          {step === 2 && (
            <div className="flex flex-col gap-4 p-6">
              <div>
                <h2 className="text-base font-semibold">Write your query</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Write a{" "}
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">SELECT</code> query against your database.
                  Use{" "}
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">:since</code>{" "}
                  /{" "}
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">:until</code>{" "}
                  for the date range and{" "}
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">:bucket</code>{" "}
                  for grouping.
                </p>
              </div>

              <div className="rounded-xl border overflow-hidden">
                <div className="h-[260px]">
                  <MonacoCodeEditor
                    content={form.sql}
                    onChange={(v) => update("sql", v)}
                    ext=".sql"
                  />
                </div>
                <div className="border-t px-3 py-2 flex items-center justify-between bg-muted/[0.04]">
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <BookOpenIcon className="size-3 shrink-0" />
                    <span>
                      <code className="font-mono text-foreground">:since</code> / <code className="font-mono text-foreground">:until</code> = date range ·{" "}
                      <code className="font-mono text-foreground">:bucket</code> = group format
                    </span>
                  </div>
                  <Button size="sm" onClick={runPreview} disabled={running} className="gap-1.5 h-7 shrink-0">
                    {running ? <Loader2Icon className="size-3 animate-spin" /> : <PlayIcon className="size-3" />}
                    Test query
                  </Button>
                </div>
              </div>

              {error && (
                <pre className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-[11px] text-destructive whitespace-pre-wrap">
                  {error}
                </pre>
              )}

              {previewRowCount !== null && !error && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 flex items-center gap-3">
                  <span className="text-emerald-600 text-lg leading-none">✓</span>
                  <div>
                    <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">Query works!</p>
                    <p className="text-xs text-muted-foreground">
                      {previewRowCount} rows · columns: <span className="font-mono">{previewColumns.map((c) => c.name).join(", ")}</span>
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Step 3: Chart ── */}
          {step === 3 && (
            <div className="flex flex-col gap-5 p-6">
              <div>
                <h2 className="text-base font-semibold">Choose your visualization</h2>
                <p className="text-sm text-muted-foreground mt-1">Pick a chart type and map your columns.</p>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {CHART_TYPES.map((ct) => (
                  <button
                    key={ct.key}
                    type="button"
                    onClick={() => update("chartType", ct.key)}
                    className={cn(
                      "flex items-center gap-3 rounded-xl border-2 p-3 text-left transition-all",
                      form.chartType === ct.key
                        ? "border-primary bg-primary/5"
                        : "border-border bg-background hover:border-primary/40",
                    )}
                  >
                    <span className={cn("shrink-0", form.chartType === ct.key ? "text-primary" : "text-muted-foreground")}>
                      {ct.icon}
                    </span>
                    <div className="min-w-0">
                      <p className={cn("text-sm font-medium", form.chartType === ct.key ? "text-primary" : "")}>{ct.label}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{ct.desc}</p>
                    </div>
                  </button>
                ))}
              </div>

              {previewColumns.length > 0 ? (
                <>
                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium">
                      X axis <span className="text-muted-foreground font-normal text-xs">(category or time)</span>
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {xCandidates.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => update("xColumn", c)}
                          className={cn(
                            "rounded-full border px-3 py-1 text-xs font-mono transition-colors",
                            form.xColumn === c
                              ? "border-foreground bg-foreground text-background font-medium"
                              : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
                          )}
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium">
                      Y axis <span className="text-muted-foreground font-normal text-xs">(values — select one or more)</span>
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {yCandidates.map((c) => {
                        const selected = form.yColumns.includes(c);
                        return (
                          <button
                            key={c}
                            type="button"
                            onClick={() =>
                              update("yColumns", selected ? form.yColumns.filter((x) => x !== c) : [...form.yColumns, c])
                            }
                            className={cn(
                              "rounded-full border px-3 py-1 text-xs font-mono transition-colors",
                              selected
                                ? "border-foreground bg-foreground text-background font-medium"
                                : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
                            )}
                          >
                            {c}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              ) : (
                <div className="rounded-xl border border-dashed bg-muted/[0.03] px-4 py-5 text-center">
                  <p className="text-sm text-muted-foreground">Go back to step 2 and run <strong>Test query</strong> to see column options here.</p>
                </div>
              )}

              {previewRows.length > 0 && (
                <div className="rounded-xl border overflow-hidden">
                  <div className="px-3 py-2 border-b bg-muted/[0.04]">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Preview</span>
                  </div>
                  <div className="p-3">
                    <MetricChart
                      type={form.chartType}
                      xColumn={form.xColumn || previewColumns[0]?.name || ""}
                      yColumns={form.yColumns.length > 0 ? form.yColumns : previewColumns.slice(1).map((c) => c.name)}
                      rows={previewRows}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t px-6 py-4 bg-muted/[0.02]">
          <Button
            variant="ghost"
            onClick={step === 1 ? onClose : () => { setError(""); setStep((s) => (s - 1) as Step); }}
            disabled={saving}
          >
            {step === 1 ? "Cancel" : "← Back"}
          </Button>
          <div className="flex items-center gap-2">
            {error && step !== 2 && (
              <p className="text-xs text-destructive max-w-xs truncate">{error}</p>
            )}
            {step < 3 ? (
              <Button
                onClick={() => { setError(""); setStep((s) => (s + 1) as Step); }}
                disabled={step === 1 ? !form.name.trim() : !form.sql.trim()}
              >
                Continue →
              </Button>
            ) : (
              <Button
                onClick={() => void save()}
                disabled={saving || !form.name.trim() || !form.sql.trim()}
              >
                {saving
                  ? <><Loader2Icon className="size-4 mr-2 animate-spin" /> Saving…</>
                  : isEdit ? "Save changes" : "Create metric"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
