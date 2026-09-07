import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore, type Document } from "./app-store";

// Regression guard for voice-metadata loss (reported 2026-09-07: "the Refine
// button AND the transcript mysteriously disappeared"). A successful Refine —
// and any passive re-render — must NOT null a saved transcript / GCS archive
// reference. updateDocument drops a null/empty voice value over an existing
// non-empty one UNLESS the caller passes the explicit __voiceClear intent flag
// (the "Clear transcript" button / starting a fresh recording).

function doc(id: string, extra: Partial<Document> = {}): Document {
  return {
    id,
    title: `t-${id}`,
    content: "hello",
    createdAt: 1,
    updatedAt: 1,
    folder: "/",
    tags: [],
    ownerId: "userA",
    ...extra,
  };
}

describe("updateDocument voice-metadata loss guard", () => {
  beforeEach(() => {
    useAppStore.setState({ documents: [], activeDocId: null });
  });

  it("does NOT null a saved transcript/gcsUri on an accidental null update", () => {
    useAppStore.setState({
      documents: [
        doc("d1", {
          voiceTranscript: "meeting notes",
          voiceGcsUri: "gs://bucket/audio/d1.wav",
          voiceRecordedAt: 1000,
        }),
      ],
    });
    // Simulates the old Refine-success / passive-render null-emit.
    useAppStore.getState().updateDocument("d1", {
      voiceTranscript: null,
      voiceGcsUri: null,
      voiceRecordedAt: null,
    });
    const d = useAppStore.getState().documents.find((x) => x.id === "d1")!;
    expect(d.voiceTranscript).toBe("meeting notes");
    expect(d.voiceGcsUri).toBe("gs://bucket/audio/d1.wav");
  });

  it("DOES clear voice fields when __voiceClear intent is set (Clear button)", () => {
    useAppStore.setState({
      documents: [
        doc("d1", {
          voiceTranscript: "meeting notes",
          voiceGcsUri: "gs://bucket/audio/d1.wav",
          voiceRecordedAt: 1000,
        }),
      ],
    });
    useAppStore.getState().updateDocument("d1", {
      voiceTranscript: null,
      voiceGcsUri: null,
      voiceRecordedAt: null,
      __voiceClear: true,
    });
    const d = useAppStore.getState().documents.find((x) => x.id === "d1")!;
    expect(d.voiceTranscript).toBeNull();
    expect(d.voiceGcsUri).toBeNull();
  });

  it("persists a non-empty transcript (Refine writes the diarized transcript)", () => {
    useAppStore.setState({
      documents: [doc("d1", { voiceTranscript: "old live transcript" })],
    });
    useAppStore.getState().updateDocument("d1", {
      voiceTranscript: "full batch-diarized transcript",
    });
    const d = useAppStore.getState().documents.find((x) => x.id === "d1")!;
    expect(d.voiceTranscript).toBe("full batch-diarized transcript");
  });

  it("never persists the internal __voiceClear flag onto the document", () => {
    useAppStore.setState({ documents: [doc("d1")] });
    useAppStore
      .getState()
      .updateDocument("d1", { voiceTranscript: "x", __voiceClear: true });
    const d = useAppStore.getState().documents.find((x) => x.id === "d1")!;
    expect("__voiceClear" in d).toBe(false);
  });

  it("does not interfere with a plain content edit (no voice keys present)", () => {
    useAppStore.setState({
      documents: [doc("d1", { voiceTranscript: "keep me" })],
    });
    useAppStore
      .getState()
      .updateDocument("d1", { content: "new body", updatedAt: 2 });
    const d = useAppStore.getState().documents.find((x) => x.id === "d1")!;
    expect(d.content).toBe("new body");
    expect(d.voiceTranscript).toBe("keep me");
  });

  it("allows setting voice fields on a doc that had none (first recording)", () => {
    useAppStore.setState({ documents: [doc("d1")] });
    useAppStore.getState().updateDocument("d1", {
      voiceGcsUri: "gs://bucket/audio/d1.wav",
      voiceRecordedAt: 5,
    });
    const d = useAppStore.getState().documents.find((x) => x.id === "d1")!;
    expect(d.voiceGcsUri).toBe("gs://bucket/audio/d1.wav");
  });
});
