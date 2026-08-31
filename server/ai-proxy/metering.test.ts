import { describe, it, expect } from "vitest";
import {
  reserveUsage,
  adjustUsage,
  decideBatchLease,
  acquireBatchLease,
  releaseBatchLease,
  type MeteringStore,
  type UsageDoc,
  type UsageTxn,
  type BatchLockDoc,
  type ServerValues,
} from "./metering";
import { reconcileBatchDelta, PLAN_LIMITS } from "./gating";

// =====================================================================
// Integration tests for the reserve → reconcile/refund metering path against a
// FakeFirestore that interprets the increment/serverTimestamp sentinels exactly
// as Firestore's FieldValue does. This is the double-charge–critical layer:
// index.ts's guard/adjustUsage/refund all funnel through reserveUsage/adjustUsage
// here, so these tests are the regression net for "a blocked request is never
// charged", "a refund never over-credits", and "an unlimited plan is never
// metered". The pure decisions (checkQuota/reconcileBatchDelta) are covered in
// gating.test.ts; here we verify the WIRING to reads/writes.
// =====================================================================

const YM = "2026-08";
const APPLIED_TS = "__applied_ts__";

// The injected server-value factory. Returns tagged sentinels the FakeStore
// resolves at write time — mirroring FieldValue.increment / serverTimestamp.
const sv: ServerValues = {
  increment: (n) => ({ __inc: n }),
  serverTimestamp: () => ({ __ts: true }),
};

function isInc(v: unknown): v is { __inc: number } {
  return typeof v === "object" && v !== null && "__inc" in v;
}
function isTs(v: unknown): boolean {
  return typeof v === "object" && v !== null && "__ts" in v;
}

class FakeStore implements MeteringStore {
  docs = new Map<string, Record<string, unknown>>();
  /** batchLocks/{uid} lease docs. */
  locks = new Map<string, Record<string, unknown>>();
  /** How many times a document write actually hit the store. */
  writeCount = 0;
  /** How many transactions were opened. */
  txnCount = 0;
  private failTxn = false;

  /** Make the next runTransaction throw (simulate a Firestore outage). */
  failNextTransaction(): void {
    this.failTxn = true;
  }

  seed(uid: string, data: Record<string, unknown>): void {
    this.docs.set(`${uid}/${YM}`, { ...data });
  }
  peek(uid: string): Record<string, unknown> | undefined {
    return this.docs.get(`${uid}/${YM}`);
  }

  private write(key: string, data: Record<string, unknown>): void {
    this.writeCount++;
    const cur = this.docs.get(key) ?? {};
    for (const [k, v] of Object.entries(data)) {
      if (isInc(v)) cur[k] = (Number(cur[k]) || 0) + v.__inc;
      else if (isTs(v)) cur[k] = APPLIED_TS;
      else cur[k] = v;
    }
    this.docs.set(key, cur);
  }

  usageDoc(uid: string, ym: string): UsageDoc {
    const key = `${uid}/${ym}`;
    const store = this;
    return {
      async get() {
        const d = store.docs.get(key);
        return { exists: d !== undefined, data: () => d };
      },
      async set(data) {
        store.write(key, data);
      },
    };
  }

  batchLockDoc(uid: string): BatchLockDoc {
    const key = uid;
    const store = this;
    return {
      async get() {
        const d = store.locks.get(key);
        return { exists: d !== undefined, data: () => d };
      },
      async set(data) {
        const cur = store.locks.get(key) ?? {};
        for (const [k, v] of Object.entries(data)) {
          if (isTs(v)) cur[k] = APPLIED_TS;
          else cur[k] = v;
        }
        store.locks.set(key, cur);
      },
      async delete() {
        store.locks.delete(key);
      },
    };
  }

  async runTransaction<T>(fn: (tx: UsageTxn) => Promise<T>): Promise<T> {
    this.txnCount++;
    if (this.failTxn) {
      this.failTxn = false;
      throw new Error("firestore unavailable");
    }
    const tx: UsageTxn = {
      get: (ref) => ref.get(),
      // Real Firestore's tx.set is synchronous (stages the write); the fake
      // applies it synchronously too (ref.set's body runs before its first await).
      set: (ref, data, opts) => {
        void ref.set(data, opts);
      },
    };
    return fn(tx);
  }
}

