// =====================================================================
// Server-side Refine jobs — pure logic (no I/O).
// ---------------------------------------------------------------------
// Refine = re-transcribe the whole recording (BatchRecognize, diarized) and have
// Claude rewrite the document from it. It used to be orchestrated by the client
// (upload → /v1/voice/batch-transcribe → /v1/chat), so a backgrounded app, a
// closed voice panel or a dropped connection lost work the server had already
// finished and billed (2026-09 logs: 3 of 9 successful transcriptions never
// reached the structuring step). A Refine job now runs both stages inside ONE
// server request and persists every intermediate result in Firestore
// (refine_jobs/{jobId}), so the client can disconnect and pick the result up
// later — from any device — and a retry reuses the saved transcript instead of
// paying for speech-to-text again.
//
// This module holds everything that can be unit-tested without Firestore or
// Vertex: request validation, the prompt (moved verbatim from the client's
// VoicePanel.doRefine), job-state decisions, Firestore part splitting and the
// Anthropic SSE accumulator. index.ts does the wiring.
// =====================================================================

import { createHash } from "node:crypto";
import { currentDateBlock } from "./datetime";

export const REFINE_JOBS = "refine_jobs";
export const REFINE_JOB_PARTS = "refine_job_parts";

/** A running job whose heartbeat is older than this is treated as interrupted. */
export const REFINE_HEARTBEAT_MS = 30_000;
export const REFINE_STALE_MS = 3 * 60_000;
/** Give up after this many runs of the same job (each resume counts). */
export const REFINE_MAX_ATTEMPTS = 4;
/** Jobs (and their parts) are deleted by a Firestore TTL policy after this. */
export const REFINE_RETENTION_MS = 14 * 24 * 60 * 60_000;
/** Pending (unacknowledged) jobs older than this are not offered for resume. */
export const REFINE_RESUME_WINDOW_MS = 7 * 24 * 60 * 60_000;

// Firestore caps a document at 1 MiB; keep each text part well under it.
export const REFINE_PART_MAX_BYTES = 700_000;

// Input caps (the 10 MB request-body cap is the coarse backstop).
export const MAX_EXISTING_DOC_CHARS = 1_000_000;
export const MAX_VOCABULARY = 100;
export const MAX_VOCAB_TERM_CHARS = 100;
export const MAX_RESEARCH_CARDS = 200;
export const MAX_QUESTION_CARDS = 200;
export const MAX_CARD_TEXT_CHARS = 20_000;
export const MAX_CARD_SOURCES = 20;
export const MAX_INCLUDED_CARD_IDS = 400;

export const REFINE_MAX_TOKENS = 128_000;
/**
 * Reasoning effort for the refinement call. Rules 8 and 9 ask the model to unify
 * speaker labels across segments and to re-read the whole transcript against its
 * draft before emitting — neither is doable while already streaming the answer.
 *
 * opus-5 takes `thinking: { type: "adaptive" }` plus `output_config.effort`; the
 * older `thinking: { type: "enabled", budget_tokens }` form is REJECTED with 400
 * ("not supported for this model"), which would fail every refinement — verified
 * live against the deployed model before shipping, so do not "restore" it.
 *
 * Billing is unaffected: metering counts one `aiCalls` unit per call regardless
 * of tokens, and the commit gate (`sseProducedOutput`) only fires on
 * `text_delta`/`input_json_delta`, never on `thinking_delta` — so a call that
 * thinks and then fails is still refunded.
 */
export const REFINE_EFFORT = "high";

export type RefineStage = "transcribe" | "structure" | "done";
export type RefineStatus = "running" | "done" | "error";

export interface RefineChunk {
  gcsUri: string;
  startSec: number;
  durationSec: number;
}

export interface RefineResearchCard {
  type: string;
  query: string;
  summary: string;
  sources: Array<{ title: string; url: string }>;
}

/** Everything the structuring prompt needs besides the transcript. */
export interface RefinePromptInput {
  existingDoc: string;
  vocabulary: string[];
  researchCards: RefineResearchCard[];
  questionSummaries: string[];
}

