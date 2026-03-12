import { create } from "zustand";
import type { User } from "firebase/auth";
import {
  signInWithGoogle,
  signOut,
  onAuthChange,
  fetchUserDocuments,
  fetchDocument,
  createDocumentInFirestore,
  saveDocumentToFirestore,
  deleteDocumentFromFirestore,
} from "@/services/firebase";
import { saveUserProfile, fetchSharedWithMe, fetchUserTeams, fetchTeamDocuments } from "@/services/sharing";
import { notifySlack } from "@/services/slack-notify";
import { useAppStore, type Document, type DocType } from "./app-store";

interface AuthState {
  user: User | null;
  loading: boolean;
  isOnline: boolean;
  syncing: boolean;
  loginError: string | null;
  init: () => () => void;
  login: () => Promise<void>;
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
        get().syncFromCloud();
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

  login: async () => {
    set({ loginError: null });
    try {
      await signInWithGoogle();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Login failed";
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

    set({ syncing: true });
    try {
      const cloudDocs = await fetchUserDocuments(user.uid);
      const appStore = useAppStore.getState();
      const localDocs = appStore.documents;

      // Claim unclaimed local docs for this user (first login on this device)
      for (const local of localDocs) {
        if (!local.ownerId) {
          appStore.updateDocument(local.id, { ownerId: user.uid });
        }
      }

      // Merge: cloud docs that don't exist locally get added,
      // existing docs get folder/tags updated from cloud
      for (const cloudDoc of cloudDocs) {
        // Skip cloud docs with empty content — don't import data loss
        if (!cloudDoc.content?.trim()) continue;

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
          // Update ownerId, sharing status, and restore folder from cloud if needed
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

      // Track all cloud doc IDs for deletion reconciliation
      const cloudDocIds = new Set(cloudDocs.map((d) => d.id));

      // Fetch documents shared with this user (as collaborator)
      try {
        const sharedDocs = await fetchSharedWithMe(user.uid);
        for (const shared of sharedDocs) {
          cloudDocIds.add(shared.id);
          const currentDocs = useAppStore.getState().documents;
          const local = currentDocs.find((d) => d.id === shared.id);
          if (local) {
            // Already in local store — update isShared + content from Firestore
            // (ensures collaborator sees the owner's latest content)
            if (local.ownerId !== user.uid) {
              const fullDoc = await fetchDocument(shared.id);
              if (fullDoc?.content?.trim()) {
                appStore.updateDocument(shared.id, {
                  isShared: true,
                  content: fullDoc.content,
                  title: fullDoc.title,
                  updatedAt: fullDoc.updatedAt?.toMillis() ?? Date.now(),
                });
              } else {
                appStore.updateDocument(shared.id, { isShared: true });
              }
            } else {
              appStore.updateDocument(shared.id, { isShared: true });
            }
            continue;
          }
          // Fetch full document content for new shared docs
          const fullDoc = await fetchDocument(shared.id);
          if (!fullDoc || !fullDoc.content?.trim()) continue;
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
        }
      } catch (err) {
        console.error("Fetch shared docs failed:", err);
      }

      // Fetch team documents
      try {
        const teams = await fetchUserTeams(user.uid);
        for (const team of teams) {
          const teamDocs = await fetchTeamDocuments(team.id);
          for (const td of teamDocs) {
            cloudDocIds.add(td.id);
            const currentDocs = useAppStore.getState().documents;
            const local = currentDocs.find((d) => d.id === td.id);
            if (local) {
              // Update content for non-owned team docs
              if (local.ownerId !== user.uid) {
                const fullDoc = await fetchDocument(td.id);
                if (fullDoc?.content?.trim()) {
                  appStore.updateDocument(td.id, {
                    isShared: true,
                    teamId: team.id,
                    content: fullDoc.content,
                    title: fullDoc.title,
                    updatedAt: fullDoc.updatedAt?.toMillis() ?? Date.now(),
                  });
                } else {
                  appStore.updateDocument(td.id, { isShared: true, teamId: team.id });
                }
              } else {
                appStore.updateDocument(td.id, { isShared: true, teamId: team.id });
              }
              continue;
            }
            const fullDoc = await fetchDocument(td.id);
            if (!fullDoc || !fullDoc.content?.trim()) continue;
            const newDoc: Document = {
              id: fullDoc.id,
              title: fullDoc.title,
              content: fullDoc.content,
              createdAt: fullDoc.createdAt?.toMillis() ?? Date.now(),
              updatedAt: fullDoc.updatedAt?.toMillis() ?? Date.now(),
              folder: fullDoc.folder ?? "/",
              tags: fullDoc.tags ?? [],
              ownerId: fullDoc.ownerId,
              teamId: team.id,
              isShared: true,
              docType: (fullDoc.docType as DocType) || "markdown",
            };
            await appStore.addDocument(newDoc);
          }
        }
      } catch (err) {
        console.error("Fetch team docs failed:", err);
      }

      // Reconcile deletions: remove local shared/team docs that no longer exist in cloud.
      // Only remove docs NOT owned by the current user (owned docs are source of truth locally).
      const finalDocs = useAppStore.getState().documents;
      for (const local of finalDocs) {
        if (local.ownerId === user.uid) continue; // never delete own docs
        if (!local.isShared && !local.teamId) continue; // only shared/team docs
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
  },

  deleteFromCloud: async (docId: string) => {
    const { user, isOnline } = get();
    if (!user || !isOnline) return;
    try {
      await deleteDocumentFromFirestore(docId);
    } catch (error) {
      console.error("Failed to delete from cloud:", error);
    }
  },

  syncToCloud: async () => {
    const { user, isOnline } = get();
    if (!user || !isOnline) return;

    set({ syncing: true });
    try {
      const { documents } = useAppStore.getState();
      // Sync: owned docs + shared docs with non-empty content
      const syncableDocs = documents.filter(
        (d) => d.content.trim() && (!d.ownerId || d.ownerId === user.uid || d.isShared),
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
          // Only create if owned — collaborators shouldn't create docs
          if (!d.ownerId || d.ownerId === user.uid) {
            try {
              await createDocumentInFirestore(payload);
            } catch (createErr) {
              console.error(`Failed to sync document ${d.id}:`, saveErr, createErr);
            }
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
  },
}));
