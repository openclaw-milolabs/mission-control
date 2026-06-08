"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { Button } from "@/components/ui/button";
import { ReviewCard, type ReviewRow } from "@/components/mobile-apps/review-card";
import { StoreConfigBanner } from "@/components/mobile-apps/store-config-banner";
import { useModules } from "@/components/modules/modules-provider";
import { toast } from "sonner";

type Listing = {
  id: string;
  store: string;
  current_rating: number | null;
  ratings_count: number | null;
  last_synced_at: string | null;
};

type Snapshot = {
  listing_id: string;
  store: string;
  captured_at: string;
  avg_rating: number | null;
  ratings_count: number | null;
  histogram: Record<string, number> | null;
};

type SyncRun = {
  listing_id: string;
  store: string;
  status: "running" | "success" | "failed";
  started_at: string;
  finished_at: string | null;
  fetched_count: number;
  upserted_count: number;
  error_message: string | null;
};

const METRIC_LABEL: Record<string, string> = {
  avg_rating: "Avg rating",
  one_star_spike: "1★ reviews today",
  review_volume: "Reviews today",
};
const OP_SYMBOL: Record<string, string> = {
  lt: "<", lte: "≤", gt: ">", gte: "≥", eq: "=",
};
function formatRule(metric: string, operator: string, threshold: number): string {
  return `${METRIC_LABEL[metric] ?? metric} ${OP_SYMBOL[operator] ?? operator} ${threshold}`;
}

