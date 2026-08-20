// =====================================================================
// Entitlement & usage-metering pure logic (monetization P0)
// ---------------------------------------------------------------------
// This module holds ONLY pure, side-effect-free logic so it can be unit
// tested exhaustively (see gating.test.ts). All Firestore / HTTP wiring
// lives in index.ts. Keep this file free of firebase-admin / http imports
// so the Docker esbuild bundle stays clean and the tests need no mocks.
// =====================================================================

export type Plan = "free" | "pro" | "team" | "internal";
export type Feature = "aiCalls" | "sttCalls" | "batchMin" | "images";

// Per-plan monthly limits. -1 (or a missing key) = unlimited for that feature.
// NOTE: launch placeholders — tune against real COGS before public launch.
export const PLAN_LIMITS: Record<
  Exclude<Plan, "internal">,
  Record<Feature, number>
> = {
  free: { aiCalls: 30, sttCalls: 100, batchMin: 60, images: 2 },
  pro: { aiCalls: 2000, sttCalls: 6000, batchMin: 3000, images: 500 },
  team: { aiCalls: 4000, sttCalls: 12000, batchMin: 6000, images: 1000 },
};

export const ALL_PLANS: ReadonlySet<Plan> = new Set<Plan>([
  "free",
  "pro",
  "team",
  "internal",
]);

// Plans an owner may PREVIEW via X-View-As. "internal" is intentionally excluded:
// it is unlimited/unmetered, so accepting X-View-As:internal would let an owner
// whose real entitlement is free/pro escalate to unmetered access via a header
// (the client type ViewAsPlan already excludes internal; the server must mirror
// that, not merely trust the client to never send it).
export const VIEW_AS_PLANS: ReadonlySet<Plan> = new Set<Plan>([
  "free",
  "pro",
  "team",
]);

