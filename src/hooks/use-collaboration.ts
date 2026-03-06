import { useEffect, useState, useRef } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
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
  /**
   * CodeMirror extension — null when collab is off or not yet synced.
   * When non-null, Yjs owns the document: do NOT set CodeMirror's value prop.
   * The extension is only set AFTER initial sync completes, so there is
   * never a frame where both value prop and yCollab coexist.
   */
  extension: Extension | null;
  /** Whether WebSocket is connected */
  connected: boolean;
  /** Active peers (not including self) */
  peers: CollabUser[];
}

const WS_URL = import.meta.env.VITE_YJS_WEBSOCKET_URL || "";

/**
 * Manages Yjs collaboration for a document.
 *
 * Contract with the Editor:
 * - `extension` is null until the first sync completes. While null, the editor
 *   operates in local-only mode with its normal `value` prop.
 * - Once `extension` is set (after sync), Yjs owns the doc. The editor must
 *   stop setting `value` and let yCollab drive the content.
 * - `onContentChange` syncs Yjs → local store for preview/auto-save.
 * - `initialContent` is pre-loaded into the Y.Doc BEFORE connecting, so the
 *   y-websocket sync protocol merges it naturally (no post-sync insertion race).
 */
export function useCollaboration(
  docId: string | null,
  initialContent: string,
  onContentChange: (content: string) => void,
): CollabState {
  const user = useAuthStore((s) => s.user);
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState<CollabUser[]>([]);
  const [extension, setExtension] = useState<Extension | null>(null);

  const providerRef = useRef<WebsocketProvider | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const colorRef = useRef(getRandomColor());
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  const enabled = Boolean(WS_URL && docId && user);

  useEffect(() => {
    if (!enabled || !docId || !user) {
      setExtension(null);
      setConnected(false);
      setPeers([]);
      return;
    }

    let cancelled = false;

    // Async: get Firebase auth token before connecting
    const setup = async () => {
      const token = await user.getIdToken().catch(() => "");
      if (cancelled) return;

      const ydoc = new Y.Doc();
      const ytext = ydoc.getText("codemirror");
      ydocRef.current = ydoc;

      // Do NOT seed content before connecting — the server snapshot would
      // merge with the local insert and duplicate everything (CRDT is additive).
      // Instead, seed only after sync if the server had no content.

      const params: Record<string, string> = {};
      if (token) params.token = token;

      const provider = new WebsocketProvider(WS_URL, `markflow-${docId}`, ydoc, {
        connect: false,
        params,
      });
      providerRef.current = provider;

      // Awareness
      const color = colorRef.current;
      provider.awareness.setLocalStateField("user", {
        name: user.displayName || user.email || "Anonymous",
        color,
        colorLight: color + "33",
      });

      // Only expose the extension AFTER first sync completes.
      // This guarantees zero overlap between value-prop and yCollab modes.
      let synced = false;
      const onSync = (isSynced: boolean) => {
        if (!isSynced || synced) return;
        synced = true;

        const serverContent = ytext.toString();
        if (ytext.length === 0 && initialContent) {
          // Server had no content — seed with local content
          ydoc.transact(() => {
            ytext.insert(0, initialContent);
          });
        } else if (serverContent.length > 0 && initialContent.length > 0) {
          // Fix corrupted snapshots: if server content is exactly the local
          // content repeated N times, replace with single copy
          const halfLen = serverContent.length / 2;
          if (
            serverContent.length >= initialContent.length * 2 &&
            serverContent.slice(0, halfLen) === serverContent.slice(halfLen)
          ) {
            ydoc.transact(() => {
              ytext.delete(0, ytext.length);
              ytext.insert(0, serverContent.slice(0, halfLen));
            });
          }
        }

        const undoManager = new Y.UndoManager(ytext);
        setExtension(yCollab(ytext, provider.awareness, { undoManager }));
      };
      provider.on("sync", onSync);

      // Connection status
      const onStatus = ({ status }: { status: string }) => {
        setConnected(status === "connected");
      };
      provider.on("status", onStatus);

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

      // Sync Yjs → local store on every change
      const observer = () => {
        onContentChangeRef.current(ytext.toString());
      };
      ytext.observe(observer);

      // Connect
      provider.connect();
    };

    setup();

    return () => {
      cancelled = true;
      const provider = providerRef.current;
      const ydoc = ydocRef.current;
      if (provider) {
        provider.disconnect();
        provider.destroy();
      }
      if (ydoc) ydoc.destroy();
      ydocRef.current = null;
      providerRef.current = null;
      setExtension(null);
      setConnected(false);
      setPeers([]);
    };
  }, [enabled, docId, user]);

  return { extension, connected, peers };
}
