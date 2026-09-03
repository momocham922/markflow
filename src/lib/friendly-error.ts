// =====================================================================
// Friendly error messages — single source of truth
// ---------------------------------------------------------------------
// Converts an unknown thrown value / raw server message into a user-facing
// Japanese string. The product rule is absolute: NEVER surface a raw HTTP
// status, an upstream error body, an English stack, or a machine code to the
// user (「素のエラーを出さない」). Every user-visible catch that currently
// interpolates `err`, `err.message`, or an HTTP status must route through here.
//
// This mirrors the two pre-existing local mappers (auth-store.friendlyLoginError
// and entitlement-store.billingErrorMessage) and generalizes them so every panel
// shares one classifier. Those two keep their domain-specific copy; this module
// covers the everyday network / timeout / auth / quota / server classes plus a
// context-appropriate generic fallback for everything else.
// =====================================================================

/**
 * An error whose `message` is ALREADY a user-ready, localized string. Throw this
 * when the code has a specific, intentional message to show (e.g. "Web公開は
 * Proプラン以上の機能です。") so it survives `friendlyErrorMessage` unchanged
 * instead of being collapsed into the generic fallback.
 */
export class FriendlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FriendlyError";
  }
}

/** Best-effort extraction of a raw message string from any thrown value. */
export function errorText(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    // Include the name when it carries signal beyond the generic "Error"
    // (e.g. DOMException "AbortError", whose message is often opaque), so the
    // classifier can key off it. Plain Error keeps just its message.
    const name = err.name && err.name !== "Error" ? `${err.name}: ` : "";
    return `${name}${err.message}`;
  }
  if (typeof err === "object") {
    // Common shapes: { name, message } (DOMException isn't always instanceof
    // Error across runtimes), { message }, { error }.
    const o = err as Record<string, unknown>;
    const name =
      typeof o.name === "string" && o.name && o.name !== "Error"
        ? `${o.name}: `
        : "";
    if (typeof o.message === "string") return `${name}${o.message}`;
    if (typeof o.error === "string") return `${name}${o.error}`;
    if (name) return name.slice(0, -2); // just the name, no ": "
  }
  try {
    return String(err);
  } catch {
    return "";
  }
}

/**
 * The calling surface — selects the generic fallback copy so a failure reads
 * naturally in context ("リサーチの取得に失敗しました" vs "同期に失敗しました")
 * without ever echoing the raw error.
 */
export type FriendlyContext =
  | "generic"
  | "research"
  | "ai"
  | "voice"
  | "publish"
  | "upload"
  | "update"
  | "share"
  | "team"
  | "feedback"
  | "sync"
  | "mcp";

function contextFallback(context: FriendlyContext): string {
  switch (context) {
    case "research":
      return "リサーチの取得に失敗しました。時間をおいて、もう一度お試しください。";
    case "ai":
      return "AIの応答に失敗しました。もう一度お試しください。";
    case "voice":
      return "音声の処理に失敗しました。もう一度お試しください。";
    case "publish":
      return "公開処理に失敗しました。時間をおいて、もう一度お試しください。";
    case "upload":
      return "画像のアップロードに失敗しました。もう一度お試しください。";
    case "update":
      return "アップデートの適用に失敗しました。時間をおいて、もう一度お試しください。";
    case "share":
      return "共有設定の更新に失敗しました。時間をおいて、もう一度お試しください。";
    case "team":
      return "チームの操作に失敗しました。時間をおいて、もう一度お試しください。";
    case "feedback":
      return "フィードバックの送信に失敗しました。時間をおいて、もう一度お試しください。";
    case "sync":
      return "同期に失敗しました。ネットワークの状態をご確認ください。";
    case "mcp":
      return "接続に失敗しました。設定を確認して、もう一度お試しください。";
    case "generic":
    default:
      return "処理に失敗しました。時間をおいて、もう一度お試しください。";
  }
}

/**
 * Map any thrown value / raw message to a friendly Japanese string.
 *
 * Classification order (most specific first): network → timeout → auth → quota
 * → server/upstream → context fallback. The final fallback NEVER contains the
 * raw text, so a malformed or English upstream body can never leak to the UI.
 */
export function friendlyErrorMessage(
  err: unknown,
  context: FriendlyContext = "generic",
): string {
  // An explicitly-authored user message passes through verbatim.
  if (err instanceof FriendlyError) return err.message;
  const s = errorText(err).toLowerCase();

  // Connectivity — same VeronaSASE / corporate-proxy class as login failures.
  if (
    /failed to fetch|networkerror|network error|network-request-failed|load failed|err_network|err_connection|econnrefused|ehostunreach|enotfound|net::/.test(
      s,
    )
  ) {
    return "サーバーに接続できませんでした。ネットワークの状態をご確認のうえ、もう一度お試しください。社内ネットワークやVPN・プロキシ環境ではブロックされることがあります。";
  }
  // Timeouts / aborted requests.
  if (/timed out|timeout|aborterror|\baborted\b|\babort\b/.test(s)) {
    return "処理がタイムアウトしました。時間をおいて、もう一度お試しください。";
  }
  // Auth / expired session.
  if (
    /\b401\b|\b403\b|unauthorized|forbidden|missing or invalid authorization|firebase id token|token exchange failed|permission-denied|permission denied/.test(
      s,
    )
  ) {
    return "認証の有効期限が切れたか、権限がありません。再度サインインしてお試しください。";
  }
  // Quota / rate limits.
  if (
    /\b402\b|\b429\b|quota|rate.?limit|payment_required|limit reached|too many requests|resource[_-]?exhausted/.test(
      s,
    )
  ) {
    return "ご利用の上限に達しました。プランのアップグレード、または翌月のリセットまでお待ちください。";
  }
  // Server / upstream (5xx, our machine codes, generic "internal server error").
  if (
    /\b5\d\d\b|ai_upstream_error|metering_unavailable|internal server error|server error|upstream|bad gateway|service unavailable|overloaded/.test(
      s,
    )
  ) {
    return contextFallback(context);
  }

  // Unmatched — return the context generic. Deliberately drops the raw text.
  return contextFallback(context);
}
