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
  setPoppedOut: (v: boolean) => void;
  setIncludeInStructure: (v: boolean) => void;
  setMobileSheetOpen: (v: boolean) => void;
  setMobileLiveResearch: (v: boolean) => void;
}

export const useResearchStore = create<ResearchState>((set) => ({
  sessionActive: false,
  cards: [],
  searchedTopics: [],
  panelVisible: true,
  analyzing: false,
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
    }),
  endSession: () => set({ sessionActive: false }),
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
  clearCards: () => set({ cards: [], searchedTopics: [] }),
  setAnalyzing: (v) => set({ analyzing: v }),
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
    set({ mobileLiveResearch: v });
  },
}));
