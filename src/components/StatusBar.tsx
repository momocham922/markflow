import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { useEditorStore } from "@/stores/editor-store";
import { isIOS } from "@/platform";

export function StatusBar() {
  const { theme, toggleTheme, activeDocId, documents } = useAppStore();
  const { user, isOnline, syncing } = useAuthStore();
  const activeDoc = documents.find((d) => d.id === activeDocId);
  const editor = useEditorStore((s) => s.editor);

  // Compute word/char count from editor text
  const text = editor?.getText() || "";
  const charCount = text.length;
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div className={`flex items-center justify-between border-t border-border bg-background px-3 text-[11px] text-muted-foreground ${isIOS ? "h-6 safe-bottom safe-left safe-right" : "h-7"}`}>
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
            {wordCount} words / {charCount} chars
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={toggleTheme}
          title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
        >
          {theme === "light" ? (
            <Moon className="h-3 w-3" />
          ) : (
            <Sun className="h-3 w-3" />
          )}
        </Button>
      </div>
    </div>
  );
}
