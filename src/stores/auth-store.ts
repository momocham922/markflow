import { create } from "zustand";
import type { User } from "firebase/auth";
import {
  signInWithGoogle,
  signOut,
  onAuthChange,
  fetchUserDocuments,
  createDocumentInFirestore,
  saveDocumentToFirestore,
  deleteDocumentFromFirestore,
} from "@/services/firebase";
import { saveUserProfile } from "@/services/sharing";
import { notifySlack } from "@/services/slack-notify";
import { useAppStore, type Document } from "./app-store";

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
        const local = localDocs.find((d) => d.id === cloudDoc.id);
        if (!local) {
          const hasCollaborators = cloudDoc.collaborators && Object.keys(cloudDoc.collaborators).length > 0;
          const hasShareLink = cloudDoc.shareLink?.enabled === true;
          const doc: Document = {
            id: cloudDoc.id,
            title: cloudDoc.title,
            content: cloudDoc.content,
            createdAt: cloudDoc.createdAt?.toMillis() ?? Date.now(),
            updatedAt: cloudDoc.updatedAt?.toMillis() ?? Date.now(),
            folder: cloudDoc.folder ?? "/",
            tags: cloudDoc.tags ?? [],
            ownerId: user.uid,
            isShared: hasCollaborators || hasShareLink,
          };
          await appStore.addDocument(doc);
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
      // Only sync docs owned by this user (or unclaimed local docs)
      const myDocs = documents.filter(
        (d) => !d.ownerId || d.ownerId === user.uid,
      );
      for (const doc of myDocs) {
        const payload = {
          id: doc.id,
          title: doc.title,
          content: doc.content,
          ownerId: user.uid,
          folder: doc.folder,
          tags: doc.tags,
        };
        try {
          await saveDocumentToFirestore(payload);
        } catch (saveErr) {
          // Only create if it's a not-found error; rethrow others
          try {
            await createDocumentInFirestore(payload);
          } catch (createErr) {
            console.error(`Failed to sync document ${doc.id}:`, saveErr, createErr);
          }
        }
      }
      // Notify Slack about edits (once per sync, not per doc)
      if (myDocs.length > 0) {
        const titles = myDocs.slice(0, 3).map((d) => d.title).join(", ");
        const extra = myDocs.length > 3 ? ` +${myDocs.length - 3} more` : "";
        notifySlack("edit", {
          docTitle: titles + extra,
          authorName: user.displayName || user.email || undefined,
          detail: `${myDocs.length} document(s) synced to cloud`,
        }).catch(() => {});
      }
    } catch (error) {
      console.error("Sync to cloud failed:", error);
    } finally {
      set({ syncing: false });
    }
  },
}));
