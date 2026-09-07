import http from "http";
import Stripe from "stripe";
import { initializeApp, cert, type ServiceAccount } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  PLAN_LIMITS,
  parseUidSet,
  resolveViewAs,
  derivePlan,
  iapExpiryBackstop,
  periodKey,
  checkQuota,
  isChargeable,
  isAutoResearchAllowed,
  clampBatchReserveMinutes,
  measuredBatchMinutes,
  mergeBatchChunks,
  reconcileBatchDelta,
  failedBatchChargeDelta,
  shouldRefund,
  deriveSeatAccess,
  type Plan,
  type Feature,
} from "./gating";
import {
  reserveUsage,
  adjustUsage as meterAdjustUsage,
  acquireBatchLease,
  releaseBatchLease,
  type MeteringStore,
  type ServerValues,
} from "./metering";
import {
  mapStripeStatus,
  buildPriceMap,
  mapPriceToPlan,
  resolveCheckoutPriceId,
  decideEntitlementWrite,
  decideSubscriptionApply,
  decideTeamBillingWrite,
  clampSeats,
  pickUid,
  toEpochSeconds,
  type EntitlementIntent,
  type TeamBillingIntent,
  type ExistingTeamBilling,
} from "./billing";
import {
  appleFactsFromDecoded,
  playFactsFromPurchaseV2,
  parseRtdnEnvelope,
  buildAppleIntent,
  buildPlayIntent,
  buildPlayVoidIntent,
  isProdEnvironment,
  type IapIntentResult,
} from "./iap";
import {
  handleMcpMessage,
  isRequest,
  isPersonalDocData,
  MAX_RPC_BATCH,
  type McpDoc,
  type McpDeps,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./mcp";
import {
  MCP_PATH,
  PRM_PATH,
  ASM_PATH,
  REGISTER_PATH,
  AUTHORIZE_PATH,
  TOKEN_PATH,
  REVOKE_PATH,
  CODE_TTL_SEC,
  ACCESS_TTL_SEC,
  REFRESH_TTL_SEC,
  hashToken,
  newOpaqueToken,
  verifyPkceS256,
  pickClientIp,
  allowedRedirectHosts,
  buildProtectedResourceMetadata,
  buildAuthServerMetadata,
  validateDcrRequest,
  buildDcrResponse,
  validateAuthorizeRequest,
  matchRedirectUri,
  buildSuccessRedirect,
  buildErrorRedirect,
  parseTokenRequest,
  buildTokenResponse,
} from "./mcp-oauth";
// Store-SDK verification (impure). Marked --external in the esbuild bundle and
// installed in the Docker image; the top-level require runs even when IAP is DARK
// (creds absent), so both packages MUST be present in node_modules at boot.
import {
  SignedDataVerifier,
  AppStoreServerAPIClient,
  Environment,
} from "@apple/app-store-server-library";
import { GoogleAuth } from "google-auth-library";
import { APPLE_ROOT_CERTS } from "./apple-root-certs";
import {
  normalizeFeedbackKind,
  sanitizeMessage,
  sanitizeError,
  feedbackFingerprint,
  shouldNotifyFeedback,
  buildFeedbackSlackPayload,
  type FeedbackKind,
} from "./feedback";
import {
  cleanBatch,
  buildInsertRows,
  type BigQueryInsertRow,
} from "./telemetry";
import { stripThinkingBlocks } from "./thinking";

const PORT = parseInt(process.env.PORT || "8080", 10);
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "markflow-app-2026";
// Claude (Anthropic) Vertex region. Opus 4.7+ are served from the global
// endpoint, not us-east5 regional. GCP_REGION is used ONLY for the Claude
// endpoint below (Gemini/image/STT have their own locations).
const GCP_REGION = process.env.GCP_REGION || "global";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
// Nano Banana Pro (Gemini 3 Pro Image), served from the global endpoint. The
// old `gemini-3.1-flash-image-preview` was retired and now 404s on Vertex,
// which broke all image generation.
const NANOBANANA_MODEL = process.env.NANOBANANA_MODEL || "gemini-3-pro-image";
const STT_LOCATION = process.env.STT_LOCATION || "asia-northeast1";
const STT_MODEL = process.env.STT_MODEL || "chirp_3";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const GCS_BUCKET =
  process.env.GCS_BUCKET || "markflow-app-2026.firebasestorage.app";

// --- Stripe billing config (monetization P1) -------------------------------
// All secrets come from the environment (Secret Manager in prod, NEVER inline).
// When STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are unset the billing routes
// stay DARK: they return 503 billing_not_configured (explicit failure, never a
// silent fallback) and every existing route is unaffected. This lets the code
// ship and deploy before the owner has created the Stripe account/products.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
// Pin to the SDK's version (stripe-node 22.5.0 → 2026-07-29.dahlia). The
// Dashboard webhook endpoint MUST be set to the same version or the event JSON
// shape (item-level billing periods) won't match.
const STRIPE_API_VERSION = "2026-07-29.dahlia";
const STRIPE_PRICES = {
  proMonthly: process.env.STRIPE_PRICE_PRO_MONTHLY || "",
  proYearly: process.env.STRIPE_PRICE_PRO_YEARLY || "",
  teamMonthly: process.env.STRIPE_PRICE_TEAM_MONTHLY || "",
  teamYearly: process.env.STRIPE_PRICE_TEAM_YEARLY || "",
};
const PRICE_MAP = buildPriceMap(
  [STRIPE_PRICES.proMonthly, STRIPE_PRICES.proYearly].filter(Boolean).join(","),
  [STRIPE_PRICES.teamMonthly, STRIPE_PRICES.teamYearly]
    .filter(Boolean)
    .join(","),
);
// Landing pages (HTTPS) the browser returns to; they deep-link back into the app
// via markflow://billing/success|cancel. Defaults live under markflow.jp.
const CHECKOUT_SUCCESS_URL =
  process.env.CHECKOUT_SUCCESS_URL ||
  "https://markflow.jp/checkout/success?session_id={CHECKOUT_SESSION_ID}";
const CHECKOUT_CANCEL_URL =
  process.env.CHECKOUT_CANCEL_URL || "https://markflow.jp/checkout/cancel";
const PORTAL_RETURN_URL =
  process.env.PORTAL_RETURN_URL || "https://markflow.jp/account";

function billingConfigured(): boolean {
  return Boolean(STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET);
}

// Master switch for non-AI paid gates that this server enforces (currently the
// Web-publish serve gate in /p/). Ships DARK: OFF until the owner flips it at GO,
// alongside the LIVE Stripe promotion + the client VITE_BILLING_ENABLED build.
// Kept SEPARATE from billingConfigured() on purpose — billing is live in TEST
// mode right now (keys present), and we must NOT start gating public pages before
// the owner's explicit GO. Set NONAI_GATES_ENABLED=1 to activate.
const NONAI_GATES_ENABLED =
  process.env.NONAI_GATES_ENABLED === "1" ||
  process.env.NONAI_GATES_ENABLED === "true";

// --- In-App Purchase config (monetization ③, Phase 0 DARK) -----------------
// The Apple/Play verify + server-notification endpoints stay DARK (503
// iap_not_configured) until the store credentials exist — exactly like the Stripe
// routes. Purely additive: no existing route is affected. The PURE mapping from a
// verified purchase to an entitlement lives in ./iap.ts (unit-tested); index.ts
// will wire the JWS/Play-API verification in Phase 1 once credentials are set.
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || "";
const APP_STORE_ISSUER_ID = process.env.APP_STORE_ISSUER_ID || "";
const APP_STORE_KEY_ID = process.env.APP_STORE_KEY_ID || "";
const APP_STORE_PRIVATE_KEY = process.env.APP_STORE_PRIVATE_KEY || "";
// The app's numeric App Store id (adamId). REQUIRED by SignedDataVerifier for
// PRODUCTION receipts/notifications (it cross-checks data.appAppleId); Sandbox
// does not use it. Set once the App Store product exists.
const APP_STORE_APP_APPLE_ID =
  Number(process.env.APP_STORE_APP_APPLE_ID) || undefined;
const PLAY_PACKAGE_NAME = process.env.PLAY_PACKAGE_NAME || "";
const PLAY_SERVICE_ACCOUNT = process.env.PLAY_SERVICE_ACCOUNT_JSON || "";
// Sandbox / test-purchase policy. Ships FALSE (production-safe): a StoreKit
// Sandbox transaction (Apple environment !== "Production") or a Play test
// purchase (License-tester `testPurchase` marker) must NEVER grant a real
// entitlement in the production deployment — otherwise a tester with a free
// sandbox subscription gets Pro for real. Set IAP_ALLOW_SANDBOX=1 ONLY on a
// TestFlight/internal-testing build where verifying the purchase flow requires
// accepting sandbox receipts. In production this stays unset → sandbox rejected.
const IAP_ALLOW_SANDBOX =
  process.env.IAP_ALLOW_SANDBOX === "1" ||
  process.env.IAP_ALLOW_SANDBOX === "true";

// Per-uid sandbox allowlist. A handful of internal/tester uids may complete a
// Sandbox (TestFlight) / License-tester purchase so the owner can validate the
// IAP flow end-to-end WITHOUT flipping the global IAP_ALLOW_SANDBOX, which would
// hand real Pro to ANY sandbox tester. This is production-SAFE to keep set: a
// non-listed real user still gets `sandbox_not_allowed`. Consulted at BOTH the
// authed /iap/verify sites (acting uid = VERIFIED Firebase uid) AND the
// server-to-server notification handlers (Apple ASSN / Play RTDN), which resolve
// the bound uid from the transaction/token FIRST, then gate per-uid. Grant and
// revoke MUST use the same gate: if a tester may sandbox-PURCHASE, that tester's
// sandbox EXPIRED/refund must also APPLY, else the entitlement sticks on Pro
// after the sandbox sub expires (the grant/revoke asymmetry that stranded a
// TestFlight tester on stale Pro). Real production events (env=Production /
// non-test) skip the gate and apply as before.
const IAP_SANDBOX_UIDS = new Set(
  (process.env.IAP_SANDBOX_UIDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
/** True when `uid` may complete a sandbox/test purchase (global flag or allowlist). */
function sandboxAllowedFor(uid: string): boolean {
  return IAP_ALLOW_SANDBOX || IAP_SANDBOX_UIDS.has(uid);
}

// --- OAuth token exchange (BFF: keep provider client_secret server-side) ----
// The client secret NEVER ships in the desktop/mobile bundle (a public GitHub
// repo + a distributable binary both leak it). The client runs the browser
// authorization-code flow, then POSTs the received `code` to
// /v1/auth/oauth/exchange; THIS server holds the secret and does the exchange.
// Unauthenticated by design — the user is not signed in yet (this IS the sign-in
// step). Abuse is bounded: a valid code is single-use, provider-issued against
// OUR client_id, and only redeemable for the fixed localhost redirect below.
const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
const GITHUB_OAUTH_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID || "";
const GITHUB_OAUTH_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET || "";
// Only redirect URIs the app actually uses may be redeemed here. This is an
// allowlist, not a trust anchor (the provider already binds the code to a
// registered redirect_uri) — it stops this endpoint being repurposed as a
// generic exchange oracle for some other redirect.
const OAUTH_ALLOWED_REDIRECTS = new Set(
  (process.env.OAUTH_ALLOWED_REDIRECTS || "http://localhost:19847/callback")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Apple IAP verification is configured (all App Store Server API creds present). */
function appleIapConfigured(): boolean {
  return Boolean(
    APPLE_BUNDLE_ID &&
    APP_STORE_ISSUER_ID &&
    APP_STORE_KEY_ID &&
    APP_STORE_PRIVATE_KEY,
  );
}
/** Play IAP verification is configured (package + service account present). */
function playIapConfigured(): boolean {
  return Boolean(PLAY_PACKAGE_NAME && PLAY_SERVICE_ACCOUNT);
}
/** True when EITHER IAP rail is configured (the /iap/verify entry gate). */
function iapConfigured(): boolean {
  return appleIapConfigured() || playIapConfigured();
}

// Upper bound on Team subscription seats (checkout quantity + seat assignment).
// A sanity cap, not a business limit — clampSeats rejects anything outside
// [1, MAX_TEAM_SEATS] so a malformed/absurd seat count can never size the pool
// or the Stripe quantity. Overridable via env for a genuinely larger org.
const MAX_TEAM_SEATS = Math.max(
  1,
  Math.floor(Number(process.env.MAX_TEAM_SEATS) || 100),
);

let _stripe: Stripe | null = null;
/** Lazily construct the Stripe client. Throws if the secret key is unset. */
function getStripe(): Stripe {
  if (!STRIPE_SECRET_KEY) throw new Error("billing_not_configured");
  if (!_stripe) {
    _stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
    });
  }
  return _stripe;
}

/** Extract a Stripe customer id whether the field is expanded or a bare id. */
function stripeCustomerId(
  c: string | { id?: string } | null | undefined,
): string {
  if (!c) return "";
  return typeof c === "string" ? c : c.id || "";
}

/**
 * Idempotency for Stripe's at-least-once, out-of-order delivery. We mark an
 * event as processed ONLY AFTER handleStripeEvent succeeds (see the webhook
 * handler), never before. A mark-BEFORE-process marker stranded by a mid-request
 * crash (Cloud Run scale-down / OOM) would make Stripe's retry read the event as
 * a duplicate and drop it forever — and there is no reconcile job. Because every
 * entitlement write is idempotent (setDoc-merge) and monotonic (isEventNewer +
 * the same-second status tie-break), reprocessing an event is always safe, so
 * mark-after loses no correctness and closes the stranded-marker window.
 */
async function eventAlreadyProcessed(eventId: string): Promise<boolean> {
  const snap = await getFirestore()
    .collection("stripeEvents")
    .doc(eventId)
    .get();
  return snap.exists;
}
async function markEventProcessed(eventId: string): Promise<void> {
  // create() (not set()) so a concurrent double-delivery's second writer hits
  // ALREADY_EXISTS rather than racing; the caller treats that as harmless.
  await getFirestore()
    .collection("stripeEvents")
    .doc(eventId)
    .create({ at: FieldValue.serverTimestamp() });
}

/** Persist the Stripe customer→uid reverse map (for invoice/customer events). */
async function mapCustomerToUid(
  customerId: string,
  uid: string,
  subscriptionId?: string,
): Promise<void> {
  if (!customerId || !uid) return;
  await getFirestore()
    .collection("stripeCustomers")
    .doc(customerId)
    .set(
      {
        uid,
        ...(subscriptionId ? { subscriptionId } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}
async function lookupUidByCustomer(customerId: string): Promise<string | null> {
  if (!customerId) return null;
  try {
    const snap = await getFirestore()
      .collection("stripeCustomers")
      .doc(customerId)
      .get();
    return snap.exists ? String(snap.data()?.uid || "") || null : null;
  } catch (e) {
    console.error(`[stripe] lookupUidByCustomer ${customerId} failed:`, e);
    return null;
  }
}

/** The uid's stored Stripe customer id (entitlement doc), if any. */
async function getStoredCustomerId(uid: string): Promise<string> {
  try {
    const snap = await getFirestore().collection("entitlements").doc(uid).get();
    return snap.exists ? String(snap.data()?.stripeCustomerId || "") : "";
  } catch (e) {
    console.error(`[stripe] getStoredCustomerId ${uid} failed:`, e);
    return "";
  }
}

/**
 * Apply a decided entitlement intent to entitlements/{uid} (setDoc merge, so
 * earlySupporter/teamId survive). Enforces the internal/cross-rail/ordering
 * invariants via decideEntitlementWrite, and busts the in-memory 60s cache so
 * the change is visible immediately on this instance.
 */
async function writeEntitlementFromIntent(
  uid: string,
  intent: EntitlementIntent,
): Promise<void> {
  const db = getFirestore();
  const ref = db.collection("entitlements").doc(uid);
  // Read-decide-write MUST be atomic. Stripe delivers a subscription's lifecycle
  // events out of order and can emit two Events for one change, so several
  // webhooks for the same uid can run concurrently (multiple Cloud Run
  // instances, or overlapping retries). A plain get()→decide()→set() interleaves
  // at the get(): two handlers both read the OLD doc, both decide "apply", and
  // the one that writes LAST wins — which can be the older/stale event, undoing
  // the ordering + terminal-revoke invariants decideEntitlementWrite enforces
  // (a permanent money leak, since there is no reconcile job). Running it inside
  // a Firestore transaction makes the whole read-decide-write serialize per doc;
  // Firestore auto-retries on contention and decideEntitlementWrite is pure, so
  // re-running against the winner's fresh state is always correct.
  const decision = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = decideEntitlementWrite(
      snap.exists ? (snap.data() as Record<string, unknown>) : null,
      intent,
    );
    if (d.apply) {
      tx.set(
        ref,
        { ...d.fields, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }
    return d;
  });
  if (!decision.apply) {
    // Money-risk refusals: a purchase whose write was refused because ANOTHER
    // rail still owns a live doc (owned_by_*) or a terminal targeted the wrong
    // sub (terminal_other_sub) can mean a customer was CHARGED but not granted —
    // or not revoked. Elevate those to error level (with rail + sub context) so a
    // Cloud Logging alert policy can catch them; benign ordering/idempotency
    // skips (stale_event, internal_untouchable) stay at log level.
    const reason = decision.reason;
    const moneyRisk =
      reason.startsWith("owned_by_") || reason === "terminal_other_sub";
    const src = intent.source ?? "stripe";
    const sub = intent.subId ?? intent.stripeSubscriptionId ?? "";
    const line = `entitlement skip uid=${uid} reason=${reason} source=${src} sub=${sub} evt=${intent.eventId}`;
    if (moneyRisk) console.error(`[billing][ALERT] ${line}`);
    else console.log(`[billing] ${line}`);
    return;
  }
  entCache.delete(uid);
  console.log(
    `[billing] entitlement set uid=${uid} plan=${decision.fields.plan} status=${decision.fields.status} source=${intent.source ?? "stripe"} evt=${intent.eventId}`,
  );
}

// =====================================================================
// In-App Purchase verification I/O (monetization ③) — Apple + Google Play.
// ---------------------------------------------------------------------
// The IMPURE half of ./iap.ts: Apple JWS verification via
// @apple/app-store-server-library and Play verification via the Android Publisher
// REST API (google-auth-library mints the service-account token). The decoded,
// TRUSTED payloads are handed to the ./iap.ts pure builders and the resulting
// intent is applied through writeEntitlementFromIntent — the SAME cross-rail-safe
// pipeline Stripe uses (decideEntitlementWrite refuses to let an IAP purchase
// overwrite an active Stripe sub, and vice-versa). Everything here is DARK: the
// endpoints return 503 before any of this runs until store credentials exist.
//
// uid binding: the buyer's firebase uid is bound to the store subscription id
// (Apple originalTransactionId / Play purchaseToken) in iapCustomers at
// /iap/verify, where the uid is the VERIFIED Firebase token — never a
// client-asserted account token. The unauthenticated server notifications (Apple
// ASSN / Play RTDN) resolve the uid from that binding.
// =====================================================================

let _appleVerifierProd: SignedDataVerifier | null = null;
let _appleVerifierSandbox: SignedDataVerifier | null = null;
/**
 * Lazily build the per-environment Apple signed-data verifier. enableOnlineChecks
 * is false: the certificate chain is validated offline against the embedded Apple
 * roots (no OCSP round-trip that could flake and reject a valid payment). A prod
 * receipt is verified with the prod verifier, a sandbox receipt with the sandbox
 * verifier — callers try prod first and fall back to sandbox on mismatch.
 */
function appleVerifier(production: boolean): SignedDataVerifier {
  if (production) {
    if (!_appleVerifierProd) {
      _appleVerifierProd = new SignedDataVerifier(
        APPLE_ROOT_CERTS,
        false,
        Environment.PRODUCTION,
        APPLE_BUNDLE_ID,
        APP_STORE_APP_APPLE_ID,
      );
    }
    return _appleVerifierProd;
  }
  if (!_appleVerifierSandbox) {
    _appleVerifierSandbox = new SignedDataVerifier(
      APPLE_ROOT_CERTS,
      false,
      Environment.SANDBOX,
      APPLE_BUNDLE_ID,
      undefined,
    );
  }
  return _appleVerifierSandbox;
}

let _appleApiProd: AppStoreServerAPIClient | null = null;
let _appleApiSandbox: AppStoreServerAPIClient | null = null;
/** Lazily build the per-environment App Store Server API client (ES256 JWT auth). */
function appleApi(production: boolean): AppStoreServerAPIClient {
  if (production) {
    if (!_appleApiProd) {
      _appleApiProd = new AppStoreServerAPIClient(
        APP_STORE_PRIVATE_KEY,
        APP_STORE_KEY_ID,
        APP_STORE_ISSUER_ID,
        APPLE_BUNDLE_ID,
        Environment.PRODUCTION,
      );
    }
    return _appleApiProd;
  }
  if (!_appleApiSandbox) {
    _appleApiSandbox = new AppStoreServerAPIClient(
      APP_STORE_PRIVATE_KEY,
      APP_STORE_KEY_ID,
      APP_STORE_ISSUER_ID,
      APPLE_BUNDLE_ID,
      Environment.SANDBOX,
    );
  }
  return _appleApiSandbox;
}

/**
 * Verify + decode a StoreKit2 signed transaction JWS, routing environment
 * automatically: production first, sandbox on failure (the standard Apple
 * pattern — a tampered receipt fails BOTH verifiers and throws, so it is
 * rejected, never granted).
 */
async function appleVerifyTransaction(
  jws: string,
): Promise<{ txn: Record<string, unknown>; production: boolean }> {
  try {
    const txn = await appleVerifier(true).verifyAndDecodeTransaction(jws);
    return { txn: txn as unknown as Record<string, unknown>, production: true };
  } catch {
    const txn = await appleVerifier(false).verifyAndDecodeTransaction(jws);
    return {
      txn: txn as unknown as Record<string, unknown>,
      production: false,
    };
  }
}

/** Verify + decode an App Store Server Notification V2 (prod → sandbox routing). */
async function appleVerifyNotification(
  signedPayload: string,
): Promise<Record<string, unknown>> {
  try {
    return (await appleVerifier(true).verifyAndDecodeNotification(
      signedPayload,
    )) as unknown as Record<string, unknown>;
  } catch {
    return (await appleVerifier(false).verifyAndDecodeNotification(
      signedPayload,
    )) as unknown as Record<string, unknown>;
  }
}

/**
 * The authoritative numeric subscription status (1..5) + the latest signed
 * transaction for an originalTransactionId, via "Get All Subscription Statuses".
 * The status is NOT carried in the transaction JWS, so /iap/verify calls this to
 * learn whether the sub is active/grace/on-hold/expired/revoked. Returns null
 * when the id is unknown to the App Store.
 */
async function appleAuthoritativeStatus(
  originalTransactionId: string,
  production: boolean,
): Promise<{ status: number; signedTransactionInfo?: string } | null> {
  const resp = (await appleApi(production).getAllSubscriptionStatuses(
    originalTransactionId,
  )) as unknown as Record<string, unknown>;
  const groups = Array.isArray(resp?.data)
    ? (resp.data as Array<Record<string, unknown>>)
    : [];
  const pick = (lt: Record<string, unknown>) => ({
    status: Number(lt?.status),
    signedTransactionInfo: lt?.signedTransactionInfo
      ? String(lt.signedTransactionInfo)
      : undefined,
  });
  for (const g of groups) {
    const lasts = Array.isArray(g?.lastTransactions)
      ? (g.lastTransactions as Array<Record<string, unknown>>)
      : [];
    for (const lt of lasts) {
      if (
        String(lt?.originalTransactionId ?? "").trim() === originalTransactionId
      ) {
        return pick(lt);
      }
    }
  }
  const first = groups[0]?.lastTransactions as
    Array<Record<string, unknown>> | undefined;
  const lt0 = Array.isArray(first) ? first[0] : undefined;
  return lt0 ? pick(lt0) : null;
}

let _playAuth: GoogleAuth | null = null;
function playAuth(): GoogleAuth {
  if (!_playAuth) {
    _playAuth = new GoogleAuth({
      credentials: JSON.parse(PLAY_SERVICE_ACCOUNT),
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });
  }
  return _playAuth;
}
async function playAccessToken(): Promise<string> {
  const client = await playAuth().getClient();
  const t = await client.getAccessToken();
  const token = typeof t === "string" ? t : t?.token;
  if (!token) throw new Error("play_auth_failed");
  return token;
}
/** Authoritative subscription state via purchases.subscriptionsv2.get (REST). */
async function playGetSubscriptionV2(
  token: string,
): Promise<Record<string, unknown>> {
  const at = await playAccessToken();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(PLAY_PACKAGE_NAME)}/purchases/subscriptionsv2/tokens/` +
    `${encodeURIComponent(token)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${at}` } });
  const text = await r.text();
  if (!r.ok) throw new Error(`play_get_failed ${r.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}
/** Acknowledge a Play subscription (else Google auto-refunds within ~3 days). */
async function playAcknowledge(
  productId: string,
  token: string,
): Promise<void> {
  const at = await playAccessToken();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(PLAY_PACKAGE_NAME)}/purchases/subscriptions/` +
    `${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${at}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  // 410 Gone = already acknowledged / expired — harmless.
  if (!r.ok && r.status !== 410) {
    const t = await r.text();
    throw new Error(`play_ack_failed ${r.status} ${t}`);
  }
}

/** iapEvents dedupe (mirror of stripeEvents; mark AFTER successful handling). */
async function iapEventAlreadyProcessed(eventId: string): Promise<boolean> {
  const snap = await getFirestore().collection("iapEvents").doc(eventId).get();
  return snap.exists;
}
async function markIapEventProcessed(eventId: string): Promise<void> {
  // create() (not set()) so a concurrent double-delivery's second writer hits
  // ALREADY_EXISTS; the caller treats a mark failure as non-fatal (idempotent).
  await getFirestore()
    .collection("iapEvents")
    .doc(eventId)
    .create({ at: FieldValue.serverTimestamp() });
}

/**
 * Sentinel returned by bindIapCustomer when ownership cannot be proven (the
 * owner read failed, or create() failed leaving no binding on record). Callers
 * MUST treat it as "cannot verify → do not grant" and return a retryable error,
 * never as this uid owning the sub (fail closed — no silent grant).
 */
const IAP_OWNER_UNVERIFIABLE = "__iap_owner_unverifiable__";

/** iapCustomers doc for a store subscription id (Firestore ids cannot hold "/"). */
function iapCustomerRef(subId: string) {
  return getFirestore()
    .collection("iapCustomers")
    .doc(subId.replace(/\//g, "_"));
}
/**
 * Bind a store subscription id → firebase uid, CREATE-ONCE (first claimant wins),
 * and return the EFFECTIVE owner uid the subId is bound to. A different uid
 * claiming an already-bound subId is an anomaly (a second app account signing in
 * on the same device's Apple ID / Play account, or abuse) and is refused + logged
 * — never silently reassigned. Returning the owner lets /iap/verify refuse to
 * grant Pro to a NON-owner, so one paid store subscription can never leak Pro to
 * multiple Firebase accounts (越境課金防止).
 */
async function bindIapCustomer(
  subId: string,
  uid: string,
  meta: Record<string, unknown> = {},
): Promise<string | null> {
  if (!subId || !uid) return null;
  const ref = iapCustomerRef(subId);
  try {
    await ref.create({ uid, ...meta, createdAt: FieldValue.serverTimestamp() });
    return uid; // first claimant wins → this uid now owns the subId
  } catch (createErr) {
    // create() failed — normally ALREADY_EXISTS (someone already claimed this
    // subId). Read the existing owner to decide. If the READ also fails, or the
    // create failed for a NON-exists reason and left no binding on record, we
    // CANNOT prove ownership — fail CLOSED (never grant on an unverifiable
    // binding) rather than returning this uid and leaking Pro across accounts.
    let snap;
    try {
      snap = await ref.get();
    } catch (readErr) {
      console.error(
        `[iap] bindIapCustomer ${subId} owner read failed:`,
        readErr,
      );
      return IAP_OWNER_UNVERIFIABLE;
    }
    const existing = snap.exists ? String(snap.data()?.uid || "") : "";
    if (!existing) {
      // No binding recorded but create() failed → transient/unverifiable, not a
      // real first-claim. Fail closed instead of granting to this uid.
      console.error(
        `[iap] bindIapCustomer ${subId} create failed with no record:`,
        createErr,
      );
      return IAP_OWNER_UNVERIFIABLE;
    }
    if (existing !== uid) {
      console.error(
        `[iap] subId ${subId} already bound to ${existing}; refused ${uid}`,
      );
      return existing; // subId belongs to a DIFFERENT account
    }
    return existing; // same uid re-verifying (idempotent restore)
  }
}
async function lookupIapCustomer(subId: string): Promise<string | null> {
  if (!subId) return null;
  try {
    const snap = await iapCustomerRef(subId).get();
    return snap.exists ? String(snap.data()?.uid || "") || null : null;
  } catch (e) {
    console.error(`[iap] lookupIapCustomer ${subId} failed:`, e);
    return null;
  }
}

/** Apply a built IAP intent for a resolved uid through the shared pipeline. */
async function applyIapIntent(
  uid: string,
  result: IapIntentResult,
  ctx: string,
): Promise<boolean> {
  if (!result.ok) {
    console.warn(`[iap] ${ctx} skip: ${result.reason}`);
    return false;
  }
  if (!uid) {
    console.error(
      `[iap] ${ctx} no uid for subId=${result.intent.subId} — cannot apply`,
    );
    return false;
  }
  await writeEntitlementFromIntent(uid, result.intent);
  return true;
}

/**
 * Whether `uid` may MANAGE a team's billing/seats (buy seats, change seat count,
 * assign/unassign members). Owner + admin only — the seat-management permission
 * the owner chose. ownerId is the definitive owner; members[] carries per-member
 * roles ("owner"|"admin"|"member"). A member with no explicit role is a plain
 * member. Never trusts client input — teamData is read server-side from Firestore.
 */
function isTeamManager(
  teamData: Record<string, unknown> | null | undefined,
  uid: string,
): boolean {
  if (!teamData || !uid) return false;
  if (String(teamData.ownerId || "").trim() === uid) return true;
  const members = Array.isArray(teamData.members)
    ? (teamData.members as Array<{ uid?: unknown; role?: unknown }>)
    : [];
  return members.some(
    (m) =>
      String(m?.uid || "").trim() === uid &&
      ["owner", "admin"].includes(
        String(m?.role || "")
          .trim()
          .toLowerCase(),
      ),
  );
}

/**
 * Apply a decided team-billing intent to teams/{teamId}.billing (setDoc merge, so
 * name/members/folders/seatAssignments survive). Enforces the monotonic-ordering
 * + terminal-scoping invariants via decideTeamBillingWrite inside a transaction
 * (same reasoning as writeEntitlementFromIntent: out-of-order/concurrent webhooks
 * must serialize per doc). Busts the entitlement cache for the owner AND every
 * currently-assigned member so a seat-count / status change is visible at once on
 * this instance (other instances self-heal on the 15s TTL). The team must already
 * exist (created by the collaboration layer) — a billing event never fabricates a
 * team; it logs team_not_found and skips.
 */
async function writeTeamBillingFromIntent(
  teamId: string,
  intent: TeamBillingIntent,
): Promise<void> {
  if (!teamId) return;
  const db = getFirestore();
  const ref = db.collection("teams").doc(teamId);
  let affected: string[] = [];
  const decision = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists)
      return { apply: false, reason: "team_not_found" } as const;
    const data = snap.data() as Record<string, unknown>;
    const existing = (data.billing ?? null) as ExistingTeamBilling | null;
    const d = decideTeamBillingWrite(existing, intent);
    if (d.apply) {
      tx.set(
        ref,
        {
          billing: { ...d.fields, updatedAt: FieldValue.serverTimestamp() },
        },
        { merge: true },
      );
      affected = Array.isArray(data.seatAssignments)
        ? (data.seatAssignments as string[])
        : [];
    }
    return d;
  });
  if (!decision.apply) {
    console.log(
      `[stripe] team billing skip team=${teamId} reason=${decision.reason} evt=${intent.eventId}`,
    );
    return;
  }
  entCache.delete(intent.ownerUid);
  for (const memberUid of affected) entCache.delete(memberUid);
  console.log(
    `[stripe] team billing set team=${teamId} status=${decision.fields.status} seats=${decision.fields.seats} evt=${intent.eventId}`,
  );
}

/** Build+apply the entitlement intent from an authoritative Subscription. */
async function applySubscription(
  uid: string,
  sub: Stripe.Subscription,
  eventId: string,
  eventCreated: number,
): Promise<void> {
  const ourStatus = mapStripeStatus(sub.status);
  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id;
  const plan = mapPriceToPlan(priceId, PRICE_MAP);
  // Team subscriptions carry the funded team id in metadata and the seat count in
  // the item quantity. Resolved here so both the grant and revoke paths can write
  // teams/{teamId}.billing alongside the owner's entitlement doc.
  const subTeamId = String(sub.metadata?.teamId || "").trim();
  const subSeats = Math.max(1, Math.floor(Number(item?.quantity) || 1));
  // The grant/revoke/skip decision (unknown status, unmapped price, fail-closed
  // on grant but fail-safe on revoke) is a pure function so it has a regression
  // net (billing.test.ts) — index.ts itself is not unit-tested.
  const action = decideSubscriptionApply(ourStatus, plan);
  switch (action.action) {
    case "skip_unknown_status":
      // Unknown Stripe status → preserve current state, never silently downgrade.
      console.error(
        `[stripe] unknown subscription status "${sub.status}" sub=${sub.id}; preserving entitlement`,
      );
      return;
    case "skip_unmapped_grant":
      // A price we don't recognize on a non-revoking event: never grant a plan
      // for it (fail closed). Only reached when ourStatus is active/grace.
      console.error(
        `[stripe] price ${priceId} not mapped to a plan (sub=${sub.id}); skipping grant`,
      );
      return;
    case "revoke_unmapped":
      // Fail SAFE on REVOKE: this event revokes access (unpaid/paused → on_hold,
      // canceled/incomplete → canceled) but the price is unmapped (e.g. a price
      // id rotated out of env while a subscriber still holds it). Downgrade to
      // free so a non-payer can't retain paid access on a config drift. ourStatus
      // is guaranteed on_hold|canceled here (decideSubscriptionApply contract).
      await writeEntitlementFromIntent(uid, {
        plan: "free",
        status: ourStatus as "on_hold" | "canceled",
        eventId,
        eventCreated,
        stripeCustomerId: stripeCustomerId(sub.customer),
        stripeSubscriptionId: sub.id,
        cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
      });
      // If this revoked sub funded a team, propagate the revoked status to the
      // team billing doc so assigned members lose the shared pool (deriveSeatAccess
      // denies on non-active/grace). Not terminal — only a delete event is.
      if (subTeamId) {
        await writeTeamBillingFromIntent(subTeamId, {
          status: ourStatus as "on_hold" | "canceled",
          seats: subSeats,
          ownerUid: uid,
          eventId,
          eventCreated,
          stripeCustomerId: stripeCustomerId(sub.customer),
          stripeSubscriptionId: sub.id,
          stripeSubscriptionItemId: item?.id,
        });
      }
      return;
    case "grant": {
      // current_period_end moved to the item level as of API Basil (2025-03-31).
      const periodEnd = toEpochSeconds(
        (item as unknown as { current_period_end?: number })
          ?.current_period_end,
      );
      const isTeam = action.plan === "team";
      // For a team grant the pool is metered under the funded team id (falling back
      // to the owner's uid if metadata is somehow absent), sized by the seat count.
      const teamId = isTeam ? subTeamId || uid : "";
      await writeEntitlementFromIntent(uid, {
        plan: action.plan,
        // ourStatus is non-null on the grant path (decideSubscriptionApply
        // returns skip_unknown_status when it is null).
        status: ourStatus as "active" | "grace" | "on_hold" | "canceled",
        eventId,
        eventCreated,
        stripeCustomerId: stripeCustomerId(sub.customer),
        stripeSubscriptionId: sub.id,
        currentPeriodEnd: periodEnd || undefined,
        cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
        priceId: priceId || undefined,
        // Team-only: seats sizes the shared pool; teamId keys it. Both invisible to
        // the gate (derivePlan reads {plan,status} only) but read by computeEntitlement.
        ...(isTeam ? { seats: subSeats, teamId } : {}),
      });
      if (isTeam) {
        await writeTeamBillingFromIntent(teamId, {
          status: ourStatus as "active" | "grace" | "on_hold" | "canceled",
          seats: subSeats,
          ownerUid: uid,
          eventId,
          eventCreated,
          stripeCustomerId: stripeCustomerId(sub.customer),
          stripeSubscriptionId: sub.id,
          stripeSubscriptionItemId: item?.id,
          currentPeriodEnd: periodEnd || undefined,
          priceId: priceId || undefined,
        });
      }
      return;
    }
  }
}

/** Resolve the uid a Subscription belongs to (metadata first, then reverse map). */
async function resolveSubscriptionUid(
  sub: Stripe.Subscription,
): Promise<string | null> {
  const fromMeta = pickUid([sub.metadata?.firebaseUid]);
  if (fromMeta) return fromMeta;
  const uid = await lookupUidByCustomer(stripeCustomerId(sub.customer));
  if (!uid) console.error(`[stripe] cannot resolve uid for sub ${sub.id}`);
  return uid;
}

/**
 * Process one verified Stripe event. Drives entitlement state from the
 * authoritative Subscription object for every path (checkout just establishes
 * the customer↔uid map, then defers to the subscription). Grace (past_due) and
 * renewal (back to active) both arrive as customer.subscription.updated, so
 * invoice.* events are intentionally not needed for the gate.
 */
async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  const eventCreated = toEpochSeconds(event.created);
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "subscription") return;
      const uid = pickUid([
        session.client_reference_id,
        session.metadata?.firebaseUid,
      ]);
      if (!uid) {
        console.error(`[stripe] no uid on checkout.session ${session.id}`);
        return;
      }
      const customerId = stripeCustomerId(session.customer);
      const subId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id || "";
      if (customerId)
        await mapCustomerToUid(customerId, uid, subId || undefined);
      if (subId) {
        const sub = await getStripe().subscriptions.retrieve(subId);
        await applySubscription(uid, sub, event.id, eventCreated);
      }
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const snap = event.data.object as Stripe.Subscription;
      const uid = await resolveSubscriptionUid(snap);
      if (!uid) return;
      // Apply the LIVE subscription (re-fetched), not the possibly-stale event
      // snapshot, so two same-second sibling events (created@incomplete +
      // updated@active) observe the current status and converge; the exact-tie
      // status precedence in decideEntitlementWrite settles a residual race.
      // Fall back to the snapshot if the retrieve fails (e.g. already deleted).
      let sub = snap;
      try {
        sub = await getStripe().subscriptions.retrieve(snap.id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[stripe] retrieve sub ${snap.id} failed, using event snapshot: ${msg}`,
        );
      }
      await mapCustomerToUid(stripeCustomerId(sub.customer), uid, sub.id);
      await applySubscription(uid, sub, event.id, eventCreated);
      return;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const uid = await resolveSubscriptionUid(sub);
      if (!uid) return;
      await writeEntitlementFromIntent(uid, {
        plan: "free",
        status: "canceled",
        eventId: event.id,
        eventCreated,
        // Terminal: a deletion is final, has no live re-fetch and no follow-up
        // event, so it must win a same-second tie against the preceding
        // updated@active (otherwise the canceled user keeps paid access forever).
        terminal: true,
        stripeCustomerId: stripeCustomerId(sub.customer),
        stripeSubscriptionId: sub.id,
        cancelAtPeriodEnd: false,
      });
      // If this sub funded a team, terminally revoke the team billing doc too
      // (seats:0, terminal) so every assigned member loses the shared pool and a
      // same-second sibling can never resurrect it.
      const delTeamId = String(sub.metadata?.teamId || "").trim();
      if (delTeamId) {
        await writeTeamBillingFromIntent(delTeamId, {
          status: "canceled",
          seats: 0,
          ownerUid: uid,
          eventId: event.id,
          eventCreated,
          terminal: true,
          stripeCustomerId: stripeCustomerId(sub.customer),
          stripeSubscriptionId: sub.id,
        });
      }
      return;
    }
    default:
      // Other event types are not needed for the gate.
      return;
  }
}

// Initialize Firebase Admin (uses default service account on Cloud Run)
initializeApp();

// Adapt the real Firestore to the DI surface metering.ts expects. This is the
// ONLY place the metering primitives touch firebase-admin — the primitives
// themselves stay pure/testable. `fn as never` bridges the structural mismatch
// between firebase's Transaction and our minimal UsageTxn (runtime-compatible;
// the server bundle is not tsc-checked, so a runtime-correct cast is fine).
const meteringStore: MeteringStore = {
  usageDoc: (uid, ym) =>
    getFirestore()
      .collection("usage")
      .doc(uid)
      .collection("months")
      .doc(ym) as never,
  batchLockDoc: (uid) =>
    getFirestore().collection("batchLocks").doc(uid) as never,
  runTransaction(fn) {
    return getFirestore().runTransaction(fn as never);
  },
};

// Per-uid batch-transcribe in-flight lease: cap concurrent BatchRecognize jobs
// at 1 so a fan-out of concurrent requests cannot launch dozens of paid
// multi-minute STT jobs in parallel (see metering.ts decideBatchLease). MUST
// exceed the Cloud Run request timeout (900s) so a legitimately long batch is
// never reclaimed as "stale" while it is still running.
const BATCH_LEASE_STALE_MS = 20 * 60 * 1000;
// Hard cap on chunks per batch-transcribe request. Each chunk launches its own
// paid BatchRecognize job, so an unbounded chunk array is a parallel cost bomb;
// the pre-flight reserve now floors at 1 min/chunk (clampBatchReserveMinutes) but
// this cap bounds the fan-out independently. The client splits recordings into
// ≤55-min chunks, so 48 chunks covers ~44h — far beyond any real recording.
const MAX_BATCH_CHUNKS = 48;
const serverValues: ServerValues = {
  increment: (n) => FieldValue.increment(n),
  serverTimestamp: () => FieldValue.serverTimestamp(),
};

// Safely send a JSON error. If headers were already sent (a stream started, or the
// client disconnected mid-response), writing a status throws ERR_HTTP_HEADERS_SENT,
// which would surface as an unhandled rejection and crash the instance — so just
// close the socket instead.
function sendJsonError(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

/**
 * A thrown error is an auth failure when it comes from token verification.
 * Every endpoint should surface these as 401 (not 500) so the client can drive
 * a re-auth / token-refresh flow instead of treating it as a server outage.
 *
 * INVARIANT: this substring test is only safe because the ONLY errors reaching
 * the outer catches are our own token-verification throws — every endpoint
 * writes upstream (Vertex/GCP) failures via their own `!res.ok` status and never
 * `throw`s the upstream body up. If you ever re-throw an upstream error body
 * into an outer catch, a GCP 401/403 whose text contains "Authorization" would
 * be mis-reported to the client as an auth failure, masking a real 5xx outage.
 */
function isAuthErrorMessage(message: string): boolean {
  return (
    message.includes("Authorization") ||
    message.includes("Firebase ID token") ||
    message.includes("Decoding Firebase ID token")
  );
}

function getVertexAiUrl(): string {
  // The global endpoint host has no region prefix.
  const host =
    GCP_REGION === "global"
      ? "aiplatform.googleapis.com"
      : `${GCP_REGION}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${GCP_PROJECT_ID}/locations/${GCP_REGION}/publishers/anthropic/models/${CLAUDE_MODEL}:streamRawPredict`;
}

function getNanoBananaUrl(): string {
  return `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/global/publishers/google/models/${NANOBANANA_MODEL}:generateContent`;
}

function getGeminiUrl(model: string): string {
  return `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/global/publishers/google/models/${model}:generateContent`;
}

function classifyCredibility(
  domain: string,
): "academic" | "official" | "news" | "general" {
  const d = domain.toLowerCase();
  if (
    [".edu", ".ac.jp", ".ac.uk"].some((s) => d.endsWith(s)) ||
    [
      "scholar.google",
      "arxiv.org",
      "pubmed",
      "researchgate.net",
      "doi.org",
    ].some((s) => d.includes(s))
  )
    return "academic";
  if (
    [".go.jp", ".gov", ".gov.uk"].some((s) => d.endsWith(s)) ||
    ["who.int", "un.org", "europa.eu"].some((s) => d.includes(s))
  )
    return "official";
  if (
    [
      "nikkei.com",
      "reuters.com",
      "bloomberg.com",
      "nhk.or.jp",
      "bbc.com",
      "nytimes.com",
      "wsj.com",
      "ft.com",
      "techcrunch.com",
      "theverge.com",
    ].some((s) => d.includes(s))
  )
    return "news";
  return "general";
}

async function getGcpAccessToken(): Promise<string> {
  const metadataUrl =
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
  const res = await fetch(metadataUrl, {
    headers: { "Metadata-Flavor": "Google" },
  });
  if (!res.ok)
    throw new Error("Failed to get access token from metadata server");
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// Upstream statuses that are worth a retry: rate limits and transient overload.
// 529 is Anthropic/Vertex "overloaded"; 503 is Gemini/Vertex unavailable. A 4xx
// other than 429 is a caller/config error and is NOT retried.
const TRANSIENT_UPSTREAM_STATUS = new Set([429, 500, 502, 503, 529]);

// Retry a fetch thunk on transient upstream failures with exponential backoff.
// Returns the FINAL Response (which may still be non-OK) so the caller decides
// how to degrade — this helper never throws on an HTTP error status and never
// reads the returned body (the caller owns it). The discarded body of a failed
// intermediate attempt is drained so the socket can be reused.
async function fetchUpstreamWithRetry(
  make: () => Promise<Response>,
  opts?: { attempts?: number; baseDelayMs?: number },
): Promise<Response> {
  const attempts = opts?.attempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 500;
  let last: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    const r = await make();
    if (r.ok || !TRANSIENT_UPSTREAM_STATUS.has(r.status)) return r;
    last = r;
    if (i < attempts - 1) {
      try {
        await r.text(); // drain the discarded body before retrying
      } catch {
        /* ignore */
      }
      await new Promise((res) => setTimeout(res, baseDelayMs * 2 ** i));
    }
  }
  return last as Response;
}

// Revocation / disabled-account check for the metered (cost-incurring) paths.
// verifyIdToken(token, true) makes a getUser() round-trip to Firebase Auth on
// every call, so we cache "this uid passed a full revocation check at T" for a
// short TTL: the added latency is one round-trip per uid per window (not per
// request), and the window bounds how long a revoked/disabled user could keep
// spending quota after being signed-out-everywhere / disabled.
const REVOCATION_TTL_MS = 5 * 60 * 1000;
const REVOCATION_CACHE_MAX = 50000;
const revocationCheckedAt = new Map<string, number>();

// Firebase Auth error codes meaning the credential is genuinely no longer valid
// (signed out everywhere / password changed / account disabled or deleted).
// These fail CLOSED (rethrow → 401). Any OTHER error from the revocation
// round-trip is transient (network blip to Firebase Auth) — the base token has
// already passed signature + expiry verification, so we log explicitly and
// allow rather than couple a Firebase outage to a total auth outage.
const REVOCATION_HARD_CODES = new Set([
  "auth/id-token-revoked",
  "auth/user-disabled",
  "auth/user-not-found",
]);

async function verifyFirebaseToken(
  authHeader: string | undefined,
  opts?: { checkRevoked?: boolean },
): Promise<string> {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }
  const idToken = authHeader.slice(7);
  // Signature + expiry validation — uses cached public keys, no network call.
  const decoded = await getAuth().verifyIdToken(idToken);
  const uid = decoded.uid;

  if (opts?.checkRevoked) {
    const now = Date.now();
    const last = revocationCheckedAt.get(uid) || 0;
    if (now - last > REVOCATION_TTL_MS) {
      try {
        // Throws auth/id-token-revoked or auth/user-disabled if the credential
        // is no longer valid; also re-fetches the user (catches deletion).
        await getAuth().verifyIdToken(idToken, true);
        if (revocationCheckedAt.size > REVOCATION_CACHE_MAX) {
          revocationCheckedAt.clear();
        }
        revocationCheckedAt.set(uid, now);
      } catch (e) {
        const code = (e as { code?: string })?.code || "";
        if (REVOCATION_HARD_CODES.has(code)) {
          throw e; // fail closed — genuinely revoked / disabled / deleted
        }
        // Transient — base token is cryptographically valid and unexpired.
        console.error(
          `[auth] revocation check transient failure for ${uid}: ${code || e}`,
        );
      }
    }
  }

  return uid;
}

// =====================================================================
// Account deletion cascade (Apple App Store Guideline 5.1.1(v))
// ---------------------------------------------------------------------
// Deleting an account must remove ALL of the user's data. These helpers run via
// the Admin SDK / GCS JSON API (bypassing Firestore + Storage rules) since much
// of that data is server-write-only (entitlements/usage/teamSeats) or client-
// deny (published/*). Each helper is best-effort and bounded so a single stuck
// object never wedges the overall deletion — the last step (auth-user delete)
// still runs so the account is genuinely gone.
// =====================================================================

/** Max pages (× 200 docs) a single collection sweep will process. A backstop
 *  against an unbounded loop if some deletes keep failing (they'd re-match). */
const ACCOUNT_DELETE_MAX_PAGES = 100;

/**
 * Delete every document in `collection` where `field == value`, 200 at a time.
 * `perDoc` (optional) runs before each doc is deleted (e.g. to remove a coupled
 * Storage object or cancel a subscription). `recursive` uses recursiveDelete so
 * subcollections (versions/research_sessions/comments, usage months, ai_chats)
 * are removed too. Per-doc failures are logged and skipped. Returns the count
 * successfully deleted.
 */
async function deleteDocsWhere(
  collection: string,
  field: string,
  value: string,
  opts?: {
    recursive?: boolean;
    perDoc?: (id: string, data: Record<string, unknown>) => Promise<void>;
  },
): Promise<number> {
  const db = getFirestore();
  let total = 0;
  for (let page = 0; page < ACCOUNT_DELETE_MAX_PAGES; page++) {
    const snap = await db
      .collection(collection)
      .where(field, "==", value)
      .limit(200)
      .get();
    if (snap.empty) break;
    let progressed = false;
    for (const doc of snap.docs) {
      if (opts?.perDoc) {
        try {
          await opts.perDoc(doc.id, doc.data() as Record<string, unknown>);
        } catch (e) {
          console.error(
            `[account/delete] perDoc ${collection}/${doc.id} failed:`,
            e,
          );
        }
      }
      try {
        if (opts?.recursive) await db.recursiveDelete(doc.ref);
        else await doc.ref.delete();
        total++;
        progressed = true;
      } catch (e) {
        console.error(
          `[account/delete] delete ${collection}/${doc.id} failed:`,
          e,
        );
      }
    }
    // If a whole page failed to delete, another pass would re-fetch the same
    // docs forever — stop rather than spin.
    if (!progressed) break;
    if (snap.size < 200) break;
  }
  return total;
}

/**
 * Delete every Storage object under `prefix` (e.g. `audio/<uid>/`) via the GCS
 * JSON API, paginating through the listing. 404s count as already-gone. A single
 * object failure is logged and the sweep continues. Returns the count removed.
 */
async function deleteStoragePrefix(prefix: string): Promise<number> {
  const token = await getGcpAccessToken();
  let deleted = 0;
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const listUrl =
      `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o` +
      `?prefix=${encodeURIComponent(prefix)}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!listRes.ok) {
      const t = await listRes.text().catch(() => "");
      console.error(
        `[account/delete] list ${prefix} failed ${listRes.status}: ${t}`,
      );
      break;
    }
    const data = (await listRes.json()) as {
      items?: { name?: string }[];
      nextPageToken?: string;
    };
    for (const item of data.items ?? []) {
      const name = item.name;
      if (!name) continue;
      const delUrl = `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o/${encodeURIComponent(
        name,
      )}`;
      const del = await fetch(delUrl, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (del.ok || del.status === 404) deleted++;
      else {
        const t = await del.text().catch(() => "");
        console.error(
          `[account/delete] delete object ${name} failed ${del.status}: ${t}`,
        );
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken && ++pages < ACCOUNT_DELETE_MAX_PAGES);
  return deleted;
}

/**
 * Best-effort cancellation of a user's personal Stripe subscription when their
 * account is deleted, so a removed user is never charged again. No-op when Stripe
 * is unconfigured (DARK) or the user has no customer. Never throws.
 */
async function cancelPersonalStripeSubscription(uid: string): Promise<void> {
  if (!billingConfigured()) return;
  try {
    const entSnap = await getFirestore()
      .collection("entitlements")
      .doc(uid)
      .get();
    const customerId = String(entSnap.data()?.stripeCustomerId || "").trim();
    if (!customerId) return;
    const stripe = getStripe();
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
    });
    for (const sub of subs.data) {
      if (["canceled", "incomplete_expired"].includes(sub.status)) continue;
      try {
        await stripe.subscriptions.cancel(sub.id);
      } catch (e) {
        console.error(
          `[account/delete] cancel sub ${sub.id} for ${uid} failed:`,
          e,
        );
      }
    }
  } catch (e) {
    console.error(`[account/delete] stripe cleanup for ${uid} failed:`, e);
  }
}

// =====================================================================
// Entitlement & usage metering (monetization P0)
// ---------------------------------------------------------------------
// Source of truth: Firestore `entitlements/{uid}` — SERVER-WRITE-ONLY (see
// firebase/firestore.rules; clients can read their own but never write).
// Usage counters live at `usage/{uid}/months/{yyyy-mm}` (also server-only).
//
// Internal staff (plan "internal") bypass all metering — MarkFlow is currently
// an internal tool and staff cost is intentionally unbounded. Free/Pro/Team are
// metered per calendar month (Asia/Tokyo) and blocked with HTTP 429 when over
// limit. Enforcement lives here at the proxy boundary because it is the only
// tamper-proof gate (client gates are bypassable via devtools + ID token).
//
// Pure decision logic (limits, plan derivation, quota check, period key, batch
// metering) lives in ./gating.ts so it can be unit-tested exhaustively.
// =====================================================================

// Operational fail-safe: uids listed here are always treated as internal even
// if their entitlement doc is unreadable. Set via Cloud Run env INTERNAL_UIDS
// (comma-separated) so staff can never be blocked by a Firestore blip.
const INTERNAL_UIDS = parseUidSet(process.env.INTERNAL_UIDS);

// Owner "view-as" preview: uids allowed to fully impersonate a general-user
// plan (free/pro/team) for previewing gated UX AND real server-side metering
// (429s). Set via Cloud Run env OWNER_UIDS (comma-separated). SECURITY: the
// X-View-As header is honored ONLY for these uids — a non-owner's header is
// ignored. The owner is always "internal" (max), so any override is a
// downgrade/lateral move; it can never escalate privileges, and it only ever
// affects the owner's own usage document.
const OWNER_UIDS = parseUidSet(process.env.OWNER_UIDS);

// Remote-MCP allowlist: uids permitted to connect Claude to their MarkFlow docs
// via the /mcp OAuth server. DARK by default — with this unset the ENTIRE MCP
// feature (discovery, OAuth, /mcp) 404s as if absent, so stable builds ship it
// off. Set via Cloud Run env MCP_UIDS (comma-separated) to enable per-uid.
const MCP_UIDS = parseUidSet(process.env.MCP_UIDS);

// Public Firebase web config (JSON) rendered into the MCP /authorize Google
// sign-in page so the user can authenticate in their browser during the OAuth
// flow. Injected via Cloud Run env MCP_FIREBASE_WEB_CONFIG. This is the SAME
// public config that ships in every client binary (apiKey/authDomain/projectId/
// …) — not a secret — but env-injected so the repo stays config-free. Unset =>
// /authorize returns 503 (dark-safe).
const MCP_FIREBASE_WEB_CONFIG = process.env.MCP_FIREBASE_WEB_CONFIG || "";

// Optional: pin the externally-visible origin used to build MCP discovery
// metadata + OAuth issuer/endpoints, instead of deriving it from the (proxy-
// supplied, spoofable) Host / X-Forwarded-Host headers. Set to the canonical
// public URL, e.g. https://markflow-ai-proxy-smgwadzxwq-an.a.run.app. Unset =>
// derive from headers (previous behaviour).
const MCP_PUBLIC_ORIGIN = (process.env.MCP_PUBLIC_ORIGIN || "").replace(
  /\/+$/,
  "",
);

// Trusted redirect hosts for MCP OAuth clients (confused-deputy defense).
// claude.ai/claude.com + loopback are built in; add more (comma-separated) via
// MCP_ALLOWED_REDIRECT_HOSTS without a code change.
const MCP_ALLOWED_REDIRECT_HOSTS = allowedRedirectHosts(
  process.env.MCP_ALLOWED_REDIRECT_HOSTS,
);

// Slack Agent-notification webhook for the feedback pipeline. Injected via Secret
// Manager in Cloud Run (never committed). Unset = DARK: feedback is still stored,
// the notification is just skipped (logged), so the endpoint is safe to ship
// before the secret is wired.
const FEEDBACK_SLACK_WEBHOOK = process.env.FEEDBACK_SLACK_WEBHOOK || "";

/**
 * Best-effort Slack notification for a feedback event. Never throws into the
 * request path — a webhook hiccup must not fail the user's report (already
 * persisted by the time this runs). DARK-safe: no-op when the webhook is unset.
 */
async function notifyFeedbackSlack(payload: unknown): Promise<void> {
  if (!FEEDBACK_SLACK_WEBHOOK) {
    console.log("[feedback] slack webhook unset — notification skipped");
    return;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const resp = await fetch(FEEDBACK_SLACK_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        console.error(`[feedback] slack notify http ${resp.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error(
      `[feedback] slack notify failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------
// Telemetry → BigQuery. DARK by default: TELEMETRY_ENABLED must be "true" AND
// the dataset/table must exist. When dark the endpoint accepts-and-drops (200,
// stored:0) so a consenting client's offline queue drains instead of growing
// unbounded for a sink that isn't live yet. Uses ADC (Cloud Run's service
// account) + the BigQuery insertAll REST API — no extra npm dependency.
// ---------------------------------------------------------------------
const TELEMETRY_ENABLED =
  (process.env.TELEMETRY_ENABLED || "").trim().toLowerCase() === "true";
const BQ_DATASET = process.env.BQ_DATASET || "markflow_analytics";
const BQ_TELEMETRY_TABLE = process.env.BQ_TELEMETRY_TABLE || "events";

let _bqAuth: GoogleAuth | null = null;
function bqAuth(): GoogleAuth {
  if (!_bqAuth) {
    // No explicit credentials → Application Default Credentials (the Cloud Run
    // runtime service account). It needs roles/bigquery.dataEditor on the dataset.
    _bqAuth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/bigquery.insertdata"],
    });
  }
  return _bqAuth;
}
async function bqAccessToken(): Promise<string> {
  const client = await bqAuth().getClient();
  const t = await client.getAccessToken();
  const token = typeof t === "string" ? t : t?.token;
  if (!token) throw new Error("bq_auth_failed");
  return token;
}

/**
 * Stream rows into the telemetry table (tabledata.insertAll). Returns the number
 * of rows BigQuery accepted. skipInvalidRows/ignoreUnknownValues make a single
 * malformed row lossy rather than failing the whole batch. Throws only on a
 * transport / auth / HTTP error so the caller can decide to 5xx (client retries).
 */
async function bqInsertTelemetry(rows: BigQueryInsertRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const at = await bqAccessToken();
  const url =
    `https://bigquery.googleapis.com/bigquery/v2/projects/` +
    `${encodeURIComponent(GCP_PROJECT_ID)}/datasets/${encodeURIComponent(BQ_DATASET)}` +
    `/tables/${encodeURIComponent(BQ_TELEMETRY_TABLE)}/insertAll`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${at}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      kind: "bigquery#tableDataInsertAllRequest",
      skipInvalidRows: true,
      ignoreUnknownValues: true,
      rows,
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`bq_insert_failed ${r.status} ${text}`);
  const body = JSON.parse(text) as {
    insertErrors?: Array<{ index: number; errors: unknown[] }>;
  };
  const failed = body.insertErrors?.length ?? 0;
  if (failed > 0) {
    console.error(
      `[telemetry] ${failed}/${rows.length} rows rejected by BigQuery: ${JSON.stringify(body.insertErrors?.slice(0, 3))}`,
    );
  }
  return rows.length - failed;
}

// Consent gate (defense-in-depth). The client only SENDS telemetry when the user
// has consented and mirrors that flag to user_settings/{uid}.telemetry_consent;
// the server independently verifies it here so a client bug / forged request
// can't write telemetry for a non-consenting user. Fails CLOSED (no consent
// record → treated as NOT consented). Cached briefly to avoid a Firestore read
// per batch.
const consentCache = new Map<string, { ok: boolean; at: number }>();
const CONSENT_TTL_MS = 5 * 60 * 1000;
async function telemetryConsent(uid: string): Promise<boolean> {
  const now = Date.now();
  const hit = consentCache.get(uid);
  if (hit && now - hit.at < CONSENT_TTL_MS) return hit.ok;
  let ok = false;
  try {
    const snap = await getFirestore().doc(`user_settings/${uid}`).get();
    ok = snap.exists && snap.data()?.telemetry_consent === true;
  } catch (err) {
    // Fail closed — a lookup blip must not silently open telemetry.
    console.error(
      `[telemetry] consent read failed uid=${uid}: ${err instanceof Error ? err.message : String(err)}`,
    );
    ok = false;
  }
  consentCache.set(uid, { ok, at: now });
  return ok;
}

/**
 * Resolve the effective plan for a request: real plan (internal allowlist or
 * entitlement doc), then apply the owner-only view-as override if present.
 */
async function resolvePlan(
  req: http.IncomingMessage,
  uid: string,
): Promise<{
  realPlan: Plan;
  plan: Plan;
  viewAs: Plan | null;
  meterKey: string;
  seats: number;
  source: string | null;
  expiresDate: number | null;
}> {
  let real: ResolvedEntitlement;
  if (INTERNAL_UIDS.has(uid)) {
    // Internal allowlist is unmetered — meter under the uid (never consulted).
    real = {
      realPlan: "internal",
      meterKey: uid,
      seats: 1,
      source: null,
      expiresDate: null,
    };
  } else {
    real = await loadEntitlement(uid);
  }
  const viewAs = resolveViewAs(req.headers["x-view-as"], uid, OWNER_UIDS);
  // view-as overrides only the EFFECTIVE plan (limits/gating preview for owners);
  // metering stays keyed/sized by the REAL entitlement so a preview never charges
  // the wrong pool.
  return {
    realPlan: real.realPlan,
    plan: viewAs ?? real.realPlan,
    viewAs,
    meterKey: real.meterKey,
    seats: real.seats,
    source: real.source ?? null,
    expiresDate: real.expiresDate ?? null,
  };
}

/**
 * The metered identity of a uid: its real plan, the POOL key usage is metered
 * under (uid for free/pro/internal; teamId for a Team owner or assigned member —
 * a single shared pool), and the seat count that sizes a team pool (1 otherwise).
 */
interface ResolvedEntitlement {
  realPlan: Plan;
  meterKey: string;
  seats: number;
  /**
   * The billing rail that owns THIS uid's own subscription doc (stripe /
   * app_store / play / founder), or null for free / an assigned team MEMBER (who
   * owns no subscription). The client uses it to route "契約を管理" to the correct
   * surface — Stripe's customer portal has no record of an Apple/Google IAP sub,
   * so an IAP subscriber must be sent to the store's own management UI instead.
   */
  source?: string | null;
  /**
   * Subscription period end (epoch MILLISECONDS) for a paid own-subscription, or
   * null. Surfaced to the client so the plan panel can show the renewal/expiry
   * date; also the input to computeEntitlement's read-time IAP expiry backstop.
   */
  expiresDate?: number | null;
  // Set when the plan could NOT be resolved (Firestore error) and we fell back to
  // "free". Lets callers that must fail OPEN (the publish serve-gate) tell a
  // genuine free plan apart from a lookup blip. The AI metering path ignores it
  // (a blip still meters as free = fail-closed on quota, the intended trade-off).
  degraded?: boolean;
}

const entCache = new Map<string, ResolvedEntitlement & { at: number }>();
// Short TTL so a plan change (cancel / upgrade / seat (un)assignment) written by
// the webhook or a seat endpoint becomes visible quickly. The writer busts THIS
// instance's cache immediately (entCache.delete on write), but Cloud Run runs
// multiple instances and a write only mutates the one it lands on — so OTHER
// instances serve the cached value until their entry expires. 15s bounds that
// cross-instance staleness to a brief window (residual, LOW: a just-canceled or
// just-unassigned user keeps access for ≤15s on instances that didn't receive
// the write; self-heals on expiry, and the client re-polls).
const ENT_TTL_MS = 15_000;

async function loadEntitlement(uid: string): Promise<ResolvedEntitlement> {
  const cached = entCache.get(uid);
  const now = Date.now();
  if (cached && now - cached.at < ENT_TTL_MS) return cached;
  const resolved = await computeEntitlement(uid);
  // Never cache a degraded (error-derived) result: caching "free" from a blip
  // would poison this instance for the full TTL and turn a momentary Firestore
  // hiccup into ~15s of wrong answers. Let the next call retry instead.
  if (!resolved.degraded) entCache.set(uid, { ...resolved, at: now });
  return resolved;
}

// MCP eligibility: who may connect Claude to their MarkFlow docs via the /mcp
// OAuth server. MCP_UIDS is BOTH the master switch and an explicit allowlist —
// unset (size 0) keeps the ENTIRE feature dark (the route-level 404 stays), and
// any uid listed there is ALWAYS allowed (owner / named testers), so a Firestore
// blip can never lock them out. Beyond that, internal staff (INTERNAL_UIDS) and
// paid users (Pro/Team) are eligible, so the feature is usable by a limited set
// without hand-listing every uid. Plan is read via the same 15s-cached
// entitlement as metering: a plan lapse revokes access within ~15s cross-instance
// and, for a live session, by the next access-token mint (≤1h) or refresh. Owner
// / internal / listed uids short-circuit BEFORE the Firestore read (zero extra
// cost on the hot /mcp path); only paid non-listed users incur the cached lookup.
async function mcpEligible(uid: string): Promise<boolean> {
  if (MCP_UIDS.size === 0) return false; // feature dark
  if (!uid) return false;
  if (MCP_UIDS.has(uid)) return true; // explicit allowlist (owner / named testers)
  if (INTERNAL_UIDS.has(uid)) return true; // internal staff, never blocked by a blip
  const ent = await loadEntitlement(uid);
  return ent.realPlan === "pro" || ent.realPlan === "team";
}

/**
 * Resolve a uid's metered identity from Firestore (no cache). Order of precedence:
 *  1. Own entitlement is a paid Team subscription → meter under the funded team
 *     pool (teamId), sized by the subscription's seat count. This is the OWNER
 *     (or a self-funded team account); their entitlement doc carries teamId+seats.
 *  2. Own entitlement is pro/internal → a per-uid pool, 1 seat.
 *  3. Own entitlement is free → the uid may still be an ASSIGNED member of another
 *     team: consult the teamSeats/{uid} reverse index, then the team doc, and
 *     grant the shared team pool ONLY when deriveSeatAccess confirms an active,
 *     in-capacity seat. Otherwise free.
 * Fails to a per-uid FREE pool (never unlimited) on any Firestore error.
 */
async function computeEntitlement(uid: string): Promise<ResolvedEntitlement> {
  try {
    const db = getFirestore();
    const snap = await db.collection("entitlements").doc(uid).get();
    const data = snap.exists ? (snap.data() as Record<string, unknown>) : null;
    const source = data?.source ? String(data.source) : null;
    // Stored subscription period end (SECONDS — iap.ts msToSec / billing.ts).
    const periodEndSec = Number(data?.currentPeriodEnd) || 0;
    const expiresDate = periodEndSec > 0 ? periodEndSec * 1000 : null;
    const derived = data ? derivePlan(data) : "free";
    // Read-time IAP expiry backstop (money-leak guard) — pure logic in gating.ts
    // (iapExpiryBackstop), the clock injected here. Response-only: we do NOT write
    // from this hot read path — the next /iap/verify or a (re)delivered
    // notification persists the terminal doc.
    const nowSec = Math.floor(Date.now() / 1000);
    const plan = iapExpiryBackstop(derived, source, periodEndSec, nowSec);
    if (plan !== derived) {
      console.warn(
        `[iap] expiry backstop: uid=${uid} source=${source} periodEnd=${periodEndSec} now=${nowSec} — treating as free (missed lifecycle notification?)`,
      );
    }
    if (plan === "team") {
      const teamId = String(data?.teamId || "").trim() || uid;
      const seats = Math.max(1, Math.floor(Number(data?.seats) || 1));
      return { realPlan: "team", meterKey: teamId, seats, source, expiresDate };
    }
    if (plan === "pro" || plan === "internal") {
      return {
        realPlan: plan,
        meterKey: uid,
        seats: 1,
        source,
        // internal is unmetered/admin-seeded — no meaningful expiry to show.
        expiresDate: plan === "internal" ? null : expiresDate,
      };
    }
    // free own-entitlement → maybe an assigned member of a paid team. The team
    // MEMBER owns no subscription of their own (the team owner's doc holds the
    // rail), so source stays null — "契約を管理" is not their action.
    const seat = await resolveTeamSeat(db, uid);
    if (seat)
      return {
        realPlan: "team",
        meterKey: seat.teamId,
        seats: seat.seats,
        source: null,
        expiresDate: null,
      };
    // A backstop-expired IAP sub reads as free here but keeps its `source` so the
    // client can still explain WHERE the lapsed subscription lived if needed.
    return { realPlan: "free", meterKey: uid, seats: 1, source, expiresDate };
  } catch (err) {
    // Fail to per-uid "free" (NOT unlimited) so a Firestore blip can neither
    // break the product nor leak unlimited cost. Logged explicitly — never silent.
    console.error(`loadEntitlement failed for ${uid}:`, err);
    return { realPlan: "free", meterKey: uid, seats: 1, degraded: true };
  }
}

/**
 * Resolve a uid's Team seat via the teamSeats/{uid} reverse index → team doc.
 * Returns the funded team pool ONLY when the team's billing is active/grace AND
 * the uid holds an in-capacity assigned seat (deriveSeatAccess); else null.
 */
async function resolveTeamSeat(
  db: FirebaseFirestore.Firestore,
  uid: string,
): Promise<{ teamId: string; seats: number } | null> {
  const idx = await db.collection("teamSeats").doc(uid).get();
  if (!idx.exists) return null;
  const teamId = String(idx.data()?.teamId || "").trim();
  if (!teamId) return null;
  const teamSnap = await db.collection("teams").doc(teamId).get();
  if (!teamSnap.exists) return null;
  const t = teamSnap.data() as Record<string, unknown>;
  // Current membership gate: a uid removed from the team must lose the shared
  // pool IMMEDIATELY, even if a stale seatAssignments entry still names them.
  // removeTeamMember is a client Firestore write that strips memberUids but does
  // not (cannot securely) rewrite the server-authoritative seatAssignments, so
  // deriveSeatAccess alone would keep granting a fired member access. Requiring
  // BOTH current membership AND an in-capacity seat closes that at the server
  // gate (authoritative — cannot be bypassed by the client).
  const memberUids = Array.isArray(t?.memberUids)
    ? (t.memberUids as unknown[]).map((u) => String(u ?? "").trim())
    : [];
  if (!memberUids.includes(uid)) return null;
  const billing = t?.billing as
    { status?: unknown; seats?: unknown } | undefined;
  const assignments = Array.isArray(t?.seatAssignments)
    ? (t.seatAssignments as string[])
    : [];
  if (!deriveSeatAccess(billing, assignments, uid).access) return null;
  const seats = Math.max(1, Math.floor(Number(billing?.seats) || 1));
  return { teamId, seats };
}

// Result of a guard() call. `ok:false` means a 429 was already written and the
// caller MUST return. On `ok:true`, `charged` tells whether quota was actually
// consumed (false for internal/unlimited or a fail-open DB error) so failure
// paths know whether a refund/reconcile is warranted.
type GuardResult =
  | {
      ok: true;
      charged: boolean;
      uid: string;
      /** The usage pool this charge landed in (uid, or teamId for a team pool). */
      meterKey: string;
      plan: Plan;
      feature: Feature;
      cost: number;
      ym: string;
    }
  | { ok: false };

/**
 * Atomically check + reserve `cost` units of `feature` for `uid`. On over-limit
 * writes a 429 and returns { ok:false } — the caller MUST return immediately.
 * Internal/unlimited plans and fail-open DB errors return { ok:true, charged:
 * false } (no Firestore write, so no refund is ever attempted for them).
 */
async function guard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  uid: string,
  feature: Feature,
  cost = 1,
): Promise<GuardResult> {
  const { plan, meterKey, seats } = await resolvePlan(req, uid);
  const ym = periodKey(new Date());
  const precheck = checkQuota(plan, feature, 0, cost, seats);
  if (precheck.unlimited) {
    return { ok: true, charged: false, uid, meterKey, plan, feature, cost, ym };
  }
  try {
    // Meter under meterKey (the shared team pool for a Team member/owner; the uid
    // otherwise) and size the ceiling by seat count (1 for non-team).
    const result = await reserveUsage(
      meteringStore,
      serverValues,
      meterKey,
      feature,
      cost,
      plan,
      ym,
      seats,
    );
    if (result.blocked) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "quota_exceeded",
          feature,
          plan,
          limit: precheck.limit,
          used: result.used,
        }),
      );
      return { ok: false };
    }
    return { ok: true, charged: true, uid, meterKey, plan, feature, cost, ym };
  } catch (err) {
    // Fail CLOSED on metering-infra error. A metered plan whose usage counter
    // cannot be read/incremented must NOT be granted the feature for free — that
    // is exactly the "user at their limit slips through during a Firestore blip"
    // money leak (project rule: サイレントフォールバック禁止・障害は明示的に失敗させろ).
    // Internal/unlimited plans never reach here (precheck.unlimited returned
    // above), so this only fails a genuinely metered request. Surfaced as a
    // retriable 503 with a stable code the client maps to a friendly message —
    // never a silent success and never a raw error string.
    console.error(`guard tx failed for ${uid}/${feature}:`, err);
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "metering_unavailable",
        feature,
        retryable: true,
      }),
    );
    return { ok: false };
  }
}

