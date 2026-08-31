// =====================================================================
// Stripe billing pure logic (monetization P1)
// ---------------------------------------------------------------------
// Pure, side-effect-free decisions for the Stripe subscription webhook and
// checkout flow — same discipline as gating.ts / metering.ts: NO stripe /
// firebase-admin / http imports, so it is exhaustively unit-testable (see
// billing.test.ts) and the esbuild bundle stays clean. index.ts does the Stripe
// SDK calls, signature verification, and Firestore reads/writes; it feeds the
// parsed facts into these functions and applies their decisions.
//
// HARD CONTRACT (gating.ts derivePlan): the entitlements/{uid} doc is gated on
// ONLY {plan, status}. plan ∈ {free,pro,team,internal}; paidOk = active|grace|
// trialing. Everything this module adds (stripeCustomerId, currentPeriodEnd,
// eventId, …) is metadata invisible to the gate. The webhook NEVER writes
// plan:"internal" — that is admin/seed-only and is treated as untouchable here.
// =====================================================================
import { parseUidSet } from "./gating";

/** Our entitlement status vocabulary (superset consumed by derivePlan). */
export type OurStatus = "active" | "grace" | "on_hold" | "canceled";

/**
 * Map a raw Stripe `subscription.status` to our entitlement status.
 * - active/trialing → active (full access; trialing is honored as paid)
 * - past_due       → grace   (dunning; access preserved by derivePlan)
 * - unpaid/paused  → on_hold (retries exhausted / paused; access revoked, plan
 *                             retained for reactivation memory)
 * - canceled/incomplete/incomplete_expired → canceled (never activated / ended)
 * Returns null for an UNKNOWN status so the caller PRESERVES the current doc
 * (never silently downgrade a payer on a Stripe status we don't recognize) and
 * logs it — no silent fallback.
 */
export function mapStripeStatus(raw: unknown): OurStatus | null {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  switch (s) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "grace";
    case "unpaid":
    case "paused":
      return "on_hold";
    case "canceled":
    case "incomplete":
    case "incomplete_expired":
      return "canceled";
    default:
      return null;
  }
}

/** Immutable price→plan lookup built from env (comma-separated price id lists). */
export interface PriceMap {
  pro: ReadonlySet<string>;
  team: ReadonlySet<string>;
}

/**
 * Build a PriceMap from the two env vars. Each may hold several price ids
 * (monthly + yearly) comma-separated. Trimmed, empties dropped (reuses the same
 * parser as the uid allowlists).
 */
export function buildPriceMap(
  proIds: string | undefined,
  teamIds: string | undefined,
): PriceMap {
  return { pro: parseUidSet(proIds), team: parseUidSet(teamIds) };
}

/**
 * Resolve which plan a Stripe price id grants. Returns null for an unknown price
 * (caller must NOT grant a plan for a price it doesn't recognize — fail closed).
 */
export function mapPriceToPlan(
  priceId: string | undefined | null,
  m: PriceMap,
): "pro" | "team" | null {
  const id = String(priceId ?? "").trim();
  if (!id) return null;
  if (m.pro.has(id)) return "pro";
  if (m.team.has(id)) return "team";
  return null;
}

/**
 * Resolve the server-authoritative Stripe price id for a checkout request.
 * plan/interval come from the client but the PRICE never does — the client can
 * only pick among the ids the server was configured with. Returns null for an
 * unconfigured/invalid combo (caller returns 400/503, never invents a price).
 */
export function resolveCheckoutPriceId(
  plan: unknown,
  interval: unknown,
  env: {
    proMonthly?: string;
    proYearly?: string;
    teamMonthly?: string;
    teamYearly?: string;
  },
): string | null {
  const p = String(plan ?? "")
    .trim()
    .toLowerCase();
  const i = String(interval ?? "month")
    .trim()
    .toLowerCase();
  const pick = (v?: string) => (v && v.trim() ? v.trim() : null);
  if (p === "pro") return pick(i === "year" ? env.proYearly : env.proMonthly);
  if (p === "team")
    return pick(i === "year" ? env.teamYearly : env.teamMonthly);
  return null;
}

