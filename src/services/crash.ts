import * as Sentry from "@sentry/react";
import { getAuth } from "firebase/auth";
import { isIOS, isAndroid, isMac } from "@/platform";
import { getConsent, onConsentChange } from "./telemetry";
import {
  environmentName,
  scrubEvent,
  shouldInit,
  type ScrubbableEvent,
} from "./crash-logic";

// =====================================================================
// Crash / error reporting client — GlitchTip (Sentry-SDK-compatible).
// ---------------------------------------------------------------------
// Backend is a self-hosted GlitchTip instance on Cloud Run; the DSN is
// injected at build time via VITE_GLITCHTIP_DSN. When that env is UNSET the
// whole module is DARK: init() no-ops and nothing is ever sent. This lets us
// ship the integration ahead of the backend go-live and flip it on by simply
// building with the DSN present.
//
// Privacy: crash reporting is gated on the SAME consent as product telemetry
// (services/consent-region.ts). A user who opts out of analytics also sends no
// crash reports. Document contents / titles are NEVER attached — we scrub
// request bodies, cookies, headers and query strings in beforeSend, and only
// ever set the Firebase uid (not email) as the user identifier.
//
// Every public function is wrapped so a reporting failure can never break the
// app — mirrors the fire-and-forget contract of services/telemetry.ts.
// =====================================================================

const DSN = import.meta.env.VITE_GLITCHTIP_DSN || "";

let initialized = false;
let authUnsub: (() => void) | null = null;

function appVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
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

/**
 * Start crash reporting. Idempotent. No-op unless a DSN was compiled in AND the
 * user has consented. Safe to call repeatedly (e.g. after a consent toggle).
 */
export function initCrashReporting(): void {
  try {
    if (initialized) return;
    // DARK build guard + privacy-first consent gate (pure, unit-tested).
    if (!shouldInit(DSN, getConsent())) return;

    Sentry.init({
      dsn: DSN,
      release: `markflow@${appVersion() || "0"}`,
      environment: environmentName(appVersion()),
      // Errors/crashes only — no performance tracing, no session replay.
      tracesSampleRate: 0,
      sampleRate: 1.0,
      sendDefaultPii: false,
      // Keep the queue small; this is a desktop/mobile app, not a busy server.
      maxBreadcrumbs: 50,
      // Privacy at the SOURCE: the default Breadcrumbs integration records
      // every console.* call (can embed document text), DOM interaction (CSS
      // selectors carry aria-label/title values) and history navigation (URLs
      // carry share-token fragments). Disable all three so that content never
      // enters the breadcrumb trail. scrubEvent() is the defense-in-depth
      // backstop if this ever regresses.
      integrations: (defaults) =>
        defaults.map((i) =>
          i.name === "Breadcrumbs"
            ? Sentry.breadcrumbsIntegration({
                console: false,
                dom: false,
                history: false,
              })
            : i,
        ),
      beforeSend(event) {
        // Strip document content, auth tokens and PII before the event leaves
        // the device. scrubEvent is pure + unit-tested and never throws.
        return scrubEvent(
          event as unknown as ScrubbableEvent,
        ) as unknown as typeof event;
      },
    });
    Sentry.setTag("platform", platformLabel());
    initialized = true;

    // Correlate crashes with the signed-in user (uid only — never email).
    try {
      const auth = getAuth();
      if (auth.currentUser) Sentry.setUser({ id: auth.currentUser.uid });
      authUnsub = auth.onAuthStateChanged((u) => {
        try {
          Sentry.setUser(u ? { id: u.uid } : null);
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* firebase not ready — user context is best-effort */
    }
  } catch {
    /* crash reporting must never break the app */
  }
}

/** Update the crash-report user context (uid only). */
export function setCrashUser(uid: string | null): void {
  try {
    if (!initialized) return;
    Sentry.setUser(uid ? { id: uid } : null);
  } catch {
    /* ignore */
  }
}

/**
 * Manually report a handled error (e.g. a caught background-task failure that
 * we still want visibility into). No-op when reporting is not active.
 */
export function reportError(
  err: unknown,
  context?: Record<string, unknown>,
): void {
  try {
    if (!initialized) return;
    Sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    /* ignore */
  }
}

/** Stop crash reporting and flush any pending events (on consent withdrawal). */
export function closeCrashReporting(): void {
  try {
    if (!initialized) return;
    initialized = false;
    if (authUnsub) {
      authUnsub();
      authUnsub = null;
    }
    void Sentry.close(2000);
  } catch {
    /* ignore */
  }
}

// React to consent changes for the lifetime of the app: start when granted,
// stop + flush when revoked. Registered once at module load; the callback is a
// no-op while DSN is unset (DARK build).
try {
  onConsentChange(() => {
    if (getConsent()) initCrashReporting();
    else closeCrashReporting();
  });
} catch {
  /* ignore */
}
