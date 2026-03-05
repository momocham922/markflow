import { LogIn, LogOut, Cloud, CloudOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";

export function UserMenu() {
  const { user, loading, isOnline, syncing, loginError, login, logout, syncToCloud } =
    useAuthStore();

  if (loading) return null;

  if (!user) {
    return (
      <div className="flex items-center gap-2">
        {loginError && (
          <span className="text-[10px] text-red-500 max-w-[200px] truncate" title={loginError}>
            {loginError}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-xs"
          onClick={login}
        >
          <LogIn className="h-3.5 w-3.5" />
          Sign in with Google
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={syncToCloud}
        disabled={syncing || !isOnline}
        title="Sync to cloud"
      >
        {syncing ? (
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        ) : isOnline ? (
          <Cloud className="h-3.5 w-3.5" />
        ) : (
          <CloudOff className="h-3.5 w-3.5" />
        )}
      </Button>
      <div className="flex items-center gap-1.5">
        {user.photoURL && (
          <img
            src={user.photoURL}
            alt=""
            className="h-5 w-5 rounded-full"
          />
        )}
        <span className="text-xs text-muted-foreground max-w-[100px] truncate">
          {user.displayName || user.email}
        </span>
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
    </div>
  );
}
