import { useRef, useEffect } from "react";
import { useResearchStore } from "@/stores/research-store";
import {
  analyzeTranscript,
  groundedSearch,
  searchUserDocuments,
} from "@/services/research";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { saveResearchSession } from "@/services/firebase";
import { isMobile } from "@/platform";
import type { ResearchCard, ResearchSource } from "@/stores/research-store";

const INTERVAL_MS = 45_000;
const MIN_DIFF_CHARS = 200;
const CRED_ORDER: ResearchCard["credibility"][] = [
  "academic",
  "official",
  "news",
  "general",
];

interface UseResearchPipelineOptions {
  isRecording: boolean;
  fullTranscript: string;
  documentContent: string;
  activeDocId: string | null;
}

export function useResearchPipeline({
  isRecording,
  fullTranscript,
  documentContent,
  activeDocId,
}: UseResearchPipelineOptions) {
  const lastAnalyzedLengthRef = useRef<number>(0);
  const pendingRef = useRef<boolean>(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fullTranscriptRef = useRef(fullTranscript);
  fullTranscriptRef.current = fullTranscript;
  const documentContentRef = useRef(documentContent);
  documentContentRef.current = documentContent;
  const activeDocIdRef = useRef(activeDocId);
  activeDocIdRef.current = activeDocId;

  const { startSession, endSession, addCard, updateCard, addSearchedTopic } =
    useResearchStore();
  const documents = useAppStore((s) => s.documents);
  const documentsRef = useRef(documents);
  documentsRef.current = documents;

  const sessionStartRef = useRef<number>(0);
  const sessionIdRef = useRef<string>("");

  useEffect(() => {
    if (isMobile) return;
    if (isRecording) {
      startSession();
      lastAnalyzedLengthRef.current = 0;
      sessionStartRef.current = Date.now();
      sessionIdRef.current = crypto.randomUUID();

      const runAnalysis = async () => {
        if (pendingRef.current) return;
        const transcript = fullTranscriptRef.current;
        if (!transcript || transcript.length < 50) return;

        const diff = transcript.slice(lastAnalyzedLengthRef.current);
        if (diff.length < MIN_DIFF_CHARS) return;

        pendingRef.current = true;
        try {
          const searchedTopics = useResearchStore.getState().searchedTopics;

          const { searches } = await analyzeTranscript({
            transcriptDiff: diff.slice(0, 3000),
            fullContext: transcript.slice(-4000),
            documentContext: documentContentRef.current.slice(0, 2000),
            searchedTopics,
          });

          lastAnalyzedLengthRef.current = transcript.length;

          if (!searches || searches.length === 0) return;

          const searchPromises = searches.map(async (search) => {
            const cardId = crypto.randomUUID();
            const placeholderCard: ResearchCard = {
              id: cardId,
              timestamp: Date.now(),
              trigger: search.researchAngle,
              query: search.query,
              type: search.type,
              summary: "",
              sources: [],
              credibility: "general",
              integrated: false,
              expandable: true,
              loading: true,
            };
            addCard(placeholderCard);
            addSearchedTopic(search.query);

            try {
              const result = await groundedSearch(
                search.query,
                search.type,
                search.researchAngle,
                search.desiredOutput,
                search.claim,
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
          });

          await Promise.all(searchPromises);

          const docs = documentsRef.current;
          const docId = activeDocIdRef.current;
          if (docs.length > 0) {
            for (const search of searches) {
              const internalResults = searchUserDocuments(
                docs,
                search.query,
                docId || undefined,
              );
              if (internalResults.length > 0) {
                addCard({
                  id: crypto.randomUUID(),
                  timestamp: Date.now(),
                  trigger: search.researchAngle,
                  query: search.query,
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
          }
        } catch (err) {
          console.error("[research] Pipeline error:", err);
        } finally {
          pendingRef.current = false;
        }
      };

      intervalRef.current = setInterval(runAnalysis, INTERVAL_MS);

      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      };
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
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
  }, [
    isRecording,
    startSession,
    endSession,
    activeDocId,
    addCard,
    updateCard,
    addSearchedTopic,
  ]);
}