/**
 * Out-of-order guard. Stripe delivers events at-least-once and NOT in order, and
 * can emit two Event objects for one change. Apply an event only when it is
 * strictly newer than the last applied one (by event.created epoch seconds), so
 * a delayed stale event can never resurrect a later state (e.g. a late
 * `active` after a `canceled`). Exact re-deliveries are caught upstream by the
 * event.id dedupe; a rare same-second sibling converging on the same end-state
 * is harmless to drop and self-corrects on the next event / reconcile.
 */
export function isEventNewer(
  incomingCreated: number,
  storedCreated: number | null | undefined,
): boolean {
  const stored = Number(storedCreated) || 0;
  return incomingCreated > stored;
}

/** The existing entitlements/{uid} doc fields this module inspects. */
export interface ExistingEntitlement {
  plan?: unknown;
  source?: unknown;
  status?: unknown;
  eventCreated?: unknown;
  /** True when the last write came from a customer.subscription.deleted (final). */
  terminal?: unknown;
  /** The subscription id the current state belongs to (scopes a terminal revoke). */
  stripeSubscriptionId?: unknown;
  /**
   * Rail-agnostic subscription id (Apple originalTransactionId / Play
   * purchaseToken / Stripe subscription id). When present it supersedes
   * stripeSubscriptionId for the cross-sub terminal / same-second scoping, so the
   * IAP rails get the same "a terminal revoke may only revoke the sub the doc
   * tracks" protection as Stripe.
   */
  subId?: unknown;
}

/**
 * Access-precedence rank of an entitlement status, used ONLY to break an exact
 * same-second timestamp tie (see decideEntitlementWrite). Higher = more access.
 * A missing status ranks as "active" to mirror derivePlan (which defaults a
 * missing status to active); an unrecognized status ranks lowest (no access).
 */
const STATUS_RANK: Record<OurStatus, number> = {
  active: 3,
  grace: 2,
  on_hold: 1,
  canceled: 0,
};
function statusRank(s: unknown): number {
  const raw =
    s == null || String(s).trim() === ""
      ? "active"
      : String(s).trim().toLowerCase();
  return (STATUS_RANK as Record<string, number>)[raw] ?? 0;
}

/** A fully-resolved intent to write, produced by index.ts from a Stripe event. */
export interface EntitlementIntent {
  plan: "free" | "pro" | "team";
  status: OurStatus;
  eventId: string;
  eventCreated: number;
  /**
   * True ONLY for a customer.subscription.deleted event. A terminal revoke is
   * final: it has no live re-fetch and no follow-up event, so it must win a
   * same-second tie for its own subscription and, once recorded, can never be
   * resurrected by a same-second sibling. Set from the event TYPE, never from
   * the mapped "canceled" status (a created@incomplete also maps to canceled but
   * is NOT terminal — it can still activate).
   */
  terminal?: boolean;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  priceId?: string;
  /**
   * Billing rail that produced this intent. Defaults to "stripe" when omitted so
   * every existing Stripe call site is byte-for-byte unchanged. The rail owns the
   * doc: decideEntitlementWrite refuses to let one rail overwrite another's doc
   * (owned_by_<source>), which is the multi-rail double-charge guard.
   */
  source?: "stripe" | "app_store" | "play";
  /**
   * Rail-agnostic subscription id: Stripe subscription id / Apple
   * originalTransactionId / Play purchaseToken. Falls back to
   * stripeSubscriptionId when omitted. Used for cross-sub terminal scoping.
   */
  subId?: string;
  /** Team seat count (subscription item quantity). Team plan only; else 1. */
  seats?: number;
  /** The team this subscription funds (checkout metadata). Team plan only. */
  teamId?: string;
  /**
   * The store product identifier that funded this entitlement (Apple product id /
   * Play product+basePlan / Stripe price id echo). Audit-only, invisible to the
   * gate; lets support/reconciliation see exactly which SKU is active.
   */
  productId?: string;
  // --- IAP audit metadata (invisible to the gate; for reconciliation/support) ---
  appStoreOriginalTransactionId?: string;
  appStoreTransactionId?: string;
  appAccountToken?: string;
  playPurchaseToken?: string;
  playLinkedPurchaseToken?: string;
  playOrderId?: string;
  environment?: string;
}

