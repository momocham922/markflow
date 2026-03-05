import { create } from "zustand";
import type { User } from "firebase/auth";
import {
  signInWithGoogle,
  signOut,
  onAuthChange,
  fetchUserDocuments,
  createDocumentInFirestore,
  saveDocumentToFirestore,
} from "@/services/firebase";
import { useAppStore, type Document } from "./app-store";

interface AuthState {
  user: User | null;
  loading: boolean;
  isOnline: boolean;
  syncing: boolean;
  init: () => () => void;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  syncToCloud: () => Promise<void>;
  syncFromCloud: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  loading: true,
  isOnline: navigator.onLine,
  syncing: false,

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
    try {
      await signInWithGoogle();
    } catch (error) {
      console.error("Login failed:", error);
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

  syncToCloud: async () => {
    const { user, isOnline } = get();
    if (!user || !isOnline) return;

    set({ syncing: true });
    try {
      const { documents } = useAppStore.getState();
      for (const doc of documents) {
        try {
          await saveDocumentToFirestore({
            id: doc.id,
            title: doc.title,
            content: doc.content,
            ownerId: user.uid,
          });
        } catch {
          // If doc doesn't exist yet, create it
          await createDocumentInFirestore({
            id: doc.id,
            title: doc.title,
            content: doc.content,
            ownerId: user.uid,
          });
        }
      }
    } catch (error) {
      console.error("Sync to cloud failed:", error);
    } finally {
      set({ syncing: false });
    }
  },
}));
