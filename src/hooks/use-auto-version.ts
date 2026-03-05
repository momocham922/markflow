import { useEffect, useRef } from "react";
import * as db from "@/services/database";

interface AutoVersionOptions {
  docId: string | null;
  content: string;
  title: string;
  /** Minimum character change to trigger auto-save (default: 50) */
  minDelta?: number;
  /** Idle time in ms before auto-saving (default: 30s) */
  idleMs?: number;
  /** Max interval between auto-saves in ms (default: 5min) */
  maxIntervalMs?: number;
}

/**
 * Auto-saves document versions after periods of inactivity.
 * - Waits for idle (no edits for `idleMs`)
 * - Only saves if content changed by at least `minDelta` characters
 * - Forces a save every `maxIntervalMs` if there are any changes
 */
export function useAutoVersion({
  docId,
  content,
  title,
  minDelta = 50,
  idleMs = 30_000,
  maxIntervalMs = 300_000,
}: AutoVersionOptions) {
  const lastContentRef = useRef<string>("");
  const lastDocIdRef = useRef<string | null>(null);
  const lastSaveTimeRef = useRef<number>(Date.now());
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset when switching documents
  useEffect(() => {
    if (docId !== lastDocIdRef.current) {
      lastDocIdRef.current = docId;
      lastContentRef.current = content;
      lastSaveTimeRef.current = Date.now();
    }
  }, [docId, content]);

  useEffect(() => {
    if (!docId) return;

    const lastContent = lastContentRef.current;
    const delta = Math.abs(content.length - lastContent.length);
    const hasChanged = content !== lastContent;

    if (!hasChanged) return;

    // Clear existing idle timer
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);

    const saveVersion = async () => {
      if (!docId || content === lastContentRef.current) return;
      try {
        await db.createVersion({
          id: crypto.randomUUID(),
          documentId: docId,
          content,
          title,
          message: null, // auto-save — no message
        });
        lastContentRef.current = content;
        lastSaveTimeRef.current = Date.now();
      } catch {
        // DB not available (browser mode)
      }
    };

    // Idle timer: save after inactivity if change is significant
    if (delta >= minDelta || content !== lastContent) {
      idleTimerRef.current = setTimeout(() => {
        const d = Math.abs(content.length - lastContentRef.current.length);
        // Also check text diff, not just length — a rewrite could be same length
        const textChanged = content !== lastContentRef.current;
        if (d >= minDelta || (textChanged && Date.now() - lastSaveTimeRef.current > maxIntervalMs)) {
          saveVersion();
        }
      }, idleMs);
    }

    // Max interval timer: force save if too long since last version
    if (!intervalTimerRef.current) {
      intervalTimerRef.current = setTimeout(() => {
        intervalTimerRef.current = null;
        if (content !== lastContentRef.current) {
          saveVersion();
        }
      }, maxIntervalMs);
    }

    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [docId, content, title, minDelta, idleMs, maxIntervalMs]);

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (intervalTimerRef.current) clearTimeout(intervalTimerRef.current);
    };
  }, []);
}
