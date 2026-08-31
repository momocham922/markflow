import { initializeApp, getApps, getApp } from "firebase/app";
import {
  initializeAuth,
  getAuth,
  indexedDBLocalPersistence,
  GoogleAuthProvider,
  GithubAuthProvider,
  signInWithCredential,
  signInWithEmailAndPassword,
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
  runTransaction,
  addDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "",
};

// Only the PUBLIC client_id ships in the bundle. The client_secret lives ONLY
// on the ai-proxy (BFF): the browser runs the authorization-code flow, then the
// received `code` is exchanged for tokens server-side via exchangeOAuthCode().
// Never reintroduce VITE_GOOGLE_CLIENT_SECRET / VITE_GITHUB_CLIENT_SECRET here —
// a client secret in a distributed binary / public repo is a leaked secret.
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
const GITHUB_CLIENT_ID = import.meta.env.VITE_GITHUB_CLIENT_ID || "";
const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";

/**
 * Generate a cryptographically random OAuth `state` value. It is sent in the
 * authorization URL and verified by the loopback callback listener (Rust) so a
 * forged callback (CSRF / auth-code injection) that doesn't echo this exact
 * value is rejected. 32 URL-safe chars ≈ 190 bits of entropy.
 */
function generateOAuthState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/**
 * Exchange an OAuth authorization code for tokens via the ai-proxy BFF.
 * The provider client_secret never reaches this bundle — the proxy holds it.
 */
async function exchangeOAuthCode(
  provider: "google" | "github",
  code: string,
  redirectUri: string,
): Promise<{ id_token?: string; access_token?: string }> {
  const url = `${AI_PROXY_URL}/v1/auth/oauth/exchange`;
  const body = JSON.stringify({ provider, code, redirectUri });

  // The mobile WebView's fetch/TLS stack intermittently fails the HTTPS
  // handshake to Cloud Run *before any response arrives* (surfaces as
  // "Failed to fetch" / "Load failed"), yet a later attempt succeeds — testers
  // hit it 数回 then it "suddenly worked". So we retry the transport for the
  // user instead of making them tap Login again.
  //
  // CRITICAL: retry ONLY when NO HTTP response was received. The authorization
  // `code` is single-use and is spent server-side (the proxy holds the
  // client_secret and calls the provider). A thrown fetch means the request
  // never reached the proxy, so the code is untouched and retrying is safe.
  // But once we get any HTTP response, the code may already be consumed —
  // retrying then would fail with invalid_grant, so we surface that error.
  const backoffMs = [0, 400, 1000, 2000];
  const perAttemptTimeoutMs = 20000;
  let lastNetworkErr: unknown;

  for (let attempt = 0; attempt < backoffMs.length; attempt++) {
    if (backoffMs[attempt] > 0) {
      await new Promise((r) => setTimeout(r, backoffMs[attempt]));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perAttemptTimeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
    } catch (e) {
      // No response arrived (TLS/DNS/connection failure or a hung request that
      // hit perAttemptTimeoutMs) → the code was never spent → retry.
      lastNetworkErr = e;
      clearTimeout(timer);
      continue;
    } finally {
      clearTimeout(timer);
    }

    // An HTTP response came back: never retry (the code may be consumed now).
    if (!res.ok) {
      let detail = "";
      try {
        detail = ((await res.json()) as { error?: string })?.error || "";
      } catch {
        /* body not JSON */
      }
      throw new Error(`Token exchange failed: ${res.status} ${detail}`.trim());
    }
    return res.json();
  }

  // Every attempt failed at the network layer before any response.
  throw lastNetworkErr instanceof Error
    ? lastNetworkErr
    : new Error("Failed to fetch");
}

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
    const tokens = await exchangeOAuthCode("google", code, redirectUri);
    const credential = GoogleAuthProvider.credential(
      tokens.id_token,
      tokens.access_token,
    );
    const result = await signInWithCredential(auth, credential);
    return result.user;
  } catch (e) {
    console.error("checkPendingOAuthCode failed:", e);
    return null;
  }
}

