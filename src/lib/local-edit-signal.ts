// A tiny module-level pub/sub for genuine *local* user edits.
//
// Slack edit-notifications must be attributed to the current user only. A
// store-wide `updatedAt` watcher can't do that: it also fires for remote
// collaborator edits synced in from Firestore/Yjs, title auto-derive, folder
// moves, and other programmatic bumps — all of which would be mis-attributed.
// The editor is the only place that can tell a real local keystroke apart from
// a remote sync, so it emits here and App subscribes.

export interface LocalEditEvent {
  docId: string;
  title: string;
}

type Listener = (event: LocalEditEvent) => void;

const listeners = new Set<Listener>();

/** Emit a local user-edit signal for the given document. */
export function emitLocalEdit(docId: string, title: string): void {
  if (!docId) return;
  const event: LocalEditEvent = { docId, title };
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* a bad listener must not break edit propagation */
    }
  }
}

/** Subscribe to local user-edit signals. Returns an unsubscribe function. */
export function onLocalEdit(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
