import { describe, it, expect, vi, beforeEach } from "vitest";

const trackMock = vi.fn();
const reportIfQuotaMock = vi.fn();
const streamMock = vi.fn();
const fetchJobMock = vi.fn();

vi.mock("@/services/firebase", () => ({
  auth: { currentUser: { getIdToken: () => Promise.resolve("tok") } },
}));
vi.mock("@/services/telemetry", () => ({
  track: (...a: unknown[]) => trackMock(...a),
}));
vi.mock("@/services/ai-proxy", () => ({
  reportIfQuota: (...a: unknown[]) => reportIfQuotaMock(...a),
  aiProxyHeaders: () => ({}),
}));
vi.mock("@/services/refine-jobs", async (orig) => {
  const actual = await orig<typeof import("./refine-jobs")>();
  return {
    ...actual,
    streamRefineJob: (...a: unknown[]) => streamMock(...a),
    fetchRefineJob: (...a: unknown[]) => fetchJobMock(...a),
  };
});

import {
  runRefineStream,
  pollRefineJob,
  retryRefineJob,
  recordLocalRefineFailure,
} from "./refine-runner";
import { RefineHttpError, type RefineJobView } from "./refine-jobs";
import { useRefineStore } from "@/stores/refine-store";

const DOC = "doc-1";

function job(over: Partial<RefineJobView> = {}): RefineJobView {
  return {
    jobId: "j1",
    docId: DOC,
    status: "running",
    stage: "transcribe",
    stale: false,
    createdAt: 1,
    updatedAt: 1,
    baseContentHash: "h",
    includedCardIds: [],
    speakerCount: 0,
    transcriptChars: 0,
    outputChars: 0,
    stopReason: "",
    error: null,
    ackAt: null,
    ...over,
  };
}

const state = () => useRefineStore.getState().byDoc[DOC];

beforeEach(() => {
  useRefineStore.getState().reset();
  trackMock.mockReset();
  reportIfQuotaMock.mockReset();
  streamMock.mockReset();
  fetchJobMock.mockReset();
});

describe("runRefineStream", () => {
  it("follows accepted → stage → done and ends ready + unattached", async () => {
    streamMock.mockImplementation(async (_b, _t, onEvent) => {
      onEvent({ type: "accepted", job: job() });
      expect(state().attached).toBe(true);
      onEvent({ type: "stage", stage: "structure" });
      expect(state().phase).toBe("structure");
      onEvent({
        type: "done",
        job: job({
          status: "done",
          stage: "done",
          output: "# x",
          outputChars: 3,
        }),
      });
      return "completed";
    });
    useRefineStore.getState().begin(DOC, "a");
    await runRefineStream(DOC, { jobId: "j1", resume: true });
    expect(state()).toMatchObject({
      phase: "ready",
      attached: false,
      jobId: "j1",
    });
    expect(state().job?.output).toBe("# x");
    expect(trackMock).toHaveBeenCalledWith(
      "refine_completed",
      expect.objectContaining({ via: "stream", output_chars: 3 }),
    );
  });

  it("records an in-stream error with a friendly message and reports quota", async () => {
    streamMock.mockImplementation(async (_b, _t, onEvent) => {
      onEvent({
        type: "error",
        status: 429,
        body: { error: "quota_exceeded", feature: "aiCalls" },
        job: job({
          status: "error",
          stage: "structure",
          error: { stage: "structure", code: "quota_exceeded", status: 429 },
        }),
      });
      return "completed";
    });
    useRefineStore.getState().begin(DOC, "a");
    await runRefineStream(DOC, { jobId: "j1", resume: true });
    expect(state().phase).toBe("error");
    expect(state().message).toContain("ご利用の上限");
    expect(reportIfQuotaMock).toHaveBeenCalledWith(
      429,
      expect.stringContaining("quota_exceeded"),
    );
  });

  it("leaves a detached job for the poller", async () => {
    streamMock.mockImplementation(async (_b, _t, onEvent) => {
      onEvent({ type: "accepted", job: job() });
      return "detached";
    });
    useRefineStore.getState().begin(DOC, "a");
    await runRefineStream(DOC, { jobId: "j1", resume: true });
    expect(state()).toMatchObject({ phase: "transcribe", attached: false });
    expect(trackMock).toHaveBeenCalledWith(
      "refine_detached",
      expect.objectContaining({ stage: "transcribe" }),
    );
  });

  it("follows a job another request is already running (409 job_running)", async () => {
    streamMock.mockRejectedValue(
      new RefineHttpError(409, {
        error: "job_running",
        job: job({ stage: "structure" }),
      }),
    );
    useRefineStore.getState().begin(DOC, "a");
    await runRefineStream(DOC, { jobId: "j1", resume: true });
    expect(state()).toMatchObject({ phase: "structure", attached: false });
  });

  it("turns other refusals into an error", async () => {
    streamMock.mockRejectedValue(
      new RefineHttpError(400, {
        error: "too_many_chunks",
        message: "長すぎます",
      }),
    );
    useRefineStore.getState().begin(DOC, "a");
    await runRefineStream(DOC, { jobId: "j1", resume: true });
    expect(state()).toMatchObject({ phase: "error", attached: false });
    expect(state().message).toContain("長すぎます");
  });

  it("keeps a create that failed before reaching the server pollable", async () => {
    streamMock.mockRejectedValue(new TypeError("Failed to fetch"));
    useRefineStore.getState().begin(DOC, "a");
    await runRefineStream(DOC, {
      jobId: "j1",
      docId: DOC,
      language: "ja-JP",
      chunks: [],
      baseContentHash: "h",
      existingDoc: "",
      vocabulary: [],
      researchCards: [],
      questionCards: [],
      includedCardIds: [],
    });
    expect(state()).toMatchObject({
      phase: "transcribe",
      attached: false,
      jobId: "j1",
    });
  });
});

