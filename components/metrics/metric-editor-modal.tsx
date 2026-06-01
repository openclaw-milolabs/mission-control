"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  IconChartBar,
  IconChartLine,
  IconChartArea,
  IconChartPie,
  IconHash,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconLoader2,
  IconPlayerPlay,
  IconBook2,
  IconTag,
  IconTerminal2,
  IconChartDots3,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { MetricChart } from "@/components/metrics/metric-chart";

const MonacoCodeEditor = dynamic(
  () => import("@/components/documents/monaco-code-editor").then((m) => m.MonacoCodeEditor),
  { ssr: false, loading: () => <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading editor…</div> },
);

// ── Types ────────────────────────────────────────────────────────────────────

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

type Props = {
  open: boolean;
  initial?: MetricFormData;
  onClose: () => void;
  onSaved: () => void;
};

type Column = { name: string; type: string | null };
type Row = Record<string, unknown>;

// ── Constants ────────────────────────────────────────────────────────────────

const STEPS = [
  { key: "basics", label: "Basics",  icon: IconTag },
  { key: "query",  label: "Query",   icon: IconTerminal2 },
  { key: "chart",  label: "Chart",   icon: IconChartBar },
] as const;

const WINDOW_OPTIONS: Array<{ key: MetricFormData["defaultWindow"]; label: string; desc: string }> = [
  { key: "daily",   label: "Day",   desc: "Last 24h" },
  { key: "weekly",  label: "Week",  desc: "Last 7 days" },
  { key: "monthly", label: "Month", desc: "Last 30 days" },
  { key: "yearly",  label: "Year",  desc: "Last 12 months" },
];

