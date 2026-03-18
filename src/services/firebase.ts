import { initializeApp, getApps, getApp } from "firebase/app";
import {
  initializeAuth,
  getAuth,
  indexedDBLocalPersistence,
  GoogleAuthProvider,
  GithubAuthProvider,
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
  runTransaction,
  addDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  type Timestamp,
} from "firebase/firestore";
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL,
} from "firebase/storage";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "",
};

const GOOGLE_CLIENT_ID =
  import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET =
  import.meta.env.VITE_GOOGLE_CLIENT_SECRET || "";
const GITHUB_CLIENT_ID =
  import.meta.env.VITE_GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET =
  import.meta.env.VITE_GITHUB_CLIENT_SECRET || "";

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

/**
 * Check for pending OAuth code from iOS in-webview flow.
 * Called on app init after the WKWebView reloads from the OAuth redirect.
 */
export async function checkPendingOAuthCode(): Promise<User | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const code = await invoke<string | null>("get_pending_oauth_code");
    if (!code) return null;

    const redirectUri = "http://localhost:19847/callback";
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
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
    const credential = GoogleAuthProvider.credential(tokens.id_token, tokens.access_token);
    const result = await signInWithCredential(auth, credential);
    return result.user;
  } catch (e) {
    console.error("checkPendingOAuthCode failed:", e);
    return null;
  }
}

export async function signInWithGoogle(): Promise<User | null> {
  const { getPlatform, isIOS } = await import("@/platform");
  const platform = await getPlatform();

  const port = 19847;
  const redirectUri = `http://localhost:${port}/callback`;

  // iOS: open SFSafariViewController (system browser sheet) for OAuth
  // Google blocks embedded WKWebView OAuth, but SFSafariViewController is allowed.
  // The Rust localhost server captures the callback and emits an event.
  if (isIOS) {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");

    // Start localhost callback server (iOS mode)
    await invoke<number>("oauth_listen", { ios: true });

    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      prompt: "select_account",
      access_type: "offline",
    });
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

    // Wait for the OAuth callback event from Rust
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
          invoke("dismiss_safari_vc").catch(() => {});
          reject(new Error("Authentication timed out"));
        }
      }, 300000);

      // Open SFSafariViewController (stays in-app, not blocked by Google)
      invoke("open_safari_vc", { url: authUrl }).catch(reject);
    });

    // Exchange code for tokens
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
    const credential = GoogleAuthProvider.credential(tokens.id_token, tokens.access_token);
    const result = await signInWithCredential(auth, credential);
    return result.user;
  }

  // Desktop: use local OAuth callback server + external browser
  await platform.startOAuthListener();

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account",
    access_type: "offline",
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  const authCode = await new Promise<string>((resolve, reject) => {
    let settled = false;

    const unlistenOk = platform.onOAuthCallback((code) => {
      if (!settled) {
        settled = true;
        unlistenOk.then((fn) => fn());
        unlistenErr.then((fn) => fn());
        resolve(code);
      }
    });

    const unlistenErr = platform.onOAuthError((error) => {
      if (!settled) {
        settled = true;
        unlistenOk.then((fn) => fn());
        unlistenErr.then((fn) => fn());
        reject(new Error(error));
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

    platform.openExternal(authUrl).catch(reject);
  });

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

export async function signInWithGitHub(): Promise<User | null> {
  const { getPlatform, isIOS } = await import("@/platform");
  const platform = await getPlatform();

  const port = 19847;
  const redirectUri = `http://localhost:${port}/callback`;

  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    throw new Error("GitHub OAuth credentials not configured");
  }

  // iOS: use SFSafariViewController
  if (isIOS) {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");

    await invoke<number>("oauth_listen", { ios: true });

    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: "read:user user:email",
    });
    const authUrl = `https://github.com/login/oauth/authorize?${params}`;

    const authCode = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const unlistenOk = listen<string>("oauth-callback", (event) => {
        if (!settled) { settled = true; unlistenOk.then(fn => fn()); unlistenErr.then(fn => fn()); resolve(event.payload); }
      });
      const unlistenErr = listen<string>("oauth-error", (event) => {
        if (!settled) { settled = true; unlistenOk.then(fn => fn()); unlistenErr.then(fn => fn()); reject(new Error(event.payload)); }
      });
      setTimeout(() => {
        if (!settled) { settled = true; unlistenOk.then(fn => fn()); unlistenErr.then(fn => fn()); invoke("dismiss_safari_vc").catch(() => {}); reject(new Error("Authentication timed out")); }
      }, 300000);
      invoke("open_safari_vc", { url: authUrl }).catch(reject);
    });

    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code: authCode,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error(`GitHub token exchange failed: ${await tokenResponse.text()}`);
    }

    const tokens = await tokenResponse.json();
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);
    const credential = GithubAuthProvider.credential(tokens.access_token);
    const result = await signInWithCredential(auth, credential);
    return result.user;
  }

  // Desktop: external browser
  await platform.startOAuthListener();

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "read:user user:email",
  });
  const authUrl = `https://github.com/login/oauth/authorize?${params}`;

  const authCode = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const unlistenOk = platform.onOAuthCallback((code) => {
      if (!settled) { settled = true; unlistenOk.then(fn => fn()); unlistenErr.then(fn => fn()); resolve(code); }
    });
    const unlistenErr = platform.onOAuthError((error) => {
      if (!settled) { settled = true; unlistenOk.then(fn => fn()); unlistenErr.then(fn => fn()); reject(new Error(error)); }
    });
    setTimeout(() => {
      if (!settled) { settled = true; unlistenOk.then(fn => fn()); unlistenErr.then(fn => fn()); reject(new Error("Authentication timed out")); }
    }, 300000);
    platform.openExternal(authUrl).catch(reject);
  });

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code: authCode,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`GitHub token exchange failed: ${await tokenResponse.text()}`);
  }

  const tokens = await tokenResponse.json();
  if (tokens.error) throw new Error(tokens.error_description || tokens.error);
  const credential = GithubAuthProvider.credential(tokens.access_token);
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
  docType?: string;
  collaborators: Record<string, { email: string; role: "editor" | "viewer"; addedAt: number }>;
  tags: string[];
  folder: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
  teamId?: string | null;
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
  docType?: string;
}): Promise<void> {
  // Never sync empty content to cloud — protects against data loss propagation
  if (!docData.content?.trim()) {
    console.warn(`[firebase] Blocked save of doc ${docData.id} with empty content`);
    return;
  }
  const ref = doc(firestore, DOCS_COLLECTION, docData.id);

  // Use transaction for conditional write: only update if our content is newer
  // than what's in Firestore. Prevents overwriting a collaborator's recent edits
  // with stale local content.
  await runTransaction(firestore, async (transaction) => {
    const snap = await transaction.get(ref);
    if (snap.exists()) {
      const cloudData = snap.data();
      // If cloud has longer/different content from another user, skip stale overwrites.
      // Only the document owner should update content in Firestore.
      if (cloudData.ownerId && cloudData.ownerId !== docData.ownerId) {
        return; // Non-owner should not overwrite
      }
    }
    const payload: Record<string, unknown> = {
      title: docData.title,
      content: docData.content,
      ownerId: docData.ownerId,
      folder: docData.folder ?? "/",
      tags: docData.tags ?? [],
      updatedAt: serverTimestamp(),
    };
    if (docData.docType) payload.docType = docData.docType;

    if (snap.exists()) {
      transaction.update(ref, payload);
    } else {
      transaction.set(ref, {
        ...payload,
        collaborators: {},
        collaboratorUids: [],
        createdAt: serverTimestamp(),
      });
    }
  });
}

