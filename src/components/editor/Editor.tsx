import {
  useEffect,
  useLayoutEffect,
  useCallback,
  useState,
  useMemo,
  useRef,
  useDeferredValue,
} from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { ViewUpdate } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import { marked } from "marked";
import hljs from "highlight.js";
import TurndownService from "turndown";
import { getPlatform, isIOS, isMobile } from "@/platform";
import {
  isHtmlContent,
  extractYouTubeId,
  escapeHtml,
} from "@/lib/editor-utils";
import { useAppStore } from "@/stores/app-store";
import { useEditorStore } from "@/stores/editor-store";
import { editorThemes } from "@/styles/editor-themes";
import { previewThemes } from "@/styles/preview-themes";
import { markdownShortcuts } from "@/extensions/markdown-shortcuts";
import { imagePaste, processImagePath } from "@/extensions/image-paste";
import { EditorToolbar } from "./EditorToolbar";
import { VoicePanel } from "./VoicePanel";
import { ResearchPanel } from "./ResearchPanel";
import { useResearchPipeline } from "@/hooks/use-research-pipeline";
import { useAutoVersion } from "@/hooks/use-auto-version";
import { useCollaboration } from "@/hooks/use-collaboration";
import {
  useAuthStore,
  markCollabActive,
  markCollabInactive,
} from "@/stores/auth-store";
import { MindMapView } from "./MindMapView";
import { MindMapEditor, createInitialMindMapData } from "./MindMapEditor";
import mermaid from "mermaid";

// HTML → Markdown converter for legacy Tiptap content
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

/** Convert HTML to Markdown, or return as-is if already markdown */
function ensureMarkdown(content: string): string {
  if (!content || !isHtmlContent(content)) return content;
  try {
    return turndown.turndown(content);
  } catch {
    return content;
  }
}

export type PreviewMode = "edit" | "split" | "preview" | "mindmap";

// Configure marked with highlight.js
marked.setOptions({
  gfm: true,
  breaks: true,
});

const renderer = new marked.Renderer();
renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  if (lang === "mermaid") {
    const escaped = escapeHtml(text);
    return `<div class="mermaid" data-mermaid-source="${escaped}"></div>`;
  }
  const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
  const highlighted = hljs.highlight(text, { language }).value;
  return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
};

// OGP data cache (persists across re-renders, cleared on page reload)
interface OgpData {
  title: string;
  description: string;
  image: string;
  site_name: string;
  url: string;
}
const ogpCache = new Map<string, OgpData | "loading" | "error">();

// Track URLs that need OGP fetching — collected during marked render, consumed by useEffect
let pendingOgpUrls: string[] = [];

/** Build OGP card HTML from cached data */
function buildLinkCardHtml(data: OgpData, url: string): string {
  let domain: string;
  try {
    domain = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    domain = url;
  }
  const safeUrl = escapeHtml(url);
  const safeImage = data.image ? escapeHtml(data.image) : "";
  const safeTitle = escapeHtml(data.title || domain);
  const desc = data.description
    ? data.description.slice(0, 120) +
      (data.description.length > 120 ? "…" : "")
    : "";
  const safeSite = escapeHtml(data.site_name || domain);
  return `<div class="link-card"><a href="${safeUrl}" class="link-card-inner" target="_blank" rel="noopener noreferrer">
    ${safeImage ? `<img class="link-card-image" src="${safeImage}" alt="" loading="lazy" />` : ""}
    <div class="link-card-body">
      <div class="link-card-title">${safeTitle}</div>
      ${desc ? `<div class="link-card-desc">${escapeHtml(desc)}</div>` : ""}
      <div class="link-card-url">${safeSite}</div>
    </div>
  </a></div>`;
}

// YouTube & OGP link card rendering
renderer.link = function ({ href, text }: { href: string; text: string }) {
  // Block dangerous protocols (javascript:, data:, vbscript:)
  if (/^(javascript|data|vbscript):/i.test(href.trim())) {
    return escapeHtml(text);
  }
  const videoId = extractYouTubeId(href);
  if (videoId) {
    // videoId is validated as [a-zA-Z0-9_-]{11} by regex — safe to embed
    return `<div class="youtube-embed">
      <iframe src="https://www.youtube.com/embed/${videoId}" frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen></iframe>
      <p class="youtube-embed-title">${text !== href ? escapeHtml(text) : ""}</p>
    </div>`;
  }
  // Bare URL (text matches href) → render as OGP link card
  if (text === href && /^https?:\/\//i.test(href)) {
    // Check cache synchronously — if data exists, render full card inline
    const cached = ogpCache.get(href);
    if (cached && cached !== "loading" && cached !== "error") {
      return buildLinkCardHtml(cached, href);
    }
    // Not yet cached or stale "loading" — mark for fetch, render fallback
    if (!cached || cached === "loading") pendingOgpUrls.push(href);
    const escaped = escapeHtml(href);
    return `<div class="link-card">
      <a href="${escaped}" class="link-card-fallback" target="_blank" rel="noopener noreferrer">${escaped}</a>
    </div>`;
  }
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
};

marked.use({ renderer });

const MERMAID_FONT =
  'ui-sans-serif, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';

