// =====================================================================
// Feedback pipeline — PURE helpers (in-app bug reports / feature requests).
// ---------------------------------------------------------------------
// The I/O half lives in index.ts (/v1/feedback: verify token, write Firestore
// via Admin SDK, notify Slack). Everything here is pure so the money/PII-adjacent
// logic — redaction, fingerprinting, notify thresholds, Slack payload shape — has
// a regression net (index.ts itself is not unit-tested). Mirrors billing.ts /
// iap.ts / gating.ts / metering.ts.
// =====================================================================
import { createHash } from "node:crypto";

export type FeedbackKind = "bug" | "idea" | "other";

export const MAX_MESSAGE = 5000;
export const MAX_ERROR = 4000;

/** Coerce a client-supplied kind to the closed set (default "other"). */
export function normalizeFeedbackKind(raw: unknown): FeedbackKind {
  const k = String(raw ?? "")
    .trim()
    .toLowerCase();
  return k === "bug" || k === "idea" ? k : "other";
}

/**
 * Redact obvious PII / secrets from free text before it is stored or forwarded to
 * Slack. Conservative on purpose — a bug report needs SOME context — but strips
 * the high-risk patterns (identities, credentials, card/long-id numbers). Applied
 * server-side; the client never decides what is safe.
 */
export function redactPII(input: string): string {
  let s = String(input ?? "");
  // Email addresses.
  s = s.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[email]");
  // JWTs (three base64url segments) — must run before the generic token rules.
  s = s.replace(
    /\beyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\b/g,
    "[token]",
  );
  // Bearer tokens.
  s = s.replace(/\bBearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [token]");
  // Common API-key shapes: Google (AIza…), Stripe (sk_/pk_/rk_live|test_…),
  // GitHub (ghp_/gho_/ghu_/ghs_/ghr_…), Slack (xoxb-/xoxp-…).
  s = s.replace(/\bAIza[0-9A-Za-z_-]{10,}\b/g, "[key]");
  s = s.replace(/\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{6,}\b/g, "[key]");
  s = s.replace(/\bgh[pousr]_[0-9A-Za-z]{20,}\b/g, "[key]");
  s = s.replace(/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, "[key]");
  // Long digit runs (13+ incl. spaces/dashes → card / phone / long id).
  s = s.replace(/\b\d[\d -]{11,}\d\b/g, "[number]");
  return s;
}

/** Clamp + redact the free-text message. */
export function sanitizeMessage(raw: unknown): string {
  return redactPII(String(raw ?? "").trim()).slice(0, MAX_MESSAGE);
}

/** Clamp + redact an attached error string (crash-prefill path). */
export function sanitizeError(raw: unknown): string {
  return redactPII(String(raw ?? "").trim()).slice(0, MAX_ERROR);
}

/**
 * Normalize a message so near-identical reports fingerprint to the same group:
 * drop urls / uuids / hex addrs / numbers / punctuation, keep words + kana/kanji,
 * collapse whitespace. Bounded so a huge paste can't dominate the hash basis.
 */
export function normalizeForFingerprint(text: string): string {
  return (
    String(text ?? "")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        " ",
      )
      .replace(/0x[0-9a-f]+/g, " ")
      .replace(/\d+/g, " ")
      // keep ascii letters + Japanese kana/kanji; everything else → space
      .replace(/[^a-z぀-ヿ一-鿿\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200)
  );
}

/** Stable 16-hex dedupe fingerprint (kind + app version + normalized message). */
export function feedbackFingerprint(
  kind: FeedbackKind,
  appVersion: string,
  message: string,
): string {
  const basis = `${kind}|${String(appVersion || "").trim()}|${normalizeForFingerprint(message)}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

// Notify on the FIRST sighting of a group, then again at the 5th and 25th
// occurrence — enough to surface a spike without spamming the ops channel.
const NOTIFY_AT = new Set([1, 5, 25]);
export function shouldNotifyFeedback(count: number, isNew: boolean): boolean {
  return isNew || NOTIFY_AT.has(Math.floor(count));
}

/** Partial-mask an email for the internal ops channel (full copy stays in Firestore). */
export function maskEmail(email: string): string {
  const e = String(email || "").trim();
  const at = e.indexOf("@");
  if (at <= 0) return e ? "[email]" : "";
  const name = e.slice(0, at);
  const domain = e.slice(at);
  const shown = name.length <= 2 ? name.slice(0, 1) : name.slice(0, 2);
  return `${shown}***${domain}`;
}

export function feedbackKindLabel(kind: FeedbackKind): string {
  return kind === "bug"
    ? "バグ報告"
    : kind === "idea"
      ? "要望・アイデア"
      : "その他";
}

/**
 * Slack status color band (house style: status via good/warning/danger, never an
 * emoji). A hot group (≥25) is always danger; otherwise bug→danger, idea→good,
 * other→warning.
 */
export function feedbackColor(kind: FeedbackKind, count: number): string {
  if (count >= 25) return "danger";
  if (kind === "bug") return "danger";
  if (kind === "idea") return "good";
  return "warning";
}

/**
 * Build the Slack payload (attachments + Block Kit). Pure so the shape is
 * unit-tested. Email is MASKED here (the internal channel gets enough to follow
 * up; the un-masked copy lives in the server-only Firestore doc).
 */
export function buildFeedbackSlackPayload(p: {
  kind: FeedbackKind;
  count: number;
  isNew: boolean;
  message: string;
  plan: string;
  appVersion: string;
  platform: string;
  email: string;
  fingerprint: string;
}): unknown {
  const title = p.isNew
    ? `新規${feedbackKindLabel(p.kind)}`
    : `${feedbackKindLabel(p.kind)}（${p.count}件目）`;
  const excerpt =
    p.message.length > 500 ? `${p.message.slice(0, 500)}…` : p.message;
  const meta = [
    `plan: ${p.plan || "-"}`,
    `ver: ${p.appVersion || "-"}`,
    `pf: ${p.platform || "-"}`,
    `from: ${maskEmail(p.email) || "-"}`,
    `fp: ${p.fingerprint}`,
  ].join("  |  ");
  return {
    attachments: [
      {
        color: feedbackColor(p.kind, p.count),
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `*${title}*` } },
          {
            type: "section",
            text: { type: "mrkdwn", text: excerpt || "(本文なし)" },
          },
          { type: "context", elements: [{ type: "mrkdwn", text: meta }] },
        ],
      },
    ],
  };
}
