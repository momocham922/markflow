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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import {
  useEntitlementStore,
  BILLING_ENABLED,
} from "@/stores/entitlement-store";
import { TeamManageDialog } from "@/components/TeamManageDialog";
import { isMobile } from "@/platform";

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
  const openBillingPortal = useEntitlementStore((s) => s.openBillingPortal);
  // Show the upgrade entry to Free users; the manage entry to paying users.
  // internal (staff/owner real plan) sees neither — they don't buy.
  const showUpgrade = BILLING_ENABLED && effectivePlan === "free";
  const showManage =
    BILLING_ENABLED && (effectivePlan === "pro" || effectivePlan === "team");
  const [teamOpen, setTeamOpen] = useState(false);
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
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

  // Manage/cancel an existing subscription. openBillingPortal sets billingError
  // in the store, but that is only rendered inside PaywallDialog (closed here),
  // so we surface the failure ourselves — otherwise the button looks dead and a
  // user trying to CANCEL gets no feedback (silent failure).
  const handleManageSubscription = useCallback(async () => {
    setMobileMenuOpen(false);
    const res = await openBillingPortal();
    if (!res.ok && res.error) window.alert(res.error);
  }, [openBillingPortal]);

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
                setTeamOpen(true);
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
            {showManage && (
              <button className={menuItem} onClick={handleManageSubscription}>
                <CreditCard className="h-4 w-4" />
                契約を管理
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
              className={cn(menuItem, "text-destructive")}
              onClick={() => {
                setMobileMenuOpen(false);
                logout();
              }}
            >
              <LogOut className="h-4 w-4" />
              サインアウト
            </button>
          </div>
        )}
        <TeamManageDialog open={teamOpen} onOpenChange={setTeamOpen} />
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
      {showManage && (
        <Button
          variant="ghost"
          size="icon"
          className={btnSize}
          onClick={handleManageSubscription}
          title="契約を管理"
        >
          <CreditCard className={iconSize} />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className={btnSize}
        onClick={() => setTeamOpen(true)}
        title="Manage Teams"
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
      <TeamManageDialog open={teamOpen} onOpenChange={setTeamOpen} />
    </div>
  );
}
