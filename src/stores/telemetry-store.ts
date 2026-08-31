import { create } from "zustand";
import {
  getConsent,
  isConsentDecided,
  getConsentRegion,
  getConsentMode,
  onConsentChange,
  setTelemetryConsent,
  initTelemetry,
  type ConsentRegion,
  type ConsentMode,
} from "@/services/telemetry";

// =====================================================================
// Reactive mirror of the telemetry consent state.
// ---------------------------------------------------------------------
// services/telemetry.ts owns the authoritative module state (a synchronous
// `consentCached` gate that track() reads on every call). This store is a thin
// React-facing mirror so the consent banner + the UserMenu toggle re-render
// when consent changes — it never becomes a second source of truth. All writes
// go through the service (setTelemetryConsent), which persists + mirrors to
// Firestore, then notifies listeners; we refresh from the service on notify.
// =====================================================================

interface TelemetryState {
  /** Whether the user currently allows analytics collection. */
  consent: boolean;
  /** Whether the user has made an explicit choice (vs. the regional default). */
  decided: boolean;
  region: ConsentRegion;
  mode: ConsentMode;
  /** True once initTelemetry() has resolved and the mirror is populated. */
  ready: boolean;
  /** Idempotently boot the telemetry service + start mirroring its state. */
  init: () => Promise<void>;
  /** Persist an explicit consent choice (dismisses the banner). */
  setConsent: (on: boolean) => Promise<void>;
  /** Pull the latest values from the service into the store. */
  refresh: () => void;
}

let subscribed = false;

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  consent: false,
  decided: false,
  region: "other",
  mode: "notice",
  ready: false,

  refresh: () =>
    set({
      consent: getConsent(),
      decided: isConsentDecided(),
      region: getConsentRegion(),
      mode: getConsentMode(),
    }),

  init: async () => {
    if (!subscribed) {
      subscribed = true;
      // Subscribe BEFORE initTelemetry so the startup notify (which applies the
      // regional default when undecided) is captured into the mirror.
      onConsentChange(() => get().refresh());
    }
    if (get().ready) return;
    try {
      await initTelemetry();
    } finally {
      get().refresh();
      set({ ready: true });
    }
  },

  setConsent: async (on) => {
    await setTelemetryConsent(on);
    get().refresh();
  },
}));
