"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

export function AppDetailClient({ appId }: { appId: string }) {
  const router = useRouter();
  const { ready, isEnabled } = useModules();
  const [app, setApp] = useState<{ id: string; name: string; icon_url: string | null } | null>(
    null,
  );
  const [listings, setListings] = useState<Listing[]>([]);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [store, setStore] = useState<"" | "apple" | "google">("");
  const [minRating, setMinRating] = useState(0);
  const [syncing, setSyncing] = useState(false);

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
      };
      if (json.ok) {
        setApp(json.app ?? null);
        setListings(json.listings ?? []);
        setReviews(json.reviews ?? []);
        setSnapshots(json.snapshots ?? []);
      } else {
        toast.error(json.error ?? "Failed to load app");
      }
    } catch {
      toast.error("Failed to load app");
    }
  }, [appId, store, minRating]);

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
