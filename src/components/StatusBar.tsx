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
      <div
        className="flex items-center justify-between border-t border-border bg-background px-3 pt-1 pb-7 text-[9px] text-muted-foreground shrink-0"
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