/** Parse a comma-separated env value into a trimmed, non-empty Set. */
export function parseUidSet(env: string | undefined): Set<string> {
  return new Set(
    (env || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Read the owner-only X-View-As override. Returns a valid Plan only when the
 * caller is an owner and the header names a known plan; otherwise null.
 * `raw` is the raw header value (string | string[] | undefined).
 */
export function resolveViewAs(
  raw: string | string[] | undefined,
  uid: string,
  ownerUids: ReadonlySet<string>,
): Plan | null {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!v) return null;
  if (!ownerUids.has(uid)) return null; // owner-only; ignore for everyone else
  // Only free/pro/team are previewable — never "internal" (see VIEW_AS_PLANS).
  return VIEW_AS_PLANS.has(v as Plan) ? (v as Plan) : null;
}

/**
 * Derive the real plan from an `entitlements/{uid}` document body. Only
 * active/grace paid entitlements grant pro/team; internal is admin-seeded and
 * intentionally status-independent; everything else falls back to free.
 */
export function derivePlan(
  data: { plan?: unknown; status?: unknown } | null | undefined,
): Plan {
  if (!data) return "free";
  // Normalize casing/whitespace so a webhook (or a hand-edited doc) writing
  // "Active" / " pro " / "TRIALING" can never silently downgrade a paying user.
  const p = String(data.plan ?? "free")
    .trim()
    .toLowerCase();
  const status = String(data.status ?? "active")
    .trim()
    .toLowerCase();
  // active/grace = full access. `trialing` is honored as paid too (defense in
  // depth: our Stripe webhook normalizes trialing→active before writing, but if
  // a raw Stripe status ever reaches here a trialing customer must keep access).
  const paidOk =
    status === "active" || status === "grace" || status === "trialing";
  if (p === "internal") return "internal";
  if (paidOk && (p === "pro" || p === "team")) return p;
  return "free";
}

/**
 * Calendar-month key in Asia/Tokyo (the product's fixed timezone). Usage
 * counters reset on the JST month boundary, not UTC.
 */
export function periodKey(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export interface QuotaCheck {
  /** True when this plan/feature is not metered (internal, or limit < 0). */
  unlimited: boolean;
  /** The applicable limit (-1 when unlimited). */
  limit: number;
  /** True when `used + cost` would exceed the limit (never true if unlimited). */
  blocked: boolean;
}

/** Pure quota decision for a given plan/feature/current-usage/cost. */
export function checkQuota(
  plan: Plan,
  feature: Feature,
  used: number,
  cost: number,
): QuotaCheck {
  if (plan === "internal")
    return { unlimited: true, limit: -1, blocked: false };
  const limit = PLAN_LIMITS[plan]?.[feature] ?? -1;
  if (limit < 0) return { unlimited: true, limit, blocked: false };
  return { unlimited: false, limit, blocked: used + cost > limit };
}

/**
 * True when a request actually consumes quota (so it is eligible for
 * refund/reconcile). Internal and unlimited-for-this-feature plans never do.
 */
export function isChargeable(plan: Plan, feature: Feature): boolean {
  if (plan === "internal") return false;
  const limit = PLAN_LIMITS[plan]?.[feature] ?? -1;
  return limit >= 0;
}

/**
 * Capability gate (MONETIZATION.md §1.3): whether a plan may run AUTOMATIC
 * (interval-driven) live research. Free is manual-only ("手動2-3回のみ・自動
 * 不可"); Pro/Team/internal may run it (Pro opt-in, default OFF, is a separate
 * client-side setting). MANUAL research is NOT gated here — it falls through to
 * the aiCalls quota for every plan.
 */
export function isAutoResearchAllowed(plan: Plan): boolean {
  return plan !== "free";
}

/**
 * The usage-counter delta to apply after a batch transcription completes: the
 * server-measured billable minutes minus what was pre-reserved. Positive = the
 * client under-reserved (charge the difference); negative = over-reserved
 * (refund the difference); 0 = exact. index.ts applies it ONLY when the request
 * actually charged quota.
 */
export function reconcileBatchDelta(
  measuredMin: number,
  reserveMin: number,
): number {
  return measuredMin - reserveMin;
}

/**
 * Whether a guarded request should refund its reserved cost. True ONLY when the
 * reservation succeeded AND actually charged quota (g.ok && g.charged) AND the
 * request did not commit (the upstream cost was never incurred). Internal /
 * unlimited / fail-open guards carry charged:false and therefore never refund —
 * this is what prevents "refunding" an increment that was never persisted.
 */
export function shouldRefund(
  g: { ok: boolean; charged?: boolean } | null | undefined,
  committed: boolean,
): boolean {
  return !!g && g.ok && !!g.charged && !committed;
}

/** Speech-to-Text v2 duration string ("1.200s") → seconds. */
export function parseOffset(v: unknown): number {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/s$/, ""));
  return isNaN(n) ? 0 : n;
}

/**
 * Pre-flight reserve (in minutes) for a batch-transcribe request, from the
 * client-supplied per-chunk durations. Negative/absent durations are clamped to
 * 0, and the reserve is floored at 1 so every request consumes something during
 * processing. This is only a best-effort block against obvious over-limit; the
 * authoritative charge is reconciled server-side after transcription via
 * measuredBatchMinutes(). Because the client value is untrusted, a caller can at
 * most under-reserve by one file's worth before the reconciled counter blocks
 * the next request — it can never obtain unlimited minutes.
 */
export function clampBatchReserveMinutes(
  chunks: Array<{ durationSec?: number }>,
): number {
  const totalSec = chunks.reduce(
    (s, c) => s + Math.max(0, Number(c.durationSec) || 0),
    0,
  );
  return Math.max(1, Math.ceil(totalSec / 60));
}

/**
 * Server-measured billable minutes for a completed batch transcription, derived
 * from the actual STT output (word/result end offsets) — never the client's
 * claim. `chunkResults[i]` is the SpeechRecognitionResult[] for chunk i. For a
 * multi-chunk recording the 20s overlaps are subtracted so audio is billed once.
 */
export function measuredBatchMinutes(
  chunkResults: Array<Array<unknown>>,
  overlapSecs: number,
): number {
  let totalSec = 0;
  for (const results of chunkResults) {
    let maxOffset = 0;
    for (const r of results) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rr = r as any;
      const ro = parseOffset(rr?.resultEndOffset);
      if (ro > maxOffset) maxOffset = ro;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ws: any[] = rr?.alternatives?.[0]?.words || [];
      for (const w of ws) {
        const eo = parseOffset(w?.endOffset);
        if (eo > maxOffset) maxOffset = eo;
      }
    }
    totalSec += maxOffset;
  }
  const n = chunkResults.length;
  if (n > 1) totalSec -= overlapSecs * (n - 1);
  if (totalSec < 0) totalSec = 0;
  return Math.ceil(totalSec / 60);
}
