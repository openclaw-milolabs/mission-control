import pLimit from "p-limit";
import { toAlpha2 } from "@/lib/mobile-apps/country-codes";
import { fetchWithRetry, sleep } from "@/lib/mobile-apps/http";

export type StorefrontScanOptions = {
  /** When true, probe the full storefront list; otherwise only the passed territories. */
  fullScan: boolean;
  concurrency: number;
  /** Delay before each request, to pace iTunes Lookup. */
  delayMs: number;
};

/**
 * The full set of App Store storefronts (ISO 3166-1 alpha-2), so countries that
 * have ratings but no written reviews aren't missed. Unioned with the review
 * territories + listing country at call time, then filtered to count > 0.
 */
export const APPLE_STOREFRONTS = [
  "ae", "ag", "ai", "al", "am", "ao", "ar", "at", "au", "az", "bb", "be", "bf", "bg", "bh", "bj",
  "bm", "bn", "bo", "br", "bs", "bt", "bw", "by", "bz", "ca", "cg", "ch", "cl", "cn", "co", "cr",
  "cv", "cy", "cz", "de", "dk", "dm", "do", "dz", "ec", "ee", "eg", "es", "fi", "fj", "fm", "fr",
  "ga", "gb", "gd", "gh", "gm", "gr", "gt", "gw", "gy", "hk", "hn", "hr", "hu", "id", "ie", "il",
  "in", "iq", "is", "it", "jm", "jo", "jp", "ke", "kg", "kh", "kn", "kr", "kw", "ky", "kz", "la",
  "lb", "lc", "lk", "lr", "lt", "lu", "lv", "ly", "ma", "md", "me", "mg", "mk", "ml", "mn", "mo",
  "mr", "ms", "mt", "mu", "mw", "mx", "my", "mz", "na", "ne", "ng", "ni", "nl", "no", "np", "nz",
  "om", "pa", "pe", "pg", "ph", "pk", "pl", "pt", "pw", "py", "qa", "ro", "rs", "ru", "rw", "sa",
  "sb", "sc", "se", "sg", "si", "sk", "sl", "sn", "sr", "st", "sv", "sz", "tc", "td", "th", "tj",
  "tm", "tn", "tr", "tt", "tw", "tz", "ua", "ug", "us", "uy", "uz", "vc", "ve", "vg", "vn", "ye",
  "za", "zm", "zw",
];

export type TerritoryRating = {
  /** alpha-2 storefront, e.g. "nl" */
  territory: string;
  /** Official average rating Apple displays for this storefront, raw (not rounded). */
  avg: number | null;
  /** Official number of ratings for this storefront. */
  count: number | null;
};

/**
 * Pure: read the official, Apple-provided rating from an iTunes Lookup result.
 * We do NOT compute this ourselves — `averageUserRating` is the value Apple
 * shows on the storefront (it includes rating-only taps, not just text reviews).
 */
export function parseiTunesLookup(json: unknown): { avg: number | null; count: number | null } {
  const r = (json as { results?: Array<Record<string, unknown>> } | null)?.results?.[0];
  if (!r) return { avg: null, count: null };
  return {
    avg: typeof r.averageUserRating === "number" ? r.averageUserRating : null,
    count: typeof r.userRatingCount === "number" ? r.userRatingCount : null,
  };
}

/**
 * Storefront-independent app metadata Apple returns from a single iTunes Lookup.
 * All real, official, no-auth fields — currently discarded by the rating scan.
 */