export interface RefineCreateRequest {
  jobId: string;
  docId: string;
  language: string;
  chunks: RefineChunk[];
  baseContentHash: string;
  includedCardIds: string[];
  input: RefinePromptInput;
}

export type ParsedRefineRequest =
  | { kind: "create"; req: RefineCreateRequest }
  | { kind: "resume"; jobId: string }
  | { kind: "invalid"; status: number; error: string; message?: string };

export interface RefineJobError {
  stage: RefineStage;
  code: string;
  /** HTTP status the equivalent synchronous call would have returned. */
  status: number;
  /** Machine-readable body (e.g. the quota_exceeded payload) for the client. */
  body?: Record<string, unknown>;
}

/** The Firestore record at refine_jobs/{jobId} (text lives in parts). */
export interface RefineJobRecord {
  uid: string;
  docId: string;
  status: RefineStatus;
  stage: RefineStage;
  createdAt: number;
  updatedAt: number;
  heartbeatAt: number;
  runnerId: string;
  attempts: number;
  language: string;
  chunks: RefineChunk[];
  audioKey: string;
  baseContentHash: string;
  includedCardIds: string[];
  inputParts: number;
  transcriptParts: number;
  transcriptChars: number;
  speakerCount: number;
  transcribedAt: number | null;
  outputParts: number;
  outputChars: number;
  stopReason: string;
  structuredAt: number | null;
  error: RefineJobError | null;
  ackAt: number | null;
  ackAction: string | null;
}

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DOC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

export function isValidJobId(v: unknown): v is string {
  return typeof v === "string" && ID_RE.test(v);
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/**
 * Validate a POST /v1/voice/refine-jobs body. `audioPrefix` is the caller's own
 * Storage folder — chunks outside it are refused (403) exactly like
 * /v1/voice/batch-transcribe, and `maxChunks` mirrors its fan-out cap.
 */
export function parseRefineRequest(
  body: unknown,
  audioPrefix: string,
  maxChunks: number,
): ParsedRefineRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;
  if (!isValidJobId(b.jobId))
    return { kind: "invalid", status: 400, error: "invalid_job_id" };
  const jobId = b.jobId;
  if (b.resume === true) return { kind: "resume", jobId };

  if (typeof b.docId !== "string" || !DOC_ID_RE.test(b.docId))
    return { kind: "invalid", status: 400, error: "invalid_doc_id" };

  const rawChunks = Array.isArray(b.chunks) ? b.chunks : [];
  if (rawChunks.length === 0)
    return { kind: "invalid", status: 400, error: "chunks_required" };
  if (rawChunks.length > maxChunks)
    return {
      kind: "invalid",
      status: 400,
      error: "too_many_chunks",
      message: "録音が長すぎます。もう少し短い録音に分けてお試しください。",
    };
  const chunks: RefineChunk[] = rawChunks.map((c) => {
    const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    return {
      gcsUri: String(o.gcsUri || ""),
      startSec: Number(o.startSec) || 0,
      durationSec: Number(o.durationSec) || 0,
    };
  });
  if (chunks.some((c) => !c.gcsUri))
    return { kind: "invalid", status: 400, error: "chunks_required" };
  if (chunks.some((c) => !c.gcsUri.startsWith(audioPrefix)))
    return { kind: "invalid", status: 403, error: "invalid_audio_path" };

  const baseContentHash =
    typeof b.baseContentHash === "string" && HASH_RE.test(b.baseContentHash)
      ? b.baseContentHash
      : "";
  if (!baseContentHash)
    return { kind: "invalid", status: 400, error: "invalid_base_hash" };

  const existingDoc = typeof b.existingDoc === "string" ? b.existingDoc : "";
  if (existingDoc.length > MAX_EXISTING_DOC_CHARS)
    return { kind: "invalid", status: 413, error: "document_too_large" };

  const vocabulary: string[] = [];
  for (const t of Array.isArray(b.vocabulary) ? b.vocabulary : []) {
    const term = str(t, MAX_VOCAB_TERM_CHARS).trim();
    if (term && !vocabulary.includes(term)) vocabulary.push(term);
    if (vocabulary.length >= MAX_VOCABULARY) break;
  }

  const researchCards: RefineResearchCard[] = (
    Array.isArray(b.researchCards) ? b.researchCards : []
  )
    .slice(0, MAX_RESEARCH_CARDS)
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => ({
      type: str(c.type, 40),
      query: str(c.query, MAX_CARD_TEXT_CHARS),
      summary: str(c.summary, MAX_CARD_TEXT_CHARS),
      sources: (Array.isArray(c.sources) ? c.sources : [])
        .slice(0, MAX_CARD_SOURCES)
        .filter(
          (s): s is Record<string, unknown> => !!s && typeof s === "object",
        )
        .map((s) => ({ title: str(s.title, 500), url: str(s.url, 2000) })),
    }))
    .filter((c) => c.summary);

  const questionSummaries: string[] = (
    Array.isArray(b.questionCards) ? b.questionCards : []
  )
    .slice(0, MAX_QUESTION_CARDS)
    .map((c) =>
      c && typeof c === "object"
        ? str((c as Record<string, unknown>).summary, MAX_CARD_TEXT_CHARS)
        : "",
    )
    .filter(Boolean);

  const includedCardIds = (
    Array.isArray(b.includedCardIds) ? b.includedCardIds : []
  )
    .map((v) => str(v, 128))
    .filter(Boolean)
    .slice(0, MAX_INCLUDED_CARD_IDS);

  return {
    kind: "create",
    req: {
      jobId,
      docId: b.docId,
      language: str(b.language, 20) || "ja-JP",
      chunks,
      baseContentHash,
      includedCardIds,
      input: { existingDoc, vocabulary, researchCards, questionSummaries },
    },
  };
}

