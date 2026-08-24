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
  appleFactsFromDecoded,
  playFactsFromPurchaseV2,
  parseRtdnEnvelope,
  buildPlayVoidIntent,
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

// =====================================================================
// Pure adapters: store-SDK decoded shapes → Facts → Intent → gate.
// =====================================================================
describe("appleFactsFromDecoded", () => {
  // A verified JWSTransactionDecodedPayload (subset of the real shape). The
  // numeric subscription status is NOT in the txn — it comes from the caller.
  const TXN = {
    productId: "com.markflow.app.pro.monthly",
    transactionId: "2000000999",
    originalTransactionId: "2000000111",
    appAccountToken: "5b1f0c7e-0000-4000-8000-000000000001",
    environment: "Production",
    purchaseDate: 1_787_000_000_000,
    expiresDate: 1_789_000_000_000,
    signedDate: 1_787_000_500_000,
    bundleId: "com.markflow.app",
    type: "Auto-Renewable Subscription",
  };

  it("extracts every AppleFacts field from a decoded transaction", () => {
    const f = appleFactsFromDecoded(TXN, { status: 1 });
    expect(f.productId).toBe("com.markflow.app.pro.monthly");
    expect(f.status).toBe(1);
    expect(f.environment).toBe("Production");
    expect(f.originalTransactionId).toBe("2000000111");
    expect(f.transactionId).toBe("2000000999");
    expect(f.appAccountToken).toBe("5b1f0c7e-0000-4000-8000-000000000001");
    expect(f.expiresDateMs).toBe(1_789_000_000_000);
    expect(f.signedDateMs).toBe(1_787_000_500_000);
    // eventId defaults to the transactionId on the /iap/verify path.
    expect(f.eventId).toBe("2000000999");
  });

  it("eventId override wins (ASSN notificationUUID path)", () => {
    const f = appleFactsFromDecoded(TXN, { status: 1, eventId: "uuid-abc" });
    expect(f.eventId).toBe("uuid-abc");
  });

  it("end-to-end: decoded active txn → pro grant", () => {
    const f = appleFactsFromDecoded(TXN, { status: 1 });
    const r = buildAppleIntent(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.plan).toBe("pro");
    expect(r.intent.status).toBe("active");
    expect(r.intent.source).toBe("app_store");
    expect(r.intent.subId).toBe("2000000111");
    const d = decideEntitlementWrite(null, r.intent);
    expect(d.apply).toBe(true);
    if (d.apply) expect(derivePlan(d.fields)).toBe("pro");
  });

  it("end-to-end: revoked (5) txn is terminal → canceled to free", () => {
    const f = appleFactsFromDecoded(TXN, { status: 5 });
    const r = buildAppleIntent(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.status).toBe("canceled");
    expect(r.intent.terminal).toBe(true);
    expect(r.intent.plan).toBe("pro"); // plan echo; gate uses canceled status
  });
});

describe("playFactsFromPurchaseV2", () => {
  // A verified SubscriptionPurchaseV2 (subset). productId + expiryTime are under
  // lineItems[]; the hashed uid is externalAccountIdentifiers.
  const PURCHASE = {
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    linkedPurchaseToken: null,
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    startTime: "2026-08-24T10:00:00Z",
    externalAccountIdentifiers: { obfuscatedExternalAccountId: "hash-uid-xyz" },
    lineItems: [
      {
        productId: "com.markflow.app.pro",
        expiryTime: "2026-09-24T10:00:00Z",
        latestSuccessfulOrderId: "GPA.1111-2222-3333-44444",
      },
    ],
  };

  it("extracts PlayFacts from lineItems + external account id", () => {
    const f = playFactsFromPurchaseV2(PURCHASE, {
      purchaseToken: "tok-123",
      eventTimeMs: 1_787_000_000_000,
    });
    expect(f.productId).toBe("com.markflow.app.pro");
    expect(f.subscriptionState).toBe("SUBSCRIPTION_STATE_ACTIVE");
    expect(f.purchaseToken).toBe("tok-123");
    expect(f.orderId).toBe("GPA.1111-2222-3333-44444");
    expect(f.externalAccountId).toBe("hash-uid-xyz");
    expect(f.expiryTimeMs).toBe(Date.parse("2026-09-24T10:00:00Z"));
    expect(f.eventTimeMs).toBe(1_787_000_000_000);
    expect(f.eventId).toBe("tok-123");
  });

  it("falls back to startTime for eventTimeMs and ctx.productId when no lineItems", () => {
    const f = playFactsFromPurchaseV2(
      {
        subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
        startTime: "2026-08-24T10:00:00Z",
      },
      {
        purchaseToken: "tok-9",
        productId: "com.markflow.app.team",
        eventId: "msg-1",
      },
    );
    expect(f.productId).toBe("com.markflow.app.team");
    expect(f.eventTimeMs).toBe(Date.parse("2026-08-24T10:00:00Z"));
    expect(f.eventId).toBe("msg-1");
  });

  it("end-to-end: active purchase → pro grant", () => {
    const f = playFactsFromPurchaseV2(PURCHASE, {
      purchaseToken: "tok-123",
      eventTimeMs: 1_787_000_000_000,
    });
    const r = buildPlayIntent(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.plan).toBe("pro");
    expect(r.intent.status).toBe("active");
    expect(r.intent.source).toBe("play");
    expect(r.intent.subId).toBe("tok-123");
    const d = decideEntitlementWrite(null, r.intent);
    expect(d.apply).toBe(true);
    if (d.apply) expect(derivePlan(d.fields)).toBe("pro");
  });
});

