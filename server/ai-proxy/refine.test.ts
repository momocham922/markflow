import { describe, it, expect } from "vitest";
import {
  parseRefineRequest,
  decideJobAction,
  newJobRecord,
  toJobRecord,
  toJobView,
  pickPendingJob,
  isStale,
  isValidJobId,
  isAckAction,
  isAudioTooLongMessage,
  audioKeyFor,
  splitUtf8,
  buildRefinePrompt,
  buildQuestionsContext,
  SseTextAccumulator,
  encodeEvent,
  REFINE_STALE_MS,
  REFINE_MAX_ATTEMPTS,
  REFINE_RESUME_WINDOW_MS,
  MAX_EXISTING_DOC_CHARS,
  MAX_VOCABULARY,
  type RefineJobRecord,
  type RefineCreateRequest,
} from "./refine";

const UID = "user-1";
const PREFIX = `gs://bucket/audio/${UID}/`;
const HASH = "a".repeat(64);
const JOB = "job_12345678";

function body(over: Record<string, unknown> = {}) {
  return {
    jobId: JOB,
    docId: "doc-1",
    language: "ja-JP",
    chunks: [{ gcsUri: `${PREFIX}x.wav`, startSec: 0, durationSec: 600 }],
    baseContentHash: HASH,
    existingDoc: "# 既存",
    vocabulary: ["hacomono", "TOKYO KOSAN"],
    researchCards: [
      {
        type: "topic",
        query: "hacomono",
        summary: "会員管理",
        sources: [{ title: "hacomono", url: "https://www.hacomono.jp/" }],
      },
    ],
    questionCards: [{ summary: "API連携の許可は？" }],
    includedCardIds: ["c1", "c2"],
    ...over,
  };
}

function createReq(): RefineCreateRequest {
  const p = parseRefineRequest(body(), PREFIX, 48);
  if (p.kind !== "create") throw new Error("expected create");
  return p.req;
}

function record(over: Partial<RefineJobRecord> = {}): RefineJobRecord {
  return { ...newJobRecord(UID, createReq(), "r1", 1, 1_000), ...over };
}

describe("parseRefineRequest", () => {
  it("accepts a well-formed create request and normalizes it", () => {
    const p = parseRefineRequest(body(), PREFIX, 48);
    expect(p.kind).toBe("create");
    if (p.kind !== "create") return;
    expect(p.req.jobId).toBe(JOB);
    expect(p.req.docId).toBe("doc-1");
    expect(p.req.chunks).toEqual([
      { gcsUri: `${PREFIX}x.wav`, startSec: 0, durationSec: 600 },
    ]);
    expect(p.req.input.vocabulary).toEqual(["hacomono", "TOKYO KOSAN"]);
    expect(p.req.input.researchCards[0].sources[0].url).toBe(
      "https://www.hacomono.jp/",
    );
    expect(p.req.input.questionSummaries).toEqual(["API連携の許可は？"]);
    expect(p.req.includedCardIds).toEqual(["c1", "c2"]);
  });
  it("recognizes a resume request by job id alone", () => {
    expect(
      parseRefineRequest({ jobId: JOB, resume: true }, PREFIX, 48),
    ).toEqual({
      kind: "resume",
      jobId: JOB,
    });
  });
  it("rejects malformed ids", () => {
    for (const jobId of [
      "",
      "short",
      "has space 123",
      "x".repeat(65),
      12345678,
    ]) {
      const p = parseRefineRequest(body({ jobId }), PREFIX, 48);
      expect(p).toMatchObject({
        kind: "invalid",
        status: 400,
        error: "invalid_job_id",
      });
    }
    expect(
      parseRefineRequest(body({ docId: "a/b" }), PREFIX, 48),
    ).toMatchObject({
      error: "invalid_doc_id",
    });
  });
  it("refuses audio outside the caller's own folder (403)", () => {
    const p = parseRefineRequest(
      body({ chunks: [{ gcsUri: "gs://bucket/audio/other/x.wav" }] }),
      PREFIX,
      48,
    );
    expect(p).toMatchObject({
      kind: "invalid",
      status: 403,
      error: "invalid_audio_path",
    });
  });
  it("requires chunks, caps their number and requires a content hash", () => {
    expect(parseRefineRequest(body({ chunks: [] }), PREFIX, 48)).toMatchObject({
      error: "chunks_required",
    });
    const many = Array.from({ length: 3 }, (_, i) => ({
      gcsUri: `${PREFIX}${i}.wav`,
    }));
    expect(parseRefineRequest(body({ chunks: many }), PREFIX, 2)).toMatchObject(
      {
        error: "too_many_chunks",
      },
    );
    expect(
      parseRefineRequest(body({ baseContentHash: "nope" }), PREFIX, 48),
    ).toMatchObject({
      error: "invalid_base_hash",
    });
  });
  it("bounds the document and vocabulary sizes", () => {
    expect(
      parseRefineRequest(
        body({ existingDoc: "x".repeat(MAX_EXISTING_DOC_CHARS + 1) }),
        PREFIX,
        48,
      ),
    ).toMatchObject({ status: 413 });
    const vocab = Array.from({ length: 300 }, (_, i) => `t${i}`);
    const p = parseRefineRequest(
      body({ vocabulary: [...vocab, "t1", 5] }),
      PREFIX,
      48,
    );
    expect(p.kind === "create" && p.req.input.vocabulary.length).toBe(
      MAX_VOCABULARY,
    );
  });
  it("drops research cards without a summary", () => {
    const p = parseRefineRequest(
      body({
        researchCards: [{ type: "topic", query: "q", summary: "" }, "junk"],
      }),
      PREFIX,
      48,
    );
    expect(p.kind === "create" && p.req.input.researchCards).toEqual([]);
  });
});

