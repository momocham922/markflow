// =====================================================================
// In-App Purchase pure logic — Apple App Store + Google Play (monetization ③)
// ---------------------------------------------------------------------
// Phase 0 (DARK): the verify / server-notification endpoints in index.ts are
// wired but return 503 until the store products + credentials exist. This module
// holds the PURE mapping from a verified store purchase to an EntitlementIntent —
// same discipline as billing.ts / gating.ts: NO firebase-admin / http / store-SDK
// imports, so it is exhaustively unit-testable (iap.test.ts) and the esbuild
// bundle stays clean. index.ts does the JWS/receipt verification and Firestore
// writes; it feeds the parsed facts into these functions and applies the intent
// through the SAME decideEntitlementWrite pipeline Stripe uses.
//
// CROSS-RAIL SAFETY: every intent carries source ("app_store" | "play") and a
// rail-agnostic subId (Apple originalTransactionId / Play purchaseToken). That is
// what lets decideEntitlementWrite refuse to let an IAP purchase overwrite (or be
// overwritten by) an active Stripe subscription — the multi-rail double-charge
// guard. IAP Team is a FLAT single-user grant (seats:1, no teamId): per-seat Team
// is desktop/web only, so an IAP "team" product meters as a 1-seat pool.
// =====================================================================
import type { EntitlementIntent, OurStatus } from "./billing";

/**
 * Apple auto-renewable subscription product ids → plan + interval. These are the
 * SKUs that must be created in App Store Connect. The bundle id is com.markflow.app
 * (iOS); product ids are namespaced under it. Interval is audit-only (the plan is
 * what gates); both months and years grant the same plan.
 */
export const APPLE_PRODUCTS: Readonly<
  Record<string, { plan: "pro" | "team"; interval: "month" | "year" }>
> = {
  "com.markflow.app.pro.monthly": { plan: "pro", interval: "month" },
  "com.markflow.app.pro.yearly": { plan: "pro", interval: "year" },
  "com.markflow.app.team.monthly": { plan: "team", interval: "month" },
  "com.markflow.app.team.yearly": { plan: "team", interval: "year" },
};

/**
 * Google Play subscription product ids → plan. Play separates the product
 * (com.markflow.app.pro / .team) from the base plan (monthly / yearly), so the
 * PLAN is derived from the product id alone; the base plan (interval) is
 * audit-only and not needed for the gate.
 */
export const PLAY_PRODUCTS: Readonly<Record<string, "pro" | "team">> = {
  "com.markflow.app.pro": "pro",
  "com.markflow.app.team": "team",
};

/** Resolve which plan an Apple product id grants (null = unrecognized). */
export function mapAppleProductToPlan(
  productId: unknown,
): "pro" | "team" | null {
  const id = String(productId ?? "").trim();
  return APPLE_PRODUCTS[id]?.plan ?? null;
}

/** Resolve which plan a Play product id grants (null = unrecognized). */
export function mapPlayProductToPlan(
  productId: unknown,
): "pro" | "team" | null {
  const id = String(productId ?? "").trim();
  return PLAY_PRODUCTS[id] ?? null;
}

/**
 * Map an Apple subscription status (App Store Server API "Get All Subscription
 * Statuses" numeric `status`, also present in the decoded renewal info) to our
 * entitlement status:
 *   1 active                 → active
 *   4 in billing grace       → grace   (access preserved during dunning)
 *   3 in billing retry       → on_hold (retries in progress; access revoked)
 *   2 expired                → canceled
 *   5 revoked (refund/family)→ canceled
 * Returns null for an unknown status so index.ts PRESERVES the current doc (never
 * silently downgrade a payer on a status we don't recognize) — no silent fallback.
 */
export function mapAppleSubStatus(raw: unknown): OurStatus | null {
  switch (Number(raw)) {
    case 1:
      return "active";
    case 4:
      return "grace";
    case 3:
      return "on_hold";
    case 2:
      return "canceled";
    case 5:
      return "canceled";
    default:
      return null;
  }
}

/**
 * Map a Google Play `subscriptionState` (subscriptionsV2) to our entitlement
 * status. CANCELED (auto-renew turned off) still GRANTS access until expiry, so it
 * maps to active — a later EXPIRED event revokes. PAUSED and ON_HOLD both revoke
 * access while retaining the plan for reactivation.
 * Returns null for an unknown/pending state → PRESERVE (no silent downgrade).
 */
export function mapPlayState(raw: unknown): OurStatus | null {
  switch (
    String(raw ?? "")
      .trim()
      .toUpperCase()
  ) {
    case "SUBSCRIPTION_STATE_ACTIVE":
      return "active";
    case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
      return "grace";
    case "SUBSCRIPTION_STATE_ON_HOLD":
      return "on_hold";
    case "SUBSCRIPTION_STATE_PAUSED":
      return "on_hold";
    case "SUBSCRIPTION_STATE_CANCELED":
      return "active";
    case "SUBSCRIPTION_STATE_EXPIRED":
      return "canceled";
    default:
      return null;
  }
}

/**
 * True when an Apple environment string denotes Production (vs Sandbox). Used to
 * REJECT a sandbox receipt in a production deployment (and vice-versa) so a test
 * purchase can never grant a real entitlement. Anything not exactly "Production"
 * (case-insensitive) is treated as non-production — fail closed.
 */
export function isProdEnvironment(raw: unknown): boolean {
  return (
    String(raw ?? "")
      .trim()
      .toLowerCase() === "production"
  );
}

/** ms-epoch → s-epoch (EntitlementIntent.eventCreated/currentPeriodEnd are secs). */
function msToSec(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n / 1000) : 0;
}

