import { aiProxyHeaders } from "@/services/ai-proxy";
import { FriendlyError, friendlyErrorMessage } from "@/lib/friendly-error";

// =====================================================================
// Server-side Refine jobs — client API
// ---------------------------------------------------------------------
// Refine used to be three client-driven calls (upload → batch-transcribe →
// chat). Now the device only uploads the recording and starts a job; the
// ai-proxy runs transcription + structuring itself and saves every result, so a
// backgrounded app / closed panel / dropped network no longer loses finished,
// already-billed work. The POST streams NDJSON progress while the device is
// listening; if the stream breaks we poll GET /v1/voice/refine-jobs/{id}.
// See server/ai-proxy/refine.ts for the server side.
// =====================================================================

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";

export type RefineJobStatus = "running" | "done" | "error";
export type RefineJobStage = "transcribe" | "structure" | "done";

export interface RefineJobError {
  stage: RefineJobStage;
  code: string;
  status: number;
  body?: Record<string, unknown>;
}

/** Mirrors the server's RefineJobView. */
export interface RefineJobView {
  jobId: string;
  docId: string;
  status: RefineJobStatus;
  stage: RefineJobStage;
  /** A running job whose server stopped heart-beating — can be resumed. */
  stale: boolean;
  createdAt: number;
  updatedAt: number;
  baseContentHash: string;
  includedCardIds: string[];
  speakerCount: number;
  transcriptChars: number;
  outputChars: number;
  stopReason: string;
  error: RefineJobError | null;
  ackAt: number | null;
  output?: string;
  transcript?: string;
}

export type RefineStreamEvent =
  | { type: "accepted"; job: RefineJobView }
  | { type: "stage"; stage: RefineJobStage }
  | { type: "ping" }
  | { type: "done"; job: RefineJobView }
  | {
      type: "error";
      status: number;
      body: Record<string, unknown>;
      job: RefineJobView | null;
    };

export interface RefineChunk {
  gcsUri: string;
  startSec: number;
  durationSec: number;
}

export interface CreateRefineJobBody {
  jobId: string;
  docId: string;
  language: string;
  chunks: RefineChunk[];
  baseContentHash: string;
  existingDoc: string;
  vocabulary: string[];
  researchCards: Array<{
    type: string;
    query: string;
    summary: string;
    sources: Array<{ title: string; url: string }>;
  }>;
  questionCards: Array<{ summary: string }>;
  includedCardIds: string[];
}

export type AckAction = "applied" | "discarded" | "dismissed";

/** A non-2xx answer to a Refine job request, with the server's JSON body. */
export class RefineHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(`refine job request failed: ${status} ${String(body.error ?? "")}`);
    this.name = "RefineHttpError";
  }
}

export function newRefineJobId(): string {
  return crypto.randomUUID();
}

/** SHA-256 hex of the document text (detects edits made while a job ran). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Split an NDJSON byte stream into events. Returns the events parsed so far and
 * the unfinished tail to prepend to the next chunk.
 */
export function parseNdjson(buffer: string): {
  events: RefineStreamEvent[];
  rest: string;
} {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const events: RefineStreamEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as RefineStreamEvent;
      if (e && typeof e === "object" && typeof e.type === "string")
        events.push(e);
    } catch {
      // ignore a malformed line; the job record stays authoritative
    }
  }
  return { events, rest };
}

/**
 * POST a job (create or resume) and feed its progress events to `onEvent`.
 * Resolves "completed" once a terminal event (done / error) arrived, or
 * "detached" when the stream ended or broke first — the job keeps running on the
 * server, so the caller should switch to polling. Throws RefineHttpError when
 * the server refused the request outright (validation, auth, job already
 * running, …).
 */
export async function streamRefineJob(
  body: CreateRefineJobBody | { jobId: string; resume: true },
  token: string,
  onEvent: (e: RefineStreamEvent) => void,
  signal?: AbortSignal,
): Promise<"completed" | "detached"> {
  let res: Response;
  try {
    res = await fetch(`${AI_PROXY_URL}/v1/voice/refine-jobs`, {
      method: "POST",
      headers: aiProxyHeaders(token),
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // The request may or may not have reached the server. A create that never
    // arrived simply has no job — the poller reports not-found and the caller
    // surfaces it; one that did arrive keeps running.
    if (signal?.aborted) return "detached";
    throw err;
  }
  if (!res.ok) throw new RefineHttpError(res.status, await readJson(res));
  const reader = res.body?.getReader();
  if (!reader) return "detached";
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseNdjson(buffer);
      buffer = parsed.rest;
      for (const e of parsed.events) {
        if (e.type === "done" || e.type === "error") terminal = true;
        onEvent(e);
      }
    }
    const tail = parseNdjson(`${buffer}${decoder.decode()}\n`);
    for (const e of tail.events) {
      if (e.type === "done" || e.type === "error") terminal = true;
      onEvent(e);
    }
  } catch {
    // Stream broke (backgrounded app, network change, unmount abort): the
    // server is unaffected — fall back to polling.
    return terminal ? "completed" : "detached";
  }
  return terminal ? "completed" : "detached";
}

