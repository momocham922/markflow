import { describe, it, expect } from "vitest";
import {
  mapStripeStatus,
  buildPriceMap,
  mapPriceToPlan,
  resolveCheckoutPriceId,
  isEventNewer,
  decideEntitlementWrite,
  decideSubscriptionApply,
  pickUid,
  toEpochSeconds,
  clampSeats,
  decideTeamBillingWrite,
  type EntitlementIntent,
  type TeamBillingIntent,
} from "./billing";
import { derivePlan } from "./gating";

// =====================================================================
// mapStripeStatus — Stripe status → our gate status. The end-to-end assertion
// is that the RESULT, fed through derivePlan, grants/revokes correctly.
// =====================================================================
describe("mapStripeStatus", () => {
  it("maps active/trialing → active (paid access)", () => {
    expect(mapStripeStatus("active")).toBe("active");
    expect(mapStripeStatus("trialing")).toBe("active");
    expect(mapStripeStatus("ACTIVE")).toBe("active"); // casing-tolerant
    expect(mapStripeStatus(" trialing ")).toBe("active");
  });

  it("maps past_due → grace (dunning; access preserved)", () => {
    expect(mapStripeStatus("past_due")).toBe("grace");
  });

  it("maps unpaid/paused → on_hold (access revoked, plan retained)", () => {
    expect(mapStripeStatus("unpaid")).toBe("on_hold");
    expect(mapStripeStatus("paused")).toBe("on_hold");
  });

  it("maps canceled/incomplete/incomplete_expired → canceled", () => {
    expect(mapStripeStatus("canceled")).toBe("canceled");
    expect(mapStripeStatus("incomplete")).toBe("canceled");
    expect(mapStripeStatus("incomplete_expired")).toBe("canceled");
  });

  it("returns null for an unknown status (caller preserves current state)", () => {
    expect(mapStripeStatus("some_new_status")).toBeNull();
    expect(mapStripeStatus("")).toBeNull();
    expect(mapStripeStatus(null)).toBeNull();
    expect(mapStripeStatus(undefined)).toBeNull();
  });

  it("end-to-end: the mapped status drives derivePlan correctly", () => {
    // pro + each mapped status → the access decision derivePlan actually makes.
    const grant = (stripe: string) =>
      derivePlan({ plan: "pro", status: mapStripeStatus(stripe)! });
    expect(grant("active")).toBe("pro");
    expect(grant("trialing")).toBe("pro");
    expect(grant("past_due")).toBe("pro"); // grace is paidOk
    expect(grant("unpaid")).toBe("free"); // on_hold revokes
    expect(grant("paused")).toBe("free");
    expect(grant("canceled")).toBe("free");
    expect(grant("incomplete")).toBe("free");
  });
});

// =====================================================================
// price ↔ plan mapping
// =====================================================================
describe("buildPriceMap + mapPriceToPlan", () => {
  const m = buildPriceMap(
    "price_pro_m, price_pro_y",
    "price_team_m,price_team_y",
  );

  it("maps configured pro/team price ids to their plan", () => {
    expect(mapPriceToPlan("price_pro_m", m)).toBe("pro");
    expect(mapPriceToPlan("price_pro_y", m)).toBe("pro");
    expect(mapPriceToPlan("price_team_m", m)).toBe("team");
    expect(mapPriceToPlan("price_team_y", m)).toBe("team");
  });

  it("returns null for an unknown/empty price (fail closed — never grant)", () => {
    expect(mapPriceToPlan("price_unknown", m)).toBeNull();
    expect(mapPriceToPlan("", m)).toBeNull();
    expect(mapPriceToPlan(undefined, m)).toBeNull();
    expect(mapPriceToPlan(null, m)).toBeNull();
  });

  it("tolerates whitespace in the env list and the lookup", () => {
    expect(mapPriceToPlan("price_pro_y", m)).toBe("pro"); // env had a space
    expect(mapPriceToPlan(" price_team_m ", m)).toBe("team"); // trimmed lookup
  });

  it("is empty when env vars are unset (billing unconfigured)", () => {
    const empty = buildPriceMap(undefined, undefined);
    expect(mapPriceToPlan("price_pro_m", empty)).toBeNull();
  });
});

// =====================================================================
// resolveCheckoutPriceId — server-authoritative price selection
// =====================================================================
describe("resolveCheckoutPriceId", () => {
  const env = {
    proMonthly: "price_pro_m",
    proYearly: "price_pro_y",
    teamMonthly: "price_team_m",
    teamYearly: "price_team_y",
  };

  it("selects by plan + interval", () => {
    expect(resolveCheckoutPriceId("pro", "month", env)).toBe("price_pro_m");
    expect(resolveCheckoutPriceId("pro", "year", env)).toBe("price_pro_y");
    expect(resolveCheckoutPriceId("team", "month", env)).toBe("price_team_m");
    expect(resolveCheckoutPriceId("team", "year", env)).toBe("price_team_y");
  });

  it("defaults a missing/blank interval to month", () => {
    expect(resolveCheckoutPriceId("pro", undefined, env)).toBe("price_pro_m");
    expect(resolveCheckoutPriceId("pro", "", env)).toBe("price_pro_m");
  });

  it("is casing-tolerant on plan and interval", () => {
    expect(resolveCheckoutPriceId("PRO", "YEAR", env)).toBe("price_pro_y");
  });

  it("returns null for free/unknown plans (not purchasable)", () => {
    expect(resolveCheckoutPriceId("free", "month", env)).toBeNull();
    expect(resolveCheckoutPriceId("internal", "month", env)).toBeNull();
    expect(resolveCheckoutPriceId("garbage", "month", env)).toBeNull();
  });

  it("returns null when that price is not configured (dark launch safe)", () => {
    expect(
      resolveCheckoutPriceId("team", "year", { proMonthly: "price_pro_m" }),
    ).toBeNull();
    expect(resolveCheckoutPriceId("pro", "month", {})).toBeNull();
  });
});

