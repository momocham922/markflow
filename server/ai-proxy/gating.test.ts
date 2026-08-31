import { describe, it, expect } from "vitest";
import {
  PLAN_LIMITS,
  ALL_PLANS,
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
  deriveSeatAccess,
  type Plan,
  type Feature,
} from "./gating";

const FEATURES: Feature[] = ["aiCalls", "sttCalls", "batchMin", "images"];
const METERED_PLANS: Array<Exclude<Plan, "internal">> = ["free", "pro", "team"];

// =====================================================================
// PLAN_LIMITS shape — the launch placeholders, locked so a stray edit is caught
// =====================================================================
describe("PLAN_LIMITS", () => {
  it("defines every metered feature for free/pro/team", () => {
    for (const plan of METERED_PLANS) {
      for (const f of FEATURES) {
        expect(typeof PLAN_LIMITS[plan][f]).toBe("number");
        expect(PLAN_LIMITS[plan][f]).toBeGreaterThan(0);
      }
    }
  });

  it("is monotonic: free ≤ pro ≤ team for every feature", () => {
    for (const f of FEATURES) {
      expect(PLAN_LIMITS.free[f]).toBeLessThanOrEqual(PLAN_LIMITS.pro[f]);
      expect(PLAN_LIMITS.pro[f]).toBeLessThanOrEqual(PLAN_LIMITS.team[f]);
    }
  });

  it("matches the documented launch values", () => {
    expect(PLAN_LIMITS.free).toEqual({
      aiCalls: 30,
      sttCalls: 100,
      batchMin: 60,
      images: 2,
    });
    expect(PLAN_LIMITS.pro).toEqual({
      aiCalls: 2000,
      sttCalls: 6000,
      batchMin: 3000,
      images: 500,
    });
    expect(PLAN_LIMITS.team).toEqual({
      aiCalls: 4000,
      sttCalls: 12000,
      batchMin: 6000,
      images: 1000,
    });
  });
});

// =====================================================================
// checkQuota — the per-plan × per-feature × boundary matrix (the heart)
// =====================================================================
describe("checkQuota", () => {
  it("internal is always unlimited, never blocked, for every feature", () => {
    for (const f of FEATURES) {
      const r = checkQuota("internal", f, 1e9, 1e9);
      expect(r).toEqual({ unlimited: true, limit: -1, blocked: false });
    }
  });

  describe.each(METERED_PLANS)("plan=%s", (plan) => {
    it.each(FEATURES)("allows usage strictly under the limit (%s)", (f) => {
      const limit = PLAN_LIMITS[plan][f];
      const r = checkQuota(plan, f, limit - 1, 1);
      expect(r.blocked).toBe(false);
      expect(r.unlimited).toBe(false);
      expect(r.limit).toBe(limit);
    });

    it.each(FEATURES)(
      "allows the exact final unit (used+cost==limit) (%s)",
      (f) => {
        const limit = PLAN_LIMITS[plan][f];
        expect(checkQuota(plan, f, limit - 1, 1).blocked).toBe(false);
        expect(checkQuota(plan, f, 0, limit).blocked).toBe(false);
      },
    );

    it.each(FEATURES)(
      "blocks when used+cost exceeds the limit by one (%s)",
      (f) => {
        const limit = PLAN_LIMITS[plan][f];
        expect(checkQuota(plan, f, limit, 1).blocked).toBe(true);
        expect(checkQuota(plan, f, limit - 1, 2).blocked).toBe(true);
      },
    );

    it.each(FEATURES)(
      "blocks a multi-unit cost that would straddle the limit (%s)",
      (f) => {
        const limit = PLAN_LIMITS[plan][f];
        // 5 units when only 3 remain → blocked; 3 units when 3 remain → allowed.
        expect(checkQuota(plan, f, limit - 3, 5).blocked).toBe(true);
        expect(checkQuota(plan, f, limit - 3, 3).blocked).toBe(false);
      },
    );
  });

  it("free is the strictest tier and blocks where pro/team still pass", () => {
    // 30 aiCalls used: free blocked, pro/team fine.
    expect(checkQuota("free", "aiCalls", 30, 1).blocked).toBe(true);
    expect(checkQuota("pro", "aiCalls", 30, 1).blocked).toBe(false);
    expect(checkQuota("team", "aiCalls", 30, 1).blocked).toBe(false);
  });
});

