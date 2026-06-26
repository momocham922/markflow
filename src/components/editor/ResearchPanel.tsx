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
  financial: {
    label: "Financial",
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  "explicit-request": {
    label: "Request",
    className: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  },
  internal: {
    label: "Internal",
    className: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
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
      const result = await groundedSearch(
        card.query,
        card.type,
        card.trigger,
        "",
      );
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
    <div className="w-full rounded-lg border border-border bg-background/95 p-2.5 text-xs shadow-md backdrop-blur">
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${typeStyle.className}`}
          >
            {typeStyle.label}
          </span>
          <span className="truncate text-[10px] text-muted-foreground">
            {card.query}
          </span>
        </div>
        <div className="flex shrink-0 items-center">
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
        <div className="mt-1.5 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span className="truncate">Searching...</span>
        </div>
      )}

      {card.error && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="text-destructive text-[10px]">{card.error}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[10px]"
            onClick={handleRetry}
            disabled={retrying}
          >
            {retrying ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
          </Button>
        </div>
      )}

      {!card.loading && !card.error && (
        <>
          <div className="mt-1 leading-relaxed text-foreground research-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                p: ({ node, ...props }) => (
                  <p className="mb-0.5 last:mb-0" {...props} />
                ),
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                ul: ({ node, ...props }) => (
                  <ul className="list-disc pl-3 mb-0.5" {...props} />
                ),
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                ol: ({ node, ...props }) => (
                  <ol className="list-decimal pl-3 mb-0.5" {...props} />
                ),
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                li: ({ node, ...props }) => <li className="mb-0" {...props} />,
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                strong: ({ node, ...props }) => (
                  <strong className="font-semibold" {...props} />
                ),
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                h3: ({ node, ...props }) => (
                  <h3
                    className="text-xs font-semibold mt-1 mb-0.5"
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
              {expanded ? card.summary : card.summary.slice(0, 150)}
            </ReactMarkdown>
            {!expanded && card.summary.length > 150 && (
              <span className="text-muted-foreground">...</span>
            )}
          </div>

          {expanded && card.sources.length > 0 && (
            <div className="mt-1.5 space-y-0.5 border-t border-border pt-1.5">
              {card.sources.slice(0, 3).map((source, i) => {
                const cfg = CRED_CONFIG[source.credibility];
                const Icon = cfg.icon;
                const isInternal = source.url.startsWith("markflow://");

                return (
                  <div key={i} className="flex items-center gap-1 text-[10px]">
                    <Icon className={`h-2.5 w-2.5 shrink-0 ${cfg.className}`} />
                    {isInternal ? (
                      <button
                        className="truncate text-left text-blue-600 hover:underline dark:text-blue-400"
                        onClick={() => {
                          const docId = source.url.replace(
                            "markflow://doc/",
                            "",
                          );
                          handleInternalLink(docId);
                        }}
                      >
                        <FileText className="mr-0.5 inline h-2.5 w-2.5" />
                        {source.title}
                      </button>
                    ) : (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-0.5 truncate text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {source.title || source.domain}
                        <ExternalLink className="h-2 w-2 shrink-0" />
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <button
            onClick={onToggle}
            className="mt-1 flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <>
                <ChevronUp className="h-3 w-3" /> Less
              </>
            ) : (
              <>
                <ChevronDown className="h-3 w-3" /> Sources (
                {card.sources.length})
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
    <div className="absolute right-4 top-12 z-50 flex max-h-[60vh] w-80 flex-col rounded-lg border border-border bg-background/95 shadow-lg backdrop-blur">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-2.5 py-1.5">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <Search className="h-3 w-3" />
          <span>Research ({activeCards.length})</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={togglePanel}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
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
              onIntegrate={() => markIntegrated(card.id)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
