import { useEffect, useCallback, useState, useMemo, useRef, useDeferredValue } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { ViewUpdate } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import { marked } from "marked";
import hljs from "highlight.js";
import TurndownService from "turndown";
import { getPlatform, isIOS } from "@/platform";
import { isHtmlContent, extractYouTubeId, escapeHtml } from "@/lib/editor-utils";
import { useAppStore } from "@/stores/app-store";
import { useEditorStore } from "@/stores/editor-store";
import { editorThemes } from "@/styles/editor-themes";
import { previewThemes } from "@/styles/preview-themes";
import { markdownShortcuts } from "@/extensions/markdown-shortcuts";
import { imagePaste, processImagePath } from "@/extensions/image-paste";
import { EditorToolbar } from "./EditorToolbar";
import { VoicePanel } from "./VoicePanel";
import { useAutoVersion } from "@/hooks/use-auto-version";
import { useCollaboration } from "@/hooks/use-collaboration";
import { markCollabActive, markCollabInactive } from "@/stores/auth-store";
import { VersionHistory } from "./VersionHistory";
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
    return `<div class="mermaid">${escapeHtml(text)}</div>`;
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
  const desc = data.description ? data.description.slice(0, 120) + (data.description.length > 120 ? "…" : "") : "";
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

// Initialize mermaid — render on demand, not on load
mermaid.initialize({ startOnLoad: false, theme: "default" });