// =====================================================================
// checkQuota × seats — the Team shared-pool multiplier
// =====================================================================
describe("checkQuota (team seat scaling)", () => {
  it("scales the team limit by seat count for every feature", () => {
    for (const f of FEATURES) {
      const base = PLAN_LIMITS.team[f];
      // 3 seats → 3× base ceiling.
      const r = checkQuota("team", f, base * 3 - 1, 1, 3);
      expect(r.limit).toBe(base * 3);
      expect(r.blocked).toBe(false);
      // one past the scaled ceiling blocks.
      expect(checkQuota("team", f, base * 3, 1, 3).blocked).toBe(true);
    }
  });

  it("defaults to 1 seat when omitted (backward-compatible)", () => {
    const base = PLAN_LIMITS.team.aiCalls;
    expect(checkQuota("team", "aiCalls", base - 1, 1).limit).toBe(base);
    expect(checkQuota("team", "aiCalls", base, 1).blocked).toBe(true);
  });

  it("clamps a malformed 0/negative/fractional seat count to ≥1 seat", () => {
    const base = PLAN_LIMITS.team.aiCalls;
    // A 0-seat or negative seat count must never zero out or invert the pool.
    expect(checkQuota("team", "aiCalls", 0, 1, 0).limit).toBe(base);
    expect(checkQuota("team", "aiCalls", 0, 1, -5).limit).toBe(base);
    // Fractional seats floor (2.9 → 2 seats).
    expect(checkQuota("team", "aiCalls", 0, 1, 2.9).limit).toBe(base * 2);
  });

  it("does NOT scale non-team plans by seats (pro is always a 1-seat pool)", () => {
    const base = PLAN_LIMITS.pro.aiCalls;
    // Even if a seats value leaks in, pro's ceiling is unchanged.
    expect(checkQuota("pro", "aiCalls", 0, 1, 10).limit).toBe(base);
    expect(checkQuota("free", "aiCalls", 0, 1, 10).limit).toBe(
      PLAN_LIMITS.free.aiCalls,
    );
    // internal stays unlimited regardless of seats.
    expect(checkQuota("internal", "aiCalls", 0, 1, 10)).toEqual({
      unlimited: true,
      limit: -1,
      blocked: false,
    });
  });
});

// =====================================================================
// deriveSeatAccess — a Team member's paid+assigned seat gate
// =====================================================================
describe("deriveSeatAccess", () => {
  const billing = (status: string, seats: number) => ({ status, seats });

  it("grants access to an assigned member of an active team within capacity", () => {
    const r = deriveSeatAccess(billing("active", 3), ["a", "b", "c"], "b");
    expect(r).toEqual({ access: true, reason: "ok" });
  });

  it("honors grace status as paid", () => {
    expect(deriveSeatAccess(billing("grace", 2), ["a", "b"], "a").access).toBe(
      true,
    );
  });

  it("denies when the team subscription is not active/grace", () => {
    for (const s of ["canceled", "past_due", "expired", "on_hold", ""]) {
      const r = deriveSeatAccess(billing(s, 5), ["a", "b"], "a");
      expect(r.access).toBe(false);
      expect(r.reason).toBe("not_active");
    }
  });

  it("denies a uid that is not in the assignment list", () => {
    const r = deriveSeatAccess(billing("active", 3), ["a", "b"], "z");
    expect(r).toEqual({ access: false, reason: "not_assigned" });
  });

  it("denies an over-capacity assignee (assignment order is the fence)", () => {
    // 2 paid seats but 3 assigned → the 3rd (index 2) falls off the end.
    const r = deriveSeatAccess(billing("active", 2), ["a", "b", "c"], "c");
    expect(r).toEqual({ access: false, reason: "over_capacity" });
    // the first two keep access.
    expect(
      deriveSeatAccess(billing("active", 2), ["a", "b", "c"], "a").access,
    ).toBe(true);
    expect(
      deriveSeatAccess(billing("active", 2), ["a", "b", "c"], "b").access,
    ).toBe(true);
  });

  it("normalizes status casing/whitespace", () => {
    expect(
      deriveSeatAccess({ status: " ACTIVE ", seats: 1 }, ["a"], "a").access,
    ).toBe(true);
  });

  it("treats a malformed seat count as ≥1 seat (never zero-capacity)", () => {
    // seats:0 must not silently lock out the first assignee.
    expect(
      deriveSeatAccess({ status: "active", seats: 0 }, ["a"], "a").access,
    ).toBe(true);
    expect(
      deriveSeatAccess({ status: "active", seats: NaN }, ["a"], "a").access,
    ).toBe(true);
  });

  it("denies on null/undefined billing or assignments", () => {
    expect(deriveSeatAccess(null, ["a"], "a").reason).toBe("not_active");
    expect(deriveSeatAccess(billing("active", 3), null, "a").reason).toBe(
      "not_assigned",
    );
    expect(deriveSeatAccess(billing("active", 3), undefined, "a").reason).toBe(
      "not_assigned",
    );
  });
});

