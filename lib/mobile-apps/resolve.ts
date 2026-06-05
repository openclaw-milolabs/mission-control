import type { ResolvedListing } from "@/lib/mobile-apps/types";

/**
 * Parse a pasted App Store / Google Play URL — or a raw store id — into a
 * { store, storeAppId, country } triple. Throws if nothing matches.
 *
 * Apple ids are numeric (e.g. 310633997). Google ids are reverse-DNS
 * package names (e.g. com.whatsapp).
 */
export function resolveListing(input: string): ResolvedListing {
  const raw = (input || "").trim();
  if (!raw) throw new Error("Empty app reference");

  // Apple URL: https://apps.apple.com/<country>/app/<slug>/id<digits>
  const appleUrl = raw.match(/apps\.apple\.com\/(?:([a-z]{2})\/)?app\/(?:[^/]+\/)?id(\d+)/i);
  if (appleUrl) {
    return { store: "apple", storeAppId: appleUrl[2], country: (appleUrl[1] || "us").toLowerCase() };
  }

  // Google Play URL: https://play.google.com/store/apps/details?id=<pkg>&gl=<cc>
  const googleUrl = raw.match(/play\.google\.com\/store\/apps\/details\?([^\s]+)/i);
  if (googleUrl) {
    const params = new URLSearchParams(googleUrl[1]);
    const id = params.get("id");
    if (!id) throw new Error("Google Play URL missing ?id=");
    const country = (params.get("gl") || "us").toLowerCase();
    return { store: "google", storeAppId: id, country };
  }

  // Bare numeric id -> apple
  if (/^\d+$/.test(raw)) {
    return { store: "apple", storeAppId: raw, country: "us" };
  }

  // Bare reverse-DNS package -> google
  if (/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(raw)) {
    return { store: "google", storeAppId: raw, country: "us" };
  }

  throw new Error(`Could not recognize an App Store or Google Play app from: ${raw}`);
}
