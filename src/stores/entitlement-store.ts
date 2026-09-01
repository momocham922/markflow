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
// The plan a Checkout is in flight for, persisted so it survives the process
// being OS-killed while the external Checkout browser is foregrounded (common on
// mobile). Without it, a cold relaunch on markflow://billing/success would poll
// with no target and could latch a just-upgraded payer on a transient stale Free.
const PENDING_CHECKOUT_KEY = "markflow_pending_checkout";

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
async function openBillingUrl(url: string): Promise<boolean> {
  try {
    const { isIOS } = await import("@/platform");
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(isIOS ? "open_safari_vc" : "open_external_url", { url });
    return true;
  } catch (err) {
    console.error(
      "[billing] native open failed, falling back to window.open:",
      err,
    );
    try {
      // window.open returns null when blocked (e.g. popup blocker on plain web,
      // or the user-activation window lost after our awaits). Treat that as a
      // failure so the caller can surface it — never a silent no-op.
      const w = window.open(url, "_blank", "noopener");
      return w != null;
    } catch {
      return false;
    }
  }
}

/**
 * Open the STORE-native subscription-management surface for an IAP subscription.
 * Apple and Google REQUIRE their in-app subscriptions be cancelled/changed through
 * their own system UI — the Stripe customer portal has no record of them, so
 * routing an IAP subscriber there is a dead end. We hand the store deep-link to
 * the OS opener (NOT SFSafariViewController) so iOS resolves the itms-apps://
 * scheme straight to Settings › Subscriptions and Android routes the Play link
 * into the Play app; the https forms are the web fallbacks when managed from a
 * desktop where the buyer happens to hold a store subscription.
 */
