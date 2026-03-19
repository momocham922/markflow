import { useEffect, useRef, useCallback } from "react";
import * as db from "@/services/database";
import { syncVersionToCloud } from "@/services/firebase";
import { useAuthStore } from "@/stores/auth-store";

interface AutoVersionOptions {
  docId: string | null;
  content: string;
  title: string;
  /** Idle time in ms before auto-saving (default: 10s) */
  idleMs?: number;
  /** When true, only save versions for local user edits (skip remote yCollab sync) */
  collabActive?: boolean;
}

/**
 * Auto-saves document versions after periods of inactivity.
 * Any change — even a single character — triggers an auto-save
 * once the user stops editing for `idleMs`.
 *
 * In collab mode (`collabActive`), only saves when the local user
 * actually edited (via `markLocalEdit()`). Remote yCollab sync
 * changes are ignored to prevent duplicate versions across clients.
 *
 * Cloud-first: when the user is logged in, versions are also
 * synced to Firestore so all collaborators can see them.
 * Local SQLite serves as offline fallback only.
 */
export function useAutoVersion({
  docId,
  content,
  title,
  idleMs = 10_000,
  collabActive = false,
}: AutoVersionOptions) {
  const lastContentRef = useRef<string>("");
  const lastDocIdRef = useRef<string | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localEditedRef = useRef(false);
  const collabActiveRef = useRef(collabActive);
  collabActiveRef.current = collabActive;

  // Reset when switching documents
  useEffect(() => {
    if (docId !== lastDocIdRef.current) {
      lastDocIdRef.current = docId;
      lastContentRef.current = content;
    }
  }, [docId, content]);

  useEffect(() => {
    if (!docId) return;
    if (content === lastContentRef.current) return;

    // Clear existing idle timer
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);

    // Save after idle period — any change counts
    const capturedContent = content;
    const capturedTitle = title;
    const capturedDocId = docId;

    idleTimerRef.current = setTimeout(async () => {
      if (!capturedDocId || capturedContent === lastContentRef.current) return;
      // In collab mode, only save if local user actually edited
      if (collabActiveRef.current && !localEditedRef.current) return;
      localEditedRef.current = false;

      const versionId = crypto.randomUUID();
      const createdAt = Date.now();

      // Local fallback save
      try {
        await db.createVersion({
          id: versionId,
          documentId: capturedDocId,
          content: capturedContent,
          title: capturedTitle,
          message: null,
        });
      } catch (e) {
        console.warn("[auto-version] Local save failed:", e);
      }

      // Cloud sync (source of truth)
      const user = useAuthStore.getState().user;
      if (user) {
        try {
          await syncVersionToCloud(
            capturedDocId,
            {
              id: versionId,
              content: capturedContent,
              title: capturedTitle,
              message: null,
              createdAt,
            },
            user.uid,
            user.displayName || user.email || "Unknown",
          );
        } catch (e) {
          console.error("[auto-version] Cloud sync FAILED for doc", capturedDocId, "user", user.uid, e);
        }
      } else {
        console.warn("[auto-version] No user — skipping cloud sync for doc", capturedDocId);
      }

      lastContentRef.current = capturedContent;
    }, idleMs);

    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [docId, content, title, idleMs]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  /** Call when the local user makes an edit (not remote yCollab sync) */
  const markLocalEdit = useCallback(() => {
    localEditedRef.current = true;
  }, []);

  return { markLocalEdit };
}
