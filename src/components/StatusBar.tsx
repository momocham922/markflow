import { Moon, Sun, FlaskConical, Eye } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import {
  useEntitlementStore,
  planLabel,
  BILLING_ENABLED,
  type ViewAsPlan,
} from "@/stores/entitlement-store";
import { isIOS, isMobile, isTauri } from "@/platform";
import { cn } from "@/lib/utils";
import { countWords } from "@/lib/editor-utils";
import * as db from "@/services/database";

export function StatusBar() {
  const { theme, toggleTheme } = useAppStore();
  const { user, isOnline, syncing } = useAuthStore();

  // Mobile: ultra-compact bar + safe area spacer
  if (isMobile) {
    return (
      <div
        className={cn(
          "flex items-center justify-between border-t border-border bg-background text-[10px] text-muted-foreground shrink-0",
          isIOS ? "pb-7 px-6 pt-2" : "px-4",
        )}
        style={
          !isIOS
            ? {
                paddingTop: "0.5rem",
                paddingBottom: "max(env(safe-area-inset-bottom, 0px), 0.5rem)",
              }
            : undefined
        }
      >
        <span className="flex items-center gap-1">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              !user
                ? "bg-zinc-400"
                : isOnline
                  ? "bg-emerald-500"
                  : "bg-amber-500"
            }`}
          />
          {!user
            ? "Local"
            : syncing
              ? "Sync..."
              : isOnline
                ? "Online"
                : "Offline"}
        </span>
        <button
          className="flex items-center justify-center text-muted-foreground"
          onClick={toggleTheme}
        >
          {theme === "light" ? (
            <Moon className="h-3.5 w-3.5" />
          ) : (
            <Sun className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    );
  }

  // Desktop: full layout
  const { activeDocId, documents } = useAppStore();
  const activeDoc = documents.find((d) => d.id === activeDocId);
  const { isOwner, effectivePlan, viewAs, setViewAs, openPaywall } =
    useEntitlementStore();
  const [betaChannel, setBetaChannel] = useState(false);

  useEffect(() => {
    db.getSetting("update_channel")
      .then((val) => {
        setBetaChannel(val === "beta");
      })
      .catch(() => {});
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
        {user && <span className="text-muted-foreground/60">{user.email}</span>}
        {activeDoc && (
          <span>
            Last edited {new Date(activeDoc.updatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {/* Owner-only (三田遼平): switch between internal-tester and general-user views */}
        {isOwner && (
          <label
            className="flex items-center gap-1 text-muted-foreground"
            title="表示切替（オーナー専用）: 内部テスター / 一般ユーザー(Free/Pro/Team)"
          >
            <Eye className="h-3 w-3" />
            <select
              className="bg-transparent text-[11px] text-foreground outline-none cursor-pointer"
              value={viewAs ?? "real"}
              onChange={(e) => {
                const v = e.target.value;
                setViewAs(v === "real" ? null : (v as ViewAsPlan));
              }}
            >
              <option value="real">内部テスター（実表示）</option>
              <option value="free">一般: Free</option>
              <option value="pro">一般: Pro</option>
              <option value="team">一般: Team</option>
            </select>
          </label>
        )}
        {/* Plan badge for general users (and owner while previewing a plan).
            When billing is live, a Free badge is a click-to-upgrade entry. */}
        {user &&
          effectivePlan &&
          (viewAs !== null || effectivePlan !== "internal") &&
          (BILLING_ENABLED && effectivePlan === "free" ? (
            <button
              className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/20 transition-colors"
              title="プランをアップグレード"
              onClick={() => openPaywall()}
            >
              Free · アップグレード
            </button>
          ) : (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                effectivePlan === "free"
                  ? "bg-muted text-muted-foreground"
                  : "bg-primary/10 text-primary",
              )}
              title={`現在のプラン: ${planLabel(effectivePlan)}`}
            >
              {planLabel(effectivePlan)}
            </span>
          ))}
        {downgrading && (
          <span className="text-amber-500 font-medium animate-pulse">
            Installing Stable...
          </span>
        )}
        {betaChannel && !downgrading && (
          <span className="text-amber-500 font-medium">Beta</span>
        )}
        {activeDoc && (
          <span>
            {countWords(activeDoc.content || "")} words /{" "}
            {(activeDoc.content || "").length} chars
          </span>
        )}
        <button
          className={`h-5 w-5 flex items-center justify-center hover:text-foreground ${betaChannel ? "text-amber-500" : "text-muted-foreground"}`}
          onClick={toggleBetaChannel}
          title={
            betaChannel
              ? "Beta channel (click to switch to Stable)"
              : "Stable channel (click to switch to Beta)"
          }
        >
          <FlaskConical className="h-3 w-3" />
        </button>
        <button
          className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={toggleTheme}
          title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
        >
          {theme === "light" ? (
            <Moon className="h-3 w-3" />
          ) : (
            <Sun className="h-3 w-3" />
          )}
        </button>
      </div>
    </div>
  );
}