export type AppleAppMetadata = {
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
  /** Apple's rating/count for the CURRENT version only (vs all-version avg). */
  currentVersionAvg: number | null;
  currentVersionCount: number | null;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Pure: extract storefront-independent app metadata from an iTunes Lookup result. */
export function parseiTunesMetadata(json: unknown): AppleAppMetadata | null {
  const r = (json as { results?: Array<Record<string, unknown>> } | null)?.results?.[0];
  if (!r) return null;
  return {
    version: str(r.version),
    releaseDate: str(r.releaseDate),
    currentVersionReleaseDate: str(r.currentVersionReleaseDate),
    releaseNotes: str(r.releaseNotes),
    fileSizeBytes: num(r.fileSizeBytes),
    primaryGenre: str(r.primaryGenreName),
    genres: Array.isArray(r.genres) ? r.genres.filter((g): g is string => typeof g === "string") : [],
    contentRating: str(r.trackContentRating) ?? str(r.contentAdvisoryRating),
    formattedPrice: str(r.formattedPrice),
    currency: str(r.currency),
    sellerName: str(r.sellerName) ?? str(r.artistName),
    minimumOsVersion: str(r.minimumOsVersion),
    languages: Array.isArray(r.languageCodesISO2A)
      ? r.languageCodesISO2A.filter((l): l is string => typeof l === "string")
      : [],
    screenshotCount: Array.isArray(r.screenshotUrls) ? r.screenshotUrls.length : null,
    artworkUrl: str(r.artworkUrl512) ?? str(r.artworkUrl100),
    currentVersionAvg: num(r.averageUserRatingForCurrentVersion),
    currentVersionCount: num(r.userRatingCountForCurrentVersion),
  };
}

const ITUNES_LOOKUP = "https://itunes.apple.com/lookup";

/**
 * One iTunes Lookup against the listing's primary storefront to capture official
 * app metadata (version, size, genre, age rating, price, languages, current-version
 * rating). Returns null on any failure — metadata is best-effort, never fatal.
 */
export async function fetchAppleAppMetadata(
  appStoreAppId: string,
  country: string | null | undefined,
): Promise<AppleAppMetadata | null> {
  const cc = toAlpha2(country) ?? "us";
  try {
    const url = `${ITUNES_LOOKUP}?id=${encodeURIComponent(appStoreAppId)}&country=${encodeURIComponent(cc)}`;
    const res = await fetchWithRetry(
      url,
      { headers: { "User-Agent": "MissionControl/1.0" } },
      { timeoutMs: 15_000, retries: 1 },
    );
    if (!res.ok) return null;
    return parseiTunesMetadata(await res.json());
  } catch {
    return null;
  }
}

/**
 * Fetch the official per-storefront rating for an App Store app from Apple's
 * iTunes Lookup API (official JSON endpoint, no auth). `territories` may be
 * alpha-2 or alpha-3 codes; unmappable ones are skipped. Failures per storefront
 * are swallowed so one bad territory never breaks the rest.
 */
export async function fetchAppleTerritoryRatings(
  appStoreAppId: string,
  territories: string[],
  opts: StorefrontScanOptions = { fullScan: true, concurrency: 2, delayMs: 250 },
): Promise<TerritoryRating[]> {
  // Full scan probes every storefront; otherwise just the territories we already
  // know about (review territories + the listing country). No caching.
  const seed = opts.fullScan ? [...territories, ...APPLE_STOREFRONTS] : territories;
  const alpha2 = [...new Set(seed.map(toAlpha2).filter((c): c is string => !!c))];

  const limit = pLimit(Math.max(1, opts.concurrency)); // bounded concurrency
  const results = await Promise.all(
    alpha2.map((cc) =>
      limit(async (): Promise<TerritoryRating | null> => {
        try {
          if (opts.delayMs > 0) await sleep(opts.delayMs); // pace requests
          const url = `${ITUNES_LOOKUP}?id=${encodeURIComponent(appStoreAppId)}&country=${encodeURIComponent(cc)}`;
          // retries: 0 — a rate-limited storefront is simply skipped, never a retry storm.
          const res = await fetchWithRetry(
            url,
            { headers: { "User-Agent": "MissionControl/1.0" } },
            { timeoutMs: 15_000, retries: 0 },
          );
          if (!res.ok) return null;
          const { avg, count } = parseiTunesLookup(await res.json());
          // Keep only storefronts that actually have ratings.
          return (count ?? 0) > 0 ? { territory: cc, avg, count } : null;
        } catch {
          return null;
        }
      }),
    ),
  );

  return results
    .filter((r): r is TerritoryRating => r !== null)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0)); // highest rating-count first
}
