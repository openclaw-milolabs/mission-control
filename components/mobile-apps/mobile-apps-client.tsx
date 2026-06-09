"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { IconDeviceMobile } from "@tabler/icons-react";
import { useModules } from "@/components/modules/modules-provider";
import { AddAppDialog } from "@/components/mobile-apps/add-app-dialog";
import { AppCard, type AppSummary } from "@/components/mobile-apps/app-card";
import { StoreConfigBanner } from "@/components/mobile-apps/store-config-banner";
import { PageHeader } from "@/components/layout/page-header";
import { toast } from "sonner";

export function MobileAppsClient() {
  const router = useRouter();
  const { ready, isEnabled } = useModules();
  useEffect(() => {
    if (ready && !isEnabled("mobile-apps")) router.replace("/settings#modules");
  }, [ready, isEnabled, router]);

  const [apps, setApps] = useState<AppSummary[]>([]);
  const [loading, setLoading] = useState(true);

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

  // The list page only READS. It deliberately does not trigger any sync: light
  // review/rating refresh happens on the app detail page, and heavy Google report
  // ETL is worker-owned. This keeps opening /mobile-apps free of store API calls.
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader page="Mobile Apps" actions={<AddAppDialog onAdded={load} />} />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          <StoreConfigBanner />

          {loading ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 rounded-xl border bg-card px-4 py-3.5">
                  <div className="size-11 animate-pulse rounded-xl bg-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3.5 w-40 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-24 animate-pulse rounded bg-muted" />
                  </div>
                </div>
              ))}
            </div>
          ) : apps.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-16 text-center">
              <div className="grid size-12 place-items-center rounded-2xl bg-muted">
                <IconDeviceMobile className="size-6 text-muted-foreground" />
              </div>
              <h2 className="mt-4 text-base font-semibold">Track your first app</h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Add an App Store or Google Play listing to pull in ratings and reviews from the official store APIs.
              </p>
              <div className="mt-4">
                <AddAppDialog onAdded={load} />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {apps.map((a) => (
                <AppCard key={a.id} app={a} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
