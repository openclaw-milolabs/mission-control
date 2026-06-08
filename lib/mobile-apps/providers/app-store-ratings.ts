import { toAlpha2 } from "@/lib/mobile-apps/country-codes";

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
  const alpha2 = [...new Set(territories.map(toAlpha2).filter((c): c is string => !!c))];
  const out: TerritoryRating[] = [];
  for (const cc of alpha2) {
    try {
      const url = `${ITUNES_LOOKUP}?id=${encodeURIComponent(appStoreAppId)}&country=${encodeURIComponent(cc)}`;
      const res = await fetch(url, { headers: { "User-Agent": "MissionControl/1.0" } });
      if (!res.ok) continue;
      const { avg, count } = parseiTunesLookup(await res.json());
      if (avg != null || count != null) out.push({ territory: cc, avg, count });
    } catch {
      // skip this storefront
    }
  }
  // Highest rating-count first so the primary storefront leads.
  out.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  return out;
}
