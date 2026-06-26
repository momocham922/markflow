import { useState, useRef, useCallback } from "react";
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
  GripVertical,
  Copy,
  Trash2,
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
  const [copied, setCopied] = useState(false);
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

  const handleCopy = async () => {
    const sourcesText = card.sources
      .slice(0, 3)
      .map((s) => `- ${s.title}: ${s.url}`)
      .join("\n");
    const text = `${card.summary}${sourcesText ? `\n\nSources:\n${sourcesText}` : ""}`;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleInternalLink = (docId: string) => {
    useAppStore.getState().setActiveDocId(docId);
  };

  return (
    <div className="w-full overflow-hidden rounded-lg border border-border bg-background/95 p-2.5 text-xs shadow-md backdrop-blur">
      <div className="flex items-center justify-between gap-1">
        <div className="flex min-w-0 items-center gap-1.5">
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
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={handleCopy}
                title="Copy to clipboard"
              >
                {copied ? (
                  <Check className="h-3 w-3 text-emerald-500" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={onIntegrate}
                title="Mark as integrated"
              >
                <Check className="h-3 w-3" />
              </Button>
            </>
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
          <span className="text-[10px] text-destructive">{card.error}</span>
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
          <div className="research-markdown mt-1 break-words leading-relaxed text-foreground">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                p: ({ node, ...props }) => (
                  <p className="mb-0.5 last:mb-0" {...props} />
                ),
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                ul: ({ node, ...props }) => (
                  <ul className="mb-0.5 list-disc pl-3" {...props} />
                ),
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                ol: ({ node, ...props }) => (
                  <ol className="mb-0.5 list-decimal pl-3" {...props} />
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
                    className="mb-0.5 mt-1 text-xs font-semibold"
                    {...props}
                  />
                ),
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                code: ({ node, ...props }) => (
                  <code
                    className="rounded bg-muted px-1 py-0.5 text-[10px]"
                    {...props}
                  />
                ),
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                a: ({ node, ...props }) => (
                  <a
                    className="break-all text-blue-600 hover:underline dark:text-blue-400"
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
                  <div
                    key={i}
                    className="flex min-w-0 items-center gap-1 text-[10px]"
                  >
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
                        className="flex min-w-0 items-center gap-0.5 truncate text-blue-600 hover:underline dark:text-blue-400"
                      >
                        <span className="truncate">
                          {source.title || source.domain}
                        </span>
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
  const {
    cards,
    panelVisible,
    analyzing,
    togglePanel,
    removeCard,
    markIntegrated,
    clearCards,
  } = useResearchStore();
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

  const activeCards = cards.filter((c) => !c.integrated);

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
      setDragOffset({
        x: dragStartRef.current.ox + (e.clientX - dragStartRef.current.x),
        y: dragStartRef.current.oy + (e.clientY - dragStartRef.current.y),
      });
    },
    [],
  );

  const handlePointerUp = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  const handleResetPosition = useCallback(() => {
    setDragOffset({ x: 0, y: 0 });
  }, []);

  if (!panelVisible || activeCards.length === 0) return null;

  return (
    <div
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
        <div className="flex items-center">
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
