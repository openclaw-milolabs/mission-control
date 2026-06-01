"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2Icon, BoxIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useModules, type ModuleSummary } from "@/components/modules/modules-provider";

type ImpactPreview = {
  counts: Array<{ icon: string; label: string; n: number }>;
  bytesOnDisk: number | null;
  sampleAffected: Array<{ kind: string; label: string; context?: string }>;
  finalWarning: string;
};

function bytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function relTime(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function ModulesSection() {
  const { modules, reload } = useModules();
  const [disableTarget, setDisableTarget] = useState<ModuleSummary | null>(null);
  const [enableTarget, setEnableTarget] = useState<ModuleSummary | null>(null);

  return (
    <section id="modules">
      <div className="mb-6">
        <h2 className="text-lg font-semibold tracking-tight">Modules</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Toggle non-core modules on or off. Core modules are required and cannot be disabled.
          Disabling a module permanently deletes its data.
        </p>
      </div>

      {modules.length === 0 ? (
        <div className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">
          Loading modules…
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {modules.map((m) => (
            <ModuleCard
              key={m.id}
              mod={m}
              onDisableClick={() => setDisableTarget(m)}
              onEnableClick={() => setEnableTarget(m)}
            />
          ))}
        </div>
      )}

      {disableTarget && (
        <DisableModuleDialog
          mod={disableTarget}
          onClose={() => setDisableTarget(null)}
          onDone={async () => {
            setDisableTarget(null);
            await reload();
          }}
        />
      )}

      {enableTarget && (
        <EnableModuleDialog
          mod={enableTarget}
          onClose={() => setEnableTarget(null)}
          onDone={async () => {
            setEnableTarget(null);
            await reload();
          }}
        />
      )}
    </section>
  );
}

function ModuleCard({
  mod,
  onDisableClick,
  onEnableClick,
}: {
  mod: ModuleSummary;
  onDisableClick: () => void;
  onEnableClick: () => void;
}) {
  return (
    <div className="flex items-start gap-4 rounded-xl border bg-card p-4">
      <div className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg",
        mod.enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
      )}>
        <BoxIcon className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{mod.name}</h3>
          {mod.core ? (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Core
            </span>
          ) : mod.enabled ? (
            <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
              Enabled
            </span>
          ) : (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Disabled
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{mod.description}</p>
        {mod.enabled && mod.enabledByName && (
          <p className="mt-2 text-[10px] text-muted-foreground/70">
            Enabled by {mod.enabledByName} · {relTime(mod.enabledAt)}
          </p>
        )}
        {!mod.enabled && mod.disabledByName && (
          <p className="mt-2 text-[10px] text-muted-foreground/70">
            Disabled by {mod.disabledByName} · {relTime(mod.disabledAt)}
          </p>
        )}
      </div>
      <div className="shrink-0">
        {mod.core ? (
          <button
            type="button"
            disabled
            aria-disabled
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 cursor-not-allowed rounded-full border-2 border-transparent transition-colors bg-muted opacity-40",
            )}
            title="Core modules cannot be disabled"
          >
            <span className="pointer-events-none inline-block size-5 translate-x-5 rounded-full bg-white shadow-lg ring-0 transition-transform" />
          </button>
        ) : (
          <button
            type="button"
            role="switch"
            aria-checked={mod.enabled}
            onClick={mod.enabled ? onDisableClick : onEnableClick}
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
              mod.enabled ? "bg-primary" : "bg-muted",
            )}
          >
            <span className={cn(
              "pointer-events-none inline-block size-5 rounded-full bg-white shadow-lg ring-0 transition-transform",
              mod.enabled ? "translate-x-5" : "translate-x-0",
            )} />
          </button>
        )}
      </div>
    </div>
  );
}

function DisableModuleDialog({
  mod, onClose, onDone,
}: {
  mod: ModuleSummary;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [preview, setPreview] = useState<ImpactPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/modules", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "previewDisable", moduleId: mod.id }),
        });
        const j = await res.json();
        if (j.ok) setPreview(j.preview);
        else setError(j.error || "Failed to load impact preview.");
      } finally {
        setLoading(false);
      }
    })();
  }, [mod.id]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/modules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "disable", moduleId: mod.id, confirmName: confirmText }),
      });
      const j = await res.json();
      if (!j.ok) {
        setError(j.error || "Failed to disable.");
        return;
      }
      toast.success(`${mod.name} disabled`, { description: "All data permanently deleted." });
      await onDone();
    } finally {
      setBusy(false);
    }
  }, [mod.id, mod.name, confirmText, onDone]);

  const canConfirm = confirmText === mod.id && !busy;

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlertIcon className="size-5 text-destructive" />
            Disable {mod.name}?
          </DialogTitle>
          <DialogDescription>
            This permanently deletes the module&apos;s data. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
            <Loader2Icon className="mr-2 size-4 animate-spin" /> Computing impact…
          </div>
        ) : preview ? (
          <div className="space-y-3 text-sm">
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                This will permanently delete
              </p>
              <ul className="space-y-1">
                {preview.counts.map((c) => (
                  <li key={c.label} className="flex items-center gap-2 text-xs">
                    <span>{c.icon}</span>
                    <span className="tabular-nums font-semibold">{c.n}</span>
                    <span className="text-muted-foreground">{c.label}</span>
                  </li>
                ))}
                {preview.bytesOnDisk != null && preview.bytesOnDisk > 0 && (
                  <li className="flex items-center gap-2 text-xs">
                    <span>💾</span>
                    <span className="tabular-nums font-semibold">{bytes(preview.bytesOnDisk)}</span>
                    <span className="text-muted-foreground">on disk</span>
                  </li>
                )}
              </ul>
            </div>

            {preview.sampleAffected.length > 0 && (
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Affected items
                </p>
                <ul className="space-y-0.5 text-xs">
                  {preview.sampleAffected.map((s, i) => (
                    <li key={i} className="truncate text-muted-foreground">
                      • <span className="text-foreground">{s.label}</span>
                      {s.context && <span className="text-muted-foreground/70"> ({s.context})</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {preview.finalWarning && (
              <p className="text-xs leading-relaxed text-destructive">{preview.finalWarning}</p>
            )}

            <div className="pt-2">
              <label className="mb-1.5 block text-xs">
                Type <span className="font-mono font-semibold">{mod.id}</span> to confirm:
              </label>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={mod.id}
                autoFocus
              />
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        ) : (
          <p className="text-xs text-destructive">{error || "No preview available."}</p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={!canConfirm}
            onClick={() => void submit()}
          >
            {busy ? "Disabling…" : "Disable module"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EnableModuleDialog({
  mod, onClose, onDone,
}: {
  mod: ModuleSummary;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/modules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "enable", moduleId: mod.id }),
      });
      const j = await res.json();
      if (!j.ok) {
        setError(j.error || "Failed to enable.");
        return;
      }
      toast.success(`${mod.name} enabled`);
      await onDone();
    } finally {
      setBusy(false);
    }
  }, [mod.id, mod.name, onDone]);

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Enable {mod.name}?</DialogTitle>
          <DialogDescription>
            Recreates the module&apos;s tables and on-disk paths if missing. Starts empty.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "Enabling…" : "Enable module"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
