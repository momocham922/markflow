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
}

export interface ResearchActionPayload {
  action: "dismiss" | "integrate" | "clear" | "retry" | "open-doc";
  id?: string;
  docId?: string;
}

const isDesktopTauri = () => isTauri && !isMobile;

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
  const width = 380;
  const x = Math.max(24, screenW - width - 24);
  const y = 72;

  const win = new WebviewWindow(RESEARCH_WINDOW_LABEL, {
    url: "research.html",
    title: "Research",
    width,
    height: 600,
    minWidth: 280,
    minHeight: 180,
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
    cards: r.cards.filter((c) => !c.integrated),
    analyzing: r.analyzing,
    theme: useAppStore.getState().theme,
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

      // Floating window asks for initial state on mount.
      unlisteners.push(
        await listen("research:ready", () => {
          emit("research:sync", buildSyncPayload()).catch(() => {});
        }),
      );

      // Apply user actions from the floating window.
      unlisteners.push(
        await listen<ResearchActionPayload>("research:action", async (ev) => {
          const { action, id, docId } = ev.payload;
          const store = useResearchStore.getState();
          if (action === "dismiss" && id) {
            store.removeCard(id);
          } else if (action === "integrate" && id) {
            store.markIntegrated(id);
          } else if (action === "clear") {
            store.clearCards();
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
            } catch {
              store.updateCard(id, { loading: false, error: "Retry failed" });
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
