// =====================================================================
// Displayed pricing (JPY, tax-inclusive). Single source of truth for the
// paywall AND team-management UIs.
//
// These are DISPLAY values only. The server resolves the Stripe priceId and
// Stripe charges its OWN configured amount, so any mismatch here is a display
// bug, never an overcharge. Keep in sync with the Stripe dashboard
// (see MONETIZATION.md → owner runbook).
//
// Team is PER-SEAT: the checkout bills item quantity = seat count, so the Team
// amounts below are the price of ONE seat. The team total = seat price × seats.
// =====================================================================
export type PaidPlan = "pro" | "team";
export type BillingInterval = "month" | "year";

export const PRICING: Record<PaidPlan, { month: number; year: number }> = {
  pro: { month: 1280, year: 11760 },
  team: { month: 1980, year: 19800 },
};

/** Format a JPY amount for the Japanese UI (e.g. ¥1,980). */
export const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

// ---------------------------------------------------------------------
// Mobile in-app-purchase pricing.
//
// On mobile, Apple/Google charge their OWN configured amount and localize it per
// storefront (¥ in Japan, $ in the US, …). The desktop PRICING above is a JPY
// Stripe display value and MUST NOT be shown on mobile — for Pro it is ¥1,280,
// while the App Store Connect product is ¥1,500, so showing PRICING on an iPhone
// would misrepresent what StoreKit is about to charge (an App Review / trust
// risk). The paywall therefore prefers the live localized store price
// (formattedPrice) and falls back to these ASC/Play amounts only when the store
// query fails. See memory iap_pricing_and_products.
// ---------------------------------------------------------------------
export const MOBILE_PRICING: Record<
  "pro",
  { month: number; year: number; currency: string }
> = {
  pro: { month: 1500, year: 14000, currency: "JPY" },
};

/**
 * A plan's resolved mobile pricing, in major currency units, with the store's
 * localized strings when available. `*Formatted` is the exact string the store
 * returned (e.g. "¥1,500", "$9.99"); when null the UI formats the numeric
 * amount itself via {@link formatMoney}. Per-month equivalents and yearly
 * savings are derived arithmetically from the numeric amounts.
 */
export interface ResolvedPricing {
  /** Monthly-plan price in major units (e.g. 1500, 9.99). */
  month: number;
  /** Yearly-plan price in major units (e.g. 14000, 89.99). */
  year: number;
  /** ISO 4217 currency code (e.g. "JPY", "USD"). */
  currency: string;
  /** Store-localized monthly price string, or null to format from `month`. */
  monthFormatted: string | null;
  /** Store-localized yearly price string, or null to format from `year`. */
  yearFormatted: string | null;
}

/** Format a money amount for an ISO 4217 currency (JA locale). */
export function formatMoney(amount: number, currency = "JPY"): string {
  try {
    return new Intl.NumberFormat("ja-JP", {
      style: "currency",
      currency,
      // Zero-decimal currencies (JPY, KRW, …) must not render "¥1,500.00".
      // Intl already knows the per-currency default, but be explicit for JPY,
      // the overwhelmingly common case here.
      maximumFractionDigits: currency === "JPY" ? 0 : 2,
    }).format(amount);
  } catch {
    // Unknown/invalid currency code → plain amount + code rather than throwing.
    return `${amount.toLocaleString("ja-JP")} ${currency}`;
  }
}

/** Per-month equivalent of an interval price (year → /12, rounded). */
export function perMonth(plan: PaidPlan, interval: BillingInterval): number {
  const p = PRICING[plan][interval];
  return interval === "year" ? Math.round(p / 12) : p;
}

/** Yearly saving vs paying month-by-month for a plan (one seat). */
export function yearSaving(plan: PaidPlan): number {
  return PRICING[plan].month * 12 - PRICING[plan].year;
}
