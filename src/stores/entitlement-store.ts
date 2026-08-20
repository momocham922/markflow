import { create } from "zustand";
import { auth } from "@/services/firebase";
import { useResearchStore } from "@/stores/research-store";

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

// Master switch for the purchase UI. Stays OFF (no CTA anywhere) until the owner
// has created the Stripe account/products and set the server secrets — so the
// paywall can ship dark and be flipped on with one env var once billing is live.
export const BILLING_ENABLED =
  import.meta.env.VITE_BILLING_ENABLED === "true" ||
  import.meta.env.VITE_BILLING_ENABLED === "1";

export type BillingInterval = "month" | "year";

/**
 * Open a Stripe URL in the SYSTEM browser (never a WebView — Stripe forbids
 * embedding Checkout). iOS uses SFSafariViewController so the markflow:// return
 * can dismiss it; desktop/Android use the OS browser. Falls back to window.open
 * on plain web where the Tauri commands are unavailable.
 */
async function openBillingUrl(url: string): Promise<void> {
  try {
    const { isIOS } = await import("@/platform");
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(isIOS ? "open_safari_vc" : "open_external_url", { url });
  } catch (err) {
    console.error(
      "[billing] native open failed, falling back to window.open:",
      err,
    );
    try {
      window.open(url, "_blank", "noopener");
    } catch {
      /* nothing more we can do */
    }
  }
}

