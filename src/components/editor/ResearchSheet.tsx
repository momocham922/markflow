import { useEffect } from "react";
import { Search, X, Loader2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useResearchStore } from "@/stores/research-store";
import { triggerResearchAnalysis } from "@/hooks/use-research-pipeline";
import { ResearchCardList } from "./ResearchCardList";

/**
 * Mobile-only bottom sheet for the research assistant. Mounted ONCE in App.tsx
 * so it shares App's single `useIOSKeyboard` instance — calling that hook from a
 * second mounted component would fight over `document.body` styles. Open state
 * and settings live in the research store; keyboard geometry comes in via props.
 */
export function ResearchSheet({
  viewportHeight,
  keyboardVisible,
}: {
  viewportHeight: number;
  keyboardVisible: boolean;
}) {
  const cards = useResearchStore((s) => s.cards);
  const analyzing = useResearchStore((s) => s.analyzing);
  const sessionActive = useResearchStore((s) => s.sessionActive);
  const mobileLiveResearch = useResearchStore((s) => s.mobileLiveResearch);
  const includeInStructure = useResearchStore((s) => s.includeInStructure);
  const setMobileSheetOpen = useResearchStore((s) => s.setMobileSheetOpen);
  const setMobileLiveResearch = useResearchStore(
    (s) => s.setMobileLiveResearch,
  );
  const setIncludeInStructure = useResearchStore(
    (s) => s.setIncludeInStructure,
  );

  // Drop keyboard focus when the sheet opens so the on-screen keyboard retracts
  // and can't cover the sheet.
  useEffect(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
  }, []);

  // Sit the sheet on top of the keyboard when it's up; otherwise flush to the
  // bottom (safe-area padding handles the home indicator).
  const bottom = keyboardVisible
    ? Math.max(0, window.innerHeight - viewportHeight)
    : 0;
  const maxHeight = keyboardVisible
    ? Math.max(200, viewportHeight - 40)
    : "85vh";

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={() => setMobileSheetOpen(false)}
      />
      <div
        className="fixed left-0 right-0 z-50 flex flex-col rounded-t-2xl border-t border-border bg-background shadow-2xl safe-bottom"
        style={{ bottom, maxHeight }}
      >
        {/* Grab handle */}
        <div className="flex shrink-0 justify-center pt-2 pb-1">
          <div className="h-1 w-10 rounded-full bg-muted-foreground/30" />
        </div>

        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 pb-2">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            {analyzing ? (
              <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            <span>リサーチ ({cards.length})</span>
          </div>
          <div className="flex items-center gap-1.5">
            {sessionActive && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1 text-xs"
                onClick={triggerResearchAnalysis}
                disabled={analyzing}
                title="現在の文字起こしをすぐに解析"
              >
                {analyzing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Zap className="h-3.5 w-3.5" />
                )}
                今すぐ解析
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setMobileSheetOpen(false)}
              title="閉じる"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Settings */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <button
            onClick={() => setMobileLiveResearch(!mobileLiveResearch)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
              mobileLiveResearch
                ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                : "bg-muted text-muted-foreground"
            }`}
            title="録音中に自動でリサーチを実行（電池・通信量を消費します）"
          >
            自動リサーチ {mobileLiveResearch ? "ON" : "OFF"}
          </button>
          <button
            onClick={() => setIncludeInStructure(!includeInStructure)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
              includeInStructure
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "bg-muted text-muted-foreground"
            }`}
            title="リサーチ結果をStructure（自動整形）に組み込む"
          >
            組込 {includeInStructure ? "ON" : "OFF"}
          </button>
        </div>

        <ResearchCardList cards={cards} />
      </div>
    </>
  );
}
