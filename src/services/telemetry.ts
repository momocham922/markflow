import { getAuth } from "firebase/auth";
import { isIOS, isAndroid, isMac } from "@/platform";
import { getSetting, setSetting } from "./database";
import { saveUserSettingsToFirestore } from "./firebase";
import {
  type ConsentRegion,
  consentModeFor,
  defaultConsent,
  detectRegion,
} from "./consent-region";

export type { ConsentRegion, ConsentMode } from "./consent-region";
export {
  consentRegionFor,
  consentModeFor,
  defaultConsent,
  detectRegion,
} from "./consent-region";

// =====================================================================
// Product telemetry client — consent-gated, offline-queued, batched.
// ---------------------------------------------------------------------
// Design mirrors the server contract in server/ai-proxy/telemetry.ts:
//   - The client decides the regional DEFAULT + surfaces the notice/opt-in.
//   - The server independently GATES writes on user_settings.telemetry_consent
//     and is authoritative for identity (uid/plan) + PII redaction.
// Events are enqueued to a bounded localStorage queue (durable across restarts
// in WKWebView / WebView2 / web alike — no SQLite migration needed), then
// flushed in batches to /v1/telemetry with the Firebase ID token. The endpoint
// is DARK by default (TELEMETRY_ENABLED unset server-side): it 200-accepts and
// DROPS, so the client queue drains instead of growing unbounded before the
// BigQuery sink is switched on.
//
// track() is fire-and-forget and MUST never throw into a call site — a metrics
// failure can never break a user action.
// =====================================================================

// ---- persistence keys -------------------------------------------------
const K_CONSENT = "telemetry_consent"; // "on" | "off"
const K_DECIDED = "telemetry_consent_decided"; // "1" once the user has chosen
const LS_QUEUE = "mf_telemetry_queue";

const MAX_QUEUE = 1000; // hard cap; oldest dropped on overflow
const BATCH = 50; // matches server MAX_EVENTS_PER_BATCH
const FLUSH_INTERVAL_MS = 20_000;

export interface QueuedEvent {
  id: string;
  event: string;
  ts: number;
  props: Record<string, string | number | boolean>;
  sessionId: string;
}

// ---- module state -----------------------------------------------------
let consentCached = false; // synchronous gate for track()
let decidedCached = false;
let regionCached: ConsentRegion = "other";
let sessionId = "";
let started = false;
let flushing = false;
let flushTimer: ReturnType<typeof setInterval> | null = null;
const consentListeners = new Set<() => void>();

function notifyConsent() {
  for (const fn of consentListeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}
export function onConsentChange(fn: () => void): () => void {
  consentListeners.add(fn);
  return () => consentListeners.delete(fn);
}

function newId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  // Fallback: 24 url-safe chars (satisfies the server /^[A-Za-z0-9_-]{6,64}$/).
  let s = "";
  const alpha =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 24; i++)
    s += alpha[Math.floor(Math.random() * alpha.length)];
  return s;
}

function platformLabel(): string {
  if (isIOS) return "ios";
  if (isAndroid) return "android";
  if (isMac) return "macos";
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent || "";
    if (/Windows/i.test(ua)) return "windows";
    if (/Linux/i.test(ua)) return "linux";
  }
  return "web";
}

// ---- queue (localStorage-backed, bounded) -----------------------------
function readQueue(): QueuedEvent[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(LS_QUEUE);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as QueuedEvent[]) : [];
  } catch {
    return [];
  }
}
function writeQueue(q: QueuedEvent[]) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(LS_QUEUE, JSON.stringify(q));
  } catch {
    /* quota / private mode — telemetry is best-effort */
  }
}
function clearQueue() {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(LS_QUEUE);
  } catch {
    /* ignore */
  }
}

// ---- public consent API ----------------------------------------------
export function getConsent(): boolean {
  return consentCached;
}
export function isConsentDecided(): boolean {
  return decidedCached;
}
export function getConsentRegion(): ConsentRegion {
  return regionCached;
}
export function getConsentMode() {
  return consentModeFor(regionCached);
}

/**
 * Record the user's choice. Persists locally (SQLite settings) for the
 * synchronous gate AND mirrors the boolean to Firestore user_settings so the
 * server can independently enforce it. Turning consent OFF immediately purges
 * any queued events (nothing already collected is sent afterward).
 */
export async function setTelemetryConsent(on: boolean): Promise<void> {
  consentCached = on;
  decidedCached = true;
  try {
    await setSetting(K_CONSENT, on ? "on" : "off");
    await setSetting(K_DECIDED, "1");
  } catch {
    /* local persistence best-effort */
  }
  if (!on) clearQueue();
  notifyConsent();
  // Mirror to the server's source of truth for the consent gate. Best-effort:
  // requires sign-in; a signed-out toggle still holds locally and re-mirrors on
  // the next successful sync.
  try {
    const uid = getAuth().currentUser?.uid;
    if (uid) {
      await saveUserSettingsToFirestore(uid, { telemetry_consent: on });
    }
  } catch {
    /* ignore */
  }
  if (on) void flushTelemetry();
}

/**
 * Load persisted consent (or apply the regional default if undecided) and start
 * the flush loop + lifecycle handlers. Idempotent. If consent is ON and the
 * user is signed in, also (re)mirror the flag to Firestore so a device that
 * inherited a default without ever syncing still opens the server gate.
 */