/** Parsed facts from a verified Apple transaction/renewal (index.ts decodes JWS). */
export interface AppleFacts {
  productId: unknown;
  /** Numeric App Store subscription status (1..5). */
  status: unknown;
  environment?: unknown;
  originalTransactionId: unknown;
  transactionId?: unknown;
  /** UUID we set as appAccountToken at purchase = the buyer's firebase uid. */
  appAccountToken?: unknown;
  /** Subscription expiry (epoch ms). */
  expiresDateMs?: unknown;
  /** Event/signed time (epoch ms) — the monotonic-ordering key. */
  signedDateMs?: unknown;
  /** Idempotency id: notificationUUID (server notif) or transactionId. */
  eventId: unknown;
}

/** Parsed facts from a verified Play purchase (index.ts calls the Play API). */
export interface PlayFacts {
  productId: unknown;
  /** Play subscriptionState string. */
  subscriptionState: unknown;
  purchaseToken: unknown;
  linkedPurchaseToken?: unknown;
  orderId?: unknown;
  /** obfuscatedExternalAccountId set at purchase = the buyer's firebase uid. */
  externalAccountId?: unknown;
  /** Subscription expiry (epoch ms). */
  expiryTimeMs?: unknown;
  /** Event time (epoch ms) — the monotonic-ordering key. */
  eventTimeMs?: unknown;
  /** Idempotency id: RTDN messageId or purchaseToken. */
  eventId: unknown;
}

export type IapIntentResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** uid candidate from the store's account token (may be empty → index.ts maps). */
      uid: string;
      intent: EntitlementIntent;
    };

/**
 * Build an EntitlementIntent from verified Apple facts, mirroring
 * decideSubscriptionApply's fail-closed-on-grant / fail-safe-on-revoke policy:
 *  - unknown status → { ok:false, unknown_status } (index.ts preserves the doc).
 *  - recognized product → GRANT that plan.
 *  - UNMAPPED product on a revoking status → revoke to free (a rotated-out product
 *    must not let a non-payer keep access); on a granting status → fail closed.
 * The intent is source:"app_store" with subId=originalTransactionId so the
 * cross-rail + terminal scoping in decideEntitlementWrite applies unchanged.
 */
export function buildAppleIntent(facts: AppleFacts): IapIntentResult {
  const status = mapAppleSubStatus(facts.status);
  if (!status) return { ok: false, reason: "unknown_status" };
  const plan = mapAppleProductToPlan(facts.productId);
  const revoking = status === "on_hold" || status === "canceled";
  if (!plan && !revoking) return { ok: false, reason: "unmapped_product" };

  const originalTxId = String(facts.originalTransactionId ?? "").trim();
  if (!originalTxId) return { ok: false, reason: "missing_original_tx" };
  const uid = String(facts.appAccountToken ?? "").trim();
  // Apple REVOKE (5) is final (refund / family-sharing removal): no follow-up
  // event, so it must win a same-second tie and never be resurrected. Expired (2)
  // is NOT terminal — a resubscribe reuses originalTransactionId and arrives
  // strictly newer, clearing the state. terminal is keyed off the RAW status.
  const terminal = Number(facts.status) === 5;

  const intent: EntitlementIntent = {
    plan: plan ?? "free",
    status,
    source: "app_store",
    subId: originalTxId,
    eventId: String(facts.eventId ?? "").trim() || originalTxId,
    eventCreated: msToSec(facts.signedDateMs),
    terminal,
    seats: 1,
    productId: String(facts.productId ?? "").trim() || undefined,
    appStoreOriginalTransactionId: originalTxId,
    appStoreTransactionId:
      String(facts.transactionId ?? "").trim() || undefined,
    appAccountToken: uid || undefined,
    currentPeriodEnd: msToSec(facts.expiresDateMs) || undefined,
    environment: String(facts.environment ?? "").trim() || undefined,
  };
  return { ok: true, uid, intent };
}

/**
 * Build an EntitlementIntent from verified Play facts. Same fail-closed-on-grant /
 * fail-safe-on-revoke policy as buildAppleIntent. source:"play" with
 * subId=purchaseToken (Play issues a new token per subscription, so token equality
 * scopes terminal revokes correctly).
 */
export function buildPlayIntent(facts: PlayFacts): IapIntentResult {
  const status = mapPlayState(facts.subscriptionState);
  if (!status) return { ok: false, reason: "unknown_state" };
  const plan = mapPlayProductToPlan(facts.productId);
  const revoking = status === "on_hold" || status === "canceled";
  if (!plan && !revoking) return { ok: false, reason: "unmapped_product" };

  const token = String(facts.purchaseToken ?? "").trim();
  if (!token) return { ok: false, reason: "missing_purchase_token" };
  const uid = String(facts.externalAccountId ?? "").trim();
  // Play EXPIRED is final for THIS token; a resubscribe issues a NEW token
  // (different subId) and arrives strictly newer. Mark it terminal so a
  // same-second sibling can never resurrect the expired token.
  const terminal =
    String(facts.subscriptionState ?? "")
      .trim()
      .toUpperCase() === "SUBSCRIPTION_STATE_EXPIRED";

  const intent: EntitlementIntent = {
    plan: plan ?? "free",
    status,
    source: "play",
    subId: token,
    eventId: String(facts.eventId ?? "").trim() || token,
    eventCreated: msToSec(facts.eventTimeMs),
    terminal,
    seats: 1,
    productId: String(facts.productId ?? "").trim() || undefined,
    playPurchaseToken: token,
    playLinkedPurchaseToken:
      String(facts.linkedPurchaseToken ?? "").trim() || undefined,
    playOrderId: String(facts.orderId ?? "").trim() || undefined,
    appAccountToken: uid || undefined,
    currentPeriodEnd: msToSec(facts.expiryTimeMs) || undefined,
  };
  return { ok: true, uid, intent };
}