/**
 * Adjust a usage counter by `delta` (may be negative). Used both to refund a
 * reserved cost when the upstream call fails and to reconcile a batch reserve to
 * the server-measured actual. No-op for delta 0. Best-effort; errors are logged,
 * never thrown (a failed refund must not turn a successful request into a 500).
 */
async function adjustUsage(
  key: string,
  feature: Feature,
  delta: number,
  plan: Plan,
  ym: string,
): Promise<void> {
  try {
    await meterAdjustUsage(
      meteringStore,
      serverValues,
      key,
      feature,
      delta,
      plan,
      ym,
    );
  } catch (err) {
    console.error(`adjustUsage(${delta}) failed for ${key}/${feature}:`, err);
  }
}

/**
 * Refund a reserved cost when a guarded request did not complete successfully.
 * Only refunds when quota was actually charged and the request was not
 * committed. Safe to call in a `finally`.
 */
async function refundIfUncommitted(
  g: GuardResult | null,
  committed: boolean,
): Promise<void> {
  // shouldRefund treats a non-ok GuardResult ({ok:false}) as never-refund; the
  // `g.ok &&` guard here narrows the union so g.uid/feature/cost/plan/ym are
  // accessible after the pure check passes.
  if (!shouldRefund(g && g.ok ? g : null, committed)) return;
  if (!g || !g.ok) return;
  await adjustUsage(g.meterKey, g.feature, -g.cost, g.plan, g.ym);
}

