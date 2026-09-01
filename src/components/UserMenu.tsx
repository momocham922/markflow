import { useState, useRef, useEffect, useCallback } from "react";
import {
  LogIn,
  LogOut,
  Cloud,
  CloudOff,
  RefreshCw,
  Users,
  DatabaseZap,
  Sparkles,
  CreditCard,
  Trash2,
  MessageSquareWarning,
  BarChart3,
  Github,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import {
  useEntitlementStore,
  BILLING_ENABLED,
} from "@/stores/entitlement-store";
import { isMobile } from "@/platform";
import { DeleteAccountDialog } from "@/components/DeleteAccountDialog";
import { useFeedbackStore } from "@/stores/feedback-store";
import { useTelemetryStore } from "@/stores/telemetry-store";

// GitHub sign-in is wired end-to-end (firebase signInWithGitHub + ai-proxy
// token exchange) but not yet production-ready (OAuth app + secrets pending),
// so the entry point is hidden entirely until it actually works. Re-enable by
// restoring the env gate: `!!import.meta.env.VITE_GITHUB_CLIENT_ID`.
const GITHUB_LOGIN_ENABLED = false;

function UserAvatar({
  user,
}: {
  user: {
    photoURL: string | null;
    displayName: string | null;
    email: string | null;
  };
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const initial = (user.displayName || user.email || "?")
    .charAt(0)
    .toUpperCase();

  if (user.photoURL && !imgFailed) {
    return (
      <img
        src={user.photoURL}
        alt=""
        className="h-5 w-5 rounded-full shrink-0"
        referrerPolicy="no-referrer"
        crossOrigin="anonymous"
        onError={() => setImgFailed(true)}
      />
    );
  }

  return (
    <div className="flex h-5 w-5 rounded-full bg-primary text-primary-foreground items-center justify-center text-[10px] font-bold shrink-0">
      {initial}
    </div>
  );
}

export function UserMenu() {
  const {
    user,
    loading,
    isOnline,
    syncing,
    loginError,
    login,
    logout,
    syncToCloud,
    resetCloudAndReSync,
  } = useAuthStore();
  const effectivePlan = useEntitlementStore((s) => s.effectivePlan);
  const openPaywall = useEntitlementStore((s) => s.openPaywall);
  const openTeamManage = useEntitlementStore((s) => s.openTeamManage);
  const openFeedback = useFeedbackStore((s) => s.openFeedback);
  const telemetryConsent = useTelemetryStore((s) => s.consent);
  const telemetryReady = useTelemetryStore((s) => s.ready);
  const setTelemetryConsentChoice = useTelemetryStore((s) => s.setConsent);
  // Show the upgrade entry to Free users only (purchase UI stays dark until
  // launch via BILLING_ENABLED). internal (staff/owner real plan) sees neither
  // upgrade nor plan — they don't buy.
  const showUpgrade = BILLING_ENABLED && effectivePlan === "free";
  const isPaidPlan = effectivePlan === "pro" || effectivePlan === "team";
  // A paid user (pro/team — commonly bought via mobile IAP) must ALWAYS be able
  // to open the plan dialog to see usage (利用状況の確認) and manage/cancel the
  // subscription (サブスク管理), on EVERY platform and even while the purchase UI
  // is dark. Before, this required BILLING_ENABLED and excluded desktop, so a Pro
  // user on the shipped desktop build had no path at all (the reported dead-end).
  // The dialog's manage button is source-aware: it routes an IAP sub to the OS
  // store's own manager and a Stripe sub to the customer portal — anti-steering
  // safe on mobile.
  const showPlan = isPaidPlan;
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const syncMenuRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  const handleResetCloud = useCallback(async () => {
    setSyncMenuOpen(false);
    setMobileMenuOpen(false);
    if (!isOnline) {
      window.alert(
        "オフラインです。オンラインに接続してから再実行してください。",
      );
      return;
    }
    const ok = window.confirm(
      "クラウドをリセットして、このデバイスのドキュメントで上書きします。\n\n" +
        "正しいドキュメントがあるデバイスで実行してください。\n本当に実行しますか？",
    );
    if (!ok) return;
    // resetCloudAndReSync reports per-doc failures via { ok, failed }. Do NOT
    // claim success while individual upload/delete errors were swallowed — a
    // false "完了" alert let cloud/local diverge silently before.
    const { ok: resetOk, failed } = await resetCloudAndReSync();
    window.alert(
      resetOk
        ? "クラウドリセット完了。他のデバイスを再起動すると同期されます。"
        : failed > 0
          ? `一部のドキュメント（${failed}件）の同期に失敗しました。クラウドはこのデバイスと完全には一致していません。ネットワーク接続を確認して再度お試しください。`
          : "クラウドリセットに失敗しました。ネットワーク接続を確認して再度お試しください。",
    );
  }, [resetCloudAndReSync, isOnline]);

  // Open the plan dialog (usage meter + source-aware 契約を管理). Routing an
  // existing subscription to its correct management surface lives inside the
  // dialog, so this menu entry just opens it — one discoverable place for both
  // 利用状況 and サブスク管理.
  const handleOpenPlan = useCallback(() => {
    setMobileMenuOpen(false);
    openPaywall();
  }, [openPaywall]);

  useEffect(() => {
    if (!syncMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        syncMenuOpen &&
        syncMenuRef.current &&
        !syncMenuRef.current.contains(e.target as Node)
      ) {
        setSyncMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [syncMenuOpen]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        mobileMenuRef.current &&
        !mobileMenuRef.current.contains(e.target as Node)
      ) {
        setMobileMenuOpen(false);
      }
    };
    // pointerdown (not mousedown): iOS WKWebView only synthesizes mouse events
    // on "clickable" targets, so tapping blank space wouldn't dismiss the menu.
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [mobileMenuOpen]);

  if (loading) return null;

  if (!user) {
    return (
      <div className="flex items-center gap-1">
        {loginError && (
          <span
            className={`text-[10px] text-red-500 truncate ${isMobile ? "max-w-20" : "max-w-50"}`}
            title={loginError}
          >
            {loginError}
          </span>
        )}
        <Button
          variant="ghost"
          size={isMobile ? "icon" : "sm"}
          className={isMobile ? "h-11 w-11" : "gap-2 text-xs"}
          onClick={() => login("google")}
          title="Sign in with Google"
        >
          <LogIn className={isMobile ? "h-5 w-5" : "h-3.5 w-3.5"} />
          {!isMobile && "Sign in"}
        </Button>
        {/* GitHub sign-in — only rendered when the OAuth client id is configured
            at build time, so an unconfigured build never ships a dead button. */}
        {GITHUB_LOGIN_ENABLED && (
          <Button
            variant="ghost"
            size={isMobile ? "icon" : "sm"}
            className={isMobile ? "h-11 w-11" : "gap-2 text-xs"}
            onClick={() => login("github")}
            title="Sign in with GitHub"
          >
            <Github className={isMobile ? "h-5 w-5" : "h-3.5 w-3.5"} />
            {!isMobile && "GitHub"}
          </Button>
        )}
      </div>
    );
  }

  const btnSize = isMobile ? "h-11 w-11" : "h-7 w-7";
  const iconSize = isMobile ? "h-4.5 w-4.5" : "h-3.5 w-3.5";

  // Mobile: collapse Teams + Sync + Reset + Sign out behind a single
  // avatar-triggered dropdown so the top bar stays within one screen width
  // (a row of separate icon buttons overflowed and clipped the avatar/logout).
  if (isMobile) {
    const menuItem =
      "flex w-full items-center gap-2.5 rounded-sm px-3 py-2.5 text-sm text-left hover:bg-accent disabled:opacity-50";
    return (
      <div className="relative" ref={mobileMenuRef}>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-11 w-11"
          onClick={() => setMobileMenuOpen((v) => !v)}
          title="アカウント"
        >
          <UserAvatar user={user} />
          {syncing ? (
            <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background">
              <RefreshCw className="h-3 w-3 animate-spin text-blue-500" />
            </span>
          ) : (
            !isOnline && (
              <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background">
                <CloudOff className="h-3 w-3 text-amber-500" />
              </span>
            )
          )}
        </Button>
        {mobileMenuOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 min-w-56 rounded-md border border-border bg-popover p-1 shadow-md">
            <div className="truncate px-3 py-2 text-xs text-muted-foreground">
              {user.displayName || user.email}
            </div>
            <div className="my-1 border-t border-border" />
            <button
              className={menuItem}
              onClick={() => {
                setMobileMenuOpen(false);
                openTeamManage();
              }}
            >
              <Users className="h-4 w-4" />
              チーム管理
            </button>
            {showUpgrade && (
              <button
                className={menuItem}
                onClick={() => {
                  setMobileMenuOpen(false);
                  openPaywall();
                }}
              >
                <Sparkles className="h-4 w-4" />
                プランをアップグレード
              </button>
            )}
            {showPlan && (
              <button className={menuItem} onClick={handleOpenPlan}>
                <CreditCard className="h-4 w-4" />
                利用状況・プラン
              </button>
            )}
            <button
              className={menuItem}
              disabled={syncing || !isOnline}
              onClick={() => {
                setMobileMenuOpen(false);
                syncToCloud();
              }}
            >
              {isOnline ? (
                <Cloud className="h-4 w-4" />
              ) : (
                <CloudOff className="h-4 w-4" />
              )}
              {syncing ? "同期中…" : "同期"}
            </button>
            <button
              className={menuItem}
              disabled={syncing || !isOnline}
              onClick={handleResetCloud}
            >
              <DatabaseZap className="h-4 w-4" />
              クラウドリセット＆再同期
            </button>
            <div className="my-1 border-t border-border" />
            <button
              className={menuItem}
              onClick={() => {
                setMobileMenuOpen(false);
                openFeedback();
              }}
            >
              <MessageSquareWarning className="h-4 w-4" />
              問題を報告
            </button>
            {telemetryReady && (
              <button
                className={menuItem}
                onClick={() => setTelemetryConsentChoice(!telemetryConsent)}
                title="匿名の利用状況データの共有を切り替えます"
              >
                <BarChart3 className="h-4 w-4" />
                <span className="flex-1">利用状況データの共有</span>
                <span className="text-xs text-muted-foreground">
                  {telemetryConsent ? "オン" : "オフ"}
                </span>
              </button>
            )}
            <div className="my-1 border-t border-border" />
            <button
              className={cn(menuItem, "text-destructive")}
              onClick={() => {
                setMobileMenuOpen(false);
                logout();
              }}
            >
              <LogOut className="h-4 w-4" />
              サインアウト
            </button>
            <button
              className={cn(menuItem, "text-destructive")}
              onClick={() => {
                setMobileMenuOpen(false);
                setDeleteDialogOpen(true);
              }}
            >
              <Trash2 className="h-4 w-4" />
              アカウントを削除
            </button>
          </div>
        )}
        <DeleteAccountDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {showUpgrade && (
        <Button
          variant="ghost"
          size="icon"
          className={btnSize}
          onClick={() => openPaywall()}
          title="プランをアップグレード"
        >
          <Sparkles className={iconSize} />
        </Button>
      )}
      {showPlan && (
        <Button
          variant="ghost"
          size="icon"
          className={btnSize}
          onClick={handleOpenPlan}
          title="利用状況・プラン"
        >
          <CreditCard className={iconSize} />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className={btnSize}
        onClick={() => openTeamManage()}
        title="チーム管理"
      >
        <Users className={iconSize} />
      </Button>
      <div className="relative" ref={syncMenuRef}>
        <Button
          variant="ghost"
          size="icon"
          className={btnSize}
          onClick={() => setSyncMenuOpen((v) => !v)}
          disabled={syncing || !isOnline}
          title="同期メニュー"
        >
          {syncing ? (
            <RefreshCw className={cn(iconSize, "animate-spin")} />
          ) : isOnline ? (
            <Cloud className={iconSize} />
          ) : (
            <CloudOff className={iconSize} />
          )}
        </Button>
        {syncMenuOpen && (
          <div className="absolute right-0 top-full mt-1 z-50 min-w-48 rounded-md border border-border bg-popover p-1 shadow-md">
            <button
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-3 hover:bg-accent text-left",
                isMobile ? "py-2.5 text-sm" : "py-1.5 text-xs",
              )}
              onClick={() => {
                setSyncMenuOpen(false);
                syncToCloud();
              }}
            >
              <Cloud className="h-3 w-3" />
              同期
            </button>
            <div className="my-1 border-t border-border" />
            <button
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-3 hover:bg-accent text-left text-destructive disabled:opacity-50",
                isMobile ? "py-2.5 text-sm" : "py-1.5 text-xs",
              )}
              disabled={syncing || !isOnline}
              onClick={handleResetCloud}
            >
              <DatabaseZap className="h-3 w-3" />
              クラウドリセット＆再同期
            </button>
            <div className="my-1 border-t border-border" />
            <button
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-3 hover:bg-accent text-left",
                isMobile ? "py-2.5 text-sm" : "py-1.5 text-xs",
              )}
              onClick={() => {
                setSyncMenuOpen(false);
                openFeedback();
              }}
            >
              <MessageSquareWarning className="h-3 w-3" />
              問題を報告
            </button>
            {telemetryReady && (
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-3 hover:bg-accent text-left",
                  isMobile ? "py-2.5 text-sm" : "py-1.5 text-xs",
                )}
                onClick={() => setTelemetryConsentChoice(!telemetryConsent)}
                title="匿名の利用状況データの共有を切り替えます"
              >
                <BarChart3 className="h-3 w-3" />
                <span className="flex-1">利用状況データの共有</span>
                <span className="text-muted-foreground">
                  {telemetryConsent ? "オン" : "オフ"}
                </span>
              </button>
            )}
            <div className="my-1 border-t border-border" />
            <button
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-3 hover:bg-accent text-left text-destructive",
                isMobile ? "py-2.5 text-sm" : "py-1.5 text-xs",
              )}
              onClick={() => {
                setSyncMenuOpen(false);
                setDeleteDialogOpen(true);
              }}
            >
              <Trash2 className="h-3 w-3" />
              アカウントを削除
            </button>
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <UserAvatar user={user} />
        {!isMobile && (
          <span className="text-xs text-muted-foreground max-w-25 truncate">
            {user.displayName || user.email}
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className={btnSize}
        onClick={logout}
        title="Sign out"
      >
        <LogOut className={iconSize} />
      </Button>
      <DeleteAccountDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
      />
    </div>
  );
}
