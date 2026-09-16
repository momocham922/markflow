import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const trackMock = vi.fn();
const ackMock = vi.fn();
const findMock = vi.fn();
const pollMock = vi.fn();

vi.mock("@/services/firebase", () => ({
  auth: { currentUser: { getIdToken: () => Promise.resolve("tok") } },
}));
vi.mock("@/services/telemetry", () => ({
  track: (...a: unknown[]) => trackMock(...a),
}));
vi.mock("@/services/refine-runner", () => ({
  pollRefineJob: (...a: unknown[]) => pollMock(...a),
}));
vi.mock("@/stores/research-store", () => {
  const markIntegrated = vi.fn();
  return {
    useResearchStore: {
      getState: () => ({
        cards: [{ id: "c1" }, { id: "c2" }],
        markIntegrated,
      }),
    },
  };
});
vi.mock("@/services/refine-jobs", async (orig) => {
  const actual = await orig<typeof import("@/services/refine-jobs")>();
  return {
    ...actual,
    ackRefineJob: (...a: unknown[]) => ackMock(...a),
    findPendingRefineJob: (...a: unknown[]) => findMock(...a),
  };
});

import { useRefineJobSync } from "./use-refine-job-sync";
import { sha256Hex, type RefineJobView } from "@/services/refine-jobs";
import { useRefineStore } from "@/stores/refine-store";
import { useResearchStore } from "@/stores/research-store";

const ORIGINAL = "# 暫定メモ";

async function doneJob(
  over: Partial<RefineJobView> = {},
): Promise<RefineJobView> {
  return {
    jobId: "j1",
    docId: "d1",
    status: "done",
    stage: "done",
    stale: false,
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
    baseContentHash: await sha256Hex(ORIGINAL),
    includedCardIds: ["c2", "gone"],
    speakerCount: 2,
    transcriptChars: 5,
    outputChars: 7,
    stopReason: "end_turn",
    error: null,
    ackAt: null,
    output: "# 清書",
    transcript: "  [Speaker 0] 本文  ",
    ...over,
  };
}

function setup(initial: {
  docId: string | null;
  content: string;
  hasVoiceData?: boolean;
}) {
  const setContent = vi.fn();
  const setVoiceTranscript = vi.fn();
  const hook = renderHook(
    (p: { docId: string | null; content: string; hasVoiceData?: boolean }) =>
      useRefineJobSync({
        docId: p.docId,
        hasVoiceData: p.hasVoiceData ?? false,
        content: p.content,
        setContent,
        setVoiceTranscript,
      }),
    { initialProps: initial },
  );
  return { ...hook, setContent, setVoiceTranscript };
}

beforeEach(() => {
  useRefineStore.getState().reset();
  trackMock.mockReset();
  ackMock.mockReset().mockResolvedValue(undefined);
  findMock.mockReset().mockResolvedValue(null);
  pollMock.mockReset().mockResolvedValue(undefined);
  vi.mocked(useResearchStore.getState().markIntegrated).mockClear();
});

