import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app-store";

export function StatusBar() {
  const { theme, toggleTheme, activeDocId, documents } = useAppStore();
  const activeDoc = documents.find((d) => d.id === activeDocId);

  return (
    <div className="flex h-7 items-center justify-between border-t border-border bg-background px-3 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Offline
        </span>
        {activeDoc && (
          <span>
            Last edited{" "}
            {new Date(activeDoc.updatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
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