describe("reserveUsage", () => {
  it("reserves a cost on a fresh (absent) doc: not blocked, counter incremented", async () => {
    const store = new FakeStore();
    const r = await reserveUsage(store, sv, "u1", "aiCalls", 1, "free", YM);
    expect(r).toEqual({ blocked: false, used: 0 });
    const doc = store.peek("u1")!;
    expect(doc.aiCalls).toBe(1);
    expect(doc.plan).toBe("free");
    expect(doc.period).toBe(YM);
    expect(doc.updatedAt).toBe(APPLIED_TS);
    expect(store.writeCount).toBe(1);
  });

  it("accumulates across sequential reserves", async () => {
    const store = new FakeStore();
    await reserveUsage(store, sv, "u1", "aiCalls", 5, "free", YM);
    const r = await reserveUsage(store, sv, "u1", "aiCalls", 3, "free", YM);
    expect(r).toEqual({ blocked: false, used: 5 }); // `used` is pre-increment
    expect(store.peek("u1")!.aiCalls).toBe(8);
  });

  it("allows the exact final unit (used+cost == limit)", async () => {
    const store = new FakeStore();
    const limit = PLAN_LIMITS.free.aiCalls; // 30
    store.seed("u1", { aiCalls: limit - 1 });
    const r = await reserveUsage(store, sv, "u1", "aiCalls", 1, "free", YM);
    expect(r.blocked).toBe(false);
    expect(store.peek("u1")!.aiCalls).toBe(limit);
  });

  it("BLOCKS when the cost would exceed the limit AND writes nothing", async () => {
    const store = new FakeStore();
    const limit = PLAN_LIMITS.free.aiCalls; // 30
    store.seed("u1", { aiCalls: limit });
    store.writeCount = 0; // ignore the seed
    const r = await reserveUsage(store, sv, "u1", "aiCalls", 1, "free", YM);
    expect(r).toEqual({ blocked: true, used: limit });
    // The critical invariant: a blocked request never charges quota.
    expect(store.peek("u1")!.aiCalls).toBe(limit);
    expect(store.writeCount).toBe(0);
  });

  it("blocks a multi-unit cost that straddles the limit without partial charge", async () => {
    const store = new FakeStore();
    const limit = PLAN_LIMITS.free.batchMin; // 60
    store.seed("u1", { batchMin: limit - 3 });
    store.writeCount = 0;
    const r = await reserveUsage(store, sv, "u1", "batchMin", 5, "free", YM);
    expect(r.blocked).toBe(true);
    expect(store.peek("u1")!.batchMin).toBe(limit - 3); // unchanged, no partial
    expect(store.writeCount).toBe(0);
  });

  it("never meters an unlimited (internal) plan: not blocked, no write, no doc", async () => {
    const store = new FakeStore();
    const r = await reserveUsage(
      store,
      sv,
      "u1",
      "aiCalls",
      1e9,
      "internal",
      YM,
    );
    expect(r).toEqual({ blocked: false, used: 0 });
    expect(store.peek("u1")).toBeUndefined(); // never touched Firestore
    expect(store.writeCount).toBe(0);
  });

  it("still opens a transaction for unlimited plans (read-then-decide), but writes nothing", async () => {
    const store = new FakeStore();
    await reserveUsage(store, sv, "u1", "aiCalls", 1, "internal", YM);
    expect(store.txnCount).toBe(1);
    expect(store.writeCount).toBe(0);
  });

  it("propagates a store/transaction error (caller decides fail-open)", async () => {
    const store = new FakeStore();
    store.failNextTransaction();
    await expect(
      reserveUsage(store, sv, "u1", "aiCalls", 1, "free", YM),
    ).rejects.toThrow("firestore unavailable");
    expect(store.peek("u1")).toBeUndefined();
  });

  it("treats a corrupt (non-numeric) stored counter as 0", async () => {
    const store = new FakeStore();
    store.seed("u1", { aiCalls: "garbage" });
    const r = await reserveUsage(store, sv, "u1", "aiCalls", 1, "free", YM);
    expect(r.used).toBe(0);
    expect(store.peek("u1")!.aiCalls).toBe(1); // NaN treated as 0, then +1
  });
});

