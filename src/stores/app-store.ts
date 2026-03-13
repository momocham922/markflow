import { create } from "zustand";
import * as db from "@/services/database";
import { fetchDocument } from "@/services/firebase";

export type DocType = "markdown" | "mindmap";

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
  isShared?: boolean;
  titlePinned?: boolean;
  docType?: DocType;
}

export interface CustomPreviewTheme {
  id: string;
  name: string;
  variables: Record<string, string>;
  dark?: Record<string, string>;
}

export interface ThemeSettings {
  previewTheme: string;
  editorTheme: string;
  mindMapTheme: string;
  customPreviewCss: string;
}

const defaultThemeSettings: ThemeSettings = {
  previewTheme: "github",
  editorTheme: "default",
  mindMapTheme: "lavender",
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

  // Custom themes
  customPreviewThemes: CustomPreviewTheme[];
  addCustomPreviewTheme: (theme: CustomPreviewTheme) => void;
  removeCustomPreviewTheme: (id: string) => void;
}

// Debounce save to avoid excessive writes
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Track pending docs for flush-on-exit
const pendingDocs = new Map<string, Document>();

function debouncedSave(doc: Document) {
  // Never persist a document with empty content — this is almost always a bug
  if (!doc.content.trim()) {
    console.warn(`[app-store] Skipped saving doc ${doc.id} with empty content`);
    return;
  }

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
export function flushPendingSaves() {
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
    if (doc.folder && doc.folder !== "/" && !doc.teamId) set.add(doc.folder);
  }
  return [...set].sort();
}

/**
 * Cloud recovery for documents that have empty content and no local backup.
 * Waits for auth, then tries to fetch content from Firestore.
 */
