import { describe, it, expect, vi, beforeEach } from "vitest";

const streamMock = vi.fn();
const fetchJobMock = vi.fn();

vi.mock("@/services/refine-jobs", async (orig) => {
  const actual = await orig<typeof import("./refine-jobs")>();
  return {
    ...actual,
    streamRefineJob: (...a: unknown[]) => streamMock(...a),
    fetchRefineJob: (...a: unknown[]) => fetchJobMock(...a),
    newRefineJobId: () => "job_structuretest",
  };
});

import { runStructureJob } from "./structure-job";
import {
  RefineHttpError,
  type RefineStreamEvent,
  type RefineJobView,
} from "./refine-jobs";

const OPTS = {
  docId: "doc-1",
  baseContentHash: "a".repeat(64),
  system: "sys",
  user: "## Doc\n\n## New\nhello",
  token: "tok",
};

function doneView(output: string): RefineJobView {
  return {
    jobId: "job_structuretest",
    docId: "doc-1",
    status: "done",
    stage: "done",
    stale: false,
    createdAt: 0,
    updatedAt: 0,
    baseContentHash: "a".repeat(64),
    includedCardIds: [],
    speakerCount: 0,
    transcriptChars: 0,
    outputChars: output.length,
    stopReason: "end_turn",
    error: null,
    ackAt: null,
    output,
  };
}

beforeEach(() => {
  streamMock.mockReset();
  fetchJobMock.mockReset();
  vi.useRealTimers();
});

describe("runStructureJob", () => {
  it("returns the output from a terminal done event (stream intact)", async () => {
    streamMock.mockImplementation(
      async (
        _body: unknown,
        _token: string,
        onEvent: (e: RefineStreamEvent) => void,
      ) => {
        onEvent({ type: "done", job: doneView("# 整形済み") });
        return "completed";
      },
    );
    const res = await runStructureJob(OPTS);
    expect(res.output).toBe("# 整形済み");
    expect(res.stopReason).toBe("end_turn");
    expect(fetchJobMock).not.toHaveBeenCalled();
  });

  it("throws RefineHttpError on a server error event (e.g. quota)", async () => {
    streamMock.mockImplementation(
      async (
        _b: unknown,
        _t: string,
        onEvent: (e: RefineStreamEvent) => void,
      ) => {
        onEvent({
          type: "error",
          status: 429,
          body: { error: "quota_exceeded" },
          job: null,
        });
        return "completed";
      },
    );
    await expect(runStructureJob(OPTS)).rejects.toBeInstanceOf(RefineHttpError);
    expect(fetchJobMock).not.toHaveBeenCalled();
  });

  it("recovers a cut stream by polling the persisted job", async () => {
    // Stream detaches with no terminal event — the ~7% cut-network case.
    streamMock.mockResolvedValue("detached");
    // First poll: still running; second poll: done.
    fetchJobMock
      .mockResolvedValueOnce({ ...doneView(""), status: "running" })
      .mockResolvedValueOnce(doneView("# 回収した整形"));

    vi.useFakeTimers();
    const p = runStructureJob(OPTS);
    // Two 3s poll intervals.
    await vi.advanceTimersByTimeAsync(3100);
    await vi.advanceTimersByTimeAsync(3100);
    const res = await p;
    expect(res.output).toBe("# 回収した整形");
    expect(fetchJobMock).toHaveBeenCalledTimes(2);
  });

  it("throws when a polled job reports an error", async () => {
    streamMock.mockResolvedValue("detached");
    fetchJobMock.mockResolvedValueOnce({
      ...doneView(""),
      status: "error",
      error: { stage: "structure", code: "ai_failed", status: 500, body: {} },
    });
    vi.useFakeTimers();
    const p = runStructureJob(OPTS);
    const assertion = expect(p).rejects.toBeInstanceOf(RefineHttpError);
    await vi.advanceTimersByTimeAsync(3100);
    await assertion;
  });
});
