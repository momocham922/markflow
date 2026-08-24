// =====================================================================
// Mobile In-App Purchase bridge (StoreKit 2 on iOS, Play Billing v9 on
// Android) — the client counterpart to ai-proxy's /v1/billing/iap/verify.
// ---------------------------------------------------------------------
// DARK until GO: this is only ever reached when BILLING_ENABLED is on AND the
// caller is on a mobile platform (startCheckout routes here). Desktop/web keep
// Stripe — macOS StoreKit IAP needs an app-sandboxed Mac App Store build, which
// is incompatible with MarkFlow's Developer-ID DMG, so the tauri-plugin-iap
// crate is compiled for iOS/Android only (see src-tauri/Cargo.toml).
//
// SECURITY MODEL: the receipt is NEVER trusted client-side. We hand the raw
// StoreKit JWS (iOS) or Play purchaseToken (Android) to the server, which
// verifies it against Apple/Google, binds the store subId → the VERIFIED
// Firebase uid, and writes the entitlement through the same pipeline Stripe
// uses. The client only kicks off the native purchase sheet and relays the
// receipt; the plan the UI shows still comes from /v1/me/entitlement.
//
// PRODUCT IDS MUST MIRROR THE SERVER (server/ai-proxy/iap.ts):
//   Apple: com.markflow.app.<plan>.<monthly|yearly>  (per-interval SKU)
//   Play:  com.markflow.app.<plan>  + base plan (monthly|yearly) = offer token
// The server derives the plan from the product id, so a drift here would make a
// real purchase resolve to the wrong / no plan. Keep the two in lockstep.
// =====================================================================
import { auth } from "@/services/firebase";
import { isIOS, isAndroid } from "@/platform";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";

type PurchasablePlan = "pro" | "team";
type Interval = "month" | "year";

/** Apple SKU id for a plan+interval (must exist in App Store Connect). */
function appleProductId(plan: PurchasablePlan, interval: Interval): string {
  return `com.markflow.app.${plan}.${interval === "year" ? "yearly" : "monthly"}`;
}

/** Play subscription product id (interval is selected via the base plan/offer). */
function playProductId(plan: PurchasablePlan): string {
  return `com.markflow.app.${plan}`;
}

/** Play base-plan id for an interval (must match the base plans in Play Console). */
function playBasePlanId(interval: Interval): string {
  return interval === "year" ? "yearly" : "monthly";
}

export type MobilePurchaseOutcome =
  { ok: true; plan: string; status: string } | { ok: false; error: string };

/**
 * Run a native subscription purchase for `plan`/`interval`, then hand the signed
 * receipt to the server for verification. Returns the server's resolved plan on
 * success or a coarse error code (mapped to a localized message upstream by
 * billingErrorMessage). The caller must have already checked BILLING_ENABLED and
 * that we are on a mobile platform.
 */
export async function purchaseMobileSubscription(
  plan: PurchasablePlan,
  interval: Interval = "month",
): Promise<MobilePurchaseOutcome> {
  const user = auth.currentUser;
  if (!user) return { ok: false, error: "unauthorized" };
  if (!isIOS && !isAndroid) return { ok: false, error: "unsupported_platform" };
  // Defense-in-depth: mobile IAP is Pro-only. Team is per-seat and sold on
  // desktop/web (Stripe) only — no Team SKU exists in App Store Connect / Play.
  // startCheckout already blocks this, but refuse here too so no caller can start
  // a native purchase for a non-existent Team product.
  if (plan !== "pro") return { ok: false, error: "team_mobile_unavailable" };

  // Dynamic import so the plugin api is never pulled into desktop/web bundles'
  // critical path; the native commands only exist in the iOS/Android binaries.
  const iap = await import("@choochmeque/tauri-plugin-iap-api");

  let requestBody: Record<string, unknown>;
  try {
    if (isIOS) {
      const productId = appleProductId(plan, interval);
      // appAccountToken is intentionally omitted: StoreKit requires a UUID there,
      // but our account id is a Firebase uid (not a UUID). The server binds the
      // uid from the VERIFIED Firebase token instead, so it is not needed here.
      const p = await iap.purchase(productId, "subs");
      const jws = p.jwsRepresentation;
      if (!jws) return { ok: false, error: "no_receipt" };
      requestBody = { platform: "ios", jws };
    } else {
      const productId = playProductId(plan);
      // Resolve the offer token for the requested interval's base plan. Play needs
      // an explicit offerToken to know which base plan (monthly/yearly) to bill.
      const { products } = await iap.getProducts([productId], "subs");
      const prod = products.find((x) => x.productId === productId);
      const offer =
        prod?.subscriptionOfferDetails?.find(
          (o) => o.basePlanId === playBasePlanId(interval),
        ) ?? prod?.subscriptionOfferDetails?.[0];
      const p = await iap.purchase(
        productId,
        "subs",
        offer?.offerToken
          ? { offerToken: offer.offerToken, obfuscatedAccountId: user.uid }
          : { obfuscatedAccountId: user.uid },
      );
      const purchaseToken = p.purchaseToken;
      if (!purchaseToken) return { ok: false, error: "no_purchase_token" };
      requestBody = {
        platform: "android",
        purchaseToken,
        productId: p.productId || productId,
      };
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // A user cancelling the native sheet is a normal outcome, not an error to
    // shout about — surface a distinct code so the UI can stay quiet.
    if (/cancel/i.test(raw)) return { ok: false, error: "purchase_canceled" };
    console.error("[iap] native purchase failed:", raw);
    return { ok: false, error: "purchase_failed" };
  }

  // Hand the receipt to the server for authoritative verification + entitlement.
  try {
    const token = await user.getIdToken();
    const res = await fetch(`${AI_PROXY_URL}/v1/billing/iap/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestBody),
    });
    if (!res.ok) {
      const errBody = await res
        .json()
        .catch(() => ({}) as Record<string, unknown>);
      const code =
        typeof errBody.error === "string"
          ? errBody.error
          : `http_${res.status}`;
      return { ok: false, error: code };
    }
    const data = (await res.json()) as { plan?: string; status?: string };
    return {
      ok: true,
      plan: data.plan || plan,
      status: data.status || "active",
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[iap] verify request failed:", raw);
    return { ok: false, error: "verify_failed" };
  }
}
