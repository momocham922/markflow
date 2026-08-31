// =====================================================================
// Telemetry pipeline — PURE helpers (product analytics → BigQuery).
// ---------------------------------------------------------------------
// The I/O half lives in index.ts (/v1/telemetry: verify token, consent gate,
// BigQuery streaming insert). Everything here — name/prop sanitization, batch
// clamping, timestamp clamping, BigQuery row shaping — is pure so it has a
// regression net independent of the network path. Mirrors billing.ts / iap.ts /
// gating.ts / metering.ts / feedback.ts.
//
// Design stance: telemetry props are STRUCTURED (small key→scalar maps), never
// free prose, so we clamp cardinality/size hard and defensively strip anything
// that smells like PII. The server, not the client, stamps identity (uid/plan)
// and receive time.
// =====================================================================
import { createHash } from "node:crypto";
import { redactPII } from "./feedback";

export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_PROPS_PER_EVENT = 25;
export const MAX_KEY_LEN = 40;
export const MAX_STRING_VALUE_LEN = 500;
export const MAX_EVENT_NAME_LEN = 48;

export type TelemetryPropValue = string | number | boolean;

export interface RawTelemetryEvent {
  id?: unknown;
  event?: unknown;
  ts?: unknown; // client event time, epoch ms
  props?: unknown;
  sessionId?: unknown;
}

export interface CleanTelemetryEvent {
  eventId: string;
  event: string;
  clientTs: number | null;
  sessionId: string;
  props: Record<string, TelemetryPropValue>;
}

/**
 * Sanitize an event name to a stable, low-cardinality token: lowercased,
 * snake_case, ascii only. Returns null if nothing usable remains — the caller
 * drops the event rather than recording a junk name.
 */
export function sanitizeEventName(raw: unknown): string | null {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, MAX_EVENT_NAME_LEN);
  return s.length >= 2 ? s : null;
}

/** Coerce a single prop value to a bounded scalar; null if unusable. */
export function sanitizePropValue(v: unknown): TelemetryPropValue | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = redactPII(v).slice(0, MAX_STRING_VALUE_LEN);
    return s;
  }
  // Objects/arrays/null/undefined are not valid scalar props — drop them.
  return null;
}

/** Sanitize a props map: bounded key count, snake_case keys, scalar values. */
export function sanitizeProps(
  raw: unknown,
): Record<string, TelemetryPropValue> {
  const out: Record<string, TelemetryPropValue> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_PROPS_PER_EVENT) break;
    const key = String(k)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, MAX_KEY_LEN);
    if (!key) continue;
    const val = sanitizePropValue(v);
    if (val === null) continue;
    out[key] = val;
    n++;
  }
  return out;
}

/**
 * Clamp a client-supplied event timestamp (epoch ms) to a sane window: never in
 * the future beyond a small skew, never absurdly old. Returns null if unparseable
 * so the row falls back to server time only.
 */
export function clampClientTs(raw: unknown, nowMs: number): number | null {
  const t = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(t)) return null;
  const maxFuture = nowMs + 5 * 60 * 1000; // 5 min skew
  const minPast = nowMs - 30 * 24 * 60 * 60 * 1000; // 30 days (offline queue)
  if (t > maxFuture) return nowMs;
  if (t < minPast) return null;
  return Math.floor(t);
}

/**
 * Derive a stable insert id for BigQuery dedup. Prefers the client-supplied event
 * id (offline retries reuse it → idempotent); otherwise hashes the content so a
 * duplicate delivery of the same event still collapses.
 */
