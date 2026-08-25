import { create } from "zustand";

// =====================================================================
// Feedback dialog UI state.
// ---------------------------------------------------------------------
// A tiny dedicated store so the "問題を報告" dialog can be opened from anywhere
// (the user menu, and — throttled — a captured crash) while being mounted
// exactly once at the app root. The actual submit lives in
// services/feedback.ts; this only holds open/prefill UI state.
// =====================================================================

interface FeedbackUIState {
  open: boolean;
  /** Error text to seed the report with (crash-prefill path); null for a blank report. */
  prefillError: string | null;
  openFeedback: (prefillError?: string | null) => void;
  closeFeedback: () => void;
}

export const useFeedbackStore = create<FeedbackUIState>((set) => ({
  open: false,
  prefillError: null,
  openFeedback: (prefillError = null) => set({ open: true, prefillError }),
  closeFeedback: () => set({ open: false, prefillError: null }),
}));
