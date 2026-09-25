import { describe, it, expect, beforeEach } from "vitest";
import { useEntitlementStore } from "./entitlement-store";

/**
 * The context-sources feature calls third-party servers on the user's behalf, so
 * it ships to internal staff first. The menu entry is hidden for everyone else,
 * and the store action refuses independently — a hidden entry point is not a
 * gate on its own.
 */
describe("context-sources internal gate", () => {
  beforeEach(() => {
    useEntitlementStore.getState().reset();
  });

  it.each(["free", "pro", "team"] as const)(
    "stays shut for a %s user even if the action is called directly",
    (plan) => {
      useEntitlementStore.setState({ realPlan: plan });
      useEntitlementStore.getState().openContextSources();
      expect(useEntitlementStore.getState().contextSourcesOpen).toBe(false);
    },
  );

  it("stays shut before the plan is known", () => {
    useEntitlementStore.setState({ realPlan: null });
    useEntitlementStore.getState().openContextSources();
    expect(useEntitlementStore.getState().contextSourcesOpen).toBe(false);
  });

  it("opens for internal staff", () => {
    useEntitlementStore.setState({ realPlan: "internal" });
    useEntitlementStore.getState().openContextSources();
    expect(useEntitlementStore.getState().contextSourcesOpen).toBe(true);
  });

  // The owner can preview the product as a Free user; that must not take away
  // an internal tool, so the gate reads realPlan and not effectivePlan.
  it("stays open while the owner previews the product as Free", () => {
    useEntitlementStore.setState({
      realPlan: "internal",
      effectivePlan: "free",
      viewAs: "free",
    });
    useEntitlementStore.getState().openContextSources();
    expect(useEntitlementStore.getState().contextSourcesOpen).toBe(true);
  });

  it("closes on reset, so a sign-out cannot leave it open", () => {
    useEntitlementStore.setState({ realPlan: "internal" });
    useEntitlementStore.getState().openContextSources();
    useEntitlementStore.getState().reset();
    expect(useEntitlementStore.getState().contextSourcesOpen).toBe(false);
    expect(useEntitlementStore.getState().realPlan).toBeNull();
  });
});
