// =====================================================================
// Consent region logic — PURE (no firebase/database/platform imports) so it is
// unit-testable in isolation and importing it never triggers Firebase init.
// Mirrors the shared shape in server/ai-proxy/telemetry.ts: the client decides
// the regional DEFAULT + surfaces the notice/opt-in; the server independently
// gates writes on the reported boolean.
// =====================================================================

export type ConsentRegion = "eu" | "jp" | "other";
export type ConsentMode = "opt_in" | "opt_out" | "notice";

// EU/EEA + UK + CH — mirrors EU_EEA in server/ai-proxy/telemetry.ts. These
// jurisdictions require prior opt-in for non-essential analytics.
const EU_EEA = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
  "GB",
  "CH",
]);

// Base languages spoken predominantly in the EU/EEA. Used only as a conservative
// fallback when no explicit region subtag is available: an ambiguous EU-language
// user is treated as opt-in (privacy-safe) rather than risking a GDPR breach.
const EU_LANGS = new Set([
  "de",
  "fr",
  "it",
  "es",
  "nl",
  "pl",
  "sv",
  "da",
  "fi",
  "el",
  "pt",
  "cs",
  "hu",
  "ro",
  "sk",
  "sl",
  "bg",
  "hr",
  "et",
  "lv",
  "lt",
  "ga",
  "mt",
  "is",
  "nb",
  "nn",
  "no",
]);

export function consentRegionFor(countryCode: string): ConsentRegion {
  const cc = (countryCode || "").trim().toUpperCase();
  if (EU_EEA.has(cc)) return "eu";
  if (cc === "JP") return "jp";
  return "other";
}

export function consentModeFor(region: ConsentRegion): ConsentMode {
  return region === "eu" ? "opt_in" : region === "jp" ? "opt_out" : "notice";
}

/** Default consent before the user chooses: OFF in the EU (opt-in), ON elsewhere. */
export function defaultConsent(region: ConsentRegion): boolean {
  return region !== "eu";
}

/**
 * Best-effort region detection from the browser locale + timezone. Order:
 *   1. explicit region subtag in navigator.language (e.g. "de-DE" → DE)
 *   2. any of navigator.languages carrying a region subtag
 *   3. timezone: "Europe/*" → EU-strict, "Asia/Tokyo" → JP
 *   4. an EU base language → EU-strict (conservative)
 * Falls back to "eu" (strictest → opt-in) when NOTHING is readable, honoring
 * "unknown region → privacy-preserving default".
 *
 * `nav`/`tz` are injectable for testing; production reads the live globals.
 */
export function detectRegion(
  nav?: { language?: string; languages?: readonly string[] },
  tzOverride?: string,
): ConsentRegion {
  try {
    const navigatorLike =
      nav ?? (typeof navigator !== "undefined" ? navigator : undefined);
    if (!navigatorLike) return "eu";
    const langs = [
      navigatorLike.language,
      ...(navigatorLike.languages || []),
    ].filter(Boolean) as string[];
    for (const l of langs) {
      const m = /-([A-Za-z]{2})\b/.exec(l);
      if (m) {
        const r = consentRegionFor(m[1]);
        // A concrete region subtag is authoritative for eu/jp; a non-EU/JP
        // subtag ("other") still lets a later signal upgrade to eu if warranted.
        if (r !== "other") return r;
      }
    }
    // An explicitly-passed override (even "") is authoritative — only read the
    // live Intl timezone when the caller passed nothing (production path).
    let tz = tzOverride;
    if (tz === undefined) {
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      } catch {
        tz = "";
      }
    }
    if (tz.startsWith("Europe/")) return "eu";
    if (tz === "Asia/Tokyo") return "jp";
    const base = (langs[0] || "").toLowerCase().split("-")[0];
    if (EU_LANGS.has(base)) return "eu";
    if (base === "ja") return "jp";
    if (langs.length > 0 || tz) return "other";
    return "eu";
  } catch {
    return "eu";
  }
}
