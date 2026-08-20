import { describe, it, expect } from "vitest";
import {
  APPLE_PRODUCTS,
  PLAY_PRODUCTS,
  mapAppleProductToPlan,
  mapPlayProductToPlan,
  mapAppleSubStatus,
  mapPlayState,
  isProdEnvironment,
  buildAppleIntent,
  buildPlayIntent,
  type AppleFacts,
  type PlayFacts,
} from "./iap";
import { decideEntitlementWrite } from "./billing";
import { derivePlan } from "./gating";

// =====================================================================
// Product → plan maps. The end-to-end assertion is that a mapped product,
// carried through an intent + decideEntitlementWrite + derivePlan, grants the
// right plan.
// =====================================================================
describe("mapAppleProductToPlan", () => {
  it("maps every configured Apple product to its plan", () => {
    expect(mapAppleProductToPlan("com.markflow.app.pro.monthly")).toBe("pro");
    expect(mapAppleProductToPlan("com.markflow.app.pro.yearly")).toBe("pro");
    expect(mapAppleProductToPlan("com.markflow.app.team.monthly")).toBe("team");
    expect(mapAppleProductToPlan("com.markflow.app.team.yearly")).toBe("team");
  });
  it("returns null for an unknown product (fail closed)", () => {
    expect(mapAppleProductToPlan("com.markflow.app.enterprise")).toBeNull();
    expect(mapAppleProductToPlan("")).toBeNull();
    expect(mapAppleProductToPlan(undefined)).toBeNull();
  });
  it("catalog is internally consistent (interval present for each)", () => {
    for (const [id, v] of Object.entries(APPLE_PRODUCTS)) {
      expect(id.startsWith("com.markflow.app.")).toBe(true);
      expect(["pro", "team"]).toContain(v.plan);
      expect(["month", "year"]).toContain(v.interval);
    }
  });
});

describe("mapPlayProductToPlan", () => {
  it("maps configured Play products to their plan", () => {
    expect(mapPlayProductToPlan("com.markflow.app.pro")).toBe("pro");
    expect(mapPlayProductToPlan("com.markflow.app.team")).toBe("team");
  });
  it("returns null for an unknown product", () => {
    expect(mapPlayProductToPlan("com.markflow.app.other")).toBeNull();
    expect(mapPlayProductToPlan(undefined)).toBeNull();
  });
  it("catalog only grants pro/team", () => {
    for (const v of Object.values(PLAY_PRODUCTS))
      expect(["pro", "team"]).toContain(v);
  });
});

// =====================================================================
// Status maps. Each result is asserted through derivePlan so the grant/revoke
// semantics are pinned end-to-end.
// =====================================================================
describe("mapAppleSubStatus", () => {
  it("1 active → active (grants)", () => {
    expect(mapAppleSubStatus(1)).toBe("active");
    expect(derivePlan({ plan: "pro", status: mapAppleSubStatus(1) })).toBe(
      "pro",
    );
  });
  it("4 billing grace → grace (access preserved)", () => {
    expect(mapAppleSubStatus(4)).toBe("grace");
    expect(derivePlan({ plan: "pro", status: mapAppleSubStatus(4) })).toBe(
      "pro",
    );
  });
  it("3 billing retry → on_hold (revokes)", () => {
    expect(mapAppleSubStatus(3)).toBe("on_hold");
    expect(derivePlan({ plan: "pro", status: mapAppleSubStatus(3) })).toBe(
      "free",
    );
  });
  it("2 expired / 5 revoked → canceled (revokes)", () => {
    expect(mapAppleSubStatus(2)).toBe("canceled");
    expect(mapAppleSubStatus(5)).toBe("canceled");
    expect(derivePlan({ plan: "pro", status: mapAppleSubStatus(2) })).toBe(
      "free",
    );
  });
  it("unknown status → null (preserve, no silent downgrade)", () => {
    expect(mapAppleSubStatus(99)).toBeNull();
    expect(mapAppleSubStatus("x")).toBeNull();
    expect(mapAppleSubStatus(undefined)).toBeNull();
  });
});