// =====================================================================
// isChargeable — who actually consumes quota (drives refund/reconcile)
// =====================================================================
describe("isChargeable", () => {
  it("internal never charges (metering bypass)", () => {
    for (const f of FEATURES) expect(isChargeable("internal", f)).toBe(false);
  });
  it("free/pro/team charge every metered feature", () => {
    for (const plan of METERED_PLANS)
      for (const f of FEATURES) expect(isChargeable(plan, f)).toBe(true);
  });
});

// =====================================================================
// isAutoResearchAllowed — §1.3 capability gate (Free is manual-only)
// =====================================================================
describe("isAutoResearchAllowed", () => {
  it("blocks automatic live research on free (manual-only tier)", () => {
    expect(isAutoResearchAllowed("free")).toBe(false);
  });
  it("allows automatic live research on pro/team/internal", () => {
    expect(isAutoResearchAllowed("pro")).toBe(true);
    expect(isAutoResearchAllowed("team")).toBe(true);
    expect(isAutoResearchAllowed("internal")).toBe(true);
  });
});

// =====================================================================
// derivePlan — entitlement doc → real plan
// =====================================================================
describe("derivePlan", () => {
  it("defaults to free for null/undefined/empty docs", () => {
    expect(derivePlan(null)).toBe("free");
    expect(derivePlan(undefined)).toBe("free");
    expect(derivePlan({})).toBe("free");
  });

  it("grants pro/team only for active or grace status", () => {
    expect(derivePlan({ plan: "pro", status: "active" })).toBe("pro");
    expect(derivePlan({ plan: "pro", status: "grace" })).toBe("pro");
    expect(derivePlan({ plan: "team", status: "active" })).toBe("team");
    expect(derivePlan({ plan: "team", status: "grace" })).toBe("team");
  });

  it("downgrades paid plans to free when status is not active/grace", () => {
    expect(derivePlan({ plan: "pro", status: "canceled" })).toBe("free");
    expect(derivePlan({ plan: "pro", status: "past_due" })).toBe("free");
    expect(derivePlan({ plan: "team", status: "expired" })).toBe("free");
  });

  it("defaults missing status to active (paid docs are seeded active)", () => {
    expect(derivePlan({ plan: "pro" })).toBe("pro");
  });

  it("treats internal as internal regardless of status (admin-seeded)", () => {
    expect(derivePlan({ plan: "internal" })).toBe("internal");
    expect(derivePlan({ plan: "internal", status: "canceled" })).toBe(
      "internal",
    );
  });

  it("falls back to free for unknown plan values", () => {
    expect(derivePlan({ plan: "enterprise", status: "active" })).toBe("free");
    expect(derivePlan({ plan: 123 })).toBe("free");
  });

  // Hardening against a Stripe webhook (or hand-edited doc) writing raw values
  // with different casing / whitespace — must never silently downgrade a payer.
  it("normalizes casing on plan and status", () => {
    expect(derivePlan({ plan: "PRO", status: "ACTIVE" })).toBe("pro");
    expect(derivePlan({ plan: "Team", status: "Grace" })).toBe("team");
    expect(derivePlan({ plan: "Internal" })).toBe("internal");
  });

  it("trims surrounding whitespace on plan and status", () => {
    expect(derivePlan({ plan: " pro ", status: " active " })).toBe("pro");
    expect(derivePlan({ plan: "\tteam\n", status: "grace" })).toBe("team");
  });

  it("honors Stripe 'trialing' status as paid (never downgrades a trial)", () => {
    expect(derivePlan({ plan: "pro", status: "trialing" })).toBe("pro");
    expect(derivePlan({ plan: "team", status: "TRIALING" })).toBe("team");
    expect(derivePlan({ plan: "pro", status: " trialing " })).toBe("pro");
  });

  it("still downgrades genuinely inactive statuses after normalization", () => {
    expect(derivePlan({ plan: "PRO", status: "PAST_DUE" })).toBe("free");
    expect(derivePlan({ plan: " team ", status: " canceled " })).toBe("free");
  });
});

// =====================================================================
// reconcileBatchDelta — measured-minus-reserve counter correction
// =====================================================================
describe("reconcileBatchDelta", () => {
  it("charges the difference when the client under-reserved", () => {
    // reserved 1 min (client claimed durationSec:0), measured 50 → +49.
    expect(reconcileBatchDelta(50, 1)).toBe(49);
  });

  it("refunds the difference when the client over-reserved", () => {
    expect(reconcileBatchDelta(30, 45)).toBe(-15);
  });

  it("is zero when the reserve was exact", () => {
    expect(reconcileBatchDelta(60, 60)).toBe(0);
  });
});

