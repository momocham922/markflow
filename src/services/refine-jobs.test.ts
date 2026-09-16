import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/stores/entitlement-store", () => ({
  useEntitlementStore: { getState: () => ({ viewAs: null }) },
}));

import {
  parseNdjson,
  sha256Hex,
  streamRefineJob,
  fetchRefineJob,
  findPendingRefineJob,
  ackRefineJob,
  refineErrorMessage,
  refineThrownMessage,
  RefineHttpError,
  newRefineJobId,
  type RefineStreamEvent,
} from "./refine-jobs";
import { FriendlyError } from "@/lib/friendly-error";

function ndjsonResponse(lines: string[], opts: { breakAfter?: boolean } = {}) {
  // Pull-based so every line is delivered before a simulated network error
  // (controller.error() would otherwise discard still-queued chunks).
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < lines.length) {
        controller.enqueue(enc.encode(lines[i++]));
      } else if (opts.breakAfter) {
        controller.error(new TypeError("network lost"));
      } else {
        controller.close();
      }
    },
  });
  return new Response(body, { status: 200 });
}

const JOB = {
  jobId: "j1",
  docId: "d1",
  status: "done",
  stage: "done",
  stale: false,
  createdAt: 1,
  updatedAt: 2,
  baseContentHash: "h",
  includedCardIds: [],
  speakerCount: 2,
  transcriptChars: 3,
  outputChars: 4,
  stopReason: "end_turn",
  error: null,
  ackAt: null,
  output: "# out",
  transcript: "t",
};

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseNdjson", () => {
  it("returns complete lines as events and keeps the partial tail", () => {
    const { events, rest } = parseNdjson(
      '{"type":"ping"}\n\n{"type":"stage","stage":"structure"}\n{"type":"do',
    );
    expect(events).toEqual([
      { type: "ping" },
      { type: "stage", stage: "structure" },
    ]);
    expect(rest).toBe('{"type":"do');
  });
  it("skips malformed and typeless lines", () => {
    const { events } = parseNdjson('nope\n{"x":1}\n{"type":"ping"}\n');
    expect(events).toEqual([{ type: "ping" }]);
  });
});

