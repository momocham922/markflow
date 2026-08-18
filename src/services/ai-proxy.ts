import { useEntitlementStore, type Feature } from "@/stores/entitlement-store";

// =====================================================================
// Shared helpers for calling the ai-proxy from the frontend.
// ---------------------------------------------------------------------
// `aiProxyHeaders` is the single place that injects the owner-only
// X-View-As preview header into every authenticated ai-proxy request, so
// the owner (三田遼平) can preview the exact metering/gating a general
// (free/pro/team) user experiences. The server honors X-View-As ONLY for
// OWNER_UIDS — it is a no-op (and never an escalation) for anyone else.
// =====================================================================

/** Build auth headers for an ai-proxy call, adding X-View-As when previewing. */
export function aiProxyHeaders(token: string): Record<string, string> {
  const viewAs = useEntitlementStore.getState().viewAs;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (viewAs) headers["X-View-As"] = viewAs;
  return headers;
}

/**
 * If a failed ai-proxy response is a 429 quota_exceeded, record it in the
 * entitlement store (drives the upsell banner) and refresh usage numbers.
 * Returns true when it was a quota error. Safe to call on any error body.
 */
export function reportIfQuota(status: number, bodyText: string): boolean {
  if (status !== 429) return false;
  try {
    const j = JSON.parse(bodyText);
    if (j && j.error === "quota_exceeded") {
      const store = useEntitlementStore.getState();
      store.reportQuota({
        feature: j.feature as Feature,
        plan: j.plan,
        limit: Number(j.limit),
        used: Number(j.used),
      });
      void store.fetchEntitlement();
      return true;
    }
  } catch {
    /* not a JSON quota body */
  }
  return false;
}
