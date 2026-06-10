"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { IconBrandApple, IconBrandGooglePlay, IconStarFilled, IconRefresh } from "@tabler/icons-react";
import { PageHeader } from "@/components/layout/page-header";
import { StoreConfigBanner } from "@/components/mobile-apps/store-config-banner";
import { ReviewsStream } from "@/components/mobile-apps/reviews-stream";
import { RatingDistribution } from "@/components/mobile-apps/rating-distribution";
import { RatingTrend, type TrendPoint, type TrendMarker } from "@/components/mobile-apps/rating-trend";
import { SentimentDigest } from "@/components/mobile-apps/sentiment-digest";
import { PlayReportsCard, type ReportPoint, type TrafficSource, type ReportFileRow, type ReportBreakdown } from "@/components/mobile-apps/play-reports-card";
import { SourceBadge } from "@/components/mobile-apps/source-badge";
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

      {/* How fresh this store's data is — and the store-side lag we can't control. */}
      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/60">
        {isApple
          ? "Checked live via the App Store Connect API on each load and Refresh. A brand-new review can still take a few hours to appear in Apple’s API after you post it."
          : "Checked live via the Play Reviews API, which returns roughly the last 7 days. A new review usually appears within a day; older reviews come from the monthly Play Console CSV exports."}
      </p>

      {/* Headline rating — one country's official, store-provided rating */}
      <div className="mt-5">
        <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
          {selEntry && !writtenOnly ? <span className="text-base leading-none">{flagEmoji(selected)}</span> : null}
          <span className="text-muted-foreground">{headlineLabel}</span>
          {isApple ? (
            <SourceBadge kind="official-api" title="Apple iTunes Lookup — official public Apple endpoint." />
          ) : fromReport ? (
            <SourceBadge kind="csv" title="Google Play Console ratings CSV export — delayed (daily/monthly), not a live API." />
          ) : (
            <SourceBadge kind="derived" title="Average of stored written reviews — Google exposes no live global store rating via API." />
          )}
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
          <div className="mb-2 flex items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              By country <span className="font-normal normal-case text-muted-foreground/60">{writtenOnly ? "· written reviews by country" : "· tap to switch · official rating + written reviews"}</span>
            </p>
            {isApple ? (
              <SourceBadge kind="official-api" title="Ratings: Apple iTunes Lookup. Written counts: App Store Connect API. Both official." />
            ) : fromReport ? (
              <SourceBadge kind="csv" label="API + CSV" title="Ratings: Play Console ratings CSV export (delayed). Written counts: Play Reviews API + monthly review CSVs." />
            ) : (
              <SourceBadge kind="official-api" title="Written-review counts from the Play Reviews API + monthly review CSVs." />
            )}
          </div>
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
          <div className="flex items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Written review breakdown</p>
            {isApple ? (
              <SourceBadge kind="official-api" title="App Store Connect API customerReviews — official, last ~500 per storefront." />
            ) : (
              <SourceBadge kind="official-api" label="API + CSV" title="Play Reviews API (last ~7 days) + monthly Play Console review CSV exports." />
            )}
          </div>
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
        <div className="flex items-center gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">App details</p>
          <SourceBadge kind="official-api" title="Apple iTunes Lookup — official public Apple endpoint." />
        </div>
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

function asMetricsObj(v: unknown): Record<string, number | null> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, number | null>;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, number | null>) : {};
    } catch {
      return {};
    }
  }
  return {};
}
function pickMetric(m: Record<string, number | null>, ...keys: string[]): number | null {
  for (const k of keys) if (typeof m[k] === "number") return m[k] as number;
  return null;
}
const INSTALL_METRIC_KEYS = ["active_device_installs", "current_device_installs", "total_user_installs", "daily_device_installs", "daily_user_installs"];

/** Top dimension values for an installs breakdown, ranked by install volume. */
function topInstallBreakdown(breakdowns: ReportBreakdown[], dimension: string, n: number): Array<{ label: string; value: number | null }> {
  return breakdowns
    .filter((b) => b.report === "installs" && b.dimension === dimension && b.dimension_value && b.dimension_value !== "overview")
    .map((b) => ({ label: b.dimension_value, value: pickMetric(asMetricsObj(b.metrics), ...INSTALL_METRIC_KEYS) }))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, n);
}

/**
 * Google Play details derived ONLY from Play Console install reports we already
 * ingest. Google exposes no catalog-metadata endpoint (size, age rating,
 * category, price) like Apple's iTunes Lookup, so we never fabricate those.
 */