describe("parseRtdnEnvelope", () => {
  function envelope(obj: unknown, messageId = "msg-42"): string {
    const data = Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
    return JSON.stringify({
      message: { data, messageId },
      subscription: "projects/markflow-app-2026/subscriptions/rtdn",
    });
  }

  it("parses a subscription notification", () => {
    const body = envelope({
      version: "1.0",
      packageName: "com.markflow.editor",
      eventTimeMillis: 1_787_000_000_000,
      subscriptionNotification: {
        version: "1.0",
        notificationType: 4,
        purchaseToken: "tok-abc",
        subscriptionId: "com.markflow.app.pro",
      },
    });
    const p = parseRtdnEnvelope(body);
    expect(p).not.toBeNull();
    expect(p!.messageId).toBe("msg-42");
    expect(p!.packageName).toBe("com.markflow.editor");
    expect(p!.eventTimeMs).toBe(1_787_000_000_000);
    expect(p!.subscription).toEqual({
      notificationType: 4,
      purchaseToken: "tok-abc",
      subscriptionId: "com.markflow.app.pro",
    });
    expect(p!.voided).toBeUndefined();
    expect(p!.test).toBe(false);
  });

  it("parses a voided (refund) notification", () => {
    const body = envelope({
      packageName: "com.markflow.editor",
      eventTimeMillis: 1_787_000_000_000,
      voidedPurchaseNotification: {
        purchaseToken: "tok-void",
        orderId: "GPA.void",
        productType: 1,
        refundType: 1,
      },
    });
    const p = parseRtdnEnvelope(body);
    expect(p!.voided).toEqual({
      purchaseToken: "tok-void",
      orderId: "GPA.void",
      productType: 1,
      refundType: 1,
    });
    expect(p!.subscription).toBeUndefined();
  });

  it("flags a test notification", () => {
    const body = envelope({
      packageName: "com.markflow.editor",
      testNotification: { version: "1.0" },
    });
    expect(parseRtdnEnvelope(body)!.test).toBe(true);
  });

  it("returns null for malformed envelopes (no redelivery)", () => {
    expect(parseRtdnEnvelope("not json")).toBeNull();
    expect(parseRtdnEnvelope(JSON.stringify({ message: {} }))).toBeNull(); // no data
    expect(
      parseRtdnEnvelope(JSON.stringify({ message: { data: "x" } })),
    ).toBeNull(); // no messageId
    expect(
      parseRtdnEnvelope(
        JSON.stringify({
          message: { data: "!!!notbase64json", messageId: "m" },
        }),
      ),
    ).toBeNull(); // undecodable data
  });
});

describe("buildPlayVoidIntent", () => {
  it("builds a terminal canceled revoke for the token", () => {
    const r = buildPlayVoidIntent("tok-void", "msg-9", 1_787_000_000_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.plan).toBe("free");
    expect(r.intent.status).toBe("canceled");
    expect(r.intent.terminal).toBe(true);
    expect(r.intent.source).toBe("play");
    expect(r.intent.subId).toBe("tok-void");
    expect(r.intent.eventCreated).toBe(Math.floor(1_787_000_000_000 / 1000));
  });

  it("missing token → not ok", () => {
    expect(buildPlayVoidIntent("", "e", 1)).toEqual({
      ok: false,
      reason: "missing_purchase_token",
    });
  });

  it("a void terminal-revokes an active play doc for the same token", () => {
    const active = buildPlayIntent({
      productId: "com.markflow.app.pro",
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      purchaseToken: "tok-same",
      eventTimeMs: 1_787_000_000_000,
      eventId: "e1",
    } as PlayFacts);
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    const d1 = decideEntitlementWrite(null, active.intent);
    expect(d1.apply).toBe(true);
    if (!d1.apply) return;
    const voidR = buildPlayVoidIntent("tok-same", "e2", 1_787_000_100_000);
    expect(voidR.ok).toBe(true);
    if (!voidR.ok) return;
    const d2 = decideEntitlementWrite(d1.fields, voidR.intent);
    expect(d2.apply).toBe(true);
    if (d2.apply) expect(derivePlan(d2.fields)).toBe("free");
  });
});