// =====================================================================
// Team shared pool: meter under a SINGLE teamId key with a seat-scaled ceiling.
// =====================================================================
describe("reserveUsage (team shared pool + seats)", () => {
  it("scales the team ceiling by seat count", async () => {
    const store = new FakeStore();
    const base = PLAN_LIMITS.team.aiCalls; // 4000
    // 3 seats → ceiling 3×base. Seed one below the SCALED ceiling: allowed.
    store.seed("team_x", { aiCalls: base * 3 - 1 });
    const r = await reserveUsage(
      store,
      sv,
      "team_x",
      "aiCalls",
      1,
      "team",
      YM,
      3,
    );
    expect(r.blocked).toBe(false);
    expect(store.peek("team_x")!.aiCalls).toBe(base * 3);
  });

  it("BLOCKS once the seat-scaled ceiling is exceeded (no charge)", async () => {
    const store = new FakeStore();
    const base = PLAN_LIMITS.team.aiCalls;
    store.seed("team_x", { aiCalls: base * 3 });
    store.writeCount = 0;
    const r = await reserveUsage(
      store,
      sv,
      "team_x",
      "aiCalls",
      1,
      "team",
      YM,
      3,
    );
    expect(r).toEqual({ blocked: true, used: base * 3 });
    expect(store.writeCount).toBe(0);
  });

  it("shares ONE pool across members metered under the same teamId key", async () => {
    const store = new FakeStore();
    // Two distinct users, but index.ts meters both under the teamId key.
    await reserveUsage(store, sv, "team_x", "aiCalls", 10, "team", YM, 5);
    const r = await reserveUsage(
      store,
      sv,
      "team_x",
      "aiCalls",
      7,
      "team",
      YM,
      5,
    );
    // Second member sees the first member's usage (shared counter).
    expect(r.used).toBe(10);
    expect(store.peek("team_x")!.aiCalls).toBe(17);
  });

  it("defaults to 1 seat when omitted — regression for pro/free (unchanged)", async () => {
    const store = new FakeStore();
    const proLimit = PLAN_LIMITS.pro.aiCalls;
    store.seed("u_pro", { aiCalls: proLimit - 1 });
    const ok = await reserveUsage(store, sv, "u_pro", "aiCalls", 1, "pro", YM);
    expect(ok.blocked).toBe(false);
    store.seed("u_pro2", { aiCalls: proLimit });
    const blocked = await reserveUsage(
      store,
      sv,
      "u_pro2",
      "aiCalls",
      1,
      "pro",
      YM,
    );
    expect(blocked.blocked).toBe(true);
  });

  it("clamps a malformed 0 seat count to a 1-seat team pool (never zero-capacity)", async () => {
    const store = new FakeStore();
    const base = PLAN_LIMITS.team.aiCalls;
    store.seed("team_x", { aiCalls: base - 1 });
    const r = await reserveUsage(
      store,
      sv,
      "team_x",
      "aiCalls",
      1,
      "team",
      YM,
      0,
    );
    expect(r.blocked).toBe(false); // 0 seats → clamped to 1×base, last unit allowed
    expect(store.peek("team_x")!.aiCalls).toBe(base);
  });
});