describe("mapPlayState", () => {
  it("ACTIVE → active", () => {
    expect(mapPlayState("SUBSCRIPTION_STATE_ACTIVE")).toBe("active");
  });
  it("IN_GRACE_PERIOD → grace", () => {
    expect(mapPlayState("SUBSCRIPTION_STATE_IN_GRACE_PERIOD")).toBe("grace");
  });
  it("ON_HOLD / PAUSED → on_hold (revokes)", () => {
    expect(mapPlayState("SUBSCRIPTION_STATE_ON_HOLD")).toBe("on_hold");
    expect(mapPlayState("SUBSCRIPTION_STATE_PAUSED")).toBe("on_hold");
  });
  it("CANCELED → active (access until expiry)", () => {
    // Auto-renew off but still entitled — a later EXPIRED revokes.
    expect(mapPlayState("SUBSCRIPTION_STATE_CANCELED")).toBe("active");
    expect(
      derivePlan({
        plan: "team",
        status: mapPlayState("SUBSCRIPTION_STATE_CANCELED"),
      }),
    ).toBe("team");
  });
  it("EXPIRED → canceled (revokes)", () => {
    expect(mapPlayState("SUBSCRIPTION_STATE_EXPIRED")).toBe("canceled");
    expect(
      derivePlan({
        plan: "team",
        status: mapPlayState("SUBSCRIPTION_STATE_EXPIRED"),
      }),
    ).toBe("free");
  });
  it("case/whitespace tolerant", () => {
    expect(mapPlayState(" subscription_state_active ")).toBe("active");
  });
  it("unknown/pending state → null (preserve)", () => {
    expect(mapPlayState("SUBSCRIPTION_STATE_PENDING")).toBeNull();
    expect(mapPlayState("")).toBeNull();
    expect(mapPlayState(undefined)).toBeNull();
  });
});

describe("isProdEnvironment", () => {
  it("only 'Production' (case-insensitive) is production", () => {
    expect(isProdEnvironment("Production")).toBe(true);
    expect(isProdEnvironment(" production ")).toBe(true);
    expect(isProdEnvironment("Sandbox")).toBe(false);
    expect(isProdEnvironment("")).toBe(false);
    expect(isProdEnvironment(undefined)).toBe(false);
  });
});

// =====================================================================
// buildAppleIntent — verified facts → EntitlementIntent, applied through the
// SAME decideEntitlementWrite pipeline Stripe uses.
// =====================================================================
const APPLE_BASE: AppleFacts = {
  productId: "com.markflow.app.pro.monthly",
  status: 1,
  environment: "Production",
  originalTransactionId: "orig_100",
  transactionId: "tx_101",
  appAccountToken: "uid_alice",
  expiresDateMs: 2_000_000_000_000,
  signedDateMs: 1_700_000_000_000,
  eventId: "notif_1",
};

