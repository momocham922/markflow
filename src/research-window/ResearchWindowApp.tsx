import { useEffect, useState, useCallback } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { Search, X, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResearchCardItem } from "@/components/editor/ResearchCardItem";
import type { ResearchCard } from "@/stores/research-store";
import type { ResearchSyncPayload } from "@/hooks/use-research-window";

function applyTheme(theme: "light" | "dark") {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function emitAction(
  action:
    | "dismiss"
    | "insert"
    | "clear"
    | "retry"
    | "open-doc"
    | "set-include"
    | "dismiss-error",
  extra?: { id?: string; docId?: string; value?: boolean },
) {
  emit("research:action", { action, ...extra }).catch(() => {});
}

async function openExternal(url: string) {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch (e) {
    console.error("[research-window] openExternal failed", e);
  }
}

async function closeWindow() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  } catch (e) {
    console.error("[research-window] close failed", e);
  }
}

export function ResearchWindowApp() {
  const [cards, setCards] = useState<ResearchCard[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [includeInStructure, setIncludeInStructure] = useState(false);
  const [featureGated, setFeatureGated] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);

  useEffect(() => {
    // Initial theme guess before first sync arrives.
    applyTheme(
      window.matchMedia?.("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light",
    );

    let unlisten: (() => void) | null = null;
    let disposed = false;

    (async () => {
      unlisten = await listen<ResearchSyncPayload>("research:sync", (ev) => {
        setCards(ev.payload.cards);
        setAnalyzing(ev.payload.analyzing);
        setIncludeInStructure(ev.payload.includeInStructure);
        setFeatureGated(ev.payload.featureGated);
        setAnalysisError(ev.payload.analysisError);
        applyTheme(ev.payload.theme);
      });
      if (disposed) {
        unlisten?.();
        return;
      }
      // Ask the main window for the current state, retry once for races.
      emit("research:ready").catch(() => {});
      setTimeout(() => emit("research:ready").catch(() => {}), 250);
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const handleOpenInternal = useCallback((docId: string) => {
    emitAction("open-doc", { docId });
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden rounded-xl border border-border bg-background/95 shadow-2xl backdrop-blur-md">
      <div
        data-tauri-drag-region
        className="flex shrink-0 cursor-grab items-center justify-between border-b border-border px-2.5 py-1.5 select-none active:cursor-grabbing"
      >
        <div
          data-tauri-drag-region
          className="flex items-center gap-1.5 text-xs font-medium"
        >
          {analyzing ? (
            <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
          ) : (
            <Search className="h-3 w-3" />
          )}
          <span data-tauri-drag-region>
            Research ({cards.length})
            {analyzing && (
              <span className="ml-1 text-[10px] font-normal text-blue-500">
                Analyzing...
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() =>
              emitAction("set-include", { value: !includeInStructure })
            }
            title="リサーチ結果をStructure（自動整形）に組み込む"
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
              includeInStructure
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            組込 {includeInStructure ? "ON" : "OFF"}
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() => emitAction("clear")}
            title="Clear all"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={closeWindow}
            title="閉じる"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Dismissible error banner — mirrors ResearchCardList so a manual-analyze
          failure surfaces here too (this window is the primary desktop surface
          when popped out; a silent failure would violate サイレントフォールバック禁止). */}
      {analysisError && (
        <div className="m-2 flex items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span className="min-w-0 break-words">{analysisError}</span>
          <button
            className="shrink-0 rounded px-1 font-medium hover:bg-destructive/20"
            onClick={() => emitAction("dismiss-error")}
            title="閉じる"
          >
            ✕
          </button>
        </div>
      )}

      <ScrollArea className="research-scroll min-h-0 flex-1">
        <div className="flex flex-col gap-1.5 p-2">
          {cards.length === 0 ? (
            <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
              {analyzing
                ? "分析中…"
                : featureGated
                  ? "自動リサーチはProプランの機能です。「今すぐ解析」で手動リサーチをご利用いただけます。"
                  : "リサーチ結果はまだありません"}
            </div>
          ) : (
            cards.map((card) => (
              <ResearchCardItem
                key={card.id}
                card={card}
                expanded={expandedCardId === card.id}
                onToggle={() =>
                  setExpandedCardId(expandedCardId === card.id ? null : card.id)
                }
                onDismiss={() => emitAction("dismiss", { id: card.id })}
                onInsert={() => emitAction("insert", { id: card.id })}
                onRetry={async () => emitAction("retry", { id: card.id })}
                onOpenInternal={handleOpenInternal}
                onOpenExternal={openExternal}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
