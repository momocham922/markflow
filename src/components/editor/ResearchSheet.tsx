import { useEffect, useRef, useState, useCallback } from "react";
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
  const featureGated = useResearchStore((s) => s.featureGated);
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

  // Swipe-down-to-close via pointer drag on the grab handle. Pointer events
  // (not HTML5 drag / touch) per this codebase's WKWebView constraints.
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef(0);
  const draggingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);

  const onDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore a second finger landing mid-drag — it would clobber dragStartRef
    // and make the sheet jump.
    if (draggingRef.current) return;
    draggingRef.current = true;
    pointerIdRef.current = e.pointerId;
    dragStartRef.current = e.clientY;
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || e.pointerId !== pointerIdRef.current) return;
    // Downward drags only — clamp negatives so the sheet can't be lifted above
    // its docked position.
    setDragY(Math.max(0, e.clientY - dragStartRef.current));
  }, []);

  const onDragEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current || e.pointerId !== pointerIdRef.current) return;
      draggingRef.current = false;
      pointerIdRef.current = null;
      // Read the release position directly from the up event (reliable), rather
      // than via a state updater — decouples dismiss logic from render timing.
      const y = Math.max(0, e.clientY - dragStartRef.current);
      setDragging(false);
      setDragY(0);
      // Past the threshold → dismiss; otherwise snap back (transition handles
      // the animation once `dragging` is false).
      if (y > 110) setMobileSheetOpen(false);
    },
    [setMobileSheetOpen],
  );

  // pointercancel is an OS interruption (banner, palm, capture loss) — always
  // snap back, never dismiss, even if the finger had passed the threshold.
  const onDragCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || e.pointerId !== pointerIdRef.current) return;
    draggingRef.current = false;
    pointerIdRef.current = null;
    setDragging(false);
    setDragY(0);
  }, []);

  // Sit the sheet on top of the keyboard when it's up; otherwise flush to the
  // bottom (safe-area padding handles the home indicator).
  const bottom = keyboardVisible
    ? Math.max(0, window.innerHeight - viewportHeight)
    : 0;
  const maxHeight = keyboardVisible
    ? Math.max(200, viewportHeight - 40)
    : "85vh";
  // Without a floor the sheet shrink-wraps to a thin band when there are only a
  // few cards, stranding the content near the bottom of the screen. Give it a
  // comfortable minimum so its top edge sits well up the viewport. When the
  // keyboard is up, available room is limited — let it size to content instead.
  const minHeight = keyboardVisible ? undefined : "55vh";

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={() => setMobileSheetOpen(false)}
      />
      <div
        className="fixed left-0 right-0 z-50 flex flex-col rounded-t-2xl border-t border-border bg-background shadow-2xl safe-bottom"
        style={{
          bottom,
          maxHeight,
          minHeight,
          transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition: dragging ? "none" : "transform 0.2s ease-out",
        }}
      >
        {/* Grab handle — drag down to dismiss */}
        <div
          className="flex shrink-0 cursor-grab justify-center pt-3 pb-2 active:cursor-grabbing"
          style={{ touchAction: "none" }}
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragCancel}
        >
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

        {/* Capability gate notice: the "自動リサーチ" toggle above is inert on the
            Free plan (auto research is Pro+, MONETIZATION §1.3). Say so instead of
            leaving the toggle looking broken. Manual "今すぐ解析" still works. Only
            when cards exist — at 0 cards, ResearchCardList's empty state shows the
            same message, so this would otherwise duplicate it. */}
        {featureGated && cards.length > 0 && (
          <div className="shrink-0 border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
            自動リサーチはProプランの機能です。「今すぐ解析」で手動リサーチをご利用いただけます。
          </div>
        )}

        <ResearchCardList cards={cards} />
      </div>
    </>
  );
}
