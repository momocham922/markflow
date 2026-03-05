import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

const WS_URL = import.meta.env.VITE_YJS_WEBSOCKET_URL || "ws://localhost:1234";

const docs = new Map<string, Y.Doc>();
const providers = new Map<string, WebsocketProvider>();

export interface CollaborationUser {
  name: string;
  color: string;
}

const CURSOR_COLORS = [
  "#3b82f6", "#ef4444", "#10b981", "#f59e0b",
  "#8b5cf6", "#ec4899", "#06b6d4", "#f97316",
];

export function getRandomColor(): string {
  return CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)];
}

export function getYDoc(docId: string): Y.Doc {
  let ydoc = docs.get(docId);
  if (!ydoc) {
    ydoc = new Y.Doc();
    docs.set(docId, ydoc);
  }
  return ydoc;
}

export function getProvider(
  docId: string,
  user: CollaborationUser,
): WebsocketProvider {
  let provider = providers.get(docId);
  if (!provider) {
    const ydoc = getYDoc(docId);
    provider = new WebsocketProvider(WS_URL, `markflow-${docId}`, ydoc, {
      connect: false, // Don't auto-connect; connect explicitly when server is ready
    });
    provider.awareness.setLocalStateField("user", user);
    providers.set(docId, provider);
  }
  return provider;
}

export function disconnectProvider(docId: string): void {
  const provider = providers.get(docId);
  if (provider) {
    provider.disconnect();
    provider.destroy();
    providers.delete(docId);
  }

  const ydoc = docs.get(docId);
  if (ydoc) {
    ydoc.destroy();
    docs.delete(docId);
  }
}

export function disconnectAll(): void {
  for (const docId of providers.keys()) {
    disconnectProvider(docId);
  }
}

export function getAwarenessStates(
  docId: string,
): Map<number, Record<string, unknown>> {
  const provider = providers.get(docId);
  if (!provider) return new Map();
  return provider.awareness.getStates() as Map<number, Record<string, unknown>>;
}