describe("sha256Hex / newRefineJobId", () => {
  it("hashes UTF-8 text", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex("議事録")).toMatch(/^[a-f0-9]{64}$/);
  });
  it("produces ids the server accepts", () => {
    expect(newRefineJobId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe("streamRefineJob", () => {
  const body = { jobId: "j1", resume: true as const };
  it("delivers events split across chunks and reports completion", async () => {
    fetchMock.mockResolvedValue(
      ndjsonResponse([
        '{"type":"accepted","job":{"jobId":"j1"}}\n{"type":"sta',
        'ge","stage":"transcribe"}\n',
        `{"type":"done","job":${JSON.stringify(JOB)}}`, // no trailing newline
      ]),
    );
    const seen: RefineStreamEvent[] = [];
    const out = await streamRefineJob(body, "tok", (e) => seen.push(e));
    expect(out).toBe("completed");
    expect(seen.map((e) => e.type)).toEqual(["accepted", "stage", "done"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1/voice/refine-jobs");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });
  it("reports 'detached' when the stream breaks before a result", async () => {
    fetchMock.mockResolvedValue(
      ndjsonResponse(['{"type":"accepted","job":{"jobId":"j1"}}\n'], {
        breakAfter: true,
      }),
    );
    const seen: RefineStreamEvent[] = [];
    expect(await streamRefineJob(body, "tok", (e) => seen.push(e))).toBe(
      "detached",
    );
    expect(seen).toHaveLength(1);
  });
  it("reports 'detached' when the stream simply ends without a result", async () => {
    fetchMock.mockResolvedValue(ndjsonResponse(['{"type":"ping"}\n']));
    expect(await streamRefineJob(body, "tok", () => {})).toBe("detached");
  });
  it("treats an error event as a terminal result", async () => {
    fetchMock.mockResolvedValue(
      ndjsonResponse([
        '{"type":"error","status":429,"body":{"error":"quota_exceeded"},"job":null}\n',
      ]),
    );
    expect(await streamRefineJob(body, "tok", () => {})).toBe("completed");
  });
  it("throws RefineHttpError with the server body on a refusal", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "job_running" }), { status: 409 }),
    );
    const err = await streamRefineJob(body, "tok", () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(RefineHttpError);
    expect(err.status).toBe(409);
    expect(err.body).toEqual({ error: "job_running" });
  });
  it("rethrows a network failure unless the caller aborted", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(streamRefineJob(body, "tok", () => {})).rejects.toThrow(
      "Failed to fetch",
    );
    const ac = new AbortController();
    ac.abort();
    expect(await streamRefineJob(body, "tok", () => {}, ac.signal)).toBe(
      "detached",
    );
  });
});

describe("GET / ack helpers", () => {
  it("fetchRefineJob returns the job, null on 404, throws otherwise", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ job: JOB }), { status: 200 }),
    );
    expect((await fetchRefineJob("j1", "tok"))?.output).toBe("# out");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    expect(await fetchRefineJob("j1", "tok")).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 500 }));
    await expect(fetchRefineJob("j1", "tok")).rejects.toBeInstanceOf(
      RefineHttpError,
    );
  });
  it("findPendingRefineJob encodes the doc id and returns null when none", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ job: null }), { status: 200 }),
    );
    expect(await findPendingRefineJob("a b", "tok")).toBeNull();
    expect(String(fetchMock.mock.calls[0][0])).toContain("docId=a%20b");
  });
  it("ackRefineJob posts the action and throws on failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await ackRefineJob("j1", "applied", "tok");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1/voice/refine-jobs/j1/ack");
    expect(JSON.parse(init.body)).toEqual({ action: "applied" });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    await expect(ackRefineJob("j1", "applied", "tok")).rejects.toThrow();
  });
});

describe("refineErrorMessage", () => {
  it("uses the server's Japanese message for batch contention", () => {
    expect(
      refineErrorMessage("transcribe", "batch_in_progress", 429, {
        message: "別の文字起こしが処理中です。",
      }),
    ).toBe("文字起こし: 別の文字起こしが処理中です。");
  });
  it("maps quota, empty transcript and STT failures", () => {
    expect(refineErrorMessage("transcribe", "quota_exceeded", 429)).toContain(
      "ご利用の上限",
    );
    expect(refineErrorMessage("transcribe", "empty_transcript", 422)).toContain(
      "文字起こし結果が空",
    );
    expect(refineErrorMessage("transcribe", "stt_failed", 502)).toContain(
      "文字起こしに失敗",
    );
  });
  it("tells the user a structuring retry reuses the saved transcript", () => {
    expect(refineErrorMessage("structure", "ai_upstream_error", 503)).toContain(
      "整形だけをやり直します",
    );
  });
  it("never echoes raw codes for unknown failures", () => {
    const m = refineErrorMessage("upload", "weird_code_x", 500);
    expect(m.startsWith("音声アップロード: ")).toBe(true);
    expect(m).not.toContain("weird_code_x");
    expect(m).not.toContain("500");
  });
  it("refineThrownMessage handles friendly, http and arbitrary errors", () => {
    expect(refineThrownMessage(new FriendlyError("そのまま"), "upload")).toBe(
      "そのまま",
    );
    expect(
      refineThrownMessage(
        new RefineHttpError(400, {
          error: "too_many_chunks",
          message: "長すぎ",
        }),
        "transcribe",
      ),
    ).toBe("文字起こし: 長すぎ");
    const m = refineThrownMessage(new Error("Failed to fetch"), "upload");
    expect(m).toContain("サーバーに接続できませんでした");
  });
});
