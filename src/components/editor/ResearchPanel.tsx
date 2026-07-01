import { useState, useRef, useCallback } from "react";
import {
  Search,
  X,
  Loader2,
  GripVertical,
  Trash2,
  PictureInPicture2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { useResearchStore } from "@/stores/research-store";
import type { ResearchSource } from "@/stores/research-store";
import { useAppStore } from "@/stores/app-store";
import { groundedSearch } from "@/services/research";
import { getPlatform, isTauri, isMobile } from "@/platform";
import {
  openResearchWindow,
  insertResearchCard,
} from "@/hooks/use-research-window";
import { ResearchCardItem } from "./ResearchCardItem";

const canPopOut = isTauri && !isMobile;

function openExternal(url: string) {
  getPlatform()
    .then((p) => p.openExternal(url))
    .catch((e) => console.error("[research] openExternal failed", e));
}

/**
 * Desktop: a minimal presence indicator. The actual reading experience is the
 * detached floating window (content clips when squeezed into the editor), so
 * this just signals that research suggestions exist and nudges to detach.
 */
function ResearchIndicator({
  count,
  analyzing,
}: {
  count: number;
  analyzing: boolean;
}) {
  return (
    // Anchored to the editor's right-middle edge — clear of the top toolbar
    // buttons and the bottom voice panel.
    <div className="absolute right-3 top-1/2 z-40 -translate-y-1/2">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => openResearchWindow()}
            className="flex items-center gap-1.5 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur transition-colors hover:bg-accent"
          >
            {analyzing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
            ) : (
              <Search className="h-3.5 w-3.5 text-blue-500" />
            )}
            <span>{count > 0 ? `リサーチ ${count}` : "リサーチ中…"}</span>
            <PictureInPicture2 className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">
          {count > 0
            ? `リサーチ候補が${count}件。クリックで別ウィンドウに表示`
            : "リサーチアシスタントが分析中。クリックで別ウィンドウを開く"}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export function ResearchPanel() {
  const {
    cards,
    panelVisible,
    analyzing,
    poppedOut,
    includeInStructure,
    togglePanel,
    removeCard,
    updateCard,
    clearCards,
    setIncludeInStructure,
  } = useResearchStore();
  const setActiveDocId = useAppStore((s) => s.setActiveDocId);
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, ox: 0, oy: 0 });
  const panelRef = useRef<HTMLDivElement>(null);

  // Show all cards — integrated ones get a badge, they are NOT hidden.
  const activeCards = cards;

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      isDraggingRef.current = true;
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        ox: dragOffset.x,
        oy: dragOffset.y,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [dragOffset],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDraggingRef.current) return;
      let nx = dragStartRef.current.ox + (e.clientX - dragStartRef.current.x);
      let ny = dragStartRef.current.oy + (e.clientY - dragStartRef.current.y);
      // Keep the panel within the viewport. rect includes the current
      // translate, so subtract dragOffset to recover the untranslated anchor.
      const rect = panelRef.current?.getBoundingClientRect();
      if (rect) {
        const baseLeft = rect.left - dragOffset.x;
        const baseTop = rect.top - dragOffset.y;
        nx = Math.min(
          window.innerWidth - rect.width - 8 - baseLeft,
          Math.max(8 - baseLeft, nx),
        );
        ny = Math.min(
          window.innerHeight - rect.height - 8 - baseTop,
          Math.max(8 - baseTop, ny),
        );
      }
      setDragOffset({ x: nx, y: ny });
    },
    [dragOffset],
  );

  const handlePointerUp = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  const handleResetPosition = useCallback(() => {
    setDragOffset({ x: 0, y: 0 });
  }, []);

  // Desktop: the floating window is the reading surface; show a minimal chip.
  if (canPopOut) {
    if (poppedOut) return null;
    if (activeCards.length === 0 && !analyzing) return null;
    return (
      <ResearchIndicator count={activeCards.length} analyzing={analyzing} />
    );
  }

  // Web fallback (no detach available): full in-app panel.
  if (!panelVisible || activeCards.length === 0) return null;

  return (
    <div
      ref={panelRef}
      className="fixed right-4 top-12 z-[9999] flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-lg border border-border bg-background/95 shadow-xl backdrop-blur"
      style={{
        transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
      }}
    >
      <div
        className="flex shrink-0 cursor-grab items-center justify-between border-b border-border px-2.5 py-1.5 select-none active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleResetPosition}
        style={{ touchAction: "none" }}
      >
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <GripVertical className="h-3 w-3 text-muted-foreground" />
          {analyzing ? (
            <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
          ) : (
            <Search className="h-3 w-3" />
          )}
          <span>
            Research ({activeCards.length})
            {analyzing && (
              <span className="ml-1 text-[10px] font-normal text-blue-500">
                Analyzing...
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setIncludeInStructure(!includeInStructure)}
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
            onClick={clearCards}
            title="Clear all"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={togglePanel}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <ScrollArea className="research-scroll min-h-0 flex-1">
        <div className="flex flex-col gap-1.5 p-2">
          {activeCards.map((card) => (
            <ResearchCardItem
              key={card.id}
              card={card}
              expanded={expandedCardId === card.id}
              onToggle={() =>
                setExpandedCardId(expandedCardId === card.id ? null : card.id)
              }
              onDismiss={() => removeCard(card.id)}
              onInsert={() => insertResearchCard(card)}
              onRetry={async () => {
                try {
                  const result = await groundedSearch(
                    card.query,
                    card.type,
                    card.trigger,
                    "",
                  );
                  updateCard(card.id, {
                    summary: result.summary,
                    sources: result.sources.map((s) => ({
                      ...s,
                      credibility:
                        s.credibility as ResearchSource["credibility"],
                    })),
                    loading: false,
                    error: undefined,
                  });
                } catch {
                  updateCard(card.id, { error: "Retry failed" });
                }
              }}
              onOpenInternal={(docId) => setActiveDocId(docId)}
              onOpenExternal={openExternal}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
