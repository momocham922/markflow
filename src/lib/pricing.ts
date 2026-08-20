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

/** Per-month equivalent of an interval price (year → /12, rounded). */
export function perMonth(plan: PaidPlan, interval: BillingInterval): number {
  const p = PRICING[plan][interval];
  return interval === "year" ? Math.round(p / 12) : p;
}

/** Yearly saving vs paying month-by-month for a plan (one seat). */
export function yearSaving(plan: PaidPlan): number {
  return PRICING[plan].month * 12 - PRICING[plan].year;
}