describe("adjustUsage", () => {
  it("applies a positive delta (charge the reconciled difference)", async () => {
    const store = new FakeStore();
    store.seed("u1", { batchMin: 1 });
    await adjustUsage(store, sv, "u1", "batchMin", 49, "free", YM);
    expect(store.peek("u1")!.batchMin).toBe(50);
    expect(store.peek("u1")!.updatedAt).toBe(APPLIED_TS);
  });

  it("applies a negative delta (refund)", async () => {
    const store = new FakeStore();
    store.seed("u1", { aiCalls: 5 });
    await adjustUsage(store, sv, "u1", "aiCalls", -1, "free", YM);
    expect(store.peek("u1")!.aiCalls).toBe(4);
  });

  it("is a no-op for delta 0 (no write at all)", async () => {
    const store = new FakeStore();
    store.seed("u1", { aiCalls: 5 });
    store.writeCount = 0;
    await adjustUsage(store, sv, "u1", "aiCalls", 0, "free", YM);
    expect(store.writeCount).toBe(0);
    expect(store.peek("u1")!.aiCalls).toBe(5);
  });
});

// =====================================================================
// End-to-end reserve → reconcile/refund flows (the actual index.ts sequences)
// =====================================================================
describe("reserve → reconcile/refund flows", () => {
  it("reconciles a batch reserve UP when the client under-reported duration", async () => {
    const store = new FakeStore();
    // Client claimed durationSec:0 → reserve 1 min; real audio measured 50 min.
    await reserveUsage(store, sv, "u1", "batchMin", 1, "free", YM);
    await adjustUsage(
      store,
      sv,
      "u1",
      "batchMin",
      reconcileBatchDelta(50, 1),
      "free",
      YM,
    );
    expect(store.peek("u1")!.batchMin).toBe(50);
  });

  it("reconciles a batch reserve DOWN when the client over-reserved", async () => {
    const store = new FakeStore();
    await reserveUsage(store, sv, "u1", "batchMin", 45, "free", YM);
    await adjustUsage(
      store,
      sv,
      "u1",
      "batchMin",
      reconcileBatchDelta(30, 45),
      "free",
      YM,
    );
    expect(store.peek("u1")!.batchMin).toBe(30);
  });

  it("a full refund of a reserved-but-failed request returns the counter to 0", async () => {
    const store = new FakeStore();
    await reserveUsage(store, sv, "u1", "sttCalls", 1, "free", YM);
    expect(store.peek("u1")!.sttCalls).toBe(1);
    // Upstream failed, request uncommitted → refund -cost.
    await adjustUsage(store, sv, "u1", "sttCalls", -1, "free", YM);
    expect(store.peek("u1")!.sttCalls).toBe(0);
  });
});

// =====================================================================
// Batch-transcribe in-flight lease (DoS brake): cap concurrent BatchRecognize
// jobs at 1 per uid so a fan-out of concurrent requests cannot launch dozens of
// paid multi-minute STT jobs in parallel.
// =====================================================================
const STALE_MS = 20 * 60 * 1000; // must exceed the Cloud Run 900s request timeout

describe("decideBatchLease (pure)", () => {
  it("acquires when there is no holder (absent / 0 / null)", () => {
    expect(decideBatchLease(0, 1_000_000, STALE_MS)).toEqual({
      acquire: true,
      heldAt: 1_000_000,
    });
    expect(decideBatchLease(null, 1_000_000, STALE_MS)).toEqual({
      acquire: true,
      heldAt: 1_000_000,
    });
    expect(decideBatchLease(undefined, 1_000_000, STALE_MS)).toEqual({
      acquire: true,
      heldAt: 1_000_000,
    });
  });

  it("REJECTS when a fresh holder still owns the lease", () => {
    const heldAt = 1_000_000;
    const now = heldAt + 60_000; // 1 min later, well within stale window
    expect(decideBatchLease(heldAt, now, STALE_MS)).toEqual({
      acquire: false,
      heldAt,
    });
  });

  it("acquires when the holder is STALE (crashed / killed before release)", () => {
    const heldAt = 1_000_000;
    const now = heldAt + STALE_MS + 1; // just past the stale threshold
    expect(decideBatchLease(heldAt, now, STALE_MS)).toEqual({
      acquire: true,
      heldAt: now,
    });
  });

  it("treats the exact stale boundary as reclaimable (>= staleMs)", () => {
    const heldAt = 1_000_000;
    const now = heldAt + STALE_MS; // exactly staleMs elapsed
    expect(decideBatchLease(heldAt, now, STALE_MS).acquire).toBe(true);
  });

  it("treats a corrupt (non-numeric) heldAt as no holder", () => {
    expect(
      decideBatchLease("garbage" as unknown as number, 1_000_000, STALE_MS)
        .acquire,
    ).toBe(true);
  });
});

