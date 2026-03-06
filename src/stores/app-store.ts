import { create } from "zustand";
import * as db from "@/services/database";

export interface Document {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  folder: string;
  tags: string[];
  ownerId: string | null;
  teamId?: string | null;
}

export interface ThemeSettings {
  previewTheme: string;
  editorTheme: string;
  customPreviewCss: string;
}

const defaultThemeSettings: ThemeSettings = {
  previewTheme: "github",
  editorTheme: "default",
  customPreviewCss: "",
};

interface AppState {
  // UI state
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
  initialized: boolean;

  // Theme customization
  themeSettings: ThemeSettings;
  setThemeSettings: (settings: Partial<ThemeSettings>) => void;

  // Document state
  activeDocId: string | null;
  setActiveDocId: (id: string | null) => void;
  documents: Document[];
  loadDocuments: () => Promise<void>;
  addDocument: (doc: Document) => Promise<void>;
  updateDocument: (id: string, updates: Partial<Document>) => void;
  deleteDocument: (id: string) => Promise<void>;

  // Folder management
  folders: string[];
  createFolder: (path: string) => void;
  deleteFolder: (path: string) => void;
  moveDocument: (docId: string, folder: string) => void;
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

/** Extract unique folder paths from documents + persisted folders */
function deriveFolders(documents: Document[], extra: string[]): string[] {
  const set = new Set<string>(["/", ...extra]);
  for (const doc of documents) {
    if (doc.folder && doc.folder !== "/") set.add(doc.folder);
  }
  return [...set].sort();
}

export const useAppStore = create<AppState>((set, get) => ({
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

  themeSettings: { ...defaultThemeSettings },
  setThemeSettings: (updates) =>
    set((s) => {
      const themeSettings = { ...s.themeSettings, ...updates };
      db.setSetting("themeSettings", JSON.stringify(themeSettings)).catch(
        console.error,
      );
      return { themeSettings };
    }),

  initialized: false,

  activeDocId: null,
  setActiveDocId: (id) => set({ activeDocId: id }),

  documents: [],
  folders: ["/"],

  loadDocuments: async () => {
    try {
      const rows = await db.getAllDocuments();
      const documents: Document[] = rows.map((r) => {
        let tags: string[] = [];
        try { tags = JSON.parse(r.tags || "[]"); } catch { /* ignore */ }
        return {
          id: r.id,
          title: r.title,
          content: r.content,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          folder: r.folder || "/",
          tags,
          ownerId: r.owner_id ?? null,
        };
      });

      const savedTheme = await db.getSetting("theme");
      const savedThemeSettings = await db.getSetting("themeSettings");
      let themeSettings = { ...defaultThemeSettings };
      if (savedThemeSettings) {
        try {
          themeSettings = { ...defaultThemeSettings, ...JSON.parse(savedThemeSettings) };
        } catch { /* ignore */ }
      }

      // Load persisted empty folders
      let extraFolders: string[] = [];
      const savedFolders = await db.getSetting("folders");
      if (savedFolders) {
        try { extraFolders = JSON.parse(savedFolders); } catch { /* ignore */ }
      }

      const folders = deriveFolders(documents, extraFolders);

      if (savedTheme === "light" || savedTheme === "dark") {
        document.documentElement.classList.toggle(
          "dark",
          savedTheme === "dark",
        );
        set({ documents, folders, theme: savedTheme, themeSettings, initialized: true });
      } else {
        set({ documents, folders, themeSettings, initialized: true });
      }
    } catch {
      // Running in browser without Tauri — skip DB
      set({ initialized: true });
    }
  },

  addDocument: async (doc) => {
    set((s) => ({
      documents: [...s.documents, doc],
      folders: deriveFolders([...s.documents, doc], s.folders),
    }));
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
    // Cancel any pending save for this doc
    const timer = saveTimers.get(id);
    if (timer) clearTimeout(timer);
    saveTimers.delete(id);
    pendingDocs.delete(id);

    set((s) => ({
      documents: s.documents.filter((d) => d.id !== id),
      activeDocId: s.activeDocId === id ? null : s.activeDocId,
    }));
    try {
      await db.deleteDocument(id);
    } catch {
      // Ignore if no DB
    }
    // Also delete from cloud
    import("@/stores/auth-store").then(({ useAuthStore }) => {
      useAuthStore.getState().deleteFromCloud(id);
    }).catch(() => {})
  },

  createFolder: (path) => {
    set((s) => {
      const folders = deriveFolders(s.documents, [...s.folders, path]);
      const toSave = folders.filter((f) => f !== "/");
      db.setSetting("folders", JSON.stringify(toSave))
        .catch(() => {});
      return { folders };
    });
  },

  deleteFolder: (path) => {
    // Move all docs in this folder to parent
    const parent = path.replace(/\/[^/]+$/, "") || "/";
    set((s) => {
      const documents = s.documents.map((d) =>
        d.folder === path || d.folder.startsWith(path + "/")
          ? { ...d, folder: parent }
          : d,
      );
      const folders = s.folders.filter(
        (f) => f !== path && !f.startsWith(path + "/"),
      );
      // Save moved docs
      for (const doc of documents) {
        if (doc.folder === parent) debouncedSave(doc);
      }
      db.setSetting("folders", JSON.stringify(folders.filter((f) => f !== "/"))).catch(console.error);
      return { documents, folders };
    });
  },

  moveDocument: (docId, folder) => {
    const { updateDocument } = get();
    updateDocument(docId, { folder, updatedAt: Date.now() });
  },
}));
