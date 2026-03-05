import { create } from "zustand";

export interface Document {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

interface AppState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
  activeDocId: string | null;
  setActiveDocId: (id: string | null) => void;
  documents: Document[];
  addDocument: (doc: Document) => void;
  updateDocument: (id: string, updates: Partial<Document>) => void;
  deleteDocument: (id: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  theme: (window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light") as "light" | "dark",
  toggleTheme: () =>
    set((s) => {
      const next = s.theme === "light" ? "dark" : "light";
      document.documentElement.classList.toggle("dark", next === "dark");
      return { theme: next };
    }),

  activeDocId: null,
  setActiveDocId: (id) => set({ activeDocId: id }),

  documents: [],
  addDocument: (doc) =>
    set((s) => ({ documents: [...s.documents, doc] })),
  updateDocument: (id, updates) =>
    set((s) => ({
      documents: s.documents.map((d) =>
        d.id === id ? { ...d, ...updates } : d,
      ),
    })),
  deleteDocument: (id) =>
    set((s) => ({
      documents: s.documents.filter((d) => d.id !== id),
      activeDocId: s.activeDocId === id ? null : s.activeDocId,
    })),
}));
