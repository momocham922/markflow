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

/** IAP lifecycle notifications (Apple ASSN v2 / Play RTDN) are BEST-EFFORT. */
export const IAP_EXPIRY_GRACE_SEC = 24 * 60 * 60;

/**
 * Read-time money-leak backstop for IAP subscriptions. Apple/Play deliver
 * renew/expire/refund as best-effort server notifications; if one is lost, a
 * lapsed sub would keep plan=pro/team + status=active in Firestore forever and
 * `derivePlan` (pure, time-agnostic) would keep granting access. When an
 * app_store/play entitlement is still paid yet its stored period end is well in
 * the past, treat it as `free` for THIS response. Legitimate grace / billing
 * retry arrive as their OWN status (grace→access, on_hold→revoked) through
 * derivePlan, so a PAST period end UNDER a paid status can only mean a missed
 * lifecycle event — never a real grace window. Pure so it is unit-testable; the
 * clock (nowSec) is injected. Stripe is excluded (it has a reconcile-capable
 * webhook + no lost-notification failure mode of this shape).
 */
export function iapExpiryBackstop(
  plan: Plan,
  source: string | null | undefined,
  periodEndSec: number,
  nowSec: number,
): Plan {
  const isIap = source === "app_store" || source === "play";
  const isPaid = plan === "pro" || plan === "team";
  if (!isIap || !isPaid || !(periodEndSec > 0)) return plan;
  if (nowSec - periodEndSec > IAP_EXPIRY_GRACE_SEC) return "free";
  return plan;
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

/**
 * Pure quota decision for a given plan/feature/current-usage/cost.
 *
 * `seats` scales ONLY the team plan's shared pool: a Team subscription meters all
 * members against a single usage/{teamId} counter whose ceiling is the per-plan
 * base × seat count (min 1). Non-team plans ignore `seats` entirely (a Pro user
 * is always a 1-seat pool), so the parameter is backward-compatible — every
 * existing call that omits it behaves exactly as before. Seats is clamped to ≥1
 * so a malformed 0/negative seat count can never zero out (or invert) the pool.
 */
export function checkQuota(
  plan: Plan,
  feature: Feature,
  used: number,
  cost: number,
  seats = 1,
): QuotaCheck {
  if (plan === "internal")
    return { unlimited: true, limit: -1, blocked: false };
  const base = PLAN_LIMITS[plan]?.[feature] ?? -1;
  if (base < 0) return { unlimited: true, limit: base, blocked: false };
  const limit = plan === "team" ? base * Math.max(1, Math.floor(seats)) : base;
  return { unlimited: false, limit, blocked: used + cost > limit };
}

/** The teams/{teamId}.billing sub-doc fields the seat-access gate inspects. */
export interface TeamBillingView {
  status?: unknown;
  seats?: unknown;
}

export interface SeatAccess {
  /** True when this uid currently holds a paid, assigned Team seat. */
  access: boolean;
  /** Why access was granted/denied (for logs / 402 payloads). */
  reason: "ok" | "not_team" | "not_active" | "not_assigned" | "over_capacity";
}

/**
 * Decide whether `uid` may spend against a Team's shared pool. A member has
 * access ONLY when the team subscription is active/grace AND the uid occupies one
 * of the first `seats` slots of `seatAssignments` (assignment order is the
 * authoritative capacity fence — assigning more people than paid seats does NOT
 * grant the overflow access; they fall off the end). seatAssignments and seats
 * are BOTH server-written (webhook + owner-only seat endpoints); this function
 * never trusts client input. Pure — no Firestore reads.
 */
export function deriveSeatAccess(
  billing: TeamBillingView | null | undefined,
  seatAssignments: readonly string[] | null | undefined,
  uid: string,
): SeatAccess {
  const status = String(billing?.status ?? "")
    .trim()
    .toLowerCase();
  if (status !== "active" && status !== "grace")
    return { access: false, reason: "not_active" };
  const seats = Math.max(1, Math.floor(Number(billing?.seats) || 0));
  const assigned = Array.isArray(seatAssignments) ? seatAssignments : [];
  const idx = assigned.indexOf(uid);
  if (idx < 0) return { access: false, reason: "not_assigned" };
  if (idx >= seats) return { access: false, reason: "over_capacity" };
  return { access: true, reason: "ok" };
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
 * The usage-counter delta to apply when a batch transcription FAILS partway.
 * Each chunk launches its OWN paid BatchRecognize op (Google bills the op the
 * moment it is created), so a batch that starts N ops then fails must NOT refund
 * the whole reserve — otherwise a client could resubmit "N valid + 1 poisoned"
 * chunks to run real STT compute for free on a repeating loop (the per-uid lease
 * serializes it but does not stop the loop). We keep the charge for the chunks
 * whose op actually STARTED and refund only the never-launched remainder.
 *
 * `startedCount` ≤ chunks.length ≤ `reserveMin` (clampBatchReserveMinutes floors
 * the reserve at 1 min/chunk), so the returned delta is ALWAYS ≤ 0: the failure
 * path can only ever refund the unstarted portion, never over-charge. Passing
 * startedCount = 0 (nothing launched — e.g. a pre-flight token/4xx error) yields
 * a full refund, preserving the "a failed batch costs nothing" promise for the
 * common start-failure case.
 */
export function failedBatchChargeDelta(
  startedCount: number,
  reserveMin: number,
): number {
  const started = Math.max(0, Math.floor(startedCount));
  const reserve = Math.max(0, Math.floor(reserveMin));
  return Math.min(started, reserve) - reserve;
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

// =====================================================================
// AI request idempotency (「エラー起因の再生成・リトライは利用カウントに含めない」)
// ---------------------------------------------------------------------
// A user-facing AI answer is ONE logical request. When it fails (empty output,
// mid-stream drop) the client retries / offers "再生成"; those must NOT each burn
// a fresh aiCall. The client stamps a stable Idempotency-Key per logical request
// and re-sends it on every retry/regenerate; the server collapses same-key,
// same-content re-runs onto the ORIGINAL charge (owner decision: 「再生成に集約し
// 1課金」). A DIFFERENT prompt under the same key, an expired window, or exceeding
// the regen cap all charge fresh — so the mechanism can never be turned into a
// free-generation faucet for arbitrary new prompts. STT paths are intentionally
// excluded (Google real-charges STT compute; see index.ts).
// =====================================================================

/**
 * Idempotency window for AI chat requests. A retry/regenerate bearing the SAME
 * key + same content within this window collapses onto the original charge;
 * after it, the key is stale and a re-run charges fresh. Short enough to bound
 * abuse, long enough to cover a user reading a broken answer then hitting 再生成.
 */
export const AI_IDEM_TTL_MS = 15 * 60 * 1000;

/**
 * Max FREE retries/regenerations per charged idempotency key. Bounds cost
 * amplification: one paid answer yields at most 1 + this many re-runs of the
 * SAME request before the next re-run charges again. Keeps a stuck "always
 * regenerate" client from fanning out unbounded free upstream calls.
 */
export const AI_IDEM_MAX_REGEN = 2;

/** The persisted idempotency record (aiRequests/{hash}) fields this logic reads. */
export interface IdemState {
  charged?: unknown;
  contentHash?: unknown;
  regenCount?: unknown;
  /** Epoch ms after which the record is stale. */
  expiresAt?: unknown;
}

/**
 * Decide whether an AI request bearing an idempotency key may REUSE a prior
 * charge (run for free) or must charge fresh. Pure so it is exhaustively unit
 * tested; index.ts wires the Firestore read/increment around it.
 *
 * Reuse ONLY when the stored record is: actually charged, not expired, bound to
 * the SAME content hash, and still under the regen cap. EVERY other case (no
 * record, not-yet-charged, expired, different prompt, cap reached) charges
 * fresh — that is what keeps this from ever GRANTING free generations for a new
 * prompt or beyond the cap. `reuse:false` on cap-reached is deliberate: the
 * caller charges again and re-opens a fresh window (the user paid again).
 */
export function decideIdempotencyReuse(
  state: IdemState | null | undefined,
  contentHash: string,
  nowMs: number,
): boolean {
  if (!state || !contentHash) return false;
  if (state.charged !== true) return false;
  const expiresAt = Number(state.expiresAt) || 0;
  if (expiresAt > 0 && nowMs >= expiresAt) return false;
  const hash = typeof state.contentHash === "string" ? state.contentHash : "";
  if (!hash || hash !== contentHash) return false;
  const count = Number(state.regenCount) || 0;
  if (count >= AI_IDEM_MAX_REGEN) return false;
  return true;
}

/**
 * True when an Anthropic/Vertex SSE stream (raw concatenated text) shows the
 * model produced USABLE output — streamed answer text (`text_delta`) or a tool
 * call (`input_json_delta`). The /v1/chat billing commit keys off this instead
 * of the bare HTTP 200: Anthropic can stream a 200 and then emit an `error`
 * event (overloaded) with no content, and an empty completion produces no
 * deltas. Produced → keep the charge (the COGS was incurred AND — since we scan
 * the UPSTREAM bytes, not client delivery — a client that disconnects AFTER
 * receiving content is still charged, closing that free-generation vector).
 * Not produced → refund (owner rule: 「生成されない＝課金しない」).
 *
 * Deliberately excludes `thinking_delta` / `content_block_stop`: a thinking-only
 * stream that dies before any answer text gave the user nothing, so it must
 * refund. Substring probes (not a full JSON parse) keep this cheap enough to run
 * on the hot passthrough path against a bounded tail buffer.
 */
export function sseProducedOutput(sse: string): boolean {
  if (!sse) return false;
  return (
    /"type"\s*:\s*"text_delta"/.test(sse) ||
    /"type"\s*:\s*"input_json_delta"/.test(sse)
  );
}

/**
 * True when a NON-streaming Anthropic/Vertex response body carries usable output
 * — at least one non-empty `text` block or any `tool_use` block. The
 * non-streaming /v1/chat commit keys off this (mirror of sseProducedOutput for
 * the buffered path): an empty `content` array or text-only-whitespace answer
 * refunds instead of charging for nothing.
 */
export function chatResponseHasOutput(data: unknown): boolean {
  const content = (data as { content?: unknown })?.content;
  if (!Array.isArray(content)) return false;
  for (const b of content) {
    const block = b as { type?: unknown; text?: unknown };
    if (block?.type === "tool_use" || block?.type === "server_tool_use")
      return true;
    if (
      block?.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim()
    )
      return true;
  }
  return false;
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
 * 0, then the reserve is floored at 1 minute PER CHUNK (not 1 minute total).
 *
 * The per-chunk floor is the money-leak fix: each chunk launches its OWN paid
 * BatchRecognize job (minutes of STT compute) BEFORE the cost is reconciled, so a
 * request that sends N chunks with durationSec=0 must still draw down at least N
 * minutes of quota up front. That bounds the chunk COUNT a request can fan out to
 * the caller's remaining quota (a user already at their limit reserves ≥1 and is
 * blocked from starting any batch at all), and it composes with:
 *   - the per-request chunk cap (MAX_BATCH_CHUNKS in index.ts) — bounds fan-out,
 *   - the per-uid in-flight lease — serializes jobs so bursts can't run parallel,
 *   - measuredBatchMinutes() reconcile — corrects the counter to the actual after.
 * The client value stays untrusted (it can only ever raise its own reserve, never
 * obtain free minutes): under-reporting duration is capped by the per-chunk floor
 * + reconcile; over-reporting only charges the caller more.
 */
export function clampBatchReserveMinutes(
  chunks: Array<{ durationSec?: number }>,
): number {
  const totalSec = chunks.reduce(
    (s, c) => s + Math.max(0, Number(c.durationSec) || 0),
    0,
  );
  // Floor at 1 min PER CHUNK so N chunks reserve ≥ N minutes regardless of the
  // (untrusted) declared durations.
  return Math.max(chunks.length, Math.ceil(totalSec / 60));
}

/**
 * Server-measured billable minutes for a completed batch transcription. The
 * billable length of each chunk is the GREATER of:
 *   - the last speech offset from the actual STT output (word/result end offsets)
 *     — a lower bound that ignores TRAILING silence, and
 *   - the client-declared chunk duration `declaredSecs[i]` (when provided).
 * Google bills by AUDIO length, so billing on the speech offset alone would let a
 * clip of speech followed by a long silence tail transcribe for near-free. Taking
 * the declared duration as a FLOOR closes that: an honest client declares the true
 * chunk length (silence included) and is billed for it, while a client that
 * under-declares to dodge the charge can only fall back to the speech-offset lower
 * bound (and has already paid the per-chunk pre-flight reserve — see
 * clampBatchReserveMinutes). A client can never LOWER its bill below actual speech
 * this way; it can only raise it by over-declaring (self-harm). For a multi-chunk
 * recording the 20s overlaps are subtracted so shared audio is billed once.
 */
export function measuredBatchMinutes(
  chunkResults: Array<Array<unknown>>,
  overlapSecs: number,
  declaredSecs?: ReadonlyArray<number>,
): number {
  let totalSec = 0;
  for (let i = 0; i < chunkResults.length; i++) {
    const results = chunkResults[i];
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
    // Floor the chunk's billable length at its declared duration (audio length),
    // never below the detected speech offset.
    const declared = Math.max(0, Number(declaredSecs?.[i]) || 0);
    totalSec += Math.max(maxOffset, declared);
  }
  const n = chunkResults.length;
  if (n > 1) totalSec -= overlapSecs * (n - 1);
  if (totalSec < 0) totalSec = 0;
  return Math.ceil(totalSec / 60);
}

export interface BatchMergeResult {
  /** Speaker-tagged transcript per chunk (joined by "---" by the caller). */
  taggedSegments: string[];
  /** Plain transcript per chunk (joined by "\n" by the caller). */
  plainSegments: string[];
  /** Distinct speaker labels seen across all chunks. */
  speakerLabels: string[];
}

/**
 * Merge per-chunk BatchRecognize results into a de-overlapped transcript.
 *
 * For a multi-chunk recording each pair of adjacent chunks shares a 20s overlap;
 * the overlap is split at its midpoint (leadCut/trailCut by word start offset) so
 * every boundary word is emitted exactly once.
 *
 * CRITICAL guard (`chunkHasOffsets`): the leadCut filter (t >= overlap/2 for any
 * chunk after the first) drops EVERY word when the STT output carries no usable
 * word offsets (every startOffset ~0) — which silently loses whole 55-min chunks.
 * This is exactly the content-loss bug that shipped before `enableWordTimeOffsets`
 * was set on the BatchRecognize request. When a chunk carries no offsets we fall
 * back to its full transcript (no cut); the ≤20s overlap dup is smoothed by the
 * structuring model at the "---" boundary — far better than losing the chunk.
 * Extracted here as a pure function so this loss path is regression-tested
 * (gating.test.ts) independently of the HTTP handler.
 */
export function mergeBatchChunks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chunkResults: any[][],
  chunks: ReadonlyArray<{ durationSec: number }>,
  multi: boolean,
  overlapSecs: number,
): BatchMergeResult {
  const allSpeakerLabels = new Set<string>();
  const taggedSegments: string[] = [];
  const plainSegments: string[] = [];

  for (let i = 0; i < chunkResults.length; i++) {
    const results = chunkResults[i];
    const c = chunks[i];
    const leadCut = i === 0 ? 0 : overlapSecs / 2;
    const trailCut =
      i === chunkResults.length - 1 || !c || c.durationSec <= 0
        ? Infinity
        : c.durationSec - overlapSecs / 2;

    // Only dedup by timestamp when this chunk's words actually carry offsets;
    // otherwise the leadCut filter would drop every word. See docstring above.
    const chunkHasOffsets = results.some((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ws: any[] = (r as any)?.alternatives?.[0]?.words || [];
      return ws.some((w) => parseOffset(w.startOffset) > 0);
    });

    const words: Array<{ word: string; speakerLabel: string }> = [];
    let plain = "";
    for (const r of results) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const alt = (r as any).alternatives?.[0];
      if (!alt) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ws: any[] = alt.words || [];
      if (multi && chunkHasOffsets && ws.length > 0) {
        for (const w of ws) {
          const t = parseOffset(w.startOffset);
          if (t >= leadCut && t < trailCut) {
            words.push({
              word: w.word || "",
              speakerLabel: w.speakerLabel || "",
            });
            plain += w.word || "";
          }
        }
      } else {
        for (const w of ws)
          words.push({
            word: w.word || "",
            speakerLabel: w.speakerLabel || "",
          });
        // Prefer the result-level transcript; if the model returned only words
        // (no transcript string), reconstruct from them so the chunk is never
        // dropped for lack of a transcript field.
        plain +=
          alt.transcript ||
          ws.map((w: { word?: string }) => w.word || "").join("");
      }
    }

    const labels = new Set(words.map((w) => w.speakerLabel).filter(Boolean));
    labels.forEach((l) => allSpeakerLabels.add(l));

    let tagged = plain;
    if (labels.size > 1 && words.length > 0) {
      let cur = "";
      const parts: string[] = [];
      for (const w of words) {
        const label = w.speakerLabel || "";
        if (label && label !== cur) {
          cur = label;
          parts.push(`\n[Speaker ${label}] `);
        }
        parts.push(w.word);
      }
      tagged = parts.join("").trim();
    }

    if (plain.trim()) {
      taggedSegments.push(tagged.trim());
      plainSegments.push(plain.trim());
    }
  }

  return {
    taggedSegments,
    plainSegments,
    speakerLabels: Array.from(allSpeakerLabels),
  };
}
