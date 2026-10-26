// =====================================================================
// Structure job — client runner for the in-recording structuring pass
// ---------------------------------------------------------------------
// The live "Structure" pass used to be one long client-held `/v1/chat` stream.
// On flaky networks (measured: ~7% on Windows) that stream was cut mid-flight
// and the structuring was lost. It now runs as a server job: the client hands
// over the SAME pre-built prompt, the server runs and persists it, and if the
// stream breaks we poll the saved result instead of failing.
//
// This deliberately does NOT touch the refine-store / RefineStatusBanner state
// machine (that drives the one-shot final Refine with its review/apply UI).
// Structure stays a quiet, frequent, auto-applied pass; the caller (VoicePanel)
// keeps its own progress flag and applies the returned markdown exactly as it
// did with the inline stream.
// =====================================================================

import {
  streamRefineJob,
  fetchRefineJob,
  newRefineJobId,
  RefineHttpError,
  type CreateRefineJobBody,
  type RefineJobView,
} from "@/services/refine-jobs";

export interface StructureJobResult {
  output: string;
  stopReason: string;
}

const POLL_INTERVAL_MS = 3000;
// Structure runs are p50 ~72s / p90 ~3min; cap the poll generously above that so
// a slow run still lands, but a truly stuck job does not poll forever.
const POLL_MAX_MS = 7 * 60 * 1000;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * Run one structuring pass as a server job and return its result. Streams while
 * the client is listening; if the stream ends before the terminal event (the
 * cut-network case) the server keeps going, so we poll the persisted job until
 * it is done. Throws RefineHttpError for a real server failure (quota, etc.).
 */
export async function runStructureJob(opts: {
  docId: string;
  baseContentHash: string;
  system: string;
  user: string;
  token: string;
  signal?: AbortSignal;
}): Promise<StructureJobResult> {
  const { docId, baseContentHash, system, user, token, signal } = opts;
  const jobId = newRefineJobId();
  const body: CreateRefineJobBody = {
    jobId,
    docId,
    language: "ja-JP",
    chunks: [],
    baseContentHash,
    existingDoc: "",
    vocabulary: [],
    researchCards: [],
    questionCards: [],
    includedCardIds: [],
    contextRecords: [],
    structurePrompt: { system, user },
  };

  // A holder, not a plain `let`: a value assigned only inside the callback is
  // otherwise narrowed to `null` by the control-flow analysis after the await.
  const got: { done: RefineJobView | null; err: RefineHttpError | null } = {
    done: null,
    err: null,
  };
  const outcome = await streamRefineJob(
    body,
    token,
    (e) => {
      if (e.type === "done") got.done = e.job;
      else if (e.type === "error")
        got.err = new RefineHttpError(e.status, e.body);
    },
    signal,
  );
  if (got.err) throw got.err;
  if (got.done && got.done.output != null) {
    return { output: got.done.output, stopReason: got.done.stopReason };
  }
  // Stream detached before a terminal event (or the done carried no text): the
  // server is unaffected and is persisting the result — poll for it.
  if (outcome === "detached" || got.done == null) {
    return pollStructureJob(jobId, token, signal);
  }
  return pollStructureJob(jobId, token, signal);
}

async function pollStructureJob(
  jobId: string,
  token: string,
  signal?: AbortSignal,
): Promise<StructureJobResult> {
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS, signal);
    let view: RefineJobView | null = null;
    try {
      view = await fetchRefineJob(jobId, token);
    } catch (e) {
      // A refused request (auth/validation) is terminal; a transient network
      // blip during polling is not — keep trying until the deadline.
      if (e instanceof RefineHttpError) throw e;
      continue;
    }
    if (!view) continue; // not visible yet
    if (view.status === "done") {
      return { output: view.output ?? "", stopReason: view.stopReason };
    }
    if (view.status === "error" && view.error) {
      throw new RefineHttpError(view.error.status, view.error.body ?? {});
    }
    // running: keep polling
  }
  throw new Error("structure job did not finish in time");
}
