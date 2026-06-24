import { useState } from "react";
import {
  Search,
  X,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Loader2,
  GraduationCap,
  Building,
  Newspaper,
  Globe,
  FileText,
  ExternalLink,
  Check,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useResearchStore } from "@/stores/research-store";
import type { ResearchCard, ResearchSource } from "@/stores/research-store";
import { useAppStore } from "@/stores/app-store";
import { groundedSearch } from "@/services/research";

const TYPE_STYLES: Record<
  ResearchCard["type"],
  { label: string; className: string }
> = {
  topic: {
    label: "Topic",
    className: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  },
  "fact-check": {
    label: "Fact Check",
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  "explicit-request": {
    label: "Request",
    className: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  },
  internal: {
    label: "Internal",
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
};

const CRED_CONFIG: Record<
  ResearchSource["credibility"],
  { icon: typeof Globe; label: string; className: string }
> = {
  academic: {
    icon: GraduationCap,
    label: "Academic",
    className: "text-blue-600 dark:text-blue-400",
  },
  official: {
    icon: Building,
    label: "Official",
    className: "text-emerald-600 dark:text-emerald-400",
  },
  news: {
    icon: Newspaper,
    label: "News",
    className: "text-amber-600 dark:text-amber-400",
  },
  general: { icon: Globe, label: "Web", className: "text-muted-foreground" },
};

function ResearchCardItem({
  card,
  expanded,
  onToggle,
  onDismiss,
  onIntegrate,
}: {
  card: ResearchCard;
  expanded: boolean;
  onToggle: () => void;
  onDismiss: () => void;
  onIntegrate: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const typeStyle = TYPE_STYLES[card.type];

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const result = await groundedSearch(card.query, card.trigger, card.type);
      useResearchStore.getState().updateCard(card.id, {
        summary: result.summary,
        sources: result.sources.map((s) => ({
          ...s,
          credibility: s.credibility as ResearchSource["credibility"],
        })),
        loading: false,
        error: undefined,
      });
    } catch {
      useResearchStore.getState().updateCard(card.id, {
        error: "Retry failed",
      });
    } finally {
      setRetrying(false);
    }
  };

  const handleInternalLink = (docId: string) => {
    useAppStore.getState().setActiveDocId(docId);
  };

  return (
    <div className="w-full rounded-lg border border-border bg-background/95 p-3 text-xs shadow-md backdrop-blur">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${typeStyle.className}`}
          >
            {typeStyle.label}
          </span>
          {card.credibility !== "general" && (
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
              {(() => {
                const cfg = CRED_CONFIG[card.credibility];
                const Icon = cfg.icon;
                return <Icon className={`h-3 w-3 ${cfg.className}`} />;
              })()}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {!card.loading && !card.error && (
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={onIntegrate}
              title="Mark as integrated"
            >
              <Check className="h-3 w-3" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={onDismiss}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {card.loading && (
        <div className="mt-2 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Searching: {card.query}</span>
        </div>
      )}

      {card.error && (
        <div className="mt-2">
          <p className="text-destructive">{card.error}</p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 h-6 px-2 text-[10px]"
            onClick={handleRetry}
            disabled={retrying}
          >
            {retrying ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3 w-3" />
            )}
            Retry
          </Button>
        </div>
      )}

      {!card.loading && !card.error && (
        <>
          <div className="mt-1.5 leading-relaxed text-foreground research-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                p: ({ node, ...props }) => (
                  <p className="mb-1 last:mb-0" {...props} />
                ),
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                ul: ({ node, ...props }) => (
                  <ul className="list-disc pl-3.5 mb-1" {...props} />
                ),
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                ol: ({ node, ...props }) => (
                  <ol className="list-decimal pl-3.5 mb-1" {...props} />
                ),
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                li: ({ node, ...props }) => (
                  <li className="mb-0.5" {...props} />
                ),
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                strong: ({ node, ...props }) => (
                  <strong className="font-semibold" {...props} />
                ),
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                h3: ({ node, ...props }) => (
                  <h3
                    className="text-xs font-semibold mt-1.5 mb-0.5"
                    {...props}
                  />
                ),
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                code: ({ node, ...props }) => (
                  <code
                    className="bg-muted rounded px-1 py-0.5 text-[10px]"
                    {...props}
                  />
                ),
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                a: ({ node, ...props }) => (
                  <a
                    className="text-blue-600 hover:underline dark:text-blue-400"
                    target="_blank"
                    rel="noopener noreferrer"
                    {...props}
                  />
                ),
              }}
            >
              {expanded ? card.summary : card.summary.slice(0, 200)}
            </ReactMarkdown>
            {!expanded && card.summary.length > 200 && (
              <span className="text-muted-foreground">...</span>
            )}
          </div>

          {expanded && card.sources.length > 0 && (
            <div className="mt-2 space-y-1 border-t border-border pt-2">
              {card.sources.map((source, i) => {
                const cfg = CRED_CONFIG[source.credibility];
                const Icon = cfg.icon;
                const isInternal = source.url.startsWith("markflow://");

                return (
                  <div key={i} className="flex items-start gap-1.5">
                    <Icon
                      className={`mt-0.5 h-3 w-3 shrink-0 ${cfg.className}`}
                    />
                    {isInternal ? (
                      <button
                        className="text-left text-blue-600 hover:underline dark:text-blue-400"
                        onClick={() => {
                          const docId = source.url.replace(
                            "markflow://doc/",
                            "",
                          );
                          handleInternalLink(docId);
                        }}
                      >
                        <FileText className="mr-0.5 inline h-3 w-3" />
                        {source.title}
                      </button>
                    ) : (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-0.5 text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {source.title || source.domain}
                        <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <button
            onClick={onToggle}
            className="mt-1.5 flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <>
                <ChevronUp className="h-3 w-3" /> Less
              </>
            ) : (
              <>
                <ChevronDown className="h-3 w-3" /> More ({card.sources.length}{" "}
                sources)
              </>
            )}
          </button>
        </>
      )}
    </div>
  );
}

export function ResearchPanel() {
  const { cards, panelVisible, togglePanel, removeCard, markIntegrated } =
    useResearchStore();
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);

  const activeCards = cards.filter((c) => !c.integrated);

  if (!panelVisible || activeCards.length === 0) return null;

  return (
    <div className="absolute bottom-20 right-4 z-50 flex w-80 max-h-[60vh] flex-col gap-2">
      <div className="flex items-center justify-between rounded-lg border border-border bg-background/95 px-3 py-1.5 shadow-lg backdrop-blur">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <Search className="h-3.5 w-3.5" />
          <span>Research ({activeCards.length})</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={togglePanel}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <ScrollArea className="max-h-[55vh]">
        <div className="flex flex-col gap-2 pr-2">
          {activeCards.map((card) => (
            <ResearchCardItem
              key={card.id}
              card={card}
              expanded={expandedCardId === card.id}
              onToggle={() =>
                setExpandedCardId(expandedCardId === card.id ? null : card.id)
              }
              onDismiss={() => removeCard(card.id)}
              onIntegrate={() => markIntegrated(card.id)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
