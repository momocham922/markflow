import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Regression for the 2026-11-09 iPhone incident: recording while signed out
// "worked" on screen while every live segment was silently discarded, and the
// full audio ended up stranded. Recording must not start without an account.

const authState: { user: unknown; loading: boolean } = {
  user: null,
  loading: false,
};
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: { getState: () => authState },
}));
vi.mock("@/services/ai-proxy", () => ({
  aiProxyHeaders: () => ({}),
  reportIfQuota: () => false,
}));
vi.mock("@/platform", () => ({ isAndroid: false, isTauri: false }));

import {
  useVoiceInput,
  RECORD_NEEDS_LOGIN_MSG,
  RECORD_AUTH_LOADING_MSG,
} from "./use-voice-input";

function setup() {
  const onError = vi.fn();
  const getUserMedia = vi.fn().mockRejectedValue(new Error("no mic in test"));
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  const hook = renderHook(() => useVoiceInput({ language: "ja-JP", onError }));
  return { hook, onError, getUserMedia };
}

describe("useVoiceInput start requires a signed-in account", () => {
  beforeEach(() => {
    authState.user = null;
    authState.loading = false;
  });

  it("signed out: does not start, never touches the mic, says why", async () => {
    const { hook, onError, getUserMedia } = setup();
    await act(async () => {
      await hook.result.current.start();
    });
    expect(onError).toHaveBeenCalledWith(RECORD_NEEDS_LOGIN_MSG);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(hook.result.current.isRecording).toBe(false);
  });

  it("auth still restoring: does not start and asks to retry", async () => {
    authState.loading = true;
    const { hook, onError, getUserMedia } = setup();
    await act(async () => {
      await hook.result.current.start();
    });
    expect(onError).toHaveBeenCalledWith(RECORD_AUTH_LOADING_MSG);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(hook.result.current.isRecording).toBe(false);
  });

  it("signed in: proceeds to open the microphone (positive control)", async () => {
    authState.user = { uid: "u1", getIdToken: async () => "t" };
    const { hook, onError, getUserMedia } = setup();
    await act(async () => {
      await hook.result.current.start();
    });
    expect(getUserMedia).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalledWith(RECORD_NEEDS_LOGIN_MSG);
    expect(onError).not.toHaveBeenCalledWith(RECORD_AUTH_LOADING_MSG);
  });
});
