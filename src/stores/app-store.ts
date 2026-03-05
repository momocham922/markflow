import { create } from "zustand";
import * as db from "@/services/database";

export interface Document {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

interface AppState {
  // UI state
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
  initialized: boolean;

  // Document state
  activeDocId: string | null;
  setActiveDocId: (id: string | null) => void;
  documents: Document[];
  loadDocuments: () => Promise<void>;
  addDocument: (doc: Document) => Promise<void>;
  updateDocument: (id: string, updates: Partial<Document>) => void;
  deleteDocument: (id: string) => Promise<void>;
}

// Debounce save to avoid excessive writes
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Track pending docs for flush-on-exit
const pendingDocs = new Map<string, Document>();

function debouncedSave(doc: Document) {
  const existing = saveTimers.get(doc.id);
  if (existing) clearTimeout(existing);
  pendingDocs.set(doc.id, doc);
  saveTimers.set(
    doc.id,
    setTimeout(async () => {
      try {
        await db.upsertDocument(doc);
      } catch (e) {
        console.error("Local save failed:", e);
      }
      saveTimers.delete(doc.id);
      pendingDocs.delete(doc.id);
      // Trigger cloud sync after local save
      cloudSyncDebounced();
    }, 500),
  );
}

// Debounced cloud sync — don't sync on every keystroke
let cloudSyncTimer: ReturnType<typeof setTimeout> | null = null;
function cloudSyncDebounced() {
  if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    cloudSyncTimer = null;
    // Dynamically import to avoid circular dependency
    import("@/stores/auth-store").then(({ useAuthStore }) => {
      useAuthStore.getState().syncToCloud();
    });
  }, 3000);
}

// Flush all pending saves immediately (called on app close)
function flushPendingSaves() {
  for (const [id, doc] of pendingDocs) {
    const timer = saveTimers.get(id);
    if (timer) clearTimeout(timer);
    saveTimers.delete(id);
    pendingDocs.delete(id);
    db.upsertDocument(doc).catch(console.error);
  }
}

// Save pending changes before window unload
window.addEventListener("beforeunload", flushPendingSaves);

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
      db.setSetting("theme", next).catch(console.error);
      return { theme: next };
    }),

  initialized: false,

  activeDocId: null,
  setActiveDocId: (id) => set({ activeDocId: id }),

  documents: [],

  loadDocuments: async () => {
    try {
      const rows = await db.getAllDocuments();
      const documents: Document[] = rows.map((r) => ({
        id: r.id,
        title: r.title,
        content: r.content,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));

      const savedTheme = await db.getSetting("theme");
      if (savedTheme === "light" || savedTheme === "dark") {
        document.documentElement.classList.toggle(
          "dark",
          savedTheme === "dark",
        );
        set({ documents, theme: savedTheme, initialized: true });
      } else {
        set({ documents, initialized: true });
      }
    } catch {
      // Running in browser without Tauri — skip DB
      set({ initialized: true });
    }
  },

  addDocument: async (doc) => {
    set((s) => ({ documents: [...s.documents, doc] }));
    try {
      await db.upsertDocument(doc);
    } catch {
      // Ignore if no DB
    }
  },

  updateDocument: (id, updates) => {
    set((s) => {
      const documents = s.documents.map((d) =>
        d.id === id ? { ...d, ...updates } : d,
      );
      const updated = documents.find((d) => d.id === id);
      if (updated) debouncedSave(updated);
      return { documents };
    });
  },

  deleteDocument: async (id) => {
    set((s) => ({
      documents: s.documents.filter((d) => d.id !== id),
      activeDocId: s.activeDocId === id ? null : s.activeDocId,
    }));
    try {
      await db.deleteDocument(id);
    } catch {
      // Ignore if no DB
    }
  },
}));
