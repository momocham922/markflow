import { useState, useRef, useEffect, useCallback } from "react";
import { LogIn, LogOut, Cloud, CloudOff, RefreshCw, Users, DatabaseZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import { TeamManageDialog } from "@/components/TeamManageDialog";
import { isMobile } from "@/platform";

function UserAvatar({ user }: { user: { photoURL: string | null; displayName: string | null; email: string | null } }) {
  const [imgFailed, setImgFailed] = useState(false);
  const initial = (user.displayName || user.email || "?").charAt(0).toUpperCase();

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
  const { user, loading, isOnline, syncing, loginError, login, logout, syncToCloud, resetCloudAndReSync } =
    useAuthStore();
  const [teamOpen, setTeamOpen] = useState(false);
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const syncMenuRef = useRef<HTMLDivElement>(null);

  const handleResetCloud = useCallback(async () => {
    setSyncMenuOpen(false);
    const ok = window.confirm(
      "クラウドをリセットして、このデバイスのドキュメントで上書きします。\n\n" +
      "正しいドキュメントがあるデバイスで実行してください。\n本当に実行しますか？"
    );
    if (!ok) return;
    await resetCloudAndReSync();
    window.alert("クラウドリセット完了。他のデバイスを再起動すると同期されます。");
  }, [resetCloudAndReSync]);

  useEffect(() => {
    if (!syncMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (syncMenuOpen && syncMenuRef.current && !syncMenuRef.current.contains(e.target as Node)) {
        setSyncMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [syncMenuOpen]);

  if (loading) return null;

  if (!user) {
    return (
      <div className="flex items-center gap-1">
        {loginError && (
          <span className={`text-[10px] text-red-500 truncate ${isMobile ? "max-w-20" : "max-w-50"}`} title={loginError}>
            {loginError}
          </span>
        )}
        <Button
          variant="ghost"
          size={isMobile ? "icon" : "sm"}
          className={isMobile ? "h-9 w-9" : "gap-2 text-xs"}
          onClick={() => login("google")}
          title="Sign in with Google"
        >
          <LogIn className={isMobile ? "h-4.5 w-4.5" : "h-3.5 w-3.5"} />
          {!isMobile && "Sign in"}
        </Button>
      </div>
    );
  }

  const btnSize = isMobile ? "h-9 w-9" : "h-7 w-7";
  const iconSize = isMobile ? "h-4 w-4" : "h-3.5 w-3.5";

  return (
    <div className="flex items-center gap-2">
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
              className={cn("flex w-full items-center gap-2 rounded-sm px-3 hover:bg-accent text-left", isMobile ? "py-2.5 text-sm" : "py-1.5 text-xs")}
              onClick={() => { setSyncMenuOpen(false); syncToCloud(); }}
            >
              <Cloud className="h-3 w-3" />
              同期
            </button>
            <div className="my-1 border-t border-border" />
            <button
              className={cn("flex w-full items-center gap-2 rounded-sm px-3 hover:bg-accent text-left text-destructive", isMobile ? "py-2.5 text-sm" : "py-1.5 text-xs")}
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