/** Identity of the audio a job transcribes (a resume must not switch audio). */
/** True for BatchRecognize's "file is too long" rejection (≈20-min limit). */
export function isAudioTooLongMessage(message: string): boolean {
  return /too long|20 ?minutes|20\s*分|60 ?minutes|60\s*分/i.test(message);
}

export function audioKeyFor(chunks: RefineChunk[]): string {
  return createHash("sha256")
    .update(
      chunks
        .map((c) => `${c.gcsUri}|${c.startSec}|${c.durationSec}`)
        .join("\n"),
    )
    .digest("hex");
}

// ---------------------------------------------------------------------
// Job state decisions
// ---------------------------------------------------------------------

export function isStale(
  job: Pick<RefineJobRecord, "status" | "heartbeatAt">,
  now: number,
): boolean {
  return (
    job.status === "running" && now - (job.heartbeatAt || 0) > REFINE_STALE_MS
  );
}

export type JobAction =
  | { kind: "create" }
  | { kind: "not_found" }
  | { kind: "return_done" }
  | { kind: "busy" }
  | { kind: "exhausted" }
  | { kind: "run"; from: "transcribe" | "structure" };

/**
 * What a POST should do with the job it names. A job belongs to exactly one uid:
 * someone else's id reads as not found (never reveal it exists). A finished job
 * is returned as-is (no second charge); a live one is left alone (the caller
 * polls); an errored or interrupted one is re-run from the first stage whose
 * result is missing — so speech-to-text is never paid for twice.
 */
export function decideJobAction(
  job: RefineJobRecord | null,
  uid: string,
  isCreate: boolean,
  now: number,
): JobAction {
  if (!job) return isCreate ? { kind: "create" } : { kind: "not_found" };
  if (job.uid !== uid) return { kind: "not_found" };
  if (job.status === "done") return { kind: "return_done" };
  if (job.status === "running" && !isStale(job, now)) return { kind: "busy" };
  if (job.attempts >= REFINE_MAX_ATTEMPTS) return { kind: "exhausted" };
  // Quota / input errors are not fixed by retrying the transcription itself,
  // but a saved transcript still lets a later retry skip straight to Claude.
  return {
    kind: "run",
    from: job.transcriptParts > 0 ? "structure" : "transcribe",
  };
}