export async function signInWithGoogle(): Promise<User | null> {
  const { getPlatform, isMobile, isIOS, isAndroid } =
    await import("@/platform");
  const platform = await getPlatform();

  const port = 19847;
  const redirectUri = `http://localhost:${port}/callback`;

  // Mobile (iOS/Android): use Rust localhost server + system browser for OAuth
  // Google blocks embedded WebView OAuth, but system browser is allowed.
  // The Rust localhost server captures the callback and emits an event.
  if (isMobile) {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");

    // Start localhost callback server with the CSRF state to verify. The
    // platform flags tell Rust which callback page to serve: iOS dismisses the
    // in-app SFSafariVC; Android serves a markflow:// return-to-app page (the
    // system browser is a separate task with nothing to dismiss).
    const oauthState = generateOAuthState();
    await invoke<number>("oauth_listen", {
      ios: isIOS,
      android: isAndroid,
      state: oauthState,
    });

    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      prompt: "select_account",
      access_type: "offline",
      state: oauthState,
    });
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

    // Wait for the OAuth callback event from Rust
    const authCode = await new Promise<string>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        unlistenOk.then((fn) => fn());
        unlistenErr.then((fn) => fn());
        clearTimeout(timeoutId);
      };
      // Route launch failures through the same settle+cleanup path so a
      // failed browser open doesn't leak the 300s timer and event listeners.
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const unlistenOk = listen<string>("oauth-callback", (event) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(event.payload);
        }
      });

      const unlistenErr = listen<string>("oauth-error", (event) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(event.payload));
        }
      });

      timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          invoke("dismiss_safari_vc").catch(() => {});
          reject(new Error("Authentication timed out"));
        }
      }, 300000);

      // Open system browser for OAuth. iOS uses the in-app SFSafariVC; Android
      // and other mobile use the external browser.
      if (isIOS) {
        invoke("open_safari_vc", { url: authUrl }).catch(fail);
      } else {
        invoke("open_external_url", { url: authUrl }).catch(fail);
      }
    });

    // Exchange code for tokens (server-side; client_secret stays on the proxy)
    const tokens = await exchangeOAuthCode("google", authCode, redirectUri);
    const credential = GoogleAuthProvider.credential(
      tokens.id_token,
      tokens.access_token,
    );
    const result = await signInWithCredential(auth, credential);
    return result.user;
  }

  // Desktop: use local OAuth callback server + external browser
  const oauthState = generateOAuthState();
  await platform.startOAuthListener(oauthState);

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account",
    access_type: "offline",
    state: oauthState,
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  const authCode = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      unlistenOk.then((fn) => fn());
      unlistenErr.then((fn) => fn());
      clearTimeout(timeoutId);
    };
    // Route launch failures through the same settle+cleanup path so a
    // failed browser open doesn't leak the 300s timer and event listeners.
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const unlistenOk = platform.onOAuthCallback((code) => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(code);
      }
    });

    const unlistenErr = platform.onOAuthError((error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(error));
      }
    });

    timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error("Authentication timed out"));
      }
    }, 300000);

    platform.openExternal(authUrl).catch(fail);
  });

  const tokens = await exchangeOAuthCode("google", authCode, redirectUri);
  const credential = GoogleAuthProvider.credential(
    tokens.id_token,
    tokens.access_token,
  );
  const result = await signInWithCredential(auth, credential);
  return result.user;
}