// =====================================================================
// isEventNewer — out-of-order / resurrection guard
// =====================================================================
describe("isEventNewer", () => {
  it("applies the first event on a fresh doc (stored 0/absent)", () => {
    expect(isEventNewer(1000, 0)).toBe(true);
    expect(isEventNewer(1000, undefined)).toBe(true);
    expect(isEventNewer(1000, null)).toBe(true);
  });

  it("applies a strictly newer event", () => {
    expect(isEventNewer(2000, 1000)).toBe(true);
  });

  it("rejects a stale (older) event — no resurrection", () => {
    expect(isEventNewer(900, 1000)).toBe(false);
  });

  it("rejects a same-second sibling (dedupe handles exact re-delivery)", () => {
    expect(isEventNewer(1000, 1000)).toBe(false);
  });
});

// =====================================================================
// decideEntitlementWrite — the three invariants + field projection
// =====================================================================
describe("decideEntitlementWrite", () => {
  const intent: EntitlementIntent = {
    plan: "pro",
    status: "active",
    eventId: "evt_1",
    eventCreated: 2000,
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: "sub_1",
    currentPeriodEnd: 9999,
    cancelAtPeriodEnd: false,
    priceId: "price_pro_m",
  };

  it("applies to a fresh (null) doc and projects all provided fields", () => {
    const d = decideEntitlementWrite(null, intent);
    expect(d.apply).toBe(true);
    if (!d.apply) throw new Error("unreachable");
    expect(d.fields).toEqual({
      plan: "pro",
      status: "active",
      source: "stripe",
      eventId: "evt_1",
      eventCreated: 2000,
      terminal: false,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      // subId mirrors stripeSubscriptionId on every apply (cross-sub scoping).
      subId: "sub_1",
      currentPeriodEnd: 9999,
      cancelAtPeriodEnd: false,
      priceId: "price_pro_m",
    });
  });

  it("NEVER touches an internal doc (staff with a Stripe sub stay internal)", () => {
    const d = decideEntitlementWrite({ plan: "internal" }, intent);
    expect(d).toEqual({ apply: false, reason: "internal_untouchable" });
  });

  it("normalizes casing/space before the internal guard", () => {
    expect(decideEntitlementWrite({ plan: " Internal " }, intent).apply).toBe(
      false,
    );
  });

  it("refuses to clobber a doc owned by another billing rail", () => {
    expect(decideEntitlementWrite({ source: "app_store" }, intent)).toEqual({
      apply: false,
      reason: "owned_by_app_store",
    });
    expect(decideEntitlementWrite({ source: "play" }, intent).apply).toBe(
      false,
    );
    expect(decideEntitlementWrite({ source: "founder" }, intent).apply).toBe(
      false,
    );
  });

  // ---- CROSS-RAIL DEAD-DOC HANDOFF (money-critical) --------------------------
  // A purchase on a NEW rail may ADOPT the doc ONLY when the other rail's doc is
  // dead: a final terminal revoke, OR an explicitly canceled/expired sub that no
  // longer grants access. This fixes the reported leak — an App Store sub lapses
  // (Apple status 2 → "canceled", terminal=FALSE) and the user re-subscribes via
  // Stripe: without adoption they are charged but never granted Pro. A LIVE
  // (active/grace) or reactivatable (on_hold) doc must STAY locked to its rail.
  it("lets Stripe ADOPT an EXPIRED app_store doc (Apple status 2 → canceled, non-terminal)", () => {
    const existing = {
      plan: "free",
      status: "canceled",
      source: "app_store",
      terminal: false, // Apple expiry is NOT terminal
      subId: "apple_orig_tx",
      eventCreated: 1000,
    };
    const d = decideEntitlementWrite(existing, intent); // stripe active@2000, sub_1
    expect(d.apply).toBe(true);
    if (!d.apply) throw new Error("unreachable");
    expect(d.fields.source).toBe("stripe");
    expect(derivePlan(d.fields)).toBe("pro");
    // subId MUST be re-scoped to the adopting rail's sub, else a later Stripe
    // cancel mis-scopes as terminal_other_sub and never revokes.
    expect(d.fields.subId).toBe("sub_1");
  });

  it("lets Stripe ADOPT a TERMINAL app_store doc (Apple revoked / refund)", () => {
    const existing = {
      plan: "free",
      status: "canceled",
      source: "app_store",
      terminal: true,
      subId: "apple_orig_tx",
      eventCreated: 1000,
    };
    expect(decideEntitlementWrite(existing, intent).apply).toBe(true);
  });

  it("does NOT let Stripe overwrite a LIVE (active) app_store doc", () => {
    const existing = {
      plan: "pro",
      status: "active",
      source: "app_store",
      subId: "apple_orig_tx",
      eventCreated: 1000,
    };
    expect(decideEntitlementWrite(existing, intent)).toEqual({
      apply: false,
      reason: "owned_by_app_store",
    });
  });

  it("does NOT let Stripe overwrite a GRACE app_store doc (dunning, still access)", () => {
    const existing = {
      plan: "pro",
      status: "grace",
      source: "app_store",
      eventCreated: 1000,
    };
    expect(decideEntitlementWrite(existing, intent).apply).toBe(false);
  });

  it("does NOT let Stripe overwrite an ON_HOLD app_store doc (its own rail may recover it)", () => {
    const existing = {
      plan: "pro",
      status: "on_hold",
      source: "app_store",
      eventCreated: 1000,
    };
    expect(decideEntitlementWrite(existing, intent)).toEqual({
      apply: false,
      reason: "owned_by_app_store",
    });
  });

  it("treats a MISSING status on a foreign doc as LIVE — not adoptable", () => {
    // derivePlan defaults a missing status to active; only an EXPLICIT
    // canceled/terminal doc is dead. A source-only doc must stay locked.
    expect(decideEntitlementWrite({ source: "app_store" }, intent)).toEqual({
      apply: false,
      reason: "owned_by_app_store",
    });
  });

  it("REGRESSION: after Stripe adopts an expired Apple doc, canceling the ADOPTING Stripe sub revokes", () => {
    // Proves the subId re-scope: without it, existingSubId(=stale apple) would
    // differ from the delete's sub and refuse as terminal_other_sub → leak.
    const expiredApple = {
      plan: "free",
      status: "canceled",
      source: "app_store",
      terminal: false,
      subId: "apple_orig_tx",
      eventCreated: 1000,
    };
    const adopt = decideEntitlementWrite(expiredApple, intent); // stripe sub_1 @2000
    expect(adopt.apply).toBe(true);
    if (!adopt.apply) throw new Error("unreachable");
    expect(adopt.fields.subId).toBe("sub_1");
    // The doc as it exists after the setDoc(merge).
    const adopted = { ...expiredApple, ...adopt.fields };
    const del: EntitlementIntent = {
      plan: "free",
      status: "canceled",
      eventId: "evt_del",
      eventCreated: 5000,
      terminal: true,
      stripeSubscriptionId: "sub_1",
    };
    const d = decideEntitlementWrite(adopted, del);
    expect(d.apply).toBe(true);
    if (!d.apply) throw new Error("unreachable");
    expect(derivePlan(d.fields)).toBe("free");
  });

  it("REGRESSION: adopt → cancel → re-subscribe(NEW sub) → cancel fully revokes (no stale subId leak)", () => {
    // The exact permanent house money leak the adversarial review reproduced.
    // With an adoption-ONLY subId re-scope, step 3 (re-subscribe to sub_2) would
    // update stripeSubscriptionId but leave subId pinned to sub_1, so step 4's
    // cancel of sub_2 would see existingSubId(=sub_1) !== intentSubId(=sub_2) and
    // refuse as terminal_other_sub — the user keeps Pro forever after cancelling
    // their only paying sub. The unconditional subId SYNC makes every apply track
    // the live sub, so the final cancel revokes.
    const expiredApple = {
      plan: "free",
      status: "canceled",
      source: "app_store",
      terminal: false,
      subId: "apple_orig_tx",
      eventCreated: 1000,
    };
    // 1. Stripe sub_1 adopts the dead Apple doc.
    const adopt = decideEntitlementWrite(expiredApple, intent); // sub_1 @2000
    if (!adopt.apply) throw new Error("unreachable");
    expect(adopt.fields.subId).toBe("sub_1");
    let doc: Record<string, unknown> = { ...expiredApple, ...adopt.fields };

    // 2. Cancel sub_1 → revoke.
    const cancel1: EntitlementIntent = {
      plan: "free",
      status: "canceled",
      eventId: "evt_del_1",
      eventCreated: 5000,
      terminal: true,
      stripeSubscriptionId: "sub_1",
    };
    const d1 = decideEntitlementWrite(doc, cancel1);
    if (!d1.apply) throw new Error("unreachable");
    expect(derivePlan(d1.fields)).toBe("free");
    doc = { ...doc, ...d1.fields };
    expect(doc.subId).toBe("sub_1"); // still tracks the cancelled sub

    // 3. Re-subscribe on Stripe with a NEW sub_2.
    const resub: EntitlementIntent = {
      plan: "pro",
      status: "active",
      eventId: "evt_2",
      eventCreated: 6000,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_2",
      currentPeriodEnd: 9999,
      priceId: "price_pro_m",
    };
    const d2 = decideEntitlementWrite(doc, resub);
    if (!d2.apply) throw new Error("unreachable");
    expect(derivePlan(d2.fields)).toBe("pro");
    doc = { ...doc, ...d2.fields };
    // The fix: subId now tracks the NEW sub, not the stale sub_1.
    expect(doc.subId).toBe("sub_2");
    expect(doc.stripeSubscriptionId).toBe("sub_2");

    // 4. Cancel sub_2 → MUST revoke (was refused as terminal_other_sub pre-fix).
    const cancel2: EntitlementIntent = {
      plan: "free",
      status: "canceled",
      eventId: "evt_del_2",
      eventCreated: 7000,
      terminal: true,
      stripeSubscriptionId: "sub_2",
    };
    const d3 = decideEntitlementWrite(doc, cancel2);
    expect(d3.apply).toBe(true); // NOT terminal_other_sub
    if (!d3.apply) throw new Error("unreachable");
    doc = { ...doc, ...d3.fields };
    expect(derivePlan(doc)).toBe("free");
  });

  it("Apple ADOPTING a dead Stripe doc is already subId-safe (IAP intents set subId)", () => {
    const deadStripe = {
      plan: "free",
      status: "canceled",
      source: "stripe",
      terminal: true,
      subId: "sub_old",
      stripeSubscriptionId: "sub_old",
      eventCreated: 1000,
    };
    const appleIntent: EntitlementIntent = {
      plan: "pro",
      status: "active",
      eventId: "evt_a",
      eventCreated: 2000,
      source: "app_store",
      subId: "apple_orig_tx",
      terminal: false,
    };
    const d = decideEntitlementWrite(deadStripe, appleIntent);
    expect(d.apply).toBe(true);
    if (!d.apply) throw new Error("unreachable");
    expect(d.fields.source).toBe("app_store");
    expect(d.fields.subId).toBe("apple_orig_tx");
  });

  it("mutates a stripe-owned or unclaimed (no source) doc", () => {
    expect(decideEntitlementWrite({ source: "stripe" }, intent).apply).toBe(
      true,
    );
    expect(decideEntitlementWrite({ plan: "free" }, intent).apply).toBe(true);
    expect(decideEntitlementWrite({}, intent).apply).toBe(true);
  });

  it("drops a stale event (out-of-order) — no resurrection", () => {
    const existing = { plan: "free", source: "stripe", eventCreated: 3000 };
    expect(decideEntitlementWrite(existing, intent)).toEqual({
      apply: false,
      reason: "stale_event",
    });
  });

  it("applies a strictly newer event over an existing stripe doc", () => {
    const existing = { plan: "pro", source: "stripe", eventCreated: 1000 };
    expect(decideEntitlementWrite(existing, intent).apply).toBe(true);
  });

  // Same-second tie-break: a higher-access status wins on an EXACT timestamp
  // tie so a payer is never stranded on free by two same-second sibling events.
  it("applies on a same-second tie when the incoming status grants MORE access", () => {
    // existing free/canceled from a created@incomplete at t=2000; incoming
    // active@pro at the same t=2000 (the intent fixture). Must upgrade to pro.
    const existing = {
      plan: "free",
      status: "canceled",
      source: "stripe",
      eventCreated: 2000,
    };
    const d = decideEntitlementWrite(existing, intent);
    expect(d.apply).toBe(true);
    if (!d.apply) throw new Error("unreachable");
    expect(derivePlan(d.fields)).toBe("pro");
  });

  it("drops a same-second tie when the incoming status grants EQUAL/LESS access", () => {
    // A same-second canceled must NOT override an existing active (no
    // same-second downgrade; a real revoke arrives as a strictly-newer event).
    const cancel: EntitlementIntent = {
      plan: "free",
      status: "canceled",
      eventId: "evt_c",
      eventCreated: 2000,
    };
    const existingActive = {
      plan: "pro",
      status: "active",
      source: "stripe",
      eventCreated: 2000,
    };
    expect(decideEntitlementWrite(existingActive, cancel)).toEqual({
      apply: false,
      reason: "stale_event",
    });
    // Equal status on a tie is also a no-op (idempotent re-delivery).
    expect(decideEntitlementWrite(existingActive, intent)).toEqual({
      apply: false,
      reason: "stale_event",
    });
  });

  it("never lets a strictly-OLDER higher-status event resurrect state", () => {
    // grantsHigher must NOT bypass the stale guard when the event is genuinely
    // older (only an exact-second tie is eligible for the status tie-break).
    const existing = {
      plan: "free",
      status: "canceled",
      source: "stripe",
      eventCreated: 3000,
    };
    expect(decideEntitlementWrite(existing, intent)).toEqual({
      apply: false,
      reason: "stale_event",
    });
  });

  // Terminal-revoke tie-break: a customer.subscription.deleted is final. It has no
  // live re-fetch and no follow-up event, and there is no reconcile job, so it must
  // win a same-second tie for its OWN subscription (otherwise a canceled user keeps
  // paid access forever) and, once recorded, must never be resurrected by a
  // same-second sibling.
  it("lets a TERMINAL delete win a same-second tie over an active grant (same sub)", () => {
    const existingActive = {
      plan: "pro",
      status: "active",
      source: "stripe",
      eventCreated: 2000,
      stripeSubscriptionId: "sub_1",
    };
    const del: EntitlementIntent = {
      plan: "free",
      status: "canceled",
      eventId: "evt_del",
      eventCreated: 2000,
      terminal: true,
      stripeSubscriptionId: "sub_1",
    };
    const d = decideEntitlementWrite(existingActive, del);
    expect(d.apply).toBe(true);
    if (!d.apply) throw new Error("unreachable");
    expect(derivePlan(d.fields)).toBe("free"); // revoked
    expect(d.fields.terminal).toBe(true);
  });

  it("never resurrects a TERMINAL state on a same-second active sibling", () => {
    // deleted@2000 already applied (terminal); a same-second updated@active@2000
    // (the intent fixture, sub_1) must NOT bring the canceled user back to pro.
    const existingTerminal = {
      plan: "free",
      status: "canceled",
      source: "stripe",
      eventCreated: 2000,
      terminal: true,
      stripeSubscriptionId: "sub_1",
    };
    expect(decideEntitlementWrite(existingTerminal, intent)).toEqual({
      apply: false,
      reason: "stale_event",
    });
  });

  it("ignores a same-second TERMINAL delete for a DIFFERENT subscription (swap safety)", () => {
    // Current doc tracks the NEW active sub_2; a same-second delete of the OLD
    // sub_1 must not revoke the new subscription. The cross-sub terminal guard
    // catches this before the tie-break (reason: terminal_other_sub).
    const existingNew = {
      plan: "pro",
      status: "active",
      source: "stripe",
      eventCreated: 2000,
      stripeSubscriptionId: "sub_2",
    };
    const delOld: EntitlementIntent = {
      plan: "free",
      status: "canceled",
      eventId: "evt_del_old",
      eventCreated: 2000,
      terminal: true,
      stripeSubscriptionId: "sub_1",
    };
    expect(decideEntitlementWrite(existingNew, delOld)).toEqual({
      apply: false,
      reason: "terminal_other_sub",
    });
  });

  it("lets a strictly-newer re-subscribe apply after a terminal delete and CLEARS terminal", () => {
    const existingTerminal = {
      plan: "free",
      status: "canceled",
      source: "stripe",
      eventCreated: 2000,
      terminal: true,
      stripeSubscriptionId: "sub_1",
    };
    const resub: EntitlementIntent = {
      plan: "pro",
      status: "active",
      eventId: "evt_resub",
      eventCreated: 5000,
      stripeSubscriptionId: "sub_9",
    };
    const d = decideEntitlementWrite(existingTerminal, resub);
    expect(d.apply).toBe(true);
    if (!d.apply) throw new Error("unreachable");
    expect(derivePlan(d.fields)).toBe("pro");
    expect(d.fields.terminal).toBe(false); // stale terminal marker cleared
  });

  it("drops a strictly-OLDER terminal delete (cannot revoke a newer subscription)", () => {
    // The cross-sub terminal guard fires regardless of age, so an OLD delete of
    // a DIFFERENT sub is rejected as terminal_other_sub (never revokes sub_2).
    const existingNew = {
      plan: "pro",
      status: "active",
      source: "stripe",
      eventCreated: 5000,
      stripeSubscriptionId: "sub_2",
    };
    const delOld: EntitlementIntent = {
      plan: "free",
      status: "canceled",
      eventId: "evt_del_old",
      eventCreated: 2000,
      terminal: true,
      stripeSubscriptionId: "sub_1",
    };
    expect(decideEntitlementWrite(existingNew, delOld)).toEqual({
      apply: false,
      reason: "terminal_other_sub",
    });
  });

  it("drops a strictly-NEWER terminal delete for a DIFFERENT subscription (no cross-sub revoke)", () => {
    // THE PREVIOUSLY-MISSING COVERAGE (audit Finding #2, HIGH). A delete of the
    // OLD sub_1 arriving STRICTLY LATER than the current doc's active sub_2 must
    // NOT fall through isEventNewer and unconditionally write plan:free — that
    // would revoke a DIFFERENT, currently-PAYING subscription (permanent money
    // leak, no reconcile job). The cross-sub terminal guard blocks it.
    const existingNew = {
      plan: "pro",
      status: "active",
      source: "stripe",
      eventCreated: 2000,
      stripeSubscriptionId: "sub_2",
    };
    const delOldNewer: EntitlementIntent = {
      plan: "free",
      status: "canceled",
      eventId: "evt_del_old_newer",
      eventCreated: 9000, // strictly newer than the active doc
      terminal: true,
      stripeSubscriptionId: "sub_1",
    };
    const d = decideEntitlementWrite(existingNew, delOldNewer);
    expect(d).toEqual({ apply: false, reason: "terminal_other_sub" });
    // And the paying subscription still derives pro (was NOT revoked).
    expect(derivePlan(existingNew)).toBe("pro");
  });

  it("still lets a strictly-newer terminal delete of the SAME sub revoke it", () => {
    // The cross-sub guard is scoped to DIFFERENT subs; the doc's own sub must
    // still be revocable by its terminal delete.
    const existingSame = {
      plan: "pro",
      status: "active",
      source: "stripe",
      eventCreated: 2000,
      stripeSubscriptionId: "sub_1",
    };
    const delSame: EntitlementIntent = {
      plan: "free",
      status: "canceled",
      eventId: "evt_del_same",
      eventCreated: 9000,
      terminal: true,
      stripeSubscriptionId: "sub_1",
    };
    const d = decideEntitlementWrite(existingSame, delSame);
    expect(d.apply).toBe(true);
    if (!d.apply) throw new Error("unreachable");
    expect(derivePlan(d.fields)).toBe("free");
    expect(d.fields.terminal).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Team per-seat + multi-rail field projection (monetization ②/③)
  // ---------------------------------------------------------------------
  it("projects seats + teamId for a Team subscription", () => {
    const teamIntent: EntitlementIntent = {
      plan: "team",
      status: "active",
      eventId: "evt_team",
      eventCreated: 3000,
      stripeSubscriptionId: "sub_team",
      seats: 5,
      teamId: "team_abc",
      priceId: "price_team_m",
    };
    const d = decideEntitlementWrite(null, teamIntent);
    expect(d.apply).toBe(true);
    if (!d.apply) throw new Error("unreachable");
    expect(d.fields.plan).toBe("team");
    expect(d.fields.seats).toBe(5);
    expect(d.fields.teamId).toBe("team_abc");
    expect(d.fields.source).toBe("stripe");
  });

  it("writes seats:0 explicitly (a canceled team must not merge-keep old seats)", () => {
    const cancel: EntitlementIntent = {
      plan: "free",
      status: "canceled",
      eventId: "evt_team_del",
      eventCreated: 4000,
      terminal: true,
      seats: 0,
      teamId: "team_abc",
    };
    const d = decideEntitlementWrite(
      { source: "stripe", eventCreated: 1, seats: 5 },
      cancel,
    );
    if (!d.apply) throw new Error("unreachable");
    expect(d.fields.seats).toBe(0); // seats != null → written even when 0
  });

  it("defaults source to stripe and mirrors subId from stripeSubscriptionId", () => {
    // A bare Stripe intent (no source, no explicit subId): source→stripe, and
    // subId is written = stripeSubscriptionId on EVERY apply so cross-sub terminal
    // scoping never goes stale after a re-subscribe (money-critical — see the
    // subId SYNC in billing.ts and the adopt→cancel→resubscribe→cancel regression).
    const d = decideEntitlementWrite(null, intent);
    if (!d.apply) throw new Error("unreachable");
    expect(d.fields.source).toBe("stripe");
    expect(d.fields.subId).toBe("sub_1");
    expect(d.fields.stripeSubscriptionId).toBe("sub_1");
  });

  it("projects an app_store rail intent with IAP audit metadata + productId", () => {
    const appleIntent: EntitlementIntent = {
      plan: "pro",
      status: "active",
      eventId: "apple_evt_1",
      eventCreated: 5000,
      source: "app_store",
      subId: "orig_txn_123",
      productId: "com.markflow.app.pro.monthly",
      appStoreOriginalTransactionId: "orig_txn_123",
      appStoreTransactionId: "txn_456",
      appAccountToken: "acct_tok",
      environment: "Production",
      currentPeriodEnd: 9999,
    };
    const d = decideEntitlementWrite(null, appleIntent);
    if (!d.apply) throw new Error("unreachable");
    expect(d.fields.source).toBe("app_store");
    expect(d.fields.subId).toBe("orig_txn_123");
    expect(d.fields.productId).toBe("com.markflow.app.pro.monthly");
    expect(d.fields.appStoreOriginalTransactionId).toBe("orig_txn_123");
    expect(d.fields.appStoreTransactionId).toBe("txn_456");
    expect(d.fields.appAccountToken).toBe("acct_tok");
    expect(d.fields.environment).toBe("Production");
    // Stripe-only fields are absent on an Apple intent.
    expect(d.fields.stripeSubscriptionId).toBeUndefined();
  });

  it("projects a play rail intent with Play audit metadata", () => {
    const playIntent: EntitlementIntent = {
      plan: "pro",
      status: "active",
      eventId: "play_evt_1",
      eventCreated: 6000,
      source: "play",
      subId: "purchase_tok_1",
      productId: "com.markflow.app.pro",
      playPurchaseToken: "purchase_tok_1",
      playOrderId: "GPA.1234",
      environment: "Production",
    };
    const d = decideEntitlementWrite(null, playIntent);
    if (!d.apply) throw new Error("unreachable");
    expect(d.fields.source).toBe("play");
    expect(d.fields.subId).toBe("purchase_tok_1");
    expect(d.fields.playPurchaseToken).toBe("purchase_tok_1");
    expect(d.fields.playOrderId).toBe("GPA.1234");
  });

  it("lets an app_store rail mutate its own app_store-owned doc", () => {
    const appleIntent: EntitlementIntent = {
      plan: "pro",
      status: "active",
      eventId: "apple_evt_2",
      eventCreated: 7000,
      source: "app_store",
      subId: "orig_txn_123",
    };
    const existing = {
      source: "app_store",
      subId: "orig_txn_123",
      eventCreated: 5000,
    };
    expect(decideEntitlementWrite(existing, appleIntent).apply).toBe(true);
  });

  it("refuses a Stripe intent against an app_store-owned doc (no cross-rail clobber)", () => {
    // The reverse of the existing owned_by test — a Stripe webhook must not
    // overwrite an Apple-funded entitlement (that would double-charge the user).
    expect(decideEntitlementWrite({ source: "app_store" }, intent)).toEqual({
      apply: false,
      reason: "owned_by_app_store",
    });
  });

  it("scopes a terminal revoke to the SAME rail's subId (Apple originalTransactionId)", () => {
    // An app_store terminal (expiration) for a DIFFERENT originalTransactionId
    // must not revoke the currently-active Apple subscription.
    const existingNew = {
      source: "app_store",
      plan: "pro",
      status: "active",
      eventCreated: 5000,
      subId: "orig_txn_new",
    };
    const delOld: EntitlementIntent = {
      plan: "free",
      status: "canceled",
      eventId: "apple_del_old",
      eventCreated: 9000,
      terminal: true,
      source: "app_store",
      subId: "orig_txn_old",
    };
    expect(decideEntitlementWrite(existingNew, delOld)).toEqual({
      apply: false,
      reason: "terminal_other_sub",
    });
  });

  it("omits optional fields that were not provided (partial intent)", () => {
    const minimal: EntitlementIntent = {
      plan: "free",
      status: "canceled",
      eventId: "evt_del",
      eventCreated: 5000,
    };
    const d = decideEntitlementWrite(
      { source: "stripe", eventCreated: 1 },
      minimal,
    );
    if (!d.apply) throw new Error("unreachable");
    expect(d.fields).toEqual({
      plan: "free",
      status: "canceled",
      source: "stripe",
      eventId: "evt_del",
      eventCreated: 5000,
      terminal: false,
    });
    // Crucially, status is ALWAYS present so derivePlan can't default-grant.
    expect(d.fields.status).toBe("canceled");
  });

  it("end-to-end: a cancel decision, fed to derivePlan, revokes access", () => {
    const cancel: EntitlementIntent = {
      plan: "free",
      status: "canceled",
      eventId: "evt_del",
      eventCreated: 5000,
    };
    const d = decideEntitlementWrite(
      { source: "stripe", eventCreated: 1 },
      cancel,
    );
    if (!d.apply) throw new Error("unreachable");
    expect(derivePlan(d.fields)).toBe("free");
  });
});

// =====================================================================
// decideSubscriptionApply — grant / revoke / skip decision from an
// authoritative Subscription's mapped status + mapped plan.
// =====================================================================
describe("decideSubscriptionApply", () => {
  it("preserves the doc on an UNKNOWN status (never downgrade a payer)", () => {
    // ourStatus === null (mapStripeStatus didn't recognize it) → skip, even if a
    // plan mapped. Preserving the existing entitlement is the safe choice.
    expect(decideSubscriptionApply(null, "pro")).toEqual({
      action: "skip_unknown_status",
    });
    expect(decideSubscriptionApply(null, null)).toEqual({
      action: "skip_unknown_status",
    });
  });

  it("grants the mapped plan for a recognized status + price", () => {
    expect(decideSubscriptionApply("active", "pro")).toEqual({
      action: "grant",
      plan: "pro",
    });
    expect(decideSubscriptionApply("grace", "team")).toEqual({
      action: "grant",
      plan: "team",
    });
    // A recognized plan is granted even on on_hold/canceled — derivePlan then
    // revokes ACCESS from the status while retaining the plan for reactivation.
    expect(decideSubscriptionApply("on_hold", "pro")).toEqual({
      action: "grant",
      plan: "pro",
    });
  });

  it("REVOKES to free on an unmapped price when the event revokes access", () => {
    // Fail SAFE: a price rotated out of env must not let a non-payer keep access.
    expect(decideSubscriptionApply("on_hold", null)).toEqual({
      action: "revoke_unmapped",
    });
    expect(decideSubscriptionApply("canceled", null)).toEqual({
      action: "revoke_unmapped",
    });
  });

  it("SKIPS granting on an unmapped price when the event would grant access", () => {
    // Fail CLOSED: never grant a plan for a price we can't recognize.
    expect(decideSubscriptionApply("active", null)).toEqual({
      action: "skip_unmapped_grant",
    });
    expect(decideSubscriptionApply("grace", null)).toEqual({
      action: "skip_unmapped_grant",
    });
  });
});

// =====================================================================
// pickUid — uid resolution priority
// =====================================================================
describe("pickUid", () => {
  it("returns the first non-empty candidate", () => {
    expect(pickUid([undefined, "", "  ", "uid_2", "uid_3"])).toBe("uid_2");
    expect(pickUid(["uid_1"])).toBe("uid_1");
    expect(pickUid([" uid_x "])).toBe("uid_x");
  });
  it("returns null when nothing resolves", () => {
    expect(pickUid([])).toBeNull();
    expect(pickUid([undefined, "", null, 123])).toBeNull();
  });
});

// =====================================================================
// toEpochSeconds
// =====================================================================
describe("toEpochSeconds", () => {
  it("passes through a positive integer", () => {
    expect(toEpochSeconds(1787200000)).toBe(1787200000);
  });
  it("floors a float", () => {
    expect(toEpochSeconds(1000.9)).toBe(1000);
  });
  it("returns 0 for NaN/negatives/absent", () => {
    expect(toEpochSeconds(undefined)).toBe(0);
    expect(toEpochSeconds(null)).toBe(0);
    expect(toEpochSeconds("garbage")).toBe(0);
    expect(toEpochSeconds(-5)).toBe(0);
  });
});

// =====================================================================
// clampSeats — validate/clamp a client-requested seat count
// =====================================================================
describe("clampSeats", () => {
  const MAX = 100;

  it("returns 1 for any non-team plan (no seat concept)", () => {
    expect(clampSeats(5, "pro", MAX)).toBe(1);
    expect(clampSeats(99, "free", MAX)).toBe(1);
    expect(clampSeats(3, "internal", MAX)).toBe(1);
    // even a garbage seat value is irrelevant for non-team.
    expect(clampSeats("garbage", "pro", MAX)).toBe(1);
  });

  it("accepts a valid team seat count within [1, max]", () => {
    expect(clampSeats(1, "team", MAX)).toBe(1);
    expect(clampSeats(5, "team", MAX)).toBe(5);
    expect(clampSeats(100, "team", MAX)).toBe(100);
  });

  it("normalizes plan casing/whitespace", () => {
    expect(clampSeats(3, " Team ", MAX)).toBe(3);
    expect(clampSeats(3, "TEAM", MAX)).toBe(3);
  });

  it("REJECTS (null) an out-of-range/invalid team seat count — fail loud", () => {
    expect(clampSeats(0, "team", MAX)).toBeNull(); // a 0-seat paid sub
    expect(clampSeats(-1, "team", MAX)).toBeNull();
    expect(clampSeats(101, "team", MAX)).toBeNull(); // over cap
    expect(clampSeats(2.5, "team", MAX)).toBeNull(); // fractional
    expect(clampSeats("5.5", "team", MAX)).toBeNull(); // fractional string
    expect(clampSeats("abc", "team", MAX)).toBeNull(); // non-numeric string
    expect(clampSeats(NaN, "team", MAX)).toBeNull();
    expect(clampSeats(undefined, "team", MAX)).toBeNull();
    expect(clampSeats(null, "team", MAX)).toBeNull();
  });

  it("leniently coerces a whole numeric string (seats is payment-self-limiting)", () => {
    // seats flows to Stripe checkout quantity — the user pays per seat, so a
    // coercible "5" is honored rather than rejected; only truly-invalid values do.
    expect(clampSeats("5", "team", MAX)).toBe(5);
  });
});

// =====================================================================
// decideTeamBillingWrite — teams/{teamId}.billing monotonic + terminal
// =====================================================================
describe("decideTeamBillingWrite", () => {
  const intent: TeamBillingIntent = {
    status: "active",
    seats: 5,
    ownerUid: "owner_1",
    eventId: "evt_1",
    eventCreated: 2000,
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: "sub_team_1",
    stripeSubscriptionItemId: "si_1",
    currentPeriodEnd: 9999,
    priceId: "price_team_m",
  };

  it("applies to a fresh (null) doc and projects team billing fields", () => {
    const d = decideTeamBillingWrite(null, intent);
    expect(d.apply).toBe(true);
    if (!d.apply) throw new Error("unreachable");
    expect(d.fields).toEqual({
      plan: "team",
      status: "active",
      seats: 5,
      ownerUid: "owner_1",
      eventId: "evt_1",
      eventCreated: 2000,
      terminal: false,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_team_1",
      stripeSubscriptionItemId: "si_1",
      currentPeriodEnd: 9999,
      priceId: "price_team_m",
    });
  });

  it("drops a stale (older) event — no seat/plan resurrection", () => {
    const existing = { eventCreated: 3000, stripeSubscriptionId: "sub_team_1" };
    expect(decideTeamBillingWrite(existing, intent)).toEqual({
      apply: false,
      reason: "stale_event",
    });
  });

  it("applies a strictly-newer seat change over the existing billing doc", () => {
    const existing = {
      status: "active",
      eventCreated: 1000,
      stripeSubscriptionId: "sub_team_1",
    };
    const bump: TeamBillingIntent = { ...intent, seats: 8, eventCreated: 5000 };
    const d = decideTeamBillingWrite(existing, bump);
    if (!d.apply) throw new Error("unreachable");
    expect(d.fields.seats).toBe(8);
  });

  it("lets a TERMINAL delete win a same-second tie for its own sub (seats:0)", () => {
    const existingActive = {
      status: "active",
      eventCreated: 2000,
      stripeSubscriptionId: "sub_team_1",
    };
    const del: TeamBillingIntent = {
      status: "canceled",
      seats: 0,
      ownerUid: "owner_1",
      eventId: "evt_del",
      eventCreated: 2000,
      terminal: true,
      stripeSubscriptionId: "sub_team_1",
    };
    const d = decideTeamBillingWrite(existingActive, del);
    if (!d.apply) throw new Error("unreachable");
    expect(d.fields.status).toBe("canceled");
    expect(d.fields.seats).toBe(0);
    expect(d.fields.terminal).toBe(true);
  });

  it("never resurrects a terminal team billing doc on a same-second sibling", () => {
    const existingTerminal = {
      status: "canceled",
      eventCreated: 2000,
      terminal: true,
      stripeSubscriptionId: "sub_team_1",
    };
    expect(decideTeamBillingWrite(existingTerminal, intent)).toEqual({
      apply: false,
      reason: "stale_event",
    });
  });

  it("scopes a terminal revoke to the tracked sub (swap safety)", () => {
    const existingNew = {
      status: "active",
      eventCreated: 2000,
      stripeSubscriptionId: "sub_team_2",
    };
    const delOld: TeamBillingIntent = {
      status: "canceled",
      seats: 0,
      ownerUid: "owner_1",
      eventId: "evt_del_old",
      eventCreated: 9000, // strictly newer, but a DIFFERENT sub
      terminal: true,
      stripeSubscriptionId: "sub_team_1",
    };
    expect(decideTeamBillingWrite(existingNew, delOld)).toEqual({
      apply: false,
      reason: "terminal_other_sub",
    });
  });

  it("still revokes the tracked sub on its own strictly-newer terminal delete", () => {
    const existingSame = {
      status: "active",
      eventCreated: 2000,
      stripeSubscriptionId: "sub_team_1",
    };
    const delSame: TeamBillingIntent = {
      status: "canceled",
      seats: 0,
      ownerUid: "owner_1",
      eventId: "evt_del_same",
      eventCreated: 9000,
      terminal: true,
      stripeSubscriptionId: "sub_team_1",
    };
    const d = decideTeamBillingWrite(existingSame, delSame);
    if (!d.apply) throw new Error("unreachable");
    expect(d.fields.status).toBe("canceled");
    expect(d.fields.terminal).toBe(true);
  });

  it("omits optional stripe fields that were not provided (partial intent)", () => {
    const minimal: TeamBillingIntent = {
      status: "canceled",
      seats: 0,
      ownerUid: "owner_1",
      eventId: "evt_del",
      eventCreated: 5000,
    };
    const d = decideTeamBillingWrite({ eventCreated: 1 }, minimal);
    if (!d.apply) throw new Error("unreachable");
    expect(d.fields).toEqual({
      plan: "team",
      status: "canceled",
      seats: 0,
      ownerUid: "owner_1",
      eventId: "evt_del",
      eventCreated: 5000,
      terminal: false,
    });
  });
});
