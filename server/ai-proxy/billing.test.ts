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
  type EntitlementIntent,
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