export async function signInWithGitHub(): Promise<User | null> {
  const { getPlatform, isMobile, isIOS, isAndroid } =
    await import("@/platform");
  const platform = await getPlatform();

  const port = 19847;
  const redirectUri = `http://localhost:${port}/callback`;

  if (!GITHUB_CLIENT_ID) {
    throw new Error("GitHub OAuth client id not configured");
  }

  // Mobile: use system browser for OAuth
  if (isMobile) {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");

    const oauthState = generateOAuthState();
    await invoke<number>("oauth_listen", {
      ios: isIOS,
      android: isAndroid,
      state: oauthState,
    });

    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: "read:user user:email",
      state: oauthState,
    });
    const authUrl = `https://github.com/login/oauth/authorize?${params}`;

    const authCode = await new Promise<string>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        unlistenOk.then((fn) => fn());
        unlistenErr.then((fn) => fn());
        clearTimeout(timeoutId);
      };
      // Route launch failures through the same settle+cleanup path so a
      // failed browser open doesn't leak the 300s timer and event listeners.
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const unlistenOk = listen<string>("oauth-callback", (event) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(event.payload);
        }
      });
      const unlistenErr = listen<string>("oauth-error", (event) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(event.payload));
        }
      });
      timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          invoke("dismiss_safari_vc").catch(() => {});
          reject(new Error("Authentication timed out"));
        }
      }, 300000);
      if (isIOS) {
        invoke("open_safari_vc", { url: authUrl }).catch(fail);
      } else {
        invoke("open_external_url", { url: authUrl }).catch(fail);
      }
    });

    const tokens = await exchangeOAuthCode("github", authCode, redirectUri);
    if (!tokens.access_token) throw new Error("GitHub token exchange failed");
    const credential = GithubAuthProvider.credential(tokens.access_token);
    const result = await signInWithCredential(auth, credential);
    return result.user;
  }

  // Desktop: external browser
  const oauthState = generateOAuthState();
  await platform.startOAuthListener(oauthState);

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "read:user user:email",
    state: oauthState,
  });
  const authUrl = `https://github.com/login/oauth/authorize?${params}`;

  const authCode = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      unlistenOk.then((fn) => fn());
      unlistenErr.then((fn) => fn());
      clearTimeout(timeoutId);
    };
    // Route launch failures through the same settle+cleanup path so a
    // failed browser open doesn't leak the 300s timer and event listeners.
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const unlistenOk = platform.onOAuthCallback((code) => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(code);
      }
    });
    const unlistenErr = platform.onOAuthError((error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(error));
      }
    });
    timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error("Authentication timed out"));
      }
    }, 300000);
    platform.openExternal(authUrl).catch(fail);
  });

  const tokens = await exchangeOAuthCode("github", authCode, redirectUri);
  if (!tokens.access_token) throw new Error("GitHub token exchange failed");
  const credential = GithubAuthProvider.credential(tokens.access_token);
  const result = await signInWithCredential(auth, credential);
  return result.user;
}

