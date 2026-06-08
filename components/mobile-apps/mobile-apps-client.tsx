"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useModules } from "@/components/modules/modules-provider";
import { AddAppDialog } from "@/components/mobile-apps/add-app-dialog";
import { AppCard, type AppSummary } from "@/components/mobile-apps/app-card";
import { StoreConfigBanner } from "@/components/mobile-apps/store-config-banner";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function MobileAppsClient() {
  const router = useRouter();
  const { ready, isEnabled } = useModules();
  useEffect(() => {
    if (ready && !isEnabled("mobile-apps")) router.replace("/settings#modules");
  }, [ready, isEnabled, router]);

  const [apps, setApps] = useState<AppSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/mobile-apps", { cache: "no-store" });
      const json = await res.json();
      if (json.ok) setApps(json.apps as AppSummary[]);
      else toast.error(json.error ?? "Failed to load apps");
    } catch {
      toast.error("Failed to load apps");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load(); // show cached immediately
      await fetch("/api/mobile-apps/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }).catch(() => null);
      if (!cancelled) await load(); // revalidate
    })().catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function refreshAll() {
    setSyncing(true);
    try {
      await fetch("/api/mobile-apps/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      await load();
      toast.success("Synced");
    } catch {
      toast.error("Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 overflow-auto p-4 md:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Mobile Applications</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={refreshAll} disabled={syncing}>
            {syncing ? "Syncing…" : "Refresh now"}
          </Button>
          <AddAppDialog onAdded={load} />
        </div>
      </div>

      <StoreConfigBanner />

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : apps.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No apps yet. Add one to start tracking reviews and ratings.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map((a) => (
            <AppCard key={a.id} app={a} />
          ))}
        </div>
      )}
    </div>
  );
}