// =====================================================================
// Remote MCP server + OAuth 2.1 Authorization Server
// ---------------------------------------------------------------------
// Exposes the signed-in user's PERSONAL documents (ownerId == uid, read-only) to
// Claude as an MCP server over Streamable HTTP, protected by an OAuth 2.1 AS we
// host here. Pure protocol/crypto logic lives in ./mcp + ./mcp-oauth (unit
// tested); this section is the Firestore/HTTP wiring. All state lives in
// server-write-only Firestore collections; codes/tokens are stored by SHA-256
// hash (raw secret never persisted). See firestore.rules.
// =====================================================================

const MCP_CLIENTS = "mcp_oauth_clients";
const MCP_CODES = "mcp_oauth_codes";
const MCP_ACCESS = "mcp_access_tokens";
const MCP_REFRESH = "mcp_refresh_tokens";
// Authoritative revocation signal: one tiny doc per revoked token family. It is
// the SOURCE OF TRUTH for family revocation because the best-effort delete sweep
// can miss docs (rotation accumulates docs; a query page is bounded). Every token
// grant/use checks it, so a token that survives the sweep — or is minted racing
// the sweep — is still rejected the instant its family is tombstoned.
const MCP_REVOKED_FAMILIES = "mcp_revoked_families";

// Cap the personal-doc set a single MCP tool call scans. get_document fetches a
// full body on demand, so list/search only need a bounded recent window.
const MCP_MAX_DOCS = 500;

function mcpNowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// Escape a string for safe interpolation into HTML text/attribute content.
function mcpEscHtml(s: string): string {
  return String(s).replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] || c,
  );
}

// Throttle the unauthenticated MCP surface (in-memory, per instance — sufficient
// for the small --max-instances pool). Buckets are keyed strings; a GLOBAL key
// backstops per-IP keys so X-Forwarded-For rotation can't buy unlimited budget.
// mcpClientIp uses the spoof-resistant rightmost XFF entry.
const mcpRateBuckets = new Map<string, number[]>();
// Hard ceiling on distinct keys: an attacker rotating source addresses (e.g. an
// IPv6 /64 on the dual-stack run.app ingress) would otherwise create a new key
// per request. When exceeded we evict the OLDEST keys unconditionally (LRU via
// Map insertion order) rather than only fully-stale ones, so the Map — and the
// per-request bookkeeping cost — stays bounded regardless of key churn.
const MCP_RATE_MAX_KEYS = 20000;
function mcpRateHit(
  key: string,
  maxPerWindow: number,
  windowSec: number,
): boolean {
  const now = mcpNowSec();
  const hits = (mcpRateBuckets.get(key) || []).filter(
    (t) => now - t < windowSec,
  );
  // This request is limited when the in-window count already meets the cap.
  const limited = hits.length >= maxPerWindow;
  // Record it, but never let a single hot key's array grow past the cap (+1):
  // once we know the boolean answer, more timestamps add nothing.
  if (hits.length <= maxPerWindow) hits.push(now);
  // Re-insert last so this key becomes most-recently-used (LRU touch).
  mcpRateBuckets.delete(key);
  mcpRateBuckets.set(key, hits);
  while (mcpRateBuckets.size > MCP_RATE_MAX_KEYS) {
    const oldest = mcpRateBuckets.keys().next().value;
    if (oldest === undefined) break;
    mcpRateBuckets.delete(oldest);
  }
  return limited;
}
function mcpClientIp(req: http.IncomingMessage): string {
  return pickClientIp(
    req.headers["x-forwarded-for"],
    req.socket.remoteAddress || undefined,
  );
}
// Per-IP-FIRST composition: check the per-IP bucket and, if it already tripped,
// return WITHOUT charging the global bucket — so one flooding source can only
// spend its own per-IP budget and can never drain the shared global bucket to
// 429 the legitimate owner. The global cap is still charged (and enforced) for
// requests that stay under their per-IP cap, which is exactly the distributed /
// address-rotating case it exists to bound.
function mcpComposeRateLimit(
  ipKey: string,
  maxPerIp: number,
  globalKey: string,
  maxGlobal: number,
  windowSec: number,
): boolean {
  if (mcpRateHit(ipKey, maxPerIp, windowSec)) return true;
  return mcpRateHit(globalKey, maxGlobal, windowSec);
}
// DCR is unauthenticated and writes a permanent client doc → tight caps.
const MCP_DCR_WINDOW_SEC = 3600;
const MCP_DCR_MAX_PER_IP = 20;
const MCP_DCR_MAX_GLOBAL = 200;
function mcpDcrRateLimited(ip: string): boolean {
  return mcpComposeRateLimit(
    "dcr:" + ip,
    MCP_DCR_MAX_PER_IP,
    "dcr:__global__",
    MCP_DCR_MAX_GLOBAL,
    MCP_DCR_WINDOW_SEC,
  );
}
// The unauthenticated MCP OAuth routes (token/authorize/revoke) each touch
// Firestore before auth can fail; a looser per-minute cap bounds cost/quota DoS.
// NOTE: /mcp itself is NOT limited here — it is throttled per-authenticated-uid
// inside mcpHandleRpc AFTER the bearer check, so a flood of the shared pre-auth
// buckets can never 429 the owner's own authenticated RPC traffic.
const MCP_ROUTE_WINDOW_SEC = 60;
const MCP_ROUTE_MAX_PER_IP = 120;
const MCP_ROUTE_MAX_GLOBAL = 600;
function mcpRouteRateLimited(ip: string): boolean {
  return mcpComposeRateLimit(
    "rt:" + ip,
    MCP_ROUTE_MAX_PER_IP,
    "rt:__global__",
    MCP_ROUTE_MAX_GLOBAL,
    MCP_ROUTE_WINDOW_SEC,
  );
}
// Per-authenticated-uid throttle for /mcp JSON-RPC, applied only AFTER the bearer
// token resolves to an MCP-eligible uid. Generous — a single client legitimately
// batches calls — but bounds a compromised/looping client's Firestore fan-out.
const MCP_RPC_WINDOW_SEC = 60;
const MCP_RPC_MAX_PER_UID = 300;
function mcpRpcRateLimited(uid: string): boolean {
  return mcpRateHit("rpc:" + uid, MCP_RPC_MAX_PER_UID, MCP_RPC_WINDOW_SEC);
}
// Pre-auth per-IP throttle for /mcp: the bearer-token lookup is a real Firestore
// read that runs BEFORE the per-uid throttle above, so an UNauthenticated flood of
// bogus bearer tokens would otherwise drive uncapped Firestore reads (cost/quota)
// and saturate the small shared instance pool. This is intentionally PER-IP-ONLY
// (no global bucket): the cap is set well above the owner's own per-uid allowance
// so the single legitimate owner is never throttled, and omitting the global
// bucket guarantees other IPs' traffic can never 429 the owner. A trivial
// single-source flood is stopped here; a botnet-scale distributed flood is not
// bounded in aggregate by this limiter (accepted — --max-instances caps blast
// radius and it targets a dark, single-owner endpoint).
const MCP_MCP_PREAUTH_MAX_PER_IP = 600;
function mcpMcpPreAuthRateLimited(ip: string): boolean {
  return mcpRateHit(
    "mcppre:" + ip,
    MCP_MCP_PREAUTH_MAX_PER_IP,
    MCP_ROUTE_WINDOW_SEC,
  );
}

// Firestore Timestamp | number | null → epoch ms.
function mcpToMs(v: unknown): number {
  const t = v as { toMillis?: () => number } | null;
  if (t && typeof t.toMillis === "function") return t.toMillis();
  return typeof v === "number" ? v : 0;
}

function mcpJson(
  res: http.ServerResponse,
  status: number,
  obj: unknown,
  extraHeaders?: Record<string, string>,
): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...(extraHeaders || {}),
  });
  res.end(JSON.stringify(obj));
}

function mcpHtml(res: http.ServerResponse, status: number, html: string): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

// Bounded body reader for the MCP routes (they run before the shared readBody).
function mcpReadBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (e) => {
      if (!aborted) reject(e);
    });
  });
}

