"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2Icon, PlusIcon, RefreshCwIcon, TriangleAlertIcon, ChartBarIcon, DownloadIcon, UploadIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useModules } from "@/components/modules/modules-provider";
import { MetricCard, type MetricDef } from "@/components/metrics/metric-card";
import { MetricEditorModal, type MetricFormData } from "@/components/metrics/metric-editor-modal";
import { PageHeader } from "@/components/layout/page-header";

type WindowName = "hourly" | "daily" | "weekly" | "monthly" | "yearly";

type Health = {
  ok: boolean;
  error?: string | null;
  host?: string;
  database?: string | null;
  version?: string | null;
  isReadOnlyUser?: boolean | null;
  secretsPath?: string;
  dataAsOf?: string | null;
};

const WINDOW_PILLS: Array<{ key: WindowName; label: string }> = [
  { key: "hourly", label: "Hour" },
  { key: "daily", label: "Day" },
  { key: "weekly", label: "Week" },
  { key: "monthly", label: "Month" },
  { key: "yearly", label: "Year" },
];

export function MetricsClient() {
  const router = useRouter();
  const { ready, isEnabled } = useModules();
  useEffect(() => {
    if (ready && !isEnabled("metrics")) router.replace("/settings#modules");
  }, [ready, isEnabled, router]);

  const [metrics, setMetrics] = useState<MetricDef[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [globalWindow, setGlobalWindow] = useState<WindowName>("monthly");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MetricFormData | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MetricDef | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const loadMetrics = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/metrics", { cache: "reload" });
      if (!res.ok) return;
      const j = await res.json();
      if (j.ok) setMetrics(j.metrics || []);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/metrics/health", { cache: "reload" });
      const j = await res.json();
      setHealth(j);
    } catch {
      setHealth({ ok: false, error: "Health check failed." });
    }
  }, []);

  useEffect(() => {
    void loadMetrics();
    void loadHealth();
  }, [loadMetrics, loadHealth]);

  const exportMetrics = () => {
    if (!metrics || metrics.length === 0) return;
    const data = metrics.map((m) => ({
      title: m.name,
      description: m.description || "",
      timerange: m.default_window,
      query: m.sql_text,
      chart: m.chart_type,
      xColumn: m.x_column,
      yColumns: m.y_columns,
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `metrics-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importMetrics = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text) as Array<{
        title: string;
        description?: string;
        timerange?: string;
        query: string;
        chart?: string;
        xColumn?: string;
        yColumns?: string[];
      }>;
      if (!Array.isArray(data)) throw new Error("Expected a JSON array.");
      for (const entry of data) {
        if (!entry.title || !entry.query) continue;
        await fetch("/api/metrics", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "createMetric",
            name: entry.title,
            description: entry.description || "",
            sql: entry.query,
            chartType: entry.chart || "bar",
            xColumn: entry.xColumn || "",
            yColumns: entry.yColumns || [],
            defaultWindow: entry.timerange || "monthly",
          }),
        });
      }
      await loadMetrics();
      setRefreshKey((k) => k + 1);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const openEdit = (m: MetricDef) => {
    setEditing({
      id: m.id,
      name: m.name,
      description: m.description || "",
      sql: m.sql_text,
      chartType: m.chart_type,
      xColumn: m.x_column,
      yColumns: m.y_columns,
      defaultWindow: (["hourly","daily","weekly","monthly","yearly"] as const).includes(m.default_window as never) ? m.default_window as "hourly"|"daily"|"weekly"|"monthly"|"yearly" : "monthly",
    });
    setEditorOpen(true);
  };

  const handleDelete = async (id: string) => {
    const res = await fetch("/api/metrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "deleteMetric", id }),
    });
    if (res.ok) {
      setDeleteTarget(null);
      await loadMetrics();
    }
  };

  const headerActions = (
    <>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {health === null ? null : health.ok ? (
          <>
            <span className="inline-block size-1.5 rounded-full bg-emerald-500" />
            <span>{health.database ?? "MySQL"}</span>
          </>
        ) : (
          <>
            <span className="inline-block size-1.5 rounded-full bg-rose-500" />
            <span className="text-rose-500">MySQL unreachable</span>
          </>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => { setRefreshKey((k) => k + 1); void loadMetrics(); void loadHealth(); }}
        aria-label="Refresh"
        title="Refresh"
      >
        <RefreshCwIcon className="size-4" />
      </Button>
      <input
        ref={importInputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void importMetrics(f); }}
      />
      <Button variant="ghost" size="sm" onClick={() => importInputRef.current?.click()} disabled={importing} className="gap-1.5 cursor-pointer" title="Import metrics from JSON">
        {importing ? <Loader2Icon className="size-4 animate-spin" /> : <UploadIcon className="size-4" />}
        Import
      </Button>
      <Button variant="ghost" size="sm" onClick={exportMetrics} disabled={!metrics || metrics.length === 0} className="gap-1.5 cursor-pointer" title="Export metrics as JSON">
        <DownloadIcon className="size-4" />
        Export
      </Button>
      <Button variant="outline" size="sm" onClick={openCreate} className="gap-1.5 cursor-pointer">
        <PlusIcon className="size-4" />
        New metric
      </Button>
    </>
  );

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      <PageHeader page="Metrics" actions={headerActions} />

      {/* Window pills sub-toolbar */}
      <div className="flex items-center gap-1 border-b px-5 py-2 bg-muted/[0.02]">
        {WINDOW_PILLS.map((p) => {
          const active = globalWindow === p.key;
          return (
            <button
              key={p.key}
              onClick={() => setGlobalWindow(p.key)}
              className={cn(
                "rounded-full px-3 py-1 text-[11px] font-medium transition-colors",
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

      {/* Body */}
      <div className="flex-1 overflow-auto p-5">
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            <Loader2Icon className="mr-2 size-4 animate-spin" /> Loading metrics…
          </div>
        ) : !health?.ok ? (
          <div className="grid h-full place-items-center">
            <div className="max-w-md rounded-xl border border-amber-500/40 bg-amber-500/5 p-5 text-center">
              <TriangleAlertIcon className="mx-auto size-6 text-amber-600" />
              <p className="mt-2 text-sm font-medium text-foreground">MySQL is not configured</p>
              <p className="mt-1 text-xs text-muted-foreground">{health?.error || "Unknown error."}</p>
              <p className="mt-3 rounded-md border bg-background/60 px-3 py-2 text-left text-[11px] text-muted-foreground">
                Add the credentials to{" "}
                <span className="font-mono text-foreground">{health?.secretsPath || "~/.config/openclaw/secrets.env"}</span>
                : <br />
                <span className="font-mono text-foreground">MYSQL_HOST</span>,{" "}
                <span className="font-mono text-foreground">MYSQL_USERNAME</span>,{" "}
                <span className="font-mono text-foreground">MYSQL_PASS</span>
              </p>
            </div>
          </div>
        ) : !metrics || metrics.length === 0 ? (
          <div className="grid h-full place-items-center">
            <div className="max-w-md text-center">
              <ChartBarIcon className="mx-auto size-10 text-muted-foreground/40" />
              <p className="mt-3 text-sm font-medium">No metrics yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Paste a SELECT, pick a chart, see it on this page. Reference{" "}
                <span className="font-mono">:since</span>, <span className="font-mono">:until</span>,{" "}
                <span className="font-mono">:bucket</span> for the window controls.
              </p>
              <Button onClick={openCreate} className="mt-4 gap-1.5">
                <PlusIcon className="size-4" /> Create your first metric
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-2 2xl:grid-cols-3 gap-4">
            {metrics.map((m) => (
              <MetricCard
                key={`${m.id}-${refreshKey}`}
                metric={m}
                globalWindow={globalWindow}
                dataAsOf={health?.dataAsOf ?? null}
                onEdit={() => openEdit(m)}
                onDelete={() => setDeleteTarget(m)}
              />
            ))}
          </div>
        )}
      </div>

      <MetricEditorModal
        open={editorOpen}
        initial={editing || undefined}
        onClose={() => setEditorOpen(false)}
        onSaved={() => { void loadMetrics(); setRefreshKey((k) => k + 1); }}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete metric?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground">{deleteTarget?.name}</span> will be permanently removed,
              along with its run history. The external MySQL data is not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => deleteTarget && void handleDelete(deleteTarget.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
