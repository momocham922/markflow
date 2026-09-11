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
import {
  saveUserProfile,
  fetchSharedWithMe,
  fetchUserTeams,
  fetchTeamDocuments,
} from "@/services/sharing";
import { useAppStore, type Document, type DocType } from "./app-store";
import { useEntitlementStore } from "./entitlement-store";
import { useResearchStore } from "./research-store";
import {
  getDeletedDocIds,
  clearDeletedDoc,
  getSetting,
  setSetting,
  purgeForeignDocuments,
} from "@/services/database";
import { wipeLocalUserData } from "@/services/local-reset";

// Persisted marker of the last account that synced on THIS device. A mismatch on
// login means a DIFFERENT user signed in and the local cache must be purged.
const LAST_UID_KEY = "last_signed_in_uid";

// --- One-time backfill: upload local SQLite versions to Firestore ---
let versionBackfillDone = false;
async function backfillLocalVersionsToCloud(uid: string, displayName: string) {
  if (versionBackfillDone) return;
  versionBackfillDone = true;

  try {
    const { getSetting, setSetting, getAllVersions } =
      await import("@/services/database");
    const flag = await getSetting("versions_backfill_v2_done");
    if (flag === "1") return;

    const allVersions = await getAllVersions();
    if (allVersions.length === 0) {
      await setSetting("versions_backfill_v2_done", "1");
      return;
    }

    const { syncVersionToCloud, fetchVersionsFromCloud, logErrorToCloud } =
      await import("@/services/firebase");

    // Collect existing cloud version IDs per document to avoid overwriting
    // other users' ownerId/ownerName with the backfilling user's info
    const docIds = [...new Set(allVersions.map((v) => v.document_id))];
    const existingCloudIds = new Set<string>();
    for (const did of docIds) {
      try {
        const cloudVersions = await fetchVersionsFromCloud(did);
        for (const cv of cloudVersions) existingCloudIds.add(cv.id);
      } catch (e) {
        console.warn(
          "[backfill] Failed to fetch cloud versions for doc",
          did,
          e,
        );
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
        console.error(
          "[backfill] Failed to upload version",
          v.id,
          "for doc",
          v.document_id,
          e,
        );
        logErrorToCloud(uid, "backfill-version-upload", e, {
          versionId: v.id,
          docId: v.document_id,
        });
      }
    }
    console.log(
      `[auth-store] Backfilled ${uploaded}/${allVersions.length} local versions to Firestore`,
    );
    await setSetting("versions_backfill_v2_done", "1");
  } catch (e) {
    console.error("[auth-store] Version backfill failed:", e);
    // Allow retry on next startup
    versionBackfillDone = false;
  }
}

// --- Sync mutex: prevents concurrent syncFromCloud / syncToCloud ---
// Try-lock: if already running, drop the call (next 60s interval will catch up).
let syncLocked = false;
// Spinner watchdog: an iOS/WKWebView Firestore call can hang with no timeout,
// leaving the caller's `set({ syncing: true })` stuck (the StatusBar spinner
// spins forever). Force the flag back off after 60s so the UI never lies — the
// lock is left as-is (the pre-existing try-lock semantics are unchanged); a hung
// operation still resolves/rejects on its own and its finally is idempotent.
let syncWatchdog: ReturnType<typeof setTimeout> | null = null;
function armSyncWatchdog() {
  if (syncWatchdog) clearTimeout(syncWatchdog);
  syncWatchdog = setTimeout(() => {
    syncWatchdog = null;
    if (useAuthStore.getState().syncing) {
      console.warn("[auth-store] sync watchdog: clearing stuck syncing flag");
      useAuthStore.setState({ syncing: false });
    }
  }, 60_000);
}
function disarmSyncWatchdog() {
  if (syncWatchdog) {
    clearTimeout(syncWatchdog);
    syncWatchdog = null;
  }
}
// Force-release the try-lock. Called on logout so a still-running (or hung)
// pre-logout flush can't starve the NEXT account's login sync — without this,
// B's syncFromCloud is silently dropped and B's sidebar stays empty until the
// 60s interval. The stale flush keeps its own captured uid/docs, so releasing
// early cannot cross-contaminate accounts.
function resetSyncLock() {
  syncLocked = false;
  disarmSyncWatchdog();
}
async function withSyncLock<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (syncLocked) return undefined;
  syncLocked = true;
  armSyncWatchdog();
  try {
    return await fn();
  } finally {
    syncLocked = false;
    disarmSyncWatchdog();
  }
}

// --- Active collab tracking: docs currently being edited via Yjs ---
// Editor sets this so sync knows not to overwrite content
const collabActiveDocIds = new Set<string>();

// --- Track docs pulled from cloud during syncFromCloud ---
// Prevents syncToCloud from re-uploading docs that were just downloaded
const cloudPulledDocIds = new Set<string>();
export function markCollabActive(docId: string) {
  collabActiveDocIds.add(docId);
}
export function markCollabInactive(docId: string) {
  collabActiveDocIds.delete(docId);
}

