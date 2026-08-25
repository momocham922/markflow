import { getAuth } from "firebase/auth";
import { isIOS, isAndroid, isMac } from "@/platform";
import { track } from "@/services/telemetry";

// =====================================================================
// In-app feedback client (bug report / feature request).
// ---------------------------------------------------------------------
// Posts to the ai-proxy /v1/feedback endpoint, which is the ONLY authority
// for identity (uid/email from the verified token) and PII redaction. The
// client just gathers a small NON-PII diagnostic context — never the
// document body, only its id — so a report is reproducible without leaking
// content. Firestore (written server-side) is the source of truth.
// =====================================================================

export type FeedbackKind = "bug" | "idea" | "other";

/** A coarse, non-PII platform label for triage. */
function detectPlatformLabel(): string {
  if (isIOS) return "ios";
  if (isAndroid) return "android";
  if (isMac) return "macos";
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent || "";
    if (/Windows/i.test(ua)) return "windows";
    if (/Linux/i.test(ua)) return "linux";
  }
  return "web";
}

export interface FeedbackContext {
  /** The currently open document id (id ONLY — never the body). */
  activeDocId?: string | null;
  /** An error string when the report is pre-filled from a captured crash. */
  error?: string | null;
}

export interface SubmitFeedbackResult {
  ok: boolean;
  id: string;
  fingerprint: string;
}

/**
 * Submit a feedback report. Throws (with a user-facing Japanese message) on any
 * failure so the dialog can surface it — a bug report silently vanishing is the
 * one thing worse than the bug.
 */
export async function submitFeedback(
  kind: FeedbackKind,
  message: string,
  context: FeedbackContext = {},
): Promise<SubmitFeedbackResult> {
  const text = message.trim();
  if (text.length < 3) {
    throw new Error("内容をもう少し詳しく入力してください。");
  }

  const proxyBase = import.meta.env.VITE_AI_PROXY_URL || "";
  if (!proxyBase) {
    throw new Error("送信に必要な接続先が設定されていません。");
  }
  const user = getAuth().currentUser;
  if (!user) {
    throw new Error("サインインが必要です。");
  }
  const token = await user.getIdToken();

  const ctx = {
    appVersion: __APP_VERSION__,
    platform: detectPlatformLabel(),
    osVersion:
      typeof navigator !== "undefined"
        ? (navigator.userAgent || "").slice(0, 180)
        : "",
    locale: typeof navigator !== "undefined" ? navigator.language || "" : "",
    activeDocId: context.activeDocId || "",
    error: context.error || "",
  };

  let res: Response;
  try {
    res = await fetch(`${proxyBase}/v1/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ kind, message: text, context: ctx }),
    });
  } catch {
    throw new Error("送信に失敗しました。ネットワーク接続を確認してください。");
  }

  if (!res.ok) {
    if (res.status === 400) {
      throw new Error("内容をもう少し詳しく入力してください。");
    }
    if (res.status === 401) {
      throw new Error("サインインが必要です。");
    }
    throw new Error(`送信に失敗しました (HTTP ${res.status})`);
  }

  const data = (await res.json()) as {
    ok?: boolean;
    id?: string;
    fingerprint?: string;
  };
  track("feedback_submit", { kind });
  return {
    ok: !!data.ok,
    id: data.id ?? "",
    fingerprint: data.fingerprint ?? "",
  };
}
