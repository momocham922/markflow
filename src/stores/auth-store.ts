import { create } from "zustand";
import type { User } from "firebase/auth";
import {
  signInWithGoogle,
  signInWithGitHub,
  signOut,
  onAuthChange,
  fetchUserDocuments,
  fetchDocument,
  createDocumentInFirestore,
  saveDocumentToFirestore,
  deleteDocumentFromFirestore,
  saveUserSettingsToFirestore,
  fetchUserSettings,
} from "@/services/firebase";
import { saveUserProfile, fetchSharedWithMe, fetchUserTeams, fetchTeamDocuments } from "@/services/sharing";
import { notifySlack } from "@/services/slack-notify";
import { useAppStore, type Document, type DocType } from "./app-store";
import { getDeletedDocIds, clearDeletedDoc } from "@/services/database";

// --- Sync mutex: prevents concurrent syncFromCloud / syncToCloud ---
let syncLock = false;
async function withSyncLock<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (syncLock) return undefined;
  syncLock = true;
  try {
    return await fn();
  } finally {
    syncLock = false;
  }
}

// --- Active collab tracking: docs currently being edited via Yjs ---
// Editor sets this so sync knows not to overwrite content
const collabActiveDocIds = new Set<string>();
export function markCollabActive(docId: string) { collabActiveDocIds.add(docId); }
export function markCollabInactive(docId: string) { collabActiveDocIds.delete(docId); }

interface AuthState {
  user: User | null;
  loading: boolean;
  isOnline: boolean;
  syncing: boolean;
  loginError: string | null;
  init: () => () => void;
  login: (provider?: "google" | "github") => Promise<void>;
  logout: () => Promise<void>;
  syncToCloud: () => Promise<void>;
  syncFromCloud: () => Promise<void>;
  deleteFromCloud: (docId: string) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  loading: true,
  isOnline: navigator.onLine,
  syncing: false,
  loginError: null,

  init: () => {
    const unsubAuth = onAuthChange((user) => {
      set({ user, loading: false });
      if (user) {
        // Save user profile for collaborator lookups
        saveUserProfile({
          uid: user.uid,
          email: user.email || "",
          displayName: user.displayName,
        }).catch(() => {});
        // Wait for loadDocuments to complete before syncing from cloud.
        // Without this, syncFromCloud may see default themeSettings and
        // overwrite correct SQLite values with stale cloud values.
        const appState = useAppStore.getState();
        if (appState.initialized) {
          get().syncFromCloud();
        } else {
          const unsub = useAppStore.subscribe((s) => {
            if (s.initialized) {
              unsub();
              get().syncFromCloud();
            }
          });
        }
      }
    });

    const handleOnline = () => {
      set({ isOnline: true });
      if (get().user) get().syncToCloud();
    };
    const handleOffline = () => set({ isOnline: false });

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      unsubAuth();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  },

