import { describe, it, expect } from "vitest";
import {
  reserveUsage,
  adjustUsage,
  type MeteringStore,
  type UsageDoc,
  type UsageTxn,
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
