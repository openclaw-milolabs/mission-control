"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconBrandApple, IconBrandGooglePlay, IconStarFilled } from "@tabler/icons-react";
import { PageHeader } from "@/components/layout/page-header";
import { StoreConfigBanner } from "@/components/mobile-apps/store-config-banner";
import { ReviewsStream } from "@/components/mobile-apps/reviews-stream";
import { RatingDistribution } from "@/components/mobile-apps/rating-distribution";
import { RatingTrend, type TrendPoint } from "@/components/mobile-apps/rating-trend";
import { SentimentDigest } from "@/components/mobile-apps/sentiment-digest";
import { countryName, flagEmoji } from "@/lib/mobile-apps/country-codes";
import { useModules } from "@/components/modules/modules-provider";
import { toast } from "sonner";

type StoreKey = "apple" | "google";
type Filter = "" | StoreKey;

type Listing = {
  id: string;
  store: string;
  store_app_id: string;
  country: string;
  current_rating: number | null;
  ratings_count: number | null;
  official_ratings: TerritoryRating[] | null;
  last_synced_at: string | null;
};

type TerritoryRating = { territory: string; avg: number | null; count: number | null };

type Summary = {
  store: string;
  total: number;
  avg_rating: number | null;
  r1: number; r2: number; r3: number; r4: number; r5: number;
  negative: number;
  latest_review_at: string | null;
};

type TrendRow = { store: string; day: string; avg: number; count: number };

type SyncRun = {
  listing_id: string;
  store: string;
  status: "running" | "success" | "failed";
  finished_at: string | null;
  fetched_count: number;
  upserted_count: number;
  error_message: string | null;
};

const STORE_META: Record<StoreKey, { label: string; Icon: typeof IconBrandApple }> = {
  apple: { label: "App Store", Icon: IconBrandApple },
  google: { label: "Google Play", Icon: IconBrandGooglePlay },
};

function lastSync(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

function Stars({ n, size = "size-4" }: { n: number | null; size?: string }) {
  const count = Math.max(0, Math.min(5, Math.round(n ?? 0)));
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <IconStarFilled key={i} className={`${size} ${i < count ? "text-amber-500" : "text-foreground/15"}`} />
      ))}
    </span>
  );
}

