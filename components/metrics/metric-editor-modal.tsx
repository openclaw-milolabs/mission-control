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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PlayIcon, Loader2Icon, BookOpenIcon } from "lucide-react";
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

type Props = {
  open: boolean;
  initial?: MetricFormData;
  onClose: () => void;
  onSaved: () => void;
};

const STARTER_SQL = `SELECT
  DATE_FORMAT(created_at, :bucket) AS bucket,
  COUNT(*) AS count
FROM your_table
WHERE created_at BETWEEN :since AND :until
GROUP BY bucket
ORDER BY bucket`;

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

export function MetricEditorModal({ open, initial, onClose, onSaved }: Props) {
  const isEdit = Boolean(initial?.id);
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
      // Auto-pick x / y if user hasn't yet.
      if (!form.xColumn && j.columns?.[0]) update("xColumn", j.columns[0].name);
      if ((form.yColumns?.length ?? 0) === 0 && j.columns?.length > 1) {
        update("yColumns", j.columns.slice(1).map((c: Column) => c.name));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run query.");
    } finally {
      setRunning(false);
    }
  };

  const save = async () => {
    if (!form.name.trim()) { setError("Name is required."); return; }
    if (!form.sql.trim()) { setError("SQL is required."); return; }
    setSaving(true);
    setError("");
    try {
      const body = {
        action: isEdit ? "updateMetric" : "createMetric",
        id: form.id,
        name: form.name,
        description: form.description,
        sql: form.sql,
        chartType: form.chartType,
        xColumn: form.xColumn,
        yColumns: form.yColumns,
        defaultWindow: form.defaultWindow,
      };
      const res = await fetch("/api/metrics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
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
      <DialogContent className="sm:max-w-[1100px] p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b">
          <DialogTitle className="text-base">{isEdit ? "Edit metric" : "New metric"}</DialogTitle>
          <DialogDescription className="text-[11px]">
            Paste a SELECT, reference <span className="font-mono">:since</span>, <span className="font-mono">:until</span>, <span className="font-mono">:bucket</span>, click Test, then save.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_360px] gap-0 max-h-[78vh] overflow-hidden">
          {/* LEFT — SQL editor + preview */}
          <div className="flex flex-col min-h-0 border-r">
            <div className="px-4 pt-3 pb-2 border-b flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                SQL
              </span>
              <Button size="sm" onClick={runPreview} disabled={running} className="gap-1.5">
                {running ? <Loader2Icon className="size-3 animate-spin" /> : <PlayIcon className="size-3" />}
                Test query
              </Button>
            </div>
            <div className="h-[320px] min-h-0">
              <MonacoCodeEditor
                content={form.sql}
                onChange={(v) => update("sql", v)}
                ext=".sql"
              />
            </div>

            <div className="px-4 pt-3 pb-2 border-t border-b flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Preview
              </span>
              {previewRowCount !== null && (
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {previewRowCount} rows
                </span>
              )}
            </div>
            <div className="flex-1 min-h-[200px] p-3 overflow-auto">
              {error ? (
                <pre className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-[11px] text-destructive whitespace-pre-wrap">
                  {error}
                </pre>
              ) : previewRows.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  Run the query to preview the chart.
                </div>
              ) : (
                <MetricChart
                  type={form.chartType}
                  xColumn={form.xColumn || previewColumns[0]?.name || ""}
                  yColumns={form.yColumns.length > 0 ? form.yColumns : previewColumns.slice(1).map((c) => c.name)}
                  rows={previewRows}
                />
              )}
            </div>
          </div>

          {/* RIGHT — metadata form */}
          <div className="flex flex-col gap-4 overflow-auto p-5 bg-muted/[0.04]">
            <Field label="Name">
              <Input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="Orders per day" />
            </Field>
            <Field label="Description (optional)">
              <Textarea value={form.description} onChange={(e) => update("description", e.target.value)} rows={2} placeholder="Short one-line summary" />
            </Field>

            <Field label="Chart type">
              <Select value={form.chartType} onValueChange={(v) => update("chartType", v as MetricFormData["chartType"])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bar">Bar</SelectItem>
                  <SelectItem value="line">Line</SelectItem>
                  <SelectItem value="area">Area</SelectItem>
                  <SelectItem value="pie">Pie</SelectItem>
                  <SelectItem value="donut">Donut</SelectItem>
                  <SelectItem value="kpi">KPI (single number)</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field label="X column (category / time)">
              {xCandidates.length === 0 ? (
                <Input
                  value={form.xColumn}
                  onChange={(e) => update("xColumn", e.target.value)}
                  placeholder="Run the query first"
                />
              ) : (
                <Select value={form.xColumn} onValueChange={(v) => update("xColumn", v)}>
                  <SelectTrigger><SelectValue placeholder="Pick a column" /></SelectTrigger>
                  <SelectContent>
                    {xCandidates.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </Field>

            <Field label="Y columns (values)">
              {yCandidates.length === 0 ? (
                <Input
                  value={form.yColumns.join(", ")}
                  onChange={(e) => update("yColumns", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
                  placeholder="count, revenue (comma-separated)"
                />
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {yCandidates.map((c) => {
                    const selected = form.yColumns.includes(c);
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => {
                          update(
                            "yColumns",
                            selected ? form.yColumns.filter((x) => x !== c) : [...form.yColumns, c],
                          );
                        }}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-xs transition-colors",
                          selected
                            ? "border-foreground/40 bg-foreground/5 font-medium"
                            : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                      >
                        {c}
                      </button>
                    );
                  })}
                </div>
              )}
            </Field>

            <Field label="Default window">
              <Select value={form.defaultWindow} onValueChange={(v) => update("defaultWindow", v as MetricFormData["defaultWindow"])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily (last 24h)</SelectItem>
                  <SelectItem value="weekly">Weekly (last 7 days)</SelectItem>
                  <SelectItem value="monthly">Monthly (last 30 days)</SelectItem>
                  <SelectItem value="yearly">Yearly (last 12 months)</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <div className="rounded-md border bg-background/60 p-3 text-[11px] text-muted-foreground">
              <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
                <BookOpenIcon className="size-3.5" /> Placeholders
              </div>
              <ul className="space-y-1">
                <li><span className="font-mono text-foreground">:since</span> — start of the window</li>
                <li><span className="font-mono text-foreground">:until</span> — now</li>
                <li><span className="font-mono text-foreground">:bucket</span> — MySQL <span className="font-mono">DATE_FORMAT</span> mask sized to the window</li>
              </ul>
            </div>
          </div>
        </div>

        <DialogFooter className="px-6 py-3 border-t">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || !form.name.trim() || !form.sql.trim()}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create metric"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-[11px] font-medium text-foreground/70">{label}</Label>
      {children}
    </div>
  );
}
