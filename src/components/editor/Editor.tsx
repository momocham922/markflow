import { useEffect, useCallback, useState, useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { ViewUpdate } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import { marked } from "marked";
import hljs from "highlight.js";
import TurndownService from "turndown";
import { useAppStore } from "@/stores/app-store";
import { useEditorStore } from "@/stores/editor-store";
import { editorThemes } from "@/styles/editor-themes";
import { previewThemes } from "@/styles/preview-themes";
import { markdownShortcuts } from "@/extensions/markdown-shortcuts";
import { EditorToolbar } from "./EditorToolbar";
import { useAutoVersion } from "@/hooks/use-auto-version";
import { useCollaboration } from "@/hooks/use-collaboration";

// HTML → Markdown converter for legacy Tiptap content
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

/** Detect if content is HTML (from old Tiptap editor) */
function isHtmlContent(content: string): boolean {
  return /^\s*<[a-z][\s\S]*>/i.test(content);
}

/** Convert HTML to Markdown, or return as-is if already markdown */
function ensureMarkdown(content: string): string {
  if (!content || !isHtmlContent(content)) return content;
  try {
    return turndown.turndown(content);
  } catch {
    return content;
  }
}

export type PreviewMode = "edit" | "split" | "preview";

// Configure marked with highlight.js
marked.setOptions({
  gfm: true,
  breaks: true,
});

const renderer = new marked.Renderer();
renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
  const highlighted = hljs.highlight(text, { language }).value;
  return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
};
marked.use({ renderer });