  login: async (provider = "google") => {
    set({ loginError: null });
    try {
      if (provider === "github") {
        await signInWithGitHub();
      } else {
        await signInWithGoogle();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Login failed:", error);
      set({ loginError: msg });
    }
  },

  logout: async () => {
    try {
      await signOut();
      set({ user: null });
    } catch (error) {
      console.error("Logout failed:", error);
    }
  },

  syncFromCloud: async () => {
    const { user, isOnline } = get();
    if (!user || !isOnline) return;

    const result = await withSyncLock(async () => {
      set({ syncing: true });
      try {
        // Load locally deleted doc IDs to skip during sync
        let deletedDocIds: Set<string>;
        try {
          deletedDocIds = await getDeletedDocIds();
        } catch {
          deletedDocIds = new Set();
        }

        // Parallel fetch: user docs, shared docs, teams, and user settings
        const [cloudDocs, sharedDocs, teams, cloudSettings] = await Promise.all([
          fetchUserDocuments(user.uid),
          fetchSharedWithMe(user.uid).catch((err) => {
            console.error("Fetch shared docs failed:", err);
            return [] as Awaited<ReturnType<typeof fetchSharedWithMe>>;
          }),
          fetchUserTeams(user.uid).catch((err) => {
            console.error("Fetch teams failed:", err);
            return [] as Awaited<ReturnType<typeof fetchUserTeams>>;
          }),
          fetchUserSettings(user.uid).catch(() => null),
        ]);

        // Restore all user settings from cloud
        if (cloudSettings) {
          const appStore = useAppStore.getState();

          // Theme
          if (cloudSettings.theme && typeof cloudSettings.theme === "string") {
            const cloudThemeMode = cloudSettings.theme as "light" | "dark";
            if (appStore.theme !== cloudThemeMode) {
              document.documentElement.classList.toggle("dark", cloudThemeMode === "dark");
              useAppStore.setState({ theme: cloudThemeMode });
            }
          }

          // Theme settings (only if local has defaults)
          const local = appStore.themeSettings;
          const defaults = { previewTheme: "github", editorTheme: "default", mindMapTheme: "lavender", customPreviewCss: "" };
          const isDefault = local.previewTheme === defaults.previewTheme
            && local.editorTheme === defaults.editorTheme
            && local.mindMapTheme === defaults.mindMapTheme;
          if (isDefault && cloudSettings.themeSettings) {
            try {
              const cloudTheme = typeof cloudSettings.themeSettings === "string"
                ? JSON.parse(cloudSettings.themeSettings as string)
                : cloudSettings.themeSettings;
              appStore.setThemeSettings(cloudTheme);
            } catch { /* ignore parse errors */ }
          }

          // Folders
          if (Array.isArray(cloudSettings.folders) && cloudSettings.folders.length > 0) {
            const localFolders = appStore.folders;
            if (localFolders.length <= 1) {
              // Local has only "/" default — restore from cloud
              const restored = ["/", ...cloudSettings.folders.filter((f: unknown) => f !== "/")];
              useAppStore.setState({ folders: restored as string[] });
            }
          }

          // Custom preview themes
          if (Array.isArray(cloudSettings.customPreviewThemes) && cloudSettings.customPreviewThemes.length > 0) {
            if (appStore.customPreviewThemes.length === 0) {
              useAppStore.setState({ customPreviewThemes: cloudSettings.customPreviewThemes as typeof appStore.customPreviewThemes });
            }
          }

          // AI custom rules, MCP servers, Slack config → write to SQLite
          try {
            const { setSetting } = await import("@/services/database");
            if (cloudSettings.ai_custom_rules && typeof cloudSettings.ai_custom_rules === "string") {
              await setSetting("ai_custom_rules", cloudSettings.ai_custom_rules).catch(() => {});
            }
            if (cloudSettings.mcp_servers && typeof cloudSettings.mcp_servers === "string") {
              await setSetting("mcp_servers", cloudSettings.mcp_servers).catch(() => {});
            }
            if (cloudSettings.slack_notify_config && typeof cloudSettings.slack_notify_config === "string") {
              await setSetting("slack_notify_config", cloudSettings.slack_notify_config).catch(() => {});
            }
          } catch { /* DB not available */ }
        }

        const appStore = useAppStore.getState();
        const localDocs = appStore.documents;

        // Claim unclaimed local docs for this user (first login on this device)
        for (const local of localDocs) {
          if (!local.ownerId) {
            appStore.updateDocument(local.id, { ownerId: user.uid });
          }
        }

        // Track all cloud doc IDs for deletion reconciliation
        const cloudDocIds = new Set<string>();

        // Merge user's own cloud docs
        for (const cloudDoc of cloudDocs) {
          if (!cloudDoc.content?.trim()) continue;
          if (deletedDocIds.has(cloudDoc.id)) continue; // skip locally deleted

          cloudDocIds.add(cloudDoc.id);
          const local = localDocs.find((d) => d.id === cloudDoc.id);
          if (!local) {
            const hasCollaborators = cloudDoc.collaborators && Object.keys(cloudDoc.collaborators).length > 0;
            const hasShareLink = cloudDoc.shareLink?.enabled === true;
            const newDoc: Document = {
              id: cloudDoc.id,
              title: cloudDoc.title,
              content: cloudDoc.content,
              createdAt: cloudDoc.createdAt?.toMillis() ?? Date.now(),
              updatedAt: cloudDoc.updatedAt?.toMillis() ?? Date.now(),
              folder: cloudDoc.folder ?? "/",
              tags: cloudDoc.tags ?? [],
              ownerId: user.uid,
              isShared: hasCollaborators || hasShareLink,
              docType: (cloudDoc.docType as DocType) || "markdown",
            };
            await appStore.addDocument(newDoc);
          } else {
            const hasCollaborators = cloudDoc.collaborators && Object.keys(cloudDoc.collaborators).length > 0;
            const hasShareLink = cloudDoc.shareLink?.enabled === true;
            const updates: Partial<Document> = {
              ownerId: user.uid,
              isShared: hasCollaborators || hasShareLink,
            };
            if (cloudDoc.folder && cloudDoc.folder !== "/" && local.folder === "/") {
              updates.folder = cloudDoc.folder;
            }
            appStore.updateDocument(local.id, updates);
          }
        }

        // Process shared docs — batch fetch full docs in parallel
        const sharedToFetch: { id: string; isNew: boolean }[] = [];
        for (const shared of sharedDocs) {
          if (deletedDocIds.has(shared.id)) continue;
          cloudDocIds.add(shared.id);
          const currentDocs = useAppStore.getState().documents;
          const local = currentDocs.find((d) => d.id === shared.id);
          if (local) {
            if (local.ownerId !== user.uid) {
              sharedToFetch.push({ id: shared.id, isNew: false });
            } else {
              appStore.updateDocument(shared.id, { isShared: true });
            }
          } else {
            sharedToFetch.push({ id: shared.id, isNew: true });
          }
        }

        // Fetch all shared docs in parallel (batch of up to 10)
        if (sharedToFetch.length > 0) {
          const batchSize = 10;
          for (let i = 0; i < sharedToFetch.length; i += batchSize) {
            const batch = sharedToFetch.slice(i, i + batchSize);
            const results = await Promise.all(
              batch.map((s) => fetchDocument(s.id).catch(() => null)),
            );
            for (let j = 0; j < batch.length; j++) {
              const fullDoc = results[j];
              const entry = batch[j];
              if (!fullDoc || !fullDoc.content?.trim()) {
                if (!entry.isNew) appStore.updateDocument(entry.id, { isShared: true });
                continue;
              }
              if (entry.isNew) {
                const newDoc: Document = {
                  id: fullDoc.id,
                  title: fullDoc.title,
                  content: fullDoc.content,
                  createdAt: fullDoc.createdAt?.toMillis() ?? Date.now(),
                  updatedAt: fullDoc.updatedAt?.toMillis() ?? Date.now(),
                  folder: fullDoc.folder ?? "/",
                  tags: fullDoc.tags ?? [],
                  ownerId: fullDoc.ownerId,
                  isShared: true,
                  docType: (fullDoc.docType as DocType) || "markdown",
                };
                await appStore.addDocument(newDoc);
              } else {
                // FIX: Skip content update if doc is actively being edited via Yjs
                // Yjs is the source of truth during collaboration — Firestore snapshot is stale
                const updates: Partial<Document> = {
                  isShared: true,
                  titlePinned: true,
                };
                if (!collabActiveDocIds.has(entry.id)) {
                  updates.content = fullDoc.content;
                  updates.title = fullDoc.title;
                  updates.updatedAt = fullDoc.updatedAt?.toMillis() ?? Date.now();
                }
                appStore.updateDocument(entry.id, updates);
              }
            }
          }
        }

        // Fetch all team docs in parallel
        const teamDocBatches = await Promise.all(
          teams.map((team) =>
            fetchTeamDocuments(team.id)
              .then((docs) => docs.map((d) => ({ ...d, teamId: team.id })))
              .catch(() => [] as { id: string; teamId: string }[]),
          ),
        );
        const teamDocsToFetch: { id: string; teamId: string; isNew: boolean }[] = [];
        for (const teamDocs of teamDocBatches) {
          for (const td of teamDocs) {
            if (deletedDocIds.has(td.id)) continue;
            cloudDocIds.add(td.id);
            const currentDocs = useAppStore.getState().documents;
            const local = currentDocs.find((d) => d.id === td.id);
            if (local) {
              if (local.ownerId !== user.uid) {
                teamDocsToFetch.push({ id: td.id, teamId: td.teamId, isNew: false });
              } else {
                appStore.updateDocument(td.id, { isShared: true, teamId: td.teamId });
              }
            } else {
              teamDocsToFetch.push({ id: td.id, teamId: td.teamId, isNew: true });
            }
          }
        }

        // Batch fetch team docs in parallel
        if (teamDocsToFetch.length > 0) {
          const batchSize = 10;
          for (let i = 0; i < teamDocsToFetch.length; i += batchSize) {
            const batch = teamDocsToFetch.slice(i, i + batchSize);
            const results = await Promise.all(
              batch.map((t) => fetchDocument(t.id).catch(() => null)),
            );
            for (let j = 0; j < batch.length; j++) {
              const fullDoc = results[j];
              const entry = batch[j];
              if (!fullDoc || !fullDoc.content?.trim()) {
                if (!entry.isNew) appStore.updateDocument(entry.id, { isShared: true, teamId: entry.teamId });
                continue;
              }
              if (entry.isNew) {
                const newDoc: Document = {
                  id: fullDoc.id,
                  title: fullDoc.title,
                  content: fullDoc.content,
                  createdAt: fullDoc.createdAt?.toMillis() ?? Date.now(),
                  updatedAt: fullDoc.updatedAt?.toMillis() ?? Date.now(),
                  folder: fullDoc.folder ?? "/",
                  tags: fullDoc.tags ?? [],
                  ownerId: fullDoc.ownerId,
                  teamId: entry.teamId,
                  isShared: true,
                  docType: (fullDoc.docType as DocType) || "markdown",
                };
                await appStore.addDocument(newDoc);
              } else {
                // FIX: Skip content update if doc is actively being edited via Yjs
                const updates: Partial<Document> = {
                  isShared: true,
                  teamId: entry.teamId,
                  titlePinned: true,
                };
                if (!collabActiveDocIds.has(entry.id)) {
                  updates.content = fullDoc.content;
                  updates.title = fullDoc.title;
                  updates.updatedAt = fullDoc.updatedAt?.toMillis() ?? Date.now();
                }
                appStore.updateDocument(entry.id, updates);
              }
            }
          }
        }

        // Reconcile deletions: remove local shared/team docs that no longer exist in cloud.
        // Only remove docs NOT owned by the current user (owned docs are source of truth locally).
        // FIX: Also skip docs being actively edited (Yjs may not have synced to Firestore yet)
        const finalDocs = useAppStore.getState().documents;
        for (const local of finalDocs) {
          if (local.ownerId === user.uid) continue; // never delete own docs
          if (!local.isShared && !local.teamId) continue; // only shared/team docs
          if (collabActiveDocIds.has(local.id)) continue; // skip actively edited docs
          if (!cloudDocIds.has(local.id)) {
            console.warn(`[sync] Removing locally-cached doc ${local.id} (deleted from cloud)`);
            await appStore.deleteDocument(local.id);
          }
        }
      } catch (error) {
        console.error("Sync from cloud failed:", error);
      } finally {
        set({ syncing: false });
      }
    });
    // result is undefined if lock was held — that's fine, next sync will catch up
    void result;
  },

  deleteFromCloud: async (docId: string) => {
    const { user, isOnline } = get();
    if (!user || !isOnline) return;
    try {
      await deleteDocumentFromFirestore(docId);
      // Cloud deletion succeeded — clear from tracking table
      await clearDeletedDoc(docId);
    } catch (error) {
      console.error("Failed to delete from cloud:", error);
      // Will be retried during next syncToCloud
    }
  },

  syncToCloud: async () => {
    const { user, isOnline } = get();
    if (!user || !isOnline) return;

    await withSyncLock(async () => {
      set({ syncing: true });
      try {
        const appState = useAppStore.getState();
        const { documents } = appState;

        // Sync all user settings to cloud after loadDocuments has completed,
        // otherwise we'd save default values and overwrite correct cloud data.
        if (appState.initialized) {
          const settingsToSync: Record<string, unknown> = {
            theme: appState.theme,
            themeSettings: appState.themeSettings,
            folders: appState.folders.filter((f) => f !== "/"),
            customPreviewThemes: appState.customPreviewThemes,
          };
          // Include AI custom rules, MCP servers, Slack config from SQLite
          try {
            const { getSetting } = await import("@/services/database");
            const [aiRules, mcpServers, slackConfig] = await Promise.all([
              getSetting("ai_custom_rules").catch(() => null),
              getSetting("mcp_servers").catch(() => null),
              getSetting("slack_notify_config").catch(() => null),
            ]);
            if (aiRules) settingsToSync.ai_custom_rules = aiRules;
            if (mcpServers) settingsToSync.mcp_servers = mcpServers;
            if (slackConfig) settingsToSync.slack_notify_config = slackConfig;
          } catch { /* DB not available */ }
          saveUserSettingsToFirestore(user.uid, settingsToSync)
            .catch((err) => console.error("Failed to sync settings:", err));
        }

        // Retry pending cloud deletions
        try {
          const deletedIds = await getDeletedDocIds();
          for (const docId of deletedIds) {
            // Only retry if doc is not in local store (actually deleted)
            if (!documents.find((d) => d.id === docId)) {
              try {
                await deleteDocumentFromFirestore(docId);
                await clearDeletedDoc(docId);
              } catch {
                // Will retry next sync
              }
            }
          }
        } catch { /* ignore */ }

        // FIX: Only sync docs owned by this user. Non-owners should NEVER write
        // document content to Firestore — Yjs handles real-time sync for shared docs,
        // and non-owner writes can overwrite the owner's latest version.
        const syncableDocs = documents.filter(
          (d) => d.content.trim() && (!d.ownerId || d.ownerId === user.uid),
        );
        for (const d of syncableDocs) {
          const payload = {
            id: d.id,
            title: d.title,
            content: d.content,
            ownerId: d.ownerId || user.uid,
            folder: d.folder,
            tags: d.tags,
            docType: d.docType,
          };
          try {
            await saveDocumentToFirestore(payload);
          } catch (saveErr) {
            // FIX: Only fall back to create for genuinely new docs (not yet in Firestore).
            // Check if doc exists before creating — createDocumentInFirestore wipes
            // collaborators/shareLink because it uses setDoc without merge.
            try {
              const existing = await fetchDocument(d.id);
              if (!existing) {
                await createDocumentInFirestore(payload);
              } else {
                console.error(`Failed to save existing document ${d.id}:`, saveErr);
              }
            } catch (createErr) {
              console.error(`Failed to sync document ${d.id}:`, saveErr, createErr);
            }
          }
        }
        // Notify Slack about edits (once per sync, not per doc)
        if (syncableDocs.length > 0) {
          const titles = syncableDocs.slice(0, 3).map((d) => d.title).join(", ");
          const extra = syncableDocs.length > 3 ? ` +${syncableDocs.length - 3} more` : "";
          notifySlack("edit", {
            docTitle: titles + extra,
            authorName: user.displayName || user.email || undefined,
            detail: `${syncableDocs.length} document(s) synced to cloud`,
          }).catch(() => {});
        }
      } catch (error) {
        console.error("Sync to cloud failed:", error);
      } finally {
        set({ syncing: false });
      }
    });
  },
}));
