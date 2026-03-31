import { create } from "zustand";
import type { User } from "firebase/auth";
import {
  signInWithGoogle,
  signInWithGitHub,
  signOut,
  onAuthChange,
  fetchUserDocuments,
  fetchDocument,
  saveDocumentToFirestore,
  saveDocumentMerge,
  deleteDocumentFromFirestore,
  saveUserSettingsToFirestore,
  fetchUserSettings,
} from "@/services/firebase";
import { saveUserProfile, fetchSharedWithMe, fetchUserTeams, fetchTeamDocuments } from "@/services/sharing";
import { useAppStore, type Document, type DocType } from "./app-store";
import { getDeletedDocIds, clearDeletedDoc } from "@/services/database";

// --- One-time backfill: upload local SQLite versions to Firestore ---
let versionBackfillDone = false;
async function backfillLocalVersionsToCloud(uid: string, displayName: string) {
  if (versionBackfillDone) return;
  versionBackfillDone = true;

  try {
    const { getSetting, setSetting, getAllVersions } = await import("@/services/database");
    const flag = await getSetting("versions_backfill_v2_done");
    if (flag === "1") return;

    const allVersions = await getAllVersions();
    if (allVersions.length === 0) {
      await setSetting("versions_backfill_v2_done", "1");
      return;
    }

    const { syncVersionToCloud, fetchVersionsFromCloud, logErrorToCloud } = await import("@/services/firebase");

    // Collect existing cloud version IDs per document to avoid overwriting
    // other users' ownerId/ownerName with the backfilling user's info
    const docIds = [...new Set(allVersions.map((v) => v.document_id))];
    const existingCloudIds = new Set<string>();
    for (const did of docIds) {
      try {
        const cloudVersions = await fetchVersionsFromCloud(did);
        for (const cv of cloudVersions) existingCloudIds.add(cv.id);
      } catch (e) {
        console.warn("[backfill] Failed to fetch cloud versions for doc", did, e);
      }
    }

    let uploaded = 0;
    for (const v of allVersions) {
      if (!v.content?.trim()) continue;
      // Skip versions already in Firestore to preserve original author info
      if (existingCloudIds.has(v.id)) continue;
      try {
        await syncVersionToCloud(
          v.document_id,
          {
            id: v.id,
            content: v.content,
            title: v.title,
            message: v.message,
            createdAt: v.created_at,
          },
          uid,
          displayName,
        );
        uploaded++;
      } catch (e) {
        console.error("[backfill] Failed to upload version", v.id, "for doc", v.document_id, e);
        logErrorToCloud(uid, "backfill-version-upload", e, { versionId: v.id, docId: v.document_id });
      }
    }
    console.log(`[auth-store] Backfilled ${uploaded}/${allVersions.length} local versions to Firestore`);
    await setSetting("versions_backfill_v2_done", "1");
  } catch (e) {
    console.error("[auth-store] Version backfill failed:", e);
    // Allow retry on next startup
    versionBackfillDone = false;
  }
}

// --- Sync mutex: prevents concurrent syncFromCloud / syncToCloud ---
let syncLock = false;
async function withSyncLock<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (syncLock) {
    // Retry once after a short wait instead of silently dropping
    await new Promise((r) => setTimeout(r, 2000));
    if (syncLock) return undefined;
  }
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

