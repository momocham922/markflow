import * as db from "@/services/database";

/**
 * Delete every locally-cached artifact of the account that was signed in, so a
 * DIFFERENT account signing in on the same device starts from a clean slate.
 *
 * Covers every local store that holds user content:
 *  - SQLite: documents + versions + snapshots + delete-tombstones (via
 *    {@link db.clearAllLocalDocuments}).
 *  - IndexedDB: Yjs collaborative content, persisted by y-indexeddb under the
 *    name `markflow-<docId>` (see use-collaboration.ts). Without this, a shared
 *    doc's text could survive an account switch inside its Y.Doc store.
 *  - localStorage: the canvas state (`markflow-canvas-state`) embeds sticky-note
 *    TEXT + node layout — real user content that would otherwise render on the
 *    next account's canvas. Also clears user/session-scoped keys (research
 *    preferences, owner view-as, pending checkout) so they can't bleed across
 *    accounts. Device-level UI (`markflow:themeSettings`) is intentionally kept.
 *
 * Best-effort: individual failures are logged, never thrown, so a partial
 * environment (IndexedDB unavailable / no enumeration API) can't block the
 * account switch — the SQLite purge alone already removes docs from the sidebar.
 */
export async function wipeLocalUserData(): Promise<void> {
  try {
    await db.clearAllLocalDocuments();
  } catch (e) {
    console.error("[local-reset] SQLite wipe failed:", e);
  }
  await clearCollabIndexedDb();
  clearLocalStorageUserData();
}

/**
 * localStorage keys that carry user content or user/session-scoped state and so
 * must NOT survive an account switch. `markflow:themeSettings` is deliberately
 * excluded (a device UI preference, not user data).
 */
const USER_SCOPED_LS_KEYS = [
  "markflow-canvas-state", // canvas layout + sticky-note text (content)
  "markflow:research:includeInStructure", // research preference (per-user)
  "markflow:research:mobileLiveResearch", // research preference (per-user)
  "markflow_view_as", // owner "view as plan" debug override
  "markflow_pending_checkout", // in-flight checkout target for this session
] as const;

/** Remove user/session-scoped localStorage keys (best-effort). */
function clearLocalStorageUserData(): void {
  try {
    if (typeof localStorage === "undefined") return;
    for (const key of USER_SCOPED_LS_KEYS) localStorage.removeItem(key);
  } catch (e) {
    console.error("[local-reset] localStorage wipe failed:", e);
  }
}

/** Delete all y-indexeddb `markflow-<docId>` databases (best-effort). */
async function clearCollabIndexedDb(): Promise<void> {
  try {
    if (typeof indexedDB === "undefined") return;
    // `databases()` is available in Chromium and WebKit (iOS 15+). Where it is
    // missing we cannot enumerate, so we skip rather than guess doc IDs — the
    // orphaned Y.Doc store is never rendered because its doc no longer exists in
    // the store, and the SQLite purge already fixed the visible leak.
    const factory = indexedDB as IDBFactory & {
      databases?: () => Promise<{ name?: string }[]>;
    };
    if (typeof factory.databases !== "function") return;
    const dbs = await factory.databases();
    const names = dbs
      .map((d) => d.name)
      .filter((n): n is string => !!n && n.startsWith("markflow-"));
    await Promise.all(
      names.map(
        (name) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            // An open connection blocks deletion; don't hang the switch on it.
            req.onblocked = () => resolve();
          }),
      ),
    );
  } catch (e) {
    console.error("[local-reset] IndexedDB wipe failed:", e);
  }
}
