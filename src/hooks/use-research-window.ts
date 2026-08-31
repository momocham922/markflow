/**
 * Manager for the standalone "research" floating window (desktop Tauri only).
 *
 * The research pipeline + research-store live in the MAIN window. The floating
 * window is a separate WebView (separate JS context) that only DISPLAYS cards
 * and emits user actions back. State is bridged over Tauri events:
 *
 *   main → floating:  "research:sync"   { cards, analyzing, theme }
 *   floating → main:  "research:ready"  (request initial state on mount)
 *                     "research:action" { action, id?, docId? }
 *
 * Mount `useResearchWindowManager()` ONCE in the main window (Editor) and call
 * `openResearchWindow()` from a button to pop the panel out.
 */
import { useEffect } from "react";
import { useResearchStore } from "@/stores/research-store";
import { useAppStore } from "@/stores/app-store";
import { groundedSearch } from "@/services/research";
import type { ResearchCard, ResearchSource } from "@/stores/research-store";
import { isTauri, isMobile } from "@/platform";

export const RESEARCH_WINDOW_LABEL = "research";

export interface ResearchSyncPayload {
  cards: ResearchCard[];
  analyzing: boolean;
  theme: "light" | "dark";
  includeInStructure: boolean;
  /**
   * Plan capability gate (Free auto-research). The floating window is the
   * primary desktop reading surface when popped out, so it MUST carry this —
   * otherwise the gate is silent there (サイレントフォールバック禁止).
   */
  featureGated: boolean;
  /** Dismissible manual-analyze failure message; mirrored to the popped window. */
  analysisError: string | null;
}

export interface ResearchActionPayload {
  action:
    | "dismiss"
    | "clear"
    | "retry"
    | "open-doc"
    | "insert"
    | "set-include"
    | "dismiss-error";
  id?: string;
  docId?: string;
  value?: boolean;
}

const isDesktopTauri = () => isTauri && !isMobile;

// Editor registers its markdown-insert function here so the research UI (main
// window and, via events, the floating window) can weave a card into the doc.
let _insertFn: ((markdown: string) => void) | null = null;

export function registerResearchInsert(
  fn: (markdown: string) => void,
): () => void {
  _insertFn = fn;
  return () => {
    if (_insertFn === fn) _insertFn = null;
  };
}

/**
 * Queue (or un-queue) a card to be woven into the NEXT Structure/Refine run.
 * We intentionally do NOT insert on the spot: the next Structure integrates all
 * queued cards together, with a natural "〜の件について" heading, a concise
 * supplement, a link to the related meeting topic, and de-duplication against
 * the body — smoother and more stable than an immediate one-off paste. The
 * queued state is cleared when that run marks the card integrated.
 */
export function insertResearchCard(card: ResearchCard): void {
  if (!card.summary) return;
  const store = useResearchStore.getState();
  if (store.cards.find((c) => c.id === card.id)?.integrated) return;
  store.toggleQueued(card.id);
}

/** Open (or focus) the floating research window. */
export async function openResearchWindow(): Promise<void> {
  if (!isDesktopTauri()) return;

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");

  const existing = await WebviewWindow.getByLabel(RESEARCH_WINDOW_LABEL);
  if (existing) {
    try {
      await existing.show();
      await existing.setFocus();
      await existing.setAlwaysOnTop(true);
    } catch (e) {
      console.error("[research-window] focus existing failed", e);
    }
    useResearchStore.getState().setPoppedOut(true);
    return;
  }

  // Position near the top-right of the current screen (logical px).
  const screenW =
    typeof window !== "undefined" ? window.screen.availWidth : 1200;
  // Default wide enough that card content never clips at the default size.
  const width = 440;
  const x = Math.max(24, screenW - width - 24);
  const y = 72;

  const win = new WebviewWindow(RESEARCH_WINDOW_LABEL, {
    url: "research.html",
    title: "Research",
    width,
    height: 620,
    minWidth: 340,
    minHeight: 200,
    x,
    y,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    shadow: false,
    skipTaskbar: false,
  });

  win.once("tauri://created", () => {
    useResearchStore.getState().setPoppedOut(true);
  });
  win.once("tauri://error", (e) => {
    console.error("[research-window] create error", e);
    useResearchStore.getState().setPoppedOut(false);
  });
  win.once("tauri://destroyed", () => {
    useResearchStore.getState().setPoppedOut(false);
  });
}