function GoogleDetailsCard({ breakdowns, installs }: { breakdowns: ReportBreakdown[]; installs: ReportPoint[] }) {
  const topVersion = topInstallBreakdown(breakdowns, "app_version", 1)[0]?.label ?? null;
  const languages = breakdowns.filter((b) => b.report === "installs" && b.dimension === "language" && b.dimension_value && b.dimension_value !== "overview");
  const topDevices = topInstallBreakdown(breakdowns, "device", 5);
  const topOs = topInstallBreakdown(breakdowns, "os_version", 4);
  const topCountries = topInstallBreakdown(breakdowns, "country", 5);
  const lastInstalls = installs.length ? asMetricsObj(installs[installs.length - 1].metrics) : {};
  const activeInstalls = pickMetric(lastInstalls, "active_device_installs", "current_device_installs", "total_user_installs");

  const facts: Array<{ label: string; value: string; title?: string }> = [];
  if (topVersion) facts.push({ label: "Top version", value: topVersion });
  if (activeInstalls != null) facts.push({ label: "Active installs", value: activeInstalls.toLocaleString() });
  if (languages.length > 0)
    facts.push({ label: "Languages", value: String(languages.length), title: languages.map((l) => l.dimension_value).join(", ") });
  if (topCountries.length > 0)
    facts.push({ label: "Top country", value: countryName(topCountries[0].label) });

  const chips: Array<{ title: string; items: string[] }> = [];
  if (topDevices.length > 0) chips.push({ title: "Top devices", items: topDevices.map((d) => d.label) });
  if (topOs.length > 0) chips.push({ title: "Android versions", items: topOs.map((o) => o.label) });
  if (topCountries.length > 0) chips.push({ title: "Top countries", items: topCountries.map((c) => countryName(c.label)) });

  if (facts.length === 0 && chips.length === 0) return null;

  return (
    <div className="w-full rounded-2xl border bg-card p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">App details</p>
          <SourceBadge kind="csv" label="CSV-derived" title="Derived from Google Play Console install CSV exports — Google has no catalog-metadata API." />
        </div>
        <span className="text-[11px] text-muted-foreground/60">Google Play · derived from Play Console install reports</span>
      </div>
      {facts.length > 0 ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          {facts.map((f) => (
            <MetaFact key={f.label} label={f.label} value={f.value} title={f.title} />
          ))}
        </div>
      ) : null}
      {chips.length > 0 ? (
        <div className="mt-4 grid gap-4 border-t pt-4 sm:grid-cols-3">
          {chips.map((c) => (
            <div key={c.title}>
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">{c.title}</p>
              <div className="flex flex-wrap gap-1">
                {c.items.map((it) => (
                  <span key={it} className="rounded-md bg-muted/50 px-1.5 py-0.5 text-[11px] text-foreground/80">{it}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground/60">
        Google’s API exposes no catalog metadata (size, age rating, category, price) the way Apple’s does. These facts are derived from the install reports you’ve downloaded.
      </p>
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
  const [syncing, setSyncing] = useState(false);
  // True only for the explicit Refresh button: that one takes over the whole page
  // (the user asked for fresh data and wants to see it arrive), unlike the silent
  // background re-check on page open which must not blank already-rendered data.
  const [manualSync, setManualSync] = useState(false);
  const [reports, setReports] = useState<{ installs: ReportPoint[]; crashes: ReportPoint[]; storePerformance: ReportPoint[]; trafficSources: TrafficSource[]; files: ReportFileRow[]; breakdowns: ReportBreakdown[] }>({ installs: [], crashes: [], storePerformance: [], trafficSources: [], files: [], breakdowns: [] });
  const [reportsFreshness, setReportsFreshness] = useState<{
    status: string;
    latestOfficialMonth: string | null;
    latestProcessedMonth: string | null;
    processedAt: string | null;
    checkedAt: string | null;
  } | null>(null);

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
        setReportsFreshness(json.freshness?.googleReports ?? null);
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
    setSyncing(true);
    void (async () => {
      // Ensure-fresh is the control plane: it refreshes live reviews + ratings
      // (light, in-request) AND cheaply checks Google report freshness, queuing the
      // background worker if a newer official CSV exists. It never does heavy ETL
      // here. "available" means we still render last-processed charts, clearly
      // labeled as refreshing — we never block the page.
      await fetch(`/api/mobile-apps/${appId}/ensure-fresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consistency: "available", includeReports: true }),
      }).catch(() => null);
      if (!cancelled) {
        await loadRef.current();
        setRefreshKey((k) => k + 1);
      }
    })()
      .catch(() => null)
      .finally(() => {
        if (!cancelled) setSyncing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  // Manual "Refresh" — force a fresh check of the live review APIs (Apple Connect /
  // Google Reviews) right now. syncReports:false keeps it fast; the heavy Play
  // Console CSV scan stays behind the reports card's own refresh button.
  const refreshNow = useCallback(async () => {
    setSyncing(true);
    setManualSync(true);
    try {
      const res = await fetch("/api/mobile-apps/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId, force: true, syncReports: false, syncAppleStorefronts: false }),
      });
      const json = await res.json().catch(() => null);
      await loadRef.current();
      setRefreshKey((k) => k + 1);
      if (json && json.ok === false) toast.error(json.error || "Refresh failed");
      else toast.success("Re-checked the stores for new reviews");
    } catch {
      toast.error("Refresh failed");
    } finally {
      setSyncing(false);
      setManualSync(false);
    }
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

  // Release marker on the trend chart: only where we have a real release date.
  // Apple's iTunes Lookup gives the current version's release date; Google's API
  // exposes no per-version release date, so we never invent one.
  const trendMarkers: TrendMarker[] = useMemo(() => {
    const meta = listings.find((l) => l.store === store)?.store_metadata;
    if (store === "apple" && meta?.currentVersionReleaseDate) {
      return [{ day: meta.currentVersionReleaseDate, label: meta.version ? `v${meta.version}` : "Update" }];
    }
    return [];
  }, [listings, store]);

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
      // Heavy Google report ETL never runs in a web request. This queues a job that
      // the detached cron-drained worker picks up; the page stays usable and reloads
      // via SSE when the worker finishes.
      const res = await fetch("/api/mobile-apps/reports/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId, store: "google", mode: "incremental", reason: "manual" }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) throw new Error(json?.error || "Failed to queue report sync");
      toast.success(json.status === "running" ? "A report sync is already running." : "Report sync queued.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to refresh reports");
    } finally {
      setRefreshingReports(false);
    }
  }

  const headerActions = (
    <div className="flex items-center gap-2">
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
      <button
        type="button"
        onClick={() => void refreshNow()}
        disabled={syncing}
        title="Re-check the App Store & Google Play review APIs for new reviews now"
        className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
      >
        <IconRefresh className={`size-3.5 ${syncing ? "animate-spin" : ""}`} />
        {syncing ? "Refreshing…" : "Refresh"}
      </button>
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
        {/* Full-page spinner in exactly two cases: the first ever load (nothing to
            render yet) and an EXPLICIT Refresh click (the user asked for fresh data
            and wants to see it arrive). The silent background re-check on page open
            stays inline so cached data is never blanked for seconds. */}
        {syncing && (manualSync || !app) ? (
          <div className="flex h-full min-h-[70vh] flex-col items-center justify-center gap-5 text-center">
            <span className="relative grid size-16 place-items-center">
              <span className="absolute inset-0 animate-spin rounded-full border-[3px] border-muted border-t-foreground" />
              {app?.icon_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={app.icon_url} alt="" className="size-9 rounded-xl border" />
              ) : (
                <IconRefresh className="size-6 text-muted-foreground" />
              )}
            </span>
            <div className="max-w-md">
              <h2 className="text-lg font-semibold tracking-tight">Checking the stores…</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Fetching the latest ratings and reviews for {app?.name ?? "this app"} from the App Store and Google Play.
                This usually takes a few seconds — and a brand-new review can still take hours to appear on the store side.
              </p>
            </div>
          </div>
        ) : (
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
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
                  <span>
                    {availableStores.length > 0
                      ? availableStores.map((s) => STORE_META[s].label).join(" · ")
                      : "No store listings"}
                  </span>
                  {syncing ? (
                    <span className="inline-flex items-center gap-1 text-foreground/70">
                      <IconRefresh className="size-3 animate-spin" /> checking stores…
                    </span>
                  ) : lastSyncedAt ? (
                    <span
                      title={`Last checked the store review APIs at ${new Date(lastSyncedAt).toLocaleString()}. A newly posted review can still take time to appear — Apple and Google expose new reviews on their own delay.`}
                    >
                      · synced {lastSync(lastSyncedAt)}
                    </span>
                  ) : null}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-6">
              <Metric
                value={combined.total.toLocaleString()}
                label="Stored written reviews"
                badge={<SourceBadge kind="official-api" label="API + CSV" title={store === "apple" ? "App Store Connect API customerReviews." : "Play Reviews API (last ~7 days) + monthly Play Console review CSV exports."} />}
              />
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
                badge={<SourceBadge kind="derived" title="Share of stored reviews that have a developer response — computed from review data." />}
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
                    {s === "apple" && listing?.store_metadata ? <AppMetaCard store={s} meta={listing.store_metadata} /> : null}
                    {s === "google" ? <GoogleDetailsCard breakdowns={reports.breakdowns} installs={reports.installs} /> : null}
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
              freshness={reportsFreshness}
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
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold">Review ratings over time</h2>
                    <SourceBadge kind="derived" title="Daily average computed from stored written reviews — not the official store rating." />
                  </div>
                  <p className="text-[11px] text-muted-foreground/70">Average of stored written reviews, not the store rating</p>
                </div>
                <RatingTrend data={trendData} markers={trendMarkers} />
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
        )}
      </div>
    </>
  );
}

function Metric({
  value,
  label,
  accent,
  danger,
  badge,
}: {
  value: string;
  label: string;
  accent?: boolean;
  danger?: boolean;
  badge?: ReactNode;
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
      <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        {label}
        {badge}
      </span>
    </div>
  );
}