describe("useRefineJobSync — applying results", () => {
  it("applies automatically when the document is unchanged since the job started", async () => {
    const { setContent, setVoiceTranscript } = setup({
      docId: "d1",
      content: ORIGINAL,
    });
    const job = await doneJob();
    act(() =>
      useRefineStore
        .getState()
        .patch("d1", { jobId: "j1", job, phase: "ready" }),
    );
    await waitFor(() => expect(setContent).toHaveBeenCalledWith("# 清書"));
    expect(setVoiceTranscript).toHaveBeenCalledWith("[Speaker 0] 本文");
    // only cards that still exist on this device are marked
    expect(useResearchStore.getState().markIntegrated).toHaveBeenCalledTimes(1);
    expect(useResearchStore.getState().markIntegrated).toHaveBeenCalledWith(
      "c2",
    );
    expect(ackMock).toHaveBeenCalledWith("j1", "applied", "tok");
    expect(useRefineStore.getState().byDoc.d1).toBeUndefined();
    expect(useRefineStore.getState().notice).toMatchObject({
      docId: "d1",
      kind: "applied",
    });
    expect(trackMock).toHaveBeenCalledWith(
      "refine_applied",
      expect.objectContaining({ auto: true }),
    );
  });

  it("flags a truncated result with the truncation notice", async () => {
    setup({ docId: "d1", content: ORIGINAL });
    const job = await doneJob({ stopReason: "max_tokens" });
    act(() =>
      useRefineStore
        .getState()
        .patch("d1", { jobId: "j1", job, phase: "ready" }),
    );
    await waitFor(() =>
      expect(useRefineStore.getState().notice).toMatchObject({
        kind: "truncated",
      }),
    );
  });

  it("asks instead of overwriting when the document was edited meanwhile", async () => {
    const { result, setContent } = setup({
      docId: "d1",
      content: ORIGINAL + "\n追記",
    });
    const job = await doneJob();
    act(() =>
      useRefineStore
        .getState()
        .patch("d1", { jobId: "j1", job, phase: "ready" }),
    );
    await waitFor(() =>
      expect(useRefineStore.getState().byDoc.d1?.phase).toBe("review"),
    );
    expect(setContent).not.toHaveBeenCalled();
    act(() => result.current.confirmApply());
    expect(setContent).toHaveBeenCalledWith("# 清書");
    expect(trackMock).toHaveBeenCalledWith(
      "refine_applied",
      expect.objectContaining({ auto: false }),
    );
  });

  it("silently records a result that is already in the document", async () => {
    const { setContent } = setup({ docId: "d1", content: "# 清書" });
    const job = await doneJob();
    act(() =>
      useRefineStore
        .getState()
        .patch("d1", { jobId: "j1", job, phase: "ready" }),
    );
    await waitFor(() =>
      expect(ackMock).toHaveBeenCalledWith("j1", "applied", "tok"),
    );
    expect(setContent).not.toHaveBeenCalled();
    expect(useRefineStore.getState().byDoc.d1).toBeUndefined();
  });

  it("discard acknowledges the job without touching the document", async () => {
    const { result, setContent } = setup({ docId: "d1", content: "changed" });
    const job = await doneJob();
    act(() =>
      useRefineStore
        .getState()
        .patch("d1", { jobId: "j1", job, phase: "ready" }),
    );
    await waitFor(() =>
      expect(useRefineStore.getState().byDoc.d1?.phase).toBe("review"),
    );
    act(() => result.current.discard());
    expect(setContent).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(ackMock).toHaveBeenCalledWith("j1", "discarded", "tok"),
    );
    expect(useRefineStore.getState().byDoc.d1).toBeUndefined();
  });

  it("does not write into another document the user switched to", async () => {
    const { rerender, setContent } = setup({ docId: "d1", content: ORIGINAL });
    const job = await doneJob();
    // Switch documents before the result lands for d1.
    rerender({ docId: "d2", content: ORIGINAL });
    act(() =>
      useRefineStore
        .getState()
        .patch("d1", { jobId: "j1", job, phase: "ready" }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(setContent).not.toHaveBeenCalled();
    expect(useRefineStore.getState().byDoc.d1?.phase).toBe("ready");
    // Coming back applies it.
    rerender({ docId: "d1", content: ORIGINAL });
    await waitFor(() => expect(setContent).toHaveBeenCalledWith("# 清書"));
  });

  it("dismissing an error acknowledges it", async () => {
    const { result } = setup({ docId: "d1", content: ORIGINAL });
    act(() =>
      useRefineStore
        .getState()
        .patch("d1", { jobId: "j9", phase: "error", message: "x" }),
    );
    act(() => result.current.dismissError());
    await waitFor(() =>
      expect(ackMock).toHaveBeenCalledWith("j9", "dismissed", "tok"),
    );
    expect(useRefineStore.getState().byDoc.d1).toBeUndefined();
  });
});

describe("useRefineJobSync — discovery and polling", () => {
  it("looks up a pending job only for documents with voice data", async () => {
    setup({ docId: "d1", content: ORIGINAL, hasVoiceData: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(findMock).not.toHaveBeenCalled();
  });

  it("adopts a finished job found for the document and applies it", async () => {
    const job = await doneJob();
    findMock.mockResolvedValue(job);
    const { setContent } = setup({
      docId: "d1",
      content: ORIGINAL,
      hasVoiceData: true,
    });
    await waitFor(() => expect(setContent).toHaveBeenCalledWith("# 清書"));
    expect(findMock).toHaveBeenCalledWith("d1", "tok");
    expect(trackMock).toHaveBeenCalledWith(
      "refine_pending_found",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("surfaces a failed job with a friendly message", async () => {
    findMock.mockResolvedValue(
      await doneJob({
        status: "error",
        stage: "structure",
        output: undefined,
        error: { stage: "structure", code: "ai_upstream_error", status: 503 },
      }),
    );
    setup({ docId: "d1", content: ORIGINAL, hasVoiceData: true });
    await waitFor(() =>
      expect(useRefineStore.getState().byDoc.d1?.phase).toBe("error"),
    );
    expect(useRefineStore.getState().byDoc.d1?.message).toContain(
      "整形だけをやり直します",
    );
  });

  it("polls a detached running job and stops once a stream attaches", async () => {
    vi.useFakeTimers();
    try {
      setup({ docId: "d1", content: ORIGINAL });
      act(() =>
        useRefineStore.getState().patch("d1", {
          jobId: "j1",
          phase: "transcribe",
          attached: false,
        }),
      );
      expect(pollMock).toHaveBeenCalledTimes(1); // immediately
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(pollMock).toHaveBeenCalledTimes(2);
      act(() => useRefineStore.getState().patch("d1", { attached: true }));
      act(() => {
        vi.advanceTimersByTime(20000);
      });
      expect(pollMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
