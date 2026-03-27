import { useState, useRef, useEffect, useCallback } from "react";
import { LogIn, LogOut, Cloud, CloudOff, RefreshCw, Users, Bell, DatabaseZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";
import { TeamManageDialog } from "@/components/TeamManageDialog";
import { SlackSettingsDialog } from "@/components/SlackSettingsDialog";
import { isIOS } from "@/platform";

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
  const [slackOpen, setSlackOpen] = useState(false);
  const [loginMenuOpen, setLoginMenuOpen] = useState(false);
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const loginMenuRef = useRef<HTMLDivElement>(null);
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
    if (!loginMenuOpen && !syncMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (loginMenuOpen && loginMenuRef.current && !loginMenuRef.current.contains(e.target as Node)) {
        setLoginMenuOpen(false);
      }
      if (syncMenuOpen && syncMenuRef.current && !syncMenuRef.current.contains(e.target as Node)) {
        setSyncMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [loginMenuOpen, syncMenuOpen]);

  if (loading) return null;

  if (!user) {
    return (
      <div className="relative flex items-center gap-1" ref={loginMenuRef}>
        {loginError && (
          <span className={`text-[10px] text-red-500 truncate ${isIOS ? "max-w-20" : "max-w-50"}`} title={loginError}>
            {loginError}
          </span>
        )}
        <Button
          variant="ghost"
          size={isIOS ? "icon" : "sm"}
          className={isIOS ? "h-7 w-7" : "gap-2 text-xs"}
          onClick={() => setLoginMenuOpen((v) => !v)}
          title="Sign in"
        >
          <LogIn className="h-3.5 w-3.5" />
          {!isIOS && "Sign in"}
        </Button>
        {loginMenuOpen && (
          <div className="absolute right-0 top-full mt-1 z-50 min-w-45 rounded-md border border-border bg-popover p-1 shadow-md">
            <button
              className="flex w-full items-center gap-2 rounded-sm px-3 py-1.5 text-xs hover:bg-accent text-left"
              onClick={() => { setLoginMenuOpen(false); login("google"); }}
            >
              Google
            </button>
            <button
              className="flex w-full items-center gap-2 rounded-sm px-3 py-1.5 text-xs hover:bg-accent text-left"
              onClick={() => { setLoginMenuOpen(false); login("github"); }}
            >
              GitHub
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => setTeamOpen(true)}
        title="Manage Teams"
      >
        <Users className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => setSlackOpen(true)}
        title="Slack通知設定"
      >
        <Bell className="h-3.5 w-3.5" />
      </Button>
      <div className="relative" ref={syncMenuRef}>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setSyncMenuOpen((v) => !v)}
          disabled={syncing || !isOnline}
          title="同期メニュー"
        >
          {syncing ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          ) : isOnline ? (
            <Cloud className="h-3.5 w-3.5" />
          ) : (
            <CloudOff className="h-3.5 w-3.5" />
          )}
        </Button>
        {syncMenuOpen && (
          <div className="absolute right-0 top-full mt-1 z-50 min-w-48 rounded-md border border-border bg-popover p-1 shadow-md">
            <button
              className="flex w-full items-center gap-2 rounded-sm px-3 py-1.5 text-xs hover:bg-accent text-left"
              onClick={() => { setSyncMenuOpen(false); syncToCloud(); }}
            >
              <Cloud className="h-3 w-3" />
              同期
            </button>
            <div className="my-1 border-t border-border" />
            <button
              className="flex w-full items-center gap-2 rounded-sm px-3 py-1.5 text-xs hover:bg-accent text-left text-destructive"
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
        {!isIOS && (
          <span className="text-xs text-muted-foreground max-w-25 truncate">
            {user.displayName || user.email}
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={logout}
        title="Sign out"
      >
        <LogOut className="h-3.5 w-3.5" />
      </Button>
      <TeamManageDialog open={teamOpen} onOpenChange={setTeamOpen} />
      <SlackSettingsDialog open={slackOpen} onOpenChange={setSlackOpen} />
    </div>
  );
}
