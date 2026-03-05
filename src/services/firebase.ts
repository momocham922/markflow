import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  type User,
} from "firebase/auth";
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  deleteDoc,
  updateDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  type Timestamp,
} from "firebase/firestore";

// Firebase config — replace with your project's config
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const firestore = getFirestore(app);

const googleProvider = new GoogleAuthProvider();

export async function signInWithGoogle(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function signOut(): Promise<void> {
  await firebaseSignOut(auth);
}

export function onAuthChange(callback: (user: User | null) => void) {
  return onAuthStateChanged(auth, callback);
}

// Firestore document operations
export interface FirestoreDocument {
  id: string;
  title: string;
  content: string;
  ownerId: string;
  collaborators: { uid: string; role: "editor" | "viewer"; addedAt: number }[];
  tags: string[];
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
  shareLink?: { enabled: boolean; token: string; permission: "view" | "edit" };
}

const DOCS_COLLECTION = "documents";

export async function fetchUserDocuments(
  uid: string,
): Promise<FirestoreDocument[]> {
  const q = query(
    collection(firestore, DOCS_COLLECTION),
    where("ownerId", "==", uid),
    orderBy("updatedAt", "desc"),
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }) as FirestoreDocument);
}

export async function fetchDocument(
  docId: string,
): Promise<FirestoreDocument | null> {
  const snap = await getDoc(doc(firestore, DOCS_COLLECTION, docId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as FirestoreDocument;
}

export async function saveDocumentToFirestore(
  docData: {
    id: string;
    title: string;
    content: string;
    ownerId: string;
  },
): Promise<void> {
  const ref = doc(firestore, DOCS_COLLECTION, docData.id);
  await setDoc(
    ref,
    {
      title: docData.title,
      content: docData.content,
      ownerId: docData.ownerId,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export async function createDocumentInFirestore(
  docData: {
    id: string;
    title: string;
    content: string;
    ownerId: string;
  },
): Promise<void> {
  const ref = doc(firestore, DOCS_COLLECTION, docData.id);
  await setDoc(ref, {
    title: docData.title,
    content: docData.content,
    ownerId: docData.ownerId,
    collaborators: [],
    tags: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function deleteDocumentFromFirestore(
  docId: string,
): Promise<void> {
  await deleteDoc(doc(firestore, DOCS_COLLECTION, docId));
}

export async function updateShareLink(
  docId: string,
  shareLink: { enabled: boolean; token: string; permission: "view" | "edit" },
): Promise<void> {
  await updateDoc(doc(firestore, DOCS_COLLECTION, docId), { shareLink });
}
