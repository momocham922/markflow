import { useRef, useEffect } from "react";
import { useResearchStore } from "@/stores/research-store";
import {
  detectKeywordDiff,
  judgeTopic,
  groundedSearch,
  searchUserDocuments,
} from "@/services/research";
import { extractHints } from "@/lib/text-utils";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { saveResearchSession } from "@/services/firebase";
import { isMobile } from "@/platform";
import type { ResearchCard, ResearchSource } from "@/stores/research-store";

const COOLDOWN_MS = 20_000;
const CRED_ORDER: ResearchCard["credibility"][] = [
  "academic",
  "official",
  "news",
  "general",
];

interface UseResearchPipelineOptions {
  isRecording: boolean;
  fullTranscript: string;
  activeDocId: string | null;
}

export function useResearchPipeline({
  isRecording,
  fullTranscript,
  activeDocId,
}: UseResearchPipelineOptions) {
  const previousHintsRef = useRef<Set<string>>(new Set());
  const lastCheckRef = useRef<number>(0);
  const pendingRef = useRef<boolean>(false);

  const { startSession, endSession, addCard, updateCard, addSearchedTopic } =
    useResearchStore();
  const documents = useAppStore((s) => s.documents);

  const sessionStartRef = useRef<number>(0);
  const sessionIdRef = useRef<string>("");

  useEffect(() => {
    if (isMobile) return;
    if (isRecording) {
      startSession();
      previousHintsRef.current = new Set();
      lastCheckRef.current = 0;
      sessionStartRef.current = Date.now();
      sessionIdRef.current = crypto.randomUUID();
    } else {
      const cards = useResearchStore.getState().cards;
      if (cards.length > 0 && activeDocId) {
        const user = useAuthStore.getState().user;
        if (user) {
          saveResearchSession(activeDocId, {
            id: sessionIdRef.current,
            cards,
            startedAt: sessionStartRef.current,
            endedAt: Date.now(),
            ownerId: user.uid,
          }).catch((err) =>
            console.error("[research] Failed to save session:", err),
          );
        }
      }
      endSession();
    }
  }, [isRecording, startSession, endSession, activeDocId]);

  useEffect(() => {
    if (isMobile || !isRecording || pendingRef.current) return;
    if (!fullTranscript || fullTranscript.length < 50) return;

    const now = Date.now();
    if (now - lastCheckRef.current < COOLDOWN_MS) return;

    const { shouldFire, delta } = detectKeywordDiff(
      previousHintsRef.current,
      fullTranscript,
    );

    if (!shouldFire) return;

    lastCheckRef.current = now;
    pendingRef.current = true;

    const currentHints = new Set(extractHints(fullTranscript));
    previousHintsRef.current = currentHints;

    (async () => {
      try {
        const searchedTopics = useResearchStore.getState().searchedTopics;

        const judgment = await judgeTopic(
          fullTranscript.slice(-2000),
          delta,
          searchedTopics,
        );

        if (!judgment.shouldSearch) return;

        const cardId = crypto.randomUUID();
        const placeholderCard: ResearchCard = {
          id: cardId,
          timestamp: Date.now(),
          trigger: delta,
          query: judgment.query,
          type: judgment.type,
          summary: "",
          sources: [],
          credibility: "general",
          integrated: false,
          expandable: true,
          loading: true,
        };
        addCard(placeholderCard);
        addSearchedTopic(judgment.query);

        try {
          const result = await groundedSearch(
            judgment.query,
            fullTranscript.slice(-1000),
            judgment.type,
          );

          const sources: ResearchSource[] = result.sources.map((s) => ({
            ...s,
            credibility: s.credibility as ResearchSource["credibility"],
          }));

          const overallCred = sources.reduce<ResearchCard["credibility"]>(
            (best, s) => {
              const sIdx = CRED_ORDER.indexOf(s.credibility);
              const bIdx = CRED_ORDER.indexOf(best);
              return sIdx < bIdx ? s.credibility : best;
            },
            "general",
          );

          updateCard(cardId, {
            summary: result.summary,
            sources,
            credibility: overallCred,
            loading: false,
          });
        } catch (err) {
          updateCard(cardId, {
            loading: false,
            error: err instanceof Error ? err.message : "Search failed",
          });
        }

        if (documents.length > 0) {
          const internalResults = searchUserDocuments(
            documents,
            judgment.query,
            activeDocId || undefined,
          );
          if (internalResults.length > 0) {
            addCard({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              trigger: delta,
              query: judgment.query,
              type: "internal",
              summary: `${internalResults.length}件の関連ドキュメント: ${internalResults.map((r) => r.title).join(", ")}`,
              sources: internalResults.map((r) => ({
                url: `markflow://doc/${r.id}`,
                title: r.title,
                domain: "MarkFlow",
                snippet: r.snippet,
                credibility: "general" as const,
              })),
              credibility: "general",
              integrated: false,
              expandable: true,
            });
          }
        }
      } catch (err) {
        console.error("[research] Pipeline error:", err);
      } finally {
        pendingRef.current = false;
      }
    })();
  }, [
    fullTranscript,
    isRecording,
    activeDocId,
    documents,
    addCard,
    updateCard,
    addSearchedTopic,
  ]);
}
