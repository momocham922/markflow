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
  /** CodeMirror extension — null when collab is off */
  extension: Extension | null;
  /** True when Yjs owns the document (editor must NOT set value prop) */
  active: boolean;
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
 * - When `active` is true, Yjs owns the content. Do NOT set CodeMirror value prop.
 * - `onContentChange` is called on every Yjs change so the local store stays in sync
 *   (for preview, auto-save, cloud sync, etc.)
 * - `initialContent` seeds the Y.Doc when the server has no prior state for this doc.
 */
export function useCollaboration(
  docId: string | null,
  initialContent: string,
  onContentChange: (content: string) => void,
): CollabState {
  const user = useAuthStore((s) => s.user);
  const [connected, setConnected] = useState(false);
  const [active, setActive] = useState(false);
  const [peers, setPeers] = useState<CollabUser[]>([]);
  const [extension, setExtension] = useState<Extension | null>(null);

  const providerRef = useRef<WebsocketProvider | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const colorRef = useRef(getRandomColor());
  // Refs to avoid stale closures in Yjs callbacks
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;
  const initialContentRef = useRef(initialContent);
  initialContentRef.current = initialContent;

  const enabled = Boolean(WS_URL && docId && user);

  useEffect(() => {
    if (!enabled || !docId || !user) {
      setExtension(null);
      setActive(false);
      setConnected(false);
      setPeers([]);
      return;
    }

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("codemirror");
    ydocRef.current = ydoc;

    // Don't auto-connect — set up handlers first
    const provider = new WebsocketProvider(WS_URL, `markflow-${docId}`, ydoc, {
      connect: false,
    });
    providerRef.current = provider;

    // Awareness: user info + cursor color
    const color = colorRef.current;
    provider.awareness.setLocalStateField("user", {
      name: user.displayName || user.email || "Anonymous",
      color,
      colorLight: color + "33",
    });

    // On first sync: seed Y.Doc with local content if server has no state
    let seeded = false;
    const onSync = (isSynced: boolean) => {
      if (!isSynced || seeded) return;
      seeded = true;
      if (ytext.length === 0 && initialContentRef.current) {
        ydoc.transact(() => {
          ytext.insert(0, initialContentRef.current);
        });
      }
      // From now on, Yjs owns the content
      setActive(true);
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

    // Sync Yjs -> local store on every change (for preview, auto-save, etc.)
    const observer = () => {
      onContentChangeRef.current(ytext.toString());
    };
    ytext.observe(observer);

    // CodeMirror extension with shared undo
    const undoManager = new Y.UndoManager(ytext);
    setExtension(yCollab(ytext, provider.awareness, { undoManager }));

    // Now connect
    provider.connect();

    return () => {
      ytext.unobserve(observer);
      provider.off("sync", onSync);
      provider.off("status", onStatus);
      provider.awareness.off("change", updatePeers);
      provider.disconnect();
      provider.destroy();
      ydoc.destroy();
      ydocRef.current = null;
      providerRef.current = null;
      setExtension(null);
      setActive(false);
      setConnected(false);
      setPeers([]);
    };
  }, [enabled, docId, user]);

  return { extension, active, connected, peers };
}
