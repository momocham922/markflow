import { create } from "zustand";

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
  type: "topic" | "fact-check" | "financial" | "explicit-request" | "internal";
  summary: string;
  sources: ResearchSource[];
  credibility: "academic" | "official" | "news" | "general";
  integrated: boolean;
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

  startSession: () => void;
  endSession: () => void;
  addCard: (card: ResearchCard) => void;
  updateCard: (id: string, updates: Partial<ResearchCard>) => void;
  removeCard: (id: string) => void;
  markIntegrated: (id: string) => void;
  markAllIntegrated: () => void;
  addSearchedTopic: (topic: string) => void;
  togglePanel: () => void;
  clearCards: () => void;
  setAnalyzing: (v: boolean) => void;
  setPoppedOut: (v: boolean) => void;
}

export const useResearchStore = create<ResearchState>((set) => ({
  sessionActive: false,
  cards: [],
  searchedTopics: [],
  panelVisible: true,
  analyzing: false,
  poppedOut: false,

  startSession: () =>
    set({
      sessionActive: true,
      cards: [],
      searchedTopics: [],
      analyzing: false,
    }),
  endSession: () => set({ sessionActive: false }),
  addCard: (card) => set((s) => ({ cards: [...s.cards, card] })),
  updateCard: (id, updates) =>
    set((s) => ({
      cards: s.cards.map((c) => (c.id === id ? { ...c, ...updates } : c)),
    })),
  removeCard: (id) =>
    set((s) => ({ cards: s.cards.filter((c) => c.id !== id) })),
  markIntegrated: (id) =>
    set((s) => ({
      cards: s.cards.map((c) => (c.id === id ? { ...c, integrated: true } : c)),
    })),
  markAllIntegrated: () =>
    set((s) => ({
      cards: s.cards.map((c) => ({ ...c, integrated: true })),
    })),
  addSearchedTopic: (topic) =>
    set((s) => ({ searchedTopics: [...s.searchedTopics, topic] })),
  togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),
  clearCards: () => set({ cards: [], searchedTopics: [] }),
  setAnalyzing: (v) => set({ analyzing: v }),
  setPoppedOut: (v) => set({ poppedOut: v }),
}));