const CHART_TYPES: Array<{ key: MetricFormData["chartType"]; label: string; icon: React.ReactNode; desc: string }> = [
  { key: "line",  label: "Line",  icon: <IconChartLine  className="size-5" />, desc: "Trends over time" },
  { key: "bar",   label: "Bar",   icon: <IconChartBar   className="size-5" />, desc: "Compare values" },
  { key: "area",  label: "Area",  icon: <IconChartArea  className="size-5" />, desc: "Volume over time" },
  { key: "pie",   label: "Pie",   icon: <IconChartPie   className="size-5" />, desc: "Part of whole" },
  { key: "donut", label: "Donut", icon: <IconChartDots3 className="size-5" />, desc: "Ring chart" },
  { key: "kpi",   label: "KPI",   icon: <IconHash       className="size-5" />, desc: "Single number" },
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

// ── Step indicator (card style — matches AgendaEventModal) ───────────────────

function StepIndicator({
  currentStep,
  onStepClick,
  canGoTo,
}: {
  currentStep: number;
  onStepClick: (i: number) => void;
  canGoTo: (i: number) => boolean;
}) {
  return (
    <div className="flex gap-1.5 w-full">
      {STEPS.map((step, i) => {
        const isActive = i === currentStep;
        const isDone = i < currentStep;
        const isDisabled = !isActive && !isDone && !canGoTo(i);
        const Icon = step.icon;
        return (
          <button
            key={step.key}
            type="button"
            onClick={() => !isDisabled && onStepClick(i)}
            disabled={isDisabled}
            className={[
              "flex-1 flex items-center gap-2 px-3 py-2.5 rounded-lg transition-all duration-200 border",
              isDisabled
                ? "bg-muted/20 text-muted-foreground/40 border-transparent cursor-not-allowed"
                : isActive
                  ? "bg-primary text-primary-foreground border-primary shadow-sm cursor-pointer"
                  : isDone
                    ? "bg-primary/10 text-primary border-primary/20 hover:bg-primary/15 cursor-pointer"
                    : "bg-muted/40 text-muted-foreground border-transparent hover:bg-muted/60 cursor-pointer",
            ].join(" ")}
          >
            <div className={[
              "flex items-center justify-center size-6 rounded-full text-[10px] font-bold shrink-0",
              isActive
                ? "bg-primary-foreground/20 text-primary-foreground"
                : isDone
                  ? "bg-primary/20 text-primary"
                  : "bg-muted-foreground/15 text-muted-foreground",
            ].join(" ")}>
              {isDone ? <IconCheck className="size-3" /> : <Icon className="size-3.5" />}
            </div>
            <div className="flex flex-col items-start min-w-0">
              <span className="text-[11px] font-semibold leading-tight truncate">{step.label}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function MetricEditorModal({ open, initial, onClose, onSaved }: Props) {
  const isEdit = Boolean(initial?.id);
  const [step, setStep] = useState(0);
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
    setStep(0);
    setError("");
    setPreviewColumns([]);
    setPreviewRows([]);
    setPreviewRowCount(null);
  }, [open, initial]);

  const update = useCallback(<K extends keyof MetricFormData>(key: K, value: MetricFormData[K]) => {
    setForm((p) => ({ ...p, [key]: value }));
    setError("");
  }, []);

  const validateStep = (s: number): string | null => {
    if (s === 0 && !form.name.trim()) return "Metric name is required.";
    if (s === 1 && !form.sql.trim()) return "SQL query is required.";
    return null;
  };

  const canGoTo = (i: number): boolean => {
    for (let s = 0; s < i; s++) {
      if (validateStep(s)) return false;
    }
    return true;
  };

  const goToStep = (i: number) => {
    if (i <= step) { setError(""); setStep(i); return; }
    for (let s = step; s < i; s++) {
      const err = validateStep(s);
      if (err) { setError(err); return; }
    }
    setError("");
    setStep(i);
  };

  const goNext = () => {
    const err = validateStep(step);
    if (err) { setError(err); return; }
    setError("");
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const goBack = () => {
    setError("");
    setStep((s) => Math.max(s - 1, 0));
  };

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
    const err = validateStep(0) || validateStep(1);
    if (err) { setError(err); return; }
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

  const handleClose = () => {
    setForm(EMPTY);
    setError("");
    setStep(0);
    onClose();
  };

  const xCandidates = useMemo(() => previewColumns.map((c) => c.name), [previewColumns]);
  const yCandidates = useMemo(
    () => previewColumns.filter((c) => c.name !== form.xColumn).map((c) => c.name),
    [previewColumns, form.xColumn],
  );

  // ── Step renderers ─────────────────────────────────────────────────────────

  const renderBasicsStep = () => (
    <div className="flex flex-col gap-4">
      <div className="text-center mb-2">
        <h3 className="text-base font-bold text-foreground">What are you tracking?</h3>
        <p className="text-xs text-muted-foreground mt-1">Give your metric a name and choose the default time range</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="m-name" className="text-xs font-semibold text-foreground/80">
          Name <span className="text-destructive ml-0.5">*</span>
        </Label>
        <Input
          id="m-name"
          value={form.name}
          onChange={(e) => update("name", e.target.value)}
          placeholder="e.g. Daily Active Players"
          className="h-10"
          autoFocus
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="m-desc" className="text-xs font-semibold text-foreground/80">
          Description <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Textarea
          id="m-desc"
          value={form.description}
          onChange={(e) => update("description", e.target.value)}
          rows={2}
          placeholder="Short description of what this measures"
          className="resize-none"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-semibold text-foreground/80">Default time range</Label>
        <div className="grid grid-cols-4 gap-2">
          {WINDOW_OPTIONS.map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => update("defaultWindow", w.key)}
              className={[
                "flex flex-col items-center gap-1 rounded-xl border-2 p-3 transition-all duration-200 cursor-pointer",
                form.defaultWindow === w.key
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:bg-muted/40 hover:text-foreground",
              ].join(" ")}
            >
              <span className="text-sm font-bold">{w.label}</span>
              <span className="text-[10px] opacity-70">{w.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  const renderQueryStep = () => (
    <div className="flex flex-col gap-4">
      <div className="text-center mb-1">
        <h3 className="text-base font-bold text-foreground">Write your query</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          A <code className="font-mono bg-muted px-1 py-0.5 rounded text-[11px]">SELECT</code> against your MySQL database
        </p>
      </div>

      <div className="rounded-xl border overflow-hidden">
        <div className="h-[240px]">
          <MonacoCodeEditor
            content={form.sql}
            onChange={(v) => update("sql", v)}
            ext=".sql"
          />
        </div>
        <div className="border-t px-3 py-2 flex items-center justify-between bg-muted/[0.04]">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <IconBook2 className="size-3 shrink-0" />
            <span>
              <code className="font-mono text-foreground">:since</code>
              {" / "}
              <code className="font-mono text-foreground">:until</code>
              {" = date range · "}
              <code className="font-mono text-foreground">:bucket</code>
              {" = group format"}
            </span>
          </div>
          <Button size="sm" onClick={runPreview} disabled={running} className="gap-1.5 h-7 shrink-0 cursor-pointer">
            {running
              ? <IconLoader2 className="size-3 animate-spin" />
              : <IconPlayerPlay className="size-3" />}
            Test query
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
          <pre className="whitespace-pre-wrap font-sans">{error}</pre>
        </div>
      )}

      {previewRowCount !== null && !error && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 flex items-center gap-3">
          <div className="flex items-center justify-center size-6 rounded-full bg-emerald-500/20 shrink-0">
            <IconCheck className="size-3.5 text-emerald-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Query works!</p>
            <p className="text-xs text-muted-foreground">
              {previewRowCount} rows · columns:{" "}
              <span className="font-mono">{previewColumns.map((c) => c.name).join(", ")}</span>
            </p>
          </div>
        </div>
      )}
    </div>
  );

  const renderChartStep = () => (
    <div className="flex flex-col gap-4">
      <div className="text-center mb-1">
        <h3 className="text-base font-bold text-foreground">Choose your visualization</h3>
        <p className="text-xs text-muted-foreground mt-0.5">Pick a chart type and map your columns</p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {CHART_TYPES.map((ct) => (
          <button
            key={ct.key}
            type="button"
            onClick={() => update("chartType", ct.key)}
            className={[
              "flex items-center gap-3 rounded-xl border-2 p-3 text-left transition-all duration-200 cursor-pointer",
              form.chartType === ct.key
                ? "border-primary bg-primary/5"
                : "border-border bg-background hover:border-primary/40 hover:bg-muted/40",
            ].join(" ")}
          >
            <span className={form.chartType === ct.key ? "text-primary" : "text-muted-foreground"}>
              {ct.icon}
            </span>
            <div className="min-w-0">
              <p className={cn("text-sm font-semibold", form.chartType === ct.key ? "text-primary" : "")}>{ct.label}</p>
              <p className="text-[10px] text-muted-foreground truncate">{ct.desc}</p>
            </div>
          </button>
        ))}
      </div>

      {previewColumns.length > 0 ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-semibold text-foreground/80">
              X axis <span className="font-normal text-muted-foreground">(category or time)</span>
            </Label>
            <div className="flex flex-wrap gap-1.5">
              {xCandidates.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => update("xColumn", c)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-mono transition-colors cursor-pointer",
                    form.xColumn === c
                      ? "border-foreground bg-foreground text-background font-semibold"
                      : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-semibold text-foreground/80">
              Y axis <span className="font-normal text-muted-foreground">(values — select one or more)</span>
            </Label>
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
                      "rounded-full border px-3 py-1 text-xs font-mono transition-colors cursor-pointer",
                      selected
                        ? "border-foreground bg-foreground text-background font-semibold"
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
          <p className="text-sm text-muted-foreground">
            Go back to <strong>Query</strong> and run <strong>Test query</strong> to map columns here.
          </p>
        </div>
      )}

      {previewRows.length > 0 && (
        <div className="rounded-xl border bg-muted/20 divide-y">
          <div className="px-4 py-2.5">
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
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent className="sm:max-w-[600px] max-h-[92vh] overflow-y-auto p-0">

        {/* Header */}
        <DialogHeader className="px-6 pt-6 pb-0">
          <div className="flex items-center gap-3 mb-1">
            <div className={[
              "flex items-center justify-center size-9 rounded-lg shrink-0",
              isEdit ? "bg-primary/10" : "bg-primary",
            ].join(" ")}>
              <IconChartBar className={[
                "size-[18px]",
                isEdit ? "text-primary" : "text-primary-foreground",
              ].join(" ")} />
            </div>
            <div>
              <DialogTitle className="text-lg">
                {isEdit ? "Edit metric" : "New metric"}
              </DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                {isEdit
                  ? "Update this metric's name, query, or chart settings."
                  : "Define a SQL query and choose how to visualize it — follow the steps below."}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Step indicator */}
        <div className="px-6 pt-3">
          <StepIndicator currentStep={step} onStepClick={goToStep} canGoTo={canGoTo} />
        </div>

        {/* Step content */}
        <div className="px-6 py-4 min-h-[280px]">
          {step === 0 && renderBasicsStep()}
          {step === 1 && renderQueryStep()}
          {step === 2 && renderChartStep()}

          {error && step !== 1 && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive mt-4">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="px-6 pb-6 pt-0">
          <div className="flex items-center justify-between w-full gap-2">
            <div>
              {step > 0 && (
                <Button variant="ghost" onClick={goBack} className="gap-1.5 cursor-pointer">
                  <IconChevronLeft className="size-3.5" />
                  Back
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={handleClose} disabled={saving} className="cursor-pointer">
                Cancel
              </Button>
              {step < STEPS.length - 1 ? (
                <Button onClick={goNext} className="gap-1.5 cursor-pointer">
                  Next
                  <IconChevronRight className="size-3.5" />
                </Button>
              ) : (
                <Button
                  onClick={() => void save()}
                  disabled={saving || !form.name.trim() || !form.sql.trim()}
                  className="cursor-pointer"
                >
                  {saving
                    ? <><IconLoader2 className="size-4 mr-2 animate-spin" /> Saving…</>
                    : isEdit ? "Save changes" : "Create metric"}
                </Button>
              )}
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
