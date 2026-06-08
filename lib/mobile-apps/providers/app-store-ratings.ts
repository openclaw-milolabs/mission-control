import pLimit from "p-limit";
import { toAlpha2 } from "@/lib/mobile-apps/country-codes";
import { fetchWithRetry } from "@/lib/mobile-apps/http";

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

const ITUNES_LOOKUP = "https://itunes.apple.com/lookup";

/**
 * Fetch the official per-storefront rating for an App Store app from Apple's
 * iTunes Lookup API (official JSON endpoint, no auth). `territories` may be
 * alpha-2 or alpha-3 codes; unmappable ones are skipped. Failures per storefront
 * are swallowed so one bad territory never breaks the rest.
 */
export async function fetchAppleTerritoryRatings(
  appStoreAppId: string,
  territories: string[],
): Promise<TerritoryRating[]> {
  const alpha2 = [
    ...new Set([...territories, ...APPLE_STOREFRONTS].map(toAlpha2).filter((c): c is string => !!c)),
  ];

  const limit = pLimit(4); // throttle so we don't hammer iTunes Lookup
  const results = await Promise.all(
    alpha2.map((cc) =>
      limit(async (): Promise<TerritoryRating | null> => {
        try {
          const url = `${ITUNES_LOOKUP}?id=${encodeURIComponent(appStoreAppId)}&country=${encodeURIComponent(cc)}`;
          const res = await fetchWithRetry(
            url,
            { headers: { "User-Agent": "MissionControl/1.0" } },
            { timeoutMs: 15_000, retries: 1 },
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
