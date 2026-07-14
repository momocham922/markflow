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
import { auth } from "@/services/firebase";
import type { ResearchCard, ResearchSource } from "@/stores/research-store";
import { isTauri, isMobile } from "@/platform";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";

export const RESEARCH_WINDOW_LABEL = "research";

export interface ResearchSyncPayload {
  cards: ResearchCard[];
  analyzing: boolean;
  theme: "light" | "dark";
  includeInStructure: boolean;
}

export interface ResearchActionPayload {
  action: "dismiss" | "clear" | "retry" | "open-doc" | "insert" | "set-include";
  id?: string;
  docId?: string;
  value?: boolean;
}

const isDesktopTauri = () => isTauri && !isMobile;

/** Format a research card as a Markdown block for insertion into the doc. */
export function formatResearchCardMarkdown(card: ResearchCard): string {
  const sources = card.sources
    .filter((s) => !s.url.startsWith("markflow://"))
    .slice(0, 3)
    .map((s) => `- [${s.title || s.domain}](${s.url})`)
    .join("\n");
  return (
    `\n\n### ${card.query}\n\n${card.summary}` +
    (sources ? `\n\n**Sources**\n${sources}` : "") +
    "\n"
  );
}

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

/** Heading texts (without leading #) from markdown — for topic linking. */
function extractHeadings(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/**
 * Turn a research card into a polished, non-redundant supplement: a natural
 * "〜の件について" heading (NOT the raw query), a concise 1–2 sentence note
 * (not a verbatim dump), a clickable link back to the most relevant meeting
 * topic (`[…への補足](#見出し)` — resolved by Editor's anchor handler), and
 * source links. Falls back to the plain verbatim format if the LLM call
 * cannot be made.
 */
async function buildResearchSupplement(card: ResearchCard): Promise<string> {
  const state = useAppStore.getState();
  const doc = state.documents.find((d) => d.id === state.activeDocId);
  const headings = doc ? extractHeadings(doc.content || "") : [];

  const token = await auth.currentUser?.getIdToken().catch(() => null);
  if (!token || !AI_PROXY_URL) return formatResearchCardMarkdown(card);

  const sources = card.sources
    .filter((s) => !s.url.startsWith("markflow://"))
    .slice(0, 3)
    .map((s) => `- [${s.title || s.domain}](${s.url})`)
    .join("\n");

  const system =
    "You turn ONE web-research finding into a short, tasteful supplement to append to a meeting-minutes document. " +
    "Output ONLY Markdown — no code fences, no commentary. Match the document's language (default Japanese). Rules:\n" +
    "1) Start with an H3 heading phrased naturally as a supplement, e.g. '### 〇〇の件について' — NEVER use the raw search query as the heading.\n" +
    "2) Then 1–2 concise sentences distilling the finding. Do NOT dump the raw summary verbatim; rephrase tightly and drop anything trivial.\n" +
    "3) If exactly one of the provided document headings is clearly the topic this supplements, add on its own line a link: [本文「<HEADING>」への補足](#<HEADING>) — copy the heading text VERBATIM for both the label and after the '#'. If none clearly fits, omit the link entirely.\n" +
    "4) End with the given sources under a '**出典**' label (omit if none).\n" +
    "Keep the whole block short (a few lines).";

  const user =
    `# 調査結果\n- 検索意図: ${card.query}\n- タイプ: ${card.type}\n- 要約: ${card.summary}\n` +
    (sources ? `- 出典:\n${sources}\n` : "") +
    `\n# ドキュメントの見出し一覧（関連トピックの候補。該当が無ければリンク無し）\n` +
    (headings.length
      ? headings.map((h) => `- ${h}`).join("\n")
      : "（見出しなし）");

  try {
    const res = await fetch(`${AI_PROXY_URL}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        system,
        messages: [{ role: "user", content: user }],
        max_tokens: 1024,
        stream: false,
      }),
    });
    if (!res.ok) return formatResearchCardMarkdown(card);
    const data = await res.json();
    const text: string =
      (data?.content as Array<{ text?: string }> | undefined)
        ?.map((b) => b.text || "")
        .join("") || "";
    const clean = text.trim();
    return clean ? `\n\n${clean}\n` : formatResearchCardMarkdown(card);
  } catch {
    return formatResearchCardMarkdown(card);
  }
}

/** Insert a card into the active document (LLM-polished) and mark integrated. */
export async function insertResearchCard(card: ResearchCard): Promise<void> {
  if (!card.summary) return;
  const store = useResearchStore.getState();
  // Already integrated → don't insert a duplicate (LLM call takes ~1–2s, so a
  // second click before it returns would otherwise double-insert).
  if (store.cards.find((c) => c.id === card.id)?.integrated) return;
  // Optimistic: mark now for instant badge feedback and double-click safety;
  // the polished block is appended when the LLM call returns.
  store.markIntegrated(card.id);
  const md = await buildResearchSupplement(card);
  _insertFn?.(md);
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