/** Map a server/transport error code to a localized, user-facing message. */
function billingErrorMessage(code: string): string {
  switch (code) {
    case "billing_not_configured":
      return "決済は現在準備中です。しばらくお待ちください。";
    case "invalid_plan":
      return "選択したプランは購入できません。";
    case "no_subscription":
      return "有効なサブスクリプションが見つかりません。";
    case "already_subscribed":
      return "すでに有効なプランをご利用中です。変更は「契約を管理」から行えます。";
    case "unauthorized":
      return "サインインが必要です。";
    case "no_checkout_url":
    case "no_portal_url":
      return "決済ページを開けませんでした。時間をおいて再度お試しください。";
    default:
      return "決済の処理に失敗しました。時間をおいて再度お試しください。";
  }
}

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
  /** True while a Checkout/Portal session is being created (spinner + guard). */
  billingBusy: boolean;
  /** Last billing error message (localized upstream), for inline surfacing. */
  billingError: string | null;
  /** Whether the global upgrade/paywall dialog is open. */
  paywallOpen: boolean;
  /** Which metered feature triggered the paywall (for contextual copy). */
  paywallReason: Feature | null;

  fetchEntitlement: () => Promise<void>;
  setViewAs: (plan: ViewAsPlan | null) => Promise<void>;
  resetPreviewUsage: () => Promise<void>;
  reportQuota: (e: Omit<QuotaError, "at">) => void;
  clearQuota: () => void;
  /** Begin a Stripe Checkout for `plan` and open it in the system browser. */
  startCheckout: (
    plan: ViewAsPlan,
    interval?: BillingInterval,
  ) => Promise<void>;
  /** Open the Stripe customer portal (manage/cancel an existing subscription). */
  openBillingPortal: () => Promise<void>;
  /**
   * Poll `/v1/me/entitlement` until the plan changes or the budget is spent —
   * used after returning from Checkout, since the webhook write + the endpoint's
   * per-instance entitlement cache mean the new plan may lag a few seconds.
   */
  pollEntitlement: (opts?: {
    tries?: number;
    intervalMs?: number;
  }) => Promise<void>;
  /** Open the upgrade dialog (no-op when billing is disabled). */
  openPaywall: (reason?: Feature | null) => void;
  /** Close the upgrade dialog. */
  closePaywall: () => void;
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
  billingBusy: false,
  billingError: null,
  paywallOpen: false,
  paywallReason: null,

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
    // Optimistically reflect the switch in effectivePlan (= viewAs ?? realPlan)
    // so client-side capability gates (e.g. the live-research auto gate) flip
    // IMMEDIATELY. Enforcement is per-request via the X-View-As header (or its
    // absence), so the server already honors the new plan on the next AI call;
    // the client must not stay stuck on the old effectivePlan if the follow-up
    // fetch fails offline. The fetch below reconciles against what the server
    // actually honored.
    const newEffective = plan ?? get().realPlan;
    set({
      viewAs: plan,
      effectivePlan: newEffective,
      lastQuotaError: null,
    });
    // Switching to a plan that CAN run auto research clears any stale "auto
    // research is Pro" notice immediately, instead of waiting up to 45s for the
    // next pipeline tick to reassert it (owner-only path; self-heals anyway).
    if (newEffective && newEffective !== "free") {
      useResearchStore.getState().setFeatureGated(false);
    }
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

  startCheckout: async (plan, interval = "month") => {
    if (!BILLING_ENABLED) return;
    const user = auth.currentUser;
    if (!user) {
      set({ billingError: "サインインが必要です。" });
      return;
    }
    // free/internal are not purchasable; guard here too (server also rejects).
    if (plan !== "pro" && plan !== "team") return;
    set({ billingBusy: true, billingError: null });
    try {
      const token = await user.getIdToken();
      const res = await fetch(`${AI_PROXY_URL}/v1/billing/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ plan, interval }),
      });
      if (!res.ok) {
        const body = await res
          .json()
          .catch(() => ({}) as Record<string, unknown>);
        const code =
          typeof body.error === "string" ? body.error : `http_${res.status}`;
        throw new Error(code);
      }
      const data = (await res.json()) as { url?: string };
      if (!data.url) throw new Error("no_checkout_url");
      await openBillingUrl(data.url);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      console.error("[billing] checkout failed:", raw);
      set({ billingError: billingErrorMessage(raw) });
    } finally {
      set({ billingBusy: false });
    }
  },

  openBillingPortal: async () => {
    if (!BILLING_ENABLED) return;
    const user = auth.currentUser;
    if (!user) {
      set({ billingError: "サインインが必要です。" });
      return;
    }
    set({ billingBusy: true, billingError: null });
    try {
      const token = await user.getIdToken();
      const res = await fetch(`${AI_PROXY_URL}/v1/billing/portal`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) {
        const body = await res
          .json()
          .catch(() => ({}) as Record<string, unknown>);
        const code =
          typeof body.error === "string" ? body.error : `http_${res.status}`;
        throw new Error(code);
      }
      const data = (await res.json()) as { url?: string };
      if (!data.url) throw new Error("no_portal_url");
      await openBillingUrl(data.url);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      console.error("[billing] portal failed:", raw);
      set({ billingError: billingErrorMessage(raw) });
    } finally {
      set({ billingBusy: false });
    }
  },

  pollEntitlement: async (opts) => {
    const tries = opts?.tries ?? 20;
    const intervalMs = opts?.intervalMs ?? 3000;
    // Seed the baseline from a FRESH fetch. Before this call effectivePlan can
    // still be null (a failed/one-shot login fetch), and a null→"free" first
    // read would otherwise be mistaken for "the plan changed" — stopping the
    // poll one tick after a purchase while the webhook is still writing "pro",
    // stranding a paying user on Free. If the baseline fetch itself fails
    // (before stays null), we re-seed from the first successful read below.
    await get().fetchEntitlement();
    let before = get().effectivePlan;
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      await get().fetchEntitlement();
      const now = get().effectivePlan;
      if (now == null) continue; // fetch failed; keep waiting
      if (before == null) {
        before = now; // establish the baseline lazily after the first good read
        continue;
      }
      // Stop as soon as the plan actually changes (up OR down). A no-op portal
      // visit (e.g. cancel-at-period-end) just times out harmlessly.
      if (now !== before) return;
    }
  },

  openPaywall: (reason = null) => {
    if (!BILLING_ENABLED) return;
    set({ paywallOpen: true, paywallReason: reason, billingError: null });
  },
  closePaywall: () => set({ paywallOpen: false, paywallReason: null }),

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
      billingBusy: false,
      billingError: null,
      paywallOpen: false,
      paywallReason: null,
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
