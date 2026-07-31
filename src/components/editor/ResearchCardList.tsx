import { useState } from "react";
import { useResearchStore } from "@/stores/research-store";
import type { ResearchCard, ResearchSource } from "@/stores/research-store";
import { useAppStore } from "@/stores/app-store";
import { groundedSearch } from "@/services/research";
import { getPlatform } from "@/platform";
import { insertResearchCard } from "@/hooks/use-research-window";
import { ResearchCardItem } from "./ResearchCardItem";

function openExternal(url: string) {
  getPlatform()
    .then((p) => p.openExternal(url))
    .catch((e) => console.error("[research] openExternal failed", e));
}

/**
 * Presentational list of research cards plus all the per-card action wiring
 * (expand, dismiss, queue-for-structure, retry, open internal/external links).
 * Shared by the desktop web-fallback panel (ResearchPanel) and the mobile
 * bottom sheet (ResearchSheet) so both surfaces behave identically.
 */
export function ResearchCardList({ cards }: { cards: ResearchCard[] }) {
  const removeCard = useResearchStore((s) => s.removeCard);
  const updateCard = useResearchStore((s) => s.updateCard);
  const setActiveDocId = useAppStore((s) => s.setActiveDocId);
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);

  if (cards.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
        録音すると、会議内容に関するリサーチがここに表示されます。
      </div>
    );
  }

  return (
    // Native scroll container — Radix ScrollArea does not touch-scroll
    // reliably in iOS WKWebView. Matches the codebase's mobile-scroll idiom
    // (Sidebar context menu): overflow-y-auto + momentum + contained overscroll.
    // Works identically on desktop (native scrollbar).
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      style={{
        WebkitOverflowScrolling: "touch",
        overscrollBehavior: "contain",
      }}
    >
      <div className="flex flex-col gap-1.5 p-2">
        {cards.map((card) => (
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
                    credibility: s.credibility as ResearchSource["credibility"],
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
    </div>
  );
}