// Escape a value for safe embedding inside an inline <script> as a JS literal.
function mcpJsonForScript(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function mcpFirestoreDocToMcp(
  id: string,
  data: Record<string, unknown>,
): McpDoc {
  return {
    id,
    title: String(data.title || ""),
    content: String(data.content || ""),
    updatedAt: mcpToMs(data.updatedAt),
    createdAt: mcpToMs(data.createdAt),
    folder: data.folder ? String(data.folder) : null,
    tags: Array.isArray(data.tags) ? (data.tags as unknown[]).map(String) : [],
    docType: data.docType ? String(data.docType) : undefined,
  };
}

// I/O deps for handleMcpMessage, scoped to ONE user's personal docs. Both paths
// enforce the authorization boundary via isPersonalDocData (pure, unit-tested in
// mcp.test.ts): a doc that is not the caller's personal document — another user's,
// a team doc (non-empty teamId), or one shared out (non-empty collaboratorUids) —
// is never returned. Filtered in code because Firestore `where("teamId","==",null)`
// does not match documents that omit the field entirely.
function mcpDepsForUid(uid: string): McpDeps {
  // Memoize the listing for the lifetime of this deps object (== one HTTP
  // request): a JSON-RPC batch with several list/search calls then costs ONE
  // Firestore query instead of one per element (read-amplification guard).
  let listPromise: Promise<McpDoc[]> | null = null;
  return {
    listDocs: () => {
      if (!listPromise) {
        listPromise = (async () => {
          const q = await getFirestore()
            .collection("documents")
            .where("ownerId", "==", uid)
            .limit(MCP_MAX_DOCS)
            .get();
          const docs = q.docs
            .filter((d) => isPersonalDocData(uid, d.data()))
            .map((d) => mcpFirestoreDocToMcp(d.id, d.data()));
          docs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          return docs;
        })();
      }
      return listPromise;
    },
    getDoc: async (id) => {
      const snap = await getFirestore().collection("documents").doc(id).get();
      if (!snap.exists) return null;
      const data = snap.data() as Record<string, unknown>;
      if (!isPersonalDocData(uid, data)) return null; // personal docs only
      return mcpFirestoreDocToMcp(snap.id, data);
    },
  };
}

async function mcpLoadClient(
  clientId: string,
): Promise<{ redirectUris: string[]; clientName: string } | null> {
  if (!clientId) return null;
  const snap = await getFirestore().collection(MCP_CLIENTS).doc(clientId).get();
  if (!snap.exists) return null;
  const data = snap.data() as Record<string, unknown>;
  const redirectUris = Array.isArray(data.redirectUris)
    ? (data.redirectUris as unknown[]).map(String)
    : [];
  const clientName = typeof data.clientName === "string" ? data.clientName : "";
  return { redirectUris, clientName };
}

// Mint + persist an access/refresh token pair (hashes only) for a granted user.
// `family` ties every token descended from a single authorization_code grant
// together so refresh-token reuse can revoke the whole lineage (OAuth 2.1 §6.1).
// Callers pass the raw token strings so the refresh path can pre-generate the
// successor and record its hash on the predecessor ATOMICALLY (race-free reuse
// detection, see mcpHandleRefreshGrant) before persisting the new pair here.
async function mcpIssueTokens(
  uid: string,
  clientId: string,
  scope: string,
  resource: string,
  family: string,
  access: string,
  refresh: string,
): Promise<{ access: string; refresh: string }> {
  const now = mcpNowSec();
  await Promise.all([
    getFirestore()
      .collection(MCP_ACCESS)
      .doc(hashToken(access))
      .set({
        uid,
        clientId,
        scope,
        resource,
        family,
        expiresAt: now + ACCESS_TTL_SEC,
        createdAt: FieldValue.serverTimestamp(),
      }),
    getFirestore()
      .collection(MCP_REFRESH)
      .doc(hashToken(refresh))
      .set({
        uid,
        clientId,
        scope,
        resource,
        family,
        expiresAt: now + REFRESH_TTL_SEC,
        createdAt: FieldValue.serverTimestamp(),
      }),
  ]);
  return { access, refresh };
}

// True iff this token family has been revoked (tombstone present). This — not
// the best-effort delete sweep — is the authoritative "is this lineage dead?"
// check; it is consulted before honoring an access token and before rotating a
// refresh token, so a doc the sweep missed (or one minted racing the sweep) is
// still rejected.
async function mcpFamilyRevoked(family: string): Promise<boolean> {
  if (!family) return false;
  try {
    const snap = await getFirestore()
      .collection(MCP_REVOKED_FAMILIES)
      .doc(family)
      .get();
    return snap.exists;
  } catch (err) {
    // Fail CLOSED: if we cannot confirm the family is live, treat it as revoked
    // rather than honor a possibly-compromised token.
    console.error(
      `[mcp] family-tombstone read failed for ${family.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)} — failing closed`,
    );
    return true;
  }
}

// Revoke an entire token family. Writes the authoritative tombstone FIRST (so any
// surviving/racing descendant is immediately rejected by mcpFamilyRevoked), then
// best-effort sweeps every access+refresh doc, PAGINATING until the family is
// empty (a single limit(500) page could otherwise leave live docs behind for a
// long-lived family). Single-field equality is auto-indexed (no composite index).
async function mcpRevokeFamily(family: string): Promise<void> {
  if (!family) return;
  const db = getFirestore();
  // The tombstone is the AUTHORITATIVE revocation signal and the read side
  // (mcpFamilyRevoked) fails CLOSED, so this write must actually land — a
  // silently-swallowed failure would leave a detected-compromised lineage with
  // no tombstone, and mcpFamilyRevoked would then read "absent" → honor the
  // token. Mirror the read side's fail-closed posture on the write side: retry a
  // bounded number of times, and if it still fails, THROW so the caller does not
  // proceed as though revocation succeeded (the reuse/refresh paths then surface
  // a server error instead of a false invalid_grant; /oauth/revoke wraps this in
  // its own try/catch and still returns 200 per RFC 7009, but logs CRITICAL).
  let tombstoneWritten = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await db
        .collection(MCP_REVOKED_FAMILIES)
        .doc(family)
        .set({ revokedAt: FieldValue.serverTimestamp() });
      tombstoneWritten = true;
      break;
    } catch (err) {
      console.error(
        `[mcp] family tombstone write attempt ${attempt}/4 failed for ${family.slice(0, 8)}…: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!tombstoneWritten) {
    console.error(
      `[mcp] CRITICAL: could not persist family tombstone for ${family.slice(0, 8)}… after retries — revocation NOT durable`,
    );
    throw new Error("mcp_family_tombstone_write_failed");
  }
  for (const coll of [MCP_ACCESS, MCP_REFRESH]) {
    try {
      for (;;) {
        const q = await db
          .collection(coll)
          .where("family", "==", family)
          .limit(500)
          .get();
        if (q.empty) break;
        const batch = db.batch();
        q.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        if (q.size < 500) break;
      }
    } catch (err) {
      console.error(
        `[mcp] family revocation sweep failed for ${coll}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function mcpLoginPageHtml(
  params: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    state: string;
    scope: string;
    resource: string;
    responseType: string;
  },
  clientName: string,
  firebaseConfig: unknown,
): string {
  const payload = {
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: params.codeChallengeMethod,
    state: params.state,
    scope: params.scope,
    resource: params.resource,
    response_type: params.responseType,
  };
  // The redirect host is the un-spoofable trust anchor shown on the consent
  // screen: it is where the authorization code will be delivered, and it has
  // already passed the strict redirect-host allowlist. The client_name is
  // self-asserted at DCR, so it is shown as secondary (labelled "アプリ") only.
  let redirectHost = "";
  try {
    redirectHost = new URL(params.redirectUri).host;
  } catch {
    redirectHost = params.redirectUri;
  }
  const appLabel = clientName.trim() || "(名称未設定のアプリ)";
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MarkFlow へのアクセスを許可</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    background:#faf9f7; color:#1c1b1a; display:flex; min-height:100vh; align-items:center; justify-content:center; }
  @media (prefers-color-scheme: dark){ body{ background:#191817; color:#ececec; } .card{ background:#232221 !important; border-color:#38363400 !important; } .grant{ background:#1c1b1a !important; border-color:#333 !important; } .k{ color:#9a958f !important; } }
  .card { background:#fff; border:1px solid #eceae7; border-radius:16px; padding:36px 32px; max-width:420px; width:calc(100% - 32px);
    box-shadow:0 1px 3px rgba(0,0,0,.06); text-align:center; }
  h1 { font-size:1.15rem; margin:0 0 8px; font-weight:650; }
  p { font-size:.9rem; line-height:1.6; color:#6b6763; margin:0 0 20px; }
  button { font:inherit; font-size:.95rem; font-weight:600; cursor:pointer; border:1px solid #dcdad7;
    background:#fff; color:#1c1b1a; border-radius:10px; padding:11px 18px; display:inline-flex; align-items:center; gap:10px;
    width:100%; justify-content:center; }
  button:hover { background:#f5f4f2; }
  button.primary { background:#1c1b1a; color:#fff; border-color:#1c1b1a; }
  button.primary:hover { background:#333; }
  button.secondary { margin-top:10px; background:transparent; border-color:transparent; color:#6b6763; }
  button.secondary:hover { background:#f5f4f2; }
  button:disabled { opacity:.55; cursor:default; }
  .grant { text-align:left; background:#faf9f7; border:1px solid #eceae7; border-radius:12px; padding:14px 16px; margin:0 0 16px; }
  .row { display:flex; gap:12px; font-size:.85rem; line-height:1.5; padding:4px 0; }
  .k { flex:0 0 64px; color:#8a857f; }
  .v { flex:1; font-weight:600; word-break:break-all; }
  .who { font-size:.82rem; color:#6b6763; margin:0 0 16px; }
  .who b { color:#1c1b1a; font-weight:650; }
  .fine { font-size:.78rem; color:#8a857f; margin:16px 0 0; line-height:1.55; }
  .msg { margin-top:16px; font-size:.85rem; min-height:1.2em; }
  .err { color:#b3261e; }
  .g { width:18px; height:18px; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
  <div class="card">
    <!-- Step 1: sign in -->
    <div id="step-signin">
      <h1>MarkFlow と連携</h1>
      <p>続けるには、MarkFlow にログインしているのと同じ Google アカウントでサインインしてください。</p>
      <button id="signin" class="primary">
        <svg class="g" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.7 30.2.5 24 .5 14.6.5 6.5 5.9 2.6 13.8l7.8 6.1C12.3 13.9 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.5 3-2.2 5.5-4.7 7.2l7.4 5.7c4.3-4 6.8-9.9 6.8-17.4z"/><path fill="#FBBC05" d="M10.4 28.3c-.5-1.5-.8-3.1-.8-4.8s.3-3.3.8-4.8l-7.8-6.1C.9 15.9 0 19.8 0 23.5s.9 7.6 2.6 10.9l7.8-6.1z"/><path fill="#34A853" d="M24 47.5c6.2 0 11.4-2 15.2-5.5l-7.4-5.7c-2 1.4-4.7 2.3-7.8 2.3-6.4 0-11.7-4.3-13.6-10.1l-7.8 6.1C6.5 42.1 14.6 47.5 24 47.5z"/></svg>
        Googleでサインイン
      </button>
    </div>

    <!-- Step 2: consent -->
    <div id="step-consent" hidden>
      <h1>アクセスを許可しますか？</h1>
      <p class="who">アカウント: <b id="who"></b></p>
      <div class="grant">
        <div class="row"><span class="k">接続先</span><span class="v" id="dst">${mcpEscHtml(redirectHost)}</span></div>
        <div class="row"><span class="k">アプリ</span><span class="v">${mcpEscHtml(appLabel)}</span></div>
        <div class="row"><span class="k">権限</span><span class="v">個人ドキュメントの検索・閲覧（読み取り専用）</span></div>
      </div>
      <p class="fine">許可すると、上記の「接続先」があなたの個人ドキュメントを検索・閲覧できるようになります。共有・チームのドキュメントは対象外で、書き込みはできません。心当たりのない接続先の場合は「許可しない」を選んでください。</p>
      <button id="approve" class="primary">許可する</button>
      <button id="deny" class="secondary">許可しない</button>
    </div>

    <div id="msg" class="msg"></div>
  </div>
<script type="module">
  import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
  import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult }
    from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";

  const OAUTH = ${mcpJsonForScript(payload)};
  const firebaseConfig = ${mcpJsonForScript(firebaseConfig)};
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const provider = new GoogleAuthProvider();
  const stepSignin = document.getElementById("step-signin");
  const stepConsent = document.getElementById("step-consent");
  const btn = document.getElementById("signin");
  const approveBtn = document.getElementById("approve");
  const denyBtn = document.getElementById("deny");
  const whoEl = document.getElementById("who");
  const msg = document.getElementById("msg");

  let pendingIdToken = "";

  function setMsg(t, isErr){ msg.textContent = t || ""; msg.className = "msg" + (isErr ? " err" : ""); }

  // After sign-in, show the consent step (do NOT auto-complete): the user must
  // explicitly approve the specific destination before a code is minted.
  function showConsent(user){
    pendingIdToken = null; // set by caller via getIdToken()
    whoEl.textContent = (user && user.email) ? user.email : "(サインイン済み)";
    stepSignin.hidden = true;
    stepConsent.hidden = false;
    setMsg("", false);
  }

  async function complete(){
    if (!pendingIdToken){ setMsg("サインインの有効期限が切れました。やり直してください。", true); return; }
    setMsg("接続を確立しています…", false);
    approveBtn.disabled = true; denyBtn.disabled = true;
    try {
      const r = await fetch(${JSON.stringify(AUTHORIZE_PATH)}, {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ idToken: pendingIdToken, ...OAUTH }),
      });
      const data = await r.json();
      if (data && data.redirect){ window.location.href = data.redirect; return; }
      setMsg((data && data.error_description) || "接続に失敗しました。", true);
      approveBtn.disabled = false; denyBtn.disabled = false;
    } catch (e){
      setMsg("接続に失敗しました: " + (e && e.message ? e.message : e), true);
      approveBtn.disabled = false; denyBtn.disabled = false;
    }
  }

  // Deny: return an OAuth access_denied error to the (already-validated) redirect
  // URI so the client ends the flow cleanly.
  function deny(){
    try {
      const u = new URL(OAUTH.redirect_uri);
      u.searchParams.set("error", "access_denied");
      u.searchParams.set("error_description", "User declined the connection");
      if (OAUTH.state) u.searchParams.set("state", OAUTH.state);
      window.location.href = u.toString();
    } catch {
      setMsg("接続をキャンセルしました。このタブを閉じてください。", false);
    }
  }

  async function afterSignIn(user){
    showConsent(user);
    try { pendingIdToken = await user.getIdToken(); }
    catch (e){ setMsg("サインインに失敗しました: " + (e && e.message ? e.message : e), true); }
  }

  // Handle return from a redirect-based sign-in (popup fallback).
  try {
    const rr = await getRedirectResult(auth);
    if (rr && rr.user){ await afterSignIn(rr.user); }
  } catch (e){ setMsg("サインインに失敗しました: " + (e && e.message ? e.message : e), true); }

  btn.addEventListener("click", async () => {
    setMsg("", false);
    try {
      const res = await signInWithPopup(auth, provider);
      await afterSignIn(res.user);
    } catch (e){
      const code = e && e.code ? e.code : "";
      if (code === "auth/popup-blocked" || code === "auth/cancelled-popup-request" || code === "auth/operation-not-supported-in-this-environment"){
        // fall back to full-page redirect
        try { await signInWithRedirect(auth, provider); }
        catch (e2){ setMsg("サインインに失敗しました: " + (e2 && e2.message ? e2.message : e2), true); }
      } else if (code === "auth/popup-closed-by-user"){
        setMsg("", false);
      } else {
        setMsg("サインインに失敗しました: " + (e && e.message ? e.message : e), true);
      }
    }
  });

  approveBtn.addEventListener("click", complete);
  denyBtn.addEventListener("click", deny);
</script>
</body>
</html>`;
}

function mcpErrorPageHtml(message: string): string {
  const safe = String(message).replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
  );
  return `<!doctype html><meta charset="utf-8"><title>接続エラー</title>
<body style="font-family:-apple-system,sans-serif;padding:3rem;text-align:center;color:#555">
<h1 style="font-size:1.15rem">接続できませんでした</h1>
<p>${safe}</p></body>`;
}

// authorization_code grant: verify PKCE + single-use code, issue tokens.
async function mcpHandleAuthCodeGrant(
  res: http.ServerResponse,
  v: ReturnType<typeof parseTokenRequest>,
): Promise<void> {
  const ref = getFirestore()
    .collection(MCP_CODES)
    .doc(hashToken(v.code || ""));
  // Atomic single-use consume: read + delete in ONE transaction so two
  // concurrent /token calls presenting the same code cannot both read it as
  // valid and mint two token pairs (replay via race). Even a subsequent PKCE
  // failure must not leave a reusable code behind — the delete already landed.
  const data = await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    tx.delete(ref);
    return snap.data() as Record<string, unknown>;
  });
  if (!data) {
    mcpJson(res, 400, {
      error: "invalid_grant",
      error_description: "code not found",
    });
    return;
  }
  if (Number(data.expiresAt || 0) < mcpNowSec()) {
    mcpJson(res, 400, {
      error: "invalid_grant",
      error_description: "code expired",
    });
    return;
  }
  if (v.clientId && String(data.clientId || "") !== v.clientId) {
    mcpJson(res, 400, {
      error: "invalid_grant",
      error_description: "client mismatch",
    });
    return;
  }
  if (v.redirectUri && String(data.redirectUri || "") !== v.redirectUri) {
    mcpJson(res, 400, {
      error: "invalid_grant",
      error_description: "redirect_uri mismatch",
    });
    return;
  }
  if (!verifyPkceS256(v.codeVerifier || "", String(data.codeChallenge || ""))) {
    mcpJson(res, 400, {
      error: "invalid_grant",
      error_description: "PKCE verification failed",
    });
    return;
  }
  const uid = String(data.uid || "");
  if (!(await mcpEligible(uid))) {
    mcpJson(res, 400, {
      error: "invalid_grant",
      error_description: "user not authorized",
    });
    return;
  }
  const scope = String(data.scope || "");
  const resource = String(data.resource || "");
  // Fresh lineage per authorization: every access/refresh token descended from
  // this grant shares one `family`, so refresh-token reuse can revoke them all.
  const family = newOpaqueToken();
  const { access, refresh } = await mcpIssueTokens(
    uid,
    String(data.clientId || ""),
    scope,
    resource,
    family,
    newOpaqueToken(),
    newOpaqueToken(),
  );
  mcpJson(res, 200, buildTokenResponse(access, refresh, scope), {
    "Cache-Control": "no-store",
  });
}

// refresh_token grant: rotate the refresh token, issue a fresh pair.
//
// Reuse detection is lineage-aware, not wall-clock-based. On rotation we SOFT-
// revoke the presented doc and, ATOMICALLY in the same transaction, record a
// pointer to its successor (`supersededBy` = hash of the freshly-minted refresh
// token). A later presentation of an already-revoked token is then classified by
// its successor's state:
//   - successor still live (or not yet persisted) → BENIGN: a concurrent double-
//     submit or a lost-response retry where the chain advanced exactly one step.
//     Reject this request but keep the lineage (never log the owner out).
//   - successor itself already revoked → GENUINE REUSE: the chain forked ≥2
//     generations, proving two concurrent holders (theft). Revoke the family.
// This removes the fragile 10s wall-clock (a lost response is only detected after
// the client's read timeout, which routinely exceeds any short grace) while still
// catching real token theft.
async function mcpHandleRefreshGrant(
  res: http.ServerResponse,
  v: ReturnType<typeof parseTokenRequest>,
): Promise<void> {
  const ref = getFirestore()
    .collection(MCP_REFRESH)
    .doc(hashToken(v.refreshToken || ""));
  // Pre-generate the successor pair so the predecessor can record its successor's
  // hash atomically with the soft-revoke (race-free reuse classification).
  const newAccess = newOpaqueToken();
  const newRefresh = newOpaqueToken();
  const newRefreshHash = hashToken(newRefresh);
  const outcome = await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { kind: "missing" as const };
    const data = snap.data() as Record<string, unknown>;
    if (data.revoked === true) return { kind: "reuse" as const, data };
    tx.update(ref, {
      revoked: true,
      revokedAt: FieldValue.serverTimestamp(),
      supersededBy: newRefreshHash,
    });
    return { kind: "active" as const, data };
  });

  if (outcome.kind === "missing") {
    mcpJson(res, 400, {
      error: "invalid_grant",
      error_description: "refresh_token invalid",
    });
    return;
  }

  if (outcome.kind === "reuse") {
    const fam = String(outcome.data.family || "");
    const succHash = String(outcome.data.supersededBy || "");
    let successorRevoked = false;
    if (succHash) {
      try {
        const succ = await getFirestore()
          .collection(MCP_REFRESH)
          .doc(succHash)
          .get();
        // Successor missing => not yet persisted (mint in flight) or already
        // swept: treat as benign. Successor present & revoked => chain forked.
        successorRevoked = succ.exists && succ.data()?.revoked === true;
      } catch (err) {
        // Can't classify → assume the worst (compromise) and revoke.
        console.error(
          `[mcp] successor lookup failed during reuse check: ${err instanceof Error ? err.message : String(err)} — treating as reuse`,
        );
        successorRevoked = true;
      }
    }
    if (successorRevoked) {
      console.error(
        `[mcp] refresh-token reuse detected (family=${fam.slice(0, 8)}…) — revoking lineage`,
      );
      await mcpRevokeFamily(fam);
      mcpJson(res, 400, {
        error: "invalid_grant",
        error_description: "refresh_token reuse detected",
      });
      return;
    }
    // Benign concurrent/lost-response retry — reject this one, keep the lineage.
    mcpJson(res, 400, {
      error: "invalid_grant",
      error_description: "refresh_token invalid",
    });
    return;
  }

  // Active token — already soft-revoked above (consumed). Validate then rotate.
  const data = outcome.data;
  if (Number(data.expiresAt || 0) < mcpNowSec()) {
    mcpJson(res, 400, {
      error: "invalid_grant",
      error_description: "refresh_token expired",
    });
    return;
  }
  if (v.clientId && String(data.clientId || "") !== v.clientId) {
    mcpJson(res, 400, {
      error: "invalid_grant",
      error_description: "client mismatch",
    });
    return;
  }
  const uid = String(data.uid || "");
  if (!(await mcpEligible(uid))) {
    mcpJson(res, 400, {
      error: "invalid_grant",
      error_description: "user not authorized",
    });
    return;
  }
  // Carry the same family forward so the rotated chain stays revocable as a unit.
  const family = String(data.family || newOpaqueToken());
  // Refuse to rotate a token whose family was revoked (e.g. reuse detected on a
  // sibling): don't resurrect a dead lineage. The RPC-time tombstone check is the
  // authoritative backstop for any pair minted racing the revoke.
  if (await mcpFamilyRevoked(family)) {
    mcpJson(res, 400, {
      error: "invalid_grant",
      error_description: "refresh_token invalid",
    });
    return;
  }
  const scope = String(data.scope || "");
  const resource = String(data.resource || "");
  const { access, refresh } = await mcpIssueTokens(
    uid,
    String(data.clientId || ""),
    scope,
    resource,
    family,
    newAccess,
    newRefresh,
  );
  mcpJson(res, 200, buildTokenResponse(access, refresh, scope), {
    "Cache-Control": "no-store",
  });
}

// POST /mcp — bearer-authenticated JSON-RPC (stateless Streamable HTTP).
async function mcpHandleRpc(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  baseUrl: string,
): Promise<void> {
  if (req.method !== "POST") {
    // Stateless server: no server→client SSE stream, no session teardown.
    mcpJson(
      res,
      405,
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Method not allowed; use POST" },
      },
      { Allow: "POST" },
    );
    return;
  }
  const prmUrl = `${baseUrl}${PRM_PATH}`;
  const challenge = (desc: string) =>
    `Bearer error="invalid_token", error_description="${desc}", resource_metadata="${prmUrl}"`;

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    mcpJson(
      res,
      401,
      { error: "invalid_token" },
      { "WWW-Authenticate": challenge("Missing bearer token") },
    );
    return;
  }
  const token = authHeader.slice(7).trim();
  const snap = await getFirestore()
    .collection(MCP_ACCESS)
    .doc(hashToken(token))
    .get();
  if (!snap.exists) {
    mcpJson(
      res,
      401,
      { error: "invalid_token" },
      { "WWW-Authenticate": challenge("Invalid token") },
    );
    return;
  }
  const tok = snap.data() as Record<string, unknown>;
  if (Number(tok.expiresAt || 0) < mcpNowSec()) {
    await snap.ref.delete().catch(() => {});
    mcpJson(
      res,
      401,
      { error: "invalid_token" },
      { "WWW-Authenticate": challenge("Token expired") },
    );
    return;
  }
  const uid = String(tok.uid || "");
  if (!(await mcpEligible(uid))) {
    mcpJson(res, 403, { error: "forbidden" });
    return;
  }
  // Authoritative revocation backstop: if this token's family was tombstoned
  // (reuse detected on a sibling, or an explicit revoke), reject even if the
  // access-token doc itself survived the sweep or was minted racing the revoke.
  if (await mcpFamilyRevoked(String(tok.family || ""))) {
    mcpJson(
      res,
      401,
      { error: "invalid_token" },
      { "WWW-Authenticate": challenge("Token revoked") },
    );
    return;
  }
  // Per-uid RPC throttle — the tools are Firestore-backed; cap how many calls a
  // single authorized identity can drive per window.
  if (mcpRpcRateLimited(uid)) {
    mcpJson(
      res,
      429,
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Rate limit exceeded" },
      },
      { "Retry-After": String(MCP_RPC_WINDOW_SEC) },
    );
    return;
  }

  const body = await mcpReadBody(req, 4 * 1024 * 1024);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body || "");
  } catch {
    mcpJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  const isBatch = Array.isArray(parsed);
  // Reject an empty batch (JSON-RPC 2.0: invalid) and cap batch size so a client
  // can't fan one POST out into many Firestore-backed tool calls.
  if (isBatch && (parsed as unknown[]).length === 0) {
    mcpJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request: empty batch" },
    });
    return;
  }
  if (isBatch && (parsed as unknown[]).length > MAX_RPC_BATCH) {
    mcpJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: `Invalid Request: batch too large (max ${MAX_RPC_BATCH})`,
      },
    });
    return;
  }

  const deps = mcpDepsForUid(uid);
  const messages = (isBatch ? parsed : [parsed]) as unknown[];
  const responses: JsonRpcResponse[] = [];
  for (const m of messages) {
    if (!isRequest(m)) continue;
    const r = await handleMcpMessage(m as JsonRpcRequest, deps);
    if (r) responses.push(r);
  }

  if (responses.length === 0) {
    // Only notifications/responses were sent → 202 Accepted, no body.
    res.writeHead(202);
    res.end();
    return;
  }
  mcpJson(res, 200, isBatch ? responses : responses[0]);
}

/**
 * Dispatch the MCP + OAuth routes. Returns true if the request was handled (the
 * caller then returns), false if it is not an MCP route. DARK when MCP_UIDS is
 * empty: every MCP route 404s as if absent.
 */
async function handleMcpRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const rawUrl = req.url || "";
  const path = rawUrl.split("?")[0];

  const isPrm =
    path === PRM_PATH || path === "/.well-known/oauth-protected-resource";
  const isAsm = path === ASM_PATH || path.startsWith(ASM_PATH + "/");
  const isMcp = path === MCP_PATH;
  const isRegister = path === REGISTER_PATH;
  const isAuthorize = path === AUTHORIZE_PATH;
  const isToken = path === TOKEN_PATH;
  const isRevoke = path === REVOKE_PATH;

  if (!(
    isPrm ||
    isAsm ||
    isMcp ||
    isRegister ||
    isAuthorize ||
    isToken ||
    isRevoke
  )) {
    return false;
  }

  // Dark-launch: feature off unless an allowlist is configured. Return a body
  // byte-identical to the generic catch-all 404 so the dark feature cannot be
  // fingerprinted by probing these paths.
  if (MCP_UIDS.size === 0) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return true;
  }

  // Fail closed: when MCP is enabled the public origin MUST be pinned. Deriving
  // it from client-supplied Host / X-Forwarded-Host would let a caller steer the
  // OAuth issuer + endpoint metadata (and the /mcp WWW-Authenticate PRM pointer)
  // to an attacker origin. Never trust request headers for security metadata.
  if (!MCP_PUBLIC_ORIGIN) {
    console.error(
      "[mcp] MCP_UIDS is set but MCP_PUBLIC_ORIGIN is unset — refusing to serve MCP with a header-derived origin",
    );
    mcpJson(res, 503, { error: "server_misconfigured" });
    return true;
  }
  const baseUrl = MCP_PUBLIC_ORIGIN;

  // Throttle the Firestore-touching routes before any lookup (cost/quota DoS).
  // Register has its own tighter limiter below; discovery (PRM/ASM) is cheap and
  // header-only, so it is not throttled (Claude fetches it on every connect).
  if (
    (isToken || isAuthorize || isRevoke) &&
    mcpRouteRateLimited(mcpClientIp(req))
  ) {
    mcpJson(
      res,
      429,
      { error: "rate_limited", error_description: "Too many requests" },
      { "Retry-After": String(MCP_ROUTE_WINDOW_SEC) },
    );
    return true;
  }
  // /mcp has its own generous PER-IP pre-auth limiter (above): the bearer lookup
  // is a Firestore read that precedes the per-uid throttle, so cap anonymous
  // floods here without ever charging a shared/global bucket that could 429 the
  // owner. Kept separate from mcpRouteRateLimited so the owner's authenticated
  // RPC (≤300/min per-uid) is never clipped by the tighter OAuth-route cap.
  if (isMcp && mcpMcpPreAuthRateLimited(mcpClientIp(req))) {
    mcpJson(
      res,
      429,
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Rate limit exceeded" },
      },
      { "Retry-After": String(MCP_ROUTE_WINDOW_SEC) },
    );
    return true;
  }

  try {
    // ---- Discovery (public, GET) ----
    if (isPrm) {
      if (req.method !== "GET") {
        mcpJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET" });
        return true;
      }
      mcpJson(res, 200, buildProtectedResourceMetadata(baseUrl));
      return true;
    }
    if (isAsm) {
      if (req.method !== "GET") {
        mcpJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET" });
        return true;
      }
      mcpJson(res, 200, buildAuthServerMetadata(baseUrl));
      return true;
    }

    // ---- Dynamic Client Registration (POST JSON) ----
    if (isRegister) {
      if (req.method !== "POST") {
        mcpJson(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
        return true;
      }
      if (mcpDcrRateLimited(mcpClientIp(req))) {
        mcpJson(
          res,
          429,
          {
            error: "rate_limited",
            error_description: "Too many registration requests",
          },
          { "Retry-After": String(MCP_DCR_WINDOW_SEC) },
        );
        return true;
      }
      const body = await mcpReadBody(req, 64 * 1024);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        mcpJson(res, 400, {
          error: "invalid_client_metadata",
          error_description: "invalid JSON",
        });
        return true;
      }
      const v = validateDcrRequest(parsed, MCP_ALLOWED_REDIRECT_HOSTS);
      if (!v.ok) {
        mcpJson(res, 400, {
          error: v.error,
          error_description: v.error_description,
        });
        return true;
      }
      const clientId = "mcp_" + newOpaqueToken();
      const createdAtSec = mcpNowSec();
      await getFirestore()
        .collection(MCP_CLIENTS)
        .doc(clientId)
        .set({
          clientId,
          redirectUris: v.redirectUris,
          clientName: v.clientName || null,
          tokenEndpointAuthMethod: "none",
          createdAt: FieldValue.serverTimestamp(),
        });
      mcpJson(
        res,
        201,
        buildDcrResponse(
          clientId,
          v.redirectUris || [],
          v.clientName,
          createdAtSec,
        ),
      );
      return true;
    }

    // ---- Authorize (GET login page, POST completes with Firebase id token) ----
    if (isAuthorize) {
      if (!MCP_FIREBASE_WEB_CONFIG) {
        mcpJson(res, 503, { error: "mcp_login_not_configured" });
        return true;
      }
      let firebaseConfig: unknown;
      try {
        firebaseConfig = JSON.parse(MCP_FIREBASE_WEB_CONFIG);
      } catch {
        console.error("[mcp] MCP_FIREBASE_WEB_CONFIG is not valid JSON");
        mcpJson(res, 503, { error: "mcp_login_not_configured" });
        return true;
      }

      if (req.method === "GET") {
        const query = Object.fromEntries(new URL(rawUrl, baseUrl).searchParams);
        const client = await mcpLoadClient(query.client_id || "");
        const v = validateAuthorizeRequest(query, client);
        if (!v.ok) {
          if (
            v.kind === "redirect" &&
            query.redirect_uri &&
            client &&
            matchRedirectUri(query.redirect_uri, client.redirectUris)
          ) {
            res.writeHead(302, {
              Location: buildErrorRedirect(
                query.redirect_uri,
                v.error || "invalid_request",
                v.error_description || "",
                query.state || "",
              ),
            });
            res.end();
            return true;
          }
          mcpHtml(
            res,
            400,
            mcpErrorPageHtml(
              v.error_description || v.error || "invalid request",
            ),
          );
          return true;
        }
        mcpHtml(
          res,
          200,
          mcpLoginPageHtml(v.params!, client?.clientName || "", firebaseConfig),
        );
        return true;
      }

      if (req.method === "POST") {
        const body = await mcpReadBody(req, 64 * 1024);
        let parsed: Record<string, string>;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          mcpJson(res, 400, {
            error: "invalid_request",
            error_description: "invalid JSON",
          });
          return true;
        }
        const idToken = String(parsed.idToken || "");
        const query = {
          response_type: parsed.response_type,
          client_id: parsed.client_id,
          redirect_uri: parsed.redirect_uri,
          code_challenge: parsed.code_challenge,
          code_challenge_method: parsed.code_challenge_method,
          state: parsed.state,
          scope: parsed.scope,
          resource: parsed.resource,
        };
        const client = await mcpLoadClient(query.client_id || "");
        const v = validateAuthorizeRequest(query, client);
        if (!v.ok) {
          mcpJson(res, 400, {
            error: v.error,
            error_description: v.error_description,
          });
          return true;
        }
        let uid: string;
        try {
          // checkRevoked=true: this one-time exchange mints a 30-day refresh
          // token, so a signed-out-everywhere / disabled / password-reset
          // credential must not be parlayed into durable access. The extra
          // Firebase round-trip is negligible for a once-per-connect call.
          uid = (await getAuth().verifyIdToken(idToken, true)).uid;
        } catch {
          mcpJson(res, 401, {
            error: "invalid_token",
            error_description: "Firebase sign-in failed",
          });
          return true;
        }
        if (!(await mcpEligible(uid))) {
          // Complete the flow with an OAuth access_denied redirect (protocol-correct).
          mcpJson(res, 200, {
            redirect: buildErrorRedirect(
              v.params!.redirectUri,
              "access_denied",
              "This Google account is not authorized for MarkFlow MCP.",
              v.params!.state,
            ),
          });
          return true;
        }
        const code = newOpaqueToken();
        await getFirestore()
          .collection(MCP_CODES)
          .doc(hashToken(code))
          .set({
            uid,
            clientId: v.params!.clientId,
            redirectUri: v.params!.redirectUri,
            codeChallenge: v.params!.codeChallenge,
            codeChallengeMethod: "S256",
            scope: v.params!.scope,
            resource: v.params!.resource,
            expiresAt: mcpNowSec() + CODE_TTL_SEC,
            createdAt: FieldValue.serverTimestamp(),
          });
        mcpJson(res, 200, {
          redirect: buildSuccessRedirect(
            v.params!.redirectUri,
            code,
            v.params!.state,
          ),
        });
        return true;
      }

      mcpJson(
        res,
        405,
        { error: "method_not_allowed" },
        { Allow: "GET, POST" },
      );
      return true;
    }

    // ---- Token (POST form) ----
    if (isToken) {
      if (req.method !== "POST") {
        mcpJson(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
        return true;
      }
      const body = await mcpReadBody(req, 64 * 1024);
      const form = Object.fromEntries(new URLSearchParams(body)) as Record<
        string,
        string
      >;
      const v = parseTokenRequest(form);
      if (!v.ok) {
        mcpJson(res, 400, {
          error: v.error,
          error_description: v.error_description,
        });
        return true;
      }
      if (v.grantType === "authorization_code") {
        await mcpHandleAuthCodeGrant(res, v);
      } else {
        await mcpHandleRefreshGrant(res, v);
      }
      return true;
    }

    // ---- Revoke (POST form; RFC 7009 always 200) ----
    if (isRevoke) {
      if (req.method !== "POST") {
        mcpJson(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
        return true;
      }
      const body = await mcpReadBody(req, 16 * 1024);
      const form = Object.fromEntries(new URLSearchParams(body)) as Record<
        string,
        string
      >;
      const token = String(form.token || "");
      if (token) {
        const h = hashToken(token);
        try {
          // Resolve the presented token's family and revoke the WHOLE lineage
          // (RFC 7009 §2.1: revoking a token SHOULD revoke related tokens from
          // the same authorization grant). Writes the durable tombstone, so any
          // sibling access/refresh token is rejected at next use even if the
          // sweep misses its doc.
          const [acc, ref] = await Promise.all([
            getFirestore().collection(MCP_ACCESS).doc(h).get(),
            getFirestore().collection(MCP_REFRESH).doc(h).get(),
          ]);
          const family = String(
            (acc.exists && acc.data()?.family) ||
              (ref.exists && ref.data()?.family) ||
              "",
          );
          if (family) {
            await mcpRevokeFamily(family);
          } else {
            // No family recorded (shouldn't happen for current tokens) — fall
            // back to deleting just the presented doc.
            await Promise.allSettled([
              getFirestore().collection(MCP_ACCESS).doc(h).delete(),
              getFirestore().collection(MCP_REFRESH).doc(h).delete(),
            ]);
          }
        } catch (err) {
          // RFC 7009: respond 200 regardless; never leak token validity/state.
          console.error(
            `[mcp] revoke cascade failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      mcpJson(res, 200, {});
      return true;
    }

    // ---- MCP JSON-RPC ----
    if (isMcp) {
      await mcpHandleRpc(req, res, baseUrl);
      return true;
    }

    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mcp] route error (${path}): ${msg}`);
    if (!res.headersSent) mcpJson(res, 500, { error: "internal_error" });
    return true;
  }
}

const server = http.createServer(async (req, res) => {
  // CORS headers. GET/DELETE + the MCP client headers (Mcp-Session-Id,
  // MCP-Protocol-Version, Last-Event-Id) are allowed so a browser-based MCP
  // client (e.g. the MCP Inspector) can preflight /mcp; WWW-Authenticate is
  // exposed so such a client can read the 401 challenge and start OAuth.
  //
  // Origin "*" is intentional and safe here: we NEVER set
  // Access-Control-Allow-Credentials, so browsers do not send cookies and cannot
  // read credentialed responses cross-origin. All auth is via bearer token /
  // Firebase idToken carried in the request (never a cookie). Reading anything
  // sensitive from /oauth/token or /oauth/authorize already requires possessing
  // the code_verifier / idToken (which a cross-origin page cannot obtain), so the
  // wildcard is not an exfiltration vector. The token-theft path the review
  // flagged is closed by the redirect-host allowlist + consent screen above.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-View-As, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-Id",
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "WWW-Authenticate, Mcp-Session-Id",
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- Remote MCP server + OAuth 2.1 AS (owner-allowlisted; dark unless
  // MCP_UIDS is set). Dispatched BEFORE the POST-only 404 guard because several
  // MCP routes are GET (discovery, the /authorize login page). Self-contained:
  // reads its own request body, so it must run before the shared readBody. ---
  if (await handleMcpRoutes(req, res)) return;

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("MarkFlow AI Proxy");
    return;
  }

  // --- Public: serve a published document (NO auth) ---
  // markflow.jp/p/{docId} → nginx (markflow-site) reverse-proxies here. We read
  // published/{docId}.html from the (private) Storage bucket with the proxy's
  // service account and serve it as HTML. Published docs are public by design.
  if (req.method === "GET" && req.url && req.url.startsWith("/p/")) {
    try {
      const docId = decodeURIComponent(req.url.slice(3).split(/[?#]/)[0]);
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(docId)) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid document id");
        return;
      }
      const objectPath = `published/${docId}.html`;
      const token = await getGcpAccessToken();
      const objUrl = `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o/${encodeURIComponent(
        objectPath,
      )}?alt=media`;
      // Fetch the object and resolve owner-gating in parallel to keep the common
      // (allowed) path fast.
      const objPromise = fetch(objUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      // Web publish is a Pro+ feature (MONETIZATION §1.3). Once billing is live,
      // refuse to RENDER pages whose owner is on Free — the server-side counterpart
      // to the client publish gate (publish writes Storage directly, so this serve
      // handler is the only server enforcement point). Gated ONLY when
      // NONAI_GATES_ENABLED — NOT billingConfigured(): billing is live in TEST mode
      // right now (keys present), so keying on it would gate public pages before the
      // owner's GO. This flag ships OFF and flips at GO alongside client billing.
      // Fails OPEN on any lookup error: a public page's availability outweighs a
      // rare transient revenue leak (the opposite trade-off to the AI guard, which
      // fails closed on quota).
      let ownerGated = false;
      if (NONAI_GATES_ENABLED) {
        try {
          const dsnap = await getFirestore()
            .collection("documents")
            .doc(docId)
            .get();
          const ownerUid = dsnap.exists
            ? String(
                (dsnap.data() as Record<string, unknown>)?.ownerId || "",
              ).trim()
            : "";
          if (ownerUid && !INTERNAL_UIDS.has(ownerUid)) {
            const ent = await loadEntitlement(ownerUid);
            // Fail OPEN: gate ONLY a genuinely-free owner, never one whose plan
            // lookup degraded to "free" on a Firestore error (loadEntitlement
            // swallows the throw and flags degraded), so a blip can't 402 a
            // paying owner's public page.
            ownerGated = ent.realPlan === "free" && !ent.degraded;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[publish] owner gate lookup failed for ${docId}: ${msg}`,
          );
          // fail-open: ownerGated stays false
        }
      }

      const r = await objPromise;
      if (!r.ok) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          '<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font-family:-apple-system,sans-serif;padding:3rem;text-align:center;color:#555"><h1 style="font-size:1.2rem">このドキュメントは公開されていません</h1><p>リンクが失効したか、公開が停止された可能性があります。</p></body>',
        );
        return;
      }
      if (ownerGated) {
        // 402 Payment Required — the page exists but its owner's plan no longer
        // includes Web publish. no-store so a re-upgrade reflects immediately.
        res.writeHead(402, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(
          '<!doctype html><meta charset="utf-8"><title>Unavailable</title><body style="font-family:-apple-system,sans-serif;padding:3rem;text-align:center;color:#555"><h1 style="font-size:1.2rem">この公開ページは現在ご利用いただけません</h1><p>Web公開はProプラン以上の機能です。公開を続けるにはページ所有者のプランのアップグレードが必要です。</p></body>',
        );
        return;
      }
      const html = await r.text();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      });
      res.end(html);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[publish] serve /p error: ${msg}`);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal error");
      return;
    }
  }

  // --- /v1/billing/webhook (Stripe; NO Firebase auth; RAW body) ---
  // Matched BEFORE the shared string readBody: signature verification needs the
  // EXACT bytes Stripe signed. Decoding/reassembling into a string corrupts a
  // multibyte char split across a TCP chunk and breaks HMAC — collect Buffers
  // and Buffer.concat() with no parsing. We process the event BEFORE ACKing and
  // only record the dedupe marker AFTER success, so a failure (or mid-request
  // crash) returns/looks like non-2xx and Stripe retries — there is no reconcile
  // job yet, so correctness over shaving latency.
  if (req.method === "POST" && req.url === "/v1/billing/webhook") {
    if (!billingConfigured()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "billing_not_configured" }));
      return;
    }
    const bufs: Buffer[] = [];
    req.on("data", (c: Buffer) => bufs.push(c));
    req.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "read_error" }));
      }
    });
    req.on("end", async () => {
      const raw = Buffer.concat(bufs);
      const sig = req.headers["stripe-signature"];
      let event: Stripe.Event;
      try {
        event = getStripe().webhooks.constructEvent(
          raw,
          Array.isArray(sig) ? sig[0] : sig || "",
          STRIPE_WEBHOOK_SECRET,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[stripe] signature verification failed: ${msg}`);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "webhook_signature" }));
        return;
      }
      // Skip only if we already FULLY processed this exact event (marker is
      // written post-success). A transient read failure must NOT be resolved as
      // either "new" (risking lost work) or silently "duplicate" (dropping the
      // event): return 500 so Stripe retries — reprocessing is idempotent.
      let alreadyDone: boolean;
      try {
        alreadyDone = await eventAlreadyProcessed(event.id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[stripe] dedupe read ${event.id} failed: ${msg}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "webhook_dedupe_failed" }));
        }
        return;
      }
      if (alreadyDone) {
        console.log(
          `[stripe] duplicate event ${event.id} (${event.type}) skipped`,
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true, duplicate: true }));
        return;
      }
      try {
        await handleStripeEvent(event);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[stripe] handle ${event.id} (${event.type}) failed: ${msg}`,
        );
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "webhook_processing_failed" }));
        }
        return;
      }
      // Mark ONLY after success. A failure to persist the marker is non-fatal:
      // the entitlement is already applied and a redelivery reprocesses
      // idempotently — so we still ACK 200 rather than force a needless retry.
      try {
        await markEventProcessed(event.id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[stripe] mark ${event.id} processed failed: ${msg}`);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ received: true }));
    });
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  // Read request body (shared by all POST routes)
  // 10 MB cap: every endpoint using this reader posts JSON (chat/transcript
  // metadata/feedback) — never raw audio (that goes to Storage; requests carry
  // only a gcsUri). The Stripe webhook uses its own raw-body reader. A cap here
  // stops an unbounded body from pinning memory (OOM / cost DoS vector).
  const MAX_BODY_BYTES = 10 * 1024 * 1024;
  const readBody = (): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;
      req.on("data", (chunk: Buffer) => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          aborted = true;
          reject(new Error("Request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!aborted) resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", (e) => {
        if (!aborted) reject(e);
      });
    });

  // --- /v1/auth/oauth/exchange (BFF: swap authorization code → tokens) ---
  // Unauthenticated on purpose: this precedes Firebase sign-in. The client sends
  // { provider, code, redirectUri }; we redeem the code with the provider using
  // the SERVER-held client_secret and return only the tokens the client feeds to
  // GoogleAuthProvider/GithubAuthProvider.credential(). No secret ever reaches
  // the client bundle. Errors fail loudly (never a silent fallback).
  if (req.url === "/v1/auth/oauth/exchange") {
    try {
      const body = await readBody();
      let parsed: { provider?: string; code?: string; redirectUri?: string };
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const provider = String(parsed.provider || "");
      const code = String(parsed.code || "");
      const redirectUri = String(
        parsed.redirectUri || "http://localhost:19847/callback",
      );
      if (provider !== "google" && provider !== "github") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unsupported_provider" }));
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing_code" }));
        return;
      }
      if (!OAUTH_ALLOWED_REDIRECTS.has(redirectUri)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "redirect_not_allowed" }));
        return;
      }

      if (provider === "google") {
        if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "oauth_not_configured" }));
          return;
        }
        const r = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: GOOGLE_OAUTH_CLIENT_ID,
            client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
        });
        const text = await r.text();
        if (!r.ok) {
          console.error(`[oauth] google exchange failed: ${r.status} ${text}`);
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "exchange_failed" }));
          return;
        }
        const tokens = JSON.parse(text);
        // Only return what the client needs to build the Firebase credential.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id_token: tokens.id_token,
            access_token: tokens.access_token,
          }),
        );
        return;
      }

      // provider === "github"
      if (!GITHUB_OAUTH_CLIENT_ID || !GITHUB_OAUTH_CLIENT_SECRET) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "oauth_not_configured" }));
        return;
      }
      const r = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: GITHUB_OAUTH_CLIENT_ID,
          client_secret: GITHUB_OAUTH_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const text = await r.text();
      if (!r.ok) {
        console.error(`[oauth] github exchange failed: ${r.status} ${text}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "exchange_failed" }));
        return;
      }
      const tokens = JSON.parse(text);
      if (tokens.error) {
        console.error(
          `[oauth] github exchange error: ${tokens.error_description || tokens.error}`,
        );
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "exchange_failed" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: tokens.access_token }));
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[oauth] exchange error: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
      return;
    }
  }

  // --- /v1/publish (owner-only web publish: server writes the Storage object) ---
  // The published HTML object (published/{docId}.html) is now written ONLY here.
  // storage.rules denies all client writes to published/*, so this endpoint is
  // the single enforcement point: it verifies the caller OWNS the document
  // (Firestore ownerId === uid) before writing, caps the payload size, and — when
  // NONAI_GATES_ENABLED — refuses a Free owner (Web publish is Pro+). Previously
  // any authenticated user could overwrite/delete/inflate ANY published page.
  if (req.method === "POST" && req.url === "/v1/publish") {
    try {
      let uid: string;
      try {
        uid = await verifyFirebaseToken(req.headers.authorization);
      } catch {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body = await readBody();
      let parsed: { docId?: string; html?: string };
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const docId = String(parsed.docId || "");
      const html = typeof parsed.html === "string" ? parsed.html : "";
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(docId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_doc_id" }));
        return;
      }
      // Cap payload: a published page is a single rendered document. 10MB is far
      // above any real doc and blocks storage-abuse via this endpoint.
      if (!html || Buffer.byteLength(html, "utf8") > 10 * 1024 * 1024) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "payload_too_large_or_empty" }));
        return;
      }
      // Ownership: only the document's owner may publish it.
      const dsnap = await getFirestore()
        .collection("documents")
        .doc(docId)
        .get();
      if (!dsnap.exists) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "document_not_found" }));
        return;
      }
      const ownerUid = String(
        (dsnap.data() as Record<string, unknown>)?.ownerId || "",
      ).trim();
      if (!ownerUid || ownerUid !== uid) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_document_owner" }));
        return;
      }
      // Pro+ gate (server-side counterpart to the client gate). Ships OFF; flips
      // at GO via NONAI_GATES_ENABLED. Fail OPEN on lookup error so a Firestore
      // blip never blocks a paying owner from (re)publishing.
      if (NONAI_GATES_ENABLED && !INTERNAL_UIDS.has(uid)) {
        try {
          const ent = await loadEntitlement(uid);
          if (ent.realPlan === "free" && !ent.degraded) {
            res.writeHead(402, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "plan_required", plan: "free" }));
            return;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[publish] plan gate lookup failed for ${docId}: ${msg}`,
          );
          // fail-open
        }
      }
      const objectPath = `published/${docId}.html`;
      const token = await getGcpAccessToken();
      const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${GCS_BUCKET}/o?uploadType=media&name=${encodeURIComponent(
        objectPath,
      )}`;
      const up = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "text/html; charset=utf-8",
        },
        body: html,
      });
      if (!up.ok) {
        const t = await up.text().catch(() => "");
        console.error(`[publish] GCS upload failed ${up.status}: ${t}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "storage_write_failed" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[publish] error: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
      return;
    }
  }

  // --- /v1/unpublish (owner-only: delete the published Storage object) ---
  if (req.method === "POST" && req.url === "/v1/unpublish") {
    try {
      let uid: string;
      try {
        uid = await verifyFirebaseToken(req.headers.authorization);
      } catch {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body = await readBody();
      let parsed: { docId?: string };
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const docId = String(parsed.docId || "");
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(docId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_doc_id" }));
        return;
      }
      // Ownership: only the owner may unpublish. A missing doc means nothing to
      // protect — the object (if any) is orphaned, so allow its removal.
      const dsnap = await getFirestore()
        .collection("documents")
        .doc(docId)
        .get();
      if (dsnap.exists) {
        const ownerUid = String(
          (dsnap.data() as Record<string, unknown>)?.ownerId || "",
        ).trim();
        if (ownerUid && ownerUid !== uid) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not_document_owner" }));
          return;
        }
      }
      const objectPath = `published/${docId}.html`;
      const token = await getGcpAccessToken();
      const delUrl = `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o/${encodeURIComponent(
        objectPath,
      )}`;
      const del = await fetch(delUrl, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      // 404 = already gone; treat as success.
      if (!del.ok && del.status !== 404) {
        const t = await del.text().catch(() => "");
        console.error(`[unpublish] GCS delete failed ${del.status}: ${t}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "storage_delete_failed" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[unpublish] error: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
      return;
    }
  }

  // --- /v1/users/resolve (email -> uid, for collaborator/team invites) ------
  // Invites are by email, but the client must NOT be able to enumerate the whole
  // `users` collection (all emails/uids/photos). firestore.rules now restricts
  // `users` read to the owner, so email->uid resolution moves here: an
  // authenticated caller submits ONE email and gets back only {exists, uid}.
  // Uses the Admin SDK getUserByEmail (Firebase Auth is the authoritative email
  // registry), never leaks profile fields, and is rate-limited by Cloud Run.
  // This is the same minimal existence oracle every invite-by-email product
  // exposes (Slack/Notion/Docs) — the win is killing bulk directory enumeration.
  if (req.method === "POST" && req.url === "/v1/users/resolve") {
    try {
      try {
        await verifyFirebaseToken(req.headers.authorization);
      } catch {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body = await readBody();
      let parsed: { email?: string };
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const email = String(parsed.email || "")
        .trim()
        .toLowerCase();
      // Basic shape check — not full RFC validation, just enough to reject junk.
      if (
        !email ||
        email.length > 320 ||
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
      ) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_email" }));
        return;
      }
      try {
        const record = await getAuth().getUserByEmail(email);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ exists: true, uid: record.uid }));
      } catch (err) {
        // getUserByEmail throws auth/user-not-found for unknown emails — that's a
        // normal "no account" answer, not a server error.
        const code = (err as { code?: string })?.code || "";
        if (code === "auth/user-not-found") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ exists: false, uid: null }));
          return;
        }
        throw err;
      }
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[users/resolve] error: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
      return;
    }
  }

  // --- /v1/feedback (in-app bug report / feature request pipeline) ----------
  // Authenticated users submit free-text feedback (bug / idea / other) plus a
  // small NON-PII diagnostic context (app version, platform, os, locale, and the
  // active doc ID only — NEVER the document body). The server, not the client,
  // is authoritative for identity (uid/email from the verified token) and safety
  // (PII/secret redaction of the free text). Each report is stored at
  // feedback/{id}; a rolling aggregate at feedback_groups/{fingerprint} dedupes
  // near-identical reports so a spike is one grouped signal, not N pings. Slack
  // (the shared Agent channel) is notified on a NEW group and at the 5th/25th
  // occurrence. Firestore is the source of truth; Slack is best-effort.
  if (req.method === "POST" && req.url === "/v1/feedback") {
    try {
      let uid: string;
      try {
        uid = await verifyFirebaseToken(req.headers.authorization);
      } catch {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body = await readBody();
      let parsed: {
        kind?: string;
        message?: string;
        context?: Record<string, unknown>;
      };
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }

      const kind: FeedbackKind = normalizeFeedbackKind(parsed.kind);
      const message = sanitizeMessage(parsed.message);
      if (message.length < 3) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "empty_message" }));
        return;
      }

      // Client-supplied diagnostic context — clamped, non-PII only. The active
      // doc ID is kept for reproduction; the doc BODY is never accepted.
      const ctx =
        parsed.context && typeof parsed.context === "object"
          ? parsed.context
          : {};
      const str = (v: unknown, max: number) => String(v ?? "").slice(0, max);
      const appVersion = str(ctx.appVersion, 32);
      const platform = str(ctx.platform, 32);
      const osVersion = str(ctx.osVersion, 64);
      const locale = str(ctx.locale, 32);
      const activeDocId = str(ctx.activeDocId, 64);
      const errorText = sanitizeError(ctx.error);

      // Server-authoritative identity (never trust the client for this).
      let email = "";
      let displayName = "";
      try {
        const u = await getAuth().getUser(uid);
        email = u.email || "";
        displayName = u.displayName || "";
      } catch {
        /* profile lookup best-effort */
      }
      // Plan for triage — best-effort, must not block a report.
      let plan = "unknown";
      try {
        plan = (await resolvePlan(req, uid)).realPlan;
      } catch {
        /* ignore */
      }

      const fingerprint = feedbackFingerprint(kind, appVersion, message);
      const db = getFirestore();
      const now = FieldValue.serverTimestamp();

      const fbRef = db.collection("feedback").doc();
      await fbRef.set({
        uid,
        email,
        displayName,
        plan,
        kind,
        message,
        error: errorText,
        appVersion,
        platform,
        osVersion,
        locale,
        activeDocId,
        fingerprint,
        status: "open",
        createdAt: now,
      });

      // Atomically bump the aggregate so concurrent reports of the same issue
      // produce a correct count (and a single "new group" winner).
      const grpRef = db.collection("feedback_groups").doc(fingerprint);
      let count = 1;
      let isNew = false;
      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(grpRef);
          if (snap.exists) {
            count = Number(snap.data()?.count || 0) + 1;
            tx.set(
              grpRef,
              { count, lastAt: now, kind, sample: message.slice(0, 140) },
              { merge: true },
            );
          } else {
            isNew = true;
            count = 1;
            tx.set(
              grpRef,
              {
                count: 1,
                firstAt: now,
                lastAt: now,
                kind,
                status: "open",
                sample: message.slice(0, 140),
              },
              { merge: true },
            );
          }
        });
      } catch (err) {
        // Aggregation is a nicety; the primary report is already stored. Degrade
        // to a single notification rather than losing the signal entirely.
        console.error(
          `[feedback] group txn failed fp=${fingerprint}: ${err instanceof Error ? err.message : String(err)}`,
        );
        isNew = true;
      }

      if (shouldNotifyFeedback(count, isNew)) {
        // Fire-and-forget; already responded-worthy work is done.
        void notifyFeedbackSlack(
          buildFeedbackSlackPayload({
            kind,
            count,
            isNew,
            message,
            plan,
            appVersion,
            platform,
            email,
            fingerprint,
          }),
        );
      }

      console.log(
        `[feedback] stored uid=${uid} kind=${kind} fp=${fingerprint} count=${count} new=${isNew}`,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, id: fbRef.id, fingerprint }));
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[feedback] error: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
      return;
    }
  }

  // --- /v1/telemetry (product analytics → BigQuery) -------------------------
  // Consenting clients POST a small BATCH of structured events (name + scalar
  // props, never free prose). The server is authoritative for identity (uid/plan
  // from the verified token), receive time, and safety (name/prop sanitization +
  // PII redaction happen in telemetry.ts). Two independent gates protect the
  // user: (1) TELEMETRY_ENABLED — DARK by default; until the BigQuery sink is
  // provisioned + flipped on we ACCEPT-AND-DROP (200, stored:0) so a client's
  // offline queue drains rather than growing unbounded. (2) a server-side
  // consent check against user_settings/{uid}.telemetry_consent — fail-closed,
  // so a client bug or forged request can't record telemetry for a
  // non-consenting user even after go-live. Events stream into BigQuery via
  // insertAll with a per-event insertId for best-effort dedup on retries.
  if (req.method === "POST" && req.url === "/v1/telemetry") {
    try {
      let uid: string;
      try {
        uid = await verifyFirebaseToken(req.headers.authorization);
      } catch {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body = await readBody();
      let parsed: {
        events?: unknown;
        context?: Record<string, unknown>;
      };
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }

      const nowMs = Date.now();
      const events = cleanBatch(parsed.events, uid, nowMs);
      if (events.length === 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, stored: 0 }));
        return;
      }

      // Gate 1: dark until the sink exists. Accept-and-drop so the client purges
      // its queue rather than retrying forever against a table that isn't live.
      if (!TELEMETRY_ENABLED) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, stored: 0, dark: true }));
        return;
      }

      // Gate 2: server-side consent (fail-closed). Accept-and-drop so a client
      // that shouldn't have sent still clears its queue quietly.
      if (!(await telemetryConsent(uid))) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, stored: 0, consent: false }));
        return;
      }

      // Plan for segmentation — best-effort, must not block ingestion.
      let plan = "unknown";
      try {
        plan = (await resolvePlan(req, uid)).realPlan;
      } catch {
        /* ignore */
      }

      // Client-supplied device meta — clamped, non-identifying.
      const ctx =
        parsed.context && typeof parsed.context === "object"
          ? parsed.context
          : {};
      const str = (v: unknown, max: number) => String(v ?? "").slice(0, max);
      const rows = buildInsertRows(events, {
        uid,
        plan,
        appVersion: str(ctx.appVersion, 32),
        platform: str(ctx.platform, 32),
        osVersion: str(ctx.osVersion, 64),
        locale: str(ctx.locale, 32),
        serverTsIso: new Date(nowMs).toISOString(),
      });

      // A BigQuery/auth error THROWS → 500 → the client keeps the batch and
      // retries later (offline queue). Never silently lose accepted-consented data.
      const stored = await bqInsertTelemetry(rows);
      console.log(
        `[telemetry] uid=${uid} plan=${plan} stored=${stored}/${rows.length}`,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, stored }));
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[telemetry] error: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
      return;
    }
  }

  // --- /v1/account/delete (self-service account + all-data deletion) --------
  // Apple App Store Guideline 5.1.1(v): an app that supports account creation
  // MUST let the user delete their account from within the app. This is the
  // single server-side cascade. It requires a FRESH re-authentication (the ID
  // token's auth_time must be within 5 minutes) so a stale/stolen token can't
  // nuke an account, then removes EVERYTHING the user owns via the Admin SDK
  // (which bypasses Firestore + Storage rules): owned documents and their
  // subcollections + published HTML, owned teams (+ Stripe sub cancel), the
  // entitlement / usage / settings / profile / seat-index / billing reverse
  // maps, and all Storage under audio/{uid}/ and images/{uid}/. It also scrubs
  // the uid from docs/teams owned by OTHERS (collaborator + membership entries).
  // The Firebase Auth user is deleted LAST so the account is genuinely gone even
  // if a best-effort sub-step logged a partial failure.
  if (req.method === "POST" && req.url === "/v1/account/delete") {
    try {
      // Verify + require a RECENT re-auth. checkRevoked=true also rejects a token
      // whose session was already revoked (defense-in-depth for this destructive op).
      if (!req.headers.authorization?.startsWith("Bearer ")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let uid: string;
      let authTime: number;
      try {
        const decoded = await getAuth().verifyIdToken(
          req.headers.authorization.slice(7),
          true,
        );
        uid = decoded.uid;
        authTime = Number(decoded.auth_time || 0);
      } catch {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const nowSec = Math.floor(Date.now() / 1000);
      if (!authTime || nowSec - authTime > 300) {
        // The client must reauthenticate (fresh sign-in) immediately before
        // calling. Surface a distinct code so the UI can prompt re-login.
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "reauth_required" }));
        return;
      }

      const db = getFirestore();
      const summary: Record<string, number> = {};

      // 1) Cancel any personal Stripe subscription so a deleted user isn't billed.
      await cancelPersonalStripeSubscription(uid);

      // 2) Owned documents: recursively delete each (versions/research_sessions/
      //    comments go with it) and remove the coupled published HTML object.
      const gcsToken = await getGcpAccessToken().catch(() => "");
      summary.documents = await deleteDocsWhere("documents", "ownerId", uid, {
        recursive: true,
        perDoc: async (docId) => {
          if (!gcsToken) return;
          const objectPath = `published/${docId}.html`;
          const delUrl = `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o/${encodeURIComponent(
            objectPath,
          )}`;
          const del = await fetch(delUrl, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${gcsToken}` },
          });
          if (!del.ok && del.status !== 404) {
            const t = await del.text().catch(() => "");
            console.error(
              `[account/delete] published/${docId} delete ${del.status}: ${t}`,
            );
          }
        },
      });

      // 3) Scrub the uid from documents owned by OTHERS where they collaborate
      //    (array + map entries), so it no longer appears as a collaborator.
      let scrubbedDocs = 0;
      for (let page = 0; page < ACCOUNT_DELETE_MAX_PAGES; page++) {
        const snap = await db
          .collection("documents")
          .where("collaboratorUids", "array-contains", uid)
          .limit(200)
          .get();
        if (snap.empty) break;
        let progressed = false;
        for (const doc of snap.docs) {
          try {
            await doc.ref.update({
              collaboratorUids: FieldValue.arrayRemove(uid),
              [`collaborators.${uid}`]: FieldValue.delete(),
            });
            scrubbedDocs++;
            progressed = true;
          } catch (e) {
            console.error(
              `[account/delete] scrub collaborator ${doc.id} failed:`,
              e,
            );
          }
        }
        if (!progressed || snap.size < 200) break;
      }
      summary.collaboratorScrubbed = scrubbedDocs;

      // 4) Owned teams: cancel their Stripe subscription then recursively delete.
      summary.teamsOwned = await deleteDocsWhere("teams", "ownerId", uid, {
        recursive: true,
        perDoc: async (_teamId, data) => {
          const billing = (data.billing ?? null) as {
            stripeSubscriptionId?: unknown;
          } | null;
          const subId = String(billing?.stripeSubscriptionId ?? "").trim();
          if (subId && billingConfigured()) {
            try {
              await getStripe().subscriptions.cancel(subId);
            } catch (e) {
              console.error(
                `[account/delete] cancel team sub ${subId} failed:`,
                e,
              );
            }
          }
        },
      });

      // 5) Scrub uid from teams owned by OTHERS where they are a member.
      let scrubbedTeams = 0;
      for (let page = 0; page < ACCOUNT_DELETE_MAX_PAGES; page++) {
        const snap = await db
          .collection("teams")
          .where("memberUids", "array-contains", uid)
          .limit(200)
          .get();
        if (snap.empty) break;
        let progressed = false;
        for (const doc of snap.docs) {
          const data = doc.data() as Record<string, unknown>;
          if (String(data.ownerId || "") === uid) continue; // owned → already deleted in step 4
          try {
            await doc.ref.update({
              memberUids: FieldValue.arrayRemove(uid),
              // seatAssignments is an ORDERED ARRAY (the capacity fence), not a
              // map — remove the uid with arrayRemove. The old map-path delete
              // (`seatAssignments.<uid>`) was a no-op on an array, so a deleted
              // account's seat lingered and could push a live member off the end.
              seatAssignments: FieldValue.arrayRemove(uid),
            });
            scrubbedTeams++;
            progressed = true;
          } catch (e) {
            console.error(
              `[account/delete] scrub team member ${doc.id} failed:`,
              e,
            );
          }
        }
        if (!progressed || snap.size < 200) break;
      }
      summary.teamMembershipScrubbed = scrubbedTeams;

      // 6) User-keyed singletons + reverse indexes (server-write-only docs).
      const deleteDoc = async (path: string) => {
        try {
          await db.doc(path).delete();
        } catch (e) {
          console.error(`[account/delete] delete ${path} failed:`, e);
        }
      };
      const recursiveDeleteDoc = async (path: string) => {
        try {
          await db.recursiveDelete(db.doc(path));
        } catch (e) {
          console.error(`[account/delete] recursiveDelete ${path} failed:`, e);
        }
      };
      await recursiveDeleteDoc(`usage/${uid}`); // + months subcollection
      await recursiveDeleteDoc(`user_settings/${uid}`); // + ai_chats subcollection
      await deleteDoc(`entitlements/${uid}`);
      await deleteDoc(`users/${uid}`);
      await deleteDoc(`teamSeats/${uid}`);
      await deleteDoc(`batchLocks/${uid}`);

      // 7) Billing reverse maps + the user's error logs.
      summary.stripeCustomers = await deleteDocsWhere(
        "stripeCustomers",
        "uid",
        uid,
      );
      summary.iapCustomers = await deleteDocsWhere("iapCustomers", "uid", uid);
      summary.errorLogs = await deleteDocsWhere("error_logs", "uid", uid);

      // 8) Storage: all raw audio and uploaded images for this user.
      summary.audioObjects = await deleteStoragePrefix(`audio/${uid}/`);
      summary.imageObjects = await deleteStoragePrefix(`images/${uid}/`);

      // 9) Finally, delete the Firebase Auth user. This is the Apple-critical
      //    step — the account must be gone. If it fails we surface 500 so the
      //    client keeps the user signed in to retry (data above is idempotent).
      try {
        await getAuth().deleteUser(uid);
      } catch (e) {
        console.error(`[account/delete] deleteUser ${uid} failed:`, e);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "auth_delete_failed" }));
        return;
      }

      console.log(
        `[account/delete] uid=${uid} complete: ${JSON.stringify(summary)}`,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, deleted: summary }));
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[account/delete] error: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
      return;
    }
  }

  // --- /v1/me/entitlement (client: effective plan + limits + usage) ---
  // Single source for UI gating. Honors the owner-only X-View-As header so the
  // owner's UI matches what the server will actually enforce this request.
  if (req.url === "/v1/me/entitlement") {
    try {
      const uid = await verifyFirebaseToken(req.headers.authorization);
      const { realPlan, plan, viewAs, meterKey, seats, source, expiresDate } =
        await resolvePlan(req, uid);
      const isOwner = OWNER_UIDS.has(uid);
      const ym = periodKey(new Date());
      let usage: Record<string, number> = {};
      try {
        // Usage is metered under the POOL key (meterKey): the teamId for a Team
        // owner/member (a single shared counter), the uid otherwise. Reading under
        // uid here would show a team member zero usage while their spend actually
        // lands in the shared pool.
        const snap = await getFirestore()
          .collection("usage")
          .doc(meterKey)
          .collection("months")
          .doc(ym)
          .get();
        if (snap.exists) {
          const d = snap.data() || {};
          usage = {
            aiCalls: Number(d.aiCalls || 0),
            sttCalls: Number(d.sttCalls || 0),
            batchMin: Number(d.batchMin || 0),
            images: Number(d.images || 0),
          };
        }
      } catch (e) {
        console.error(`me/entitlement usage read failed for ${uid}:`, e);
      }
      // Effective limits: team's shared pool ceiling is per-plan base × seats, so
      // the UI shows the true team-wide allowance (mirrors checkQuota's scaling).
      let limits: Record<Feature, number> | null =
        plan === "internal" ? null : PLAN_LIMITS[plan];
      if (limits && plan === "team") {
        const s = Math.max(1, Math.floor(seats));
        limits = {
          aiCalls: limits.aiCalls * s,
          sttCalls: limits.sttCalls * s,
          batchMin: limits.batchMin * s,
          images: limits.images * s,
        };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          uid,
          realPlan,
          effectivePlan: plan,
          viewAs: viewAs ?? null,
          isOwner,
          period: ym,
          seats,
          limits,
          usage,
          // Billing rail owning THIS user's own subscription (stripe / app_store /
          // play / founder / null). The client routes "契約を管理" on it: an IAP
          // sub has no Stripe customer, so it must be sent to the store's own
          // management UI instead. Dropping it here (the pre-fix behavior) left the
          // client's source-aware routing dead → IAP users hit the Stripe portal
          // and saw a false "no subscription found".
          source: source ?? null,
          // Subscription period end (epoch ms) for the plan panel's renewal/expiry
          // line; null for free / no dated subscription.
          expiresDate: expiresDate ?? null,
          // Whether this user may connect Claude to their docs via the remote
          // MCP server (owner / named-testers allowlist, internal staff, or a paid
          // Pro/Team plan; dark unless MCP_UIDS set). Drives the in-app "Connect to
          // Claude (MCP)" entry point visibility — mirrors the server-side gate.
          mcpEnabled: await mcpEligible(uid),
        }),
      );
      return;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      sendJsonError(res, isAuthErrorMessage(message) ? 401 : 500, message);
      return;
    }
  }

  // --- /v1/dev/reset-usage (OWNER-ONLY: zero current-month usage) ---
  // Lets the owner re-test hitting free/pro limits while in view-as mode.
  // Only ever touches the owner's OWN usage doc.
  if (req.url === "/v1/dev/reset-usage") {
    try {
      const uid = await verifyFirebaseToken(req.headers.authorization);
      if (!OWNER_UIDS.has(uid)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "owner only" }));
        return;
      }
      const ym = periodKey(new Date());
      await getFirestore()
        .collection("usage")
        .doc(uid)
        .collection("months")
        .doc(ym)
        .delete();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, period: ym }));
      return;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      sendJsonError(res, isAuthErrorMessage(message) ? 401 : 500, message);
      return;
    }
  }

  // --- /v1/billing/checkout (authed: create a subscription Checkout Session) ---
  // The client sends { plan:"pro"|"team", interval:"month"|"year" }; the PRICE is
  // resolved server-side (client never asserts a price). The verified Firebase
  // uid is attached as client_reference_id AND subscription metadata so the
  // webhook can map every lifecycle event back to this user.
  if (req.url === "/v1/billing/checkout") {
    try {
      if (!billingConfigured()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "billing_not_configured" }));
        return;
      }
      const uid = await verifyFirebaseToken(req.headers.authorization);
      const body = await readBody();
      const parsed = body ? JSON.parse(body) : {};
      const priceId = resolveCheckoutPriceId(
        parsed.plan,
        parsed.interval,
        STRIPE_PRICES,
      );
      if (!priceId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_plan" }));
        return;
      }
      // Team checkout: validate seats + team, and authorize the buyer. A team sub
      // is one Stripe subscription whose ITEM QUANTITY is the seat count; the
      // funded team id rides in metadata so the webhook can size + key the shared
      // pool. Pro checkout skips all of this (seats stays 1, no teamId).
      const planNorm = String(parsed.plan ?? "")
        .trim()
        .toLowerCase();
      const isTeamCheckout = planNorm === "team";
      let seatCount = 1;
      let checkoutTeamId = "";
      if (isTeamCheckout) {
        const clamped = clampSeats(parsed.seats, "team", MAX_TEAM_SEATS);
        if (clamped == null) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: "invalid_seats", max: MAX_TEAM_SEATS }),
          );
          return;
        }
        seatCount = clamped;
        checkoutTeamId = String(parsed.teamId ?? "").trim();
        if (!checkoutTeamId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "team_id_required" }));
          return;
        }
        const teamSnap = await getFirestore()
          .collection("teams")
          .doc(checkoutTeamId)
          .get();
        if (!teamSnap.exists) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "team_not_found" }));
          return;
        }
        const teamData = teamSnap.data() as Record<string, unknown>;
        // Owner + admin only (the chosen seat-management permission).
        if (!isTeamManager(teamData, uid)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not_team_manager" }));
          return;
        }
        // Never fund a team that already has live billing — a second admin opening
        // checkout would create a duplicate team subscription (double charge).
        const existingBilling = (teamData.billing ?? null) as {
          status?: unknown;
        } | null;
        const bStatus = String(existingBilling?.status ?? "")
          .trim()
          .toLowerCase();
        if (["active", "grace", "trialing"].includes(bStatus)) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "already_subscribed" }));
          return;
        }
      }
      // Refuse to open a SECOND subscription for someone who already has access.
      // Stripe Checkout does not dedupe per-customer, so a stale client / double
      // tap could otherwise create a duplicate sub and double-charge; and an
      // internal/other-rail entitlement would be paid for but declined by the
      // webhook (internal_untouchable / owned_by_*). derivePlan mirrors the gate
      // exactly (paid = pro|team with active/grace/trialing; internal = access).
      const entSnap = await getFirestore()
        .collection("entitlements")
        .doc(uid)
        .get();
      const curPlan = derivePlan(
        entSnap.exists ? (entSnap.data() as Record<string, unknown>) : null,
      );
      if (curPlan !== "free") {
        // pro/team → manage via portal; internal already has full access.
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "already_subscribed" }));
        return;
      }
      const stripe = getStripe();
      // Reuse the stored customer so lifecycle webhooks map back to this uid;
      // create one (tagged with firebaseUid) on the first purchase.
      let customerId = await getStoredCustomerId(uid);
      // TOCTOU hardening: the derivePlan check above reads the Firestore
      // entitlement doc, which LAGS a live Stripe subscription while its webhook
      // is still in flight. A double-tap / stale client could slip past it and
      // create a SECOND subscription (Stripe Checkout does not dedupe per
      // customer) → duplicate active subs → double charge. When the customer
      // already exists, ask Stripe directly — the authoritative source — whether
      // they hold any non-terminated subscription before opening a new checkout.
      if (customerId) {
        try {
          const subs = await stripe.subscriptions.list({
            customer: customerId,
            status: "all",
            limit: 10,
          });
          // Split by whether the sub currently GRANTS access, mirroring
          // derivePlan (paidOk = active|grace|trialing; past_due maps to grace).
          //  - HAS_ACCESS: the user already has (or retains, during dunning)
          //    paid access → block a 2nd checkout as already_subscribed (this is
          //    the webhook-lag double-charge guard the derivePlan precheck above
          //    can miss).
          //  - NEEDS_PAYMENT: a live-but-non-paying sub (retries exhausted →
          //    unpaid, or paused). derivePlan reports these as free (no access),
          //    so the precheck above lets them through — but opening a SECOND sub
          //    would double-charge once the old one resumes. They must fix payment
          //    on the EXISTING sub, so route them to the portal via a distinct
          //    code instead of the misleading already_subscribed dead-end.
          const HAS_ACCESS = ["active", "trialing", "past_due"];
          const NEEDS_PAYMENT = ["unpaid", "paused"];
          if (subs.data.some((s) => HAS_ACCESS.includes(s.status))) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "already_subscribed" }));
            return;
          }
          if (subs.data.some((s) => NEEDS_PAYMENT.includes(s.status))) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "payment_required" }));
            return;
          }
        } catch (e) {
          // Never block a legitimate purchase on a transient Stripe list error:
          // the Firestore precheck above and the webhook's event.id idempotency
          // still guard against most dupes. Logged, never silent.
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[stripe] subscriptions.list precheck ${uid}: ${msg}`);
        }
      }
      if (!customerId) {
        let email: string | undefined;
        try {
          email = (await getAuth().getUser(uid)).email || undefined;
        } catch {
          /* email is optional for customer creation */
        }
        const customer = await stripe.customers.create({
          email,
          metadata: { firebaseUid: uid },
        });
        customerId = customer.id;
        await mapCustomerToUid(customerId, uid);
        // Persist the customer id WITHOUT touching plan/status (missing plan →
        // derivePlan returns free), so a retried checkout reuses this customer.
        await getFirestore().collection("entitlements").doc(uid).set(
          {
            stripeCustomerId: customerId,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [
          {
            price: priceId,
            quantity: seatCount,
            // Let a team buyer tweak the seat count on the Stripe checkout page;
            // the webhook reads the final item quantity as the source of truth.
            ...(isTeamCheckout
              ? {
                  adjustable_quantity: {
                    enabled: true,
                    minimum: 1,
                    maximum: MAX_TEAM_SEATS,
                  },
                }
              : {}),
          },
        ],
        client_reference_id: uid,
        metadata: {
          firebaseUid: uid,
          ...(isTeamCheckout ? { teamId: checkoutTeamId } : {}),
        },
        subscription_data: {
          metadata: {
            firebaseUid: uid,
            ...(isTeamCheckout ? { teamId: checkoutTeamId } : {}),
          },
        },
        success_url: CHECKOUT_SUCCESS_URL,
        cancel_url: CHECKOUT_CANCEL_URL,
        allow_promotion_codes: true,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url: session.url }));
      return;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      console.error(`[stripe] checkout failed: ${message}`);
      sendJsonError(res, isAuthErrorMessage(message) ? 401 : 500, message);
      return;
    }
  }

  // --- /v1/billing/portal (authed: open the Stripe Customer Portal) ---
  // Manage/cancel/update-card. Returns 404 if the user has no Stripe customer yet.
  if (req.url === "/v1/billing/portal") {
    try {
      if (!billingConfigured()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "billing_not_configured" }));
        return;
      }
      const uid = await verifyFirebaseToken(req.headers.authorization);
      const customerId = await getStoredCustomerId(uid);
      if (!customerId) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no_subscription" }));
        return;
      }
      const session = await getStripe().billingPortal.sessions.create({
        customer: customerId,
        return_url: PORTAL_RETURN_URL,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url: session.url }));
      return;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      console.error(`[stripe] portal failed: ${message}`);
      sendJsonError(res, isAuthErrorMessage(message) ? 401 : 500, message);
      return;
    }
  }

  // --- /v1/billing/team/seats (owner+admin: change the paid seat COUNT) ---
  // Changes the Stripe subscription item quantity (money). The webhook
  // (customer.subscription.updated) is the source of truth that reconciles
  // teams/{teamId}.billing.seats + the owner's entitlement seats — this endpoint
  // only drives Stripe, then the client re-polls me/entitlement.
  if (req.url === "/v1/billing/team/seats") {
    try {
      if (!billingConfigured()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "billing_not_configured" }));
        return;
      }
      const uid = await verifyFirebaseToken(req.headers.authorization);
      const body = await readBody();
      const parsed = body ? JSON.parse(body) : {};
      const teamId = String(parsed.teamId ?? "").trim();
      const seats = clampSeats(parsed.seats, "team", MAX_TEAM_SEATS);
      if (!teamId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "team_id_required" }));
        return;
      }
      if (seats == null) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "invalid_seats", max: MAX_TEAM_SEATS }),
        );
        return;
      }
      const teamSnap = await getFirestore()
        .collection("teams")
        .doc(teamId)
        .get();
      if (!teamSnap.exists) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "team_not_found" }));
        return;
      }
      const teamData = teamSnap.data() as Record<string, unknown>;
      if (!isTeamManager(teamData, uid)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_team_manager" }));
        return;
      }
      const billing = (teamData.billing ?? null) as {
        stripeSubscriptionId?: unknown;
        status?: unknown;
      } | null;
      const subId = String(billing?.stripeSubscriptionId ?? "").trim();
      const bStatus = String(billing?.status ?? "")
        .trim()
        .toLowerCase();
      if (!subId || !["active", "grace", "trialing"].includes(bStatus)) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no_active_subscription" }));
        return;
      }
      const stripe = getStripe();
      // Retrieve the live subscription so we update the AUTHORITATIVE item id
      // (never a possibly-stale stored one). Quantity change prorates by default.
      const sub = await stripe.subscriptions.retrieve(subId);
      const itemId = sub.items?.data?.[0]?.id;
      if (!itemId) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no_active_subscription" }));
        return;
      }
      await stripe.subscriptions.update(subId, {
        items: [{ id: itemId, quantity: seats }],
        proration_behavior: "create_prorations",
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, seats }));
      return;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      console.error(`[stripe] team/seats failed: ${message}`);
      sendJsonError(res, isAuthErrorMessage(message) ? 401 : 500, message);
      return;
    }
  }

  // --- /v1/billing/team/assign (owner+admin: set WHO holds the seats) ---
  // Replaces teams/{teamId}.seatAssignments with an ORDERED uid list (order is the
  // capacity fence: the first `seats` uids get the shared pool — see
  // deriveSeatAccess). Pure Firestore, NO Stripe/money. Also maintains the
  // teamSeats/{uid} reverse index (resolveTeamSeat reads it) and busts the
  // entitlement cache for every affected uid. Requires ONLY seat-holders be actual
  // team members (server-authoritative) — an unknown uid fails loudly (no silent
  // drop). Does NOT require billingConfigured (assignment is free to manage even
  // while Stripe keys are dark), but access still needs active billing at spend time.
  if (req.url === "/v1/billing/team/assign") {
    try {
      const uid = await verifyFirebaseToken(req.headers.authorization);
      const body = await readBody();
      const parsed = body ? JSON.parse(body) : {};
      const teamId = String(parsed.teamId ?? "").trim();
      if (!teamId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "team_id_required" }));
        return;
      }
      const rawList = Array.isArray(parsed.seatAssignments)
        ? parsed.seatAssignments
        : null;
      if (!rawList) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "seat_assignments_required" }));
        return;
      }
      const db = getFirestore();
      const teamRef = db.collection("teams").doc(teamId);
      const teamSnap = await teamRef.get();
      if (!teamSnap.exists) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "team_not_found" }));
        return;
      }
      const teamData = teamSnap.data() as Record<string, unknown>;
      if (!isTeamManager(teamData, uid)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_team_manager" }));
        return;
      }
      // Normalize the requested list: strings only, trimmed, de-duplicated while
      // PRESERVING ORDER (order is the capacity fence). Cap at MAX_TEAM_SEATS so a
      // pathological array can't bloat the doc.
      const memberUids = new Set(
        (Array.isArray(teamData.memberUids)
          ? (teamData.memberUids as unknown[])
          : []
        )
          .map((u) => String(u ?? "").trim())
          .filter(Boolean),
      );
      const seen = new Set<string>();
      const newAssignments: string[] = [];
      const unknownMembers: string[] = [];
      for (const raw of rawList) {
        const u = String(raw ?? "").trim();
        if (!u || seen.has(u)) continue;
        seen.add(u);
        if (!memberUids.has(u)) {
          unknownMembers.push(u);
          continue;
        }
        newAssignments.push(u);
        if (newAssignments.length >= MAX_TEAM_SEATS) break;
      }
      // A seat may only be assigned to an actual team member — fail loudly rather
      // than silently drop, so the caller knows the request was not fully honored.
      if (unknownMembers.length) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "not_team_member", uids: unknownMembers }),
        );
        return;
      }
      const oldAssignments = (
        Array.isArray(teamData.seatAssignments)
          ? (teamData.seatAssignments as unknown[])
          : []
      )
        .map((u) => String(u ?? "").trim())
        .filter(Boolean);
      // Persist the new ordered assignment list (merge preserves billing/members).
      await teamRef.set(
        {
          seatAssignments: newAssignments,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      // Maintain the teamSeats/{uid} reverse index for the delta. Added → point at
      // this team; removed → delete ONLY if it still points here (never clobber a
      // seat the uid holds in a DIFFERENT team).
      const newSet = new Set(newAssignments);
      const oldSet = new Set(oldAssignments);
      const added = newAssignments.filter((u) => !oldSet.has(u));
      const removed = oldAssignments.filter((u) => !newSet.has(u));
      await Promise.all([
        ...added.map((u) =>
          db
            .collection("teamSeats")
            .doc(u)
            .set(
              { teamId, updatedAt: FieldValue.serverTimestamp() },
              { merge: true },
            ),
        ),
        ...removed.map(async (u) => {
          const ref = db.collection("teamSeats").doc(u);
          const snap = await ref.get();
          if (
            snap.exists &&
            String(snap.data()?.teamId || "").trim() === teamId
          )
            await ref.delete();
        }),
      ]);
      // Bust the entitlement cache for every uid whose access may have changed.
      for (const u of new Set([...added, ...removed])) entCache.delete(u);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, seatAssignments: newAssignments }));
      return;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      console.error(`[stripe] team/assign failed: ${message}`);
      sendJsonError(res, isAuthErrorMessage(message) ? 401 : 500, message);
      return;
    }
  }

  // --- /v1/billing/iap/verify (authed: verify a mobile IAP → entitlement) ---
  // The client sends { platform:"ios", jws } (StoreKit2 signed transaction) or
  // { platform:"android", purchaseToken, productId }. We verify the receipt
  // server-side, build the intent via iap.ts, bind the store subId→uid (using the
  // VERIFIED Firebase uid, never a client-asserted token), and apply through the
  // SAME writeEntitlementFromIntent pipeline Stripe uses (cross-rail safe). DARK:
  // 503 until store credentials exist.
  if (req.url === "/v1/billing/iap/verify") {
    try {
      const uid = await verifyFirebaseToken(req.headers.authorization);
      if (!iapConfigured()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "iap_not_configured" }));
        return;
      }
      const body = await readBody();
      let parsed: {
        platform?: string;
        jws?: string;
        purchaseToken?: string;
        productId?: string;
      };
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const platform = String(parsed.platform || "").toLowerCase();

      if (platform === "ios") {
        if (!appleIapConfigured()) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "iap_not_configured" }));
          return;
        }
        const jws = String(parsed.jws || "").trim();
        if (!jws) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "missing_jws" }));
          return;
        }
        const { txn, production } = await appleVerifyTransaction(jws);
        // Reject a Sandbox receipt in production: it verifies (Apple's sandbox
        // chain is valid) but represents a free test purchase, so granting on it
        // would hand real Pro to any sandbox tester. Allowed only for the global
        // testing flag OR an allowlisted tester uid (IAP_SANDBOX_UIDS).
        if (!production && !sandboxAllowedFor(uid)) {
          console.warn(`[iap] verify/ios rejected sandbox receipt uid=${uid}`);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "sandbox_not_allowed" }));
          return;
        }
        const originalTxId = String(txn.originalTransactionId || "").trim();
        if (!originalTxId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_transaction" }));
          return;
        }
        // Authoritative numeric status (+ latest signed txn) from the App Store
        // Server API — the JWS alone does not carry active/expired/revoked.
        const authStatus = await appleAuthoritativeStatus(
          originalTxId,
          production,
        );
        let effectiveTxn = txn;
        if (authStatus?.signedTransactionInfo) {
          try {
            effectiveTxn = (await appleVerifier(
              production,
            ).verifyAndDecodeTransaction(
              authStatus.signedTransactionInfo,
            )) as unknown as Record<string, unknown>;
          } catch {
            /* fall back to the client-supplied (already-verified) txn */
          }
        }
        const facts = appleFactsFromDecoded(effectiveTxn, {
          status: authStatus?.status,
        });
        const result = buildAppleIntent(facts);
        if (!result.ok) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: result.reason }));
          return;
        }
        // Strongest cross-account guard: the store-recorded buyer id (Apple
        // appAccountToken) is the firebase uid stamped at purchase time. When
        // present it is STABLE regardless of any subId churn, so an account that
        // did not buy this sub can never claim it. (Today the iOS client omits
        // appAccountToken — StoreKit requires a UUID — so result.uid is usually
        // empty and this is a no-op; the originalTransactionId guard below is the
        // active iOS check. Kept for defense-in-depth + future-proofing.)
        if (result.uid && result.uid !== uid) {
          console.warn(
            `[iap] verify/ios buyer-id mismatch uid=${uid} buyer=${result.uid} sub=${result.intent.subId}`,
          );
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "owned_by_other_account" }));
          return;
        }
        const iosOwner = await bindIapCustomer(result.intent.subId!, uid, {
          source: "app_store",
          productId: result.intent.productId,
        });
        if (iosOwner === IAP_OWNER_UNVERIFIABLE) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "verify_retry" }));
          return;
        }
        // The Apple subscription is owned by the DEVICE's Apple ID, not the app
        // account. If a different Firebase account than the original buyer signs
        // in on the same device and restores/re-purchases, StoreKit returns the
        // EXISTING transaction — granting on it would hand one paid subscription
        // to multiple accounts (越境課金). originalTransactionId is stable across
        // resubscribe, so this binding scopes ownership. Only the owner may apply.
        if (iosOwner && iosOwner !== uid) {
          console.warn(
            `[iap] verify/ios owned_by_other uid=${uid} owner=${iosOwner} sub=${result.intent.subId}`,
          );
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "owned_by_other_account" }));
          return;
        }
        await applyIapIntent(uid, result, "verify/ios");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            plan: result.intent.plan,
            status: result.intent.status,
          }),
        );
        return;
      }

      if (platform === "android") {
        if (!playIapConfigured()) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "iap_not_configured" }));
          return;
        }
        const token = String(parsed.purchaseToken || "").trim();
        if (!token) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "missing_purchase_token" }));
          return;
        }
        const purchase = await playGetSubscriptionV2(token);
        // Acknowledge within the 3-day window or Google auto-refunds the buyer.
        if (
          String(purchase.acknowledgementState || "") ===
          "ACKNOWLEDGEMENT_STATE_PENDING"
        ) {
          const li = Array.isArray(purchase.lineItems)
            ? (purchase.lineItems as Array<Record<string, unknown>>)[0]
            : undefined;
          const pid = String(li?.productId || parsed.productId || "").trim();
          if (pid) {
            try {
              await playAcknowledge(pid, token);
            } catch (e) {
              console.error("[iap] play acknowledge failed:", e);
            }
          }
        }
        const facts = playFactsFromPurchaseV2(purchase, {
          productId: parsed.productId,
          purchaseToken: token,
          eventTimeMs: Date.now(),
        });
        // Reject a License-tester test purchase in production (parity with the
        // Apple sandbox reject) — it is a free test grant, not a real payment.
        // Allowlisted tester uids (IAP_SANDBOX_UIDS) may proceed for validation.
        if (facts.test && !sandboxAllowedFor(uid)) {
          console.warn(
            `[iap] verify/android rejected test purchase uid=${uid}`,
          );
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "sandbox_not_allowed" }));
          return;
        }
        const result = buildPlayIntent(facts);
        if (!result.ok) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: result.reason }));
          return;
        }
        // PRIMARY Play cross-account guard: the store-recorded buyer id
        // (obfuscatedExternalAccountId) is the firebase uid the client stamped at
        // purchase time (mobile-billing.ts sets obfuscatedAccountId: user.uid).
        // Unlike the purchaseToken subId — which Google ROTATES on
        // upgrade/downgrade/resubscribe/resume, leaving the new token unbound —
        // this id is STABLE across the whole lineage. So a second Firebase
        // account restoring a rotated token (subId guard would miss it, brand-new
        // token → fresh binding → leak) is caught here (越境課金防止).
        if (result.uid && result.uid !== uid) {
          console.warn(
            `[iap] verify/android buyer-id mismatch uid=${uid} buyer=${result.uid} sub=${result.intent.subId}`,
          );
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "owned_by_other_account" }));
          return;
        }
        const playOwner = await bindIapCustomer(result.intent.subId!, uid, {
          source: "play",
          productId: result.intent.productId,
        });
        if (playOwner === IAP_OWNER_UNVERIFIABLE) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "verify_retry" }));
          return;
        }
        // Secondary guard (defense-in-depth): the purchaseToken binding. Scopes
        // ownership when obfuscatedExternalAccountId is absent (older purchases).
        if (playOwner && playOwner !== uid) {
          console.warn(
            `[iap] verify/android owned_by_other uid=${uid} owner=${playOwner} sub=${result.intent.subId}`,
          );
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "owned_by_other_account" }));
          return;
        }
        await applyIapIntent(uid, result, "verify/android");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            plan: result.intent.plan,
            status: result.intent.status,
          }),
        );
        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unsupported_platform" }));
      return;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      console.error(`[iap] verify failed: ${message}`);
      sendJsonError(res, isAuthErrorMessage(message) ? 401 : 500, message);
      return;
    }
  }

  // --- /v1/billing/appstore/notifications (Apple Server Notifications V2) ---
  // NO Firebase auth — Apple posts { signedPayload } (a JWS whose signature is
  // self-contained, so a plain JSON body read is safe). We verify the chain,
  // dedupe on notificationUUID, decode the nested transaction, and apply via the
  // shared pipeline. uid resolves from the iapCustomers binding /iap/verify set.
  // 5xx on failure so Apple retries; 200 once recorded.
  if (req.url === "/v1/billing/appstore/notifications") {
    if (!appleIapConfigured()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "iap_not_configured" }));
      return;
    }
    try {
      const body = await readBody();
      let parsed: { signedPayload?: string };
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const signedPayload = String(parsed.signedPayload || "").trim();
      if (!signedPayload) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing_payload" }));
        return;
      }
      const notification = await appleVerifyNotification(signedPayload);
      const uuid = String(notification.notificationUUID || "").trim();
      if (!uuid) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_notification" }));
        return;
      }
      const eventId = `apple:${uuid}`;
      if (await iapEventAlreadyProcessed(eventId)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true, duplicate: true }));
        return;
      }
      const data = (notification.data || {}) as Record<string, unknown>;
      const signedTx = String(data.signedTransactionInfo || "").trim();
      const notifProduction = isProdEnvironment(data.environment);
      if (signedTx) {
        // Decode + resolve the bound uid FIRST so the sandbox decision is PER-UID
        // (sandboxAllowedFor), mirroring /iap/verify. The SAME allowlisted testers
        // who may sandbox-PURCHASE must also have their sandbox lifecycle
        // (renew / expire / refund) APPLIED — otherwise a sandbox EXPIRED is
        // dropped and the tester is stuck on Pro forever (grant/revoke asymmetry).
        // A real production notification (notifProduction=true) is unaffected: the
        // sandbox gate below is skipped and it applies as before.
        const txn = (await appleVerifier(
          notifProduction,
        ).verifyAndDecodeTransaction(signedTx)) as unknown as Record<
          string,
          unknown
        >;
        const facts = appleFactsFromDecoded(txn, {
          status: data.status,
          eventId: uuid,
        });
        const result = buildAppleIntent(facts);
        const subId = String(txn.originalTransactionId || "").trim();
        const uid = subId ? await lookupIapCustomer(subId) : null;
        if (!notifProduction && !(uid && sandboxAllowedFor(uid))) {
          // Sandbox notification whose bound uid is NOT sandbox-allowed (or a stray
          // sandbox event in a production deployment) — never apply it to a real
          // entitlement. Still ack + dedupe-record below so Apple stops retrying.
          console.log(
            `[iap] apple notif ${uuid} sandbox — ack, not applied (uid=${uid ?? "?"})`,
          );
        } else if (result.ok && uid) {
          await applyIapIntent(uid, result, "notif/apple");
        } else {
          console.warn(
            `[iap] apple notif ${uuid} unmapped subId=${subId} ok=${result.ok}`,
          );
        }
      } else {
        // Non-subscription notification (e.g. CONSUMPTION_REQUEST) — nothing to
        // apply, but still dedupe-record so Apple stops retrying.
        console.log(`[iap] apple notif ${uuid} no transaction — ack`);
      }
      try {
        await markIapEventProcessed(eventId);
      } catch (e) {
        console.error(`[iap] mark ${eventId} failed:`, e);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ received: true }));
      return;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      console.error(`[iap] appstore notification failed: ${message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "notification_failed" }));
      }
      return;
    }
  }

  // --- /v1/billing/play/rtdn (Google Play Real-time Developer Notifications) ---
  // NO Firebase auth — Play pushes a Pub/Sub envelope. RTDN is a change-SIGNAL:
  // we re-fetch the authoritative subscription via the Play API (never trust the
  // push payload's state). Dedupe on the Pub/Sub messageId; ack malformed
  // messages with 200 to stop pointless redelivery; 500 on transient Play-API
  // failure so Pub/Sub retries. uid resolves from the iapCustomers binding.
  if (req.url === "/v1/billing/play/rtdn") {
    if (!playIapConfigured()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "iap_not_configured" }));
      return;
    }
    try {
      const body = await readBody();
      const rtdn = parseRtdnEnvelope(body);
      if (!rtdn) {
        // Permanently-malformed envelope: ack so Pub/Sub drops it, log loudly.
        console.error("[iap] play RTDN malformed envelope — ack");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true, ignored: true }));
        return;
      }
      const eventId = `play:${rtdn.messageId}`;
      if (await iapEventAlreadyProcessed(eventId)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true, duplicate: true }));
        return;
      }
      if (rtdn.test) {
        try {
          await markIapEventProcessed(eventId);
        } catch (e) {
          console.error(`[iap] mark ${eventId} failed:`, e);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true, test: true }));
        return;
      }

      if (rtdn.voided) {
        const token = rtdn.voided.purchaseToken;
        const result = buildPlayVoidIntent(
          token,
          rtdn.messageId,
          rtdn.eventTimeMs,
        );
        const uid = await lookupIapCustomer(token);
        if (result.ok && uid) {
          await applyIapIntent(uid, result, "rtdn/void");
        } else {
          console.warn(
            `[iap] play void ${rtdn.messageId} unmapped token ok=${result.ok}`,
          );
        }
      } else if (rtdn.subscription) {
        const token = rtdn.subscription.purchaseToken;
        const purchase = await playGetSubscriptionV2(token);
        const facts = playFactsFromPurchaseV2(purchase, {
          productId: rtdn.subscription.subscriptionId,
          purchaseToken: token,
          eventId: rtdn.messageId,
          eventTimeMs: rtdn.eventTimeMs,
        });
        const result = buildPlayIntent(facts);
        // Resolve the bound uid FIRST so the test-purchase decision is PER-UID
        // (sandboxAllowedFor), mirroring /iap/verify/android. The SAME allowlisted
        // testers who may test-PURCHASE must also have their test lifecycle
        // (renew / expire / refund) APPLIED — otherwise a test EXPIRED is dropped
        // and the tester is stuck on Pro forever (grant/revoke asymmetry). Prefer
        // the server-established binding; fall back to the obfuscated account id we
        // set at purchase (from the authoritative Play API).
        let uid = await lookupIapCustomer(token);
        if (!uid && result.ok) uid = String(result.uid || "") || null;
        if (facts.test && !(uid && sandboxAllowedFor(uid))) {
          // Test-purchase RTDN whose bound uid is NOT sandbox-allowed (or a stray
          // test event) — ack + dedupe-record, never apply to a real entitlement.
          console.log(
            `[iap] play sub ${rtdn.messageId} test — ack, not applied (uid=${uid ?? "?"})`,
          );
        } else if (result.ok && uid) {
          await bindIapCustomer(result.intent.subId!, uid, {
            source: "play",
          });
          await applyIapIntent(uid, result, "rtdn/sub");
        } else {
          console.warn(
            `[iap] play sub ${rtdn.messageId} unmapped token ok=${result.ok}`,
          );
        }
      } else {
        console.log(`[iap] play RTDN ${rtdn.messageId} no actionable body`);
      }
      try {
        await markIapEventProcessed(eventId);
      } catch (e) {
        console.error(`[iap] mark ${eventId} failed:`, e);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ received: true }));
      return;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      console.error(`[iap] play RTDN failed: ${message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "rtdn_failed" }));
      }
      return;
    }
  }

  // --- /v1/voice/transcribe ---
  if (req.url === "/v1/voice/transcribe") {
    let g: GuardResult | null = null;
    let committed = false;
    try {
      const uid = await verifyFirebaseToken(req.headers.authorization, {
        checkRevoked: true,
      });
      const body = await readBody();
      const parsed = JSON.parse(body);
      const audio: string = parsed.audio; // base64-encoded audio
      const language: string = parsed.language || "ja-JP";

      if (!audio) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "audio is required" }));
        return;
      }

      g = await guard(req, res, uid, "sttCalls", 1);
      if (!g.ok) return;

      const accessToken = await getGcpAccessToken();
      const sttUrl = `https://${STT_LOCATION}-speech.googleapis.com/v2/projects/${GCP_PROJECT_ID}/locations/${STT_LOCATION}/recognizers/_:recognize`;

      // Support explicit encoding (LINEAR16 from Rust) or auto-detect (webm/opus from browser)
      const encoding: string | undefined = parsed.encoding;
      const sampleRate: number | undefined = parsed.sampleRate;
      const channels: number | undefined = parsed.channels;

      const hints: string[] | undefined = parsed.hints;
      const hasHints = hints && hints.length > 0;

      // chirp_3: diarization + adaptation は併用不可（404エラー）
      // hints有り → adaptation優先（ドキュメント固有語彙で精度向上）
      // hints無し → diarization有効（話者境界検出）
      const enableDiarization = parsed.diarization !== false && !hasHints;

      const sttConfig: Record<string, unknown> = {
        model: STT_MODEL,
        languageCodes: [language],
        features: {
          enableAutomaticPunctuation: true,
          ...(enableDiarization && {
            diarizationConfig: {
              minSpeakerCount: parsed.minSpeakers || 1,
              maxSpeakerCount: parsed.maxSpeakers || 6,
            },
          }),
        },
        denoiserConfig: {
          denoiseAudio: true,
        },
      };

      if (hasHints) {
        sttConfig.adaptation = {
          phraseSets: [
            {
              inlinePhraseSet: {
                phrases: hints
                  .slice(0, 100)
                  .map((h: string) => ({ value: h, boost: 3 })),
              },
            },
          ],
        };
      }

      if (encoding) {
        sttConfig.explicitDecodingConfig = {
          encoding,
          sampleRateHertz: sampleRate || 48000,
          audioChannelCount: channels || 1,
        };
      } else {
        sttConfig.autoDecodingConfig = {};
      }

      const sttRes = await fetch(sttUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          config: sttConfig,
          content: audio,
        }),
      });

      if (!sttRes.ok) {
        const errText = await sttRes.text();
        const audioBytes = Math.round((audio.length * 3) / 4);
        console.error(
          `[voice] STT error: ${sttRes.status} | encoding=${encoding} rate=${sampleRate} audioBytes=${audioBytes} | ${errText}`,
        );
        res.writeHead(sttRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errText }));
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sttData = (await sttRes.json()) as any;
      const transcript =
        sttData.results
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ?.map((r: any) => r.alternatives?.[0]?.transcript || "")
          .join("") || "";

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const words: Array<{ word: string; speakerLabel: string }> = (
        sttData.results || []
      ).flatMap(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (r: any) => r.alternatives?.[0]?.words || [],
      );

      let taggedText = transcript;
      const speakerLabels = new Set(
        words.map((w) => w.speakerLabel).filter(Boolean),
      );
      if (speakerLabels.size > 1) {
        let currentSpeaker = "";
        const parts: string[] = [];
        for (const w of words) {
          const label = w.speakerLabel || "";
          if (label && label !== currentSpeaker) {
            currentSpeaker = label;
            parts.push(`\n[Speaker ${label}] `);
          }
          parts.push(w.word);
        }
        taggedText = parts.join("").trim();
      }

      committed = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          text: transcript,
          taggedText: speakerLabels.size > 1 ? taggedText : undefined,
          speakerCount: speakerLabels.size,
        }),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      sendJsonError(res, isAuthErrorMessage(message) ? 401 : 500, message);
    } finally {
      // Refund the reserved sttCall if the upstream STT failed / threw.
      await refundIfUncommitted(g, committed);
    }
    return;
  }

  // --- /v1/voice/batch-transcribe ---
  if (req.url === "/v1/voice/batch-transcribe") {
    let g: GuardResult | null = null;
    let committed = false;
    let reserveMin = 0;
    let leaseUid = "";
    let leaseHeld = false;
    let leaseToken = 0; // the heldAt generation we acquired (for a fenced release)
    try {
      const uid = await verifyFirebaseToken(req.headers.authorization, {
        checkRevoked: true,
      });
      const body = await readBody();
      const parsed = JSON.parse(body);
      const language: string = parsed.language || "ja-JP";
      const OVERLAP_SECS = 20; // must match the client-side split overlap

      // Accept either `chunks` (ordered ≤55min parts of a long recording, each
      // with 20s overlap) or a single `gcsUri` (short recording / back-compat).
      type BatchChunk = {
        gcsUri: string;
        startSec: number;
        durationSec: number;
      };
      let chunks: BatchChunk[] = [];
      if (Array.isArray(parsed.chunks) && parsed.chunks.length > 0) {
        chunks = parsed.chunks.map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c: any) => ({
            gcsUri: String(c.gcsUri || ""),
            startSec: Number(c.startSec) || 0,
            durationSec: Number(c.durationSec) || 0,
          }),
        );
      } else if (parsed.gcsUri) {
        chunks = [
          { gcsUri: String(parsed.gcsUri), startSec: 0, durationSec: 0 },
        ];
      }

      if (chunks.length === 0 || chunks.some((c) => !c.gcsUri)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "gcsUri or chunks is required" }));
        return;
      }

      const expectedPrefix = `gs://markflow-app-2026.firebasestorage.app/audio/${uid}/`;
      if (chunks.some((c) => !c.gcsUri.startsWith(expectedPrefix))) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Access denied: invalid audio path" }));
        return;
      }

      // Cap the chunk fan-out. Each chunk launches its own paid BatchRecognize
      // job in parallel (Promise.all below), so an oversized `chunks` array is a
      // cost bomb independent of the quota reserve. The client never produces
      // more than ~a few dozen chunks (≤55min each); anything larger is abuse.
      if (chunks.length > MAX_BATCH_CHUNKS) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "too_many_chunks",
            message:
              "録音が長すぎます。もう少し短い録音に分けてお試しください。",
          }),
        );
        return;
      }

      // Pre-flight reserve from the client-supplied (untrusted) durations —
      // negatives clamped, floored at 1. The authoritative charge is reconciled
      // below from the server-measured transcript length, so the client cannot
      // obtain free minutes by under-reporting duration.
      reserveMin = clampBatchReserveMinutes(chunks);
      g = await guard(req, res, uid, "batchMin", reserveMin);
      if (!g.ok) return;

      // Per-uid in-flight lease: cap concurrent batch jobs at 1 so a fan-out of
      // concurrent requests (each passing the floored-at-1 reserve) cannot launch
      // dozens of paid multi-minute BatchRecognize jobs in parallel. Acquired
      // AFTER the (cheap) reserve and BEFORE the (expensive) job launch. On a
      // lock-infra error we fail OPEN (proceed without a lease) so a Firestore
      // blip never breaks a single legitimate transcription; on genuine
      // contention we return 429 and refund the reserve via `finally`.
      leaseUid = uid;
      leaseToken = Date.now();
      let leaseContended = false;
      try {
        leaseHeld = await acquireBatchLease(
          meteringStore,
          serverValues,
          uid,
          leaseToken,
          BATCH_LEASE_STALE_MS,
        );
        leaseContended = !leaseHeld;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[batch] lease acquire failed for ${uid}: ${msg}`);
      }
      if (leaseContended) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "batch_in_progress",
            message: "別の文字起こしが処理中です。完了後に再度お試しください。",
          }),
        );
        return;
      }

      const multi = chunks.length > 1;

      const batchUrl = `https://${STT_LOCATION}-speech.googleapis.com/v2/projects/${GCP_PROJECT_ID}/locations/${STT_LOCATION}/recognizers/_:batchRecognize`;

      // Per-chunk "op launched" flags. A chunk's paid BatchRecognize op is billed
      // by Google the moment it is created (startRes.ok), so on a partial failure
      // we charge for the ops that STARTED and refund only the rest (see the
      // failure branch below and failedBatchChargeDelta).
      const startedChunks: boolean[] = new Array(chunks.length).fill(false);

      // Transcribe one file: start the op, poll to completion, surface per-file
      // errors, and return its SpeechRecognitionResult[] (word-level speaker
      // labels + timestamps). Throws on any failure.
      const transcribeFile = async (
        uri: string,
        idx: number,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ): Promise<any[]> => {
        const startToken = await getGcpAccessToken();
        const startRes = await fetch(batchUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${startToken}`,
          },
          body: JSON.stringify({
            config: {
              model: STT_MODEL,
              languageCodes: [language],
              features: {
                enableAutomaticPunctuation: true,
                // REQUIRED for multi-chunk (>58min) recordings: the overlap dedup
                // below filters words by parseOffset(w.startOffset). Per the STT v2
                // spec, word startOffset/endOffset are ONLY populated when this flag
                // is set — without it every word offset is absent (→ 0), so for
                // chunk i>0 the leadCut filter (t >= 10) drops EVERY word and the
                // entire chunk is silently lost (observed: a 102-min 2-chunk run
                // transcribed only its first ~55min). measuredBatchMinutes also
                // reads endOffset, so this fixes the batch billing under-count too.
                enableWordTimeOffsets: true,
                diarizationConfig: { minSpeakerCount: 1, maxSpeakerCount: 6 },
              },
              denoiserConfig: { denoiseAudio: true },
              autoDecodingConfig: {},
            },
            files: [{ uri }],
            recognitionOutputConfig: { inlineResponseConfig: {} },
          }),
        });
        if (!startRes.ok) {
          const t = await startRes.text();
          throw new Error(
            `BatchRecognize start failed (${startRes.status}): ${t}`,
          );
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const op = (await startRes.json()) as any;
        const opName: string = op.name;
        // The op now exists on Google's side and is billed regardless of whether
        // it later succeeds, errors, or times out — flag it so a partial failure
        // charges for it instead of refunding it.
        startedChunks[idx] = true;
        const shortName = uri.split("/").pop();
        console.log(`[batch] Operation started: ${opName} (${shortName})`);

        // Parallel across chunks → total ≈ slowest chunk; keep each poll under
        // the Cloud Run 900s request timeout.
        const maxPollMs = 12 * 60 * 1000;
        const pollInterval = 5000;
        const t0 = Date.now();
        let fails = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let result: any = null;
        while (Date.now() - t0 < maxPollMs) {
          await new Promise((r) => setTimeout(r, pollInterval));
          const tok = await getGcpAccessToken();
          const pollRes = await fetch(
            `https://${STT_LOCATION}-speech.googleapis.com/v2/${opName}`,
            { headers: { Authorization: `Bearer ${tok}` } },
          );
          if (!pollRes.ok) {
            fails++;
            const t = await pollRes.text();
            console.error(
              `[batch] Poll error (${fails}/5) ${shortName}: ${pollRes.status} | ${t}`,
            );
            if (fails >= 5)
              throw new Error(`Poll circuit breaker for ${shortName}`);
            continue;
          }
          fails = 0;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const status = (await pollRes.json()) as any;
          if (status.done) {
            result = status;
            break;
          }
        }
        if (!result) throw new Error(`BatchRecognize timed out (${shortName})`);
        if (result.error)
          throw new Error(`STT op error: ${JSON.stringify(result.error)}`);
        const fileResults = result.response?.results || {};
        const fileKey = Object.keys(fileResults)[0];
        if (!fileKey) {
          console.error(
            `[batch] No file results for ${shortName}: ${JSON.stringify(
              result.response || {},
            ).slice(0, 1500)}`,
          );
          throw new Error("BatchRecognize returned no file results");
        }
        const fileError = fileResults[fileKey]?.error;
        if (fileError) {
          console.error(
            `[batch] Per-file STT error ${shortName}: ${JSON.stringify(fileError)}`,
          );
          throw new Error(
            `STT failed: ${fileError.message || JSON.stringify(fileError)}`,
          );
        }
        return fileResults[fileKey]?.inlineResult?.transcript?.results || [];
      };

      // Run all chunks in parallel (total ≈ slowest chunk). allSettled (not all)
      // so one chunk's failure doesn't erase the fact that the OTHER chunks' paid
      // ops already launched — the failure branch below charges for every started
      // op instead of refunding the whole batch.
      const settled = await Promise.allSettled(
        chunks.map((c, i) => transcribeFile(c.gcsUri, i)),
      );
      const firstReject = settled.find((s) => s.status === "rejected") as
        PromiseRejectedResult | undefined;
      if (firstReject) {
        const msg =
          firstReject.reason instanceof Error
            ? firstReject.reason.message
            : String(firstReject.reason);
        console.error(`[batch] Transcription failed: ${msg}`);
        // A batch that launched real BatchRecognize ops then failed must NOT
        // refund the whole reserve — that would let a client loop "N valid + 1
        // poisoned" chunks to run paid STT for free. Charge the ops that STARTED
        // (Google billed them) and refund only the never-launched remainder. The
        // delta is always ≤ 0 (see failedBatchChargeDelta), so this never
        // over-charges; startedCount = 0 (a pre-flight start failure) is still a
        // full refund. Setting committed=true stops `finally` refunding on top.
        const startedCount = startedChunks.filter(Boolean).length;
        if (g.ok && g.charged) {
          await adjustUsage(
            g.meterKey,
            "batchMin",
            failedBatchChargeDelta(startedCount, reserveMin),
            g.plan,
            g.ym,
          );
        }
        committed = true;
        console.log(
          `[batch] Partial failure: ${startedCount}/${chunks.length} op(s) started; charged ${Math.min(
            startedCount,
            reserveMin,
          )}min of reserved ${reserveMin}min`,
        );
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
        return;
      }
      // All chunks fulfilled — collect their results in order.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chunkResults: any[][] = settled.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s) => (s as PromiseFulfilledResult<any[]>).value,
      );

      // Dedup the 20s overlap by word timestamp — split the overlap at its
      // midpoint so each boundary word is emitted exactly once — then build a
      // speaker-tagged transcript per chunk joined by "---" boundaries (labels
      // are only consistent within a segment; Claude unifies across "---").
      // The merge (incl. the enableWordTimeOffsets-absent fallback that prevents
      // whole-chunk loss) lives in mergeBatchChunks() so it is unit-tested in
      // gating.test.ts independently of this handler.
      const { taggedSegments, plainSegments, speakerLabels } = mergeBatchChunks(
        chunkResults,
        chunks,
        multi,
        OVERLAP_SECS,
      );
      const allSpeakerLabels = new Set(speakerLabels);

      // Partial-loss alarm: every chunk that returned any words should yield a
      // non-empty segment. If a chunk produced text but was dropped by the
      // overlap filter (e.g. absent offsets slipping past the guard above), it
      // silently vanishes from the "---"-joined transcript with no gap marker,
      // and the client only rejects a FULLY empty transcript — so Refine would
      // replace the document with a plausible-looking but truncated result.
      // Surface it loudly (no silent fallback). With enableWordTimeOffsets set
      // this should never fire; it exists to catch regressions in the field.
      const chunksWithText = chunkResults.filter((results) =>
        results.some((r) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const alt = (r as any).alternatives?.[0];
          return (
            (alt?.transcript && alt.transcript.trim()) ||
            (Array.isArray(alt?.words) && alt.words.length > 0)
          );
        }),
      ).length;
      if (plainSegments.length < chunksWithText) {
        console.error(
          `[batch] PARTIAL LOSS: ${chunksWithText - plainSegments.length}/${chunkResults.length} chunk(s) had audio/words but produced an empty merged segment — transcript is truncated. Check enableWordTimeOffsets / overlap dedup.`,
        );
      }

      const transcript = plainSegments.join("\n");
      const taggedTranscript = taggedSegments.join("\n---\n");
      const speakerCount = allSpeakerLabels.size;

      // Reconcile the reserve to the server-measured billable minutes (derived
      // from the actual STT word/result offsets, not the client's claim). This
      // is the authoritative charge — a client that under-reported duration now
      // has its counter corrected upward so the next request is blocked.
      const measuredMin = measuredBatchMinutes(
        chunkResults,
        OVERLAP_SECS,
        chunks.map((c) => c.durationSec),
      );
      if (g.ok && g.charged) {
        await adjustUsage(
          g.meterKey,
          "batchMin",
          reconcileBatchDelta(measuredMin, reserveMin),
          g.plan,
          g.ym,
        );
      }

      console.log(
        `[batch] Done: ${chunks.length} chunk(s), ${transcript.length} chars, ${speakerCount} speakers, reserved=${reserveMin}min measured=${measuredMin}min`,
      );

      committed = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          transcript,
          taggedTranscript: taggedTranscript || transcript,
          speakerCount,
        }),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      console.error(`[batch] Error: ${message}`);
      sendJsonError(res, isAuthErrorMessage(message) ? 401 : 500, message);
    } finally {
      // Release the in-flight lease so the user's next batch can proceed. If the
      // Cloud Run request timeout (900s) kills the process before this runs, the
      // lease is reclaimed as stale after BATCH_LEASE_STALE_MS (20min > 900s).
      if (leaseHeld) {
        await releaseBatchLease(meteringStore, leaseUid, leaseToken).catch(
          (e) =>
            console.error(`[batch] lease release failed for ${leaseUid}:`, e),
        );
      }
      // Refund the reserve only on paths that left committed=false: an early
      // 429/return (no op launched) or an exception caught above (rare, e.g. a
      // post-transcription processing bug). The partial-failure branch is NOT one
      // of these — it already reconciled the charge to the ops that STARTED and
      // set committed=true, so it is not refunded on top. Charging started ops
      // there closes the old free-STT loop (which full-refunded every partial
      // failure), while the per-uid lease keeps a retry loop serial.
      await refundIfUncommitted(g, committed);
    }
    return;
  }

  // --- /v1/image/generate ---
  if (req.url === "/v1/image/generate") {
    let g: GuardResult | null = null;
    let committed = false;
    try {
      const uid = await verifyFirebaseToken(req.headers.authorization, {
        checkRevoked: true,
      });
      const body = await readBody();
      const parsed = JSON.parse(body);
      const prompt: string = parsed.prompt;
      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "prompt is required" }));
        return;
      }

      g = await guard(req, res, uid, "images", 1);
      if (!g.ok) return;

      const accessToken = await getGcpAccessToken();
      const geminiRes = await fetch(getNanoBananaUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
          },
        }),
      });

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        res.writeHead(geminiRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errText }));
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const geminiData = (await geminiRes.json()) as any;
      const candidate = geminiData.candidates?.[0];
      const parts = candidate?.content?.parts;

      // gemini-3-pro-image can return HTTP 200 with NO image when it declines
      // the prompt (finishReason IMAGE_RECITATION / PROHIBITED_CONTENT / SAFETY).
      // Surface the model's own finishMessage so the user knows to rephrase —
      // never mask this as a generic 500 (サイレントフォールバック禁止).
      const findImage = (
        ps: unknown,
      ): { mimeType: string; data: string } | undefined =>
        Array.isArray(ps)
          ? ps.find(
              (p: { inlineData?: { mimeType: string; data: string } }) =>
                p.inlineData,
            )?.inlineData
          : undefined;
      const inlineData = findImage(parts);
      if (!inlineData) {
        const finishReason: string | undefined = candidate?.finishReason;
        const finishMessage: string | undefined = candidate?.finishMessage;
        const declined =
          finishReason === "IMAGE_RECITATION" ||
          finishReason === "PROHIBITED_CONTENT" ||
          finishReason === "SAFETY" ||
          finishReason === "RECITATION" ||
          finishReason === "BLOCKLIST" ||
          finishReason === "SPII";
        const message =
          finishMessage ||
          (declined
            ? "The model declined to generate an image for this prompt. Try rephrasing with more descriptive, original wording."
            : "No image was returned by the model.");
        // 422 = we reached the model but it produced no usable image (prompt
        // issue), distinct from 5xx infra failures.
        res.writeHead(declined ? 422 : 500, {
          "Content-Type": "application/json",
        });
        res.end(
          JSON.stringify({
            error: message,
            finishReason: finishReason || null,
          }),
        );
        return;
      }
      const imagePart = { inlineData };

      committed = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: imagePart.inlineData.data,
          media_type: imagePart.inlineData.mimeType || "image/png",
        }),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      sendJsonError(res, isAuthErrorMessage(message) ? 401 : 500, message);
    } finally {
      // Refund the reserved image credit if generation failed / threw.
      await refundIfUncommitted(g, committed);
    }
    return;
  }

  // --- /v1/research/analyze (Research Director — Claude Opus) ---
  if (req.url === "/v1/research/analyze") {
    let g: GuardResult | null = null;
    let committed = false;
    try {
      const uid = await verifyFirebaseToken(req.headers.authorization, {
        checkRevoked: true,
      });
      const body = await readBody();
      const parsed = JSON.parse(body);
      const transcriptDiff: string = parsed.transcriptDiff || "";
      const fullContext: string = parsed.fullContext || "";
      const documentContext: string = parsed.documentContext || "";
      const searchedTopics: string[] = parsed.searchedTopics || [];
      const auto: boolean = parsed.auto === true;

      if (!transcriptDiff) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "transcriptDiff is required" }));
        return;
      }

      // Capability gate (MONETIZATION.md §1.3): Free may run research MANUALLY
      // only — automatic (interval) live research is Pro+. Enforced server-side
      // so a tampered client cannot bypass it. Checked BEFORE guard so a gated
      // auto call never reserves (and never has to refund) an aiCall. Manual
      // runs fall through to the aiCalls quota below for every plan.
      if (auto) {
        const { plan } = await resolvePlan(req, uid);
        if (!isAutoResearchAllowed(plan)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "feature_gated",
              feature: "autoResearch",
              plan,
            }),
          );
          return;
        }
      }

      g = await guard(req, res, uid, "aiCalls", 1);
      if (!g.ok) return;

      const accessToken = await getGcpAccessToken();

      const systemPrompt = `あなたは会議のシニアリサーチディレクターです。
音声認識テキストを深く分析し、会議参加者に真に有益な調査を設計してください。

## あなたの役割
1. 会議の文脈・目的・参加者の関心事を深く読み解く
2. リサーチ価値のあるトピックを特定する
3. 各トピックについて「何を」「なぜ」「どの切り口で」調べるべきかを判断する
4. Web検索担当（リサーチアシスタント）への詳細なブリーフを設計する

## リサーチブリーフの設計指針
あなたのブリーフの質が、最終的なアウトプットの質を決定します。

**researchAngle（調査の焦点）の設計:**
- 悪い例: 「ソニーについて調べて」
- 良い例: 「ソニーのゲーム事業に焦点。議論ではPS5の販売台数が話題になっており、直近四半期のG&NS部門の売上・ハードウェア出荷台数・サブスクリプション会員数の推移が最も関連する。競合(Xbox, Nintendo)との比較データも有用」

**desiredOutput（出力形式の指示）の設計:**
- 悪い例: 「情報をまとめて」
- 良い例: 「先頭に結論1行（例: PS5累計6000万台、前年比+15%）。続いて直近2Qの数値を箇条書き。議論で出た『1億台突破は来年』という発言の妥当性を最後に1行で判定」

## リサーチ対象の判定基準
以下に該当する場合にリサーチを設計:
1. **企業・ブランド・人名**: 最新動向、財務状況、市場ポジション
2. **数値・事実の主張**: 「シェアは○%」「売上○億」→ 正確な数値で裏付けor修正
3. **業界動向・技術トレンド**: 最新の市場データ、競合情報
4. **明示的な調査依頼**: 「調べて」「確認して」等の発言

以下はリサーチ不要:
- 一般的な雑談・挨拶・意見表明
- 検索済みトピックと実質同じ内容
- 検索しても有用な情報が得られない曖昧な話題

0〜3件のsearchesを返してください。検索価値がなければ空配列。

## スピーカーへの質問（questions）の設計
相手（自分以外の話者）が実質的な内容を**まとまって話した**直後に、こちらが次に投げるべき
鋭い質問を設計します。これは会議参加者が「いざ質問しようとすると引き出しが少ない」場面を
支える機能です。Web検索は不要で、発言そのものへの深い読み込みから設計します。

- 直近の発言に対して、**狙いの異なる質問を3〜4問**用意する。狙いは分散させること:
  - 数値・事実を引き出す（「具体的に何%／いつ／いくら？」）
  - 前提・根拠を掘る（「その判断の前提は？なぜそう言える？」）
  - 具体化を促す（「具体例を1つ挙げると？」）
  - リスク・反例を突く（「未達／失敗時は？逆のケースは？」）
  - 次アクションを確定させる（「誰が・いつまでに？」）
- 会議の言語で、**そのまま口に出せる簡潔な問い**にする。長い前置き禁止。
- 以下では questions を出さない（空にする）:
  - 挨拶・雑談・相槌・自分（記録者）側の発言
  - 掘り下げる価値のない断片的な発言
  - 直近の質問候補と実質同じ問い

必ずJSON形式のみで出力してください。

出力フォーマット:
{
  "searches": [
    {
      "query": "検索クエリ（具体的に。年号含む）",
      "type": "topic | fact-check | financial | explicit-request",
      "researchAngle": "調査の焦点。会議の文脈を踏まえ、何に焦点を当てて調べるべきか",
      "desiredOutput": "最も有用な出力の形式と内容。具体的に指示",
      "claim": "(fact-checkのみ) 検証対象の元の発言をそのまま引用"
    }
  ],
  "questions": {
    "topic": "質問群の見出し（例: 新規事業のKPI）。相手の発言テーマを短く",
    "items": [
      { "question": "現在の達成率は具体的に何%ですか？", "intent": "数値を引き出す" }
    ]
  }
}

questions は掘り下げ価値がある時のみ。無ければ "questions": { "items": [] } とすること。`;

      let userPrompt = `## 新しいトランスクリプト（音声認識 — 誤認識を含む可能性あり）\n${transcriptDiff.slice(0, 3000)}`;
      if (fullContext) {
        userPrompt += `\n\n## 会議の全体コンテキスト（直近部分）\n${fullContext.slice(-4000)}`;
      }
      if (documentContext) {
        userPrompt += `\n\n## 構造化済みドキュメント（参考）\n${documentContext.slice(0, 2000)}`;
      }
      userPrompt += `\n\n## 検索済みトピック（重複禁止）\n${searchedTopics.length > 0 ? searchedTopics.join(", ") : "(なし)"}`;

      const vertexRes = await fetchUpstreamWithRetry(() =>
        fetch(getVertexAiUrl(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            anthropic_version: "vertex-2023-10-16",
            // Generous headroom for opus-5's default `thinking` tokens PLUS the
            // JSON brief: with thinking on, a low ceiling can be spent before the
            // JSON is emitted, truncating it ("no JSON found"). The ceiling is a
            // cap, not a charge. Kept below the 128K streaming max because this
            // call is non-streaming (stream:false) and a huge cap would widen the
            // HTTP-timeout window; the JSON brief is small and finishes early.
            max_tokens: 32000,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
            stream: false,
          }),
        }),
      );

      if (!vertexRes.ok) {
        // Never leak the raw upstream status/body to the client (that produced
        // the "素の500エラー" users saw). Research is a best-effort background
        // enhancement: on upstream failure we degrade to an empty result with a
        // clean 200 so the panel simply shows no new cards this tick. committed
        // stays false → the reserved aiCall is refunded in `finally`.
        const errText = await vertexRes.text().catch(() => "");
        console.error(
          `[research] analyze upstream failed: ${vertexRes.status} | ${errText.slice(0, 500)}`,
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ searches: [], questions: null }));
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vertexData = (await vertexRes.json()) as any;
      // Claude 5 models (claude-opus-5) emit a leading `thinking` block by
      // default, so content[0] is usually NOT the text block. Reading
      // content[0].text (the old code) therefore returned "" for EVERY opus-5
      // response — logged as "empty response from Claude" — which silently
      // killed live research (0 searches → 0 cards). Concatenate ALL text-type
      // blocks instead; this is model-agnostic (works with or without thinking).
      const text = Array.isArray(vertexData.content)
        ? vertexData.content
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .filter((b: any) => b?.type === "text")
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((b: any) => b?.text || "")
            .join("")
        : vertexData.content?.text || "";

      if (!text) {
        console.log("[research] analyze: empty response from Claude");
        committed = true; // Vertex was invoked (cost incurred) — keep the charge.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ searches: [], questions: null }));
        return;
      }

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error("[research] analyze: no JSON found in response");
        committed = true; // Vertex was invoked (cost incurred) — keep the charge.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ searches: [], questions: null }));
        return;
      }

      // The greedy /\{[\s\S]*\}/ span can capture non-JSON text, and a
      // thinking-truncated response can leave the JSON malformed — an unguarded
      // JSON.parse here throws, and the outer catch turned that into a raw 500
      // (the "素の500エラー" users saw). Degrade to an empty result on any parse
      // failure; Vertex was invoked so the charge is kept (committed=true).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any;
      try {
        result = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        console.error(
          `[research] analyze: JSON parse failed: ${
            parseErr instanceof Error ? parseErr.message : String(parseErr)
          }`,
        );
        committed = true; // Vertex was invoked (cost incurred) — keep the charge.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ searches: [], questions: null }));
        return;
      }
      const searches = Array.isArray(result.searches) ? result.searches : [];
      // Questions are follow-up prompts the user can ASK — no web search needed.
      // Only surface them when the director produced a non-empty item list.
      const rawQuestions = result.questions;
      const questionItems = Array.isArray(rawQuestions?.items)
        ? rawQuestions.items.filter(
            (q: { question?: string }) =>
              q && typeof q.question === "string" && q.question.trim(),
          )
        : [];
      const questions =
        questionItems.length > 0
          ? { topic: rawQuestions.topic || "", items: questionItems }
          : null;
      // Log counts only — the generated search queries are derived from the
      // user's private research/document content and must not hit stdout logs.
      console.log(
        `[research] analyze: ${searches.length} searches, ${questionItems.length} questions`,
      );
      committed = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ searches, questions }));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      console.error(`[research] analyze error: ${message}`);
      sendJsonError(res, isAuthErrorMessage(message) ? 401 : 500, message);
    } finally {
      // Refund the reserved aiCall if the upstream Vertex call failed / threw.
      await refundIfUncommitted(g, committed);
    }
    return;
  }

  // --- /v1/research/grounded-search ---
  if (req.url === "/v1/research/grounded-search") {
    let g: GuardResult | null = null;
    let committed = false;
    try {
      const uid = await verifyFirebaseToken(req.headers.authorization, {
        checkRevoked: true,
      });
      const body = await readBody();
      const parsed = JSON.parse(body);
      const query: string = parsed.query || "";
      const researchAngle: string = parsed.researchAngle || "";
      const desiredOutput: string = parsed.desiredOutput || "";
      const claim: string = parsed.claim || "";

      if (!query) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "query is required" }));
        return;
      }

      g = await guard(req, res, uid, "aiCalls", 1);
      if (!g.ok) return;

      const accessToken = await getGcpAccessToken();

      const systemPrompt = researchAngle
        ? `会議のリアルタイムリサーチアシスタント。ディレクターのブリーフに基づき、正確で具体的な情報を提供する。

## 調査の焦点
${researchAngle}

## 求められるアウトプット
${desiredOutput || "数値・日付・固有名詞を含む具体的な情報を箇条書きで提供"}
${claim ? `\n## 検証対象の発言\n「${claim}」` : ""}

