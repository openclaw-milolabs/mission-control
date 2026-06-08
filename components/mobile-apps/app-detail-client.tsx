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
import { PlayReportsCard, type ReportPoint, type TrafficSource, type ReportFileRow, type ReportBreakdown } from "@/components/mobile-apps/play-reports-card";
import { countryName, flagEmoji, toAlpha2 } from "@/lib/mobile-apps/country-codes";
import { formatDate } from "@/lib/format-date";
import { useModules } from "@/components/modules/modules-provider";
import { toast } from "sonner";

type StoreKey = "apple" | "google";
type Filter = StoreKey;

type Listing = {
  id: string;
  store: string;
  store_app_id: string;
  country: string;
  current_rating: number | null;
  ratings_count: number | null;
  official_ratings: TerritoryRating[] | null;
  rating_source: string | null;
  rating_as_of: string | null;
  store_metadata: AppMetadata | null;
  last_synced_at: string | null;
};

type TerritoryRating = { territory: string; avg: number | null; count: number | null; review_count?: number | null };

type AppMetadata = {
  version: string | null;
  releaseDate: string | null;
  currentVersionReleaseDate: string | null;
  releaseNotes: string | null;
  fileSizeBytes: number | null;
  primaryGenre: string | null;
  genres: string[];
  contentRating: string | null;
  formattedPrice: string | null;
  currency: string | null;
  sellerName: string | null;
  minimumOsVersion: string | null;
  languages: string[];
  screenshotCount: number | null;
  artworkUrl: string | null;
  currentVersionAvg: number | null;
  currentVersionCount: number | null;
};

