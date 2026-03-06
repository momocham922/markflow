import { initializeApp, getApps, getApp } from "firebase/app";
import {
  initializeAuth,
  getAuth,
  indexedDBLocalPersistence,
  GoogleAuthProvider,
  signInWithCredential,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  type User,
  type Auth,
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

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "",
};

const GOOGLE_CLIENT_ID =
  "636447248627-d24omgnl2flv7jd8msasgnea5cc2pte8.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = "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";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

// Use indexedDB persistence to avoid sessionStorage issues in Tauri webview
// Wrap in try/catch so HMR re-execution doesn't crash
let _auth: Auth;
try {
  _auth = initializeAuth(app, {
    persistence: indexedDBLocalPersistence,
  });
} catch {
  _auth = getAuth(app);
}
export const auth = _auth;
export const firestore = getFirestore(app);

export async function signInWithGoogle(): Promise<User | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { open } = await import("@tauri-apps/plugin-shell");

  // Start local callback server (Rust side) and get the random port
  const port = await invoke<number>("oauth_listen");
  const redirectUri = `http://localhost:${port}/callback`;

  // Build Google OAuth URL
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account",
    access_type: "offline",
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  // Listen for the OAuth callback event from Rust
  const authCode = await new Promise<string>((resolve, reject) => {
    let settled = false;

    const unlistenOk = listen<string>("oauth-callback", (event) => {
      if (!settled) {
        settled = true;
        unlistenOk.then((fn) => fn());
        unlistenErr.then((fn) => fn());
        resolve(event.payload);
      }
    });

    const unlistenErr = listen<string>("oauth-error", (event) => {
      if (!settled) {
        settled = true;
        unlistenOk.then((fn) => fn());
        unlistenErr.then((fn) => fn());
        reject(new Error(event.payload));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        unlistenOk.then((fn) => fn());
        unlistenErr.then((fn) => fn());
        reject(new Error("Authentication timed out"));
      }
    }, 300000);

    // Open the auth URL in the system browser
    open(authUrl).catch(reject);
  });

  // Exchange auth code for tokens
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: authCode,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  const tokens = await tokenResponse.json();
  const credential = GoogleAuthProvider.credential(
    tokens.id_token,
    tokens.access_token,
  );
  const result = await signInWithCredential(auth, credential);
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
  collaborators: Record<string, { email: string; role: "editor" | "viewer"; addedAt: number }>;
  tags: string[];
  folder: string;
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
  return snapshot.docs.map(
    (d) => ({ id: d.id, ...d.data() }) as FirestoreDocument,
  );
}

export async function fetchDocument(
  docId: string,
): Promise<FirestoreDocument | null> {
  const snap = await getDoc(doc(firestore, DOCS_COLLECTION, docId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as FirestoreDocument;
}

export async function saveDocumentToFirestore(docData: {
  id: string;
  title: string;
  content: string;
  ownerId: string;
  folder?: string;
  tags?: string[];
}): Promise<void> {
  const ref = doc(firestore, DOCS_COLLECTION, docData.id);
  await setDoc(
    ref,
    {
      title: docData.title,
      content: docData.content,
      ownerId: docData.ownerId,
      folder: docData.folder ?? "/",
      tags: docData.tags ?? [],
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export async function createDocumentInFirestore(docData: {
  id: string;
  title: string;
  content: string;
  ownerId: string;
  folder?: string;
  tags?: string[];
}): Promise<void> {
  const ref = doc(firestore, DOCS_COLLECTION, docData.id);
  await setDoc(ref, {
    title: docData.title,
    content: docData.content,
    ownerId: docData.ownerId,
    collaborators: {},
    tags: docData.tags ?? [],
    folder: docData.folder ?? "/",
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