describe("pollRefineJob", () => {
  function detached(over = {}) {
    useRefineStore.getState().patch(DOC, {
      jobId: "j1",
      phase: "transcribe",
      attached: false,
      ...over,
    });
  }

  it("does nothing while a stream is attached", async () => {
    detached({ attached: true });
    await pollRefineJob(DOC);
    expect(fetchJobMock).not.toHaveBeenCalled();
  });
  it("picks up a finished job", async () => {
    detached();
    fetchJobMock.mockResolvedValue(
      job({ status: "done", stage: "done", output: "# y" }),
    );
    await pollRefineJob(DOC);
    expect(state().phase).toBe("ready");
    expect(state().job?.output).toBe("# y");
  });
  it("reports a failed job", async () => {
    detached();
    fetchJobMock.mockResolvedValue(
      job({
        status: "error",
        stage: "transcribe",
        error: { stage: "transcribe", code: "stt_failed", status: 502 },
      }),
    );
    await pollRefineJob(DOC);
    expect(state().phase).toBe("error");
    expect(state().message).toContain("文字起こしに失敗");
  });
  it("reports a job the server never received", async () => {
    detached();
    fetchJobMock.mockResolvedValue(null);
    await pollRefineJob(DOC);
    expect(state().phase).toBe("error");
    expect(state().message).toContain("見つかりませんでした");
  });
  it("tracks the server stage of a running job", async () => {
    detached();
    fetchJobMock.mockResolvedValue(job({ stage: "structure" }));
    await pollRefineJob(DOC);
    expect(state().phase).toBe("structure");
  });
  it("keeps state on a transient poll failure", async () => {
    detached();
    fetchJobMock.mockRejectedValue(new TypeError("offline"));
    await pollRefineJob(DOC);
    expect(state().phase).toBe("transcribe");
  });
  it("resumes a stale job, but only a bounded number of times", async () => {
    detached();
    fetchJobMock.mockResolvedValue(job({ stale: true }));
    streamMock.mockResolvedValue("detached");
    await pollRefineJob(DOC);
    expect(state()).toMatchObject({ resumeTries: 1, attached: true });
    await vi.waitFor(() => expect(streamMock).toHaveBeenCalledTimes(1));
    expect(streamMock.mock.calls[0][0]).toEqual({ jobId: "j1", resume: true });
    await vi.waitFor(() => expect(state().attached).toBe(false));
    await pollRefineJob(DOC);
    await vi.waitFor(() => expect(streamMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(state().attached).toBe(false));
    await pollRefineJob(DOC); // third stale sighting → give up
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(state().phase).toBe("error");
  });
  it("ignores a result for a job that was replaced meanwhile", async () => {
    detached();
    fetchJobMock.mockImplementation(async () => {
      useRefineStore.getState().patch(DOC, { jobId: "j2" });
      return job({ status: "done", output: "old" });
    });
    await pollRefineJob(DOC);
    expect(state().phase).toBe("transcribe");
  });
});

describe("retry / local failure", () => {
  it("retry resumes the job from structuring when the transcript is saved", async () => {
    useRefineStore.getState().patch(DOC, {
      jobId: "j1",
      phase: "error",
      message: "x",
      job: job({ status: "error", transcriptChars: 10 }),
    });
    streamMock.mockResolvedValue("completed");
    retryRefineJob(DOC);
    expect(state()).toMatchObject({ phase: "structure", message: null });
    await vi.waitFor(() => expect(streamMock).toHaveBeenCalledTimes(1));
    expect(streamMock.mock.calls[0][0]).toEqual({ jobId: "j1", resume: true });
  });
  it("records an upload failure with a stage-labelled message", () => {
    useRefineStore.getState().begin(DOC, "");
    recordLocalRefineFailure(DOC, new Error("Failed to fetch"), "upload");
    expect(state().phase).toBe("error");
    expect(state().message?.startsWith("音声アップロード: ")).toBe(true);
    expect(trackMock).toHaveBeenCalledWith(
      "refine_failed",
      expect.objectContaining({ stage: "upload", code: "local" }),
    );
  });
});