function StoreScoreCard({
  store,
  summary,
  listing,
  run,
  negativeThreshold,
}: {
  store: StoreKey;
  summary: Summary | undefined;
  listing: Listing | undefined;
  run: SyncRun | undefined;
  negativeThreshold: number;
}) {
  const { label, Icon } = STORE_META[store];
  const counts: [number, number, number, number, number] = [
    summary?.r1 ?? 0, summary?.r2 ?? 0, summary?.r3 ?? 0, summary?.r4 ?? 0, summary?.r5 ?? 0,
  ];
  const total = summary?.total ?? 0;
  const failed = run?.status === "failed";
  const official = listing?.current_rating ?? null; // Apple: official storefront average; Google: null
  const officialCount = listing?.ratings_count ?? null;
  const territories = (listing?.official_ratings ?? []).filter((t) => t.avg != null);

  return (
    <div className="rounded-2xl border bg-card p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Icon className="size-4" />
          {label}
        </div>
        <span
          className={`flex items-center gap-1.5 text-xs ${failed ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}
          title={run?.error_message ?? undefined}
        >
          <span className={`size-1.5 rounded-full ${failed ? "bg-red-500" : "bg-emerald-500"}`} />
          {failed ? "sync failed" : lastSync(listing?.last_synced_at ?? null)}
        </span>
      </div>

      {/* Official headline rating */}
      <div className="mt-5 flex items-end gap-4">
        <span className="text-5xl font-semibold leading-none tracking-tight tabular-nums">
          {official != null ? official.toFixed(1) : "—"}
        </span>
        <div className="pb-1">
          <Stars n={official} size="size-4" />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {store === "apple"
              ? official != null
                ? `official · ${officialCount?.toLocaleString() ?? "—"} ratings`
                : "no rating from the App Store API yet"
              : "Google's API has no aggregate rating"}
          </p>
        </div>
      </div>

      {/* Per-storefront official ratings (Apple) */}
      {territories.length > 0 ? (
        <div className="mt-5 border-t pt-4">
          <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            By storefront
          </p>
          <ul className="space-y-2">
            {territories.map((t) => (
              <li key={t.territory} className="flex items-center gap-2.5 text-sm">
                <span className="text-base leading-none">{flagEmoji(t.territory)}</span>
                <span className="min-w-0 flex-1 truncate text-foreground/80">{countryName(t.territory)}</span>
                <Stars n={t.avg} size="size-3" />
                <span className="w-9 text-right font-semibold tabular-nums">{t.avg != null ? t.avg.toFixed(1) : "—"}</span>
                <span className="w-12 text-right text-xs text-muted-foreground tabular-nums">
                  {t.count != null ? t.count.toLocaleString() : "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Distribution of the reviews we fetched (not the official rating) */}
      <div className="mt-5 border-t pt-4">
        <div className="mb-2.5 flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Review breakdown</p>
          <p className="text-[11px] text-muted-foreground/70">
            {total.toLocaleString()} fetched
            {summary && summary.negative > 0 ? ` · ${summary.negative} ≤${negativeThreshold}★` : ""}
          </p>
        </div>
        <RatingDistribution counts={counts} />
      </div>
    </div>
  );
}

export function AppDetailClient({ appId }: { appId: string }) {
  const router = useRouter();
  const { ready, isEnabled } = useModules();
  const [app, setApp] = useState<{ id: string; name: string; icon_url: string | null } | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [summary, setSummary] = useState<Summary[]>([]);
  const [trend, setTrend] = useState<TrendRow[]>([]);
  const [syncRuns, setSyncRuns] = useState<SyncRun[]>([]);
  const [negativeThreshold, setNegativeThreshold] = useState(3);
  const [store, setStore] = useState<Filter>("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [digest, setDigest] = useState<{ summary_md: string; created_at: string } | null>(null);
  const [genBusy, setGenBusy] = useState(false);

  useEffect(() => {
    if (ready && !isEnabled("mobile-apps")) router.replace("/settings#modules");
  }, [ready, isEnabled, router]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/mobile-apps/${appId}`, { cache: "no-store" });
      const json = await res.json();
      if (json.ok) {
        setApp(json.app ?? null);
        setListings(json.listings ?? []);
        setSummary(json.summary ?? []);
        setTrend(json.trend ?? []);
        setSyncRuns(json.syncRuns ?? []);
        setNegativeThreshold(json.negativeThreshold ?? 3);
      } else {
        toast.error(json.error ?? "Failed to load app");
      }
    } catch {
      toast.error("Failed to load app");
    }
  }, [appId]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    void load();
  }, [load]);

  // Live sync on mount, then revalidate.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await fetch("/api/mobile-apps/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId }),
      }).catch(() => null);
      if (!cancelled) {
        await loadRef.current();
        setRefreshKey((k) => k + 1);
      }
    })().catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [appId]);

  // SSE live updates.
  useEffect(() => {
    const es = new EventSource("/api/mobile-apps/stream");
    es.addEventListener("change", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data || "{}");
        if (!data.appId || data.appId === appId) {
          void loadRef.current();
          setRefreshKey((k) => k + 1);
        }
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

  const availableStores = useMemo(
    () => listings.map((l) => l.store).filter((s): s is StoreKey => s === "apple" || s === "google"),
    [listings],
  );
  const shownStores = store ? [store] : availableStores;

  // Facts only (counts), never a computed average — the rating shown is the
  // official per-store value in each card.
  const combined = useMemo(() => {
    const rows = store ? summary.filter((s) => s.store === store) : summary;
    const total = rows.reduce((a, r) => a + r.total, 0);
    const negative = rows.reduce((a, r) => a + r.negative, 0);
    return { total, negative };
  }, [summary, store]);

  const trendData: TrendPoint[] = useMemo(() => {
    const rows = store ? trend.filter((t) => t.store === store) : trend;
    if (store) return rows.map((t) => ({ day: t.day, avg: t.avg, count: t.count }));
    const byDay = new Map<string, { sum: number; count: number }>();
    for (const r of rows) {
      const b = byDay.get(r.day) ?? { sum: 0, count: 0 };
      b.sum += r.avg * r.count;
      b.count += r.count;
      byDay.set(r.day, b);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, b]) => ({ day, avg: Math.round((b.sum / b.count) * 100) / 100, count: b.count }));
  }, [trend, store]);

  const lastSyncedAt = useMemo(
    () => listings.map((l) => l.last_synced_at).filter(Boolean).sort().at(-1) ?? null,
    [listings],
  );

  const storeAppIds = useMemo(() => {
    const m: Record<string, string> = {};
    for (const l of listings) m[l.store] = l.store_app_id;
    return m;
  }, [listings]);

  const headerActions = (
    <div className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
      {([["", "All"], ["apple", "App Store"], ["google", "Google Play"]] as const).map(([val, label]) => (
        <button
          key={val}
          onClick={() => setStore(val)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            store === val ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <PageHeader
        page={app?.name ?? "App"}
        crumbs={[{ label: "Mobile Apps", href: "/mobile-apps" }]}
        actions={headerActions}
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-5">
          {/* Masthead */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              {app?.icon_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={app.icon_url} alt="" className="size-14 rounded-2xl border" />
              ) : (
                <div className="grid size-14 place-items-center rounded-2xl border bg-muted text-lg font-semibold text-muted-foreground">
                  {(app?.name ?? "?").slice(0, 1).toUpperCase()}
                </div>
              )}
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">{app?.name ?? "App"}</h1>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {availableStores.length > 0
                    ? availableStores.map((s) => STORE_META[s].label).join(" · ")
                    : "No store listings"}
                  {lastSyncedAt ? ` · synced ${lastSync(lastSyncedAt)}` : ""}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-6">
              <Metric value={combined.total.toLocaleString()} label="Reviews fetched" />
              <div className="h-9 w-px bg-border" />
              <Metric
                value={combined.negative.toLocaleString()}
                label={`Negative ≤${negativeThreshold}★`}
                danger={combined.negative > 0}
              />
            </div>
          </div>

          <StoreConfigBanner />

          {/* Store score cards */}
          {shownStores.length > 0 ? (
            <div className={`grid gap-5 ${shownStores.length > 1 ? "sm:grid-cols-2" : "max-w-lg"}`}>
              {shownStores.map((s) => (
                <StoreScoreCard
                  key={s}
                  store={s}
                  summary={summary.find((x) => x.store === s)}
                  listing={listings.find((x) => x.store === s)}
                  run={syncRuns.find((x) => x.store === s)}
                  negativeThreshold={negativeThreshold}
                />
              ))}
            </div>
          ) : null}

          {/* Main: reviews + rail */}
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <ReviewsStream appId={appId} store={store} refreshKey={refreshKey} storeAppIds={storeAppIds} />
            </div>
            <div className="flex flex-col gap-5">
              <section className="rounded-xl border bg-card p-4">
                <div className="mb-3">
                  <h2 className="text-sm font-semibold">Review ratings over time</h2>
                  <p className="text-[11px] text-muted-foreground/70">Average of fetched reviews, not the store rating</p>
                </div>
                <RatingTrend data={trendData} />
              </section>
              <SentimentDigest
                summaryMd={digest?.summary_md ?? null}
                createdAt={digest?.created_at ?? null}
                busy={genBusy}
                onGenerate={() => void generate()}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Metric({
  value,
  label,
  accent,
  danger,
}: {
  value: string;
  label: string;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span
        className={`text-xl font-semibold tabular-nums leading-none ${
          danger ? "text-red-600 dark:text-red-400" : accent ? "text-foreground" : "text-foreground"
        }`}
      >
        {value}
      </span>
      <span className="mt-1 text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
