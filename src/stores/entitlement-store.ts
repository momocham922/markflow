import { create } from "zustand";
import { auth } from "@/services/firebase";

// =====================================================================
// Entitlement / plan state (monetization P0 — client side)
// ---------------------------------------------------------------------
// Single source of truth for the UI is the ai-proxy endpoint
// `/v1/me/entitlement`, NOT Firestore directly. The endpoint applies the
// same PLAN_LIMITS + owner view-as logic the server enforces on every AI
// call, so what the UI shows always matches what the server will allow.
//
// `viewAs` is the OWNER-ONLY preview override (三田遼平 only). It is honored
// server-side exclusively for OWNER_UIDS; for anyone else the server ignores
// the X-View-As header and returns viewAs:null, which we reconcile back into
// this store — so a stale localStorage value can never leak a fake plan view.
// =====================================================================
export type Plan = "free" | "pro" | "team" | "internal";
export type ViewAsPlan = Exclude<Plan, "internal">; // free | pro | team
export type Feature = "aiCalls" | "sttCalls" | "batchMin" | "images";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";
const VIEW_AS_KEY = "markflow_view_as";

const ZERO_USAGE: Record<Feature, number> = {
  aiCalls: 0,
  sttCalls: 0,
  batchMin: 0,
  images: 0,
};

function loadPersistedViewAs(): ViewAsPlan | null {
  try {
    const v = localStorage.getItem(VIEW_AS_KEY);
    return v === "free" || v === "pro" || v === "team" ? v : null;
  } catch {
    return null;
  }
}

function persistViewAs(plan: ViewAsPlan | null) {
  try {
    if (plan) localStorage.setItem(VIEW_AS_KEY, plan);
    else localStorage.removeItem(VIEW_AS_KEY);
  } catch {
    /* localStorage unavailable */
  }
}

export interface QuotaError {
  feature: Feature;
  plan: Plan;
  limit: number;
  used: number;
  at: number;
}

interface EntitlementState {
  /** Real plan ignoring any owner preview (internal for staff/owner). */
  realPlan: Plan | null;
  /** Plan the server is actually enforcing this session (= viewAs ?? realPlan). */
  effectivePlan: Plan | null;
  /** Owner-only preview target; null = show real plan. */
  viewAs: ViewAsPlan | null;
  /** True only for OWNER_UIDS (三田遼平) — gates the view-as switcher UI. */
  isOwner: boolean;
  /** Monthly limits for effectivePlan; null = unlimited (internal). */
  limits: Record<Feature, number> | null;
  usage: Record<Feature, number>;
  period: string | null;
  loading: boolean;
  loaded: boolean;
  /** Last 429 quota_exceeded surfaced by an AI call, for upsell UI. */
  lastQuotaError: QuotaError | null;

  fetchEntitlement: () => Promise<void>;
  setViewAs: (plan: ViewAsPlan | null) => Promise<void>;
  resetPreviewUsage: () => Promise<void>;
  reportQuota: (e: Omit<QuotaError, "at">) => void;
  clearQuota: () => void;
  reset: () => void;
}

export const useEntitlementStore = create<EntitlementState>((set, get) => ({
  realPlan: null,
  effectivePlan: null,
  viewAs: loadPersistedViewAs(),
  isOwner: false,
  limits: null,
  usage: { ...ZERO_USAGE },
  period: null,
  loading: false,
  loaded: false,
  lastQuotaError: null,

  fetchEntitlement: async () => {
    const user = auth.currentUser;
    if (!user) return;
    set({ loading: true });
    try {
      const token = await user.getIdToken();
      const viewAs = get().viewAs;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      if (viewAs) headers["X-View-As"] = viewAs;
      const res = await fetch(`${AI_PROXY_URL}/v1/me/entitlement`, {
        method: "POST",
        headers,
      });
      if (!res.ok) throw new Error(`entitlement ${res.status}`);
      const d = await res.json();
      // Reconcile viewAs with what the server actually honored (null for a
      // non-owner), so a stale localStorage value can't fake a plan view.
      const honored: ViewAsPlan | null =
        d.viewAs === "free" || d.viewAs === "pro" || d.viewAs === "team"
          ? d.viewAs
          : null;
      persistViewAs(honored);
      set({
        realPlan: (d.realPlan as Plan) ?? null,
        effectivePlan: (d.effectivePlan as Plan) ?? null,
        viewAs: honored,
        isOwner: !!d.isOwner,
        limits: d.limits ?? null,
        usage: d.usage ? { ...ZERO_USAGE, ...d.usage } : { ...ZERO_USAGE },
        period: d.period ?? null,
        loaded: true,
        loading: false,
      });
    } catch (err) {
      console.error("[entitlement] fetch failed:", err);
      // If a PRIOR fetch already confirmed this user is NOT the owner, drop any
      // lingering viewAs so we stop sending a pointless (server-ignored)
      // X-View-As header while offline. An owner's preview (loaded && isOwner)
      // and the pre-first-fetch state (loaded === false) are left untouched.
      const s = get();
      if (s.loaded && !s.isOwner && s.viewAs) {
        persistViewAs(null);
        set({ viewAs: null, loading: false });
      } else {
        set({ loading: false });
      }
    }
  },

  setViewAs: async (plan) => {
    persistViewAs(plan);
    set({ viewAs: plan, lastQuotaError: null });
    await get().fetchEntitlement();
  },

  resetPreviewUsage: async () => {
    const user = auth.currentUser;
    if (!user) return;
    try {
      const token = await user.getIdToken();
      await fetch(`${AI_PROXY_URL}/v1/dev/reset-usage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (err) {
      console.error("[entitlement] reset usage failed:", err);
    }
    set({ lastQuotaError: null });
    await get().fetchEntitlement();
  },

  reportQuota: (e) => set({ lastQuotaError: { ...e, at: Date.now() } }),
  clearQuota: () => set({ lastQuotaError: null }),

  reset: () =>
    set({
      realPlan: null,
      effectivePlan: null,
      isOwner: false,
      limits: null,
      usage: { ...ZERO_USAGE },
      period: null,
      loaded: false,
      loading: false,
      lastQuotaError: null,
      // viewAs is intentionally kept (persisted); it is owner-only and gets
      // reconciled to null on the next fetch if the next user is not the owner.
    }),
}));

/** Human-readable label for a plan (Japanese UI). */
export function planLabel(plan: Plan | null): string {
  switch (plan) {
    case "internal":
      return "内部テスター";
    case "pro":
      return "Pro";
    case "team":
      return "Team";
    case "free":
      return "Free";
    default:
      return "—";
  }
}

/** Human-readable label for a metered feature (Japanese UI). */
export function featureLabel(feature: Feature): string {
  switch (feature) {
    case "aiCalls":
      return "AIリクエスト";
    case "sttCalls":
      return "音声認識";
    case "batchMin":
      return "文字起こし（分）";
    case "images":
      return "画像生成";
    default:
      return feature;
  }
}