export function newJobRecord(
  uid: string,
  req: RefineCreateRequest,
  runnerId: string,
  inputParts: number,
  now: number,
): RefineJobRecord {
  return {
    uid,
    docId: req.docId,
    status: "running",
    stage: "transcribe",
    createdAt: now,
    updatedAt: now,
    heartbeatAt: now,
    runnerId,
    attempts: 1,
    language: req.language,
    chunks: req.chunks,
    audioKey: audioKeyFor(req.chunks),
    baseContentHash: req.baseContentHash,
    includedCardIds: req.includedCardIds,
    inputParts,
    transcriptParts: 0,
    transcriptChars: 0,
    speakerCount: 0,
    transcribedAt: null,
    outputParts: 0,
    outputChars: 0,
    stopReason: "",
    structuredAt: null,
    error: null,
    ackAt: null,
    ackAction: null,
  };
}

/** Coerce a raw Firestore map into a record (tolerant of missing fields). */
export function toJobRecord(data: Record<string, unknown>): RefineJobRecord {
  const num = (v: unknown, d = 0) =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  const numOrNull = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const status = s(data.status);
  const stage = s(data.stage);
  const err = data.error as Record<string, unknown> | null | undefined;
  return {
    uid: s(data.uid),
    docId: s(data.docId),
    status: (["running", "done", "error"].includes(status)
      ? status
      : "error") as RefineStatus,
    stage: (["transcribe", "structure", "done"].includes(stage)
      ? stage
      : "transcribe") as RefineStage,
    createdAt: num(data.createdAt),
    updatedAt: num(data.updatedAt),
    heartbeatAt: num(data.heartbeatAt),
    runnerId: s(data.runnerId),
    attempts: num(data.attempts),
    language: s(data.language) || "ja-JP",
    chunks: (Array.isArray(data.chunks) ? data.chunks : []).map((c) => {
      const o = (c || {}) as Record<string, unknown>;
      return {
        gcsUri: s(o.gcsUri),
        startSec: num(o.startSec),
        durationSec: num(o.durationSec),
      };
    }),
    audioKey: s(data.audioKey),
    baseContentHash: s(data.baseContentHash),
    includedCardIds: (Array.isArray(data.includedCardIds)
      ? data.includedCardIds
      : []
    ).map(String),
    inputParts: num(data.inputParts),
    transcriptParts: num(data.transcriptParts),
    transcriptChars: num(data.transcriptChars),
    speakerCount: num(data.speakerCount),
    transcribedAt: numOrNull(data.transcribedAt),
    outputParts: num(data.outputParts),
    outputChars: num(data.outputChars),
    stopReason: s(data.stopReason),
    structuredAt: numOrNull(data.structuredAt),
    error:
      err && typeof err === "object"
        ? {
            stage: (s(err.stage) || "transcribe") as RefineStage,
            code: s(err.code) || "internal",
            status: num(err.status, 500),
            body:
              err.body && typeof err.body === "object"
                ? (err.body as Record<string, unknown>)
                : undefined,
          }
        : null,
    ackAt: numOrNull(data.ackAt),
    ackAction: s(data.ackAction) || null,
  };
}

