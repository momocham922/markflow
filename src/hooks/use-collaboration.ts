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
  docId: string | null;
  enabled: boolean;
  wsTimedOut: boolean;
}

const WS_URL = import.meta.env.VITE_YJS_WEBSOCKET_URL || "";

/**
 * Yjs real-time collaboration hook.
 *
 * Architecture:
 *  Y.Doc ← single source of truth for shared doc content
 *  y-indexeddb ← local Y.Doc persistence (offline, instant load)
 *  y-websocket ← real-time peer sync
 *  yCollab ← binds Y.Text ↔ CodeMirror editor
 *
 * onContentChange: called when Y.Text changes → updates store (for preview/search/save)
 * onBeforeCollab: called right before yCollab activates → sync frozen value to Y.Text content
 */
export function useCollaboration(
  docId: string | null,
  initialContent: string,
  onContentChange: (content: string) => void,
  isShared: boolean = false,
  onBeforeCollab?: (docId: string, ytextContent: string) => void,
): CollabState {
  const user = useAuthStore((s) => s.user);
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState<CollabUser[]>([]);
  const [extension, setExtension] = useState<Extension | null>(null);
  const [collabDocId, setCollabDocId] = useState<string | null>(null);
  const [wsTimedOut, setWsTimedOut] = useState(false);

  const providerRef = useRef<WebsocketProvider | null>(null);
  const idbRef = useRef<IndexeddbPersistence | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const colorRef = useRef(getRandomColor());
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;
  const initialContentRef = useRef(initialContent);
  initialContentRef.current = initialContent;
  const onBeforeCollabRef = useRef(onBeforeCollab);
  onBeforeCollabRef.current = onBeforeCollab;
  const enabled = Boolean(WS_URL && docId && user && isShared);

  useEffect(() => {
    if (!enabled || !docId || !user) {
      setExtension(null);
      setCollabDocId(null);
      setConnected(false);
      setPeers([]);
      setWsTimedOut(false);
      return;
    }

    let cancelled = false;

    const setup = async () => {
      setWsTimedOut(false);
      const token = await user.getIdToken().catch(() => "");
      if (cancelled) return;

      const ydoc = new Y.Doc();
      const ytext = ydoc.getText("codemirror");
      ydocRef.current = ydoc;

      // --- Provider 1: IndexedDB (local persistence) ---
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

      // --- Sync state machine ---
      let idbSynced = false;
      let wsSynced = false;
      let finalized = false;

      /** Seed Y.Text from local content if Y.Doc is empty.
       *  If peers are connected, wait briefly for their state to propagate
       *  before seeding — prevents content duplication when multiple users
       *  open the same doc simultaneously with an empty WS server.
       */
      const seedIfEmpty = () => {
        const ydocContent = ytext.toString();
        const localContent = initialContentRef.current;
        if (!ydocContent.trim() && localContent.trim()) {
          const peerCount = Array.from(provider.awareness.getStates().keys())
            .filter((id) => id !== ydoc.clientID).length;
          if (peerCount > 0) {
            // Peers connected — wait for their Y.Doc state before seeding
            setTimeout(() => {
              if (cancelled) return;
              if (!ytext.toString().trim() && localContent.trim()) {
                ydoc.transact(() => { ytext.insert(0, localContent); });
              }
            }, 1500);
            return;
          }
          ydoc.transact(() => {
            ytext.insert(0, localContent);
          });
        }
      };

      const tryFinalize = () => {
        if (finalized || !idbSynced || !wsSynced || cancelled) return;
        finalized = true;

        seedIfEmpty();

        // Sync Y.Text content → frozen value BEFORE activating yCollab.
        // This prevents @uiw/react-codemirror's value prop from conflicting
        // with yCollab's initial sync (which would cause content duplication).
        const finalContent = ytext.toString();
        if (finalContent.trim() && docId) {
          onBeforeCollabRef.current?.(docId, finalContent);
        }

        // Also push Y.Text content to store immediately for preview sync
        if (finalContent.trim()) {
          onContentChangeRef.current(finalContent);
        }

        // Activate yCollab — Y.Doc is now the source of truth
        const undoManager = new Y.UndoManager(ytext);
        setExtension(yCollab(ytext, provider.awareness, { undoManager }));
        setCollabDocId(docId);
      };

      // IDB synced → if Y.Text already has content from IDB, finalize immediately
      // (no risk of duplication — these are persisted operations from previous sessions).
      // Otherwise, connect WS and wait for server state.
      idb.once("synced", () => {
        idbSynced = true;
        if (ytext.toString().trim()) {
          wsSynced = true;
          tryFinalize();
        }
        provider.connect();
      });

      // WS sync — handles both initial sync and reconnections
      provider.on("sync", (isSynced: boolean) => {
        if (!isSynced) return;

        if (!finalized) {
          // First sync: complete initialization
          wsSynced = true;
          tryFinalize();
        } else {
          // Reconnection sync: WS server may have restarted (Cloud Run scale-to-zero).
          // If Y.Doc is now empty, re-seed from local content.
          seedIfEmpty();
        }
      });

      // Fallback: if WS never syncs (server down), allow non-collab editing.
      // Do NOT seed Y.Text here — seeding creates new Yjs operations that can
      // conflict with operations arriving later from the WS server, causing
      // content duplication. Instead, Editor renders without yCollab.
      const wsTimeout = setTimeout(() => {
        if (!wsSynced && idbSynced && !cancelled && !finalized) {
          console.warn("[collab] WS sync timeout — fallback to non-collab mode");
          setWsTimedOut(true);
        }
      }, 5000);

      // Connection status
      provider.on("status", ({ status }: { status: string }) => {
        if (cancelled) return;
        setConnected(status === "connected");
      });

      // Peer tracking
      const updatePeers = () => {
        if (cancelled) return;
        const states = provider.awareness.getStates();
        const users: CollabUser[] = [];
        states.forEach((state, clientId) => {
          if (clientId === ydoc.clientID) return;
          if (state.user) users.push(state.user as CollabUser);
        });
        setPeers(users);
      };
      provider.awareness.on("change", updatePeers);

      // Y.Text observer → throttled store updates (preview, search, auto-save).
      // Throttle prevents heavy docs from triggering marked.parse() on every keystroke.
      let throttleTimer: ReturnType<typeof setTimeout> | null = null;
      let pendingText: string | null = null;

      const flushPending = () => {
        throttleTimer = null;
        if (pendingText !== null && !cancelled) {
          onContentChangeRef.current(pendingText);
          pendingText = null;
        }
      };

      const observer = () => {
        if (!finalized || cancelled) return;
        const text = ytext.toString();
        if (!text.trim()) return;

        pendingText = text;
        if (!throttleTimer) {
          // Fire immediately on first change, then throttle subsequent ones
          onContentChangeRef.current(text);
          pendingText = null;
          throttleTimer = setTimeout(flushPending, 300);
        }
      };
      ytext.observe(observer);

      return () => {
        clearTimeout(wsTimeout);
        if (throttleTimer) clearTimeout(throttleTimer);
        // Flush any pending update on cleanup
        if (pendingText !== null) {
          onContentChangeRef.current(pendingText);
        }
      };
    };

    let cleanupTimeout: (() => void) | undefined;
    setup().then((fn) => { cleanupTimeout = fn; });

    return () => {
      cancelled = true;
      cleanupTimeout?.();

      const provider = providerRef.current;
      const idb = idbRef.current;
      const ydoc = ydocRef.current;

      // Disconnect WS first (stops receiving updates)
      if (provider) {
        provider.disconnect();
        provider.destroy();
      }

      // Flush Y.Doc state to IDB before destroying.
      // y-indexeddb writes are async; store a final snapshot to ensure persistence.
      if (idb && ydoc) {
        try {
          const update = Y.encodeStateAsUpdate(ydoc);
          // Apply the update back to trigger IDB write, then destroy after a tick
          Y.applyUpdate(ydoc, update);
        } catch { /* best effort */ }
        // Small delay to let IDB flush the final write
        setTimeout(() => {
          idb.destroy();
          ydoc.destroy();
        }, 50);
      } else {
        if (idb) idb.destroy();
        if (ydoc) ydoc.destroy();
      }

      ydocRef.current = null;
      providerRef.current = null;
      idbRef.current = null;
      setExtension(null);
      setCollabDocId(null);
      setConnected(false);
      setPeers([]);
      setWsTimedOut(false);
    };
  }, [enabled, docId, user]);

  return { extension, connected, peers, docId: collabDocId, enabled, wsTimedOut };
}
