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
  periodKey,
  checkQuota,
  isChargeable,
  isAutoResearchAllowed,
  parseOffset,
  clampBatchReserveMinutes,
  measuredBatchMinutes,
  reconcileBatchDelta,
  shouldRefund,
  type Plan,
  type Feature,
} from "./gating";
import {
  reserveUsage,
  adjustUsage as meterAdjustUsage,
  type MeteringStore,
  type ServerValues,
} from "./metering";
import {
  mapStripeStatus,
  buildPriceMap,
  mapPriceToPlan,
  resolveCheckoutPriceId,
  decideEntitlementWrite,
  pickUid,
  toEpochSeconds,
  type EntitlementIntent,
} from "./billing";

const PORT = parseInt(process.env.PORT || "8080", 10);
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "markflow-app-2026";
// Claude (Anthropic) Vertex region. Opus 4.7+ are served from the global
// endpoint, not us-east5 regional. GCP_REGION is used ONLY for the Claude
// endpoint below (Gemini/image/STT have their own locations).
const GCP_REGION = process.env.GCP_REGION || "global";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const NANOBANANA_MODEL =
  process.env.NANOBANANA_MODEL || "gemini-3.1-flash-image-preview";
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
  const ref = getFirestore().collection("entitlements").doc(uid);
  const snap = await ref.get();
  const decision = decideEntitlementWrite(
    snap.exists ? (snap.data() as Record<string, unknown>) : null,
    intent,
  );
  if (!decision.apply) {
    console.log(
      `[stripe] entitlement skip uid=${uid} reason=${decision.reason} evt=${intent.eventId}`,
    );
    return;
  }
  await ref.set(
    { ...decision.fields, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  entCache.delete(uid);
  console.log(
    `[stripe] entitlement set uid=${uid} plan=${decision.fields.plan} status=${decision.fields.status} evt=${intent.eventId}`,
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
  if (!ourStatus) {
    // Unknown Stripe status → preserve current state, never silently downgrade.
    console.error(
      `[stripe] unknown subscription status "${sub.status}" sub=${sub.id}; preserving entitlement`,
    );
    return;
  }
  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id;
  const plan = mapPriceToPlan(priceId, PRICE_MAP);
  if (!plan) {
    // Fail CLOSED on GRANT (never grant a plan for a price we don't recognize),
    // but fail SAFE on REVOKE: if this event revokes access (unpaid/paused →
    // on_hold, canceled/incomplete → canceled), downgrade to free even when the
    // price is unmapped (e.g. a price id rotated out of env while a subscriber
    // still holds it), so a non-payer can't retain paid access on a config drift.
    if (ourStatus === "on_hold" || ourStatus === "canceled") {
      await writeEntitlementFromIntent(uid, {
        plan: "free",
        status: ourStatus,
        eventId,
        eventCreated,
        stripeCustomerId: stripeCustomerId(sub.customer),
        stripeSubscriptionId: sub.id,
        cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
      });
      return;
    }
    console.error(
      `[stripe] price ${priceId} not mapped to a plan (sub=${sub.id}); skipping grant`,
    );
    return;
  }
  // current_period_end moved to the item level as of API Basil (2025-03-31).
  const periodEnd = toEpochSeconds(
    (item as unknown as { current_period_end?: number })?.current_period_end,
  );
  await writeEntitlementFromIntent(uid, {
    plan,
    status: ourStatus,
    eventId,
    eventCreated,
    stripeCustomerId: stripeCustomerId(sub.customer),
    stripeSubscriptionId: sub.id,
    currentPeriodEnd: periodEnd || undefined,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    priceId: priceId || undefined,
  });
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
  runTransaction(fn) {
    return getFirestore().runTransaction(fn as never);
  },
};
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

async function verifyFirebaseToken(
  authHeader: string | undefined,
): Promise<string> {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }
  const idToken = authHeader.slice(7);
  const decoded = await getAuth().verifyIdToken(idToken);
  return decoded.uid;
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

/**
 * Resolve the effective plan for a request: real plan (internal allowlist or
 * entitlement doc), then apply the owner-only view-as override if present.
 */
async function resolvePlan(
  req: http.IncomingMessage,
  uid: string,
): Promise<{ realPlan: Plan; plan: Plan; viewAs: Plan | null }> {
  const realPlan: Plan = INTERNAL_UIDS.has(uid)
    ? "internal"
    : await loadEntitlement(uid);
  const viewAs = resolveViewAs(req.headers["x-view-as"], uid, OWNER_UIDS);
  return { realPlan, plan: viewAs ?? realPlan, viewAs };
}

const entCache = new Map<string, { plan: Plan; at: number }>();
const ENT_TTL_MS = 60_000;

async function loadEntitlement(uid: string): Promise<Plan> {
  const cached = entCache.get(uid);
  const now = Date.now();
  if (cached && now - cached.at < ENT_TTL_MS) return cached.plan;
  try {
    const snap = await getFirestore().collection("entitlements").doc(uid).get();
    const plan: Plan = snap.exists ? derivePlan(snap.data()) : "free";
    entCache.set(uid, { plan, at: now });
    return plan;
  } catch (err) {
    // Fail to "free" (NOT unlimited) so a Firestore blip can neither break the
    // product nor leak unlimited cost. Logged explicitly — never silent.
    console.error(`loadEntitlement failed for ${uid}:`, err);
    return "free";
  }
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
  const { plan } = await resolvePlan(req, uid);
  const ym = periodKey(new Date());
  const precheck = checkQuota(plan, feature, 0, cost);
  if (precheck.unlimited) {
    return { ok: true, charged: false, uid, plan, feature, cost, ym };
  }
  try {
    const result = await reserveUsage(
      meteringStore,
      serverValues,
      uid,
      feature,
      cost,
      plan,
      ym,
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
    return { ok: true, charged: true, uid, plan, feature, cost, ym };
  } catch (err) {
    // Fail-open on metering-infra error: don't break AI for a DB blip. Logged.
    // charged:false — the increment never persisted, so never refund it.
    console.error(`guard tx failed for ${uid}/${feature}:`, err);
    return { ok: true, charged: false, uid, plan, feature, cost, ym };
  }
}

/**
 * Adjust a usage counter by `delta` (may be negative). Used both to refund a
 * reserved cost when the upstream call fails and to reconcile a batch reserve to
 * the server-measured actual. No-op for delta 0. Best-effort; errors are logged,
 * never thrown (a failed refund must not turn a successful request into a 500).
 */
async function adjustUsage(
  uid: string,
  feature: Feature,
  delta: number,
  plan: Plan,
  ym: string,
): Promise<void> {
  try {
    await meterAdjustUsage(
      meteringStore,
      serverValues,
      uid,
      feature,
      delta,
      plan,
      ym,
    );
  } catch (err) {
    console.error(`adjustUsage(${delta}) failed for ${uid}/${feature}:`, err);
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
  await adjustUsage(g.uid, g.feature, -g.cost, g.plan, g.ym);
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-View-As",
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

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
      const r = await fetch(objUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          '<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font-family:-apple-system,sans-serif;padding:3rem;text-align:center;color:#555"><h1 style="font-size:1.2rem">このドキュメントは公開されていません</h1><p>リンクが失効したか、公開が停止された可能性があります。</p></body>',
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
  const readBody = (): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: Buffer) => (data += chunk.toString()));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

  // --- /v1/me/entitlement (client: effective plan + limits + usage) ---
  // Single source for UI gating. Honors the owner-only X-View-As header so the
  // owner's UI matches what the server will actually enforce this request.
  if (req.url === "/v1/me/entitlement") {
    try {
      const uid = await verifyFirebaseToken(req.headers.authorization);
      const { realPlan, plan, viewAs } = await resolvePlan(req, uid);
      const isOwner = OWNER_UIDS.has(uid);
      const ym = periodKey(new Date());
      let usage: Record<string, number> = {};
      try {
        const snap = await getFirestore()
          .collection("usage")
          .doc(uid)
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
      const limits = plan === "internal" ? null : PLAN_LIMITS[plan];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          uid,
          realPlan,
          effectivePlan: plan,
          viewAs: viewAs ?? null,
          isOwner,
          period: ym,
          limits,
          usage,
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
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: uid,
        metadata: { firebaseUid: uid },
        subscription_data: { metadata: { firebaseUid: uid } },
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

  // --- /v1/voice/transcribe ---
  if (req.url === "/v1/voice/transcribe") {
    let g: GuardResult | null = null;
    let committed = false;
    try {
      const uid = await verifyFirebaseToken(req.headers.authorization);
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
    try {
      const uid = await verifyFirebaseToken(req.headers.authorization);
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

      // Pre-flight reserve from the client-supplied (untrusted) durations —
      // negatives clamped, floored at 1. The authoritative charge is reconciled
      // below from the server-measured transcript length, so the client cannot
      // obtain free minutes by under-reporting duration.
      reserveMin = clampBatchReserveMinutes(chunks);
      g = await guard(req, res, uid, "batchMin", reserveMin);
      if (!g.ok) return;

      const multi = chunks.length > 1;

      const batchUrl = `https://${STT_LOCATION}-speech.googleapis.com/v2/projects/${GCP_PROJECT_ID}/locations/${STT_LOCATION}/recognizers/_:batchRecognize`;

      // Transcribe one file: start the op, poll to completion, surface per-file
      // errors, and return its SpeechRecognitionResult[] (word-level speaker
      // labels + timestamps). Throws on any failure.
      const transcribeFile = async (
        uri: string,
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

      // Run all chunks in parallel (total ≈ slowest chunk).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let chunkResults: any[][];
      try {
        chunkResults = await Promise.all(
          chunks.map((c) => transcribeFile(c.gcsUri)),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[batch] Transcription failed: ${msg}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
        return;
      }

      // Dedup the 20s overlap by word timestamp — split the overlap at its
      // midpoint so each boundary word is emitted exactly once — then build a
      // speaker-tagged transcript per chunk joined by "---" boundaries (labels
      // are only consistent within a segment; Claude unifies across "---").
      const allSpeakerLabels = new Set<string>();
      const taggedSegments: string[] = [];
      const plainSegments: string[] = [];

      for (let i = 0; i < chunkResults.length; i++) {
        const results = chunkResults[i];
        const c = chunks[i];
        const leadCut = i === 0 ? 0 : OVERLAP_SECS / 2;
        const trailCut =
          i === chunkResults.length - 1 || c.durationSec <= 0
            ? Infinity
            : c.durationSec - OVERLAP_SECS / 2;

        const words: Array<{ word: string; speakerLabel: string }> = [];
        let plain = "";
        for (const r of results) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const alt = (r as any).alternatives?.[0];
          if (!alt) continue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ws: any[] = alt.words || [];
          if (multi && ws.length > 0) {
            for (const w of ws) {
              const t = parseOffset(w.startOffset);
              if (t >= leadCut && t < trailCut) {
                words.push({
                  word: w.word || "",
                  speakerLabel: w.speakerLabel || "",
                });
                plain += w.word || "";
              }
            }
          } else {
            for (const w of ws)
              words.push({
                word: w.word || "",
                speakerLabel: w.speakerLabel || "",
              });
            plain += alt.transcript || "";
          }
        }

        const labels = new Set(
          words.map((w) => w.speakerLabel).filter(Boolean),
        );
        labels.forEach((l) => allSpeakerLabels.add(l));

        let tagged = plain;
        if (labels.size > 1 && words.length > 0) {
          let cur = "";
          const parts: string[] = [];
          for (const w of words) {
            const label = w.speakerLabel || "";
            if (label && label !== cur) {
              cur = label;
              parts.push(`\n[Speaker ${label}] `);
            }
            parts.push(w.word);
          }
          tagged = parts.join("").trim();
        }

        if (plain.trim()) {
          taggedSegments.push(tagged.trim());
          plainSegments.push(plain.trim());
        }
      }

      const transcript = plainSegments.join("\n");
      const taggedTranscript = taggedSegments.join("\n---\n");
      const speakerCount = allSpeakerLabels.size;

      // Reconcile the reserve to the server-measured billable minutes (derived
      // from the actual STT word/result offsets, not the client's claim). This
      // is the authoritative charge — a client that under-reported duration now
      // has its counter corrected upward so the next request is blocked.
      const measuredMin = measuredBatchMinutes(chunkResults, OVERLAP_SECS);
      if (g.ok && g.charged) {
        await adjustUsage(
          g.uid,
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
      // On any non-success path (transcription 502, timeout, throw) refund the
      // full reserve so a failed batch never costs the user minutes.
      await refundIfUncommitted(g, committed);
    }
    return;
  }

  // --- /v1/image/generate ---
  if (req.url === "/v1/image/generate") {
    let g: GuardResult | null = null;
    let committed = false;
    try {
      const uid = await verifyFirebaseToken(req.headers.authorization);
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
      const parts = geminiData.candidates?.[0]?.content?.parts;
      if (!parts || !Array.isArray(parts)) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No image generated" }));
        return;
      }

      // Find the image part (inlineData)
      const imagePart = parts.find(
        (p: { inlineData?: { mimeType: string; data: string } }) =>
          p.inlineData,
      );
      if (!imagePart?.inlineData) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No image in response" }));
        return;
      }

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
      const uid = await verifyFirebaseToken(req.headers.authorization);
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

      const vertexRes = await fetch(getVertexAiUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          anthropic_version: "vertex-2023-10-16",
          max_tokens: 3072,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
          stream: false,
        }),
      });

      if (!vertexRes.ok) {
        const errText = await vertexRes.text();
        console.error(
          `[research] analyze error: ${vertexRes.status} | ${errText}`,
        );
        res.writeHead(vertexRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errText }));
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vertexData = (await vertexRes.json()) as any;
      const text =
        vertexData.content?.[0]?.text || vertexData.content?.text || "";

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

      const result = JSON.parse(jsonMatch[0]);
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
      console.log(
        `[research] analyze: ${searches.length} searches, ${questionItems.length} questions — ${searches.map((s: { query: string }) => s.query).join(" | ")}`,
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
      const uid = await verifyFirebaseToken(req.headers.authorization);
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

      const geminiRes = await fetch(getGeminiUrl(GEMINI_MODEL), {
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
      });

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        console.error(
          `[research] grounded-search error: ${geminiRes.status} | ${errText}`,
        );
        res.writeHead(geminiRes.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errText }));
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const geminiData = (await geminiRes.json()) as any;
      const summary =
        geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
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

      console.log(
        `[research] grounded-search: query="${query}" sources=${sources.length} searches=${webSearchQueries.length}`,
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
    const uid = await verifyFirebaseToken(req.headers.authorization);

    const body = await readBody();
    const parsed = JSON.parse(body);
    const isStream = parsed.stream === true;

    g = await guard(req, res, uid, "aiCalls", 1);
    if (!g.ok) return;

    // Build Vertex AI request (model is in URL, not body)
    const vertexBody: Record<string, unknown> = {
      anthropic_version: "vertex-2023-10-16",
      max_tokens: parsed.max_tokens || 4096,
      messages: parsed.messages || [],
      stream: isStream,
    };
    if (parsed.system) {
      vertexBody.system = parsed.system;
    }
    if (parsed.tools) {
      vertexBody.tools = parsed.tools;
    }

    const accessToken = await getGcpAccessToken();

    const vertexRes = await fetch(getVertexAiUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(vertexBody),
    });

    if (!vertexRes.ok) {
      const errText = await vertexRes.text();
      res.writeHead(vertexRes.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errText }));
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