export type EntitlementDecision =
  | { apply: false; reason: string }
  | { apply: true; fields: Record<string, unknown> };

/**
 * Decide whether (and what) to write to entitlements/{uid} for a Stripe event,
 * given the existing doc. Enforces the three invariants:
 *  1. INTERNAL IS SACRED — never touch a plan:"internal" doc (a staff member who
 *     also buys a Stripe sub must never be downgraded).
 *  2. CROSS-RAIL SAFETY — only mutate a doc that is stripe-owned or unclaimed;
 *     app_store/play/founder docs are owned by their own rail.
 *  3. MONOTONIC ORDERING — apply only strictly-newer events.
 * On apply, returns ONLY the fields to merge (setDoc merge preserves
 * earlySupporter/teamId and any other untouched fields). The caller must always
 * write `status` explicitly (derivePlan defaults a MISSING status to "active",
 * so an absent status on a revocation would silently grant access).
 */
export function decideEntitlementWrite(
  existing: ExistingEntitlement | null | undefined,
  intent: EntitlementIntent,
): EntitlementDecision {
  const existingPlan = String((existing?.plan ?? "") as unknown)
    .trim()
    .toLowerCase();
  const existingSource = String((existing?.source ?? "") as unknown)
    .trim()
    .toLowerCase();
  // The rail this intent belongs to. Absent = "stripe" so every existing Stripe
  // call site keeps its exact prior behavior.
  const intentSource = String((intent.source ?? "stripe") as unknown)
    .trim()
    .toLowerCase();

  if (existingPlan === "internal")
    return { apply: false, reason: "internal_untouchable" };
  // CROSS-RAIL SAFETY: a doc owned by one rail (stripe / app_store / play /
  // founder / …) may normally only be mutated by that same rail. An empty
  // existingSource is unclaimed and may be adopted. This is the multi-rail
  // double-charge guard: one rail can never silently overwrite (or be overwritten
  // by) another rail's LIVE subscription — the second rail's write is refused.
  //
  // DEAD-DOC HANDOFF (the exception): if the other rail's doc is DEAD — a final
  // terminal revoke, OR an explicitly canceled/expired subscription that no
  // longer grants access — then a purchase on a DIFFERENT rail is a legitimate
  // FRESH subscription and may ADOPT the doc. Without this, a real customer who
  // lets their App Store sub lapse (Apple status 2 → "canceled", NOT terminal)
  // and then subscribes again on desktop/web via Stripe is charged but never
  // granted Pro — a silent money leak. A still-LIVE doc (active/grace) OR a
  // reactivatable one (on_hold — dunning/paused, whose OWN rail may still recover
  // it) stays locked to its rail, so this never stomps a paying subscription. A
  // MISSING status is treated as LIVE (derivePlan defaults missing → active), not
  // dead — only an EXPLICIT canceled/terminal doc is adoptable.
  if (existingSource && existingSource !== intentSource) {
    const existingTerminal = existing?.terminal === true;
    const existingStatus = String((existing?.status ?? "") as unknown)
      .trim()
      .toLowerCase();
    const existingDead = existingTerminal || existingStatus === "canceled";
    if (!existingDead)
      return { apply: false, reason: `owned_by_${existingSource}` };
    // else: adopting a DEAD foreign doc — allowed. subId is re-scoped to THIS
    // rail's id unconditionally below (see the subId sync), so the defunct
    // foreign subId never survives the merge.
  }

  const incomingTerminal = intent.terminal === true;
  // Rail-agnostic subscription id for the terminal / same-second scoping below.
  // subId supersedes stripeSubscriptionId; Stripe intents that only set
  // stripeSubscriptionId still resolve identically via the fallback.
  const existingSubId = String(
    (existing?.subId ?? existing?.stripeSubscriptionId ?? "") as unknown,
  ).trim();
  const intentSubId = String(
    (intent.subId ?? intent.stripeSubscriptionId ?? "") as unknown,
  ).trim();

  // CROSS-SUB TERMINAL SAFETY (applies REGARDLESS of event age). A terminal
  // revoke (customer.subscription.deleted) may ONLY revoke the subscription the
  // doc currently tracks. A customer can transiently hold two subscriptions
  // (a checkout race, a manual dashboard sub, an on_hold sub left while a new one
  // is bought), and Stripe emits each sub's lifecycle independently. Without this
  // scope, a *strictly-newer* delete of the OLD sub would fall straight through
  // the isEventNewer branch below and unconditionally write plan:free — revoking
  // a DIFFERENT, currently-PAYING subscription. The same-second tie-break already
  // scoped this via `sameSub`; a strict-newer delete must be scoped identically.
  // Non-terminal events (created/updated) may legitimately swap the tracked sub,
  // so this guard is terminal-only.
  {
    if (
      incomingTerminal &&
      existingSource === intentSource &&
      existingSubId &&
      intentSubId &&
      existingSubId !== intentSubId
    ) {
      return { apply: false, reason: "terminal_other_sub" };
    }
  }

  if (!isEventNewer(intent.eventCreated, Number(existing?.eventCreated))) {
    // Same-second sibling tie-break. Stripe emits related lifecycle events within
    // one second, out of order, and `event.created` is only second-granular.
    //  1. ACTIVATION: customer.subscription.created (incomplete → canceled → free)
    //     and .updated (active → pro) can share a second; strict-newer would drop
    //     whichever loses the processing-order race and strand a payer on free.
    //     Resolve by ACCESS RANK — the higher-access status wins deterministically
    //     (active > grace > on_hold > canceled) regardless of arrival order.
    //  2. CANCELLATION: a customer.subscription.deleted (terminal) can share a
    //     second with the .updated@active that preceded it. A delete has NO live
    //     re-fetch and NO follow-up event, and there is no reconcile job — so if
    //     it lost the access-rank tie it would strand a CANCELED user on a paid
    //     plan forever. A terminal revoke therefore ALWAYS wins the tie for its
    //     OWN subscription, and once terminal is recorded a same-second sibling
    //     can NEVER resurrect it. (A genuine later re-subscribe is strictly newer
    //     and still applies via isEventNewer, clearing terminal.)
    const stored = Number(existing?.eventCreated) || 0;
    const tie = stored > 0 && intent.eventCreated === stored;
    const existingTerminal = existing?.terminal === true;
    const sameSub =
      !existingSubId || !intentSubId || existingSubId === intentSubId;
    let applyOnTie: boolean;
    if (existingTerminal)
      applyOnTie = false; // terminal state is final — never overridden on a tie
    else if (incomingTerminal)
      applyOnTie = sameSub; // a delete of the CURRENT sub wins; of another sub, ignore
    else applyOnTie = statusRank(intent.status) > statusRank(existing?.status);
    if (!(tie && applyOnTie)) return { apply: false, reason: "stale_event" };
  }

  const fields: Record<string, unknown> = {
    plan: intent.plan,
    status: intent.status,
    source: intentSource,
    eventId: intent.eventId,
    eventCreated: intent.eventCreated,
    // Always write terminal explicitly (true for a delete, false otherwise) so a
    // later re-subscribe CLEARS a stale terminal marker instead of merge-keeping it.
    terminal: incomingTerminal,
  };
  if (intent.stripeCustomerId)
    fields.stripeCustomerId = intent.stripeCustomerId;
  if (intent.stripeSubscriptionId)
    fields.stripeSubscriptionId = intent.stripeSubscriptionId;
  if (intent.currentPeriodEnd != null)
    fields.currentPeriodEnd = intent.currentPeriodEnd;
  if (intent.cancelAtPeriodEnd != null)
    fields.cancelAtPeriodEnd = intent.cancelAtPeriodEnd;
  if (intent.priceId) fields.priceId = intent.priceId;
  // Team per-seat: seats sizes the shared quota pool; teamId links the doc to the
  // funded team. Both are invisible to derivePlan (gated on {plan,status} only).
  if (intent.seats != null) fields.seats = intent.seats;
  if (intent.teamId) fields.teamId = intent.teamId;
  // IAP audit metadata (invisible to the gate). Conditionally merged so a Stripe
  // intent never writes empty Apple/Play fields and vice-versa.
  if (intent.productId) fields.productId = intent.productId;
  if (intent.appStoreOriginalTransactionId)
    fields.appStoreOriginalTransactionId = intent.appStoreOriginalTransactionId;
  if (intent.appStoreTransactionId)
    fields.appStoreTransactionId = intent.appStoreTransactionId;
  if (intent.appAccountToken) fields.appAccountToken = intent.appAccountToken;
  if (intent.playPurchaseToken)
    fields.playPurchaseToken = intent.playPurchaseToken;
  if (intent.playLinkedPurchaseToken)
    fields.playLinkedPurchaseToken = intent.playLinkedPurchaseToken;
  if (intent.playOrderId) fields.playOrderId = intent.playOrderId;
  if (intent.environment) fields.environment = intent.environment;
  // subId SYNC (money-critical — keep authoritative on EVERY apply). subId is the
  // rail-agnostic id that cross-sub terminal scoping (above) and the same-second
  // tie-break compare against, and it takes PRECEDENCE over stripeSubscriptionId
  // in existingSubId. Stripe intents carry only stripeSubscriptionId (never
  // intent.subId), so intentSubId falls back to it. If we wrote subId only
  // sometimes (e.g. only on cross-rail adoption), a Stripe doc's subId would go
  // STALE the next time the tracked sub changed — a later re-subscribe updates
  // stripeSubscriptionId but the pinned subId would still shadow it, so the
  // eventual cancel of the NEW sub would see existingSubId(=old) !== intentSubId
  // (=new) and refuse as `terminal_other_sub`, stranding a CANCELED user on Pro
  // forever (a permanent house money leak). Writing it on every apply makes subId
  // always track the currently-tracked subscription across re-subscribes and
  // cross-rail adoption alike.
  if (intentSubId) fields.subId = intentSubId;
  return { apply: true, fields };
}