export async function initTelemetry(): Promise<void> {
  if (started) return;
  started = true;
  sessionId = newId();
  regionCached = detectRegion();
  try {
    const decided = await getSetting(K_DECIDED);
    if (decided === "1") {
      decidedCached = true;
      consentCached = (await getSetting(K_CONSENT)) === "on";
    } else {
      decidedCached = false;
      consentCached = defaultConsent(regionCached);
    }
  } catch {
    decidedCached = false;
    consentCached = defaultConsent(regionCached);
  }
  notifyConsent();

  if (typeof window !== "undefined") {
    // Best-effort final flush when the app is backgrounded / closed.
    const finalFlush = () => {
      void flushTelemetry(true);
    };
    window.addEventListener("pagehide", finalFlush);
    window.addEventListener("beforeunload", finalFlush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") finalFlush();
    });
  }
  flushTimer = setInterval(() => void flushTelemetry(), FLUSH_INTERVAL_MS);

  // A default-consented (jp/other) device that has never synced still needs the
  // server gate opened; mirror once at startup.
  if (consentCached) {
    try {
      const uid = getAuth().currentUser?.uid;
      if (uid)
        await saveUserSettingsToFirestore(uid, { telemetry_consent: true });
    } catch {
      /* ignore */
    }
    void flushTelemetry();
  }

  // initTelemetry() runs at mount, BEFORE auth resolves (onAuthStateChanged is
  // async), so the startup mirror above usually finds no user. Re-mirror when
  // auth first resolves so an opt-out-region user who never opens the banner
  // still opens the server-side consent gate — and drain any queue collected
  // pre-sign-in. Only writes when consent is ON: an EU opt-in user's default is
  // OFF, so `true` is never written for them without an explicit choice.
  try {
    getAuth().onAuthStateChanged((u) => {
      if (u && consentCached) {
        void saveUserSettingsToFirestore(u.uid, {
          telemetry_consent: true,
        }).catch(() => {});
        void flushTelemetry();
      }
    });
  } catch {
    /* ignore */
  }
}

// ---- track ------------------------------------------------------------
/**
 * Record a product event. Fire-and-forget: never throws, never blocks. No-op
 * when the user has not consented. `props` must be a small map of scalars; the
 * server re-sanitizes and PII-redacts, but we keep it clean here too.
 */
export function track(
  event: string,
  props: Record<string, unknown> = {},
): void {
  try {
    if (!consentCached) return;
    const name = String(event || "").trim();
    if (!name) return;
    const clean: Record<string, string | number | boolean> = {};
    let n = 0;
    for (const [k, v] of Object.entries(props)) {
      if (n >= 25) break;
      if (typeof v === "boolean") clean[k] = v;
      else if (typeof v === "number" && Number.isFinite(v)) clean[k] = v;
      else if (typeof v === "string") clean[k] = v.slice(0, 500);
      else continue;
      n++;
    }
    const q = readQueue();
    q.push({
      id: newId(),
      event: name,
      ts: Date.now(),
      props: clean,
      sessionId,
    });
    // Bound the queue: drop the OLDEST on overflow.
    if (q.length > MAX_QUEUE) q.splice(0, q.length - MAX_QUEUE);
    writeQueue(q);
    if (q.length >= BATCH) void flushTelemetry();
  } catch {
    /* telemetry must never break a call site */
  }
}

// ---- flush ------------------------------------------------------------
/**
 * Send queued events in one batch. Removes only the events the server accepted
 * (kept-on-failure so an offline/5xx retries later). `final` uses fetch
 * keepalive so an in-flight page-hide flush still completes.
 */
export async function flushTelemetry(final = false): Promise<void> {
  if (flushing) return;
  if (!consentCached) return;
  const proxyBase = import.meta.env.VITE_AI_PROXY_URL || "";
  if (!proxyBase) return;
  const user = getAuth().currentUser;
  if (!user) return; // no token → can't attribute; retry after sign-in
  const q = readQueue();
  if (q.length === 0) return;

  flushing = true;
  try {
    const batch = q.slice(0, BATCH);
    let token: string;
    try {
      token = await user.getIdToken();
    } catch {
      return; // token unavailable → keep queue, retry later
    }
    const ctx = {
      appVersion: __APP_VERSION__,
      platform: platformLabel(),
      osVersion:
        typeof navigator !== "undefined"
          ? (navigator.userAgent || "").slice(0, 120)
          : "",
      locale: typeof navigator !== "undefined" ? navigator.language || "" : "",
    };
    let res: Response;
    try {
      res = await fetch(`${proxyBase}/v1/telemetry`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          events: batch.map((e) => ({
            id: e.id,
            event: e.event,
            ts: e.ts,
            props: e.props,
            sessionId: e.sessionId,
          })),
          context: ctx,
        }),
        keepalive: final,
      });
    } catch {
      return; // network error → keep queue
    }
    // 2xx (incl. dark accept-and-drop) → the server has taken responsibility for
    // this batch; remove it. 4xx (bad request, not 401) → drop too, else it
    // wedges the queue forever. 401/5xx → keep for retry.
    if (
      res.ok ||
      (res.status >= 400 && res.status < 500 && res.status !== 401)
    ) {
      const rest = readQueue().slice(batch.length);
      if (rest.length > 0) writeQueue(rest);
      else clearQueue();
      // Drain the rest promptly if a large backlog remains.
      if (rest.length >= BATCH && !final) {
        flushing = false;
        void flushTelemetry();
        return;
      }
    }
    // 401 (token rejected) / 5xx → keep the batch, retry on the next tick.
  } finally {
    flushing = false;
  }
}

/** Test / teardown helper. */
export function _stopTelemetry(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  started = false;
}