describe("decideJobAction", () => {
  const now = 10_000_000;
  it("creates only on a create request for an unknown id", () => {
    expect(decideJobAction(null, UID, true, now)).toEqual({ kind: "create" });
    expect(decideJobAction(null, UID, false, now)).toEqual({
      kind: "not_found",
    });
  });
  it("hides other users' jobs", () => {
    expect(decideJobAction(record({ uid: "someone" }), UID, true, now)).toEqual(
      {
        kind: "not_found",
      },
    );
  });
  it("returns a finished job without re-running it (no second charge)", () => {
    expect(decideJobAction(record({ status: "done" }), UID, true, now)).toEqual(
      {
        kind: "return_done",
      },
    );
  });
  it("leaves a live job alone and resumes an interrupted one", () => {
    const live = record({ status: "running", heartbeatAt: now - 1000 });
    expect(decideJobAction(live, UID, false, now)).toEqual({ kind: "busy" });
    const dead = record({
      status: "running",
      heartbeatAt: now - REFINE_STALE_MS - 1,
    });
    expect(decideJobAction(dead, UID, false, now)).toEqual({
      kind: "run",
      from: "transcribe",
    });
  });
  it("skips speech-to-text when the transcript is already saved", () => {
    const failed = record({ status: "error", transcriptParts: 1 });
    expect(decideJobAction(failed, UID, false, now)).toEqual({
      kind: "run",
      from: "structure",
    });
  });
  it("stops after the attempt budget", () => {
    const tired = record({ status: "error", attempts: REFINE_MAX_ATTEMPTS });
    expect(decideJobAction(tired, UID, false, now)).toEqual({
      kind: "exhausted",
    });
  });
});