// =====================================================================
// shouldRefund — refund a reserved cost only when truly uncommitted
// =====================================================================
describe("shouldRefund", () => {
  it("refunds a charged, uncommitted reservation", () => {
    expect(shouldRefund({ ok: true, charged: true }, false)).toBe(true);
  });

  it("never refunds once committed (the upstream cost was incurred)", () => {
    expect(shouldRefund({ ok: true, charged: true }, true)).toBe(false);
  });

  it("never refunds an uncharged guard (internal/unlimited/fail-open)", () => {
    // charged:false → the increment was never persisted, so a refund would
    // wrongly credit the counter below zero.
    expect(shouldRefund({ ok: true, charged: false }, false)).toBe(false);
    expect(shouldRefund({ ok: true }, false)).toBe(false);
  });

  it("never refunds a failed/absent guard result", () => {
    expect(shouldRefund({ ok: false }, false)).toBe(false);
    expect(shouldRefund(null, false)).toBe(false);
    expect(shouldRefund(undefined, false)).toBe(false);
  });
});

// =====================================================================
// resolveViewAs — owner-only X-View-As; never an escalation for others
// =====================================================================
describe("resolveViewAs", () => {
  const owners = new Set(["owner1", "owner2"]);

  it("honors a valid metered plan header for an owner", () => {
    expect(resolveViewAs("free", "owner1", owners)).toBe("free");
    expect(resolveViewAs("pro", "owner1", owners)).toBe("pro");
    expect(resolveViewAs("team", "owner2", owners)).toBe("team");
  });

  it("REFUSES X-View-As:internal even for an owner (no header-escalation)", () => {
    // SECURITY (audit Finding #12): "internal" is unlimited/unmetered. If an
    // owner whose real entitlement is free/pro could set X-View-As:internal they
    // would escalate to unmetered access via a header. Only free/pro/team are
    // previewable (VIEW_AS_PLANS); internal is rejected → null (real plan used).
    expect(resolveViewAs("internal", "owner1", owners)).toBeNull();
    expect(resolveViewAs(" Internal ", "owner1", owners)).toBeNull();
  });

  it("ignores the header entirely for non-owners (no escalation)", () => {
    expect(resolveViewAs("team", "randomUser", owners)).toBeNull();
    expect(resolveViewAs("internal", "randomUser", owners)).toBeNull();
  });

  it("returns null for empty/absent/whitespace headers", () => {
    expect(resolveViewAs(undefined, "owner1", owners)).toBeNull();
    expect(resolveViewAs("", "owner1", owners)).toBeNull();
    expect(resolveViewAs("   ", "owner1", owners)).toBeNull();
  });

  it("returns null for an unknown plan name even for an owner", () => {
    expect(resolveViewAs("enterprise", "owner1", owners)).toBeNull();
    expect(resolveViewAs("admin", "owner1", owners)).toBeNull();
  });

  it("uses the first value when the header arrives as an array, trimmed", () => {
    expect(resolveViewAs(["pro", "team"], "owner1", owners)).toBe("pro");
    expect(resolveViewAs(" pro ", "owner1", owners)).toBe("pro");
  });
});

// =====================================================================
// periodKey — Asia/Tokyo month boundary (NOT UTC)
// =====================================================================
describe("periodKey (Asia/Tokyo)", () => {
  it("uses JST for a normal mid-month instant", () => {
    expect(periodKey(new Date("2026-08-18T05:00:00Z"))).toBe("2026-08");
  });

  it("rolls to the next month across the JST midnight boundary", () => {
    // 2026-01-31T15:30Z == 2026-02-01T00:30 JST → February, not January.
    expect(periodKey(new Date("2026-01-31T15:30:00Z"))).toBe("2026-02");
    // Just before the JST boundary stays in January.
    expect(periodKey(new Date("2026-01-31T14:30:00Z"))).toBe("2026-01");
  });

  it("rolls the year across the Dec→Jan JST boundary", () => {
    expect(periodKey(new Date("2026-12-31T20:00:00Z"))).toBe("2027-01");
  });

  it("zero-pads single-digit months", () => {
    expect(periodKey(new Date("2026-03-05T00:00:00Z"))).toBe("2026-03");
  });
});