// Map raw login errors to actionable Japanese guidance. A bare "Failed to fetch"
// (fetch TypeError) or Firebase "auth/network-request-failed" means the device
// could not reach our HTTPS backend — almost always a corporate proxy/VPN
// (e.g. VeronaSASE-style TLS inspection without the corp root CA on the device),
// a wrong device clock breaking TLS, or no connectivity — NOT an app/server bug.
// Surfacing the raw English string leaves testers stuck; give them the next step.
function friendlyLoginError(raw: string): string {
  const s = raw.toLowerCase();
  if (
    s.includes("failed to fetch") ||
    s.includes("networkerror") ||
    s.includes("network error") ||
    s.includes("network-request-failed") ||
    s.includes("load failed") ||
    s.includes("token exchange failed") ||
    s.includes("aborted") ||
    s.includes("abort")
  ) {
    return "サーバーに接続できませんでした。社内ネットワークやVPN・プロキシをご利用の場合はブロックされていることがあります。モバイル回線など別のネットワークで再度お試しください。改善しない場合は端末の日時設定が自動になっているかご確認のうえ、IT管理者にご相談ください。";
  }
  if (s.includes("timed out") || s.includes("timeout")) {
    return "ログインがタイムアウトしました。ネットワークの状態をご確認のうえ、もう一度お試しください。";
  }
  if (s.includes("popup") && s.includes("closed")) {
    return "ログイン画面が閉じられました。もう一度お試しください。";
  }
  return raw;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  isOnline: boolean;
  syncing: boolean;
  loginError: string | null;
  init: () => () => void;
  login: (provider?: "google" | "github") => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Permanently delete the signed-in account and ALL its data (Apple 5.1.1(v)).
   * Calls the ai-proxy cascade, transparently re-authenticating once if the
   * server demands a fresh sign-in, then wipes every local trace on success.
   */
  deleteAccount: () => Promise<{ ok: boolean; error?: string }>;
  syncToCloud: () => Promise<boolean>;
  syncFromCloud: () => Promise<void>;
  deleteFromCloud: (docId: string) => Promise<void>;
  resetCloudAndReSync: () => Promise<{ ok: boolean; failed: number }>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  loading: true,
  isOnline: navigator.onLine,
  syncing: false,
  loginError: null,

  init: () => {
    // onAuthChange = onAuthStateChanged: fires on sign-in/sign-out/initial only
    // (NOT on hourly token refresh), so the account-switch purge + rehydrate
    // below run exactly once per real auth transition.
    const unsubAuth = onAuthChange(async (user) => {
      set({ user, loading: false });
      if (user) {
        // --- Account-switch isolation (data privacy) ---------------------
        // SQLite is a single per-device cache with NO per-user scoping. If a
        // DIFFERENT account signed in since last time, the previous user's
        // PRIVATE docs (owned by them, not shared) survive sync reconciliation
        // and leak into this user's sidebar. Purge the local cache BEFORE any
        // sync so the new account starts clean.
        try {
          const prevUid = await getSetting(LAST_UID_KEY);
          if (prevUid && prevUid !== user.uid) {
            console.warn(
              `[auth-store] Account switch ${prevUid} → ${user.uid}: purging local cache`,
            );
            // Clear in-memory + cancel pending saves FIRST (so no timer can
            // re-insert an old doc during the async wipe), then purge SQLite +
            // Yjs IndexedDB.
            useAppStore.getState().resetLocalDocuments();
            await wipeLocalUserData();
            // Drop the previous account's in-memory research cards (content) and
            // re-read prefs now that local-reset cleared their localStorage keys.
            useResearchStore.getState().reset();
            // Drop cross-account tracking so the new user's sync is clean.
            collabActiveDocIds.clear();
            cloudPulledDocIds.clear();
            versionBackfillDone = false;
          }
          await setSetting(LAST_UID_KEY, user.uid);
        } catch (e) {
          console.error("[auth-store] account-switch check failed:", e);
        }

        // --- Fail-closed isolation guard (runs UNCONDITIONALLY) --------------
        // The LAST_UID purge above is best-effort: on iOS/WKWebView getSetting or
        // wipeLocalUserData can throw (SQLITE_BUSY under concurrent login queries)
        // and the whole block is skipped, or an in-flight A-sync revives a row
        // after the wipe. So independently of prevUid, remove every PRIVATE doc
        // owned by another account from BOTH SQLite and the in-memory list. This
        // does not depend on getSetting/wipe succeeding, so a foreign account's
        // private docs can never remain in the sidebar. Own/unclaimed/shared/team
        // docs are preserved (see purgeForeignDocuments / dropForeignDocuments).
        try {
          const removed = await purgeForeignDocuments(user.uid);
          if (removed > 0) {
            console.warn(
              `[auth-store] Fail-closed purge removed ${removed} foreign private doc(s) from local cache`,
            );
          }
        } catch (e) {
          console.error("[auth-store] foreign-doc purge failed:", e);
        }
        // Cold start loads SQLite BEFORE auth resolves, so foreign rows may already
        // be in memory even after the DB purge above — drop them from the store too.
        useAppStore.getState().dropForeignDocuments(user.uid);

        // Rehydrate the in-memory list from THIS account's local cache. After a
        // switch-purge that yields [] (SQLite is empty); after a same-account
        // re-login (logout cleared the in-memory list) it restores the cached
        // docs so the sidebar is correct even offline. On cold start the
        // App.tsx effect already populated it, so skip to avoid a double load.
        const app = useAppStore.getState();
        if (app.initialized && app.documents.length === 0) {
          await app.loadDocuments();
        }

        // Save user profile for collaborator lookups
        saveUserProfile({
          uid: user.uid,
          email: user.email || "",
          displayName: user.displayName,
        }).catch(() => {});
        // Load plan/entitlement (drives quota UI + owner view-as switcher).
        useEntitlementStore
          .getState()
          .fetchEntitlement()
          .catch(() => {});
        // Wait for loadDocuments to complete before syncing from cloud.
        // Without this, syncFromCloud may see default themeSettings and
        // overwrite correct SQLite values with stale cloud values.
        const syncThenBackfill = async () => {
          // Re-run the fail-closed drop here because this is the ONE point
          // guaranteed to execute AFTER loadDocuments' final set() has landed
          // (it runs either because app was already initialized, or via the
          // subscribe below that fires ON initialized becoming true). Closes the
          // TOCTOU where App.tsx's initial loadDocuments — started before auth
          // resolved — captures the previous account's rows and lands its set()
          // AFTER the drop at line 266, re-injecting foreign private docs into
          // the store. Idempotent no-op when the store is already clean.
          useAppStore.getState().dropForeignDocuments(user.uid);
          const syncStartedAt = Date.now();
          await get().syncFromCloud();
          const uploaded = await get().syncToCloud();
          // Only advance lastSyncAt if syncToCloud actually ran (not dropped by lock)
          if (uploaded) {
            try {
              const { setSetting } = await import("@/services/database");
              await setSetting("lastSyncAt", String(syncStartedAt));
            } catch {
              /* ignore */
            }
          }
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
        const syncStartedAt = Date.now();
        await get().syncFromCloud();
        const uploaded = await get().syncToCloud();
        if (uploaded) {
          try {
            const { setSetting } = await import("@/services/database");
            await setSetting("lastSyncAt", String(syncStartedAt));
          } catch {
            /* ignore */
          }
        }
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
        const syncStartedAt = Date.now();
        await get().syncFromCloud();
        const uploaded = await get().syncToCloud();
        if (uploaded) {
          try {
            const { setSetting } = await import("@/services/database");
            await setSetting("lastSyncAt", String(syncStartedAt));
          } catch {
            /* ignore */
          }
        }
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
      const { track } = await import("@/services/telemetry");
      track("sign_in", { provider });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error("Login failed:", error);
      set({ loginError: friendlyLoginError(raw) });
    }
  },

  logout: async () => {
    // Flush any unsynced local edits BEFORE dropping the session. An account
    // switch is logout-A → login-B, and B's login purges the shared (un-scoped)
    // local cache. Once B is authenticated we can no longer upload as A, so this
    // is A's last chance to persist offline/dirty work to the cloud. Best-effort
    // and time-boxed (8s) so a slow network never hangs logout; if A is offline
    // the edits remain in SQLite for A's next same-account login (only a later
    // different-account login on this device would purge them — an inherent limit
    // of a device-shared local cache, not a silent drop of reachable data).
    try {
      const { user, isOnline } = get();
      if (user && isOnline) {
        await Promise.race([
          get().syncToCloud(),
          new Promise<void>((resolve) => setTimeout(resolve, 8000)),
        ]);
      }
    } catch (e) {
      console.error("[auth-store] pre-logout flush failed:", e);
    }
    try {
      await signOut();
    } catch (error) {
      console.error("Logout failed:", error);
    } finally {
      // Clear the session + in-memory docs regardless of signOut outcome, so the
      // sidebar never shows the previous account's documents after logout. SQLite
      // is intentionally KEPT (a same-account re-login rehydrates from it, works
      // offline); a DIFFERENT account signing in purges it via the switch check.
      // Also drop `syncing` so a stuck spinner from an in-flight sync can't
      // persist across the logout.
      set({ user: null, syncing: false });
      // Release the sync try-lock so the NEXT account's login sync isn't starved
      // by a still-running/hung pre-logout flush (would leave B's sidebar empty).
      resetSyncLock();
      useAppStore.getState().resetLocalDocuments();
      useEntitlementStore.getState().reset();
      // Research cards are user content — clear them so the login screen (and any
      // next account) never shows the previous user's research.
      useResearchStore.getState().reset();
    }
  },

  deleteAccount: async (): Promise<{ ok: boolean; error?: string }> => {
    const proxyBase = import.meta.env.VITE_AI_PROXY_URL || "";
    if (!proxyBase) {
      return { ok: false, error: "削除サービスに接続できません。" };
    }
    if (!get().isOnline) {
      return {
        ok: false,
        error: "オフラインです。オンラインに接続してから再度お試しください。",
      };
    }

    // POST the delete with a FRESH id token (force-refresh). The server also
    // requires a recent sign-in (auth_time within 5 min); when it isn't, it
    // returns 401 reauth_required and we re-run the provider sign-in once.
    const callDelete = async (): Promise<Response> => {
      const { auth } = await import("@/services/firebase");
      const current = auth.currentUser;
      if (!current) throw new Error("not_signed_in");
      const token = await current.getIdToken(true);
      return fetch(`${proxyBase}/v1/account/delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
    };

    try {
      let res = await callDelete();
      if (res.status === 401) {
        let body: { error?: string } = {};
        try {
          body = (await res.clone().json()) as { error?: string };
        } catch {
          /* non-JSON */
        }
        if (body.error === "reauth_required" || body.error === "unauthorized") {
          // Re-authenticate via the user's ORIGINAL provider, then retry once.
          const { auth } = await import("@/services/firebase");
          const providerId =
            auth.currentUser?.providerData?.[0]?.providerId || "";
          if (providerId.includes("github")) await signInWithGitHub();
          else await signInWithGoogle();
          res = await callDelete();
        }
      }

      if (!res.ok) {
        let err =
          "アカウントの削除に失敗しました。時間をおいて再度お試しください。";
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error === "reauth_required") {
            err =
              "セキュリティのため再ログインが必要です。もう一度お試しください。";
          }
        } catch {
          /* keep default */
        }
        return { ok: false, error: err };
      }

      // Success: the server deleted the Firebase Auth user AND all cloud data.
      // Purge every local trace on this device and drop the session.
      try {
        await wipeLocalUserData();
      } catch (e) {
        console.error("[auth-store] post-delete local wipe failed:", e);
      }
      try {
        await signOut();
      } catch {
        /* session is already invalid server-side; ignore */
      }
      set({ user: null, syncing: false });
      useAppStore.getState().resetLocalDocuments();
      useEntitlementStore.getState().reset();
      useResearchStore.getState().reset();
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[auth-store] deleteAccount failed:", msg);
      return { ok: false, error: "アカウントの削除に失敗しました。" };
    }
  },

  syncFromCloud: async () => {
    const { user, isOnline } = get();
    if (!user || !isOnline) return;

    const result = await withSyncLock(async () => {
      set({ syncing: true });
      // --- Account-switch generation guard (data isolation, P0) --------------
      // This sync captured `user` (= account A) at call time and then performs
      // many awaited fetches. If account B signs in mid-flight, onAuthChange has
      // already set `user = B` in the store (and purged A's local cache), so any
      // store write we still make below would REVIVE A's private docs into B's
      // sidebar — the exact leak we are closing. `isStale()` returns true once
      // the live session uid no longer matches the uid this sync started with
      // (a different account, or a logout to null); we bail before every batch of
      // store writes so a late-completing A-sync can never pollute B.
      const syncUid = user.uid;
      const isStale = () => get().user?.uid !== syncUid;
      try {
        // Load locally deleted doc IDs to skip during sync
        let deletedDocIds: Set<string>;
        try {
          deletedDocIds = await getDeletedDocIds();
        } catch {
          deletedDocIds = new Set();
        }

        // Parallel fetch: user docs, shared docs, teams, and user settings.
        // Track per-source success: a transient fetch failure returns [] and must
        // NOT be mistaken for "the owner removed every shared/team doc" during
        // deletion reconciliation (that would tombstone-delete valid docs).
        let sharedOk = true;
        let teamsOk = true;
        const [cloudDocs, sharedDocs, teams, cloudSettings] = await Promise.all(
          [
            fetchUserDocuments(user.uid),
            fetchSharedWithMe(user.uid).catch((err) => {
              console.error("Fetch shared docs failed:", err);
              sharedOk = false;
              return [] as Awaited<ReturnType<typeof fetchSharedWithMe>>;
            }),
            fetchUserTeams(user.uid).catch((err) => {
              console.error("Fetch teams failed:", err);
              teamsOk = false;
              return [] as Awaited<ReturnType<typeof fetchUserTeams>>;
            }),
            fetchUserSettings(user.uid).catch(() => null),
          ],
        );

        // Account switched while we were fetching — abandon before any write.
        if (isStale()) return;

        // Restore all user settings from cloud
        if (cloudSettings) {
          const appStore = useAppStore.getState();

          // Theme
          if (cloudSettings.theme && typeof cloudSettings.theme === "string") {
            const cloudThemeMode = cloudSettings.theme as "light" | "dark";
            if (appStore.theme !== cloudThemeMode) {
              document.documentElement.classList.toggle(
                "dark",
                cloudThemeMode === "dark",
              );
              useAppStore.setState({ theme: cloudThemeMode });
            }
          }

          // Theme settings (only if local has defaults)
          const local = appStore.themeSettings;
          const defaults = {
            previewTheme: "github",
            editorTheme: "default",
            mindMapTheme: "lavender",
            customPreviewCss: "",
          };
          const isDefault =
            local.previewTheme === defaults.previewTheme &&
            local.editorTheme === defaults.editorTheme &&
            local.mindMapTheme === defaults.mindMapTheme;
          if (isDefault && cloudSettings.themeSettings) {
            try {
              const cloudTheme =
                typeof cloudSettings.themeSettings === "string"
                  ? JSON.parse(cloudSettings.themeSettings as string)
                  : cloudSettings.themeSettings;
              appStore.setThemeSettings(cloudTheme);
            } catch {
              /* ignore parse errors */
            }
          }

          // Folders
          if (
            Array.isArray(cloudSettings.folders) &&
            cloudSettings.folders.length > 0
          ) {
            const localFolders = appStore.folders;
            if (localFolders.length <= 1) {
              // Local has only "/" default — restore from cloud
              const restored = [
                "/",
                ...cloudSettings.folders.filter((f: unknown) => f !== "/"),
              ];
              useAppStore.setState({ folders: restored as string[] });
            }
          }

          // Custom preview themes
          if (
            Array.isArray(cloudSettings.customPreviewThemes) &&
            cloudSettings.customPreviewThemes.length > 0
          ) {
            if (appStore.customPreviewThemes.length === 0) {
              useAppStore.setState({
                customPreviewThemes:
                  cloudSettings.customPreviewThemes as typeof appStore.customPreviewThemes,
              });
            }
          }

          // AI custom rules, MCP servers, Slack config → write to SQLite
          try {
            const { setSetting } = await import("@/services/database");
            if (
              cloudSettings.ai_custom_rules &&
              typeof cloudSettings.ai_custom_rules === "string"
            ) {
              await setSetting(
                "ai_custom_rules",
                cloudSettings.ai_custom_rules,
              ).catch(() => {});
            }
            if (
              cloudSettings.mcp_servers &&
              typeof cloudSettings.mcp_servers === "string"
            ) {
              await setSetting("mcp_servers", cloudSettings.mcp_servers).catch(
                () => {},
              );
            }
            if (
              cloudSettings.slack_notify_config &&
              typeof cloudSettings.slack_notify_config === "string"
            ) {
              await setSetting(
                "slack_notify_config",
                cloudSettings.slack_notify_config,
              ).catch(() => {});
            }
          } catch {
            /* DB not available */
          }
        }

        if (isStale()) return;
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
          if (isStale()) return; // account switched mid-merge — stop writing
          if (deletedDocIds.has(cloudDoc.id)) continue; // skip locally deleted

          cloudDocIds.add(cloudDoc.id);
          if (!cloudDoc.content?.trim()) continue; // track existence but skip empty content
          const local = localDocs.find((d) => d.id === cloudDoc.id);
          if (!local) {
            const hasCollaborators =
              cloudDoc.collaborators &&
              Object.keys(cloudDoc.collaborators).length > 0;
            const newDoc: Document = {
              id: cloudDoc.id,
              title: cloudDoc.title,
              content: cloudDoc.content,
              createdAt: cloudDoc.createdAt?.toMillis() ?? Date.now(),
              updatedAt: cloudDoc.updatedAt?.toMillis() ?? Date.now(),
              folder: cloudDoc.folder ?? "/",
              tags: cloudDoc.tags ?? [],
              ownerId: user.uid,
              // "Shared" (sidebar badge + yCollab gate) means real collaborators
              // or a team doc — NOT a mere share link. Link recipients edit via
              // SharedDocView (direct Firestore write), so a link alone doesn't
              // make the owner's copy collaborative and shouldn't show the badge.
              isShared: hasCollaborators || !!cloudDoc.teamId,
              docType: (cloudDoc.docType as DocType) || "markdown",
              voiceTranscript: cloudDoc.voiceTranscript ?? null,
              voiceGcsUri: cloudDoc.voiceGcsUri ?? null,
              voiceRecordedAt: cloudDoc.voiceRecordedAt?.toMillis() ?? null,
            };
            await appStore.addDocument(newDoc);
            cloudPulledDocIds.add(cloudDoc.id);
          } else {
            const hasCollaborators =
              cloudDoc.collaborators &&
              Object.keys(cloudDoc.collaborators).length > 0;
            const cloudUpdatedAt = cloudDoc.updatedAt?.toMillis() ?? 0;
            const updates: Partial<Document> = {
              ownerId: user.uid,
              // See note above: a share link alone is not "shared" for the badge.
              isShared: hasCollaborators || !!cloudDoc.teamId,
            };
            if (
              cloudDoc.folder &&
              cloudDoc.folder !== "/" &&
              local.folder === "/"
            ) {
              updates.folder = cloudDoc.folder;
            }
            // Sync content/title from cloud if cloud version is newer
            if (
              cloudUpdatedAt > local.updatedAt &&
              !collabActiveDocIds.has(local.id)
            ) {
              if (cloudDoc.content?.trim()) {
                updates.content = cloudDoc.content;
              }
              // Respect pinned titles: if local has a pinned title and cloud doesn't,
              // keep the local title. Otherwise sync from cloud.
              if (local.titlePinned && !cloudDoc.titlePinned) {
                // Keep local pinned title
              } else {
                updates.title = cloudDoc.title;
                if (cloudDoc.titlePinned) {
                  updates.titlePinned = true;
                }
              }
              updates.updatedAt = cloudUpdatedAt;
              updates.folder = cloudDoc.folder ?? local.folder;
              updates.tags = cloudDoc.tags ?? local.tags;
              updates.docType = (cloudDoc.docType as DocType) || local.docType;
              // Mark as pulled from cloud — don't re-upload in syncToCloud
              cloudPulledDocIds.add(local.id);
            }
            // Voice fields sync INDEPENDENTLY of the content-freshness gate above:
            // a live transcript does NOT bump updatedAt, so a doc that only gained
            // a transcript on another device has cloudUpdatedAt == local.updatedAt
            // and would be missed by that gate — the transcript stayed invisible on
            // the other device (reported on Windows). Pull the cloud transcript
            // when it is present and strictly newer than ours (by voiceRecordedAt),
            // and never clobber a non-empty local transcript with an empty cloud
            // one. We do NOT add to cloudPulledDocIds here: if local ALSO has newer
            // content pending, it must still upload this cycle (re-uploading the
            // just-pulled voice fields is idempotent).
            const cloudVoiceAt = cloudDoc.voiceRecordedAt?.toMillis() ?? 0;
            const localVoiceAt = local.voiceRecordedAt ?? 0;
            if (
              cloudDoc.voiceTranscript &&
              cloudVoiceAt > localVoiceAt &&
              !collabActiveDocIds.has(local.id)
            ) {
              updates.voiceTranscript = cloudDoc.voiceTranscript;
              updates.voiceGcsUri = cloudDoc.voiceGcsUri ?? null;
              updates.voiceRecordedAt = cloudVoiceAt;
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
            if (isStale()) return; // account switched mid-batch
            for (let j = 0; j < batch.length; j++) {
              if (isStale()) return; // re-check: addDocument below awaits per item
              const fullDoc = results[j];
              const entry = batch[j];
              if (!fullDoc || !fullDoc.content?.trim()) {
                if (!entry.isNew)
                  appStore.updateDocument(entry.id, { isShared: true });
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
                const localDoc = useAppStore
                  .getState()
                  .documents.find((d) => d.id === entry.id);
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
                if (
                  !collabActiveDocIds.has(entry.id) &&
                  cloudUpdatedAt > localUpdatedAt
                ) {
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
              .catch(() => {
                // A single team's doc fetch failing must also suppress deletion
                // reconciliation — otherwise that team's docs get tombstoned.
                teamsOk = false;
                return [] as { id: string; teamId: string }[];
              }),
          ),
        );
        const teamDocsToFetch: {
          id: string;
          teamId: string;
          isNew: boolean;
        }[] = [];
        for (const teamDocs of teamDocBatches) {
          for (const td of teamDocs) {
            if (deletedDocIds.has(td.id)) continue;
            cloudDocIds.add(td.id);
            const currentDocs = useAppStore.getState().documents;
            const local = currentDocs.find((d) => d.id === td.id);
            if (local) {
              if (local.ownerId !== user.uid) {
                teamDocsToFetch.push({
                  id: td.id,
                  teamId: td.teamId,
                  isNew: false,
                });
              } else {
                appStore.updateDocument(td.id, {
                  isShared: true,
                  teamId: td.teamId,
                });
              }
            } else {
              teamDocsToFetch.push({
                id: td.id,
                teamId: td.teamId,
                isNew: true,
              });
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
            if (isStale()) return; // account switched mid-batch
            for (let j = 0; j < batch.length; j++) {
              if (isStale()) return; // re-check: addDocument below awaits per item
              const fullDoc = results[j];
              const entry = batch[j];
              if (!fullDoc || !fullDoc.content?.trim()) {
                if (!entry.isNew)
                  appStore.updateDocument(entry.id, {
                    isShared: true,
                    teamId: entry.teamId,
                  });
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
                  ownerName:
                    fullDoc.ownerName || teamOwnerMap.get(fullDoc.ownerId),
                  teamId: entry.teamId,
                  isShared: true,
                  docType: (fullDoc.docType as DocType) || "markdown",
                };
                await appStore.addDocument(newDoc);
              } else {
                // Non-owned team docs: Yjs/IndexedDB is source of truth for content.
                // Only update content/title if cloud version is genuinely newer.
                const localTeamDoc = useAppStore
                  .getState()
                  .documents.find((d) => d.id === entry.id);
                const cloudTeamUpdatedAt = fullDoc.updatedAt?.toMillis() ?? 0;
                const localTeamUpdatedAt = localTeamDoc?.updatedAt ?? 0;
                const updates: Partial<Document> = {
                  isShared: true,
                  teamId: entry.teamId,
                  titlePinned: true,
                  ownerName:
                    fullDoc.ownerName || teamOwnerMap.get(fullDoc.ownerId),
                };
                // Only update title/folder if cloud is newer (preserves local folder moves)
                if (cloudTeamUpdatedAt > localTeamUpdatedAt) {
                  updates.title = fullDoc.title;
                  updates.updatedAt = cloudTeamUpdatedAt;
                  updates.folder =
                    fullDoc.folder ?? localTeamDoc?.folder ?? "/";
                }
                // Never overwrite content for collab-active docs.
                // For inactive docs, only update if cloud is genuinely newer.
                if (
                  !collabActiveDocIds.has(entry.id) &&
                  cloudTeamUpdatedAt > localTeamUpdatedAt
                ) {
                  updates.content = fullDoc.content;
                }
                appStore.updateDocument(entry.id, updates);
              }
            }
          }
        }

        // Reconcile deletions: remove local docs that no longer exist in cloud.
        // For own docs: verify deletion by checking Firestore directly (never rely on timing alone)
        // For shared/team docs: remove if not in cloud (non-owner, cloud is source of truth)
        if (isStale()) return; // account switched — do not reconcile B's store as A
        const finalDocs = useAppStore.getState().documents;
        for (const local of finalDocs) {
          if (isStale()) return; // account switched mid-reconcile
          if (collabActiveDocIds.has(local.id)) continue; // skip actively edited docs
          if (cloudDocIds.has(local.id)) continue; // exists in cloud — keep

          if (local.ownerId === user.uid) {
            // Own doc not in query results. Could be:
            // a) Deleted on another device → should delete locally
            // b) Never synced / upload failed → must NOT delete
            //
            // GUARD (P0 data-loss fix): only a doc that was PREVIOUSLY synced to
            // the cloud (synced_at set) can be a genuine remote deletion. A doc
            // with synced_at == NULL has never been uploaded (created offline /
            // first sync still pending / earlier upload failed) — deleting it here
            // would permanently destroy content that syncToCloud is about to push.
            // syncFromCloud always runs BEFORE syncToCloud, so a freshly-created
            // local doc reaches this point unsynced by design.
            let everSynced = false;
            try {
              const { getDocument } = await import("@/services/database");
              const dbDoc = await getDocument(local.id);
              everSynced = !!(dbDoc && dbDoc.synced_at);
            } catch {
              // Can't read local sync state → keep the doc (fail safe).
              everSynced = false;
            }
            if (!everSynced) {
              continue; // never uploaded — keep; syncToCloud will push it
            }
            // Direct Firestore check is authoritative — no timing heuristics.
            try {
              const cloudDoc = await fetchDocument(local.id);
              if (!cloudDoc) {
                console.warn(
                  `[sync] Removing own doc ${local.id} "${local.title}" (confirmed deleted from cloud)`,
                );
                useAppStore.setState((s) => ({
                  documents: s.documents.filter((d) => d.id !== local.id),
                  activeDocId:
                    s.activeDocId === local.id ? null : s.activeDocId,
                }));
                try {
                  const { deleteDocument: dbDelete } =
                    await import("@/services/database");
                  await dbDelete(local.id);
                } catch {
                  /* ignore */
                }
              }
              // else: doc exists in Firestore but query missed it — keep locally, syncToCloud will handle
            } catch {
              // Firestore check failed (network?) — err on the side of keeping the doc
            }
          } else if (local.isShared || local.teamId) {
            // Non-owned shared/team doc not in cloud → removed by owner.
            // Only reconcile when the relevant source list actually loaded.
            // If the fetch failed (returned [] via .catch), we cannot tell
            // "removed by owner" from "transient network error" — deleting here
            // writes a 30-day tombstone that blocks re-sync, so skip instead.
            // fetchDocument re-check is NOT usable here: getDoc throws
            // permission-denied for both deleted AND access-revoked non-owned
            // docs, so it can't distinguish the cases.
            const isTeamDoc = !!local.teamId;
            if (isTeamDoc && !teamsOk) continue;
            if (!isTeamDoc && !sharedOk) continue;
            console.warn(
              `[sync] Removing non-owned doc ${local.id} (deleted from cloud)`,
            );
            await appStore.deleteDocument(local.id);
          }
        }

        // Any locally-present doc that exists in the cloud is, by definition,
        // synced — stamp synced_at so the reconciliation above treats a later
        // remote deletion correctly. markDocumentsSynced only touches existing
        // local rows, so passing the full cloud id set is safe.
        try {
          const { markDocumentsSynced } = await import("@/services/database");
          await markDocumentsSynced(Array.from(cloudDocIds));
        } catch (e) {
          console.error("Failed to mark cloud docs synced:", e);
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
    if (!user || !isOnline) return { ok: false, failed: 0 };

    const result = await withSyncLock(async () => {
      set({ syncing: true });
      // Count per-doc delete/upload failures that we swallow to keep going.
      // A non-zero count means the cloud does NOT fully match this device, so we
      // must NOT report unconditional success (サイレントフォールバック禁止).
      let failed = 0;
      try {
        // 1. Fetch all own docs from cloud
        const cloudDocs = await fetchUserDocuments(user.uid);
        const appState = useAppStore.getState();
        const localIds = new Set(
          appState.documents
            .filter((d) => !d.ownerId || d.ownerId === user.uid)
            .map((d) => d.id),
        );

        // 2. Delete cloud docs that don't exist locally (= garbage)
        let deleted = 0;
        for (const cd of cloudDocs) {
          if (!localIds.has(cd.id)) {
            try {
              await deleteDocumentFromFirestore(cd.id);
              deleted++;
            } catch (e) {
              failed++;
              console.error(`[resetCloud] Failed to delete ${cd.id}:`, e);
            }
          }
        }
        console.warn(`[resetCloud] Deleted ${deleted} garbage docs from cloud`);

        // 3. Re-upload all local docs to ensure cloud matches local
        const ownDocs = appState.documents.filter(
          (d) => (!d.ownerId || d.ownerId === user.uid) && d.content?.trim(),
        );
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
              titlePinned: d.titlePinned,
            });
          } catch (e) {
            failed++;
            console.error(`[resetCloud] Failed to upload ${d.id}:`, e);
          }
        }
        console.warn(`[resetCloud] Uploaded ${ownDocs.length} docs to cloud`);

        // 4. Clear deleted_docs table and update lastSyncAt
        try {
          const { setSetting } = await import("@/services/database");
          await setSetting("lastSyncAt", String(Date.now()));
        } catch {
          /* ignore */
        }
        // Clear all deleted_docs entries
        try {
          const deletedIds = await getDeletedDocIds();
          for (const id of deletedIds) {
            await clearDeletedDoc(id);
          }
        } catch {
          /* ignore */
        }

        console.warn(
          `[resetCloud] Cloud reset complete (${failed} per-doc failures).`,
        );
        return { ok: failed === 0, failed };
      } catch (error) {
        console.error("[resetCloud] Failed:", error);
        return { ok: false, failed };
      } finally {
        set({ syncing: false });
      }
    });
    // withSyncLock returns undefined if another sync held the lock (skipped).
    return result ?? { ok: false, failed: 0 };
  },

  syncToCloud: async () => {
    const { user, isOnline } = get();
    if (!user || !isOnline) return false;

    const result = await withSyncLock(async () => {
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
          } catch {
            /* DB not available */
          }
          saveUserSettingsToFirestore(user.uid, settingsToSync).catch((err) =>
            console.error("Failed to sync settings:", err),
          );
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
        } catch {
          /* ignore */
        }

        // Only upload docs that were locally modified since last sync cycle.
        // Skip docs just pulled from cloud (cloudPulledDocIds) to avoid ping-pong.
        // lastSyncAt is updated by the CALLER after both sync steps complete,
        // so it reflects the PREVIOUS cycle — not the one currently running.
        let lastSyncAt = 0;
        try {
          const { getSetting } = await import("@/services/database");
          const saved = await getSetting("lastSyncAt");
          if (saved) lastSyncAt = parseInt(saved, 10) || 0;
        } catch {
          /* DB not available */
        }

        const syncableDocs = documents.filter((d) => {
          if (d.ownerId && d.ownerId !== user.uid) return false; // non-owner
          if (cloudPulledDocIds.has(d.id)) return false; // just pulled from cloud
          if (!d.content?.trim()) return false; // never upload empty content
          // On first sync ever (lastSyncAt=0), upload everything.
          // After that, only upload docs modified OR created since last sync cycle.
          // Also check voiceRecordedAt: voice data updates don't bump updatedAt
          // (to avoid content conflict resolution issues), so we need a separate check.
          if (
            lastSyncAt > 0 &&
            d.updatedAt < lastSyncAt &&
            d.createdAt < lastSyncAt &&
            (!d.voiceRecordedAt || d.voiceRecordedAt < lastSyncAt)
          )
            return false;
          return true;
        });
        const syncedOk: string[] = [];
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
            titlePinned: d.titlePinned,
            updatedAt: d.updatedAt,
            teamId: d.teamId ?? null,
            voiceTranscript: d.voiceTranscript ?? null,
            voiceGcsUri: d.voiceGcsUri ?? null,
            voiceRecordedAt: d.voiceRecordedAt ?? null,
          };
          try {
            await saveDocumentToFirestore(payload);
            syncedOk.push(d.id);
          } catch (saveErr) {
            // Transaction failed — fall back to merge save (preserves collaborators/shareLink)
            try {
              await saveDocumentMerge(payload);
              syncedOk.push(d.id);
            } catch (mergeErr) {
              console.error(
                `Failed to sync document ${d.id}:`,
                saveErr,
                mergeErr,
              );
            }
          }
        }
        // Stamp synced_at on everything that reached the cloud, so the deletion
        // reconciliation can never mistake an uploaded doc for a never-synced one
        // (and, conversely, so a genuine remote deletion is still actionable).
        try {
          const { markDocumentsSynced } = await import("@/services/database");
          await markDocumentsSynced(syncedOk);
        } catch (e) {
          console.error("Failed to mark documents synced:", e);
        }
        // Edit notifications are handled by debounce in App.tsx
        // (10min idle / document switch / app close)
        return true;
      } catch (error) {
        console.error("Sync to cloud failed:", error);
        return false;
      } finally {
        set({ syncing: false });
      }
    });
    return result === true;
  },
}));
