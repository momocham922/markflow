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
// guard. MOBILE = PRO ONLY: per-seat Team is desktop/web only, so NO team SKU is
// registered (see APPLE_PRODUCTS/PLAY_PRODUCTS) and an IAP "team" product maps to
// null → buildAppleIntent/buildPlayIntent fail closed (unmapped_product) on grant.
// =====================================================================
import type { EntitlementIntent, OurStatus } from "./billing";

/**
 * Apple auto-renewable subscription product ids → plan + interval. These are the
 * SKUs that must be created in App Store Connect. The bundle id is com.markflow.app
 * (iOS); product ids are namespaced under it. Interval is audit-only (the plan is
 * what gates); both months and years grant the same plan.
 *
 * MOBILE = PRO ONLY (invariant): Team is a per-seat product sold on desktop/web
 * only, so NO team SKU is registered here. This is a defense-in-depth fence: even
 * if a `com.markflow.app.team.*` product were somehow purchased, mapAppleProductToPlan
 * returns null → buildAppleIntent fails closed (unmapped_product) on a grant and
 * never mints an IAP plan="team". Re-add a team entry ONLY alongside a real
 * per-seat mobile Team design.
 */
export const APPLE_PRODUCTS: Readonly<
  Record<string, { plan: "pro"; interval: "month" | "year" }>
> = {
  "com.markflow.app.pro.monthly": { plan: "pro", interval: "month" },
  "com.markflow.app.pro.yearly": { plan: "pro", interval: "year" },
};

/**
 * Google Play subscription product ids → plan. Play separates the product
 * (com.markflow.app.pro) from the base plan (monthly / yearly), so the PLAN is
 * derived from the product id alone; the base plan (interval) is audit-only and
 * not needed for the gate. MOBILE = PRO ONLY — no team SKU (see APPLE_PRODUCTS).
 */