/** What the client sees. Text is attached only when requested and present. */
export interface RefineJobView {
  jobId: string;
  docId: string;
  status: RefineStatus;
  stage: RefineStage;
  /** A running job that stopped heart-beating (instance died) — resumable. */
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

export function toJobView(
  jobId: string,
  job: RefineJobRecord,
  now: number,
  text: { output?: string; transcript?: string } = {},
): RefineJobView {
  const view: RefineJobView = {
    jobId,
    docId: job.docId,
    status: job.status,
    stage: job.stage,
    stale: isStale(job, now),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    baseContentHash: job.baseContentHash,
    includedCardIds: job.includedCardIds,
    speakerCount: job.speakerCount,
    transcriptChars: job.transcriptChars,
    outputChars: job.outputChars,
    stopReason: job.stopReason,
    error: job.error,
    ackAt: job.ackAt,
  };
  if (text.output !== undefined) view.output = text.output;
  if (text.transcript !== undefined) view.transcript = text.transcript;
  return view;
}

/**
 * The job to offer when a document is opened: the newest one for this doc that
 * the user hasn't dealt with yet (applied / discarded / dismissed), within the
 * resume window. Errors are offered too so the user learns the run failed.
 */
export function pickPendingJob(
  jobs: Array<{ id: string; job: RefineJobRecord }>,
  uid: string,
  docId: string,
  now: number,
): { id: string; job: RefineJobRecord } | null {
  const candidates = jobs
    .filter(
      (j) =>
        j.job.uid === uid &&
        j.job.docId === docId &&
        j.job.ackAt === null &&
        now - j.job.createdAt <= REFINE_RESUME_WINDOW_MS,
    )
    .sort((a, b) => b.job.createdAt - a.job.createdAt);
  return candidates[0] || null;
}

export const ACK_ACTIONS = ["applied", "discarded", "dismissed"] as const;
export type AckAction = (typeof ACK_ACTIONS)[number];
export function isAckAction(v: unknown): v is AckAction {
  return (
    typeof v === "string" && (ACK_ACTIONS as readonly string[]).includes(v)
  );
}

// ---------------------------------------------------------------------
// Firestore text parts
// ---------------------------------------------------------------------

/**
 * Split text into pieces of at most `maxBytes` UTF-8 bytes without cutting a
 * code point. Always returns at least one piece ("" → [""]).
 */
export function splitUtf8(
  text: string,
  maxBytes = REFINE_PART_MAX_BYTES,
): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > maxBytes) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += b;
  }
  parts.push(current);
  return parts;
}

export function partId(
  jobId: string,
  name: "input" | "transcript" | "output",
  i: number,
): string {
  return `${jobId}_${name}_${i}`;
}

// ---------------------------------------------------------------------
// Prompt (moved verbatim from the client's VoicePanel.doRefine)
// ---------------------------------------------------------------------

/**
 * Build the "Questions Context" block. Speaker-questions are prompts the user may
 * ASK — NOT facts and NOT meeting speech — so they go into their own trailing
 * '## 確認したいこと' section, separate from '## 補足情報（Web調査）'.
 */
export function buildQuestionsContext(questionSummaries: string[]): string {
  return (
    "\n\n## Questions Context (follow-up questions to ASK — NOT meeting content)\n" +
    "These are candidate questions the user may want to ASK the other participants. " +
    "They are NOT facts and NOT anything anyone said. Follow the SEPARATION RULE: " +
    "collect them under a SINGLE trailing section titled '## 確認したいこと' " +
    "(translate the title to match the document's language), placed AFTER any " +
    "'## 補足情報（Web調査）' section and clearly separate from it. Render as a " +
    "bulleted checklist of the questions themselves; you MAY drop any ' — *intent*' " +
    "annotation and merge duplicate/near-identical questions. Do NOT weave them " +
    "into the minutes body. Omit the section entirely if none are meaningful.\n\n" +
    questionSummaries.join("\n")
  );
}