function buildSyncPayload(): ResearchSyncPayload {
  const r = useResearchStore.getState();
  return {
    // Show all cards — integrated ones get a badge, they are NOT hidden.
    cards: r.cards,
    analyzing: r.analyzing,
    theme: useAppStore.getState().theme,
    includeInStructure: r.includeInStructure,
    featureGated: r.featureGated,
    analysisError: r.analysisError,
  };
}

/**
 * Sets up the main-window side of the bridge: pushes state to the floating
 * window on every change, and applies actions received from it.
 */
export function useResearchWindowManager(): void {
  useEffect(() => {
    if (!isDesktopTauri()) return;

    let disposed = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const unlisteners: Array<() => void> = [];

    let emitFn: ((event: string, payload?: unknown) => Promise<void>) | null =
      null;

    const pushSync = () => {
      // Only emit when the floating window is actually open.
      if (!useResearchStore.getState().poppedOut) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        emitFn?.("research:sync", buildSyncPayload()).catch(() => {});
      }, 120);
    };

    (async () => {
      const { emit, listen } = await import("@tauri-apps/api/event");
      if (disposed) return;
      emitFn = emit;

      // Close the floating research window when the MAIN window closes —
      // otherwise it orphans / stays open after the main window is gone.
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const unClose = await getCurrentWindow().onCloseRequested(async () => {
          try {
            const rw = await WebviewWindow.getByLabel(RESEARCH_WINDOW_LABEL);
            if (rw) await rw.close();
          } catch {
            /* ignore */
          }
        });
        if (disposed) unClose();
        else unlisteners.push(unClose);
      } catch {
        /* ignore */
      }

      // Floating window asks for initial state on mount.
      unlisteners.push(
        await listen("research:ready", () => {
          emit("research:sync", buildSyncPayload()).catch(() => {});
        }),
      );

      // Apply user actions from the floating window.
      unlisteners.push(
        await listen<ResearchActionPayload>("research:action", async (ev) => {
          const { action, id, docId, value } = ev.payload;
          const store = useResearchStore.getState();
          if (action === "dismiss" && id) {
            store.removeCard(id);
          } else if (action === "insert" && id) {
            const card = store.cards.find((c) => c.id === id);
            if (card) insertResearchCard(card);
          } else if (action === "set-include") {
            store.setIncludeInStructure(!!value);
          } else if (action === "clear") {
            store.clearCards();
          } else if (action === "dismiss-error") {
            store.setAnalysisError(null);
          } else if (action === "open-doc" && docId) {
            useAppStore.getState().setActiveDocId(docId);
            try {
              const { getCurrentWindow } =
                await import("@tauri-apps/api/window");
              await getCurrentWindow().setFocus();
            } catch {
              /* ignore */
            }
          } else if (action === "retry" && id) {
            const card = store.cards.find((c) => c.id === id);
            if (!card) return;
            store.updateCard(id, { loading: true, error: undefined });
            try {
              const result = await groundedSearch(
                card.query,
                card.type,
                card.trigger,
                "",
              );
              store.updateCard(id, {
                summary: result.summary,
                sources: result.sources.map((s) => ({
                  ...s,
                  credibility: s.credibility as ResearchSource["credibility"],
                })),
                loading: false,
                error: undefined,
              });
            } catch (e) {
              store.updateCard(id, {
                loading: false,
                error: e instanceof Error ? e.message : "再試行に失敗しました",
              });
            }
          }
        }),
      );
    })();

    // Push on any research-store or theme change.
    const unsubResearch = useResearchStore.subscribe(pushSync);
    const unsubTheme = useAppStore.subscribe((s, prev) => {
      if (s.theme !== prev.theme) pushSync();
    });

    return () => {
      disposed = true;
      if (debounce) clearTimeout(debounce);
      unsubResearch();
      unsubTheme();
      unlisteners.forEach((u) => u());
    };
  }, []);
}
