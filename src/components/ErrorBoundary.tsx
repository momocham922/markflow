import React from "react";
import { reportError } from "@/services/crash";

// =====================================================================
// Top-level React error boundary.
// ---------------------------------------------------------------------
// WHY THIS EXISTS: the app has a single fixed-position root (mobile) and
// html{background:var(--background)} paints near-black in dark mode. Any
// uncaught render/commit exception (e.g. thrown while applying a theme)
// unmounts the whole tree, leaving an unrecoverable BLACK, unresponsive
// screen. This boundary converts that into a visible, interactive, and
// diagnosable fallback — and crucially offers a "Reset theme" recovery so
// a bad theme can't wedge the user into a reload-crash loop.
//
// The fallback MUST set its own OPAQUE LIGHT background/foreground with
// inline styles so it is never invisible regardless of the .dark class or
// any CSS variable state at the moment of the crash.
// =====================================================================

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

const DEFAULT_THEME_SETTINGS = {
  previewTheme: "github",
  editorTheme: "default",
  mindMapTheme: "lavender",
  customPreviewCss: "",
};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Never let the reporter itself throw and re-crash the fallback.
    try {
      reportError(error, {
        componentStack: info?.componentStack ?? "",
        boundary: "root",
      });
    } catch {
      /* ignore */
    }
  }

  private reload = () => {
    try {
      window.location.reload();
    } catch {
      /* ignore */
    }
  };

  // Reset theme-related persistence to safe defaults, then reload. Writes the
  // synchronous localStorage backup FIRST (always works in WKWebView) so the
  // recovery holds even if the async SQLite write can't complete; a timer is a
  // final safety net in case the dynamic import hangs.
  private resetTheme = () => {
    const json = JSON.stringify(DEFAULT_THEME_SETTINGS);
    try {
      localStorage.setItem("markflow:themeSettings", json);
    } catch {
      /* ignore */
    }
    let reloaded = false;
    const doReload = () => {
      if (reloaded) return;
      reloaded = true;
      this.reload();
    };
    import("@/services/database")
      .then((db) =>
        Promise.allSettled([
          db.setSetting("themeSettings", json),
          db.setSetting("theme", "light"),
        ]),
      )
      .catch(() => {})
      .finally(doReload);
    setTimeout(doReload, 1500);
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const btn: React.CSSProperties = {
      appearance: "none",
      border: "1px solid #d4d4d4",
      borderRadius: 10,
      padding: "12px 18px",
      fontSize: 15,
      fontWeight: 600,
      cursor: "pointer",
      minHeight: 44,
    };

    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "#ffffff",
          color: "#111111",
          padding: 24,
          overflow: "auto",
          zIndex: 2147483647,
          WebkitTextSizeAdjust: "100%",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          lineHeight: 1.5,
        }}
        role="alert"
      >
        <div style={{ maxWidth: 640, margin: "0 auto" }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>
            問題が発生しました
          </h1>
          <p style={{ fontSize: 14, color: "#444", margin: "0 0 20px" }}>
            予期しないエラーが発生しました。ドキュメントは安全に保存されています。
            まず「再読み込み」をお試しください。繰り返し発生する場合は、テーマを
            初期設定に戻してから再読み込みしてください。
          </p>
          <div
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              marginBottom: 24,
            }}
          >
            <button
              type="button"
              onClick={this.reload}
              style={{ ...btn, background: "#111111", color: "#ffffff" }}
            >
              再読み込み
            </button>
            <button
              type="button"
              onClick={this.resetTheme}
              style={{ ...btn, background: "#f5f5f5", color: "#111111" }}
            >
              テーマを初期化して再読み込み
            </button>
          </div>
          <p style={{ fontSize: 12, color: "#888", margin: "0 0 6px" }}>
            エラー詳細（不具合報告用）
          </p>
          <pre
            style={{
              fontSize: 12,
              color: "#666",
              background: "#f5f5f5",
              border: "1px solid #e5e5e5",
              borderRadius: 8,
              padding: 12,
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              overflowX: "auto",
            }}
          >
            {error.message || String(error)}
          </pre>
        </div>
      </div>
    );
  }
}