/**
 * Decide, from an authoritative Subscription's mapped status + mapped plan, what
 * applySubscription must do. Extracted as a pure function so the money-critical
 * invariants have a regression net (index.ts itself is not unit-tested):
 *  - unknown Stripe status (ourStatus === null) → PRESERVE the current doc
 *    (never silently downgrade a payer on a status we don't recognize).
 *  - recognized price → GRANT that plan (with the mapped status).
 *  - UNMAPPED price (mapPriceToPlan === null): fail CLOSED on grant but SAFE on
 *    revoke — if the event revokes access (on_hold/canceled), still downgrade to
 *    free (a price id rotated out of env must not let a non-payer keep access);
 *    otherwise skip (never grant a plan for a price we can't recognize).
 */
export type SubscriptionAction =
  | { action: "skip_unknown_status" }
  | { action: "revoke_unmapped" }
  | { action: "skip_unmapped_grant" }
  | { action: "grant"; plan: "pro" | "team" };

export function decideSubscriptionApply(
  ourStatus: OurStatus | null,
  plan: "pro" | "team" | null,
): SubscriptionAction {
  if (!ourStatus) return { action: "skip_unknown_status" };
  if (!plan) {
    if (ourStatus === "on_hold" || ourStatus === "canceled")
      return { action: "revoke_unmapped" };
    return { action: "skip_unmapped_grant" };
  }
  return { action: "grant", plan };
}

