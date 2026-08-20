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
/** A per-uid batch-transcribe in-flight lock document (batchLocks/{uid}). */
export interface BatchLockDoc {
  get(): Promise<UsageSnap>;
  set(
    data: Record<string, unknown>,
    opts: { merge: boolean },
  ): Promise<unknown>;
  delete(): Promise<unknown>;
}

/**
 * The minimal Firestore surface metering uses: the `usage/{uid}/months/{ym}`
 * document, the `batchLocks/{uid}` in-flight lock, and a transaction runner.
 * index.ts adapts the real Firestore to this.
 */
export interface MeteringStore {
  usageDoc(uid: string, ym: string): UsageDoc;
  batchLockDoc(uid: string): BatchLockDoc;
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

/**
 * Pure decision for the per-uid batch-transcribe in-flight lease. Given the
 * currently-stored acquire time `storedHeldAt` (epoch ms; 0/absent = free),
 * decide whether a new request at `now` may take the lease. It is free when
 * unheld OR when the holder is STALE (older than `staleMs` — a request that
 * crashed / was killed by the Cloud Run request timeout before it could
 * release). `staleMs` MUST exceed the Cloud Run request timeout (900s) so a
 * legitimately long-running batch is never treated as stale mid-flight.
 *
 * Why a lease at all: batch-transcribe launches a full paid BatchRecognize job
 * (minutes of STT compute) BEFORE its cost is reconciled, and the pre-flight
 * reserve is floored at 1 min from an UNTRUSTED client duration — so a fan-out
 * of concurrent requests could each pass the Free batchMin gate yet each launch
 * a full multi-minute job (a parallel cost bomb). Capping in-flight jobs at 1
 * per uid converts that unbounded parallel burst into strictly serial
 * execution. This is a DoS brake, NOT the billing gate (reserveUsage stays that).
 */
export function decideBatchLease(
  storedHeldAt: number | null | undefined,
  now: number,
  staleMs: number,
): { acquire: boolean; heldAt: number } {
  const held = Number(storedHeldAt) || 0;
  if (held <= 0 || now - held >= staleMs) return { acquire: true, heldAt: now };
  return { acquire: false, heldAt: held };
}

/**
 * Atomically try to acquire the per-uid batch lease. Returns true when acquired
 * (caller may proceed and MUST release afterward), false when another request
 * holds a FRESH lease (caller returns 429 and does not launch a job). The
 * read-decide-write runs inside ONE transaction so two concurrent acquires
 * cannot both win. Throws on store error — the caller decides fail-open (a lock
 * infra blip must not break transcription for a single legitimate request).
 */
export async function acquireBatchLease(
  store: MeteringStore,
  sv: ServerValues,
  uid: string,
  now: number,
  staleMs: number,
): Promise<boolean> {
  const ref = store.batchLockDoc(uid);
  return store.runTransaction(async (tx) => {
    const snap = await tx.get(ref as never);
    const held = snap.exists ? Number(snap.data()?.heldAt || 0) || 0 : 0;
    const d = decideBatchLease(held, now, staleMs);
    if (!d.acquire) return false;
    tx.set(
      ref as never,
      { heldAt: d.heldAt, uid, updatedAt: sv.serverTimestamp() },
      { merge: true },
    );
    return true;
  });
}

/**
 * Release the per-uid batch lease with FENCING: only delete the lock if it still
 * holds the generation we acquired (`expectedHeldAt` = the `now` passed to
 * acquireBatchLease, which decideBatchLease writes as `heldAt`). If our lease had
 * already gone stale and been reclaimed by a NEWER request, the stored heldAt no
 * longer matches ours, so we no-op and leave the current holder's lease intact —
 * an unconditional delete would otherwise wipe the new holder's lease and defeat
 * the 1-job-per-uid cap. The read-then-conditional-delete needs no transaction:
 * a reclaim only happens on staleness (>staleMs old), which by definition cannot
 * be true of a lease we are actively releasing, so our generation can only be
 * overwritten with a value that FAILS the equality check. Throws on store error.
 */
export async function releaseBatchLease(
  store: MeteringStore,
  uid: string,
  expectedHeldAt: number,
): Promise<void> {
  const ref = store.batchLockDoc(uid);
  const snap = await ref.get();
  const held = snap.exists ? Number(snap.data()?.heldAt || 0) || 0 : 0;
  if (held === expectedHeldAt) await ref.delete();
}