export function buildRefinePrompt(
  transcript: string,
  speakerCount: number,
  input: RefinePromptInput,
): { system: string; user: string } {
  const existingDoc = input.existingDoc.trim();
  // Speaker labels are assigned independently inside each "---" segment, so the
  // number of distinct labels is an UPPER BOUND on how many people are present,
  // never the count. Handing the model "There are 4 speakers" flatly contradicts
  // the unify-across-segments instruction, and the model believes the number:
  // measured 2026-09-18 (job 1433fdd5), a 3-person meeting was transcribed as 4
  // labels across 2 segments and the refined document never named a participant.
  const segments = transcript.split("\n---\n").length;
  const docVocabulary = existingDoc ? input.vocabulary : [];
  const vocabularyHint =
    docVocabulary.length > 0
      ? `The following terms appear in the existing document and may have been misrecognized — use them as the correct spelling: [${docVocabulary.slice(0, 100).join(", ")}]. `
      : "";

  const system =
    // The model has no clock: without today's date it reads "来年" / "翌月" /
    // "次月" against its training year and can stamp the wrong year on a
    // schedule. See datetime.ts.
    `${currentDateBlock()}\n\n` +
    "You are a document assistant performing a FINAL REFINEMENT. " +
    "You will receive a BATCH-DIARIZED TRANSCRIPT processed from the complete recording session. It may contain '---' markers separating processing segments of a long recording; speaker labels are ONLY consistent WITHIN a segment (the same speaker may have a different number across '---') — use speech content to identify and unify the same speaker across segments, " +
    (existingDoc
      ? "and an EXISTING DOCUMENT (a preliminary structure created during recording). "
      : "") +
    "The transcript is from speech-to-text and may contain misrecognitions. Correct obvious errors based on context. " +
    vocabularyHint +
    (segments > 1
      ? `This transcript is made of ${segments} processing segments and ${speakerCount} distinct speaker labels appear across them. Because labels are assigned independently PER SEGMENT, ${speakerCount} is an UPPER BOUND on the number of people — it is NOT the participant count, and the same person almost always carries different numbers in different segments. Work out how many people are actually present by unifying labels: match on role and responsibility, who gives instructions and who accepts them, who is addressed by name, and which side each person speaks for (a person who consistently says 御社 to the others is on the opposite side from the person they say it to). NEVER state or imply a participant count taken from the label count. `
      : `There are ${speakerCount} speaker(s) in this recording. `) +
    "CRITICAL RULES: " +
    "1) You are NOT creating a cleaned-up transcript or conversation log. Produce a POLISHED INFORMATIONAL DOCUMENT that a reader can use without having heard the conversation. " +
    "2) Use the speaker labels INTERNALLY to understand who holds which opinion, who proposed what, and the dynamics between participants — but NEVER output raw speaker labels like 'Speaker 1', 'Speaker 0', 'speaker0', etc. " +
    "3) When attribution matters: if a speaker's name can be identified from the transcript (e.g., they introduced themselves or were addressed by name), use their real name (e.g., '田中さんからの質問', '鈴木の提案'). Otherwise, describe by inferred role or position (e.g., '提案側の意見として', 'プロジェクトリーダーが指摘した点'). If neither name nor role can be inferred, paraphrase without attribution rather than using speaker numbers. " +
    "4) Organize by TOPIC, not chronologically. Extract and distill: key decisions, action items, facts, issues, background context, and conclusions. " +
    "5) CONSOLIDATION (CRITICAL — non-redundant): Each distinct topic, decision, fact, definition, number, or conclusion must appear EXACTLY ONCE, in the single most relevant section. The conversation circles back to topics — do NOT create a new section or restate a point each time it recurs; gather everything about a topic into its one section. Never repeat the same conclusion/figure/definition/action item across sections; refer to it in one short phrase if needed elsewhere. Before finalizing, scan your output and merge sections/bullets covering the same subject. Prefer a tight, consolidated document over a long, repetitive one. " +
    "6) Omit filler, repetition, backchannel responses, and off-topic tangents. " +
    "7) SEPARATION RULE: If web-search supplementary information is provided (a 'Research Context' block), it is NOT part of the meeting and MUST NOT be woven into the minutes body. Place it in a SINGLE dedicated section at the very end, titled '## 補足情報（Web調査）' (match the document's language), clearly separated from the meeting minutes. Include ONLY research points that ADD information the minutes do not already contain — never restate a fact/figure/conclusion already in the body. Keep each supplement concise. Do NOT create this section if no research information was provided. If a 'Questions Context' block is provided, collect those follow-up questions under a SEPARATE trailing section '## 確認したいこと' (match the document's language), after '## 補足情報（Web調査）'; they are prompts to ask, NOT facts, and MUST NOT enter the minutes body. Omit if none. " +
    "8) PARTICIPANTS: When two or more people take part and their names or sides can be established from the transcript, open the document with a short '## 参加者' section (match the document's language) listing each person by the name used in the transcript, or — when no name is spoken — by organisation and role. Never invent a name or an organisation. If you could not decide whether two labels are the same person, list the participants you are sure of and say so in one short line instead of inflating the count. Omit this section for a solo recording, or when no side or role can be established. " +
    "9) COVERAGE CHECK — do this before you output: re-read the transcript from the start against your draft and confirm that every decision, figure, date, name, deadline, condition, commitment and action item that was actually spoken survives somewhere in the document. Put back anything you dropped. This is not a licence to repeat: rule 5 still holds, so a recovered item goes in the one section it belongs to. Anything the speakers themselves retracted or corrected must NOT be restored — keep only the corrected version. " +
    "Keep the same language as the transcript. Do NOT add generic titles like '会議メモ'. " +
    "Output ONLY the structured Markdown, no explanations. Do not truncate.";

  const header =
    segments > 1
      ? `## Batch-Diarized Transcript (${segments} segments, ${speakerCount} speaker labels — labels are per-segment, unify them into the real people)`
      : `## Batch-Diarized Transcript (${speakerCount} speakers)`;
  let user = existingDoc
    ? `${header}\n\n${transcript}\n\n## Existing Document (preliminary)\n\n${existingDoc}\n\nProduce the final refined document using the diarized transcript as the authoritative source.`
    : `${header}\n\n${transcript}\n\nProduce a polished structured document from this transcript.`;

  if (input.researchCards.length > 0) {
    user +=
      "\n\n## Research Context (web search — SUPPLEMENTARY, NOT meeting content)\n" +
      "Gathered via web search during the recording — background reference, NOT meeting speech. " +
      "Follow the SEPARATION RULE: put these in the trailing '## 補足情報（Web調査）' section, NOT in the minutes body. " +
      "For EACH item: use a natural H3 heading like '### 〇〇の件について' (never the raw query); write 1–2 concise sentences (do not dump the summary verbatim); include ONLY what adds to the minutes; and, if it clearly supplements a specific meeting section, add a link on its own line — [本文「<見出し>」への補足](#<見出し>) — copying that body heading VERBATIM. Cite sources as markdown links.\n\n" +
      input.researchCards
        .map((c) => {
          const srcList = c.sources
            .map((s) => `  - [${s.title}](${s.url})`)
            .join("\n");
          return `### ${c.type}: ${c.query}\n${c.summary}\n${srcList}`;
        })
        .join("\n\n");
  }
  if (input.questionSummaries.length > 0) {
    user += buildQuestionsContext(input.questionSummaries);
  }
  return { system, user };
}

