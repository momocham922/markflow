import { useEffect, useState, useRef } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";
import { yCollab } from "y-codemirror.next";
import type { Extension } from "@codemirror/state";
import { useAuthStore } from "@/stores/auth-store";
import { getRandomColor } from "@/services/yjs";

export interface CollabUser {
  name: string;
  color: string;
  colorLight: string;
}

export interface CollabState {
  extension: Extension | null;
  connected: boolean;
  peers: CollabUser[];
}

const WS_URL = import.meta.env.VITE_YJS_WEBSOCKET_URL || "";

/**
 * Yjs-based real-time collaboration following established best practices:
 *
 * Architecture (same pattern as Google Docs / Notion):
 *  1. Y.Doc is the SINGLE source of truth for shared document content.
 *  2. y-indexeddb persists the Y.Doc locally (offline support, instant load).
 *  3. y-websocket syncs Y.Doc between peers in real-time.
 *  4. Local SQLite content is only used as a ONE-TIME seed when a document
 *     is first shared. After that, Y.Doc owns the content entirely.
 *
 * Flow:
 *  - y-indexeddb loads persisted Y.Doc from IndexedDB (instant, offline-safe).
 *  - y-websocket connects for real-time peer sync.
 *  - If Y.Doc is empty after both providers sync, seed from local content.
 *  - yCollab extension is ALWAYS active for shared docs — it drives the editor.
 *  - Content changes in Y.Doc propagate to the local store for preview/search.
 */
export function useCollaboration(
  docId: string | null,
  initialContent: string,
  onContentChange: (content: string) => void,
  isShared: boolean = false,
): CollabState {
  const user = useAuthStore((s) => s.user);
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState<CollabUser[]>([]);
  const [extension, setExtension] = useState<Extension | null>(null);

  const providerRef = useRef<WebsocketProvider | null>(null);
  const idbRef = useRef<IndexeddbPersistence | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const colorRef = useRef(getRandomColor());
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;
  const initialContentRef = useRef(initialContent);
  initialContentRef.current = initialContent;

  const enabled = Boolean(WS_URL && docId && user && isShared);

  useEffect(() => {
    if (!enabled || !docId || !user) {
      setExtension(null);
      setConnected(false);
      setPeers([]);
      return;
    }

    let cancelled = false;

    const setup = async () => {
      const token = await user.getIdToken().catch(() => "");
      if (cancelled) return;

      const ydoc = new Y.Doc();
      const ytext = ydoc.getText("codemirror");
      ydocRef.current = ydoc;

      // --- Provider 1: IndexedDB (local persistence) ---
      // Loads previously persisted Y.Doc state instantly.
      const idb = new IndexeddbPersistence(`markflow-${docId}`, ydoc);
      idbRef.current = idb;

      // --- Provider 2: WebSocket (real-time peer sync) ---
      const params: Record<string, string> = {};
      if (token) params.token = token;

      const provider = new WebsocketProvider(WS_URL, `markflow-${docId}`, ydoc, {
        connect: false,
        params,
      });
      providerRef.current = provider;

      // Awareness (cursor/presence)
      const color = colorRef.current;
      provider.awareness.setLocalStateField("user", {
        name: user.displayName || user.email || "Anonymous",
        color,
        colorLight: color + "33",
      });

      // --- Wait for IndexedDB to load, then connect WS ---
      // This ensures local persisted state is loaded BEFORE merging with server.
      let idbSynced = false;
      let idbHadData = false;
      let wsSynced = false;
      let finalized = false;

      const tryFinalize = () => {
        if (finalized || !idbSynced || !wsSynced || cancelled) return;
        finalized = true;

        const ydocContent = ytext.toString();
        const localContent = initialContentRef.current;

        if (!ydocContent.trim() && localContent.trim()) {
          // Y.Doc is empty — seed from local (first share or corrupted state)
          ydoc.transact(() => {
            ytext.insert(0, localContent);
          });
        } else if (
          !idbHadData &&
          localContent.trim() &&
          ydocContent.trim() !== localContent.trim()
        ) {
          // MIGRATION: IndexedDB was empty (first time using y-indexeddb).
          // Y.Doc state came entirely from WS server, which may be stale.
          // Trust local SQLite content as the latest version.
          // After this session, IndexedDB will persist the correct state.
          ydoc.transact(() => {
            if (ytext.length > 0) ytext.delete(0, ytext.length);
            ytext.insert(0, localContent);
          });
        }

        // Activate yCollab — Y.Doc is now the source of truth
        const undoManager = new Y.UndoManager(ytext);
        setExtension(yCollab(ytext, provider.awareness, { undoManager }));
      };

      idb.once("synced", () => {
        idbSynced = true;
        // Check if IndexedDB had previously persisted data
        idbHadData = ytext.toString().trim().length > 0;
        // Connect WS after IndexedDB is ready
        provider.connect();
      });

      provider.on("sync", (isSynced: boolean) => {
        if (!isSynced) return;
        wsSynced = true;
        tryFinalize();
      });

      // Fallback: if WS never syncs (server down), still activate after IDB
      const wsTimeout = setTimeout(() => {
        if (!wsSynced && idbSynced && !cancelled) {
          console.warn("[collab] WS sync timeout — using IndexedDB state only");
          wsSynced = true;
          tryFinalize();
        }
      }, 5000);

      // Connection status
      provider.on("status", ({ status }: { status: string }) => {
        setConnected(status === "connected");
      });

      // Peer tracking
      const updatePeers = () => {
        const states = provider.awareness.getStates();
        const users: CollabUser[] = [];
        states.forEach((state, clientId) => {
          if (clientId === ydoc.clientID) return;
          if (state.user) users.push(state.user as CollabUser);
        });
        setPeers(users);
      };
      provider.awareness.on("change", updatePeers);

      // Propagate Y.Doc changes → local store (for preview, search, auto-save)
      const observer = () => {
        if (!finalized) return;
        const text = ytext.toString();
        if (!text.trim()) return;
        onContentChangeRef.current(text);
      };
      ytext.observe(observer);

      // Cleanup timeout ref
      return () => clearTimeout(wsTimeout);
    };

    let cleanupTimeout: (() => void) | undefined;
    setup().then((fn) => { cleanupTimeout = fn; });

    return () => {
      cancelled = true;
      cleanupTimeout?.();
      const provider = providerRef.current;
      const idb = idbRef.current;
      const ydoc = ydocRef.current;
      if (provider) {
        provider.disconnect();
        provider.destroy();
      }
      if (idb) idb.destroy();
      if (ydoc) ydoc.destroy();
      ydocRef.current = null;
      providerRef.current = null;
      idbRef.current = null;
      setExtension(null);
      setConnected(false);
      setPeers([]);
    };
  }, [enabled, docId, user]);

  return { extension, connected, peers };
}