function scheduleCloudRecovery(docIds: string[]) {
  // Retry with backoff until auth is ready
  let attempts = 0;
  const tryRecover = async () => {
    attempts++;
    if (attempts > 10) return; // give up after ~30s

    // Dynamic import to avoid circular dep
    const { useAuthStore } = await import("@/stores/auth-store");
    const user = useAuthStore.getState().user;
    if (!user) {
      setTimeout(tryRecover, 3000);
      return;
    }

    for (const docId of docIds) {
      try {
        const cloudDoc = await fetchDocument(docId);
        if (cloudDoc?.content?.trim()) {
          console.warn(`[app-store] Recovered doc ${docId} from cloud`);
          const appStore = useAppStore.getState();
          appStore.updateDocument(docId, {
            content: cloudDoc.content,
            title: cloudDoc.title || undefined,
            updatedAt: Date.now(),
          });
        }
      } catch (e) {
        console.error(`[app-store] Cloud recovery failed for ${docId}:`, e);
      }
    }
  };
  setTimeout(tryRecover, 2000);
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
      const json = JSON.stringify(themeSettings);
      // Primary: SQLite
      db.setSetting("themeSettings", json).catch((e) =>
        console.error("[app-store] SQLite theme save failed:", e),
      );
      // Backup: localStorage (always works in WebView)
      try { localStorage.setItem("markflow:themeSettings", json); } catch {}
      return { themeSettings };
    }),

  initialized: false,

  activeDocId: null,
  setActiveDocId: (id) => set({ activeDocId: id }),

  documents: [],
  folders: ["/"],
  customPreviewThemes: [],

  loadDocuments: async () => {
    try {
      const rows = await db.getAllDocuments();
      const documents: Document[] = [];
      const docsNeedingCloudRecovery: string[] = [];

      for (const r of rows) {
        let tags: string[] = [];
        try { tags = JSON.parse(r.tags || "[]"); } catch { /* ignore */ }
        let content = r.content;
        let title = r.title;

        // LAYER 3: Recovery cascade for empty content
        if (!content.trim()) {
          const recovered = await db.recoverContent(r.id);
          if (recovered) {
            content = recovered.content;
            title = recovered.title || r.title;
            console.warn(`[app-store] Recovered doc ${r.id} from ${recovered.source}`);
            // Persist the recovery back to documents table
            db.upsertDocument({
              id: r.id, title, content,
              createdAt: r.created_at, updatedAt: Date.now(),
              folder: r.folder || "/", tags: JSON.parse(r.tags || "[]"),
              ownerId: r.owner_id ?? null, isShared: r.is_shared === 1,
              titlePinned: r.title_pinned === 1,
              docType: (r.doc_type as DocType) || "markdown",
            }).catch(console.error);
          } else {
            // No local recovery possible — try cloud after auth init
            docsNeedingCloudRecovery.push(r.id);
          }
        }

        documents.push({
          id: r.id,
          title,
          content,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          folder: r.folder || "/",
          tags,
          ownerId: r.owner_id ?? null,
          isShared: r.is_shared === 1,
          titlePinned: r.title_pinned === 1,
          docType: (r.doc_type as DocType) || "markdown",
        });
      }

      // Schedule cloud recovery for docs that couldn't be recovered locally
      if (docsNeedingCloudRecovery.length > 0) {
        scheduleCloudRecovery(docsNeedingCloudRecovery);
      }

      const savedTheme = await db.getSetting("theme");
      // Load theme settings: SQLite primary, localStorage fallback
      let savedThemeSettings = await db.getSetting("themeSettings");
      if (!savedThemeSettings) {
        try { savedThemeSettings = localStorage.getItem("markflow:themeSettings"); } catch {}
      }
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

      // Load custom preview themes
      let customPreviewThemes: CustomPreviewTheme[] = [];
      const savedCustomThemes = await db.getSetting("customPreviewThemes");
      if (savedCustomThemes) {
        try { customPreviewThemes = JSON.parse(savedCustomThemes); } catch { /* ignore */ }
      }

      if (savedTheme === "light" || savedTheme === "dark") {
        document.documentElement.classList.toggle(
          "dark",
          savedTheme === "dark",
        );
        set({ documents, folders, theme: savedTheme, themeSettings, customPreviewThemes, initialized: true });
      } else {
        set({ documents, folders, themeSettings, customPreviewThemes, initialized: true });
      }
    } catch {
      // Running in browser without Tauri — skip DB, but still restore themes from localStorage
      let themeSettings = { ...defaultThemeSettings };
      try {
        const lsTheme = localStorage.getItem("markflow:themeSettings");
        if (lsTheme) themeSettings = { ...defaultThemeSettings, ...JSON.parse(lsTheme) };
      } catch {}
      set({ themeSettings, initialized: true });
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
      const existing = s.documents.find((d) => d.id === id);
      if (!existing) return {};

      // CRITICAL: Never overwrite non-empty content with empty content.
      // This prevents data loss from Yjs reconnect, CodeMirror remount,
      // cloud sync race conditions, etc.
      let safeUpdates = updates;
      if (
        "content" in updates &&
        !updates.content?.trim() &&
        existing.content.trim()
      ) {
        // Strip the empty content from the update — keep everything else
        const { content: _dropped, ...rest } = updates;
        safeUpdates = rest;
        console.warn(`[app-store] Blocked empty content overwrite for doc ${id}`);
      }

      if (Object.keys(safeUpdates).length === 0) return {};

      const documents = s.documents.map((d) =>
        d.id === id ? { ...d, ...safeUpdates } : d,
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
      // Track deletion so syncFromCloud won't re-add this doc
      await db.trackDeletedDoc(id);
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
    const { deleteDocument } = get();
    const state = get();

    // Delete all documents inside this folder (and subfolders)
    const docsToDelete = state.documents.filter(
      (d) => d.folder === path || d.folder.startsWith(path + "/"),
    );
    for (const doc of docsToDelete) {
      deleteDocument(doc.id);
    }

    // Remove the folder and its subfolders
    set((s) => {
      const folders = s.folders.filter(
        (f) => f !== path && !f.startsWith(path + "/"),
      );
      db.setSetting("folders", JSON.stringify(folders.filter((f) => f !== "/"))).catch(console.error);
      return { folders };
    });
  },

  moveDocument: (docId, folder) => {
    const { updateDocument } = get();
    updateDocument(docId, { folder, updatedAt: Date.now() });
  },

  addCustomPreviewTheme: (theme) => {
    set((s) => {
      const customPreviewThemes = [...s.customPreviewThemes.filter((t) => t.id !== theme.id), theme];
      db.setSetting("customPreviewThemes", JSON.stringify(customPreviewThemes)).catch(console.error);
      return { customPreviewThemes };
    });
  },

  removeCustomPreviewTheme: (id) => {
    set((s) => {
      const customPreviewThemes = s.customPreviewThemes.filter((t) => t.id !== id);
      db.setSetting("customPreviewThemes", JSON.stringify(customPreviewThemes)).catch(console.error);
      // Reset to default if the removed theme was active
      if (s.themeSettings.previewTheme === id) {
        const themeSettings = { ...s.themeSettings, previewTheme: "github" };
        db.setSetting("themeSettings", JSON.stringify(themeSettings)).catch(console.error);
        return { customPreviewThemes, themeSettings };
      }
      return { customPreviewThemes };
    });
  },
}));