/**
 * Pick the first non-empty uid candidate. Used to resolve the uid for an event
 * from (in priority order) session.client_reference_id, subscription/session
 * metadata.firebaseUid, then a Firestore customer→uid reverse-map lookup.
 * Never trusts client-asserted input — every candidate here originates from a
 * Stripe object the server created with a server-verified uid.
 */
export function pickUid(candidates: Array<unknown>): string | null {
  for (const c of candidates) {
    const s = typeof c === "string" ? c.trim() : "";
    if (s) return s;
  }
  return null;
}

/** Stripe duration → epoch seconds passthrough (guards NaN/negatives → 0). */
export function toEpochSeconds(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// =====================================================================
// Team per-seat billing (monetization ②)
// ---------------------------------------------------------------------
// A Team subscription is a single Stripe subscription whose item quantity IS the
// seat count. The seat count sizes a SHARED quota pool (see gating.checkQuota's
// `seats` scale) metered under usage/{teamId}. The authoritative seat count lives
// in teams/{teamId}.billing.seats (written ONLY by the webhook via Admin SDK);
// seatAssignments (who may spend) is a separate server-only field.
// =====================================================================

/**
 * Validate and clamp a client-requested seat count for checkout / seat change.
 * - Non-team plans have NO seat concept → always 1 (Pro checkout is unchanged).
 * - Team must be an integer in [1, max]; anything else → null (caller 400s). We
 *   never silently coerce an invalid seat count (a 0-seat paid sub, a fractional
 *   or absurd count) — fail loudly.
 */
export function clampSeats(
  raw: unknown,
  plan: unknown,
  max: number,
): number | null {
  const p = String(plan ?? "")
    .trim()
    .toLowerCase();
  if (p !== "team") return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

/** The existing teams/{teamId}.billing sub-doc fields this module inspects. */
export interface ExistingTeamBilling {
  status?: unknown;
  eventCreated?: unknown;
  terminal?: unknown;
  stripeSubscriptionId?: unknown;
}

/** A fully-resolved intent to write to teams/{teamId}.billing. */
export interface TeamBillingIntent {
  status: OurStatus;
  seats: number;
  ownerUid: string;
  eventId: string;
  eventCreated: number;
  terminal?: boolean;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripeSubscriptionItemId?: string;
  currentPeriodEnd?: number;
  priceId?: string;
}

export type TeamBillingDecision =
  | { apply: false; reason: string }
  | { apply: true; fields: Record<string, unknown> };

/**
 * Decide whether (and what) to write to teams/{teamId}.billing for a Stripe
 * event. Mirrors decideEntitlementWrite's monotonic-ordering + terminal-scoping
 * discipline (a delete may only revoke the subscription this team doc tracks; a
 * terminal state, once recorded, is never resurrected by a same-second sibling),
 * so a delayed/out-of-order event can neither strand a paying team on canceled
 * nor keep a canceled team paid. Team billing is Stripe-only (no cross-rail
 * source concept — IAP Team is flat, out of scope here).
 */
export function decideTeamBillingWrite(
  existing: ExistingTeamBilling | null | undefined,
  intent: TeamBillingIntent,
): TeamBillingDecision {
  const incomingTerminal = intent.terminal === true;
  const existingSub = String(
    (existing?.stripeSubscriptionId ?? "") as unknown,
  ).trim();
  const intentSub = String(
    (intent.stripeSubscriptionId ?? "") as unknown,
  ).trim();

  // A terminal revoke may ONLY revoke the subscription this team doc tracks.
  if (
    incomingTerminal &&
    existingSub &&
    intentSub &&
    existingSub !== intentSub
  ) {
    return { apply: false, reason: "terminal_other_sub" };
  }

  if (!isEventNewer(intent.eventCreated, Number(existing?.eventCreated))) {
    const stored = Number(existing?.eventCreated) || 0;
    const tie = stored > 0 && intent.eventCreated === stored;
    const existingTerminal = existing?.terminal === true;
    const sameSub = !existingSub || !intentSub || existingSub === intentSub;
    let applyOnTie: boolean;
    if (existingTerminal) applyOnTie = false;
    else if (incomingTerminal) applyOnTie = sameSub;
    else applyOnTie = statusRank(intent.status) > statusRank(existing?.status);
    if (!(tie && applyOnTie)) return { apply: false, reason: "stale_event" };
  }

  const fields: Record<string, unknown> = {
    plan: "team",
    status: intent.status,
    seats: intent.seats,
    ownerUid: intent.ownerUid,
    eventId: intent.eventId,
    eventCreated: intent.eventCreated,
    terminal: incomingTerminal,
  };
  if (intent.stripeCustomerId)
    fields.stripeCustomerId = intent.stripeCustomerId;
  if (intent.stripeSubscriptionId)
    fields.stripeSubscriptionId = intent.stripeSubscriptionId;
  if (intent.stripeSubscriptionItemId)
    fields.stripeSubscriptionItemId = intent.stripeSubscriptionItemId;
  if (intent.currentPeriodEnd != null)
    fields.currentPeriodEnd = intent.currentPeriodEnd;
  if (intent.priceId) fields.priceId = intent.priceId;
  return { apply: true, fields };
}