export function AppDetailClient({ appId }: { appId: string }) {
  const router = useRouter();
  const { ready, isEnabled } = useModules();
  const [app, setApp] = useState<{ id: string; name: string; icon_url: string | null } | null>(
    null,
  );
  const [listings, setListings] = useState<Listing[]>([]);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [syncRuns, setSyncRuns] = useState<SyncRun[]>([]);
  const [store, setStore] = useState<"" | "apple" | "google">("");
  const [minRating, setMinRating] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [digest, setDigest] = useState<{ summary_md: string; created_at: string } | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const [rules, setRules] = useState<Array<{ id: string; metric: string; operator: string; threshold: number; enabled: boolean; mobile_app_id: string | null }>>([]);
  const [newThreshold, setNewThreshold] = useState(4.0);

  useEffect(() => {
    if (ready && !isEnabled("mobile-apps")) router.replace("/settings#modules");
  }, [ready, isEnabled, router]);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (store) params.set("store", store);
      if (minRating) params.set("minRating", String(minRating));
      const res = await fetch(`/api/mobile-apps/${appId}?${params.toString()}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        app?: { id: string; name: string; icon_url: string | null };
        listings?: Listing[];
        reviews?: ReviewRow[];
        snapshots?: Snapshot[];
        syncRuns?: SyncRun[];
      };
      if (json.ok) {
        setApp(json.app ?? null);
        setListings(json.listings ?? []);
        setReviews(json.reviews ?? []);
        setSnapshots(json.snapshots ?? []);
        setSyncRuns(json.syncRuns ?? []);
      } else {
        toast.error(json.error ?? "Failed to load app");
      }
    } catch {
      toast.error("Failed to load app");
    }
  }, [appId, store, minRating]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    void load();
  }, [load]);

  // Stale-while-revalidate: live sync this app on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await fetch("/api/mobile-apps/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId }),
      }).catch(() => null);
      if (!cancelled) await load();
    })().catch(() => null);
    return () => {
      cancelled = true;
    };
    // Intentionally omit `load` from deps: this sync must run once per appId,
    // not on every filter change. load() is invoked explicitly after the sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  // SSE live updates: reload when this app is synced in another tab/process.
  useEffect(() => {
    const es = new EventSource("/api/mobile-apps/stream");
    es.addEventListener("change", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data || "{}");
        if (!data.appId || data.appId === appId) void loadRef.current();
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }, [appId]);

  const loadDigest = useCallback(async () => {
    try {
      const res = await fetch(`/api/mobile-apps/${appId}/digest`, { cache: "no-store" });
      const json = await res.json();
      if (json.ok && json.digests?.[0]) setDigest(json.digests[0]);
    } catch {
      /* ignore */
    }
  }, [appId]);

  useEffect(() => {
    void loadDigest();
  }, [loadDigest]);

  const loadRules = useCallback(async () => {
    try {
      const res = await fetch("/api/mobile-apps/alerts", { cache: "no-store" });
      const json = await res.json();
      if (json.ok) setRules(json.rules);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  async function addRule() {
    try {
      const res = await fetch("/api/mobile-apps/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mobileAppId: appId, metric: "avg_rating", operator: "lt", threshold: newThreshold }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Failed");
      await loadRules();
      toast.success("Alert added");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add alert");
    }
  }
  async function deleteRule(id: string) {
    try {
      const res = await fetch("/api/mobile-apps/alerts", {
        method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Failed to delete alert");
      await loadRules();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete alert");
    }
  }

  async function refresh() {
    setSyncing(true);
    try {
      await fetch("/api/mobile-apps/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId, force: true }),
      });
      await load();
      toast.success("Synced");
    } catch {
      toast.error("Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function generate() {
    setGenBusy(true);
    try {
      const res = await fetch(`/api/mobile-apps/${appId}/digest`, { method: "POST" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Failed");
      await loadDigest();
      toast.success("Digest generated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to generate digest");
    } finally {
      setGenBusy(false);
    }
  }

  const chartData = useMemo(() => {
    return snapshots
      .filter((s) => !store || s.store === store)
      .map((s) => ({
        t: new Date(s.captured_at).toLocaleDateString(),
        rating: s.avg_rating != null ? Number(s.avg_rating) : null,
        store: s.store,
      }));
  }, [snapshots, store]);

  const histogram = useMemo(() => {
    const filtered = snapshots.filter((s) => (!store || s.store === store) && s.histogram);
    const latest = filtered[filtered.length - 1];
    return latest?.histogram ?? null;
  }, [snapshots, store]);

  const histogramTotal = useMemo(
    () => (histogram ? Object.values(histogram).reduce((a, b) => a + Number(b), 0) || 1 : 1),
    [histogram],
  );

  return (
    <div className="flex flex-col gap-4 overflow-auto p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {app?.icon_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={app.icon_url} alt="" className="size-10 rounded-lg" />
          ) : null}
          <h1 className="text-xl font-semibold">{app?.name ?? "App"}</h1>
        </div>
        <Button variant="outline" onClick={() => void refresh()} disabled={syncing}>
          {syncing ? "Syncing…" : "Refresh now"}
        </Button>
      </div>

      <StoreConfigBanner />

      {syncRuns.length > 0 ? (
        <div className="rounded-xl border bg-card p-4">
          <h2 className="mb-2 text-sm font-medium">Sync health</h2>
          <ul className="space-y-1 text-xs">
            {syncRuns.map((run) => (
              <li key={run.listing_id} className="flex flex-wrap items-center gap-2">
                <span className="w-20 capitalize text-muted-foreground">{run.store}</span>
                <span
                  className={
                    run.status === "success"
                      ? "rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-400"
                      : run.status === "failed"
                        ? "rounded bg-red-500/15 px-1.5 py-0.5 text-red-700 dark:text-red-400"
                        : "rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
                  }
                >
                  {run.status}
                </span>
                <span className="text-muted-foreground">
                  {run.finished_at ? new Date(run.finished_at).toLocaleString() : "in progress"}
                </span>
                {run.status === "success" ? (
                  <span className="text-muted-foreground">
                    · {run.fetched_count} fetched, {run.upserted_count} new
                  </span>
                ) : null}
                {run.error_message ? (
                  <span className="text-red-600 dark:text-red-400">· {run.error_message}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          aria-label="Filter by store"
          className="rounded-md border bg-background px-2 py-1"
          value={store}
          onChange={(e) => setStore(e.target.value as "" | "apple" | "google")}
        >
          <option value="">All stores</option>
          <option value="apple">App Store</option>
          <option value="google">Google Play</option>
        </select>
        <select
          aria-label="Minimum rating"
          className="rounded-md border bg-background px-2 py-1"
          value={minRating}
          onChange={(e) => setMinRating(Number(e.target.value))}
        >
          <option value={0}>Any rating</option>
          <option value={1}>★ 1+</option>
          <option value={2}>★ 2+</option>
          <option value={3}>★ 3+</option>
          <option value={4}>★ 4+</option>
          <option value={5}>★ 5 only</option>
        </select>
        {listings.map((l) => (
          <span key={l.id} className="rounded-md border px-2 py-1 text-xs capitalize">
            {l.store}: {l.current_rating?.toFixed(2) ?? "—"} (
            {l.ratings_count?.toLocaleString() ?? "—"})
          </span>
        ))}
      </div>

      <div className="rounded-xl border bg-card p-4">
        <h2 className="mb-2 text-sm font-medium">Rating over time</h2>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="t" fontSize={11} />
              <YAxis domain={[0, 5]} fontSize={11} />
              <Tooltip />
              <Line
                type="monotone"
                dataKey="rating"
                stroke="var(--chart-1)"
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {histogram ? (
        <div className="rounded-xl border bg-card p-4">
          <h2 className="mb-2 text-sm font-medium">Star distribution</h2>
          <div className="space-y-1">
            {[5, 4, 3, 2, 1].map((star) => {
              const v = Number(histogram[String(star)] ?? 0);
              return (
                <div key={star} className="flex items-center gap-2 text-xs">
                  <span className="w-6">{star}★</span>
                  <div className="h-2 flex-1 rounded bg-muted">
                    <div
                      className="h-2 rounded bg-amber-500"
                      style={{ width: `${(v / histogramTotal) * 100}%` }}
                    />
                  </div>
                  <span className="w-12 text-right text-muted-foreground">
                    {v.toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="rounded-xl border bg-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">Sentiment digest</h2>
          <Button size="sm" variant="outline" onClick={() => void generate()} disabled={genBusy}>
            {genBusy ? "Generating…" : "Generate digest now"}
          </Button>
        </div>
        {digest ? (
          <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm text-muted-foreground">
            {digest.summary_md}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No digest yet. Generate one from the latest reviews.</p>
        )}
      </div>

      <div className="rounded-xl border bg-card p-4">
        <h2 className="mb-2 text-sm font-medium">Alerts</h2>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span>Notify when average rating drops below</span>
          <input
            type="number" step="0.1" min={0} max={5}
            aria-label="Average rating threshold"
            className="w-20 rounded-md border bg-background px-2 py-1"
            value={newThreshold}
            onChange={(e) => setNewThreshold(Number(e.target.value))}
          />
          <Button size="sm" variant="outline" onClick={() => void addRule()}>Add alert</Button>
        </div>
        <ul className="space-y-1 text-sm">
          {rules.filter((r) => r.mobile_app_id === appId || r.mobile_app_id == null).map((r) => (
            <li key={r.id} className="flex items-center justify-between rounded border px-2 py-1">
              <span>{formatRule(r.metric, r.operator, r.threshold)}{r.enabled ? "" : " (disabled)"}</span>
              <Button size="sm" variant="ghost" onClick={() => void deleteRule(r.id)}>Remove</Button>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-medium">Reviews ({reviews.length})</h2>
        {reviews.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No reviews match the current filters.
          </p>
        ) : (
          reviews.map((r) => <ReviewCard key={r.id} review={r} />)
        )}
      </div>
    </div>
  );
}