// =====================================================================
// parseOffset — STT duration string parsing
// =====================================================================
describe("parseOffset", () => {
  it("parses a seconds string", () => {
    expect(parseOffset("1.200s")).toBeCloseTo(1.2);
    expect(parseOffset("90s")).toBe(90);
  });
  it("accepts a raw number", () => {
    expect(parseOffset(45)).toBe(45);
  });
  it("returns 0 for null/undefined/garbage", () => {
    expect(parseOffset(null)).toBe(0);
    expect(parseOffset(undefined)).toBe(0);
    expect(parseOffset("abc")).toBe(0);
  });
});

// =====================================================================
// clampBatchReserveMinutes — untrusted client pre-flight reserve
// =====================================================================
describe("clampBatchReserveMinutes", () => {
  it("ceils total seconds to minutes", () => {
    expect(clampBatchReserveMinutes([{ durationSec: 90 }])).toBe(2);
    expect(clampBatchReserveMinutes([{ durationSec: 60 }])).toBe(1);
    expect(clampBatchReserveMinutes([{ durationSec: 61 }])).toBe(2);
  });

  it("sums across chunks", () => {
    expect(
      clampBatchReserveMinutes([{ durationSec: 3300 }, { durationSec: 2100 }]),
    ).toBe(90);
  });

  it("floors at 1 even for zero/absent durations", () => {
    expect(clampBatchReserveMinutes([{ durationSec: 0 }])).toBe(1);
    expect(clampBatchReserveMinutes([{}])).toBe(1);
    expect(clampBatchReserveMinutes([{ durationSec: 0 }, {}])).toBe(1);
  });

  it("clamps negative durations to zero (never a negative reserve)", () => {
    expect(clampBatchReserveMinutes([{ durationSec: -9999 }])).toBe(1);
    expect(
      clampBatchReserveMinutes([{ durationSec: -100 }, { durationSec: 120 }]),
    ).toBe(2);
  });
});

// =====================================================================
// measuredBatchMinutes — server-measured authoritative charge
// =====================================================================
describe("measuredBatchMinutes", () => {
  const chunkFromEndOffset = (sec: number) => [
    { alternatives: [{ words: [{ endOffset: `${sec}s` }] }] },
  ];

  it("measures a single chunk from the last word endOffset", () => {
    expect(measuredBatchMinutes([chunkFromEndOffset(90)], 20)).toBe(2);
    expect(measuredBatchMinutes([chunkFromEndOffset(60)], 20)).toBe(1);
  });

  it("subtracts the overlap once per boundary for multi-chunk audio", () => {
    // 55min + 35min chunks, 20s overlap → 90min-20s → ceil = 90.
    const r = measuredBatchMinutes(
      [chunkFromEndOffset(3300), chunkFromEndOffset(2100)],
      20,
    );
    expect(r).toBe(90);
  });

  it("returns 0 for empty transcription (no words)", () => {
    expect(measuredBatchMinutes([[]], 20)).toBe(0);
    expect(measuredBatchMinutes([[{ alternatives: [{}] }]], 20)).toBe(0);
  });

  it("falls back to resultEndOffset when word offsets are absent", () => {
    const chunk = [{ resultEndOffset: "120s", alternatives: [{}] }];
    expect(measuredBatchMinutes([chunk], 20)).toBe(2);
  });

  it("takes the maximum offset within a chunk (not the sum of words)", () => {
    const chunk = [
      {
        alternatives: [
          {
            words: [
              { endOffset: "10s" },
              { endOffset: "50s" },
              { endOffset: "30s" },
            ],
          },
        ],
      },
    ];
    expect(measuredBatchMinutes([chunk], 20)).toBe(1); // max 50s → 1 min
  });

  it("is the untrusted-client defense: measured is independent of any claim", () => {
    // A client could claim durationSec:0 (reserve 1), but a real 50-min file
    // measures to 50 → the counter is corrected upward regardless of the claim.
    const fiftyMin = chunkFromEndOffset(3000);
    expect(measuredBatchMinutes([fiftyMin], 20)).toBe(50);
  });
});

// =====================================================================
// misc pure helpers
// =====================================================================
describe("parseUidSet", () => {
  it("splits, trims, and drops empties", () => {
    expect([...parseUidSet("a, b ,,c")]).toEqual(["a", "b", "c"]);
    expect([...parseUidSet("")]).toEqual([]);
    expect([...parseUidSet(undefined)]).toEqual([]);
  });
});

describe("ALL_PLANS", () => {
  it("contains exactly the four plans", () => {
    expect([...ALL_PLANS].sort()).toEqual(["free", "internal", "pro", "team"]);
  });
});
