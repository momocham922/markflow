import { describe, it, expect } from "vitest";
import { friendlyErrorMessage, errorText } from "./friendly-error";

describe("errorText", () => {
  it("extracts strings, Error.message, and object shapes", () => {
    expect(errorText("raw string")).toBe("raw string");
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText({ message: "msg" })).toBe("msg");
    expect(errorText({ error: "err" })).toBe("err");
    expect(errorText(null)).toBe("");
    expect(errorText(undefined)).toBe("");
  });
});

describe("friendlyErrorMessage", () => {
  // The core invariant of the whole "素のエラーを出さない" sweep: no raw HTTP
  // status, upstream body, or English text ever survives into the output.
  const RAW_LEAKS = [
    "Research analyze failed: 500",
    "Grounded search failed: 502",
    'HTTP 500: Internal Server Error {"error":"boom"}',
    "TypeError: Cannot read properties of undefined",
    "ai_upstream_error",
    "metering_unavailable",
    "Refine failed: Vertex overloaded 529",
    "Upload failed: storage/unauthorized",
  ];

  it("never echoes the raw status/body/English for any known failure shape", () => {
    for (const raw of RAW_LEAKS) {
      const msg = friendlyErrorMessage(raw, "research");
      // No digits from an HTTP status, no English machine code, no stack word.
      expect(msg).not.toMatch(/\d{3}/);
      expect(msg).not.toMatch(/failed|error|typeerror|upstream|http/i);
      expect(msg).not.toContain(raw);
      // Always non-empty Japanese guidance.
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it("classifies network failures", () => {
    for (const raw of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource",
      "load failed",
      "auth/network-request-failed",
    ]) {
      expect(friendlyErrorMessage(raw)).toContain("接続");
    }
  });

  it("classifies timeouts", () => {
    expect(friendlyErrorMessage("The operation timed out")).toContain(
      "タイムアウト",
    );
    expect(friendlyErrorMessage(new DOMException("x", "AbortError"))).toContain(
      "タイムアウト",
    );
  });

  it("classifies auth expiry", () => {
    expect(friendlyErrorMessage("Request failed: 401")).toContain("認証");
    expect(friendlyErrorMessage("Missing or invalid Authorization")).toContain(
      "認証",
    );
  });

  it("classifies quota / rate limits", () => {
    expect(friendlyErrorMessage("Research analyze failed: 429")).toContain(
      "上限",
    );
    expect(friendlyErrorMessage("payment_required")).toContain("上限");
  });

  it("uses context-specific fallback copy for 5xx and unmatched errors", () => {
    expect(
      friendlyErrorMessage("Research analyze failed: 500", "research"),
    ).toBe(
      "リサーチの取得に失敗しました。時間をおいて、もう一度お試しください。",
    );
    expect(friendlyErrorMessage("boom", "voice")).toBe(
      "音声の処理に失敗しました。もう一度お試しください。",
    );
    expect(friendlyErrorMessage("boom", "upload")).toBe(
      "画像のアップロードに失敗しました。もう一度お試しください。",
    );
    expect(friendlyErrorMessage("weird", "generic")).toBe(
      "処理に失敗しました。時間をおいて、もう一度お試しください。",
    );
  });

  it("handles Error objects and nullish input", () => {
    expect(friendlyErrorMessage(new Error("Refine failed: 500"), "voice")).toBe(
      "音声の処理に失敗しました。もう一度お試しください。",
    );
    expect(friendlyErrorMessage(null, "sync")).toContain("同期");
  });
});
