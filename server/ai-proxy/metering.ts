// =====================================================================
// Usage-metering Firestore wiring (monetization P0)
// ---------------------------------------------------------------------
// The reserve / adjust primitives that touch Firestore, factored out of
// index.ts so the double-charge–critical path (reserve → 429, reserve →
// reconcile, reserve → refund) is unit-testable against a fake store (see
// metering.test.ts). Kept FREE of firebase-admin / http imports — exactly like
// gating.ts — by dependency-injecting the Firestore surface (`store`) and the
// server-value factory (`sv`). index.ts passes the real ones; tests pass fakes.
// The PURE decisions (checkQuota, reconcileBatchDelta, shouldRefund) live in
// gating.ts; this module only wires those decisions to reads/writes.
// =====================================================================
import { checkQuota, type Plan, type Feature } from "./gating";

/**
 * The FieldValue sentinels metering needs, injected so this module never imports
 * firebase-admin (which would break local vitest — firebase-admin is only
 * installed in the Cloud Run image, not the app's node_modules).
 */
export interface ServerValues {
  increment(n: number): unknown;
  serverTimestamp(): unknown;
}

export interface UsageSnap {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}
export interface UsageDoc {
  get(): Promise<UsageSnap>;
  set(
    data: Record<string, unknown>,
    opts: { merge: boolean },
  ): Promise<unknown>;
}
export interface UsageTxn {
  get(ref: UsageDoc): Promise<UsageSnap>;
  set(
    ref: UsageDoc,
    data: Record<string, unknown>,
    opts: { merge: boolean },
  ): unknown;
}
/**
 * The minimal Firestore surface metering uses: the `usage/{uid}/months/{ym}`
 * document and a transaction runner. index.ts adapts the real Firestore to this.
 */
export interface MeteringStore {
  usageDoc(uid: string, ym: string): UsageDoc;
  runTransaction<T>(fn: (tx: UsageTxn) => Promise<T>): Promise<T>;
}

/**
 * Atomically check the current-month counter and, only if not over limit,
 * increment it by `cost`. Returns { blocked:true } WITHOUT writing when the cost
 * would exceed the limit — the critical invariant that a blocked request is
 * never charged. The read-decide-write happens inside ONE transaction so a
 * concurrent request cannot slip past the limit. Unlimited plans (internal, or a
 * feature with limit < 0) return blocked:false WITHOUT writing — their counters
 * are never metered. Throws on store error (the caller decides fail-open).
 */
export async function reserveUsage(
  store: MeteringStore,
  sv: ServerValues,
  uid: string,
  feature: Feature,
  cost: number,
  plan: Plan,
  ym: string,
): Promise<{ blocked: boolean; used: number }> {
  const ref = store.usageDoc(uid, ym);
  return store.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const used = snap.exists ? Number(snap.data()?.[feature] || 0) || 0 : 0;
    const c = checkQuota(plan, feature, used, cost);
    // Never meter an unlimited plan/feature (defense in depth; index.ts already
    // short-circuits these before calling reserveUsage).
    if (c.unlimited) return { blocked: false, used };
    if (c.blocked) return { blocked: true, used };
    tx.set(
      ref,
      {
        [feature]: sv.increment(cost),
        plan,
        period: ym,
        updatedAt: sv.serverTimestamp(),
      },
      { merge: true },
    );
    return { blocked: false, used };
  });
}

/**
 * Adjust a counter by `delta` (may be negative) via an atomic increment. Used to
 * refund a reserved-but-unused cost and to reconcile a batch reserve to the
 * server-measured actual. No-op for delta 0. Throws on store error; index.ts
 * wraps this so a failed refund never turns a successful request into a 500.
 */
export async function adjustUsage(
  store: MeteringStore,
  sv: ServerValues,
  uid: string,
  feature: Feature,
  delta: number,
  plan: Plan,
  ym: string,
): Promise<void> {
  if (!delta) return;
  const ref = store.usageDoc(uid, ym);
  await ref.set(
    {
      [feature]: sv.increment(delta),
      plan,
      period: ym,
      updatedAt: sv.serverTimestamp(),
    },
    { merge: true },
  );
}