export function deriveEventId(
  rawId: unknown,
  uid: string,
  event: string,
  clientTs: number | null,
): string {
  const id = String(rawId ?? "").trim();
  if (id && /^[A-Za-z0-9_-]{6,64}$/.test(id)) return id;
  return createHash("sha256")
    .update(`${uid}|${event}|${clientTs ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

/** Validate + normalize a single raw event. Returns null to drop it. */
export function cleanEvent(
  raw: RawTelemetryEvent,
  uid: string,
  nowMs: number,
): CleanTelemetryEvent | null {
  const event = sanitizeEventName(raw?.event);
  if (!event) return null;
  const clientTs = clampClientTs(raw?.ts, nowMs);
  const props = sanitizeProps(raw?.props);
  const sessionId = String(raw?.sessionId ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 64);
  const eventId = deriveEventId(raw?.id, uid, event, clientTs);
  return { eventId, event, clientTs, sessionId, props };
}

/** Clean + clamp a whole batch (drops junk events, caps count). */
export function cleanBatch(
  raw: unknown,
  uid: string,
  nowMs: number,
): CleanTelemetryEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: CleanTelemetryEvent[] = [];
  for (const e of raw.slice(0, MAX_EVENTS_PER_BATCH)) {
    const c = cleanEvent(e as RawTelemetryEvent, uid, nowMs);
    if (c) out.push(c);
  }
  return out;
}

export interface TelemetryServerMeta {
  uid: string;
  plan: string;
  appVersion: string;
  platform: string;
  osVersion: string;
  locale: string;
  serverTsIso: string; // ISO-8601, computed by caller (Date is banned in workflows, not here)
}

export interface BigQueryInsertRow {
  insertId: string;
  json: Record<string, unknown>;
}

/** ISO-8601 for a client epoch-ms, or null. BigQuery TIMESTAMP accepts ISO. */
export function tsToIso(ms: number | null): string | null {
  if (ms === null) return null;
  return new Date(ms).toISOString();
}

/**
 * Shape cleaned events into BigQuery tabledata.insertAll rows. `insertId` gives
 * best-effort streaming dedup; `props` is serialized to a JSON string column so
 * the schema stays flat and stable while keeping the full structured payload.
 */
export function buildInsertRows(
  events: CleanTelemetryEvent[],
  meta: TelemetryServerMeta,
): BigQueryInsertRow[] {
  return events.map((e) => ({
    insertId: e.eventId,
    json: {
      event_id: e.eventId,
      server_ts: meta.serverTsIso,
      client_ts: tsToIso(e.clientTs),
      uid: meta.uid,
      plan: meta.plan,
      event: e.event,
      session_id: e.sessionId || null,
      app_version: meta.appVersion || null,
      platform: meta.platform || null,
      os_version: meta.osVersion || null,
      locale: meta.locale || null,
      props: JSON.stringify(e.props),
    },
  }));
}

// ---------------------------------------------------------------------
// Consent (region) logic — shared shape used by client + server so the two never
// disagree on what a region requires. The client decides the DEFAULT + surfaces
// the notice; the server independently gates writes on the reported consent flag.
// ---------------------------------------------------------------------
export type ConsentRegion = "eu" | "jp" | "other";
export type ConsentMode = "opt_in" | "opt_out" | "notice";

/**
 * EU/EEA (+UK) require prior opt-in for non-essential analytics (ePrivacy/GDPR):
 * default OFF. Japan's 外部送信規律 requires notice + easy opt-out: default ON but
 * disclosed and revocable. Elsewhere: notice, default ON.
 */
const EU_EEA = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
  "GB",
  "CH",
]);

export function consentRegionFor(countryCode: unknown): ConsentRegion {
  const cc = String(countryCode ?? "")
    .trim()
    .toUpperCase();
  if (EU_EEA.has(cc)) return "eu";
  if (cc === "JP") return "jp";
  return "other";
}

export function consentModeFor(region: ConsentRegion): ConsentMode {
  return region === "eu" ? "opt_in" : region === "jp" ? "opt_out" : "notice";
}

/**
 * The DEFAULT telemetry-consent value before the user has chosen: OFF in the EU
 * (opt-in), ON elsewhere (opt-out/notice). Unknown region → fail to the
 * privacy-preserving side (OFF) per the decision record.
 */
export function defaultConsent(region: ConsentRegion): boolean {
  return region !== "eu"; // eu → false; jp/other → true
}