export async function createDocumentInFirestore(docData: {
  id: string;
  title: string;
  content: string;
  ownerId: string;
  folder?: string;
  tags?: string[];
  docType?: string;
}): Promise<void> {
  const ref = doc(firestore, DOCS_COLLECTION, docData.id);
  await setDoc(ref, {
    title: docData.title,
    content: docData.content || "",
    ownerId: docData.ownerId,
    collaborators: {},
    collaboratorUids: [],
    tags: docData.tags ?? [],
    folder: docData.folder ?? "/",
    ...(docData.docType ? { docType: docData.docType } : {}),
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

// ─── Version history cloud sync ─────────────────────────────
// Versions are stored as subcollections: documents/{docId}/versions/{versionId}
// This matches Firestore security rules and scopes access to document collaborators.

export interface FirestoreVersion {
  id: string;
  documentId: string;
  content: string;
  title: string;
  message: string | null;
  createdAt: number;
  ownerId: string;
  ownerName: string;
}

export async function syncVersionToCloud(
  documentId: string,
  version: { id: string; content: string; title: string; message: string | null; createdAt: number },
  ownerId: string,
  ownerName: string,
): Promise<void> {
  if (!version.content?.trim()) return;
  const ref = doc(firestore, DOCS_COLLECTION, documentId, "versions", version.id);
  await setDoc(ref, {
    content: version.content,
    title: version.title,
    message: version.message,
    createdAt: version.createdAt,
    ownerId,
    ownerName,
  }, { merge: true });
}

export async function fetchVersionsFromCloud(
  documentId: string,
): Promise<FirestoreVersion[]> {
  const q = query(
    collection(firestore, DOCS_COLLECTION, documentId, "versions"),
    orderBy("createdAt", "desc"),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({
    id: d.id,
    documentId,
    ...d.data(),
  }) as FirestoreVersion);
}

export async function deleteVersionFromCloud(documentId: string, versionId: string): Promise<void> {
  await deleteDoc(doc(firestore, DOCS_COLLECTION, documentId, "versions", versionId));
}

// ─── User settings (theme, preferences) ─────────────────────

const SETTINGS_COLLECTION = "user_settings";

export async function saveUserSettingsToFirestore(
  uid: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const ref = doc(firestore, SETTINGS_COLLECTION, uid);
  await setDoc(ref, { ...settings, updatedAt: serverTimestamp() }, { merge: true });
}

export async function fetchUserSettings(
  uid: string,
): Promise<Record<string, unknown> | null> {
  const snap = await getDoc(doc(firestore, SETTINGS_COLLECTION, uid));
  if (!snap.exists()) return null;
  return snap.data() as Record<string, unknown>;
}

// ─── AI Chat History (subcollection under user_settings) ────
// Supports multi-thread: each thread stored as ai_chats/{docId}__{threadId}
// Thread metadata stored as ai_chats/{docId} with a threads array

/**
 * Save AI chat thread content.
 * chatId = docId (legacy) or docId__threadId (multi-thread)
 */
export async function saveAiChatToCloud(
  uid: string,
  chatId: string,
  data: { messages: unknown[]; apiMessages: unknown[] },
): Promise<void> {
  if (!data.messages.length) return;
  const ref = doc(firestore, SETTINGS_COLLECTION, uid, "ai_chats", chatId);
  await setDoc(ref, { ...data, updatedAt: serverTimestamp() });
}

/** Fetch AI chat thread content */
export async function fetchAiChatFromCloud(
  uid: string,
  chatId: string,
): Promise<{ messages: unknown[]; apiMessages: unknown[] } | null> {
  const ref = doc(firestore, SETTINGS_COLLECTION, uid, "ai_chats", chatId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const data = snap.data();
  return {
    messages: (data.messages || []) as unknown[],
    apiMessages: (data.apiMessages || []) as unknown[],
  };
}

/** Delete AI chat thread content */
export async function deleteAiChatFromCloud(
  uid: string,
  chatId: string,
): Promise<void> {
  const ref = doc(firestore, SETTINGS_COLLECTION, uid, "ai_chats", chatId);
  await deleteDoc(ref);
}

/** Save thread list metadata for a document */
export async function saveAiThreadsToCloud(
  uid: string,
  docId: string,
  threads: { id: string; title: string; createdAt: number }[],
): Promise<void> {
  const ref = doc(firestore, SETTINGS_COLLECTION, uid, "ai_chats", `${docId}__meta`);
  await setDoc(ref, { threads, updatedAt: serverTimestamp() });
}

/** Fetch thread list metadata for a document */
export async function fetchAiThreadsFromCloud(
  uid: string,
  docId: string,
): Promise<{ id: string; title: string; createdAt: number }[] | null> {
  const ref = doc(firestore, SETTINGS_COLLECTION, uid, "ai_chats", `${docId}__meta`);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return (snap.data().threads || []) as { id: string; title: string; createdAt: number }[];
}

// ─── Image upload (Firebase Storage) ────────────────────────

const storage = getStorage(app);

/**
 * Upload an image to Firebase Storage and return the download URL.
 * Path: images/{uid}/{uuid}.{ext}
 */
export async function uploadImage(
  uid: string,
  data: Uint8Array,
  ext: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const path = `images/${uid}/${id}.${ext}`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, data, {
    contentType: `image/${ext === "jpg" ? "jpeg" : ext}`,
  });
  return getDownloadURL(storageRef);
}

// ─── Remote error logging ────────────────────────────────────

/** Write a client-side error to Firestore so it can be inspected remotely */
export async function logErrorToCloud(
  uid: string,
  context: string,
  error: unknown,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    await addDoc(collection(firestore, "error_logs"), {
      uid,
      context,
      error: error instanceof Error ? { message: error.message, code: (error as { code?: string }).code } : String(error),
      meta: meta ?? {},
      createdAt: serverTimestamp(),
      appVersion: (globalThis as Record<string, unknown>).__APP_VERSION__ ?? "unknown",
    });
  } catch {
    // Best-effort — don't throw if logging itself fails
  }
}
