import { useCallback, useEffect, useRef } from "react";
import { auth } from "@/services/firebase";
import { track } from "@/services/telemetry";
import {
  ackRefineJob,
  findPendingRefineJob,
  refineErrorMessage,
  sha256Hex,
  type AckAction,
  type RefineJobView,
} from "@/services/refine-jobs";
import { pollRefineJob } from "@/services/refine-runner";
import { useRefineStore } from "@/stores/refine-store";
import { useResearchStore } from "@/stores/research-store";

const POLL_INTERVAL_MS = 5000;

interface Options {
  docId: string | null;
  /** Only documents that carry voice data can have a Refine job. */
  hasVoiceData: boolean;
  content: string;
  setContent: (content: string) => void;
  setVoiceTranscript: (transcript: string) => void;
}

async function ack(jobId: string, action: AckAction): Promise<void> {
  try {
    const token = await auth.currentUser?.getIdToken();
    if (token) await ackRefineJob(jobId, action, token);
  } catch (err) {
    // Not fatal: an unacknowledged job is only offered again for this document.
    console.warn(`[refine] ack ${action} failed:`, err);
  }
}

/**
 * Keeps the open document in step with its server-side Refine job:
 * finds a job started elsewhere (another device, or before the app was closed),
 * polls it while no live stream is attached, resumes an interrupted run, and
 * applies the finished result — automatically when the document is unchanged
 * since the job started, otherwise only after the user confirms.
 */
export function useRefineJobSync({
  docId,
  hasVoiceData,
  content,
  setContent,
  setVoiceTranscript,
}: Options) {
  const state = useRefineStore((s) => (docId ? s.byDoc[docId] : undefined));
  const contentRef = useRef(content);
  contentRef.current = content;
  // The document open RIGHT NOW. An async step must re-check it: applying after
  // the user switched documents would write into the wrong editor.
  const activeDocRef = useRef(docId);
  activeDocRef.current = docId;
  const applyingRef = useRef<string | null>(null);
  const lookedUpRef = useRef<Set<string>>(new Set());

  // 1) Discover a pending job for this document (once per document per session).
  useEffect(() => {
    if (!docId || !hasVoiceData || lookedUpRef.current.has(docId)) return;
    if (useRefineStore.getState().byDoc[docId]) return;
    lookedUpRef.current.add(docId);
    let cancelled = false;
    (async () => {
      try {
        const token = await auth.currentUser?.getIdToken();
        if (!token || cancelled) return;
        const job = await findPendingRefineJob(docId, token);
        if (!job || cancelled || useRefineStore.getState().byDoc[docId]) return;
        useRefineStore.getState().patch(docId, {
          jobId: job.jobId,
          job,
          attached: false,
          startedAt: job.createdAt,
          phase:
            job.status === "done"
              ? "ready"
              : job.status === "error"
                ? "error"
                : job.stage === "structure"
                  ? "structure"
                  : "transcribe",
          message: job.error
            ? refineErrorMessage(
                job.error.stage,
                job.error.code,
                job.error.status,
                job.error.body ?? {},
              )
            : null,
        });
        track("refine_pending_found", {
          status: job.status,
          stage: job.stage,
          age_ms: Date.now() - job.createdAt,
        });
        if (job.status === "running") void pollRefineJob(docId);
      } catch (err) {
        lookedUpRef.current.delete(docId); // retry on the next open
        console.warn("[refine] pending lookup failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, hasVoiceData]);

  // 2) Poll while the server works and no live stream is attached. Also poll
  // the moment the app comes back to the foreground.
  const polling =
    !!docId &&
    !!state &&
    !state.attached &&
    (state.phase === "transcribe" || state.phase === "structure");
  useEffect(() => {
    if (!polling || !docId) return;
    void pollRefineJob(docId);
    const id = setInterval(() => void pollRefineJob(docId), POLL_INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) void pollRefineJob(docId);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [polling, docId]);

  const apply = useCallback(
    (job: RefineJobView, auto: boolean) => {
      if (!docId || typeof job.output !== "string" || !job.output.trim())
        return;
      setContent(job.output);
      if (job.transcript?.trim()) setVoiceTranscript(job.transcript.trim());
      if (job.includedCardIds.length > 0) {
        const research = useResearchStore.getState();
        const known = new Set(research.cards.map((c) => c.id));
        for (const id of job.includedCardIds)
          if (known.has(id)) research.markIntegrated(id);
      }
      void ack(job.jobId, "applied");
      track("refine_applied", {
        auto,
        ms_since_start: Date.now() - job.createdAt,
        output_chars: job.outputChars,
        stop_reason: job.stopReason,
      });
      const store = useRefineStore.getState();
      store.clear(docId);
      store.setNotice({
        docId,
        kind: job.stopReason === "max_tokens" ? "truncated" : "applied",
        at: Date.now(),
      });
    },
    [docId, setContent, setVoiceTranscript],
  );

  // 3) A result arrived: apply it if the document is exactly as it was when the
  // job started; otherwise ask (Refine replaces the whole document).
  useEffect(() => {
    if (!docId || state?.phase !== "ready" || !state.job) return;
    const job = state.job;
    if (applyingRef.current === job.jobId) return;
    applyingRef.current = job.jobId;
    (async () => {
      const current = await sha256Hex(contentRef.current);
      // Switched away meanwhile → leave it "ready"; it applies on return.
      if (activeDocRef.current !== docId) return;
      const latest = useRefineStore.getState().byDoc[docId];
      if (latest?.phase !== "ready" || latest.job?.jobId !== job.jobId) return;
      if (current === job.baseContentHash) {
        apply(job, true);
      } else if (
        typeof job.output === "string" &&
        current === (await sha256Hex(job.output))
      ) {
        // Already applied earlier (e.g. the "applied" ack never reached the
        // server) — record it instead of asking again.
        void ack(job.jobId, "applied");
        useRefineStore.getState().clear(docId);
      } else {
        useRefineStore.getState().patch(docId, { phase: "review" });
        track("refine_review_shown", {
          ms_since_start: Date.now() - job.createdAt,
        });
      }
    })().finally(() => {
      applyingRef.current = null;
    });
  }, [docId, state?.phase, state?.job, apply]);

  const confirmApply = useCallback(() => {
    if (!docId || !state?.job) return;
    apply(state.job, false);
  }, [docId, state?.job, apply]);

  const discard = useCallback(() => {
    if (!docId || !state?.job) return;
    void ack(state.job.jobId, "discarded");
    track("refine_discarded", {
      ms_since_start: Date.now() - state.job.createdAt,
    });
    useRefineStore.getState().clear(docId);
  }, [docId, state?.job]);

  const dismissError = useCallback(() => {
    if (!docId) return;
    if (state?.jobId) void ack(state.jobId, "dismissed");
    track("refine_error_dismissed", {
      code: state?.job?.error?.code ?? "local",
    });
    useRefineStore.getState().clear(docId);
  }, [docId, state?.jobId, state?.job]);

  return { state, confirmApply, discard, dismissError };
}
