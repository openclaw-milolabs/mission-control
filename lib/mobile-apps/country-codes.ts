/**
 * App Store Connect `customerReviews` returns territory codes as ISO 3166-1
 * **alpha-3** (e.g. "NLD"), but Apple's iTunes Lookup storefront param and our
 * canonical country key are **alpha-2** (e.g. "nl"). This is the complete ISO
 * 3166-1 alpha-3 → alpha-2 map so no real App Store territory ever falls through
 * to a raw 3-letter code. Unknown/invalid codes return null (territory skipped).
 */
const ALPHA3_TO_ALPHA2: Record<string, string> = {
  ABW: "aw", AFG: "af", AGO: "ao", AIA: "ai", ALA: "ax", ALB: "al", AND: "ad",
  ARE: "ae", ARG: "ar", ARM: "am", ASM: "as", ATA: "aq", ATF: "tf", ATG: "ag",
  AUS: "au", AUT: "at", AZE: "az", BDI: "bi", BEL: "be", BEN: "bj", BES: "bq",
  BFA: "bf", BGD: "bd", BGR: "bg", BHR: "bh", BHS: "bs", BIH: "ba", BLM: "bl",
  BLR: "by", BLZ: "bz", BMU: "bm", BOL: "bo", BRA: "br", BRB: "bb", BRN: "bn",
  BTN: "bt", BVT: "bv", BWA: "bw", CAF: "cf", CAN: "ca", CCK: "cc", CHE: "ch",
  CHL: "cl", CHN: "cn", CIV: "ci", CMR: "cm", COD: "cd", COG: "cg", COK: "ck",
  COL: "co", COM: "km", CPV: "cv", CRI: "cr", CUB: "cu", CUW: "cw", CXR: "cx",
  CYM: "ky", CYP: "cy", CZE: "cz", DEU: "de", DJI: "dj", DMA: "dm", DNK: "dk",
  DOM: "do", DZA: "dz", ECU: "ec", EGY: "eg", ERI: "er", ESH: "eh", ESP: "es",
  EST: "ee", ETH: "et", FIN: "fi", FJI: "fj", FLK: "fk", FRA: "fr", FRO: "fo",
  FSM: "fm", GAB: "ga", GBR: "gb", GEO: "ge", GGY: "gg", GHA: "gh", GIB: "gi",
  GIN: "gn", GLP: "gp", GMB: "gm", GNB: "gw", GNQ: "gq", GRC: "gr", GRD: "gd",
  GRL: "gl", GTM: "gt", GUF: "gf", GUM: "gu", GUY: "gy", HKG: "hk", HMD: "hm",
  HND: "hn", HRV: "hr", HTI: "ht", HUN: "hu", IDN: "id", IMN: "im", IND: "in",
  IOT: "io", IRL: "ie", IRN: "ir", IRQ: "iq", ISL: "is", ISR: "il", ITA: "it",
  JAM: "jm", JEY: "je", JOR: "jo", JPN: "jp", KAZ: "kz", KEN: "ke", KGZ: "kg",
  KHM: "kh", KIR: "ki", KNA: "kn", KOR: "kr", KWT: "kw", LAO: "la", LBN: "lb",
  LBR: "lr", LBY: "ly", LCA: "lc", LIE: "li", LKA: "lk", LSO: "ls", LTU: "lt",
  LUX: "lu", LVA: "lv", MAC: "mo", MAF: "mf", MAR: "ma", MCO: "mc", MDA: "md",
  MDG: "mg", MDV: "mv", MEX: "mx", MHL: "mh", MKD: "mk", MLI: "ml", MLT: "mt",
  MMR: "mm", MNE: "me", MNG: "mn", MNP: "mp", MOZ: "mz", MRT: "mr", MSR: "ms",
  MTQ: "mq", MUS: "mu", MWI: "mw", MYS: "my", MYT: "yt", NAM: "na", NCL: "nc",
  NER: "ne", NFK: "nf", NGA: "ng", NIC: "ni", NIU: "nu", NLD: "nl", NOR: "no",
  NPL: "np", NRU: "nr", NZL: "nz", OMN: "om", PAK: "pk", PAN: "pa", PCN: "pn",
  PER: "pe", PHL: "ph", PLW: "pw", PNG: "pg", POL: "pl", PRI: "pr", PRK: "kp",
  PRT: "pt", PRY: "py", PSE: "ps", PYF: "pf", QAT: "qa", REU: "re", ROU: "ro",
  RUS: "ru", RWA: "rw", SAU: "sa", SDN: "sd", SEN: "sn", SGP: "sg", SGS: "gs",
  SHN: "sh", SJM: "sj", SLB: "sb", SLE: "sl", SLV: "sv", SMR: "sm", SOM: "so",
  SPM: "pm", SRB: "rs", SSD: "ss", STP: "st", SUR: "sr", SVK: "sk", SVN: "si",
  SWE: "se", SWZ: "sz", SXM: "sx", SYC: "sc", SYR: "sy", TCA: "tc", TCD: "td",
  TGO: "tg", THA: "th", TJK: "tj", TKL: "tk", TKM: "tm", TLS: "tl", TON: "to",
  TTO: "tt", TUN: "tn", TUR: "tr", TUV: "tv", TWN: "tw", TZA: "tz", UGA: "ug",
  UKR: "ua", UMI: "um", URY: "uy", USA: "us", UZB: "uz", VAT: "va", VCT: "vc",
  VEN: "ve", VGB: "vg", VIR: "vi", VNM: "vn", VUT: "vu", WLF: "wf", WSM: "ws",
  YEM: "ye", ZAF: "za", ZMB: "zm", ZWE: "zw",
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