export async function reportCrash(
  data: Record<string, unknown>,
): Promise<void> {
  try {
    // Defense-in-depth privacy gate: never persist a crash report unless the
    // user consented to telemetry. Callers gate too, but this is the last line.
    // Lazy import avoids a static firebase<->telemetry cycle.
    const { getConsent } = await import("./telemetry");
    if (!getConsent()) return;
    const userId = auth.currentUser?.uid || null;
    await addDoc(collection(firestore, "crash_reports"), {
      ...data,
      userId,
      reportedAt: serverTimestamp(),
    });
  } catch {}
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
  ownerName?: string;
  docType?: string;
  collaborators: Record<
    string,
    { email: string; role: "editor" | "viewer"; addedAt: number }
  >;
  tags: string[];
  folder: string;
  titlePinned?: boolean;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
  teamId?: string | null;
  shareLink?: { enabled: boolean; token: string; permission: "view" | "edit" };
  voiceTranscript?: string | null;
  voiceGcsUri?: string | null;
  voiceRecordedAt?: Timestamp | null;
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
  ownerName?: string;
  folder?: string;
  tags?: string[];
  docType?: string;
  titlePinned?: boolean;
  updatedAt?: number;
  teamId?: string | null;
  voiceTranscript?: string | null;
  voiceGcsUri?: string | null;
  voiceRecordedAt?: number | null;
}): Promise<void> {
  const ref = doc(firestore, DOCS_COLLECTION, docData.id);

  // Use transaction for conditional write: only update if our content is newer
  // than what's in Firestore. Prevents overwriting a collaborator's recent edits
  // with stale local content.
  await runTransaction(firestore, async (transaction) => {
    const snap = await transaction.get(ref);
    if (snap.exists()) {
      const cloudData = snap.data();
      if (cloudData.ownerId && cloudData.ownerId !== docData.ownerId) {
        return; // Non-owner should not overwrite
      }
      // Skip if cloud has newer content (prevents stale local data overwriting remote edits)
      const cloudUpdatedAt = cloudData.updatedAt?.toMillis?.() ?? 0;
      if (docData.updatedAt && cloudUpdatedAt > docData.updatedAt) {
        return;
      }
      // Never overwrite non-empty cloud content with empty local content
      if (!docData.content?.trim() && cloudData.content?.trim()) {
        return;
      }
    }
    const payload: Record<string, unknown> = {
      title: docData.title,
      content: docData.content,
      ownerId: docData.ownerId,
      folder: docData.folder ?? "/",
      tags: docData.tags ?? [],
      titlePinned: docData.titlePinned ?? false,
      updatedAt: docData.updatedAt
        ? Timestamp.fromMillis(docData.updatedAt)
        : serverTimestamp(),
    };
    if (docData.ownerName) payload.ownerName = docData.ownerName;
    if (docData.docType) payload.docType = docData.docType;
    if (docData.teamId !== undefined) payload.teamId = docData.teamId;
    if (docData.voiceTranscript !== undefined)
      payload.voiceTranscript = docData.voiceTranscript;
    if (docData.voiceGcsUri !== undefined)
      payload.voiceGcsUri = docData.voiceGcsUri;
    if (docData.voiceRecordedAt !== undefined)
      payload.voiceRecordedAt =
        docData.voiceRecordedAt !== null
          ? Timestamp.fromMillis(docData.voiceRecordedAt)
          : null;

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
  ownerName?: string;
  folder?: string;
  tags?: string[];
  docType?: string;
  titlePinned?: boolean;
}): Promise<void> {
  const ref = doc(firestore, DOCS_COLLECTION, docData.id);
  await setDoc(ref, {
    title: docData.title,
    content: docData.content || "",
    ownerId: docData.ownerId,
    ...(docData.ownerName ? { ownerName: docData.ownerName } : {}),
    collaborators: {},
    collaboratorUids: [],
    tags: docData.tags ?? [],
    folder: docData.folder ?? "/",
    titlePinned: docData.titlePinned ?? false,
    ...(docData.docType ? { docType: docData.docType } : {}),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

/** Fallback save using setDoc with merge — bypasses transaction issues, preserves collaborators/shareLink */
export async function saveDocumentMerge(docData: {
  id: string;
  title: string;
  content: string;
  ownerId: string;
  ownerName?: string;
  folder?: string;
  tags?: string[];
  docType?: string;
  titlePinned?: boolean;
  updatedAt?: number;
  teamId?: string | null;
  voiceTranscript?: string | null;
  voiceGcsUri?: string | null;
  voiceRecordedAt?: number | null;
}): Promise<void> {
  const ref = doc(firestore, DOCS_COLLECTION, docData.id);
  // Safety checks: owner, timestamp, and empty content — same guards as saveDocumentToFirestore
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const cloudData = snap.data();
    if (cloudData.ownerId && cloudData.ownerId !== docData.ownerId) return;
    const cloudUpdatedAt = cloudData.updatedAt?.toMillis?.() ?? 0;
    if (docData.updatedAt && cloudUpdatedAt > docData.updatedAt) return;
    if (!docData.content?.trim() && cloudData.content?.trim()) return;
  }
  await setDoc(
    ref,
    {
      title: docData.title,
      content: docData.content,
      ownerId: docData.ownerId,
      ...(docData.ownerName ? { ownerName: docData.ownerName } : {}),
      folder: docData.folder ?? "/",
      tags: docData.tags ?? [],
      titlePinned: docData.titlePinned ?? false,
      ...(docData.docType ? { docType: docData.docType } : {}),
      ...(docData.teamId !== undefined ? { teamId: docData.teamId } : {}),
      ...(docData.voiceTranscript !== undefined
        ? { voiceTranscript: docData.voiceTranscript }
        : {}),
      ...(docData.voiceGcsUri !== undefined
        ? { voiceGcsUri: docData.voiceGcsUri }
        : {}),
      ...(docData.voiceRecordedAt !== undefined
        ? {
            voiceRecordedAt:
              docData.voiceRecordedAt !== null
                ? Timestamp.fromMillis(docData.voiceRecordedAt)
                : null,
          }
        : {}),
      updatedAt: docData.updatedAt
        ? Timestamp.fromMillis(docData.updatedAt)
        : serverTimestamp(),
    },
    { merge: true },
  );
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
  await setDoc(
    doc(firestore, DOCS_COLLECTION, docId),
    { shareLink },
    { merge: true },
  );
}

// ─── Publish URL management ─────────────────────────────────

export async function setPublishUrl(
  docId: string,
  publishUrl: string | null,
): Promise<void> {
  await setDoc(
    doc(firestore, DOCS_COLLECTION, docId),
    {
      publishUrl: publishUrl,
      publishedAt: publishUrl ? serverTimestamp() : null,
    },
    { merge: true },
  );
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
  version: {
    id: string;
    content: string;
    title: string;
    message: string | null;
    createdAt: number;
  },
  ownerId: string,
  ownerName: string,
): Promise<void> {
  if (!version.content?.trim()) return;
  const ref = doc(
    firestore,
    DOCS_COLLECTION,
    documentId,
    "versions",
    version.id,
  );
  await setDoc(
    ref,
    {
      content: version.content,
      title: version.title,
      message: version.message,
      createdAt: version.createdAt,
      ownerId,
      ownerName,
    },
    { merge: true },
  );
}

export async function fetchVersionsFromCloud(
  documentId: string,
): Promise<FirestoreVersion[]> {
  const q = query(
    collection(firestore, DOCS_COLLECTION, documentId, "versions"),
    orderBy("createdAt", "desc"),
  );
  const snap = await getDocs(q);
  return snap.docs.map(
    (d) =>
      ({
        id: d.id,
        documentId,
        ...d.data(),
      }) as FirestoreVersion,
  );
}

export async function deleteVersionFromCloud(
  documentId: string,
  versionId: string,
): Promise<void> {
  await deleteDoc(
    doc(firestore, DOCS_COLLECTION, documentId, "versions", versionId),
  );
}

// ─── User settings (theme, preferences) ─────────────────────

const SETTINGS_COLLECTION = "user_settings";

export async function saveUserSettingsToFirestore(
  uid: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const ref = doc(firestore, SETTINGS_COLLECTION, uid);
  await setDoc(
    ref,
    { ...settings, updatedAt: serverTimestamp() },
    { merge: true },
  );
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
  const ref = doc(
    firestore,
    SETTINGS_COLLECTION,
    uid,
    "ai_chats",
    `${docId}__meta`,
  );
  await setDoc(ref, { threads, updatedAt: serverTimestamp() });
}

/** Fetch thread list metadata for a document */
export async function fetchAiThreadsFromCloud(
  uid: string,
  docId: string,
): Promise<{ id: string; title: string; createdAt: number }[] | null> {
  const ref = doc(
    firestore,
    SETTINGS_COLLECTION,
    uid,
    "ai_chats",
    `${docId}__meta`,
  );
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return (snap.data().threads || []) as {
    id: string;
    title: string;
    createdAt: number;
  }[];
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
      error:
        error instanceof Error
          ? { message: error.message, code: (error as { code?: string }).code }
          : String(error),
      meta: meta ?? {},
      createdAt: serverTimestamp(),
      appVersion:
        (globalThis as Record<string, unknown>).__APP_VERSION__ ?? "unknown",
    });
  } catch {
    // Best-effort — don't throw if logging itself fails
  }
}