async function openStoreSubscriptions(
  source: "app_store" | "play",
): Promise<boolean> {
  const { isIOS } = await import("@/platform");

  // iOS: prefer StoreKit 2's native manage-subscriptions sheet
  // (AppStore.showManageSubscriptions). This is the ONLY surface that lists an
  // IAP subscription for a real-Apple-ID TestFlight/sandbox tester — such subs
  // never appear under Settings › Subscriptions, so the itms-apps:// deep link
  // is a dead end for testers. Production subscribers see it in both places.
  if (source === "app_store" && isIOS) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("plugin:iap|show_manage_subscriptions");
      return true;
    } catch (err) {
      // Fall through to the itms-apps:// deep link (pre-iOS-15 / no scene / etc.).
      console.warn(
        "[billing] native manage subscriptions failed, falling back to deep link:",
        err,
      );
    }
  }

  let url: string;
  if (source === "app_store") {
    url = isIOS
      ? "itms-apps://apps.apple.com/account/subscriptions"
      : "https://apps.apple.com/account/subscriptions";
  } else {
    url = "https://play.google.com/store/account/subscriptions";
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // System open (openURL/opener) — handles itms-apps:// and the Play intent,
    // unlike SFSafariViewController which only takes http/https.
    await invoke("open_external_url", { url });
    return true;
  } catch (err) {
    console.error("[billing] store subscriptions open failed:", err);
    try {
      const w = window.open(url, "_blank", "noopener");
      return w != null;
    } catch {
      return false;
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
    case "payment_required":
      return "以前のサブスクリプションのお支払いが未完了です。お支払い方法の更新ページを開きます。";
    case "unauthorized":
      return "サインインが必要です。";
    case "no_checkout_url":
    case "no_portal_url":
      return "決済ページを開けませんでした。時間をおいて再度お試しください。";
    case "store_manage_failed":
      return "サブスクリプション管理画面を開けませんでした。デバイスの設定アプリからも変更できます。";
    // --- Team seat billing ---
    case "team_id_required":
      return "対象のチームを選択してください。";
    case "team_not_found":
      return "チームが見つかりません。";
    case "not_team_manager":
      return "席の管理はチームのオーナーまたは管理者のみ行えます。";
    case "invalid_seats":
      return "席数が正しくありません。1以上の人数を指定してください。";
    case "no_active_subscription":
      return "このチームには有効なTeamプランがありません。先にご購入ください。";
    case "seat_assignments_required":
      return "割り当てるメンバーを指定してください。";
    case "not_team_member":
      return "チームに参加していないユーザーには席を割り当てられません。";
    // --- Mobile In-App Purchase (StoreKit / Play Billing) ---
    case "iap_not_configured":
      return "アプリ内課金は現在準備中です。しばらくお待ちください。";
    case "sandbox_not_allowed":
      return "サンドボックス（テスト）購入は現在このアカウントでは有効化されていません。";
    case "owned_by_other_account":
      return "この端末のサブスクリプションは別のアカウントで登録済みです。購入時のアカウントでログインしてご利用ください。";
    case "no_receipt":
    case "no_purchase_token":
    case "missing_jws":
    case "missing_purchase_token":
      return "購入情報を取得できませんでした。もう一度お試しください。";
    case "invalid_transaction":
    case "unknown_status":
    case "unmapped_product":
      return "この購入を確認できませんでした。時間をおいて再度お試しください。";
    case "verify_retry":
      return "購入の確認に一時的に失敗しました。通信状況を確認して、もう一度お試しください。";
    case "unsupported_platform":
      return "このプラットフォームではアプリ内課金を利用できません。";
    case "team_mobile_unavailable":
      return "Teamプランのご購入はデスクトップ版またはWebからお願いします。モバイルアプリではProプランのみご購入いただけます。";
    case "purchase_failed":
    case "verify_failed":
      return "購入処理に失敗しました。時間をおいて再度お試しください。";
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

/** Purchasable plans only (pro/team). Used to validate the persisted target. */
function loadPendingCheckout(): "pro" | "team" | null {
  try {
    const v = localStorage.getItem(PENDING_CHECKOUT_KEY);
    return v === "pro" || v === "team" ? v : null;
  } catch {
    return null;
  }
}

function persistPendingCheckout(plan: "pro" | "team" | null) {
  try {
    if (plan) localStorage.setItem(PENDING_CHECKOUT_KEY, plan);
    else localStorage.removeItem(PENDING_CHECKOUT_KEY);
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
  /**
   * Paid seat count of the POOL the server is metering this user against. For a
   * Team owner/member this is the team's funded seat count (limits already scaled
   * by it); for free/pro/internal it is 1. Purely informational for the UI.
   */
  seats: number;
  period: string | null;
  /**
   * Billing rail that owns THIS user's subscription (stripe / app_store / play /
   * founder), or null for free / an assigned team member. Drives where "契約を管理"
   * sends the user: Stripe's customer portal has NO record of an Apple/Google IAP
   * subscription, so an IAP subscriber must be routed to the store's own
   * management surface instead (openBillingPortal branches on this).
   */
  source: string | null;
  /**
   * When the current paid subscription's period ends / next renews, in epoch
   * MILLISECONDS (server sends seconds→ms). null for free / internal / an
   * assigned team member (no own subscription). Shown in the usage view so a
   * subscriber can see their renewal (or, after cancel, expiry) date.
   */
  expiresDate: number | null;
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
  /**
   * Whether the global team-management dialog is open. Team billing (buying seats,
   * changing the count, assigning members) lives there — the Paywall's Team card
   * routes here because a Team purchase needs a concrete team context (teamId),
   * which the generic paywall has none of.
   */
  teamManageOpen: boolean;
  /**
   * The plan the user is currently checking out (set when the Checkout browser
   * opens, cleared once the entitlement reaches it). The billing-return handler
   * passes this as pollEntitlement's `target` so the poll waits for the PURCHASED
   * plan specifically, instead of stopping on any transient plan change.
   */
  pendingCheckoutPlan: ViewAsPlan | null;

  fetchEntitlement: () => Promise<void>;
  setViewAs: (plan: ViewAsPlan | null) => Promise<void>;
  resetPreviewUsage: () => Promise<void>;
  reportQuota: (e: Omit<QuotaError, "at">) => void;
  clearQuota: () => void;
  /**
   * Begin a Stripe Checkout for `plan` and open it in the system browser. Team
   * checkout REQUIRES `opts.teamId` (the funded team) and `opts.seats` (item
   * quantity = paid seat count); Pro ignores both.
   */
  startCheckout: (
    plan: ViewAsPlan,
    interval?: BillingInterval,
    opts?: { teamId?: string; seats?: number },
  ) => Promise<void>;
  /**
   * Change the PAID seat count of a team's live subscription (owner/admin only).
   * Drives Stripe; the webhook reconciles teams/{teamId}.billing.seats. Returns
   * the outcome so the caller (TeamManageDialog) can surface failures inline.
   */
  changeTeamSeats: (
    teamId: string,
    seats: number,
  ) => Promise<{ ok: boolean; error?: string; seats?: number }>;
  /**
   * Replace WHO holds the team's seats — an ORDERED uid list; the first `seats`
   * get the shared pool (owner/admin only). Pure Firestore, no money. Returns the
   * server-normalized list so the caller can reconcile its local view.
   */
  assignTeamSeats: (
    teamId: string,
    seatAssignments: string[],
  ) => Promise<{ ok: boolean; error?: string; seatAssignments?: string[] }>;
  /** Clear the pending-checkout target (store + persisted copy). */
  clearPendingCheckout: () => void;
  /**
   * Open the Stripe customer portal (manage/cancel an existing subscription).
   * Returns the outcome so a caller OUTSIDE the paywall dialog (e.g. the
   * UserMenu "契約を管理" entry) can surface the failure itself — billingError is
   * only rendered inside PaywallDialog, so a portal failure there would be a
   * silent dead button (a user trying to CANCEL must never be left with no
   * feedback). The dialog path keeps using the inline billingError.
   */
  openBillingPortal: () => Promise<{ ok: boolean; error?: string }>;
  /**
   * Poll `/v1/me/entitlement` until the plan reaches `target` (or higher), or —
   * when no target is given (portal return) — until it changes at all, or the
   * budget is spent. Used after returning from Checkout/Portal, since the webhook
   * write + the endpoint's per-instance entitlement cache mean the new plan may
   * lag a few seconds. Passing `target` prevents a transient downward/stale read
   * (e.g. a cross-instance cache still serving Free) from stopping the poll and
   * latching a paying user on Free.
   */
  pollEntitlement: (opts?: {
    tries?: number;
    intervalMs?: number;
    target?: ViewAsPlan | null;
  }) => Promise<void>;
  /** Open the upgrade dialog (no-op when billing is disabled). */
  openPaywall: (reason?: Feature | null) => void;
  /** Close the upgrade dialog. */
  closePaywall: () => void;
  /** Open the global team-management dialog (closes the paywall if open). */
  openTeamManage: () => void;
  /** Close the global team-management dialog. */
  closeTeamManage: () => void;
  reset: () => void;
}

export const useEntitlementStore = create<EntitlementState>((set, get) => ({
  realPlan: null,
  effectivePlan: null,
  viewAs: loadPersistedViewAs(),
  isOwner: false,
  limits: null,
  usage: { ...ZERO_USAGE },
  seats: 1,
  period: null,
  source: null,
  expiresDate: null,
  loading: false,
  loaded: false,
  lastQuotaError: null,
  billingBusy: false,
  billingError: null,
  paywallOpen: false,
  paywallReason: null,
  teamManageOpen: false,
  // Seed from localStorage so a checkout target survives a cold relaunch (the
  // process can be OS-killed while the external Checkout browser is foreground).
  pendingCheckoutPlan: loadPendingCheckout(),

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
        seats: Math.max(1, Math.floor(Number(d.seats) || 1)),
        period: d.period ?? null,
        source: typeof d.source === "string" ? d.source : null,
        expiresDate:
          typeof d.expiresDate === "number" && d.expiresDate > 0
            ? d.expiresDate
            : null,
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

  clearPendingCheckout: () => {
    persistPendingCheckout(null);
    set({ pendingCheckoutPlan: null });
  },

  startCheckout: async (plan, interval = "month", opts) => {
    if (!BILLING_ENABLED) return;
    const user = auth.currentUser;
    if (!user) {
      set({ billingError: "サインインが必要です。" });
      return;
    }
    // free/internal are not purchasable; guard here too (server also rejects).
    if (plan !== "pro" && plan !== "team") return;

    // On mobile the stores REQUIRE their own IAP rails (Apple/Google forbid
    // routing digital-goods payments through an external processor like Stripe),
    // so a mobile purchase goes through the native StoreKit/Play sheet and the
    // server's /v1/billing/iap/verify — never the Stripe checkout URL. Mobile IAP
    // is Pro-only: Team is per-seat and sold on desktop/web (Stripe) only — there
    // is no Team SKU in App Store Connect / Play — so a mobile Team request fails
    // loudly here instead of launching a purchase for a SKU that does not exist.
    // Desktop/web fall through to Stripe.
    try {
      const { isMobile } = await import("@/platform");
      if (isMobile) {
        if (plan === "team") {
          set({ billingError: billingErrorMessage("team_mobile_unavailable") });
          return;
        }
        set({ billingBusy: true, billingError: null });
        const { purchaseMobileSubscription } =
          await import("@/services/mobile-billing");
        const r = await purchaseMobileSubscription(plan, interval);
        if (r.ok) {
          set({ paywallOpen: false, paywallReason: null });
          // The server has already written the entitlement; poll until the
          // endpoint's per-instance cache reflects the purchased plan.
          await get().pollEntitlement({ target: plan });
        } else if (r.error !== "purchase_canceled") {
          set({ billingError: billingErrorMessage(r.error) });
        }
        set({ billingBusy: false });
        return;
      }
    } catch (err) {
      console.error("[billing] mobile purchase failed:", err);
      set({
        billingError: billingErrorMessage("purchase_failed"),
        billingBusy: false,
      });
      return;
    }

    // Team checkout (Stripe) needs a concrete team context (the funded team) and
    // a seat count; the server rejects a team checkout without them. Guard
    // client-side so we fail loudly with a clear message instead of a raw error.
    if (plan === "team") {
      const teamId = String(opts?.teamId ?? "").trim();
      if (!teamId) {
        set({ billingError: billingErrorMessage("team_id_required") });
        return;
      }
    }
    set({ billingBusy: true, billingError: null });

    try {
      const token = await user.getIdToken();
      const teamId = String(opts?.teamId ?? "").trim();
      const seats = Math.max(1, Math.floor(Number(opts?.seats) || 1));
      const res = await fetch(`${AI_PROXY_URL}/v1/billing/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(
          plan === "team"
            ? { plan, interval, teamId, seats }
            : { plan, interval },
        ),
      });
      if (!res.ok) {
        const body = await res
          .json()
          .catch(() => ({}) as Record<string, unknown>);
        const code =
          typeof body.error === "string" ? body.error : `http_${res.status}`;
        // A live-but-unpaid/paused subscription can't open a SECOND checkout (it
        // would double-charge once the old one resumes) — the user must fix
        // payment on the EXISTING sub. Route them straight to the billing portal
        // instead of a dead-end "already subscribed" error they can't act on.
        if (code === "payment_required") {
          const r = await get().openBillingPortal();
          if (r.ok) set({ billingError: billingErrorMessage(code) });
          return;
        }
        throw new Error(code);
      }
      const data = (await res.json()) as { url?: string };
      if (!data.url) throw new Error("no_checkout_url");
      // Open the Checkout browser FIRST; only on a CONFIRMED open do we record
      // the purchase target and dismiss the paywall. If the open fails (popup
      // blocked / no browser), surface an error and keep the paywall up — never a
      // silent no-op (the paywall is the only surface that renders billingError).
      const opened = await openBillingUrl(data.url);
      if (!opened) throw new Error("no_checkout_url");
      set({
        pendingCheckoutPlan: plan,
        paywallOpen: false,
        paywallReason: null,
      });
      persistPendingCheckout(plan);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      console.error("[billing] checkout failed:", raw);
      set({ billingError: billingErrorMessage(raw) });
    } finally {
      set({ billingBusy: false });
    }
  },

  openBillingPortal: async () => {
    // Managing/cancelling an EXISTING subscription must work even while the
    // purchase UI is dark (BILLING_ENABLED=false): a paid user (esp. an IAP
    // subscriber routed to the store's own management surface below) must never be
    // trapped unable to cancel. Only block when billing is dark AND the user is
    // not currently on a paid plan.
    const plan = get().effectivePlan;
    const isPaid = plan === "pro" || plan === "team";
    if (!BILLING_ENABLED && !isPaid)
      return { ok: false, error: "決済は現在準備中です。" };
    const user = auth.currentUser;
    if (!user) {
      const msg = "サインインが必要です。";
      set({ billingError: msg });
      return { ok: false, error: msg };
    }
    // IAP subscriptions (Apple / Google) live ONLY in the store — the Stripe
    // customer portal has no record of them, so /v1/billing/portal would fail
    // (no_customer). Route an IAP subscriber to the store's own management UI,
    // which Apple/Google mandate for cancelling or changing an IAP sub.
    const source = get().source;
    if (source === "app_store" || source === "play") {
      set({ billingBusy: true, billingError: null });
      try {
        const opened = await openStoreSubscriptions(source);
        // A failed open is a failure, never a silent success — a user trying to
        // cancel must get feedback (サイレントフォールバック禁止).
        if (!opened) throw new Error("store_manage_failed");
        // iOS's native manage sheet (AppStore.showManageSubscriptions) resolves
        // only AFTER the customer dismisses it, so re-pull the entitlement now: a
        // cancellation that already took effect (e.g. an accelerated sandbox sub
        // that has expired) flips the CTA from "現在のプラン" to the upgrade CTA
        // immediately instead of showing a stale plan. A mid-period cancel
        // legitimately stays paid until expiry — the foreground re-fetch (App.tsx
        // visibilitychange) then catches the later downgrade when the user
        // returns to the app. Fire-and-forget so the manage flow returns promptly
        // and billingBusy clears; fetchEntitlement drives its own loading flag.
        void get().fetchEntitlement();
        return { ok: true };
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        console.error("[billing] store manage failed:", raw);
        const msg = billingErrorMessage(raw);
        set({ billingError: msg });
        return { ok: false, error: msg };
      } finally {
        set({ billingBusy: false });
      }
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
      // Mirror startCheckout: a failed browser open (popup blocked / lost
      // user-activation) is a failure, never a silent success. Otherwise a user
      // trying to manage/cancel would be told the page is opening when nothing did
      // (サイレントフォールバック禁止).
      const opened = await openBillingUrl(data.url);
      if (!opened) throw new Error("no_portal_url");
      return { ok: true };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      console.error("[billing] portal failed:", raw);
      const msg = billingErrorMessage(raw);
      set({ billingError: msg });
      return { ok: false, error: msg };
    } finally {
      set({ billingBusy: false });
    }
  },

  changeTeamSeats: async (teamId, seats) => {
    if (!BILLING_ENABLED) return { ok: false, error: "決済は現在準備中です。" };
    const user = auth.currentUser;
    if (!user) {
      const msg = "サインインが必要です。";
      return { ok: false, error: msg };
    }
    const tid = String(teamId ?? "").trim();
    const n = Math.max(1, Math.floor(Number(seats) || 0));
    if (!tid)
      return { ok: false, error: billingErrorMessage("team_id_required") };
    set({ billingBusy: true });
    try {
      const token = await user.getIdToken();
      const res = await fetch(`${AI_PROXY_URL}/v1/billing/team/seats`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ teamId: tid, seats: n }),
      });
      if (!res.ok) {
        const body = await res
          .json()
          .catch(() => ({}) as Record<string, unknown>);
        const code =
          typeof body.error === "string" ? body.error : `http_${res.status}`;
        throw new Error(code);
      }
      const data = (await res.json()) as { seats?: number };
      return { ok: true, seats: data.seats };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      console.error("[billing] team/seats failed:", raw);
      return { ok: false, error: billingErrorMessage(raw) };
    } finally {
      set({ billingBusy: false });
    }
  },

  assignTeamSeats: async (teamId, seatAssignments) => {
    const user = auth.currentUser;
    if (!user) return { ok: false, error: "サインインが必要です。" };
    const tid = String(teamId ?? "").trim();
    if (!tid)
      return { ok: false, error: billingErrorMessage("team_id_required") };
    const list = Array.isArray(seatAssignments)
      ? seatAssignments.map((u) => String(u ?? "").trim()).filter(Boolean)
      : [];
    set({ billingBusy: true });
    try {
      const token = await user.getIdToken();
      const res = await fetch(`${AI_PROXY_URL}/v1/billing/team/assign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ teamId: tid, seatAssignments: list }),
      });
      if (!res.ok) {
        const body = await res
          .json()
          .catch(() => ({}) as Record<string, unknown>);
        const code =
          typeof body.error === "string" ? body.error : `http_${res.status}`;
        throw new Error(code);
      }
      const data = (await res.json()) as { seatAssignments?: string[] };
      return { ok: true, seatAssignments: data.seatAssignments };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      console.error("[billing] team/assign failed:", raw);
      return { ok: false, error: billingErrorMessage(raw) };
    } finally {
      set({ billingBusy: false });
    }
  },

  pollEntitlement: async (opts) => {
    const tries = opts?.tries ?? 20;
    const intervalMs = opts?.intervalMs ?? 3000;
    const target = opts?.target ?? null;
    // Ordered rank so "did the plan reach what I bought?" is a monotonic test,
    // not a bare inequality. A checkout for "pro" must NOT stop the poll on a
    // transient downward/stale read (e.g. a cached "free" served by another
    // Cloud Run instance whose entCache hasn't expired yet) — that would latch
    // a paying user on Free. With a target we stop ONLY when we've reached or
    // exceeded it; downward/equal-to-baseline reads are ignored until then.
    const RANK: Record<Plan, number> = {
      free: 0,
      pro: 1,
      team: 2,
      internal: 3,
    };
    // Seed the baseline from a FRESH fetch. Before this call effectivePlan can
    // still be null (a failed/one-shot login fetch), and a null→"free" first
    // read would otherwise be mistaken for "the plan changed" — stopping the
    // poll one tick after a purchase while the webhook is still writing "pro",
    // stranding a paying user on Free. If the baseline fetch itself fails
    // (before stays null), we re-seed from the first successful read below.
    await get().fetchEntitlement();
    let before = get().effectivePlan;
    // If we already satisfy the target at the baseline read, we're done.
    if (target && before != null && RANK[before] >= RANK[target]) return;
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      await get().fetchEntitlement();
      const now = get().effectivePlan;
      if (now == null) continue; // fetch failed; keep waiting
      if (target) {
        // Purchase/upgrade path: only an upward transition to (or past) the
        // purchased plan ends the poll. Ignore downward/stale reads entirely.
        if (RANK[now] >= RANK[target]) return;
        continue;
      }
      if (before == null) {
        before = now; // establish the baseline lazily after the first good read
        continue;
      }
      // Untargeted (e.g. portal-return) path: stop as soon as the plan actually
      // changes (up OR down). A no-op portal visit just times out harmlessly.
      if (now !== before) return;
    }
  },

  openPaywall: (reason = null) => {
    // This dialog is the single surface for 利用状況 (the usage meter) + plan info +
    // the platform-appropriate upgrade / 契約を管理 action, so it must ALWAYS open
    // for a signed-in user — on every platform and even while the purchase UI
    // ships dark (BILLING_ENABLED=false). Purchase-CTA visibility is gated INSIDE
    // the dialog (PaywallDialog: desktop shows the Stripe upgrade, mobile shows
    // "近日対応予定" until launch), NOT by refusing to open. Refusing for a Free
    // user while dark left the StatusBar/UserMenu entry a no-op — the reported PC
    // dead-end the moment the owner downgraded (mirror of the earlier paid-user
    // dead-end). All callers are user-triggered (badge/menu click or a gated
    // action), so this never auto-pops.
    set({ paywallOpen: true, paywallReason: reason, billingError: null });
  },
  closePaywall: () => set({ paywallOpen: false, paywallReason: null }),
  openTeamManage: () =>
    set({ teamManageOpen: true, paywallOpen: false, paywallReason: null }),
  closeTeamManage: () => set({ teamManageOpen: false }),

  reset: () =>
    set({
      realPlan: null,
      effectivePlan: null,
      isOwner: false,
      limits: null,
      usage: { ...ZERO_USAGE },
      seats: 1,
      period: null,
      source: null,
      expiresDate: null,
      loaded: false,
      loading: false,
      lastQuotaError: null,
      billingBusy: false,
      billingError: null,
      paywallOpen: false,
      paywallReason: null,
      teamManageOpen: false,
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

/**
 * Max collaborators (guests) a plan may invite to a SINGLE document
 * (MONETIZATION §1.3): Free 0 / Pro 3 / Team & internal unlimited. This is a
 * capability gate (not a metered PLAN_LIMITS counter), so it lives client-side;
 * the server-side counterpart (a Firestore-rules count cap keyed to the owner's
 * plan) is a deferred follow-up because a fail-closed rule on the core document
 * write path would risk breaking existing shared docs.
 */
export function collaboratorLimit(plan: Plan | null): number {
  switch (plan) {
    case "team":
    case "internal":
      return Infinity;
    case "pro":
      return 3;
    default: // free / null
      return 0;
  }
}

/**
 * Where a subscription is billed, for UI copy. `source` is the ai-proxy
 * entitlement rail: "app_store" (Apple IAP), "play" (Google IAP), "stripe"
 * (desktop/web card), "founder" (grandfathered), or null (free / team member).
 */
export function billingSourceLabel(source: string | null): string {
  switch (source) {
    case "app_store":
      return "App Store（iOSアプリ）";
    case "play":
      return "Google Play（Androidアプリ）";
    case "stripe":
      return "クレジットカード（Web）";
    case "founder":
      return "永年優待";
    default:
      return "";
  }
}

/**
 * Label for the "manage subscription" action, matched to the billing rail so the
 * button says where it will actually send the user (Apple/Google mandate their
 * own management surface for IAP subscriptions; Stripe uses the customer portal).
 */
export function manageLabelForSource(source: string | null): string {
  switch (source) {
    case "app_store":
      return "App Storeで管理";
    case "play":
      return "Google Playで管理";
    default:
      return "契約を管理";
  }
}

/**
 * One-line guidance explaining WHERE an IAP subscription must be managed, shown
 * in the usage view for app_store/play subscribers (who often try to manage from
 * the desktop and hit a dead end). Empty for Stripe/founder/free — no special
 * routing needed. The exact Settings path is spelled out so a user can find it
 * even offline.
 */
export function billingSourceGuidance(source: string | null): string {
  switch (source) {
    case "app_store":
      return "このプランはiOSアプリ（App Store）経由でご購入いただいています。解約・プラン変更・お支払い方法の更新は、iPhone/iPadの「設定 › （自分の名前）› サブスクリプション」から行えます。";
    case "play":
      return "このプランはAndroidアプリ（Google Play）経由でご購入いただいています。解約・プラン変更・お支払い方法の更新は、Playストアアプリの「メニュー › 定期購入」から行えます。";
    default:
      return "";
  }
}

/**
 * Format an epoch-ms subscription period end as a JST calendar date (the
 * product's fixed timezone). Returns "" for null so callers can omit the line.
 */
export function formatExpiryDate(ms: number | null): string {
  if (!ms || ms <= 0) return "";
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(new Date(ms));
  } catch {
    return "";
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
