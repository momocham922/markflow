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

      // Merge: cloud docs that don't exist locally get added
      for (const cloudDoc of cloudDocs) {
        const local = localDocs.find((d) => d.id === cloudDoc.id);
        if (!local) {
          const doc: Document = {
            id: cloudDoc.id,
            title: cloudDoc.title,
            content: cloudDoc.content,
            createdAt: cloudDoc.createdAt?.toMillis() ?? Date.now(),
            updatedAt: cloudDoc.updatedAt?.toMillis() ?? Date.now(),
          };
          await appStore.addDocument(doc);
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
      for (const doc of documents) {
        const payload = {
          id: doc.id,
          title: doc.title,
          content: doc.content,
          ownerId: user.uid,
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
    } catch (error) {
      console.error("Sync to cloud failed:", error);
    } finally {
      set({ syncing: false });
    }
  },
}));
