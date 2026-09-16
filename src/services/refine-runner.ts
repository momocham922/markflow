import { auth } from "@/services/firebase";
import { reportIfQuota } from "@/services/ai-proxy";
import { track } from "@/services/telemetry";
import {
  RefineHttpError,
  ackRefineJob,
  fetchRefineJob,
  refineErrorMessage,
  refineThrownMessage,
  streamRefineJob,
  type CreateRefineJobBody,
  type RefineJobView,
  type RefineStreamEvent,
} from "@/services/refine-jobs";
import { useRefineStore, type RefinePhase } from "@/stores/refine-store";

// =====================================================================
// Refine job orchestration (device side)
// ---------------------------------------------------------------------
// Deliberately NOT tied to a React component: closing the voice panel or
// switching documents must not cancel anything. A live progress stream is kept
// when possible; otherwise the Editor's useRefineJobSync polls the job. Applying
// a finished result to the document happens in exactly one place
// (useRefineJobSync), whichever path delivered it.
// =====================================================================

/** Server-side automatic resumes of an interrupted (stale) run per job. */
const MAX_AUTO_RESUMES = 2;

async function idToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error("Not authenticated");
  return user.getIdToken();
}

function phaseFor(job: RefineJobView): RefinePhase {
  if (job.status === "done") return "ready";
  if (job.status === "error") return "error";
  return job.stage === "structure" ? "structure" : "transcribe";
}

function msSince(docId: string): number {
  const s = useRefineStore.getState().byDoc[docId];
  return s ? Date.now() - s.startedAt : 0;
}

function recordError(
  docId: string,
  job: RefineJobView | null,
  status: number,
  body: Record<string, unknown>,
) {
  const store = useRefineStore.getState();
  const prev = store.byDoc[docId];
  const current = job ?? prev?.job ?? null;
  const stage = current?.error?.stage ?? current?.stage ?? "transcribe";
  const code = String(body.error ?? current?.error?.code ?? "internal");
  reportIfQuota(status, JSON.stringify(body));
  store.patch(docId, {
    job: current,
    jobId: current?.jobId ?? prev?.jobId ?? null,
    phase: "error",
    attached: false,
    message: refineErrorMessage(stage, code, status, body),
  });
  track("refine_failed", { stage, code, status, ms: msSince(docId) });
}

function onStreamEvent(docId: string, e: RefineStreamEvent) {
  const store = useRefineStore.getState();
  switch (e.type) {
    case "accepted":
      store.patch(docId, {
        jobId: e.job.jobId,
        job: e.job,
        phase: phaseFor(e.job),
      });
      return;
    case "stage":
      store.patch(docId, {
        phase: e.stage === "structure" ? "structure" : "transcribe",
      });
      track("refine_stage", { stage: e.stage, ms: msSince(docId) });
      return;
    case "done":
      store.patch(docId, { job: e.job, jobId: e.job.jobId, phase: "ready" });
      track("refine_completed", {
        via: "stream",
        ms: msSince(docId),
        output_chars: e.job.outputChars,
        transcript_chars: e.job.transcriptChars,
        speakers: e.job.speakerCount,
        stop_reason: e.job.stopReason,
      });
      return;
    case "error":
      recordError(docId, e.job, e.status, e.body);
      return;
    case "ping":
      return;
  }
}

/**
 * Start (create) or resume a job and follow its progress stream. Resolves when
 * the stream ends; if it ended without a result the state is left "detached"
 * (attached=false) for the poller.
 */
export async function runRefineStream(
  docId: string,
  body: CreateRefineJobBody | { jobId: string; resume: true },
): Promise<void> {
  const store = useRefineStore.getState();
  const resume = "resume" in body;
  store.patch(docId, {
    jobId: body.jobId,
    attached: true,
    message: null,
    ...(resume ? {} : { phase: "transcribe" as const }),
  });
  try {
    const token = await idToken();
    const outcome = await streamRefineJob(body, token, (e) =>
      onStreamEvent(docId, e),
    );
    if (outcome === "detached") {
      const s = useRefineStore.getState().byDoc[docId];
      track("refine_detached", {
        stage: s?.phase ?? "unknown",
        ms: msSince(docId),
      });
    }
  } catch (err) {
    if (err instanceof RefineHttpError) {
      const code = String(err.body.error ?? "");
      if (code === "job_running") {
        // Another request (e.g. another device) is driving it — just follow.
        const job = err.body.job as RefineJobView | undefined;
        if (job) store.patch(docId, { job, phase: phaseFor(job) });
      } else {
        recordError(
          docId,
          (err.body.job as RefineJobView) ?? null,
          err.status,
          err.body,
        );
      }
    } else {
      // The request may not have reached the server (offline) or broke before
      // the first byte. Let the poller find out: a job that never started reads
      // as not-found and is reported then.
      console.warn("[refine] stream request failed:", err);
      track("refine_detached", { stage: "request", ms: msSince(docId) });
    }
  } finally {
    const s = useRefineStore.getState().byDoc[docId];
    if (s?.attached)
      useRefineStore.getState().patch(docId, { attached: false });
  }
}

