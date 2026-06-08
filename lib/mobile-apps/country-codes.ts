/**
 * App Store Connect `customerReviews` returns territory codes as ISO 3166-1
 * **alpha-3** (e.g. "NLD"), but Apple's iTunes Lookup storefront param wants
 * **alpha-2** (e.g. "nl"). This maps alpha-3 → alpha-2 for the App Store
 * storefronts. Unknown codes return null (we simply skip that territory).
 */
const ALPHA3_TO_ALPHA2: Record<string, string> = {
  AUS: "au", AUT: "at", BEL: "be", BGR: "bg", BRA: "br", CAN: "ca", CHE: "ch",
  CHL: "cl", CHN: "cn", COL: "co", CYP: "cy", CZE: "cz", DEU: "de", DNK: "dk",
  EGY: "eg", ESP: "es", EST: "ee", FIN: "fi", FRA: "fr", GBR: "gb", GRC: "gr",
  HKG: "hk", HRV: "hr", HUN: "hu", IDN: "id", IND: "in", IRL: "ie", ISL: "is",
  ISR: "il", ITA: "it", JPN: "jp", KOR: "kr", KWT: "kw", LTU: "lt", LUX: "lu",
  LVA: "lv", MAR: "ma", MEX: "mx", MYS: "my", NLD: "nl", NOR: "no", NZL: "nz",
  PER: "pe", PHL: "ph", POL: "pl", PRT: "pt", QAT: "qa", ROU: "ro", RUS: "ru",
  SAU: "sa", SGP: "sg", SVK: "sk", SVN: "si", SWE: "se", THA: "th", TUR: "tr",
  TWN: "tw", UKR: "ua", USA: "us", ARE: "ae", ZAF: "za", VNM: "vn", ARG: "ar",
  PAK: "pk", BGD: "bd", NGA: "ng", KEN: "ke", SRB: "rs", MLT: "mt",
};

/** Normalize an App Store territory or storefront code to an alpha-2 storefront. */
export function toAlpha2(code: string | null | undefined): string | null {
  const c = (code ?? "").trim();
  if (!c) return null;
  if (c.length === 2) return c.toLowerCase();
  const mapped = ALPHA3_TO_ALPHA2[c.toUpperCase()];
  return mapped ?? null;
}

/** Regional-indicator flag emoji for an alpha-2 code, or "" if invalid. */
export function flagEmoji(alpha2: string | null | undefined): string {
  const c = (alpha2 ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "";
  return String.fromCodePoint(...[...c].map((ch) => 127397 + ch.charCodeAt(0)));
}

/** Primary language (ISO-639-1) for a storefront, as a best-effort source hint. */
const ALPHA2_TO_LANG: Record<string, string> = {
  nl: "nl", be: "nl", tr: "tr", us: "en", gb: "en", ie: "en", au: "en", nz: "en", ca: "en",
  za: "en", in: "en", de: "de", at: "de", ch: "de", fr: "fr", es: "es", mx: "es", ar: "es",
  co: "es", cl: "es", pe: "es", it: "it", pt: "pt", br: "pt", pl: "pl", ru: "ru", ua: "uk",
  se: "sv", no: "nb", dk: "da", fi: "fi", gr: "el", cz: "cs", sk: "sk", hu: "hu", ro: "ro",
  bg: "bg", hr: "hr", jp: "ja", kr: "ko", cn: "zh", tw: "zh", hk: "zh", th: "th", vn: "vi",
  id: "id", my: "ms", ph: "en", sa: "ar", ae: "ar", eg: "ar", il: "he", kw: "ar", qa: "ar",
};

/** Guess the source language for a review from its territory/storefront code. */
export function territoryToLanguage(code: string | null | undefined): string | null {
  const a2 = toAlpha2(code);
  return a2 ? (ALPHA2_TO_LANG[a2] ?? null) : null;
}

/** Human-readable country name for an alpha-2 code (falls back to the code). */
export function countryName(alpha2: string | null | undefined): string {
  const c = (alpha2 ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return (alpha2 ?? "").toUpperCase();
  try {
    return new Intl.DisplayNames(undefined, { type: "region" }).of(c) ?? c;
  } catch {
    return c;
  }
}
