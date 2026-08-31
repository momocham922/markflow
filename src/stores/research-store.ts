import { create } from "zustand";

const INCLUDE_KEY = "markflow:research:includeInStructure";
const MOBILE_LIVE_KEY = "markflow:research:mobileLiveResearch";

function loadIncludeInStructure(): boolean {
  try {
    return localStorage.getItem(INCLUDE_KEY) === "true";
  } catch {
    return false;
  }
}

function loadMobileLiveResearch(): boolean {
  try {
    return localStorage.getItem(MOBILE_LIVE_KEY) === "true";
  } catch {
    return false;
  }
}

export interface ResearchSource {
  url: string;
  title: string;
  domain: string;
  snippet?: string;
  credibility: "academic" | "official" | "news" | "general";
}

export interface ResearchCard {
  id: string;
  timestamp: number;
  trigger: string;
  query: string;
  type:
    | "topic"
    | "fact-check"
    | "financial"
    | "explicit-request"
    | "internal"
    | "question";
  summary: string;
  sources: ResearchSource[];
  credibility: "academic" | "official" | "news" | "general";
  /** Woven into the structured document. Shown with a badge — NOT hidden. */
  integrated: boolean;
  /**
   * User queued this card to be woven into the NEXT Structure/Refine run
   * (instead of an immediate insert). Processed and cleared on that run.
   */
  queuedForStructure?: boolean;
  expandable: boolean;
  loading?: boolean;
  error?: string;
}

interface ResearchState {
  sessionActive: boolean;
  cards: ResearchCard[];
  searchedTopics: string[];
  panelVisible: boolean;
  analyzing: boolean;
  /**
   * Last non-quota analysis failure surfaced to the user (e.g. a manual
   * "今すぐ解析" that hit a network/server error). Quota (429) errors are shown
   * by the global upsell banner instead. null = no error. Dismissible.
   */
  analysisError: string | null;
  /**
   * Automatic live research was suppressed by a plan capability gate
   * (MONETIZATION §1.3: auto research is Pro+, Free is manual-only). Set when
   * the client-side gate skips an auto tick OR the server returns
   * FeatureGatedError. Drives a visible "自動リサーチはPro" notice so the gate
   * is never silent (プロジェクト規則: サイレントフォールバック禁止). Reset per session.
   */
  featureGated: boolean;
  poppedOut: boolean;
  /** User choice: weave research findings into the structured document. */
  includeInStructure: boolean;
  /** Mobile: bottom-sheet open/close (transient — not persisted). */
  mobileSheetOpen: boolean;
  /**
   * Mobile: opt-in to automatic live research while recording. Off by default
   * to protect battery/data; persisted. Manual "今すぐ解析" always works.
   */
  mobileLiveResearch: boolean;

  startSession: () => void;
  endSession: () => void;
  /**
   * Replace the current cards with persisted ones loaded from Firestore.
   * Used when a document opens so previously-gathered research reappears.
   * Does NOT touch sessionActive — this is a read-only hydration, not a live session.
   */
  hydrateCards: (cards: ResearchCard[]) => void;
  addCard: (card: ResearchCard) => void;
  updateCard: (id: string, updates: Partial<ResearchCard>) => void;
  removeCard: (id: string) => void;
  markIntegrated: (id: string) => void;
  markAllIntegrated: () => void;
  /** Toggle whether a card is queued for the NEXT Structure/Refine run. */
  toggleQueued: (id: string) => void;
  addSearchedTopic: (topic: string) => void;
  togglePanel: () => void;
  clearCards: () => void;
  setAnalyzing: (v: boolean) => void;
  setAnalysisError: (v: string | null) => void;
  setFeatureGated: (v: boolean) => void;
  setPoppedOut: (v: boolean) => void;
  setIncludeInStructure: (v: boolean) => void;
  setMobileSheetOpen: (v: boolean) => void;
  setMobileLiveResearch: (v: boolean) => void;
  /**
   * Wipe ALL in-memory research state on logout / account switch. `cards` hold
   * research summaries + sources (user content) and would otherwise linger for
   * the NEXT account signing in on the same device. Persisted preferences are
   * re-read from localStorage; on an account switch local-reset clears those
   * keys first, so this resets them to defaults too.
   */
  reset: () => void;
}