function initMermaid() {
  mermaid.initialize({
    startOnLoad: false,
    theme: "default",
    themeVariables: { fontFamily: MERMAID_FONT, fontSize: "14px" },
    flowchart: { htmlLabels: false, padding: 15, useMaxWidth: true },
    sequence: { useMaxWidth: true },
  });
}

initMermaid();

// Module-level cache — survives component remounts
const mermaidSvgCache = new Map<string, string>();

function fixMermaidSvg(el: HTMLElement, dark: boolean) {
  const svg = el.querySelector("svg") as SVGSVGElement | null;
  if (!svg) return;

  let modified = false;
  const SKIP_CLASSES = new Set([
    "actor",
    "note",
    "activation0",
    "activation1",
    "activation2",
  ]);
  const allRects = Array.from(svg.querySelectorAll("rect"));

  // --- Expand note rects to fit CJK text ---
  for (const noteRect of allRects.filter((r) => r.classList.contains("note"))) {
    const g = noteRect.parentElement;
    if (!g) continue;
    const textEls = g.querySelectorAll("text");
    if (textEls.length === 0) continue;

    const rx = parseFloat(noteRect.getAttribute("x") || "0");
    const rw = parseFloat(noteRect.getAttribute("width") || "0");

    let minTx = Infinity;
    let maxTr = -Infinity;
    for (const t of Array.from(textEls)) {
      try {
        const bb = (t as SVGTextElement).getBBox();
        if (bb.width > 0) {
          minTx = Math.min(minTx, bb.x);
          maxTr = Math.max(maxTr, bb.x + bb.width);
        }
      } catch {
        /* getBBox fails if not visible */
      }
    }
    if (maxTr === -Infinity) continue;

    const pad = 18;
    const newX = Math.min(rx, minTx - pad);
    const newRight = Math.max(rx + rw, maxTr + pad);
    if (newRight - newX > rw + 1) {
      noteRect.setAttribute("x", String(newX));
      noteRect.setAttribute("width", String(newRight - newX));
      modified = true;
    }
  }

  // --- Identify section background rects by rgb() fill (from `rect rgb(...)` directive) ---
  const sectionRects = allRects.filter((r) => {
    for (const c of r.classList) if (SKIP_CLASSES.has(c)) return false;
    const fill = r.getAttribute("fill") || "";
    return /^rgba?\s*\(/i.test(fill);
  });

  // --- Normalize section rect widths ---
  if (sectionRects.length >= 2) {
    let minX = Infinity;
    let maxR = 0;
    for (const r of sectionRects) {
      const x = parseFloat(r.getAttribute("x") || "0");
      const w = parseFloat(r.getAttribute("width") || "0");
      minX = Math.min(minX, x);
      maxR = Math.max(maxR, x + w);
    }
    for (const r of sectionRects) {
      r.setAttribute("x", String(minX));
      r.setAttribute("width", String(maxR - minX));
    }
    modified = true;
  }

  // --- Dark mode: transparent main bg + darken section colors ---
  if (dark) {
    // Make the largest rect (main background) transparent
    let mainBg: Element | null = null;
    let maxArea = 0;
    for (const r of allRects) {
      if (sectionRects.includes(r)) continue;
      const a =
        parseFloat(r.getAttribute("width") || "0") *
        parseFloat(r.getAttribute("height") || "0");
      if (a > maxArea) {
        maxArea = a;
        mainBg = r;
      }
    }
    if (mainBg) {
      mainBg.setAttribute("fill", "transparent");
      modified = true;
    }

    for (const r of sectionRects) {
      const fill = r.getAttribute("fill") || "";
      const m = fill.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (m) {
        r.setAttribute(
          "fill",
          `rgba(${Math.round(Number(m[1]) * 0.25)}, ${Math.round(Number(m[2]) * 0.25)}, ${Math.round(Number(m[3]) * 0.25)}, 0.6)`,
        );
      }
      const stroke = r.getAttribute("stroke") || "";
      const sm = stroke.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (sm) {
        r.setAttribute(
          "stroke",
          `rgba(${Math.round(Number(sm[1]) * 0.35)}, ${Math.round(Number(sm[2]) * 0.35)}, ${Math.round(Number(sm[3]) * 0.35)}, 0.5)`,
        );
      }
    }
  }

  // --- Update viewBox only if elements were expanded AND getBBox is valid ---
  if (modified) {
    try {
      const bbox = svg.getBBox();
      if (bbox.width > 10 && bbox.height > 10) {
        const pad = 8;
        svg.setAttribute(
          "viewBox",
          `${bbox.x - pad} ${bbox.y - pad} ${bbox.width + pad * 2} ${bbox.height + pad * 2}`,
        );
        svg.style.maxWidth = `${bbox.width + pad * 2}px`;
      }
    } catch {
      /* getBBox may fail if SVG not yet laid out */
    }
  }
}

export function Editor() {
  const {
    activeDocId,
    documents,
    updateDocument,
    setActiveDocId,
    theme,
    themeSettings,
    customPreviewThemes,
  } = useAppStore();
  const user = useAuthStore((s) => s.user);
  const activeDoc = documents.find((d) => d.id === activeDocId);
  const [previewMode, setPreviewMode] = useState<PreviewMode>(
    isMobile ? "edit" : "split",
  );
  const [scrollSyncEnabled, setScrollSyncEnabled] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [ogpVersion, setOgpVersion] = useState(0);
  const pendingOgpUrlsRef = useRef<string[]>([]);
  const setView = useEditorStore((s) => s.setView);
  const viewRef = useRef<EditorView | null>(null);
  const convertedRef = useRef<Set<string>>(new Set());

  // For shared docs: freeze value per-mount so @uiw/react-codemirror
  // never dispatches value-driven transactions that fight yCollab.
  // Update frozen content when switching docs (activeDocId changes → CodeMirror remounts).
  const frozenContentRef = useRef<Record<string, string>>({});
  const prevActiveDocRef = useRef<string | null>(null);
  if (
    activeDocId &&
    activeDoc?.isShared &&
    activeDocId !== prevActiveDocRef.current
  ) {
    // Clean up old entry to prevent memory leak (only keep current doc)
    if (prevActiveDocRef.current && prevActiveDocRef.current !== activeDocId) {
      delete frozenContentRef.current[prevActiveDocRef.current];
    }
    frozenContentRef.current[activeDocId] = activeDoc.content || "";
  }
  prevActiveDocRef.current = activeDocId ?? null;

  // Collab: sync Yjs changes → local store (already throttled by observer)
  const handleCollabChange = useCallback(
    (content: string) => {
      if (!activeDocId) return;
      // Allow intentional content clearing from collab
      const updates: { content: string; updatedAt: number; title?: string } = {
        content,
        updatedAt: Date.now(),
      };
      // Auto-derive title from first heading for owned docs (or personal docs).
      // Skip for pinned titles and non-owned shared/team docs (their title comes from cloud).
      const isOwned = !activeDoc?.ownerId || activeDoc.ownerId === user?.uid;
      if (!activeDoc?.titlePinned && isOwned) {
        const firstLine = content
          .split("\n")[0]
          ?.replace(/^#+\s*/, "")
          .trim();
        if (firstLine) updates.title = firstLine.slice(0, 50);
      }
      updateDocument(activeDocId, updates);
    },
    [
      activeDocId,
      activeDoc?.titlePinned,
      activeDoc?.ownerId,
      user?.uid,
      updateDocument,
    ],
  );

  // Callback: sync Y.Text content → frozen value BEFORE yCollab activates.
  // This ensures value prop matches Y.Text, preventing content duplication.
  const handleBeforeCollab = useCallback(
    (docId: string, ytextContent: string) => {
      frozenContentRef.current[docId] = ytextContent;
    },
    [],
  );

  // Real-time collaboration via Yjs — only for shared documents
  const {
    extension: collabExtension,
    connected: collabConnected,
    peers,
    docId: collabDocId,
    enabled: collabEnabled,
    wsTimedOut,
    replaceContent: collabReplaceContent,
  } = useCollaboration(
    activeDocId,
    activeDoc?.content ?? "",
    handleCollabChange,
    activeDoc?.isShared ?? false,
    handleBeforeCollab,
  );
  const isCollabReady = Boolean(
    activeDocId && collabExtension && collabDocId === activeDocId,
  );

  // Keep frozenContentRef fresh while CodeMirror is unmounted (during collab reconnection).
  // Without this, remounting after "Syncing document..." overlay shows stale/empty content.
  if (activeDocId && activeDoc?.isShared && !isCollabReady) {
    frozenContentRef.current[activeDocId] = activeDoc.content || "";
  }

  // Track active collab docs so syncFromCloud/syncToCloud skip them
  useEffect(() => {
    if (isCollabReady && activeDocId) {
      markCollabActive(activeDocId);
      return () => {
        markCollabInactive(activeDocId);
      };
    }
  }, [isCollabReady, activeDocId]);

  // Auto-save versions when content changes significantly
  // In collab mode, only save for local edits (not remote yCollab sync)
  const { markLocalEdit } = useAutoVersion({
    docId: activeDocId,
    content: activeDoc?.content ?? "",
    title: activeDoc?.title ?? "",
    collabActive: isCollabReady,
  });

  useResearchPipeline({
    isRecording: voiceRecording,
    fullTranscript: voiceTranscript,
    documentContent: activeDoc?.content || "",
    activeDocId,
  });

  // Auto-convert legacy HTML content to Markdown on first load
  useEffect(() => {
    if (!activeDocId || !activeDoc?.content) return;
    if (convertedRef.current.has(activeDocId)) return;
    if (isHtmlContent(activeDoc.content)) {
      const md = ensureMarkdown(activeDoc.content);
      convertedRef.current.add(activeDocId);
      // Only update if conversion produced non-empty content
      if (md.trim()) {
        updateDocument(activeDocId, { content: md, updatedAt: Date.now() });
      }
    } else {
      // Mark as processed even if not HTML to prevent re-checking
      convertedRef.current.add(activeDocId);
    }
  }, [activeDocId, activeDoc?.content, updateDocument]);

  // Stable reference prevents @uiw/react-codemirror from reconfiguring on every render
  // (inline object literal → new ref each render → StateEffect.reconfigure on every render)
  const basicSetupConfig = useMemo(
    () => ({
      lineNumbers: true,
      highlightActiveLineGutter: !isIOS,
      highlightActiveLine: true,
      foldGutter: !isIOS,
      bracketMatching: true,
      closeBrackets: true,
      indentOnInput: true,
    }),
    [],
  );

  // iOS: compact gutter via CodeMirror theme (CSS can't override CM's inline width calc)
  const iosGutterTheme = useMemo(() => {
    if (!isIOS) return [];
    return [
      EditorView.theme({
        ".cm-gutters": {
          borderRight: "none",
        },
        ".cm-lineNumbers .cm-gutterElement": {
          fontSize: "9px",
          lineHeight: "16.5px",
          opacity: "0.4",
        },
      }),
      // Force narrow gutter via stylesheet with !important (overrides CM's inline width)
      EditorView.baseTheme({
        "&light .cm-lineNumbers, &dark .cm-lineNumbers": {
          minWidth: "0 !important",
          width: "auto !important",
        },
        "&light .cm-lineNumbers .cm-gutterElement, &dark .cm-lineNumbers .cm-gutterElement":
          {
            minWidth: "0 !important",
            padding: "0 1px 0 2px !important",
          },
        "&light .cm-gutters, &dark .cm-gutters": {
          paddingRight: "0 !important",
        },
        "&light .cm-line, &dark .cm-line": {
          paddingLeft: "4px !important",
        },
      }),
    ];
  }, []);

  // Include yCollab directly in extensions. CodeMirror reconciles same-instance
  // extensions across reconfigures, so the ySync ViewPlugin survives as long as
  // collabExtension reference is stable (which it is — only changes on doc switch
  // or collab activation).
  const extensions = useMemo(
    () => [
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        addKeymap: false,
      }),
      EditorView.lineWrapping,
      markdownShortcuts,
      imagePaste,
      ...iosGutterTheme,
      ...(isCollabReady && collabExtension ? [collabExtension] : []),
    ],
    [iosGutterTheme, isCollabReady, collabExtension],
  );

  const editorTheme = useMemo(() => {
    const preset =
      editorThemes[themeSettings.editorTheme] ?? editorThemes.default;
    return theme === "dark" ? preset.dark : preset.light;
  }, [theme, themeSettings.editorTheme]);

  // Defer preview content so marked.parse() doesn't block editor input on heavy docs
  const deferredContent = useDeferredValue(activeDoc?.content ?? "");

  // Convert markdown to HTML for preview (with wiki-link support)
  // ogpVersion dependency: re-render when OGP data arrives so cards render inline
  const previewHtml = useMemo(() => {
    if (!deferredContent) return "";
    pendingOgpUrls = [];
    try {
      let html = marked.parse(deferredContent) as string;
      // Protect code/pre/mermaid blocks from wiki-link replacement
      const codeBlocks: string[] = [];
      html = html.replace(
        /<(pre|code)[^>]*>[\s\S]*?<\/\1>|<div class="mermaid"[^>]*>[\s\S]*?<\/div>/gi,
        (match) => {
          codeBlocks.push(match);
          return `\x00CB${codeBlocks.length - 1}\x00`;
        },
      );
      // Replace [[doc title]] with clickable links
      html = html.replace(/\[\[([^\]]+)\]\]/g, (_match, title: string) => {
        const target = documents.find(
          (d) => d.title.toLowerCase() === title.trim().toLowerCase(),
        );
        if (target) {
          return `<a href="#" class="wikilink" data-doc-id="${escapeHtml(target.id)}" title="${escapeHtml(target.title)}">${escapeHtml(title)}</a>`;
        }
        return `<span class="wikilink-missing" title="Document not found">${escapeHtml(title)}</span>`;
      });
      // Restore code/pre blocks
      html = html.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);
      // Make task checkboxes interactive (remove disabled, add index + class)
      let cbIdx = 0;
      html = html.replace(
        /<input (checked="" )?disabled="" type="checkbox">/g,
        (_match, checked) => {
          const idx = cbIdx++;
          return `<input type="checkbox" class="task-checkbox" data-checkbox-index="${idx}"${checked ? " checked" : ""}>`;
        },
      );
      // Capture pending URLs to ref (survives concurrent renders)
      // eslint-disable-next-line react-compiler/react-compiler
      pendingOgpUrlsRef.current = [...pendingOgpUrls];
      return html;
    } catch {
      return deferredContent;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredContent, documents, ogpVersion]);

  // Mermaid diagram rendering — split into two phases:
  // 1. useLayoutEffect: synchronous cache restore (runs BEFORE browser paint — no plaintext flash)
  // 2. useEffect: async mermaid.render() for uncached diagrams
  const previewRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const editorScrollRef = useRef<HTMLDivElement>(null);
  const prevThemeRef = useRef(theme);

  const restoreMermaidFromCache = useCallback(
    (container: HTMLElement) => {
      const prefix = theme === "dark" ? "d:" : "l:";
      const divs = container.querySelectorAll<HTMLElement>(".mermaid");
      for (const el of Array.from(divs)) {
        const source = el.getAttribute("data-mermaid-source") || "";
        if (!source) continue;
        const hasSvg = el.querySelector("svg") !== null;
        if (hasSvg) continue;
        const cached = mermaidSvgCache.get(prefix + source);
        if (cached) {
          el.setAttribute("data-mermaid-processed", "true");
          el.innerHTML = cached;
        } else {
          el.removeAttribute("data-mermaid-processed");
        }
      }
    },
    [theme],
  );

  const previewVisible = previewMode !== "edit" && previewMode !== "mindmap";

  useLayoutEffect(() => {
    if (!previewVisible) return;
    const container = previewRef.current;
    if (!container) return;
    const themeChanged = prevThemeRef.current !== theme;
    prevThemeRef.current = theme;
    if (themeChanged) {
      container
        .querySelectorAll<HTMLElement>(".mermaid[data-mermaid-processed]")
        .forEach((el) => {
          el.removeAttribute("data-mermaid-processed");
          el.innerHTML = "";
        });
      return;
    }
    restoreMermaidFromCache(container);
  }, [previewHtml, theme, previewVisible, restoreMermaidFromCache]);

  const renderMermaidRef = useRef<(() => void) | null>(null);
  renderMermaidRef.current = () => {
    const container = previewRef.current;
    if (!container) return;
    const isDark = theme === "dark";
    const prefix = isDark ? "d:" : "l:";
    const divs = container.querySelectorAll<HTMLElement>(".mermaid");
    const needsRender = Array.from(divs).filter((el) => {
      if (el.querySelector("svg")) return false;
      return true;
    });
    if (needsRender.length === 0) return;
    (async () => {
      for (const el of needsRender) {
        if (!el.isConnected || el.querySelector("svg")) continue;
        const source = el.getAttribute("data-mermaid-source") || "";
        if (!source) continue;
        el.setAttribute("data-mermaid-processed", "true");
        const cached = mermaidSvgCache.get(prefix + source);
        if (cached) {
          el.innerHTML = cached;
          continue;
        }
        try {
          const { svg, bindFunctions } = await mermaid.render(
            `mermaid-${Math.random().toString(36).slice(2)}`,
            source,
          );
          mermaidSvgCache.set(prefix + source, svg);
          if (!el.isConnected) continue;
          el.innerHTML = svg;
          bindFunctions?.(el);
          try {
            fixMermaidSvg(el, isDark);
            mermaidSvgCache.set(prefix + source, el.innerHTML);
          } catch {
            /* fixMermaidSvg failed — cache still has raw SVG */
          }
        } catch (e) {
          console.error("[mermaid] render failed:", e);
          el.textContent = String(e);
        }
      }
    })();
  };

  useEffect(() => {
    if (!previewVisible) return;
    renderMermaidRef.current?.();
    const t1 = setTimeout(() => renderMermaidRef.current?.(), 150);
    const t2 = setTimeout(() => renderMermaidRef.current?.(), 600);
    const t3 = setTimeout(() => renderMermaidRef.current?.(), 2000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [previewHtml, theme, previewVisible]);

  useEffect(() => {
    if (!previewVisible) return;
    const container = previewRef.current;
    if (!container) return;
    const observer = new MutationObserver(() => {
      restoreMermaidFromCache(container);
      requestAnimationFrame(() => renderMermaidRef.current?.());
    });
    observer.observe(container, { childList: true });
    return () => observer.disconnect();
  }, [previewVisible, restoreMermaidFromCache]);

  // Fetch OGP data for pending URLs collected during marked render
  useEffect(() => {
    const urls = [...pendingOgpUrlsRef.current];
    if (urls.length === 0) return;

    let cancelled = false;
    (async () => {
      let fetched = 0;
      for (const url of urls) {
        if (cancelled) break;
        const cached = ogpCache.get(url);
        if (cached && cached !== "loading") continue;
        ogpCache.set(url, "loading");
        try {
          const platform = await getPlatform();
          const data = await platform.fetchOgp(url);
          if (cancelled) break;
          ogpCache.set(url, data);
          fetched++;
        } catch {
          ogpCache.set(url, "error");
        }
      }
      if (fetched > 0 && !cancelled) {
        setOgpVersion((v) => v + 1);
      }
    })();

    return () => {
      cancelled = true;
      // Clean up stale "loading" entries so URLs get re-fetched on next render
      for (const url of urls) {
        if (ogpCache.get(url) === "loading") ogpCache.delete(url);
      }
    };
  }, [previewHtml]);

  // Backlinks: documents that link to this one
  const backlinks = useMemo(() => {
    if (!activeDoc) return [];
    const title = activeDoc.title.toLowerCase();
    return documents.filter(
      (d) =>
        d.id !== activeDoc.id &&
        d.content.match(
          new RegExp(
            `\\[\\[${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\]`,
            "i",
          ),
        ),
    );
  }, [activeDoc, documents]);

  // Build preview theme CSS variables as a <style> tag override
  const previewThemeCss = useMemo(() => {
    // Check built-in themes first, then custom themes
    const preset =
      previewThemes[themeSettings.previewTheme] ??
      customPreviewThemes.find((t) => t.id === themeSettings.previewTheme);
    if (!preset) return "";
    const vars = { ...preset.variables };
    if (theme === "dark" && preset.dark) {
      Object.assign(vars, preset.dark);
    }
    const entries = Object.entries(vars)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
    return `:root {\n${entries}\n}`;
  }, [themeSettings.previewTheme, theme, customPreviewThemes]);

  const onChange = useCallback(
    (value: string) => {
      if (!activeDocId) return;
      // Allow intentional content clearing — don't block empty content
      const updates: { content: string; updatedAt: number; title?: string } = {
        content: value,
        updatedAt: Date.now(),
      };
      // Auto-derive title from first heading for owned docs (or personal docs).
      // Skip for pinned titles and non-owned shared/team docs (their title comes from cloud).
      const isOwned = !activeDoc?.ownerId || activeDoc.ownerId === user?.uid;
      if (!activeDoc?.titlePinned && isOwned) {
        const firstLine = value
          .split("\n")[0]
          ?.replace(/^#+\s*/, "")
          .trim();
        if (firstLine) updates.title = firstLine.slice(0, 50);
      }
      updateDocument(activeDocId, updates);
    },
    [
      activeDocId,
      activeDoc?.titlePinned,
      activeDoc?.ownerId,
      user?.uid,
      updateDocument,
    ],
  );

  const onCreateEditor = useCallback(
    (view: EditorView) => {
      viewRef.current = view;
      setView(view);
    },
    [setView],
  );

  // Keep the store's view reference in sync on every editor update
  // Also detect local edits (vs remote yCollab sync) for auto-version
  const isCollabReadyRef = useRef(isCollabReady);
  isCollabReadyRef.current = isCollabReady;
  const markLocalEditRef = useRef(markLocalEdit);
  markLocalEditRef.current = markLocalEdit;

  const onUpdate = useCallback(
    (update: ViewUpdate) => {
      if (update.view !== viewRef.current) {
        viewRef.current = update.view;
        setView(update.view);
      }
      // In collab mode, detect local user edits for auto-version.
      // Remote yCollab sync transactions lack userEvent annotations.
      if (isCollabReadyRef.current && update.docChanged) {
        const hasLocal = update.transactions.some(
          (tr) =>
            tr.docChanged &&
            (tr.isUserEvent("input") ||
              tr.isUserEvent("delete") ||
              tr.isUserEvent("undo") ||
              tr.isUserEvent("redo") ||
              tr.isUserEvent("move")),
        );
        if (hasLocal) markLocalEditRef.current();
      }
    },
    [setView],
  );

  // Restore a version's content into the document
  // FIX: Also update Y.Doc for collab documents so the editor reflects the restored version
  const handleRestoreVersion = useCallback(
    (content: string) => {
      if (!activeDocId || !content.trim()) return;
      updateDocument(activeDocId, { content, updatedAt: Date.now() });
      if (isCollabReady) {
        collabReplaceContent(content);
      }
    },
    [activeDocId, updateDocument, isCollabReady, collabReplaceContent],
  );

  // Watch for pending restore from VersionPanel (store-based bridge)
  const pendingRestoreContent = useAppStore((s) => s.pendingRestoreContent);
  const clearPendingRestore = useAppStore((s) => s.setPendingRestoreContent);
  useEffect(() => {
    if (pendingRestoreContent !== null) {
      handleRestoreVersion(pendingRestoreContent);
      clearPendingRestore(null);
    }
  }, [pendingRestoreContent, handleRestoreVersion, clearPendingRestore]);

  // Apply pending insert from AI panel (iOS: panel closes first, then insert fires)
  const pendingInsert = useEditorStore((s) => s.pendingInsert);
  const clearPendingInsert = useEditorStore((s) => s.setPendingInsert);
  useEffect(() => {
    if (pendingInsert && viewRef.current) {
      const view = viewRef.current;
      if (pendingInsert.mode === "replace") {
        const { from, to } = view.state.selection.main;
        view.dispatch({ changes: { from, to, insert: pendingInsert.text } });
      } else {
        const len = view.state.doc.length;
        view.dispatch({
          changes: { from: len, insert: `\n\n${pendingInsert.text}` },
        });
      }
      view.focus();
      clearPendingInsert(null);
    }
  }, [pendingInsert, clearPendingInsert]);

  // Cleanup on unmount only
  useEffect(() => {
    return () => {
      setView(null);
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll sync between editor and preview in split mode
  useEffect(() => {
    if (!scrollSyncEnabled || previewMode !== "split" || isMobile) return;
    const editorDOM = editorScrollRef.current;
    const previewDOM = previewScrollRef.current;
    if (!editorDOM || !previewDOM) return;

    let lockUntil = 0;
    let lockedBy: "editor" | "preview" | null = null;
    let rafId: number | null = null;
    const LOCK_MS = 120;

    const syncTo = (
      target: HTMLElement,
      source: HTMLElement,
      origin: "editor" | "preview",
    ) => {
      const now = performance.now();
      if (lockedBy && lockedBy !== origin && now < lockUntil) return;
      lockedBy = origin;
      lockUntil = now + LOCK_MS;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const srcMax = source.scrollHeight - source.clientHeight;
        if (srcMax <= 0) return;
        const pct = source.scrollTop / srcMax;
        const tgtMax = target.scrollHeight - target.clientHeight;
        target.scrollTop = Math.round(tgtMax * pct);
      });
    };

    const onEditorScroll = () => syncTo(previewDOM, editorDOM, "editor");
    const onPreviewScroll = () => syncTo(editorDOM, previewDOM, "preview");

    editorDOM.addEventListener("scroll", onEditorScroll, { passive: true });
    previewDOM.addEventListener("scroll", onPreviewScroll, { passive: true });
    return () => {
      editorDOM.removeEventListener("scroll", onEditorScroll);
      previewDOM.removeEventListener("scroll", onPreviewScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [scrollSyncEnabled, previewMode, activeDocId]);

  // Handle Tauri native file drag-and-drop for images
  // WKWebView cannot receive browser-native drop events from Finder,
  // so we must use Tauri's event API with dragDropEnabled: true.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const imageExts = new Set([
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "svg",
      "bmp",
    ]);

    (async () => {
      try {
        const platform = await getPlatform();
        unlisten =
          (await platform.onDragDrop(async (paths, position) => {
            const view = viewRef.current;
            if (!view) return;
            if (!paths?.length) return;

            const imagePaths = paths.filter((p) => {
              const ext = p.split(".").pop()?.toLowerCase() ?? "";
              return imageExts.has(ext);
            });
            if (!imagePaths.length) return;

            const pos =
              view.posAtCoords({ x: position.x, y: position.y }) ??
              view.state.selection.main.head;
            const placeholder = "![Uploading image...]()";
            view.dispatch({
              changes: { from: pos, insert: placeholder + "\n" },
            });

            try {
              const markdowns = await Promise.all(
                imagePaths.map((p) => processImagePath(p)),
              );
              const v = viewRef.current;
              if (v) {
                const doc = v.state.doc.toString();
                const idx = doc.indexOf(placeholder);
                if (idx >= 0) {
                  v.dispatch({
                    changes: {
                      from: idx,
                      to: idx + placeholder.length,
                      insert: markdowns.join("\n"),
                    },
                  });
                }
              }
            } catch (err: unknown) {
              const v = viewRef.current;
              if (v) {
                const doc = v.state.doc.toString();
                const idx = doc.indexOf(placeholder);
                if (idx >= 0) {
                  const errMsg = `![Upload failed: ${err instanceof Error ? err.message : String(err)}]()`;
                  v.dispatch({
                    changes: {
                      from: idx,
                      to: idx + placeholder.length,
                      insert: errMsg,
                    },
                  });
                }
              }
            }
          })) ?? undefined;
      } catch {
        /* not in Tauri */
      }
    })();
    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Callbacks for mind map editor
  const handleMindMapChange = useCallback(
    (content: string) => {
      if (!activeDocId) return;
      updateDocument(activeDocId, { content, updatedAt: Date.now() });
    },
    [activeDocId, updateDocument],
  );
  const handleMindMapTitleChange = useCallback(
    (title: string) => {
      if (!activeDocId) return;
      updateDocument(activeDocId, { title, updatedAt: Date.now() });
    },
    [activeDocId, updateDocument],
  );

  // Voice input — always show button; errors handled in useVoiceInput on start
  const voiceSupported = true;

  const handleInsertMarkdown = useCallback(
    (markdown: string) => {
      if (!activeDocId) return;
      const current = activeDoc?.content ?? "";
      const newContent = current.trimEnd() + markdown;
      updateDocument(activeDocId, {
        content: newContent,
        updatedAt: Date.now(),
      });
      if (isCollabReady) {
        collabReplaceContent(newContent);
      }
    },
    [
      activeDocId,
      activeDoc?.content,
      updateDocument,
      isCollabReady,
      collabReplaceContent,
    ],
  );

  const handleSetContent = useCallback(
    (newContent: string) => {
      if (!activeDocId) return;
      updateDocument(activeDocId, {
        content: newContent,
        updatedAt: Date.now(),
      });
      if (isCollabReady) {
        collabReplaceContent(newContent);
      }
    },
    [activeDocId, updateDocument, isCollabReady, collabReplaceContent],
  );

  if (!activeDoc) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="text-center space-y-2">
          <p className="text-lg font-medium">No document selected</p>
          <p className="text-sm">
            Create a new document or select one from the sidebar
          </p>
        </div>
      </div>
    );
  }

  // Standalone mind map document — uses dedicated editor, no markdown
  if (activeDoc.docType === "mindmap") {
    return (
      <div className="flex h-full flex-col relative">
        <MindMapEditor
          key={activeDocId}
          content={
            activeDoc.content ||
            JSON.stringify(createInitialMindMapData(activeDoc.title))
          }
          title={activeDoc.title}
          onChange={handleMindMapChange}
          onTitleChange={handleMindMapTitleChange}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <EditorToolbar
        previewMode={previewMode}
        onPreviewModeChange={setPreviewMode}
        voiceActive={voiceOpen}
        voiceSupported={voiceSupported}
        onVoiceToggle={() => setVoiceOpen((v) => !v)}
        scrollSyncEnabled={scrollSyncEnabled}
        onScrollSyncToggle={() => setScrollSyncEnabled((v) => !v)}
        collabSlot={
          collabConnected || collabExtension ? (
            <div className="flex items-center gap-1.5 shrink-0 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-0.5">
              <div
                className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"
                title="Live collaboration active"
              />
              {peers.length > 0 ? (
                <>
                  <div className="flex -space-x-1.5">
                    {peers.slice(0, 5).map((peer, i) => (
                      <div
                        key={i}
                        className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-white ring-2 ring-background"
                        style={{ backgroundColor: peer.color }}
                        title={peer.name}
                      >
                        {peer.name.charAt(0).toUpperCase()}
                      </div>
                    ))}
                    {peers.length > 5 && (
                      <div className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground ring-2 ring-background">
                        +{peers.length - 5}
                      </div>
                    )}
                  </div>
                  <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
                    {peers.length} online
                  </span>
                </>
              ) : (
                <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
                  Live
                </span>
              )}
            </div>
          ) : undefined
        }
      />
      <div className="relative flex flex-1 overflow-hidden">
        {voiceOpen && <ResearchPanel />}
        {/* Editor pane — always mounted, hidden in preview-only and mindmap modes */}
        <div
          ref={editorScrollRef}
          className={`overflow-auto editor-scroll ${
            previewMode === "preview" || previewMode === "mindmap"
              ? "hidden"
              : previewMode === "split"
                ? "w-1/2 border-r border-border"
                : "flex-1"
          } ${isIOS ? "ios-editor" : ""}`}
        >
          {collabEnabled && !isCollabReady && !wsTimedOut ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <p className="text-sm">Syncing document...</p>
            </div>
          ) : (
            <CodeMirror
              key={activeDocId}
              value={
                isCollabReady
                  ? frozenContentRef.current[activeDocId!]
                  : activeDoc.content || ""
              }
              onChange={onChange}
              extensions={extensions}
              theme={editorTheme}
              onCreateEditor={onCreateEditor}
              onUpdate={onUpdate}
              basicSetup={basicSetupConfig}
            />
          )}
        </div>
        {/* Mind map view */}
        {previewMode === "mindmap" && (
          <div className="flex-1">
            <MindMapView
              content={activeDoc.content || ""}
              title={activeDoc.title}
              onNodeClick={({ text }) => {
                setPreviewMode("preview");
                setTimeout(() => {
                  const container = previewScrollRef.current;
                  if (!container) return;
                  const headings = container.querySelectorAll(
                    "h1, h2, h3, h4, h5, h6",
                  );
                  for (const heading of headings) {
                    if (heading.textContent?.trim() === text) {
                      heading.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                      });
                      return;
                    }
                  }
                }, 150);
              }}
            />
          </div>
        )}
        {/* Preview pane — rendered markdown */}
        {previewMode !== "edit" && previewMode !== "mindmap" && (
          <div
            ref={previewScrollRef}
            className={`overflow-auto preview-scroll ${previewMode === "split" ? "w-1/2" : "flex-1"} ${isMobile ? "overflow-x-hidden" : ""}`}
          >
            {previewThemeCss && <style>{previewThemeCss}</style>}
            {themeSettings.customPreviewCss && (
              <style>{themeSettings.customPreviewCss}</style>
            )}
            <div
              ref={previewRef}
              className={`prose max-w-none ${isMobile ? "mobile-preview" : "px-12 py-8"}`}
              dangerouslySetInnerHTML={{ __html: previewHtml }}
              onClick={(e) => {
                // Checkbox toggle in preview
                const checkbox = e.target as HTMLInputElement;
                if (
                  checkbox.classList?.contains("task-checkbox") &&
                  activeDocId
                ) {
                  const idx = parseInt(
                    checkbox.getAttribute("data-checkbox-index") || "-1",
                    10,
                  );
                  if (idx >= 0) {
                    const content = activeDoc?.content || "";
                    const lines = content.split("\n");
                    let cbCount = 0;
                    for (let i = 0; i < lines.length; i++) {
                      const match = lines[i].match(/^(\s*[-*+]\s*)\[([ xX])\]/);
                      if (match) {
                        if (cbCount === idx) {
                          const isChecked = match[2] !== " ";
                          lines[i] = lines[i].replace(
                            /\[([ xX])\]/,
                            isChecked ? "[ ]" : "[x]",
                          );
                          updateDocument(activeDocId, {
                            content: lines.join("\n"),
                            updatedAt: Date.now(),
                          });
                          break;
                        }
                        cbCount++;
                      }
                    }
                  }
                  return;
                }
                // Wiki-link click
                const target = (e.target as HTMLElement).closest(".wikilink");
                if (target) {
                  e.preventDefault();
                  const docId = target.getAttribute("data-doc-id");
                  if (docId) setActiveDocId(docId);
                }
              }}
            />
            {/* Backlinks */}
            {backlinks.length > 0 && (
              <div className={isMobile ? "px-4 pb-4" : "px-12 pb-8"}>
                <div className="border-t border-border pt-4 mt-4">
                  <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-2">
                    Backlinks ({backlinks.length})
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {backlinks.map((bl) => (
                      <button
                        key={bl.id}
                        onClick={() => setActiveDocId(bl.id)}
                        className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-xs text-secondary-foreground hover:bg-accent transition-colors"
                      >
                        {bl.title}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {voiceOpen && (
        <VoicePanel
          onInsertMarkdown={handleInsertMarkdown}
          onSetContent={handleSetContent}
          documentContent={activeDoc?.content || ""}
          onTranscriptChange={setVoiceTranscript}
          onRecordingChange={setVoiceRecording}
        />
      )}
    </div>
  );
}
