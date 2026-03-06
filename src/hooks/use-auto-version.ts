import { useEffect, useRef } from "react";
import * as db from "@/services/database";

interface AutoVersionOptions {
  docId: string | null;
  content: string;
  title: string;
  /** Idle time in ms before auto-saving (default: 10s) */
  idleMs?: number;
}

/**
 * Auto-saves document versions after periods of inactivity.
 * Any change — even a single character — triggers an auto-save
 * once the user stops editing for `idleMs`.
 */
export function useAutoVersion({
  docId,
  content,
  title,
  idleMs = 10_000,
}: AutoVersionOptions) {
  const lastContentRef = useRef<string>("");
  const lastDocIdRef = useRef<string | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      try {
        await db.createVersion({
          id: crypto.randomUUID(),
          documentId: capturedDocId,
          content: capturedContent,
          title: capturedTitle,
          message: null,
        });
        lastContentRef.current = capturedContent;
      } catch {
        // DB not available (browser mode)
      }
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
}