/** jsonb can arrive as an object, a JSON string, or null depending on the driver. */
function asMetadata(v: unknown): AppMetadata | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as AppMetadata;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" && !Array.isArray(p) ? (p as AppMetadata) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** jsonb can arrive as an array, a JSON string, or null depending on the driver. */
function asTerritoryRatings(v: unknown): TerritoryRating[] {
  if (Array.isArray(v)) return v as TerritoryRating[];
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as TerritoryRating[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

type Summary = {
  store: string;
  total: number;
  avg_rating: number | null;
  r1: number; r2: number; r3: number; r4: number; r5: number;
  negative: number;
  responded: number;
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
  report_status?: string | null;
  report_warnings?: unknown;
};

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

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
  const isApple = store === "apple";
  const territories = (listing?.official_ratings ?? []).filter((t) => t.avg != null || t.review_count != null);
  const fromReport = listing?.rating_source === "google_play_console_ratings_report";

  // Google with no ratings report: the only number available is the average of
  // stored written reviews — explicitly NOT a store-wide rating. Every other case
  // (Apple, or Google with a Play Console ratings report) has a real, official
  // per-country rating we can show and switch between.
  const writtenOnly = !isApple && !fromReport;

  // The headline shows ONE country's official rating. Default to the listing's
  // country, else the first country that actually has a rating. Tapping a row
  // below switches it. We never synthesize a cross-country average — averaging
  // per-country averages is statistically meaningless and not an official number.
  const ratingTerritories = territories.filter((t) => t.avg != null);
  const defaultTerr =
    ratingTerritories.find((t) => t.territory === toAlpha2(listing?.country))?.territory ??
    ratingTerritories[0]?.territory ??
    null;
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? defaultTerr;
  const selEntry = territories.find((t) => t.territory === selected) ?? null;

  const headlineAvg = writtenOnly
    ? listing?.current_rating ?? null
    : selEntry?.avg ?? listing?.current_rating ?? null;
  // Apple exposes a per-country ratings count; the Google ratings report does not.
  const headlineCount = writtenOnly ? listing?.ratings_count ?? null : selEntry?.count ?? null;
  const storeLabel = isApple ? "App Store" : "Google Play";
  const headlineLabel = writtenOnly
    ? "Google Play written-review average"
    : selEntry
      ? `${countryName(selected)} · ${storeLabel} rating`
      : `${storeLabel} rating`;
  return (
    <div className="w-full rounded-2xl border bg-card p-6">
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

      {/* Surface Play Console report problems instead of silently swallowing them. */}
      {!isApple && asStringArray(run?.report_warnings).length > 0 ? (
        <div className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-500">
          <span className="font-medium">Reports:</span> {asStringArray(run?.report_warnings).join(" · ")}
        </div>
      ) : null}

      {/* Headline rating — one country's official, store-provided rating */}
      <div className="mt-5">
        <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
          {selEntry && !writtenOnly ? <span className="text-base leading-none">{flagEmoji(selected)}</span> : null}
          <span className="text-muted-foreground">{headlineLabel}</span>
        </p>
        <div className="flex items-end gap-4">
          <span className="text-5xl font-semibold leading-none tracking-tight tabular-nums">
            {headlineAvg != null ? headlineAvg.toFixed(1) : "—"}
          </span>
          <div className="pb-1">
            <Stars n={headlineAvg} size="size-4" />
            <p className="mt-1.5 text-xs text-muted-foreground">
              {isApple
                ? headlineAvg != null
                  ? `official · ${headlineCount?.toLocaleString() ?? "—"} ratings`
                  : "no rating from the App Store API yet"
                : writtenOnly
                  ? headlineAvg != null
                    ? `from ${headlineCount?.toLocaleString() ?? "—"} written reviews only · not a store-wide rating`
                    : "no stored written reviews yet"
                  : headlineAvg != null
                    ? `official per-country average · Play Console ratings report${listing?.rating_as_of ? ` · as of ${formatDate(listing.rating_as_of)}` : ""}`
                    : "no rating rows in the Play Console report yet"}
            </p>
          </div>
        </div>
        {!isApple && fromReport ? (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground/70">
            Google’s API does not expose an Apple-style global rating or total ratings count. This is the official per-country average from your latest Play Console ratings report — tap a country below to switch.
          </p>
        ) : null}
      </div>

      {/* Per-storefront switcher: Apple switches the headline; Google shows country rows used for the report average. */}
      {territories.length > 0 ? (
        <div className="mt-5 border-t pt-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            By country <span className="font-normal normal-case text-muted-foreground/60">{writtenOnly ? "· written reviews by country" : "· tap to switch · official rating + written reviews"}</span>
          </p>
          <ul className="space-y-0.5">
            {territories.map((t) => {
              const active = t.territory === selected;
              return (
                <li key={t.territory}>
                  <button
                    onClick={() => setPicked(t.territory)}
                    aria-pressed={active}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors ${
                      active ? "bg-accent" : "hover:bg-muted/50"
                    }`}
                  >
                    <span className="text-base leading-none">{flagEmoji(t.territory)}</span>
                    <span className="min-w-0 flex-1 truncate text-left text-foreground/80">{countryName(t.territory)}</span>
                    <Stars n={t.avg} size="size-3" />
                    <span className="w-9 text-right font-semibold tabular-nums">{t.avg != null ? t.avg.toFixed(1) : "—"}</span>
                    <span className="w-28 text-right text-[11px] text-muted-foreground tabular-nums">
                      {isApple && t.count != null ? `${t.count.toLocaleString()} ratings` : ""}
                      {isApple && t.count != null && t.review_count != null ? " · " : ""}
                      {t.review_count != null ? `${t.review_count.toLocaleString()} written` : isApple && t.count != null ? "" : "—"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Distribution of stored written reviews (not the official rating) */}
      <div className="mt-5 border-t pt-4">
        <div className="mb-2.5 flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Written review breakdown</p>
          <p className="text-[11px] text-muted-foreground/70">
            {total.toLocaleString()} stored
            {summary && summary.negative > 0 ? ` · ${summary.negative} ≤${negativeThreshold}★` : ""}
          </p>
        </div>
        <RatingDistribution counts={counts} />
        {!isApple ? (
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/60">
            Written reviews come from downloaded Play Console reviews CSVs plus the latest Reviews API refresh. Rating-only feedback is not included here.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function formatBytes(bytes: number | null): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function MetaFact({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">{label}</span>
      <span className="truncate text-sm font-medium text-foreground/90">{value}</span>
    </div>
  );
}

/** Official app metadata from the store (Apple iTunes Lookup). Real, no-auth facts. */
function AppMetaCard({ store, meta }: { store: StoreKey; meta: AppMetadata }) {
  const size = formatBytes(meta.fileSizeBytes);
  const facts: Array<{ label: string; value: string; title?: string }> = [];
  if (meta.version) facts.push({ label: "Version", value: meta.version });
  if (meta.currentVersionReleaseDate)
    facts.push({ label: "Updated", value: formatDate(meta.currentVersionReleaseDate), title: meta.releaseNotes ?? undefined });
  if (meta.releaseDate) facts.push({ label: "First released", value: formatDate(meta.releaseDate) });
  if (size) facts.push({ label: "Size", value: size });
  if (meta.primaryGenre) facts.push({ label: "Category", value: meta.primaryGenre });
  if (meta.contentRating) facts.push({ label: "Age rating", value: meta.contentRating });
  if (meta.formattedPrice) facts.push({ label: "Price", value: meta.formattedPrice });
  if (meta.minimumOsVersion) facts.push({ label: "Min OS", value: meta.minimumOsVersion });
  if (meta.languages.length > 0)
    facts.push({ label: "Languages", value: String(meta.languages.length), title: meta.languages.join(", ") });
  if (meta.sellerName) facts.push({ label: "Seller", value: meta.sellerName });
  if (facts.length === 0) return null;

  const storeLabel = STORE_META[store].label;
  return (
    <div className="w-full rounded-2xl border bg-card p-6">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">App details</p>
        <span className="text-[11px] text-muted-foreground/60">{storeLabel} · official store metadata</span>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
        {facts.map((f) => (
          <MetaFact key={f.label} label={f.label} value={f.value} title={f.title} />
        ))}
      </div>
      {meta.currentVersionAvg != null ? (
        <div className="mt-4 flex items-center gap-2 border-t pt-4 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">This version:</span>
          <Stars n={meta.currentVersionAvg} size="size-3" />
          <span className="font-semibold tabular-nums">{meta.currentVersionAvg.toFixed(1)}</span>
          {meta.currentVersionCount != null ? <span>· {meta.currentVersionCount.toLocaleString()} ratings</span> : null}
          {meta.releaseNotes ? <span className="ml-auto max-w-[60%] truncate" title={meta.releaseNotes}>“{meta.releaseNotes}”</span> : null}
        </div>
      ) : null}
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
  const [store, setStore] = useState<Filter>("google");
  const [refreshKey, setRefreshKey] = useState(0);
  const [digest, setDigest] = useState<{ summary_md: string; created_at: string } | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const [refreshingReports, setRefreshingReports] = useState(false);
  const [reports, setReports] = useState<{ installs: ReportPoint[]; crashes: ReportPoint[]; storePerformance: ReportPoint[]; trafficSources: TrafficSource[]; files: ReportFileRow[]; breakdowns: ReportBreakdown[] }>({ installs: [], crashes: [], storePerformance: [], trafficSources: [], files: [], breakdowns: [] });

  useEffect(() => {
    if (ready && !isEnabled("mobile-apps")) router.replace("/settings#modules");
  }, [ready, isEnabled, router]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/mobile-apps/${appId}`, { cache: "no-store" });
      const json = await res.json();
      if (json.ok) {
        setApp(json.app ?? null);
        const rawListings = (Array.isArray(json.listings) ? json.listings : []) as Listing[];
        setListings(rawListings.map((l) => ({ ...l, official_ratings: asTerritoryRatings(l.official_ratings), store_metadata: asMetadata(l.store_metadata) })));
        setSummary(Array.isArray(json.summary) ? json.summary : []);
        setTrend(Array.isArray(json.trend) ? json.trend : []);
        setSyncRuns(Array.isArray(json.syncRuns) ? json.syncRuns : []);
        setNegativeThreshold(json.negativeThreshold ?? 3);
        setReports({
          installs: Array.isArray(json.reports?.installs) ? json.reports.installs : [],
          crashes: Array.isArray(json.reports?.crashes) ? json.reports.crashes : [],
          storePerformance: Array.isArray(json.reports?.store_performance) ? json.reports.store_performance : [],
          trafficSources: Array.isArray(json.reports?.traffic_sources) ? json.reports.traffic_sources : [],
          files: Array.isArray(json.reports?.files) ? json.reports.files : [],
          breakdowns: Array.isArray(json.reports?.breakdowns) ? json.reports.breakdowns : [],
        });
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
  useEffect(() => {
    if (availableStores.length > 0 && !availableStores.includes(store)) {
      setStore(availableStores[0]);
    }
  }, [availableStores, store]);
  const shownStores = availableStores.includes(store) ? [store] : [];

  // Facts only (counts), never a computed average — the rating shown is the
  // official per-store value in each card.
  const combined = useMemo(() => {
    const rows = summary.filter((s) => s.store === store);
    const total = rows.reduce((a, r) => a + r.total, 0);
    const negative = rows.reduce((a, r) => a + r.negative, 0);
    const responded = rows.reduce((a, r) => a + (r.responded ?? 0), 0);
    return { total, negative, responded };
  }, [summary, store]);

  const trendData: TrendPoint[] = useMemo(() => {
    const rows = trend.filter((t) => t.store === store);
    return rows.map((t) => ({ day: t.day, avg: t.avg, count: t.count }));
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

  async function refreshGoogleReports() {
    setRefreshingReports(true);
    try {
      const res = await fetch("/api/mobile-apps/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId, store: "google", force: true, refreshReports: true }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Failed");
      await loadRef.current();
      setRefreshKey((k) => k + 1);
      toast.success("Google Play reports and reviews refreshed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to refresh reports");
    } finally {
      setRefreshingReports(false);
    }
  }

  const headerActions = (
    <div className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
      {availableStores.map((val) => (
        <button
          key={val}
          onClick={() => setStore(val)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            store === val ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {STORE_META[val].label}
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
              <Metric value={combined.total.toLocaleString()} label="Stored written reviews" />
              <div className="h-9 w-px bg-border" />
              <Metric
                value={combined.negative.toLocaleString()}
                label={`Negative ≤${negativeThreshold}★`}
                danger={combined.negative > 0}
              />
              <div className="h-9 w-px bg-border" />
              <Metric
                value={combined.total > 0 ? `${Math.round((combined.responded / combined.total) * 100)}%` : "—"}
                label="Developer replies"
              />
            </div>
          </div>

          <StoreConfigBanner />

          {/* Store score cards + official app metadata */}
          {shownStores.length > 0 ? (
            <div className="grid w-full gap-5">
              {shownStores.map((s) => {
                const listing = listings.find((x) => x.store === s);
                return (
                  <div key={s} className="flex flex-col gap-5">
                    <StoreScoreCard
                      store={s}
                      summary={summary.find((x) => x.store === s)}
                      listing={listing}
                      run={syncRuns.find((x) => x.store === s)}
                      negativeThreshold={negativeThreshold}
                    />
                    {listing?.store_metadata ? <AppMetaCard store={s} meta={listing.store_metadata} /> : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {/* Google Play Console reports are shown only in the Google Play tab. */}
          {store === "google" ? (
            <PlayReportsCard
              installs={reports.installs}
              crashes={reports.crashes}
              storePerformance={reports.storePerformance}
              trafficSources={reports.trafficSources}
              files={reports.files}
              breakdowns={reports.breakdowns}
              onRefresh={() => void refreshGoogleReports()}
              refreshing={refreshingReports}
            />
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
                  <p className="text-[11px] text-muted-foreground/70">Average of stored written reviews, not the store rating</p>
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
