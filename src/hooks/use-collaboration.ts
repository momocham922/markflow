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
  /** CodeMirror extension to add to the editor */
  extension: Extension | null;
  /** Whether WebSocket is connected */
  connected: boolean;
  /** List of currently active users */
  peers: CollabUser[];
}

const WS_URL = import.meta.env.VITE_YJS_WEBSOCKET_URL || "";

/**
 * Hook that manages Yjs collaboration for a document.
 * Returns a CodeMirror extension for the collab binding + active peers.
 * Only activates when a WS URL is configured and user is logged in.
 */
export function useCollaboration(docId: string | null): CollabState {
  const user = useAuthStore((s) => s.user);
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState<CollabUser[]>([]);
  const [extension, setExtension] = useState<Extension | null>(null);

  const providerRef = useRef<WebsocketProvider | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const colorRef = useRef(getRandomColor());

  const enabled = Boolean(WS_URL && docId && user);

  useEffect(() => {
    if (!enabled || !docId || !user) {
      setExtension(null);
      setConnected(false);
      setPeers([]);
      return;
    }

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("codemirror");
    const provider = new WebsocketProvider(WS_URL, `markflow-${docId}`, ydoc);

    ydocRef.current = ydoc;
    providerRef.current = provider;

    // Set local awareness user info
    const color = colorRef.current;
    const userName = user.displayName || user.email || "Anonymous";
    provider.awareness.setLocalStateField("user", {
      name: userName,
      color,
      colorLight: color + "33", // 20% opacity
    });

    // Track connection state
    const onStatus = ({ status }: { status: string }) => {
      setConnected(status === "connected");
    };
    provider.on("status", onStatus);

    // Track peers via awareness
    const updatePeers = () => {
      const states = provider.awareness.getStates();
      const users: CollabUser[] = [];
      states.forEach((state, clientId) => {
        if (clientId === ydoc.clientID) return; // skip self
        if (state.user) {
          users.push(state.user as CollabUser);
        }
      });
      setPeers(users);
    };
    provider.awareness.on("change", updatePeers);
    updatePeers();

    // Create CodeMirror extension
    const undoManager = new Y.UndoManager(ytext);
    const ext = yCollab(ytext, provider.awareness, { undoManager });
    setExtension(ext);

    return () => {
      provider.off("status", onStatus);
      provider.awareness.off("change", updatePeers);
      provider.disconnect();
      provider.destroy();
      ydoc.destroy();
      ydocRef.current = null;
      providerRef.current = null;
      setExtension(null);
      setConnected(false);
      setPeers([]);
    };
  }, [enabled, docId, user]);

  return { extension, connected, peers };
}
