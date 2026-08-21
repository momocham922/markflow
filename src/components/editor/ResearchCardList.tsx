import { useState } from "react";
import { useResearchStore } from "@/stores/research-store";
import type { ResearchCard, ResearchSource } from "@/stores/research-store";
import { useAppStore } from "@/stores/app-store";
import {
  useEntitlementStore,
  BILLING_ENABLED,
} from "@/stores/entitlement-store";
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
  const analysisError = useResearchStore((s) => s.analysisError);
  const setAnalysisError = useResearchStore((s) => s.setAnalysisError);
  const featureGated = useResearchStore((s) => s.featureGated);
  const openPaywall = useEntitlementStore((s) => s.openPaywall);
  const setActiveDocId = useAppStore((s) => s.setActiveDocId);
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);

  // Dismissible inline banner for a manual-analyze failure (network/server).
  // Rendered above both the empty state and the list so it always surfaces.
  const errorBanner = analysisError ? (
    <div className="m-2 flex items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <span className="min-w-0 break-words">{analysisError}</span>
      <button
        className="shrink-0 rounded px-1 font-medium hover:bg-destructive/20"
        onClick={() => setAnalysisError(null)}
        title="閉じる"
      >
        ✕
      </button>
    </div>
  ) : null;

  if (cards.length === 0) {
    return (
      <div className="flex flex-1 flex-col">
        {errorBanner}
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
          {featureGated ? (
            <>
              <span>
                自動リサーチはProプランの機能です。「今すぐ解析」で手動リサーチをご利用いただけます。
              </span>
              {BILLING_ENABLED && (
                <button
                  className="rounded-md bg-primary/10 px-3 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
                  onClick={() => openPaywall()}
                >
                  Proにアップグレード
                </button>
              )}
            </>
          ) : (
            "録音すると、会議内容に関するリサーチがここに表示されます。"
          )}
        </div>
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
      {errorBanner}
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
              } catch (e) {
                // Surface the real reason instead of a flat "Retry failed", and
                // always clear the loading flag so the card isn't stuck spinning.
                updateCard(card.id, {
                  error:
                    e instanceof Error ? e.message : "再試行に失敗しました",
                  loading: false,
                });
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