describe("buildAppleIntent", () => {
  it("grants pro on an active recognized product; carries source+subId+audit", () => {
    const r = buildAppleIntent(APPLE_BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.uid).toBe("uid_alice");
    expect(r.intent.plan).toBe("pro");
    expect(r.intent.status).toBe("active");
    expect(r.intent.source).toBe("app_store");
    expect(r.intent.subId).toBe("orig_100");
    expect(r.intent.seats).toBe(1);
    expect(r.intent.appStoreOriginalTransactionId).toBe("orig_100");
    expect(r.intent.appStoreTransactionId).toBe("tx_101");
    expect(r.intent.appAccountToken).toBe("uid_alice");
    // eventCreated/currentPeriodEnd converted ms → sec.
    expect(r.intent.eventCreated).toBe(1_700_000_000);
    expect(r.intent.currentPeriodEnd).toBe(2_000_000_000);
    expect(r.intent.terminal).toBe(false);
  });

  it("grants team as a FLAT 1-seat plan (no teamId)", () => {
    const r = buildAppleIntent({
      ...APPLE_BASE,
      productId: "com.markflow.app.team.yearly",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.plan).toBe("team");
    expect(r.intent.seats).toBe(1);
    expect(r.intent.teamId).toBeUndefined();
  });

  it("unknown status → not ok (index.ts preserves the doc)", () => {
    const r = buildAppleIntent({ ...APPLE_BASE, status: 99 });
    expect(r).toEqual({ ok: false, reason: "unknown_status" });
  });

  it("unmapped product on a GRANTING status → fail closed", () => {
    const r = buildAppleIntent({
      ...APPLE_BASE,
      productId: "com.markflow.app.unknown",
      status: 1,
    });
    expect(r).toEqual({ ok: false, reason: "unmapped_product" });
  });

  it("unmapped product on a REVOKING status → fail SAFE (revoke to free)", () => {
    const r = buildAppleIntent({
      ...APPLE_BASE,
      productId: "com.markflow.app.unknown",
      status: 2, // expired
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.plan).toBe("free");
    expect(r.intent.status).toBe("canceled");
  });

  it("REVOKE (status 5) is terminal; expiry (2) is not", () => {
    const revoked = buildAppleIntent({ ...APPLE_BASE, status: 5 });
    const expired = buildAppleIntent({ ...APPLE_BASE, status: 2 });
    expect(revoked.ok && revoked.intent.terminal).toBe(true);
    expect(expired.ok && expired.intent.terminal).toBe(false);
  });

  it("missing originalTransactionId → not ok", () => {
    const r = buildAppleIntent({ ...APPLE_BASE, originalTransactionId: "" });
    expect(r).toEqual({ ok: false, reason: "missing_original_tx" });
  });

  it("end-to-end: intent grants access, then Stripe cannot overwrite it", () => {
    const r = buildAppleIntent(APPLE_BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d1 = decideEntitlementWrite(null, r.intent);
    expect(d1.apply).toBe(true);
    if (!d1.apply) return;
    expect(derivePlan(d1.fields)).toBe("pro");
    expect(d1.fields.source).toBe("app_store");
    // A later Stripe event must NOT overwrite an app_store-owned doc.
    const stripeD = decideEntitlementWrite(d1.fields, {
      plan: "pro",
      status: "active",
      eventId: "evt_s",
      eventCreated: 1_800_000_000,
      source: "stripe",
      stripeSubscriptionId: "sub_x",
    });
    expect(stripeD).toEqual({ apply: false, reason: "owned_by_app_store" });
  });
});

// =====================================================================
// buildPlayIntent
// =====================================================================
const PLAY_BASE: PlayFacts = {
  productId: "com.markflow.app.pro",
  subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
  purchaseToken: "tok_abc",
  linkedPurchaseToken: "tok_old",
  orderId: "GPA.1234",
  externalAccountId: "uid_bob",
  expiryTimeMs: 2_000_000_000_000,
  eventTimeMs: 1_700_000_000_000,
  eventId: "msg_1",
};

describe("buildPlayIntent", () => {
  it("grants pro; carries source=play + subId=purchaseToken + audit", () => {
    const r = buildPlayIntent(PLAY_BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.uid).toBe("uid_bob");
    expect(r.intent.plan).toBe("pro");
    expect(r.intent.status).toBe("active");
    expect(r.intent.source).toBe("play");
    expect(r.intent.subId).toBe("tok_abc");
    expect(r.intent.playPurchaseToken).toBe("tok_abc");
    expect(r.intent.playLinkedPurchaseToken).toBe("tok_old");
    expect(r.intent.playOrderId).toBe("GPA.1234");
    expect(r.intent.seats).toBe(1);
    expect(r.intent.eventCreated).toBe(1_700_000_000);
    expect(r.intent.currentPeriodEnd).toBe(2_000_000_000);
    expect(r.intent.terminal).toBe(false);
  });

  it("CANCELED still grants (access until expiry, not terminal)", () => {
    const r = buildPlayIntent({
      ...PLAY_BASE,
      subscriptionState: "SUBSCRIPTION_STATE_CANCELED",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.status).toBe("active");
    expect(r.intent.terminal).toBe(false);
    expect(derivePlan(r.intent as never)).toBe("pro");
  });

  it("EXPIRED revokes and is terminal", () => {
    const r = buildPlayIntent({
      ...PLAY_BASE,
      subscriptionState: "SUBSCRIPTION_STATE_EXPIRED",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.status).toBe("canceled");
    expect(r.intent.terminal).toBe(true);
  });

  it("unknown state → not ok", () => {
    const r = buildPlayIntent({
      ...PLAY_BASE,
      subscriptionState: "SUBSCRIPTION_STATE_PENDING",
    });
    expect(r).toEqual({ ok: false, reason: "unknown_state" });
  });

  it("unmapped product on granting state → fail closed; on revoking → fail safe", () => {
    const closed = buildPlayIntent({
      ...PLAY_BASE,
      productId: "com.markflow.app.other",
    });
    expect(closed).toEqual({ ok: false, reason: "unmapped_product" });
    const safe = buildPlayIntent({
      ...PLAY_BASE,
      productId: "com.markflow.app.other",
      subscriptionState: "SUBSCRIPTION_STATE_EXPIRED",
    });
    expect(safe.ok).toBe(true);
    if (!safe.ok) return;
    expect(safe.intent.plan).toBe("free");
  });

  it("missing purchaseToken → not ok", () => {
    const r = buildPlayIntent({ ...PLAY_BASE, purchaseToken: "" });
    expect(r).toEqual({ ok: false, reason: "missing_purchase_token" });
  });

  it("play doc cannot be overwritten by stripe (cross-rail)", () => {
    const r = buildPlayIntent(PLAY_BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d1 = decideEntitlementWrite(null, r.intent);
    expect(d1.apply).toBe(true);
    if (!d1.apply) return;
    const stripeD = decideEntitlementWrite(d1.fields, {
      plan: "team",
      status: "active",
      eventId: "e",
      eventCreated: 1_900_000_000,
      source: "stripe",
    });
    expect(stripeD).toEqual({ apply: false, reason: "owned_by_play" });
  });
});