export const useResearchStore = create<ResearchState>((set) => ({
  sessionActive: false,
  cards: [],
  searchedTopics: [],
  panelVisible: true,
  analyzing: false,
  analysisError: null,
  featureGated: false,
  poppedOut: false,
  includeInStructure: loadIncludeInStructure(),
  mobileSheetOpen: false,
  mobileLiveResearch: loadMobileLiveResearch(),

  startSession: () =>
    set({
      sessionActive: true,
      cards: [],
      searchedTopics: [],
      analyzing: false,
      analysisError: null,
      featureGated: false,
    }),
  // Clear both transient notices on stop so a stopped session can't leave a
  // stale, undismissable gated chip or error chip mounted while not recording.
  endSession: () =>
    set({ sessionActive: false, featureGated: false, analysisError: null }),
  hydrateCards: (cards) => set({ cards }),
  addCard: (card) => set((s) => ({ cards: [...s.cards, card] })),
  updateCard: (id, updates) =>
    set((s) => ({
      cards: s.cards.map((c) => (c.id === id ? { ...c, ...updates } : c)),
    })),
  removeCard: (id) =>
    set((s) => ({ cards: s.cards.filter((c) => c.id !== id) })),
  markIntegrated: (id) =>
    set((s) => ({
      cards: s.cards.map((c) =>
        c.id === id ? { ...c, integrated: true, queuedForStructure: false } : c,
      ),
    })),
  markAllIntegrated: () =>
    set((s) => ({
      cards: s.cards.map((c) => ({
        ...c,
        integrated: true,
        queuedForStructure: false,
      })),
    })),
  toggleQueued: (id) =>
    set((s) => ({
      cards: s.cards.map((c) =>
        c.id === id ? { ...c, queuedForStructure: !c.queuedForStructure } : c,
      ),
    })),
  addSearchedTopic: (topic) =>
    set((s) => ({ searchedTopics: [...s.searchedTopics, topic] })),
  togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),
  clearCards: () =>
    set({
      cards: [],
      searchedTopics: [],
      analysisError: null,
      featureGated: false,
    }),
  setAnalyzing: (v) => set({ analyzing: v }),
  setAnalysisError: (v) => set({ analysisError: v }),
  setFeatureGated: (v) => set({ featureGated: v }),
  setPoppedOut: (v) => set({ poppedOut: v }),
  setIncludeInStructure: (v) => {
    try {
      localStorage.setItem(INCLUDE_KEY, String(v));
    } catch {
      /* ignore */
    }
    set({ includeInStructure: v });
  },
  setMobileSheetOpen: (v) => set({ mobileSheetOpen: v }),
  setMobileLiveResearch: (v) => {
    try {
      localStorage.setItem(MOBILE_LIVE_KEY, String(v));
    } catch {
      /* ignore */
    }
    // Turning auto OFF is a device opt-out, NOT a plan gate — clear any lingering
    // "auto research is Pro" notice so it doesn't wrongly blame the plan.
    set(
      v
        ? { mobileLiveResearch: v }
        : { mobileLiveResearch: v, featureGated: false },
    );
  },
  reset: () =>
    set({
      sessionActive: false,
      cards: [],
      searchedTopics: [],
      panelVisible: true,
      analyzing: false,
      analysisError: null,
      featureGated: false,
      poppedOut: false,
      mobileSheetOpen: false,
      // Re-read persisted prefs (cleared by local-reset on an account switch).
      includeInStructure: loadIncludeInStructure(),
      mobileLiveResearch: loadMobileLiveResearch(),
    }),
}));
