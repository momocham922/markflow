import { create } from "zustand";
import type { RefineJobView } from "@/services/refine-jobs";

/**
 * Where a document's Refine stands on THIS device.
 * - upload: the recording is being uploaded from this device (must stay open)
 * - transcribe / structure: the server is working (the device may go away)
 * - ready: the result arrived and is waiting to be applied to the open document
 * - review: the document changed since the job started — the user decides
 * - error: the job failed (message set); the user can retry or dismiss
 */
export type RefinePhase =
  "upload" | "transcribe" | "structure" | "ready" | "review" | "error";

export interface RefineDocState {
  jobId: string | null;
  phase: RefinePhase;
  /** A live progress stream to the server is open on this device. */
  attached: boolean;
  startedAt: number;
  job: RefineJobView | null;
  message: string | null;
  /** Identity of the uploaded audio, so a retry can reuse the saved transcript. */
  audioKey: string;
  /** Automatic resumes of an interrupted server run (bounded). */
  resumeTries: number;
}

interface RefineState {
  byDoc: Record<string, RefineDocState>;
  /** One-shot notices for the open document (applied / truncated warning). */
  notice: { docId: string; kind: "applied" | "truncated"; at: number } | null;
  begin: (docId: string, audioKey: string) => void;
  patch: (docId: string, patch: Partial<RefineDocState>) => void;
  clear: (docId: string) => void;
  setNotice: (notice: RefineState["notice"]) => void;
  /** Drop everything (logout / account switch) — jobs hold user content. */
  reset: () => void;
}

const EMPTY: Omit<RefineDocState, "startedAt"> = {
  jobId: null,
  phase: "upload",
  attached: false,
  job: null,
  message: null,
  audioKey: "",
  resumeTries: 0,
};

export const useRefineStore = create<RefineState>((set) => ({
  byDoc: {},
  notice: null,
  begin: (docId, audioKey) =>
    set((s) => ({
      byDoc: {
        ...s.byDoc,
        [docId]: {
          ...EMPTY,
          audioKey,
          attached: true,
          startedAt: Date.now(),
        },
      },
    })),
  patch: (docId, patch) =>
    set((s) => {
      const base = s.byDoc[docId] ?? { ...EMPTY, startedAt: Date.now() };
      return { byDoc: { ...s.byDoc, [docId]: { ...base, ...patch } } };
    }),
  clear: (docId) =>
    set((s) => {
      if (!s.byDoc[docId]) return s;
      const next = { ...s.byDoc };
      delete next[docId];
      return { byDoc: next };
    }),
  setNotice: (notice) => set({ notice }),
  reset: () => set({ byDoc: {}, notice: null }),
}));

/** Phases in which a Refine is in progress (no new Refine / Structure). */
export function isRefineBusy(state: RefineDocState | undefined): boolean {
  return (
    !!state &&
    (state.phase === "upload" ||
      state.phase === "transcribe" ||
      state.phase === "structure" ||
      state.phase === "ready")
  );
}