// ---------------------------------------------------------------------
// Anthropic SSE accumulation (server-side structuring)
// ---------------------------------------------------------------------

/**
 * Incrementally parse an Anthropic Messages SSE stream (as proxied by Vertex
 * streamRawPredict). Mirrors the client parser it replaces: answer text comes
 * from content_block_delta text deltas (thinking deltas are ignored), the stop
 * reason from message_delta, and an in-stream `error` event is recorded.
 */
export class SseTextAccumulator {
  text = "";
  stopReason = "";
  streamError = "";
  private buf = "";

  push(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() || "";
    for (const line of lines) this.line(line);
  }

  end(): void {
    if (this.buf) this.line(this.buf);
    this.buf = "";
  }

  private line(line: string): void {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const evt = JSON.parse(payload) as {
        type?: string;
        delta?: { type?: string; text?: string; stop_reason?: string };
        error?: { type?: string; message?: string };
      };
      if (
        evt.type === "content_block_delta" &&
        typeof evt.delta?.text === "string"
      ) {
        this.text += evt.delta.text;
      } else if (evt.type === "message_delta" && evt.delta?.stop_reason) {
        this.stopReason = evt.delta.stop_reason;
      } else if (evt.type === "error") {
        this.streamError = evt.error?.type || evt.error?.message || "error";
      }
    } catch {
      // skip malformed SSE lines (same as the client parser)
    }
  }
}

// ---------------------------------------------------------------------
// NDJSON progress stream (the POST response body)
// ---------------------------------------------------------------------

export type RefineEvent =
  | { type: "accepted"; job: RefineJobView }
  | { type: "stage"; stage: RefineStage }
  | { type: "ping" }
  | { type: "done"; job: RefineJobView }
  | {
      type: "error";
      status: number;
      body: Record<string, unknown>;
      job: RefineJobView | null;
    };

export function encodeEvent(e: RefineEvent): string {
  return `${JSON.stringify(e)}\n`;
}
