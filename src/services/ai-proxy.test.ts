import { describe, it, expect, vi, beforeEach } from "vitest";

// The entitlement store pulls in @/services/firebase at import time; mock the
// whole module so these pure-helper tests never touch Firebase. getState()
// returns our controllable stub.
const state = {
  viewAs: null as null | "free" | "pro" | "team",
  reportQuota: vi.fn(),
  fetchEntitlement: vi.fn(() => Promise.resolve()),
};
vi.mock("@/stores/entitlement-store", () => ({
  useEntitlementStore: { getState: () => state },
}));

import { aiProxyHeaders, reportIfQuota } from "./ai-proxy";

beforeEach(() => {
  state.viewAs = null;
  state.reportQuota.mockClear();
  state.fetchEntitlement.mockClear();
});

describe("aiProxyHeaders", () => {
  it("always sets Content-Type and Bearer auth", () => {
    const h = aiProxyHeaders("tok123");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["Authorization"]).toBe("Bearer tok123");
  });

  it("omits X-View-As when not previewing", () => {
    state.viewAs = null;
    expect(aiProxyHeaders("t")["X-View-As"]).toBeUndefined();
  });

  it("injects X-View-As with the current preview plan", () => {
    state.viewAs = "pro";
    expect(aiProxyHeaders("t")["X-View-As"]).toBe("pro");
    state.viewAs = "team";
    expect(aiProxyHeaders("t")["X-View-As"]).toBe("team");
  });
});

describe("reportIfQuota", () => {
  it("ignores any non-429 status without touching the store", () => {
    expect(reportIfQuota(200, "")).toBe(false);
    expect(reportIfQuota(500, '{"error":"quota_exceeded"}')).toBe(false);
    expect(reportIfQuota(403, "forbidden")).toBe(false);
    expect(state.reportQuota).not.toHaveBeenCalled();
    expect(state.fetchEntitlement).not.toHaveBeenCalled();
  });

  it("records a 429 quota_exceeded body and refreshes usage", () => {
    const body = JSON.stringify({
      error: "quota_exceeded",
      feature: "aiCalls",
      plan: "free",
      limit: 30,
      used: 30,
    });
    expect(reportIfQuota(429, body)).toBe(true);
    expect(state.reportQuota).toHaveBeenCalledWith({
      feature: "aiCalls",
      plan: "free",
      limit: 30,
      used: 30,
    });
    expect(state.fetchEntitlement).toHaveBeenCalledTimes(1);
  });

  it("coerces numeric fields even when the body sends them as strings", () => {
    const body = JSON.stringify({
      error: "quota_exceeded",
      feature: "batchMin",
      plan: "pro",
      limit: "3000",
      used: "3001",
    });
    expect(reportIfQuota(429, body)).toBe(true);
    expect(state.reportQuota).toHaveBeenCalledWith({
      feature: "batchMin",
      plan: "pro",
      limit: 3000,
      used: 3001,
    });
  });

  it("returns false for a 429 that is NOT a quota body (e.g. rate limit)", () => {
    expect(reportIfQuota(429, '{"error":"rate_limited"}')).toBe(false);
    expect(state.reportQuota).not.toHaveBeenCalled();
  });

  it("returns false (never throws) for a malformed/empty 429 body", () => {
    expect(reportIfQuota(429, "not json")).toBe(false);
    expect(reportIfQuota(429, "")).toBe(false);
    expect(state.reportQuota).not.toHaveBeenCalled();
  });
});