// --- Track docs pulled from cloud during syncFromCloud ---
// Prevents syncToCloud from re-uploading docs that were just downloaded
const cloudPulledDocIds = new Set<string>();
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
  resetCloudAndReSync: () => Promise<void>;
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
        const syncThenBackfill = async () => {
          await get().syncFromCloud();
          await get().syncToCloud();
          // Update lastSyncAt AFTER both steps complete
          try {
            const { setSetting } = await import("@/services/database");
            await setSetting("lastSyncAt", String(Date.now()));
          } catch { /* ignore */ }
          cloudPulledDocIds.clear();
          // Backfill local versions to Firestore (one-time, background)
          backfillLocalVersionsToCloud(
            user.uid,
            user.displayName || user.email || "Unknown",
          ).catch(() => {});
        };
        const appState = useAppStore.getState();
        if (appState.initialized) {
          syncThenBackfill();
        } else {
          const unsub = useAppStore.subscribe((s) => {
            if (s.initialized) {
              unsub();
              syncThenBackfill();
            }
          });
        }
      }
    });

    const handleOnline = async () => {
      set({ isOnline: true });
      if (get().user) {
        await get().syncFromCloud();
        await get().syncToCloud();
        try {
          const { setSetting } = await import("@/services/database");
          await setSetting("lastSyncAt", String(Date.now()));
        } catch { /* ignore */ }
        cloudPulledDocIds.clear();
      }
    };
    const handleOffline = () => set({ isOnline: false });

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Periodic bidirectional sync every 60s — pull then push
    const syncInterval = setInterval(async () => {
      const { user, isOnline, syncing } = get();
      if (user && isOnline && !syncing) {
        await get().syncFromCloud();
        await get().syncToCloud();
        try {
          const { setSetting } = await import("@/services/database");
          await setSetting("lastSyncAt", String(Date.now()));
        } catch { /* ignore */ }
        cloudPulledDocIds.clear();
      }
    }, 60_000);

    return () => {
      unsubAuth();
      clearInterval(syncInterval);
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

        // Load last successful sync timestamp (0 = first sync ever)
        let lastSyncAt = 0;
        try {
          const { getSetting } = await import("@/services/database");
          const saved = await getSetting("lastSyncAt");
          if (saved) lastSyncAt = parseInt(saved, 10) || 0;
        } catch { /* DB not available */ }

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
            cloudPulledDocIds.add(cloudDoc.id);
          } else {
            const hasCollaborators = cloudDoc.collaborators && Object.keys(cloudDoc.collaborators).length > 0;
            const hasShareLink = cloudDoc.shareLink?.enabled === true;
            const cloudUpdatedAt = cloudDoc.updatedAt?.toMillis() ?? 0;
            const updates: Partial<Document> = {
              ownerId: user.uid,
              isShared: hasCollaborators || hasShareLink,
            };
            if (cloudDoc.folder && cloudDoc.folder !== "/" && local.folder === "/") {
              updates.folder = cloudDoc.folder;
            }
            // Sync content/title from cloud if cloud version is newer
            if (cloudUpdatedAt > local.updatedAt && !collabActiveDocIds.has(local.id)) {
              if (cloudDoc.content?.trim()) {
                updates.content = cloudDoc.content;
              }
              updates.title = cloudDoc.title;
              updates.updatedAt = cloudUpdatedAt;
              updates.folder = cloudDoc.folder ?? local.folder;
              updates.tags = cloudDoc.tags ?? local.tags;
              updates.docType = (cloudDoc.docType as DocType) || local.docType;
              // Mark as pulled from cloud — don't re-upload in syncToCloud
              cloudPulledDocIds.add(local.id);
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
                  ownerName: fullDoc.ownerName,
                  isShared: true,
                  docType: (fullDoc.docType as DocType) || "markdown",
                };
                await appStore.addDocument(newDoc);
              } else {
                // Non-owned shared docs: Yjs/IndexedDB is source of truth for content.
                // Only update content if cloud version is genuinely newer.
                const localDoc = useAppStore.getState().documents.find((d) => d.id === entry.id);
                const cloudUpdatedAt = fullDoc.updatedAt?.toMillis() ?? 0;
                const localUpdatedAt = localDoc?.updatedAt ?? 0;
                const updates: Partial<Document> = {
                  isShared: true,
                  titlePinned: true,
                  ownerName: fullDoc.ownerName,
                };
                // Only update title if cloud is newer
                if (cloudUpdatedAt > localUpdatedAt) {
                  updates.title = fullDoc.title;
                  updates.updatedAt = cloudUpdatedAt;
                }
                // Never overwrite content for collab-active docs.
                // For inactive docs, only update if cloud is genuinely newer.
                if (!collabActiveDocIds.has(entry.id) && cloudUpdatedAt > localUpdatedAt) {
                  updates.content = fullDoc.content;
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

        // Build ownerId → ownerName lookup from team members
        const teamOwnerMap = new Map<string, string>();
        for (const team of teams) {
          for (const m of team.members) {
            if (m.uid && m.email) teamOwnerMap.set(m.uid, m.email);
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
                  ownerName: fullDoc.ownerName || teamOwnerMap.get(fullDoc.ownerId),
                  teamId: entry.teamId,
                  isShared: true,
                  docType: (fullDoc.docType as DocType) || "markdown",
                };
                await appStore.addDocument(newDoc);
              } else {
                // Non-owned team docs: Yjs/IndexedDB is source of truth for content.
                // Only update content/title if cloud version is genuinely newer.
                const localTeamDoc = useAppStore.getState().documents.find((d) => d.id === entry.id);
                const cloudTeamUpdatedAt = fullDoc.updatedAt?.toMillis() ?? 0;
                const localTeamUpdatedAt = localTeamDoc?.updatedAt ?? 0;
                const updates: Partial<Document> = {
                  isShared: true,
                  teamId: entry.teamId,
                  titlePinned: true,
                  ownerName: fullDoc.ownerName || teamOwnerMap.get(fullDoc.ownerId),
                };
                // Only update title if cloud is newer
                if (cloudTeamUpdatedAt > localTeamUpdatedAt) {
                  updates.title = fullDoc.title;
                  updates.updatedAt = cloudTeamUpdatedAt;
                }
                // Never overwrite content for collab-active docs.
                // For inactive docs, only update if cloud is genuinely newer.
                if (!collabActiveDocIds.has(entry.id) && cloudTeamUpdatedAt > localTeamUpdatedAt) {
                  updates.content = fullDoc.content;
                }
                appStore.updateDocument(entry.id, updates);
              }
            }
          }
        }

        // Reconcile deletions: remove local docs that no longer exist in cloud.
        // For own docs: only remove if last synced before this session (prevents deleting newly created docs)
        // For shared/team docs: remove if not in cloud (non-owner, cloud is source of truth)
        const finalDocs = useAppStore.getState().documents;
        for (const local of finalDocs) {
          if (collabActiveDocIds.has(local.id)) continue; // skip actively edited docs
          if (cloudDocIds.has(local.id)) continue; // exists in cloud — keep

          if (local.ownerId === user.uid) {
            // Own doc not in cloud: deleted on another device OR newly created here
            // If created/updated AFTER last sync → newly created on this device → keep
            // If older than last sync → was known to cloud but now gone → deleted elsewhere
            if (lastSyncAt > 0 && local.updatedAt < lastSyncAt) {
              console.warn(`[sync] Removing own doc ${local.id} "${local.title}" (deleted on another device)`);
              // Delete locally without re-tracking in deleted_docs (already gone from cloud)
              useAppStore.setState((s) => ({
                documents: s.documents.filter((d) => d.id !== local.id),
                activeDocId: s.activeDocId === local.id ? null : s.activeDocId,
              }));
              try {
                const { deleteDocument: dbDelete } = await import("@/services/database");
                await dbDelete(local.id);
              } catch { /* ignore */ }
            }
            // else: newer than lastSyncAt → keep (will be uploaded by syncToCloud)
          } else if (local.isShared || local.teamId) {
            // Non-owned shared/team doc not in cloud → removed by owner
            console.warn(`[sync] Removing non-owned doc ${local.id} (deleted from cloud)`);
            await appStore.deleteDocument(local.id);
          }
        }

        // NOTE: lastSyncAt is updated by the CALLER after both syncFromCloud + syncToCloud complete.
        // Do NOT update it here — otherwise syncToCloud would filter out all docs.
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

  // Emergency recovery: wipe all own docs from Firestore, re-upload current local docs.
  // Run this on the device with the CORRECT document list.
  resetCloudAndReSync: async () => {
    const { user, isOnline } = get();
    if (!user || !isOnline) return;

    await withSyncLock(async () => {
      set({ syncing: true });
      try {
        // 1. Fetch all own docs from cloud
        const cloudDocs = await fetchUserDocuments(user.uid);
        const appState = useAppStore.getState();
        const localIds = new Set(appState.documents.filter((d) => !d.ownerId || d.ownerId === user.uid).map((d) => d.id));

        // 2. Delete cloud docs that don't exist locally (= garbage)
        let deleted = 0;
        for (const cd of cloudDocs) {
          if (!localIds.has(cd.id)) {
            try {
              await deleteDocumentFromFirestore(cd.id);
              deleted++;
            } catch (e) {
              console.error(`[resetCloud] Failed to delete ${cd.id}:`, e);
            }
          }
        }
        console.warn(`[resetCloud] Deleted ${deleted} garbage docs from cloud`);

        // 3. Re-upload all local docs to ensure cloud matches local
        const ownDocs = appState.documents.filter((d) => !d.ownerId || d.ownerId === user.uid);
        for (const d of ownDocs) {
          try {
            await saveDocumentMerge({
              id: d.id,
              title: d.title,
              content: d.content,
              ownerId: user.uid,
              ownerName: user.displayName || user.email || undefined,
              folder: d.folder,
              tags: d.tags,
              docType: d.docType,
            });
          } catch (e) {
            console.error(`[resetCloud] Failed to upload ${d.id}:`, e);
          }
        }
        console.warn(`[resetCloud] Uploaded ${ownDocs.length} docs to cloud`);

        // 4. Clear deleted_docs table and update lastSyncAt
        try {
          const { setSetting } = await import("@/services/database");
          await setSetting("lastSyncAt", String(Date.now()));
        } catch { /* ignore */ }
        // Clear all deleted_docs entries
        try {
          const deletedIds = await getDeletedDocIds();
          for (const id of deletedIds) {
            await clearDeletedDoc(id);
          }
        } catch { /* ignore */ }

        console.warn("[resetCloud] Cloud reset complete. Cloud now matches this device.");
      } catch (error) {
        console.error("[resetCloud] Failed:", error);
      } finally {
        set({ syncing: false });
      }
    });
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

        // Only upload docs that were locally modified since last sync cycle.
        // Skip docs just pulled from cloud (cloudPulledDocIds) to avoid ping-pong.
        // lastSyncAt is updated by the CALLER after both sync steps complete,
        // so it reflects the PREVIOUS cycle — not the one currently running.
        let lastSyncAt = 0;
        try {
          const { getSetting } = await import("@/services/database");
          const saved = await getSetting("lastSyncAt");
          if (saved) lastSyncAt = parseInt(saved, 10) || 0;
        } catch { /* DB not available */ }

        const syncableDocs = documents.filter((d) => {
          if (d.ownerId && d.ownerId !== user.uid) return false; // non-owner
          if (cloudPulledDocIds.has(d.id)) return false; // just pulled from cloud
          // On first sync ever (lastSyncAt=0), upload everything.
          // After that, only upload docs modified since last sync cycle.
          if (lastSyncAt > 0 && d.updatedAt < lastSyncAt) return false;
          return true;
        });
        for (const d of syncableDocs) {
          const payload = {
            id: d.id,
            title: d.title,
            content: d.content,
            ownerId: d.ownerId || user.uid,
            ownerName: user.displayName || user.email || undefined,
            folder: d.folder,
            tags: d.tags,
            docType: d.docType,
            updatedAt: d.updatedAt,
          };
          try {
            await saveDocumentToFirestore(payload);
          } catch (saveErr) {
            // Transaction failed — fall back to merge save (preserves collaborators/shareLink)
            try {
              await saveDocumentMerge(payload);
            } catch (mergeErr) {
              console.error(`Failed to sync document ${d.id}:`, saveErr, mergeErr);
            }
          }
        }
        // Edit notifications are handled by debounce in App.tsx
        // (10min idle / document switch / app close)
      } catch (error) {
        console.error("Sync to cloud failed:", error);
      } finally {
        set({ syncing: false });
      }
    });
  },
}));
