import { useRef, useEffect } from "react";
import { useResearchStore } from "@/stores/research-store";
import { analyzeTranscript, groundedSearch } from "@/services/research";
import { useAuthStore } from "@/stores/auth-store";
import { saveResearchSession } from "@/services/firebase";
import { isMobile } from "@/platform";
import type { ResearchCard, ResearchSource } from "@/stores/research-store";

const FIRST_ANALYSIS_MS = 15_000;
const INTERVAL_MS = 45_000;
const MIN_DIFF_CHARS = 200;
const CRED_ORDER: ResearchCard["credibility"][] = [
  "academic",
  "official",
  "news",
  "general",
];

let _triggerFn: (() => void) | null = null;

export function triggerResearchAnalysis() {
  _triggerFn?.();
}

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
  const firstTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fullTranscriptRef = useRef(fullTranscript);
  fullTranscriptRef.current = fullTranscript;
  const documentContentRef = useRef(documentContent);
  documentContentRef.current = documentContent;
  const activeDocIdRef = useRef(activeDocId);
  activeDocIdRef.current = activeDocId;

  const { startSession, endSession, addCard, updateCard, addSearchedTopic } =
    useResearchStore();

  const sessionStartRef = useRef<number>(0);
  const sessionIdRef = useRef<string>("");

  useEffect(() => {
    if (isMobile) return;
    if (isRecording) {
      startSession();
      lastAnalyzedLengthRef.current = 0;
      sessionStartRef.current = Date.now();
      sessionIdRef.current = crypto.randomUUID();

      const runAnalysis = async (manual = false) => {
        if (pendingRef.current) return;
        const transcript = fullTranscriptRef.current;
        if (!transcript || transcript.length < 50) return;

        const diff = transcript.slice(lastAnalyzedLengthRef.current);
        if (!manual && diff.length < MIN_DIFF_CHARS) return;
        if (manual && diff.length < 30) return;

        pendingRef.current = true;
        useResearchStore.getState().setAnalyzing(true);
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
        } catch (err) {
          console.error("[research] Pipeline error:", err);
        } finally {
          pendingRef.current = false;
          useResearchStore.getState().setAnalyzing(false);
        }
      };

      _triggerFn = () => runAnalysis(true);

      firstTimeoutRef.current = setTimeout(() => {
        runAnalysis();
        intervalRef.current = setInterval(() => runAnalysis(), INTERVAL_MS);
      }, FIRST_ANALYSIS_MS);

      return () => {
        _triggerFn = null;
        if (firstTimeoutRef.current) {
          clearTimeout(firstTimeoutRef.current);
          firstTimeoutRef.current = null;
        }
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      };
    } else {
      if (firstTimeoutRef.current) {
        clearTimeout(firstTimeoutRef.current);
        firstTimeoutRef.current = null;
      }
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