describe("job records and views", () => {
  it("round-trips through the tolerant Firestore coercion", () => {
    const r = record({
      error: {
        stage: "structure",
        code: "quota_exceeded",
        status: 429,
        body: { feature: "aiCalls" },
      },
    });
    expect(toJobRecord(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });
  it("coerces garbage to a safe errored record", () => {
    const r = toJobRecord({ status: "weird", stage: 5, chunks: "no" });
    expect(r.status).toBe("error");
    expect(r.stage).toBe("transcribe");
    expect(r.chunks).toEqual([]);
    expect(r.error).toBeNull();
  });
  it("flags stale running jobs in the view and attaches text only on request", () => {
    const r = record({ status: "running", heartbeatAt: 0 });
    const v = toJobView(JOB, r, REFINE_STALE_MS + 10);
    expect(v.stale).toBe(true);
    expect(v).not.toHaveProperty("output");
    const done = toJobView(JOB, record({ status: "done" }), 2000, {
      output: "# out",
      transcript: "t",
    });
    expect(done.stale).toBe(false);
    expect(done.output).toBe("# out");
    expect(done.transcript).toBe("t");
  });
  it("isStale is only true for running jobs", () => {
    expect(isStale({ status: "error", heartbeatAt: 0 }, 1e12)).toBe(false);
    expect(isStale({ status: "running", heartbeatAt: 0 }, 1e12)).toBe(true);
  });
  it("audio key changes with the audio", () => {
    const a = audioKeyFor([{ gcsUri: "a", startSec: 0, durationSec: 1 }]);
    const b = audioKeyFor([{ gcsUri: "b", startSec: 0, durationSec: 1 }]);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("pickPendingJob", () => {
  const now = REFINE_RESUME_WINDOW_MS + 100_000;
  const mk = (id: string, over: Partial<RefineJobRecord>) => ({
    id,
    job: record(over),
  });
  it("offers the newest unacknowledged job for this user and document", () => {
    const jobs = [
      mk("old", { createdAt: now - 5000 }),
      mk("new", { createdAt: now - 1000 }),
      mk("acked", { createdAt: now - 10, ackAt: now }),
      mk("other-doc", { createdAt: now - 1, docId: "doc-2" }),
      mk("other-user", { createdAt: now - 1, uid: "u2" }),
      mk("expired", { createdAt: 1 }),
    ];
    expect(pickPendingJob(jobs, UID, "doc-1", now)?.id).toBe("new");
  });
  it("returns null when nothing is pending", () => {
    expect(pickPendingJob([], UID, "doc-1", now)).toBeNull();
  });
});

describe("small validators", () => {
  it("isValidJobId / isAckAction", () => {
    expect(isValidJobId(crypto.randomUUID())).toBe(true);
    expect(isValidJobId("../etc/passwd")).toBe(false);
    expect(isAckAction("applied")).toBe(true);
    expect(isAckAction("dismissed")).toBe(true);
    expect(isAckAction("delete")).toBe(false);
  });
});

describe("isAudioTooLongMessage", () => {
  it("recognizes BatchRecognize's length rejection", () => {
    expect(
      isAudioTooLongMessage(
        "STT failed: File `gs://b/a.wav` is too long. Only audio files up to 20 minutes are supported",
      ),
    ).toBe(true);
    expect(isAudioTooLongMessage('STT op error: {"code":13}')).toBe(false);
  });
});

describe("splitUtf8", () => {
  it("keeps short text whole (and empty text as one part)", () => {
    expect(splitUtf8("abc", 10)).toEqual(["abc"]);
    expect(splitUtf8("", 10)).toEqual([""]);
  });
  it("splits on code-point boundaries within the byte budget", () => {
    const text = "あいう😀えお"; // 3-byte kana, 4-byte emoji
    const parts = splitUtf8(text, 7);
    expect(parts.join("")).toBe(text);
    for (const p of parts)
      expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(7);
    expect(parts.some((p) => p.includes("😀"))).toBe(true);
  });
  it("handles large Japanese text", () => {
    const text = "議事録".repeat(200_000); // 1.8 MB
    const parts = splitUtf8(text, 700_000);
    expect(parts.length).toBe(3);
    expect(parts.join("")).toBe(text);
  });
});

describe("buildRefinePrompt (verbatim port of the client prompt)", () => {
  const input = createReq().input;
  it("includes the existing document, vocabulary hint and speaker count", () => {
    const { system, user } = buildRefinePrompt(
      "[Speaker 1] こんにちは",
      3,
      input,
    );
    expect(system).toContain("performing a FINAL REFINEMENT");
    expect(system).toContain(
      "and an EXISTING DOCUMENT (a preliminary structure",
    );
    expect(system).toContain("[hacomono, TOKYO KOSAN]");
    expect(system).toContain("There are 3 speaker(s) in this recording.");
    expect(
      system.endsWith(
        "Output ONLY the structured Markdown, no explanations. Do not truncate.",
      ),
    ).toBe(true);
    expect(
      user.startsWith(
        "## Batch-Diarized Transcript (3 speakers)\n\n[Speaker 1] こんにちは\n\n## Existing Document (preliminary)\n\n# 既存",
      ),
    ).toBe(true);
    expect(user).toContain(
      "using the diarized transcript as the authoritative source.",
    );
  });
  it("omits the existing-document parts (and vocabulary) for an empty document", () => {
    const { system, user } = buildRefinePrompt("t", 1, {
      ...input,
      existingDoc: "  ",
    });
    expect(system).not.toContain("EXISTING DOCUMENT");
    expect(system).not.toContain("hacomono");
    expect(user).toContain(
      "Produce a polished structured document from this transcript.",
    );
  });
  it("appends research and question context blocks in order", () => {
    const { user } = buildRefinePrompt("t", 1, input);
    const r = user.indexOf("## Research Context (web search — SUPPLEMENTARY");
    const q = user.indexOf("## Questions Context");
    expect(r).toBeGreaterThan(0);
    expect(q).toBeGreaterThan(r);
    expect(user).toContain(
      "### topic: hacomono\n会員管理\n  - [hacomono](https://www.hacomono.jp/)",
    );
    expect(user.endsWith("API連携の許可は？")).toBe(true);
  });
  it("adds no context blocks when there are no cards", () => {
    const { user } = buildRefinePrompt("t", 1, {
      ...input,
      researchCards: [],
      questionSummaries: [],
    });
    expect(user).not.toContain("Research Context");
    expect(user).not.toContain("Questions Context");
  });
  it("buildQuestionsContext lists the questions after the rules", () => {
    const out = buildQuestionsContext(["q1", "q2"]);
    expect(out.startsWith("\n\n## Questions Context")).toBe(true);
    expect(out.endsWith("\n\nq1\nq2")).toBe(true);
  });
});

describe("SseTextAccumulator", () => {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n`;
  it("collects text deltas across split chunks and the stop reason", () => {
    const acc = new SseTextAccumulator();
    const stream =
      "event: message_start\n" +
      ev({ type: "message_start" }) +
      ev({
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "hmm" },
      }) +
      ev({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "# 見出し" },
      }) +
      ev({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "\n本文" },
      }) +
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" } });
    // feed it in awkward 7-char pieces
    for (let i = 0; i < stream.length; i += 7) acc.push(stream.slice(i, i + 7));
    acc.end();
    expect(acc.text).toBe("# 見出し\n本文");
    expect(acc.stopReason).toBe("end_turn");
    expect(acc.streamError).toBe("");
  });
  it("records an in-stream error event and ignores junk", () => {
    const acc = new SseTextAccumulator();
    acc.push("data: {not json\n");
    acc.push(ev({ type: "error", error: { type: "overloaded_error" } }));
    acc.push("data: [DONE]\n");
    acc.end();
    expect(acc.text).toBe("");
    expect(acc.streamError).toBe("overloaded_error");
  });
  it("parses a final line without a trailing newline on end()", () => {
    const acc = new SseTextAccumulator();
    acc.push(
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "x" } })}`,
    );
    expect(acc.text).toBe("");
    acc.end();
    expect(acc.text).toBe("x");
  });
});

describe("encodeEvent", () => {
  it("emits one JSON object per line", () => {
    const line = encodeEvent({ type: "stage", stage: "structure" });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ type: "stage", stage: "structure" });
  });
});