export const PLAY_PRODUCTS: Readonly<Record<string, "pro">> = {
  "com.markflow.app.pro": "pro",
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
  /**
   * Transaction revocation time (epoch ms) — set by Apple when THIS transaction
   * was refunded or revoked (family-sharing removal). Present in the decoded
   * JWSTransaction even when data.status still reads active on a single-
   * transaction refund, so it is the authoritative signal to pull access.
   */
  revocationDateMs?: unknown;
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
  /** True when Play marks this a License-tester test purchase (subscriptionsv2
   *  `testPurchase` present). index.ts rejects it unless IAP_ALLOW_SANDBOX. */
  test?: boolean;
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
  // A set revocationDate means THIS transaction was refunded/revoked. Apple may
  // leave data.status=active on a single-transaction refund, so the numeric
  // status alone would keep the buyer on Pro until period end (+ backstop) — a
  // bounded money leak. Treat a revoked transaction exactly like REVOKE(5):
  // terminal "canceled", regardless of the reported status. Mirrors Play's
  // voidedPurchaseNotification → immediate revoke. A genuine later resubscribe
  // arrives strictly-newer and clears terminal (see decideEntitlementWrite).
  const revokedByRefund = msToSec(facts.revocationDateMs) > 0;
  const status = revokedByRefund ? "canceled" : mapAppleSubStatus(facts.status);
  if (!status) return { ok: false, reason: "unknown_status" };
  const plan = mapAppleProductToPlan(facts.productId);
  const revoking = status === "on_hold" || status === "canceled";
  if (!plan && !revoking) return { ok: false, reason: "unmapped_product" };

  const originalTxId = String(facts.originalTransactionId ?? "").trim();
  if (!originalTxId) return { ok: false, reason: "missing_original_tx" };
  const uid = String(facts.appAccountToken ?? "").trim();
  // Apple REVOKE (5) is final (refund / family-sharing removal): no follow-up
  // event, so it must win a same-second tie and never be resurrected. A refund
  // detected via revocationDate is the same event class → also terminal. Expired
  // (2) is NOT terminal — a resubscribe reuses originalTransactionId and arrives
  // strictly newer, clearing the state.
  const terminal = Number(facts.status) === 5 || revokedByRefund;

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

// =====================================================================
// Pure adapters: store-SDK decoded shapes → AppleFacts / PlayFacts.
// ---------------------------------------------------------------------
// index.ts performs the IMPURE verification (Apple SignedDataVerifier / the Play
// Developer API) and hands the DECODED, TRUSTED payload here. These adapters do
// nothing but field extraction + shape-normalisation, so they stay exhaustively
// unit-testable and keep index.ts free of hand-rolled field plucking. They never
// decide trust — a caller must only feed a payload that verification accepted.
// =====================================================================

/** ISO-8601 / RFC-3339 date string → epoch ms (0 when absent/unparseable). */
function isoToMs(v: unknown): number {
  const s = String(v ?? "").trim();
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/** A numeric string/number → finite number, else 0. */
function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Map a verified, decoded Apple JWSTransaction payload (from
 * SignedDataVerifier.verifyAndDecodeTransaction) → AppleFacts. The numeric
 * subscription `status` (1..5) is NOT in the transaction payload — it comes from
 * the App Store Server API "Get All Subscription Statuses" call or the ASSN V2
 * notification `data.status`, so the caller passes it in. `eventId` defaults to
 * the transactionId (the /iap/verify path) but is the notificationUUID for ASSN.
 */
export function appleFactsFromDecoded(
  txn: Record<string, unknown>,
  opts: { status: unknown; eventId?: unknown },
): AppleFacts {
  return {
    productId: txn.productId,
    status: opts.status,
    environment: txn.environment,
    originalTransactionId: txn.originalTransactionId,
    transactionId: txn.transactionId,
    appAccountToken: txn.appAccountToken,
    expiresDateMs: txn.expiresDate,
    revocationDateMs: txn.revocationDate,
    signedDateMs: txn.signedDate,
    eventId:
      String(opts.eventId ?? "").trim() ||
      String(txn.transactionId ?? "").trim(),
  };
}

/**
 * Map a verified Play SubscriptionPurchaseV2 (purchases.subscriptionsv2.get) →
 * PlayFacts. `productId`/`expiryTime` live under lineItems[] in v2; the buyer's
 * hashed uid is externalAccountIdentifiers.obfuscatedExternalAccountId. The
 * caller supplies the purchaseToken (the API path param, not echoed in the body)
 * and the ordering key `eventTimeMs` (Date.now() at /iap/verify, or the RTDN
 * eventTimeMillis) since a Play purchase carries no per-event signed timestamp.
 */
export function playFactsFromPurchaseV2(
  purchase: Record<string, unknown>,
  ctx: {
    productId?: unknown;
    purchaseToken: unknown;
    eventId?: unknown;
    eventTimeMs?: unknown;
  },
): PlayFacts {
  const lineItems = Array.isArray(purchase.lineItems)
    ? (purchase.lineItems as Array<Record<string, unknown>>)
    : [];
  const li0 = lineItems[0] ?? {};
  const ext = (purchase.externalAccountIdentifiers ?? {}) as Record<
    string,
    unknown
  >;
  const token = String(ctx.purchaseToken ?? "").trim();
  return {
    productId: String(li0.productId ?? ctx.productId ?? "").trim(),
    subscriptionState: purchase.subscriptionState,
    purchaseToken: token,
    linkedPurchaseToken: purchase.linkedPurchaseToken,
    orderId: li0.latestSuccessfulOrderId,
    externalAccountId: ext.obfuscatedExternalAccountId,
    expiryTimeMs: isoToMs(li0.expiryTime),
    eventTimeMs: toNum(ctx.eventTimeMs) || isoToMs(purchase.startTime),
    eventId: String(ctx.eventId ?? "").trim() || token,
    // `testPurchase` is present (an object) ONLY for License-tester purchases.
    test: purchase.testPurchase != null,
  };
}

/** A parsed Google Play RTDN (Pub/Sub push envelope → DeveloperNotification). */
export interface RtdnParsed {
  /** Pub/Sub message id — the notification idempotency key. */
  messageId: string;
  packageName: string;
  eventTimeMs: number;
  /** Present for a subscription state change (the common case). */
  subscription?: {
    notificationType: number;
    purchaseToken: string;
    subscriptionId: string;
  };
  /** Present for a refund/chargeback (revoke the entitlement for the token). */
  voided?: {
    purchaseToken: string;
    orderId: string;
    productType: number;
    refundType: number;
  };
  /** True for Google's connectivity test notification (ack, do nothing). */
  test: boolean;
}

/**
 * Parse a Google Play RTDN Pub/Sub push request body → RtdnParsed (null when the
 * envelope is malformed — the caller acks with 400 so Pub/Sub does not redeliver
 * a permanently-broken message). RTDN is a CHANGE-SIGNAL only: the caller must
 * re-fetch the authoritative subscription via the Play Developer API; this only
 * extracts the purchaseToken/subscriptionId to fetch and the messageId to dedupe.
 */
export function parseRtdnEnvelope(rawBody: string): RtdnParsed | null {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return null;
  }
  const message = (envelope?.message ?? null) as Record<string, unknown> | null;
  if (!message || typeof message.data !== "string") return null;
  const messageId = String(
    message.messageId ?? message.message_id ?? "",
  ).trim();
  if (!messageId) return null;

  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(
      Buffer.from(message.data, "base64").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }

  const out: RtdnParsed = {
    messageId,
    packageName: String(decoded.packageName ?? "").trim(),
    eventTimeMs: toNum(decoded.eventTimeMillis),
    test: false,
  };
  const sub = decoded.subscriptionNotification as
    Record<string, unknown> | undefined;
  const voided = decoded.voidedPurchaseNotification as
    Record<string, unknown> | undefined;
  if (sub && typeof sub === "object") {
    out.subscription = {
      notificationType: toNum(sub.notificationType),
      purchaseToken: String(sub.purchaseToken ?? "").trim(),
      subscriptionId: String(sub.subscriptionId ?? "").trim(),
    };
  } else if (voided && typeof voided === "object") {
    out.voided = {
      purchaseToken: String(voided.purchaseToken ?? "").trim(),
      orderId: String(voided.orderId ?? "").trim(),
      productType: toNum(voided.productType),
      refundType: toNum(voided.refundType),
    };
  } else if (decoded.testNotification) {
    out.test = true;
  }
  return out;
}

/**
 * Build a REVOKE intent for a refunded/voided Play purchase
 * (voidedPurchaseNotification carries no subscriptionState, so it cannot go
 * through subscriptionsv2.get). The refund is terminal for the token: canceled +
 * terminal, seats:1, source:"play". uid is resolved by the caller via iapCustomers.
 */
export function buildPlayVoidIntent(
  token: unknown,
  eventId: unknown,
  eventTimeMs: unknown,
): IapIntentResult {
  const t = String(token ?? "").trim();
  if (!t) return { ok: false, reason: "missing_purchase_token" };
  const ms = toNum(eventTimeMs);
  const intent: EntitlementIntent = {
    plan: "free",
    status: "canceled",
    source: "play",
    subId: t,
    eventId: String(eventId ?? "").trim() || t,
    eventCreated: ms > 0 ? Math.floor(ms / 1000) : 0,
    terminal: true,
    seats: 1,
    playPurchaseToken: t,
  };
  return { ok: true, uid: "", intent };
}