/** Current state of a job (with its text once done); null if it doesn't exist. */
export async function fetchRefineJob(
  jobId: string,
  token: string,
): Promise<RefineJobView | null> {
  const res = await fetch(
    `${AI_PROXY_URL}/v1/voice/refine-jobs/${encodeURIComponent(jobId)}`,
    { headers: aiProxyHeaders(token) },
  );
  if (res.status === 404) return null;
  const body = await readJson(res);
  if (!res.ok) throw new RefineHttpError(res.status, body);
  return (body.job as RefineJobView | null) ?? null;
}

/** The newest job for this document the user hasn't dealt with yet. */
export async function findPendingRefineJob(
  docId: string,
  token: string,
): Promise<RefineJobView | null> {
  const res = await fetch(
    `${AI_PROXY_URL}/v1/voice/refine-jobs?docId=${encodeURIComponent(docId)}`,
    { headers: aiProxyHeaders(token) },
  );
  const body = await readJson(res);
  if (!res.ok) throw new RefineHttpError(res.status, body);
  return (body.job as RefineJobView | null) ?? null;
}

export async function ackRefineJob(
  jobId: string,
  action: AckAction,
  token: string,
): Promise<void> {
  const res = await fetch(
    `${AI_PROXY_URL}/v1/voice/refine-jobs/${encodeURIComponent(jobId)}/ack`,
    {
      method: "POST",
      headers: aiProxyHeaders(token),
      body: JSON.stringify({ action }),
    },
  );
  if (!res.ok) throw new RefineHttpError(res.status, await readJson(res));
}

const STAGE_LABEL: Record<RefineJobStage | "upload", string> = {
  upload: "音声アップロード",
  transcribe: "文字起こし",
  structure: "整形",
  done: "整形",
};

/**
 * User-facing message for a failed job / refused request. Never echoes raw
 * server text except the server's own Japanese `message` field (which the API
 * reserves for user-ready copy).
 */
export function refineErrorMessage(
  stage: RefineJobStage | "upload",
  code: string,
  status: number,
  body: Record<string, unknown> = {},
): string {
  const label = STAGE_LABEL[stage];
  const serverMessage =
    typeof body.message === "string" && body.message ? body.message : "";
  switch (code) {
    case "batch_in_progress":
    case "too_many_chunks":
      return `${label}: ${serverMessage || friendlyErrorMessage(code, "voice")}`;
    case "quota_exceeded":
      return `${label}: ${friendlyErrorMessage("429 quota_exceeded", "voice")}`;
    case "empty_transcript":
      return `${label}: 文字起こし結果が空でした。録音に音声が入っていない可能性があります。`;
    case "stt_failed":
      return `${label}: 文字起こしに失敗しました。もう一度お試しください。`;
    case "audio_too_long":
      return `${label}: 音声が長すぎると判定されました。もう一度 Refine をお試しください。解消しない場合は録音を短く区切ってください。`;
    case "job_exhausted":
      return "何度か再試行しましたが完了できませんでした。お手数ですが、もう一度 Refine を実行してください。";
    case "job_not_found":
      return "Refine の処理が見つかりませんでした。もう一度 Refine を実行してください。";
    case "job_running":
      return "このドキュメントの Refine はサーバーで処理中です。完了までお待ちください。";
    default:
      if (stage === "structure" || stage === "done") {
        return "整形に失敗しました。文字起こしは保存済みなので、再試行すると整形だけをやり直します。";
      }
      return `${label}: ${friendlyErrorMessage(`${status} ${code}`, "voice")}`;
  }
}

/** Message for an arbitrary thrown value from a Refine request. */
export function refineThrownMessage(
  err: unknown,
  stage: RefineJobStage | "upload",
): string {
  if (err instanceof FriendlyError) return err.message;
  if (err instanceof RefineHttpError) {
    return refineErrorMessage(
      stage,
      String(err.body.error ?? ""),
      err.status,
      err.body,
    );
  }
  return `${STAGE_LABEL[stage]}: ${friendlyErrorMessage(err, "voice")}`;
}
