import { useRef, useEffect } from "react";
import { useResearchStore } from "@/stores/research-store";
import {
  analyzeTranscript,
  groundedSearch,
  FeatureGatedError,
} from "@/services/research";
import { useAuthStore } from "@/stores/auth-store";
import { useEntitlementStore } from "@/stores/entitlement-store";
import {
  saveResearchSession,
  fetchResearchSessions,
} from "@/services/firebase";
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

  // Reset + hydrate research whenever the active document changes. Research is
  // a GLOBAL store (not per-doc), so without a hard reset here the previous
  // document's cards linger when you switch docs or start the next meeting.
  useEffect(() => {
    // Switching documents must never show the previous doc's research over the
    // new one — close the mobile sheet up-front (the desktop panel/floating
    // window react to the card reset below on their own).
    useResearchStore.getState().setMobileSheetOpen(false);
    if (!activeDocId) return;

    // Reset synchronously and up-front so the previous document's cards are
    // NEVER shown on — or saved to — the newly opened document, even if the
    // async hydrate below finds nothing, errors, or the user isn't signed in.
    // (This effect runs before the recording effect below, so when its
    // stop-branch reads the card list on a doc switch it sees an empty list
    // and won't persist the old doc's cards under the new doc's id.)
    const store = useResearchStore.getState();
    if (store.sessionActive) store.endSession();
    store.clearCards();

    const user = useAuthStore.getState().user;
    if (!user) return; // already cleared above

    let cancelled = false;
    fetchResearchSessions(activeDocId)
      .then((sessions) => {
        if (cancelled) return;
        // Flatten newest-session-first; sessions already come ordered desc.
        const cards: ResearchCard[] = sessions.flatMap((s) =>
          s.cards.map((c) => ({
            ...c,
            // Fields not persisted to Firestore — restore sane defaults.
            expandable: true,
            loading: false,
          })),
        );
        // Guard against a live session that may have started while fetching.
        if (useResearchStore.getState().sessionActive) return;
        if (cards.length > 0) useResearchStore.getState().hydrateCards(cards);
      })
      .catch((err) =>
        console.error("[research] Failed to hydrate sessions:", err),
      );
    return () => {
      cancelled = true;
    };
  }, [activeDocId]);

  useEffect(() => {
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

        // Mobile: automatic research is opt-in (battery/data). Manual "今すぐ
        // 解析" always runs; automatic ticks are skipped unless the user turned
        // it on. This MUST return before pendingRef/analyzing are set below —
        // those flags live outside the try/finally and would leak permanently
        // (killing all future analysis and pinning the spinner) if set first.
        if (
          !manual &&
          isMobile &&
          !useResearchStore.getState().mobileLiveResearch
        ) {
          // Skipping is a DEVICE opt-out (mobile auto off), not a plan gate.
          // Clear any stale "auto research is Pro" notice so the sheet blames the
          // device toggle (which it renders) instead of the plan.
          useResearchStore.getState().setFeatureGated(false);
          return;
        }

        // Capability gate (MONETIZATION.md §1.3): Free is manual-only for live
        // research — automatic (interval) runs are Pro+. Skip auto ticks for
        // Free up-front so we never fire a request the server will 403 every
        // 45s. Manual triggers fall through (they hit the aiCalls quota for all
        // plans). The server enforces this too; this just avoids the spam.
        // Surface the gate (featureGated) so the "リサーチ" indicator can explain
        // why no cards appear — a silent return left users staring at a UI that
        // never showed anything (サイレントフォールバック禁止).
        if (
          !manual &&
          useEntitlementStore.getState().effectivePlan === "free"
        ) {
          useResearchStore.getState().setFeatureGated(true);
          return;
        }

        pendingRef.current = true;
        useResearchStore.getState().setAnalyzing(true);
        useResearchStore.getState().setAnalysisError(null);
        // We passed every gate and are actually analyzing — clear any stale
        // "gated" notice (e.g. the owner switched view-as back to a paid plan
        // mid-recording, or the entitlement finished loading).
        useResearchStore.getState().setFeatureGated(false);
        try {
          const searchedTopics = useResearchStore.getState().searchedTopics;

          const { searches, questions } = await analyzeTranscript({
            transcriptDiff: diff.slice(0, 3000),
            fullContext: transcript.slice(-4000),
            documentContext: documentContentRef.current.slice(0, 2000),
            // Cap to the most recent topics — an unbounded list bloats the
            // prompt over long sessions and makes the director return nothing.
            searchedTopics: searchedTopics.slice(-40),
            // Lets the server apply the §1.3 auto-research capability gate.
            auto: !manual,
          });

          lastAnalyzedLengthRef.current = transcript.length;

          // Speaker-question cards need no web search — the director already
          // wrote them. Surface immediately as a finished "drawer" of 3–4
          // candidate questions the user can ask. Added before the searches
          // early-return so questions still appear when no search is warranted.
          if (questions && questions.items && questions.items.length > 0) {
            const topic = questions.topic?.trim() || "スピーカーへの質問";
            addCard({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              trigger: topic,
              query: topic,
              type: "question",
              summary: questions.items
                .map(
                  (q) => `- ${q.question}${q.intent ? ` — *${q.intent}*` : ""}`,
                )
                .join("\n"),
              sources: [],
              credibility: "general",
              integrated: false,
              expandable: true,
              loading: false,
            });
          }

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

          // Persist incrementally after each analysis round so research
          // survives even if the recording never stops cleanly (crash, close).
          const docId = activeDocIdRef.current;
          const currentCards = useResearchStore.getState().cards;
          if (docId && currentCards.length > 0) {
            const u = useAuthStore.getState().user;
            if (u) {
              saveResearchSession(docId, {
                id: sessionIdRef.current,
                cards: currentCards,
                startedAt: sessionStartRef.current,
                endedAt: null,
                ownerId: u.uid,
              }).catch((err) =>
                console.error("[research] Incremental save failed:", err),
              );
            }
          }
        } catch (err) {
          // A capability gate (Free + auto research, MONETIZATION §1.3). The
          // client-side gate above normally skips Free auto ticks before we get
          // here, so this fires when effectivePlan hasn't loaded yet (null) or a
          // tampered client reached the server. Don't log noise, but DO record
          // the gated state so the "リサーチ" indicator explains the absence of
          // cards instead of showing nothing (サイレントフォールバック禁止). A manual
          // run additionally gets a dismissible banner (manual is allowed for
          // every plan, so a manual gate means a stale/unknown plan — worth saying).
          // If the session was already stopped (endSession cleared the transient
          // notices), a late-arriving rejection must NOT resurrect a gated/error
          // chip while not recording. The finally still clears the spinner.
          const stillActive = useResearchStore.getState().sessionActive;
          if (err instanceof FeatureGatedError) {
            if (stillActive) {
              useResearchStore.getState().setFeatureGated(true);
              if (manual) {
                useResearchStore
                  .getState()
                  .setAnalysisError(
                    "自動リサーチはProプランの機能です。「今すぐ解析」（手動）はご利用いただけます。",
                  );
              }
            }
            return;
          }
          console.error("[research] Pipeline error:", err);
          // Surface a MANUAL "今すぐ解析" failure so the button press never fails
          // silently. Auto ticks stay quiet (the next interval retries), and
          // quota 429s already raise the global upsell banner via reportIfQuota.
          if (manual && stillActive) {
            const msg = err instanceof Error ? err.message : String(err);
            const isNetwork =
              /load failed|failed to fetch|network|aborted|the operation was aborted/i.test(
                msg,
              );
            useResearchStore
              .getState()
              .setAnalysisError(
                isNetwork
                  ? "リサーチ解析中に通信エラーが発生しました。もう一度お試しください。"
                  : `リサーチ解析に失敗しました: ${msg}`,
              );
          }
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