describe("acquireBatchLease / releaseBatchLease (wiring)", () => {
  it("acquires a free lease and records the holder inside a transaction", async () => {
    const store = new FakeStore();
    const ok = await acquireBatchLease(store, sv, "u1", 1_000_000, STALE_MS);
    expect(ok).toBe(true);
    expect(store.txnCount).toBe(1);
    const lock = store.locks.get("u1")!;
    expect(lock.heldAt).toBe(1_000_000);
    expect(lock.uid).toBe("u1");
    expect(lock.updatedAt).toBe(APPLIED_TS);
  });

  it("REJECTS a second acquire while a fresh lease is held (no double-write)", async () => {
    const store = new FakeStore();
    await acquireBatchLease(store, sv, "u1", 1_000_000, STALE_MS);
    const second = await acquireBatchLease(
      store,
      sv,
      "u1",
      1_000_000 + 60_000,
      STALE_MS,
    );
    expect(second).toBe(false);
    // The original holder's timestamp is untouched.
    expect(store.locks.get("u1")!.heldAt).toBe(1_000_000);
  });

  it("re-acquires after the holder goes stale", async () => {
    const store = new FakeStore();
    await acquireBatchLease(store, sv, "u1", 1_000_000, STALE_MS);
    const later = 1_000_000 + STALE_MS + 1;
    const ok = await acquireBatchLease(store, sv, "u1", later, STALE_MS);
    expect(ok).toBe(true);
    expect(store.locks.get("u1")!.heldAt).toBe(later);
  });

  it("release frees the lease so the next request can acquire", async () => {
    const store = new FakeStore();
    await acquireBatchLease(store, sv, "u1", 1_000_000, STALE_MS);
    await releaseBatchLease(store, "u1", 1_000_000);
    expect(store.locks.get("u1")).toBeUndefined();
    // A fresh (non-stale) acquire now succeeds because the holder is gone.
    const ok = await acquireBatchLease(
      store,
      sv,
      "u1",
      1_000_000 + 1000,
      STALE_MS,
    );
    expect(ok).toBe(true);
  });

  it("fenced release is a NO-OP when the lock was reclaimed by a newer generation", async () => {
    const store = new FakeStore();
    // Request A acquires at T. Its lease later goes stale and request B reclaims
    // it at T+STALE (writing a NEW heldAt). When A's finally finally runs, its
    // fenced release must NOT delete B's fresh lease.
    await acquireBatchLease(store, sv, "u1", 1_000_000, STALE_MS);
    const reclaimT = 1_000_000 + STALE_MS;
    const bReclaimed = await acquireBatchLease(
      store,
      sv,
      "u1",
      reclaimT,
      STALE_MS,
    );
    expect(bReclaimed).toBe(true);
    // A releases with ITS token (1_000_000) — must not touch B's lease (reclaimT).
    await releaseBatchLease(store, "u1", 1_000_000);
    expect(Number(store.locks.get("u1")?.heldAt)).toBe(reclaimT);
    // B releases with its own token → the lock is now actually freed.
    await releaseBatchLease(store, "u1", reclaimT);
    expect(store.locks.get("u1")).toBeUndefined();
  });

  it("leases are per-uid (one user's lease never blocks another)", async () => {
    const store = new FakeStore();
    await acquireBatchLease(store, sv, "u1", 1_000_000, STALE_MS);
    const other = await acquireBatchLease(store, sv, "u2", 1_000_000, STALE_MS);
    expect(other).toBe(true);
  });

  it("propagates a store error (caller decides fail-open)", async () => {
    const store = new FakeStore();
    store.failNextTransaction();
    await expect(
      acquireBatchLease(store, sv, "u1", 1_000_000, STALE_MS),
    ).rejects.toThrow("firestore unavailable");
    expect(store.locks.get("u1")).toBeUndefined();
  });
});
