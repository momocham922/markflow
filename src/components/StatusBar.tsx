import { Moon, Sun, FlaskConical } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { isIOS, isTauri } from "@/platform";
import * as db from "@/services/database";

export function StatusBar() {
  const { theme, toggleTheme } = useAppStore();
  const { user, isOnline, syncing } = useAuthStore();

  // iOS: ultra-compact bar + safe area spacer (separate divs to avoid height conflicts)
  if (isIOS) {
    return (
      <div
        className="flex items-center justify-between border-t border-border bg-background pt-1 safe-bottom text-[9px] text-muted-foreground shrink-0"
        style={{ paddingLeft: "max(20px, env(safe-area-inset-left, 20px))", paddingRight: "max(20px, env(safe-area-inset-right, 20px))" }}
      >
        <span className="flex items-center gap-1">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              !user ? "bg-zinc-400" : isOnline ? "bg-emerald-500" : "bg-amber-500"
            }`}
          />
          {!user ? "Local" : syncing ? "Sync..." : isOnline ? "Online" : "Offline"}
        </span>
        <button
          className="h-5 w-5 flex items-center justify-center text-muted-foreground"
          onClick={toggleTheme}
        >
          {theme === "light" ? <Moon className="h-3 w-3" /> : <Sun className="h-3 w-3" />}
        </button>
      </div>
    );
  }

  // Desktop: full layout
  const { activeDocId, documents } = useAppStore();
  const activeDoc = documents.find((d) => d.id === activeDocId);
  const [betaChannel, setBetaChannel] = useState(false);

  useEffect(() => {
    db.getSetting("update_channel").then((val) => {
      setBetaChannel(val === "beta");
    }).catch(() => {});
  }, []);

  const [downgrading, setDowngrading] = useState(false);

  const toggleBetaChannel = useCallback(async () => {
    const next = !betaChannel;

    // Switching from beta → stable: offer to force-install stable if current version is beta
    if (!next && isTauri && __APP_VERSION__.includes("beta")) {
      const confirmed = window.confirm(
        "Stableチャンネルに切り替えます。\n最新のStable版をインストールしてアプリを再起動しますか？",
      );
      if (!confirmed) return;

      setBetaChannel(false);
      await db.setSetting("update_channel", "stable");
      setDowngrading(true);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke<string>("force_install_stable");
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } catch (err) {
        setDowngrading(false);
        window.alert(`Stable版のインストールに失敗しました: ${err}`);
      }
      return;
    }

    setBetaChannel(next);
    await db.setSetting("update_channel", next ? "beta" : "stable");
  }, [betaChannel]);

  return (
    <div className="flex items-center justify-between border-t border-border bg-background px-3 text-[11px] text-muted-foreground h-7">
      <div className="flex items-center gap-3">
        {user ? (
          <span className="flex items-center gap-1">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isOnline ? "bg-emerald-500" : "bg-amber-500"
              }`}
            />
            {syncing ? "Syncing..." : isOnline ? "Online" : "Offline"}
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />
            Local
          </span>
        )}
        {user && (
          <span className="text-muted-foreground/60">{user.email}</span>
        )}
        {activeDoc && (
          <span>
            Last edited{" "}
            {new Date(activeDoc.updatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {downgrading && (
          <span className="text-amber-500 font-medium animate-pulse">Installing Stable...</span>
        )}
        {betaChannel && !downgrading && (
          <span className="text-amber-500 font-medium">Beta</span>
        )}
        {activeDoc && (
          <span>
            {(activeDoc.content || "").trim() ? (activeDoc.content || "").trim().split(/\s+/).length : 0} words / {(activeDoc.content || "").length} chars
          </span>
        )}
        <button
          className={`h-5 w-5 flex items-center justify-center hover:text-foreground ${betaChannel ? "text-amber-500" : "text-muted-foreground"}`}
          onClick={toggleBetaChannel}
          title={betaChannel ? "Beta channel (click to switch to Stable)" : "Stable channel (click to switch to Beta)"}
        >
          <FlaskConical className="h-3 w-3" />
        </button>
        <button
          className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={toggleTheme}
          title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
        >
          {theme === "light" ? <Moon className="h-3 w-3" /> : <Sun className="h-3 w-3" />}
        </button>
      </div>
    </div>
  );
}