/**
 * One poll of a detached job: pick up its result, report a failure, or resume a
 * run whose server instance died (bounded).
 */
export async function pollRefineJob(docId: string): Promise<void> {
  const store = useRefineStore.getState();
  const state = store.byDoc[docId];
  if (!state?.jobId || state.attached) return;
  let job: RefineJobView | null;
  try {
    job = await fetchRefineJob(state.jobId, await idToken());
  } catch (err) {
    // Transient (offline, 5xx): keep the state and try again next tick.
    console.warn("[refine] poll failed:", err);
    return;
  }
  const latest = useRefineStore.getState().byDoc[docId];
  if (!latest || latest.jobId !== state.jobId || latest.attached) return;
  if (!job) {
    store.patch(docId, {
      phase: "error",
      message: refineErrorMessage("transcribe", "job_not_found", 404),
    });
    track("refine_failed", {
      stage: "request",
      code: "job_not_found",
      status: 404,
    });
    return;
  }
  if (job.status === "done") {
    store.patch(docId, { job, phase: "ready" });
    track("refine_completed", {
      via: "poll",
      ms: msSince(docId),
      output_chars: job.outputChars,
      transcript_chars: job.transcriptChars,
      speakers: job.speakerCount,
      stop_reason: job.stopReason,
    });
    return;
  }
  if (job.status === "error") {
    recordError(docId, job, job.error?.status ?? 500, {
      ...(job.error?.body ?? {}),
      error: job.error?.code ?? "internal",
    });
    return;
  }
  if (job.stale) {
    if (latest.resumeTries >= MAX_AUTO_RESUMES) {
      store.patch(docId, {
        job,
        phase: "error",
        message: refineErrorMessage(job.stage, "internal", 500),
      });
      track("refine_failed", { stage: job.stage, code: "stale", status: 0 });
      return;
    }
    store.patch(docId, { job, resumeTries: latest.resumeTries + 1 });
    track("refine_resumed", { reason: "stale", stage: job.stage });
    void runRefineStream(docId, { jobId: job.jobId, resume: true });
    return;
  }
  store.patch(docId, { job, phase: phaseFor(job) });
}

/** User-initiated retry of a failed job (reuses its saved transcript). */
export function retryRefineJob(docId: string): void {
  const state = useRefineStore.getState().byDoc[docId];
  if (!state?.jobId) return;
  track("refine_resumed", {
    reason: "retry",
    stage: state.job?.error?.stage ?? state.job?.stage ?? "unknown",
    has_transcript: (state.job?.transcriptChars ?? 0) > 0,
  });
  useRefineStore.getState().patch(docId, {
    phase: (state.job?.transcriptChars ?? 0) > 0 ? "structure" : "transcribe",
    message: null,
    resumeTries: 0,
  });
  void runRefineStream(docId, { jobId: state.jobId, resume: true });
}

/** Map a failure that happened on this device before the job started. */
export function recordLocalRefineFailure(
  docId: string,
  err: unknown,
  stage: "upload" | "transcribe",
): void {
  useRefineStore.getState().patch(docId, {
    phase: "error",
    attached: false,
    message: refineThrownMessage(err, stage),
  });
  track("refine_failed", {
    stage,
    code:
      err instanceof RefineHttpError ? String(err.body.error ?? "") : "local",
    status: err instanceof RefineHttpError ? err.status : 0,
  });
}

/**
 * A new Refine replaces a result still awaiting review, or a failure the user
 * never dismissed: record that on the server so the old job is not offered
 * again for this document.
 */
export function supersedeRefineJob(
  prev: { jobId: string | null; phase: string } | undefined,
): void {
  if (!prev?.jobId) return;
  const action =
    prev.phase === "review"
      ? "discarded"
      : prev.phase === "error"
        ? "dismissed"
        : null;
  if (!action) return;
  const jobId = prev.jobId;
  void (async () => {
    try {
      await ackRefineJob(jobId, action, await idToken());
    } catch (err) {
      console.warn(`[refine] superseding ${jobId} failed:`, err);
    }
  })();
}