export function Editor() {
  const { activeDocId, documents, updateDocument, setActiveDocId, theme, themeSettings, customPreviewThemes } = useAppStore();
  const activeDoc = documents.find((d) => d.id === activeDocId);
  const [previewMode, setPreviewMode] = useState<PreviewMode>(isIOS ? "edit" : "split");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
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
  if (activeDocId && activeDoc?.isShared && activeDocId !== prevActiveDocRef.current) {
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
      if (!content.trim()) return;
      const updates: { content: string; updatedAt: number; title?: string } = { content, updatedAt: Date.now() };
      // Skip auto-title for pinned, shared, or team docs
      if (!activeDoc?.titlePinned && !activeDoc?.isShared && !activeDoc?.teamId) {
        const firstLine = content.split("\n")[0]?.replace(/^#+\s*/, "").trim();
        if (firstLine) updates.title = firstLine.slice(0, 50);
      }
      updateDocument(activeDocId, updates);
    },
    [activeDocId, activeDoc?.titlePinned, activeDoc?.isShared, activeDoc?.teamId, updateDocument],
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
  const { extension: collabExtension, connected: collabConnected, peers, docId: collabDocId, enabled: collabEnabled, wsTimedOut, replaceContent: collabReplaceContent } =
    useCollaboration(activeDocId, activeDoc?.content ?? "", handleCollabChange, activeDoc?.isShared ?? false, handleBeforeCollab);
  const isCollabReady = Boolean(activeDocId && collabExtension && collabDocId === activeDocId);

  // Track active collab docs so syncFromCloud/syncToCloud skip them
  useEffect(() => {
    if (isCollabReady && activeDocId) {
      markCollabActive(activeDocId);
      return () => { markCollabInactive(activeDocId); };
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
  const basicSetupConfig = useMemo(() => ({
    lineNumbers: true,
    highlightActiveLineGutter: !isIOS,
    highlightActiveLine: true,
    foldGutter: !isIOS,
    bracketMatching: true,
    closeBrackets: true,
    indentOnInput: true,
  }), []);

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
        "&light .cm-lineNumbers .cm-gutterElement, &dark .cm-lineNumbers .cm-gutterElement": {
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
      markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
      EditorView.lineWrapping,
      markdownShortcuts,
      imagePaste,
      ...iosGutterTheme,
      ...(isCollabReady && collabExtension ? [collabExtension] : []),
    ],
    [iosGutterTheme, isCollabReady, collabExtension],
  );

  const editorTheme = useMemo(() => {
    const preset = editorThemes[themeSettings.editorTheme] ?? editorThemes.default;
    return theme === "dark" ? preset.dark : preset.light;
  }, [theme, themeSettings.editorTheme]);

  // Defer preview content so marked.parse() doesn't block editor input on heavy docs
  const deferredContent = useDeferredValue(activeDoc?.content ?? "");

  // Convert markdown to HTML for preview (with wiki-link support)
  // ogpVersion dependency: re-render when OGP data arrives so cards render inline
  const previewHtml = useMemo(() => {
    if (!deferredContent) return "";
    // Reset pending OGP URLs for this render pass
    pendingOgpUrls = [];
    try {
      let html = marked.parse(deferredContent) as string;
      // Protect code/pre blocks from wiki-link replacement
      const codeBlocks: string[] = [];
      html = html.replace(/<(pre|code)[^>]*>[\s\S]*?<\/\1>/gi, (match) => {
        codeBlocks.push(match);
        return `\x00CB${codeBlocks.length - 1}\x00`;
      });
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
      // Capture pending URLs to ref (survives concurrent renders)
      // eslint-disable-next-line react-compiler/react-compiler
      pendingOgpUrlsRef.current = [...pendingOgpUrls];
      return html;
    } catch {
      return deferredContent;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredContent, documents, ogpVersion]);

  // Render mermaid diagrams after preview HTML updates or theme change
  const previewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = previewRef.current;
    if (!container) return;
    const mermaidDivs = container.querySelectorAll<HTMLElement>(".mermaid");
    if (mermaidDivs.length === 0) return;
    // Reset processed state so mermaid re-renders on content/theme change
    mermaidDivs.forEach((el) => el.removeAttribute("data-processed"));
    mermaid.run({ nodes: Array.from(mermaidDivs) }).catch(() => {});
  }, [previewHtml, theme]);

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

  // Sync mermaid theme with app theme
  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: theme === "dark" ? "dark" : "default",
    });
  }, [theme]);

  // Backlinks: documents that link to this one
  const backlinks = useMemo(() => {
    if (!activeDoc) return [];
    const title = activeDoc.title.toLowerCase();
    return documents.filter(
      (d) =>
        d.id !== activeDoc.id &&
        d.content.match(new RegExp(`\\[\\[${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\]`, "i")),
    );
  }, [activeDoc, documents]);

  // Build preview theme CSS variables as a <style> tag override
  const previewThemeCss = useMemo(() => {
    // Check built-in themes first, then custom themes
    const preset = previewThemes[themeSettings.previewTheme]
      ?? customPreviewThemes.find((t) => t.id === themeSettings.previewTheme);
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
      if (!value.trim()) return;
      const updates: { content: string; updatedAt: number; title?: string } = { content: value, updatedAt: Date.now() };
      // Skip auto-title for pinned, shared, or team docs
      if (!activeDoc?.titlePinned && !activeDoc?.isShared && !activeDoc?.teamId) {
        const firstLine = value.split("\n")[0]?.replace(/^#+\s*/, "").trim();
        if (firstLine) updates.title = firstLine.slice(0, 50);
      }
      updateDocument(activeDocId, updates);
    },
    [activeDocId, activeDoc?.titlePinned, activeDoc?.isShared, activeDoc?.teamId, updateDocument],
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

  // Cleanup on unmount only
  useEffect(() => {
    return () => {
      setView(null);
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle Tauri native file drag-and-drop for images
  // WKWebView cannot receive browser-native drop events from Finder,
  // so we must use Tauri's event API with dragDropEnabled: true.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const imageExts = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);

    (async () => {
      try {
        const platform = await getPlatform();
        unlisten = await platform.onDragDrop(async (paths, position) => {
          const view = viewRef.current;
          if (!view) return;
          if (!paths?.length) return;

          const imagePaths = paths.filter((p) => {
            const ext = p.split(".").pop()?.toLowerCase() ?? "";
            return imageExts.has(ext);
          });
          if (!imagePaths.length) return;

          const pos = view.posAtCoords({ x: position.x, y: position.y })
            ?? view.state.selection.main.head;
          const placeholder = "![Uploading image...]()";
          view.dispatch({ changes: { from: pos, insert: placeholder + "\n" } });

          try {
            const markdowns = await Promise.all(imagePaths.map((p) => processImagePath(p)));
            const v = viewRef.current;
            if (v) {
              const doc = v.state.doc.toString();
              const idx = doc.indexOf(placeholder);
              if (idx >= 0) {
                v.dispatch({ changes: { from: idx, to: idx + placeholder.length, insert: markdowns.join("\n") } });
              }
            }
          } catch (err: unknown) {
            const v = viewRef.current;
            if (v) {
              const doc = v.state.doc.toString();
              const idx = doc.indexOf(placeholder);
              if (idx >= 0) {
                const errMsg = `![Upload failed: ${err instanceof Error ? err.message : String(err)}]()`;
                v.dispatch({ changes: { from: idx, to: idx + placeholder.length, insert: errMsg } });
              }
            }
          }
        }) ?? undefined;
      } catch { /* not in Tauri */ }
    })();
    return () => { unlisten?.(); };
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
      updateDocument(activeDocId, { content: newContent, updatedAt: Date.now() });
      // Also update Y.Doc for collab documents
      if (isCollabReady) {
        collabReplaceContent(newContent);
      }
    },
    [activeDocId, activeDoc?.content, updateDocument, isCollabReady, collabReplaceContent],
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
          content={activeDoc.content || JSON.stringify(createInitialMindMapData(activeDoc.title))}
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
        onHistoryOpen={() => setHistoryOpen(true)}
        voiceActive={voiceOpen}
        voiceSupported={voiceSupported}
        onVoiceToggle={() => setVoiceOpen((v) => !v)}
        collabSlot={
          (collabConnected || collabExtension) ? (
            <div className="flex items-center gap-1.5 shrink-0 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-0.5">
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" title="Live collaboration active" />
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
      <div className="flex flex-1 overflow-hidden">
        {/* Editor pane — always mounted, hidden in preview-only and mindmap modes */}
        <div
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
              value={isCollabReady ? frozenContentRef.current[activeDocId!] : (activeDoc.content || "")}
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
            <MindMapView content={activeDoc.content || ""} title={activeDoc.title} />
          </div>
        )}
        {/* Preview pane — rendered markdown */}
        {previewMode !== "edit" && previewMode !== "mindmap" && (
          <div
            className={`overflow-auto preview-scroll ${previewMode === "split" ? "w-1/2" : "flex-1"} ${isIOS ? "overflow-x-hidden" : ""}`}
          >
            {previewThemeCss && <style>{previewThemeCss}</style>}
            {themeSettings.customPreviewCss && (
              <style>{themeSettings.customPreviewCss}</style>
            )}
            <div
              ref={previewRef}
              className={`prose max-w-none ${isIOS ? "ios-preview" : "px-12 py-8"}`}
              dangerouslySetInnerHTML={{ __html: previewHtml }}
              onClick={(e) => {
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
              <div className={isIOS ? "px-4 pb-4" : "px-12 pb-8"}>
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
      {voiceOpen && <VoicePanel onInsertMarkdown={handleInsertMarkdown} />}
      <VersionHistory
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        docId={activeDocId}
        currentTitle={activeDoc?.title ?? ""}
        onRestore={handleRestoreVersion}
      />
    </div>
  );
}