export function Editor() {
  const { activeDocId, documents, updateDocument, setActiveDocId, theme, themeSettings } = useAppStore();
  const activeDoc = documents.find((d) => d.id === activeDocId);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("split");
  const setView = useEditorStore((s) => s.setView);
  const viewRef = useRef<EditorView | null>(null);
  const convertedRef = useRef<Set<string>>(new Set());

  // Collab: sync Yjs changes → local store (throttled to avoid thrashing)
  const collabTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCollabChange = useCallback(
    (content: string) => {
      if (!activeDocId) return;
      if (collabTimerRef.current) clearTimeout(collabTimerRef.current);
      collabTimerRef.current = setTimeout(() => {
        updateDocument(activeDocId, { content, updatedAt: Date.now() });
        const firstLine = content.split("\n")[0]?.replace(/^#+\s*/, "").trim();
        if (firstLine) updateDocument(activeDocId, { title: firstLine.slice(0, 50) });
      }, 300);
    },
    [activeDocId, updateDocument],
  );

  // Real-time collaboration via Yjs
  const { extension: collabExtension, active: collabActive, connected: collabConnected, peers } =
    useCollaboration(activeDocId, activeDoc?.content ?? "", handleCollabChange);

  // Auto-save versions when content changes significantly
  useAutoVersion({
    docId: activeDocId,
    content: activeDoc?.content ?? "",
    title: activeDoc?.title ?? "",
  });

  // Auto-convert legacy HTML content to Markdown on first load
  useEffect(() => {
    if (!activeDocId || !activeDoc?.content) return;
    if (convertedRef.current.has(activeDocId)) return;
    if (isHtmlContent(activeDoc.content)) {
      const md = ensureMarkdown(activeDoc.content);
      convertedRef.current.add(activeDocId);
      updateDocument(activeDocId, { content: md, updatedAt: Date.now() });
    }
  }, [activeDocId, activeDoc?.content, updateDocument]);

  // Memoize extensions (include collab when connected)
  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      markdownShortcuts,
      ...(collabExtension ? [collabExtension] : []),
    ],
    [collabExtension],
  );

  const editorTheme = useMemo(() => {
    const preset = editorThemes[themeSettings.editorTheme] ?? editorThemes.default;
    return theme === "dark" ? preset.dark : preset.light;
  }, [theme, themeSettings.editorTheme]);

  // Convert markdown to HTML for preview (with wiki-link support)
  const previewHtml = useMemo(() => {
    if (!activeDoc?.content) return "";
    try {
      let html = marked.parse(activeDoc.content) as string;
      // Replace [[doc title]] with clickable links
      html = html.replace(/\[\[([^\]]+)\]\]/g, (_match, title: string) => {
        const target = documents.find(
          (d) => d.title.toLowerCase() === title.trim().toLowerCase(),
        );
        if (target) {
          return `<a href="#" class="wikilink" data-doc-id="${target.id}" title="${target.title}">${title}</a>`;
        }
        return `<span class="wikilink-missing" title="Document not found">${title}</span>`;
      });
      return html;
    } catch {
      return activeDoc.content;
    }
  }, [activeDoc?.content, documents]);

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
    const preset = previewThemes[themeSettings.previewTheme];
    if (!preset) return "";
    const vars = { ...preset.variables };
    if (theme === "dark" && preset.dark) {
      Object.assign(vars, preset.dark);
    }
    const entries = Object.entries(vars)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
    return `:root {\n${entries}\n}`;
  }, [themeSettings.previewTheme, theme]);

  const onChange = useCallback(
    (value: string) => {
      if (activeDocId) {
        updateDocument(activeDocId, {
          content: value,
          updatedAt: Date.now(),
        });
        // Auto-update title from first line
        const firstLine = value.split("\n")[0]?.replace(/^#+\s*/, "").trim();
        if (firstLine) {
          updateDocument(activeDocId, { title: firstLine.slice(0, 50) });
        }
      }
    },
    [activeDocId, updateDocument],
  );

  const onCreateEditor = useCallback(
    (view: EditorView) => {
      viewRef.current = view;
      setView(view);
    },
    [setView],
  );

  // Keep the store's view reference in sync on every editor update
  const onUpdate = useCallback(
    (update: ViewUpdate) => {
      if (update.view !== viewRef.current) {
        viewRef.current = update.view;
        setView(update.view);
      }
    },
    [setView],
  );

  // Cleanup on unmount only
  useEffect(() => {
    return () => {
      setView(null);
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  return (
    <div className="flex h-full flex-col">
      <EditorToolbar
        previewMode={previewMode}
        onPreviewModeChange={setPreviewMode}
        collabSlot={
          collabConnected ? (
            <div className="flex items-center gap-1 shrink-0">
              {peers.length > 0 && (
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
              )}
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 ml-1" title="Live collaboration active" />
            </div>
          ) : undefined
        }
      />
      <div className="flex flex-1 overflow-hidden">
        {/* Editor pane — always mounted, hidden in preview-only mode */}
        <div
          className={`overflow-auto editor-scroll ${
            previewMode === "preview"
              ? "hidden"
              : previewMode === "split"
                ? "w-1/2 border-r border-border"
                : "flex-1"
          }`}
        >
          <CodeMirror
            // When collab is active, Yjs owns the doc — don't set value
            {...(collabActive ? {} : { value: activeDoc.content || "" })}
            // When collab is active, Yjs observer handles store sync
            onChange={collabActive ? undefined : onChange}
            extensions={extensions}
            theme={editorTheme}
            onCreateEditor={onCreateEditor}
            onUpdate={onUpdate}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLineGutter: true,
              highlightActiveLine: true,
              foldGutter: true,
              bracketMatching: true,
              closeBrackets: true,
              indentOnInput: true,
            }}
          />
        </div>
        {/* Preview pane — rendered markdown */}
        {previewMode !== "edit" && (
          <div
            className={`overflow-auto preview-scroll ${previewMode === "split" ? "w-1/2" : "flex-1"}`}
          >
            {previewThemeCss && <style>{previewThemeCss}</style>}
            {themeSettings.customPreviewCss && (
              <style>{themeSettings.customPreviewCss}</style>
            )}
            <div
              className="prose max-w-none px-12 py-8"
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
              <div className="px-12 pb-8">
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
    </div>
  );
}