## 品質基準（厳守）
- 数値・日付・固有名詞を必ず含める。抽象的な記述は禁止
- 「〜と言われている」「〜の見方がある」等の曖昧表現禁止。断定と出典で書く
- 不明な情報は「確認不能」と明記。推測で補完しない
- コンパクトに。会議中にチラ見して即座に使える分量（最大8行）`
        : `会議中にチラ見するカンペを生成する。数値・固有名詞・日付を含め、曖昧表現は禁止。最大8行。`;

      const userPrompt = query;

      const geminiRes = await fetchUpstreamWithRetry(() =>
        fetch(getGeminiUrl(GEMINI_MODEL), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: systemPrompt }],
            },
            contents: [
              {
                role: "user",
                parts: [{ text: userPrompt }],
              },
            ],
            tools: [{ googleSearch: {} }],
          }),
        }),
      );

      if (!geminiRes.ok) {
        // Same degrade-not-leak policy as analyze: return a clean, empty result
        // (with `degraded:true` so the client can show a soft "検索できませんでした"
        // state instead of a raw error) rather than passing the upstream status/
        // body through. committed stays false → the aiCall is refunded.
        const errText = await geminiRes.text().catch(() => "");
        console.error(
          `[research] grounded-search upstream failed: ${geminiRes.status} | ${errText.slice(0, 500)}`,
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            summary: "",
            sources: [],
            webSearchQueries: [],
            degraded: true,
          }),
        );
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const geminiData = (await geminiRes.json()) as any;
      // gemini-3.5-flash is a thinking model: its first part CAN be a pure
      // `thought` part (no text), which would make the old `parts[0].text`
      // read undefined → empty summary. Join every non-thought text part so
      // the answer is captured regardless of thought-part ordering. (Same
      // class of regression as the opus-5 thinking-block fix above.)
      const gParts = geminiData.candidates?.[0]?.content?.parts;
      const summary = Array.isArray(gParts)
        ? gParts
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .filter((p: any) => !p?.thought && typeof p?.text === "string")
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((p: any) => p.text)
            .join("")
        : "";
      const groundingMeta = geminiData.candidates?.[0]?.groundingMetadata;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sources = (groundingMeta?.groundingChunks || []).map(
        (chunk: any) => {
          const uri: string = chunk.web?.uri || "";
          const title: string = chunk.web?.title || "";
          let domain = "";
          try {
            domain = new URL(uri).hostname;
          } catch {
            domain = uri;
          }
          return {
            url: uri,
            title,
            domain,
            credibility: classifyCredibility(domain),
          };
        },
      );

      const webSearchQueries: string[] = groundingMeta?.webSearchQueries || [];

      // Log counts only — `query` is the user's private research input and must
      // not be written to stdout logs (only length as a coarse size signal).
      console.log(
        `[research] grounded-search: queryLen=${query.length} sources=${sources.length} searches=${webSearchQueries.length}`,
      );
      committed = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ summary, sources, webSearchQueries }));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      console.error(`[research] grounded-search error: ${message}`);
      sendJsonError(res, isAuthErrorMessage(message) ? 401 : 500, message);
    } finally {
      // Refund the reserved aiCall if the upstream Gemini call failed / threw.
      await refundIfUncommitted(g, committed);
    }
    return;
  }

  // --- /v1/chat ---
  if (req.url !== "/v1/chat") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  let g: GuardResult | null = null;
  let committed = false;
  try {
    // Verify Firebase auth
    const uid = await verifyFirebaseToken(req.headers.authorization, {
      checkRevoked: true,
    });

    const body = await readBody();
    const parsed = JSON.parse(body);
    const isStream = parsed.stream === true;

    g = await guard(req, res, uid, "aiCalls", 1);
    if (!g.ok) return;

    // Build Vertex AI request (model is in URL, not body)
    const vertexBody: Record<string, unknown> = {
      anthropic_version: "vertex-2023-10-16",
      // Fallback ceiling when the client doesn't send one. Streaming gets the
      // full 128K output max (safe, cap-not-charge); non-streaming stays lower
      // to avoid widening the HTTP-timeout window on a huge response.
      max_tokens: parsed.max_tokens || (isStream ? 128000 : 16000),
      messages: stripThinkingBlocks(parsed.messages || []),
      stream: isStream,
    };
    if (parsed.system) {
      vertexBody.system = parsed.system;
    }
    if (parsed.tools) {
      vertexBody.tools = parsed.tools;
    }

    const accessToken = await getGcpAccessToken();

    const vertexRes = await fetchUpstreamWithRetry(() =>
      fetch(getVertexAiUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(vertexBody),
      }),
    );

    if (!vertexRes.ok) {
      // Do NOT pass the raw Vertex body through — it is an opaque upstream error
      // that surfaced as a raw blob in the UI. Emit a machine-readable code +
      // retryable flag; the client (AiPanel.pushFriendlyError) maps it to a
      // friendly Japanese message. Full body is logged server-side for ops.
      const errText = await vertexRes.text().catch(() => "");
      console.error(
        `[chat] vertex upstream failed: ${vertexRes.status} | ${errText.slice(0, 800)}`,
      );
      const retryable = TRANSIENT_UPSTREAM_STATUS.has(vertexRes.status);
      const status = retryable ? 503 : 502;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "ai_upstream_error",
          retryable,
        }),
      );
      return;
    }

    // Vertex accepted the request (200) — the cost is incurred, so keep the
    // charge even if the client disconnects mid-stream.
    committed = true;

    if (isStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const reader = vertexRes.body?.getReader();
      if (!reader) {
        res.end();
        return;
      }

      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
    } else {
      const data = await vertexRes.text();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(data);
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    // If the SSE stream already started, headers are sent — we cannot write an
    // error status. Writing one throws ERR_HTTP_HEADERS_SENT which would surface
    // as an unhandled rejection and crash the instance. Just close the socket.
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
    } else {
      sendJsonError(res, isAuthErrorMessage(message) ? 401 : 500, message);
    }
  } finally {
    // Refund the reserved aiCall if /v1/chat failed before Vertex accepted it.
    await refundIfUncommitted(g, committed);
  }
});

// Backstop: never let a stray async error tear down the whole instance and drop
// every in-flight request. Per-request handlers already catch their own errors;
// these catch anything that slips through (e.g. a socket write after the client
// vanished, or a timer callback that rejects). Log and keep serving — Cloud Run
// will recycle the instance if it becomes genuinely unhealthy.
process.on("unhandledRejection", (reason) => {
  console.error("[proxy] Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[proxy] Uncaught exception:", err);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AI proxy server running on port ${PORT}`);
});
