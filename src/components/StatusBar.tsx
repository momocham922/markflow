import { Moon, Sun } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { isIOS } from "@/platform";

export function StatusBar() {
  const { theme, toggleTheme } = useAppStore();
  const { user, isOnline, syncing } = useAuthStore();

  // iOS: ultra-compact bar + safe area spacer (separate divs to avoid height conflicts)
  if (isIOS) {
    return (
      <div className="shrink-0 bg-background safe-left safe-right">
        {/* Thin content bar */}
        <div className="flex items-center justify-between border-t border-border px-3 py-0.5 text-[9px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span
              className={`h-1 w-1 rounded-full ${
                !user ? "bg-zinc-400" : isOnline ? "bg-emerald-500" : "bg-amber-500"
              }`}
            />
            {syncing && "Sync..."}
          </span>
          <button
            className="h-4 w-4 flex items-center justify-center text-muted-foreground"
            onClick={toggleTheme}
          >
            {theme === "light" ? <Moon className="h-2.5 w-2.5" /> : <Sun className="h-2.5 w-2.5" />}
          </button>
        </div>
        {/* Home indicator safe area — just background color, no content */}
        <div className="safe-bottom" />
      </div>
    );
  }

  // Desktop: full layout
  const { activeDocId, documents } = useAppStore();
  const activeDoc = documents.find((d) => d.id === activeDocId);

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
        {activeDoc && (
          <span>
            {(activeDoc.content || "").trim() ? (activeDoc.content || "").trim().split(/\s+/).length : 0} words / {(activeDoc.content || "").length} chars
          </span>
        )}
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