// --- Test-only: Email/Password login for E2E testing ---
// Exposed as window.__TEST_LOGIN__ so WebDriverIO can call it via browser.execute()
if (import.meta.env.VITE_TEST_MODE === "1") {
  (window as unknown as Record<string, unknown>).__TEST_LOGIN__ = async (
    email: string,
    password: string,
  ): Promise<string> => {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    // Ensure user profile is saved to Firestore BEFORE returning.
    // Without this, addCollaborator's email→UID lookup fails and
    // collaboratorUids won't contain this user's UID.
    const firestore = getFirestore();
    await setDoc(
      doc(firestore, "users", cred.user.uid),
      {
        email: cred.user.email || email,
        displayName: cred.user.displayName,
        lastSeen: serverTimestamp(),
      },
      { merge: true },
    );
    return cred.user.uid;
  };

  // Force syncFromCloud — more reliable than page reload for E2E tests
  (window as unknown as Record<string, unknown>).__TEST_FORCE_SYNC__ =
    async (): Promise<string> => {
      try {
        const { useAuthStore } = await import("../stores/auth-store");
        await useAuthStore.getState().syncFromCloud();
        return "ok";
      } catch (e: unknown) {
        return "error:" + (e instanceof Error ? e.message : String(e));
      }
    };

  // Verify sharing state — check if a doc has collaboratorUids for debugging
  (window as unknown as Record<string, unknown>).__TEST_GET_SHARED_DOCS__ =
    async (): Promise<string> => {
      try {
        const currentUser = getAuth().currentUser;
        if (!currentUser) return "error:not_logged_in";
        const { fetchSharedWithMe } = await import("./sharing");
        const docs = await fetchSharedWithMe(currentUser.uid);
        return JSON.stringify(docs);
      } catch (e: unknown) {
        return "error:" + (e instanceof Error ? e.message : String(e));
      }
    };

  // Programmatic share: save doc to Firestore + add collaborator (bypasses UI)
  (window as unknown as Record<string, unknown>).__TEST_SHARE_DOC__ = async (
    email: string,
    role: string,
  ): Promise<string> => {
    try {
      const currentUser = getAuth().currentUser;
      if (!currentUser) return "error:not_logged_in";
      const { useAppStore } = await import("../stores/app-store");
      const state = useAppStore.getState();
      const activeDocId = state.activeDocId;
      if (!activeDocId) return "error:no_active_doc";
      const activeDoc = state.documents.find((d) => d.id === activeDocId);
      if (!activeDoc) return "error:doc_not_found";

      const docPayload = {
        id: activeDocId,
        title: activeDoc.title,
        content: activeDoc.content,
        ownerId: activeDoc.ownerId || currentUser.uid,
        ownerName: currentUser.displayName || currentUser.email || undefined,
        folder: activeDoc.folder,
        tags: activeDoc.tags,
        titlePinned: activeDoc.titlePinned,
      };

      // Save to Firestore first — try save, fall back to create for new docs
      try {
        await saveDocumentToFirestore(docPayload);
      } catch {
        // saveDocumentToFirestore uses transaction.get which fails on
        // non-existent docs due to Firestore read rules. Fall back to create.
        await createDocumentInFirestore(docPayload);
      }

      // Add collaborator
      const { addCollaborator } = await import("./sharing");
      await addCollaborator(activeDocId, email, role as "editor" | "viewer");
      return "ok:" + activeDocId;
    } catch (e: unknown) {
      return "error:" + (e instanceof Error ? e.message : String(e));
    }
  };

  // Save active doc directly to Firestore (bypasses syncToCloud transaction issues)
  (window as unknown as Record<string, unknown>).__TEST_SAVE_TO_CLOUD__ =
    async (): Promise<string> => {
      try {
        const currentUser = getAuth().currentUser;
        if (!currentUser) return "error:not_logged_in";
        const { useAppStore } = await import("../stores/app-store");
        const state = useAppStore.getState();
        const activeDocId = state.activeDocId;
        if (!activeDocId) return "error:no_active_doc";
        const activeDoc = state.documents.find((d) => d.id === activeDocId);
        if (!activeDoc) return "error:doc_not_found";

        const firestore = getFirestore();
        const ref = doc(firestore, "documents", activeDocId);
        // Use set with merge to avoid transaction read-rule issues
        await setDoc(
          ref,
          {
            title: activeDoc.title,
            content: activeDoc.content,
            ownerId: activeDoc.ownerId || currentUser.uid,
            ownerName:
              currentUser.displayName || currentUser.email || undefined,
            folder: activeDoc.folder ?? "/",
            tags: activeDoc.tags ?? [],
            titlePinned: activeDoc.titlePinned ?? false,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
        return "ok";
      } catch (e: unknown) {
        return "error:" + (e instanceof Error ? e.message : String(e));
      }
    };

  // Debug: get current user UID
  (window as unknown as Record<string, unknown>).__TEST_GET_UID__ =
    (): string => {
      const currentUser = getAuth().currentUser;
      return currentUser ? currentUser.uid : "not_logged_in";
    };

  // Debug: check document info in Firestore
  (window as unknown as Record<string, unknown>).__TEST_DOC_INFO__ = async (
    docId: string,
  ): Promise<string> => {
    try {
      const firestore = getFirestore();
      const snap = await getDoc(doc(firestore, "documents", docId));
      if (!snap.exists()) return "not_found";
      const data = snap.data();
      return JSON.stringify({
        title: data.title,
        ownerId: data.ownerId,
        collaborators: data.collaborators,
        collaboratorUids: data.collaboratorUids,
      });
    } catch (e: unknown) {
      return "error:" + (e instanceof Error ? e.message : String(e));
    }
  };

  (window as unknown as Record<string, unknown>).__TEST_CREATE_TEAM__ = async (
    teamName: string,
  ): Promise<string> => {
    try {
      const currentUser = getAuth().currentUser;
      if (!currentUser) return "error:not_logged_in";
      const { createTeam } = await import("./sharing");
      const teamId = await createTeam(teamName, {
        uid: currentUser.uid,
        email: currentUser.email || "",
      });
      return "ok:" + teamId;
    } catch (e: unknown) {
      return "error:" + (e instanceof Error ? e.message : String(e));
    }
  };

  (window as unknown as Record<string, unknown>).__TEST_ADD_TEAM_MEMBER__ =
    async (argsJson: string): Promise<string> => {
      try {
        const { teamId, email, role } = JSON.parse(argsJson);
        const { addTeamMember } = await import("./sharing");
        await addTeamMember(teamId, { email, role: role || "member" });
        return "ok";
      } catch (e: unknown) {
        return "error:" + (e instanceof Error ? e.message : String(e));
      }
    };

  (window as unknown as Record<string, unknown>).__TEST_CREATE_TEAM_DOC__ =
    async (argsJson: string): Promise<string> => {
      try {
        const { teamId, title, content } = JSON.parse(argsJson);
        const currentUser = getAuth().currentUser;
        if (!currentUser) return "error:not_logged_in";
        const { createTeamDocument } = await import("./sharing");
        const docId = await createTeamDocument(
          teamId,
          currentUser.uid,
          currentUser.displayName || currentUser.email || undefined,
        );
        // Update title and content after creation
        const firestore = getFirestore();
        const ref = doc(firestore, "documents", docId);
        await setDoc(
          ref,
          {
            title,
            content,
            ownerName:
              currentUser.displayName || currentUser.email || undefined,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
        return "ok:" + docId;
      } catch (e: unknown) {
        return "error:" + (e instanceof Error ? e.message : String(e));
      }
    };
}

// --- Research Sessions ---

import type { ResearchCard } from "@/stores/research-store";

export async function saveResearchSession(
  documentId: string,
  session: {
    id: string;
    cards: ResearchCard[];
    startedAt: number;
    endedAt: number | null;
    ownerId: string;
  },
): Promise<void> {
  const ref = doc(
    firestore,
    DOCS_COLLECTION,
    documentId,
    "research_sessions",
    session.id,
  );
  await setDoc(
    ref,
    {
      cards: session.cards.map((c) => ({
        id: c.id,
        timestamp: c.timestamp,
        trigger: c.trigger,
        query: c.query,
        type: c.type,
        summary: c.summary,
        sources: c.sources,
        credibility: c.credibility,
        integrated: c.integrated,
      })),
      startedAt: Timestamp.fromMillis(session.startedAt),
      endedAt: session.endedAt ? Timestamp.fromMillis(session.endedAt) : null,
      ownerId: session.ownerId,
    },
    { merge: true },
  );
}

export async function fetchResearchSessions(documentId: string): Promise<
  Array<{
    id: string;
    cards: ResearchCard[];
    startedAt: number;
    endedAt: number | null;
    ownerId: string;
  }>
> {
  const q = query(
    collection(firestore, DOCS_COLLECTION, documentId, "research_sessions"),
    orderBy("startedAt", "desc"),
  );
  const snap = await getDocs(q);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return snap.docs.map((d) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = d.data() as any;
    return {
      id: d.id,
      cards: data.cards || [],
      startedAt: data.startedAt?.toMillis?.() || 0,
      endedAt: data.endedAt?.toMillis?.() || null,
      ownerId: data.ownerId || "",
    };
  });
}
