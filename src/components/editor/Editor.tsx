import { useEffect, useCallback, useState, useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { marked } from "marked";
import hljs from "highlight.js";
import TurndownService from "turndown";
import { useAppStore } from "@/stores/app-store";
import { useEditorStore } from "@/stores/editor-store";
import { EditorToolbar } from "./EditorToolbar";

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

// Light theme for CodeMirror
const lightTheme = EditorView.theme(
  {
    "&": {
      fontSize: "15px",
      fontFamily:
        '"SF Mono", "Fira Code", "Cascadia Code", "JetBrains Mono", monospace',
    },
    ".cm-content": {
      padding: "2rem 3rem",
      minHeight: "calc(100vh - 8rem)",
      caretColor: "oklch(0.3 0 0)",
    },
    ".cm-gutters": {
      background: "transparent",
      border: "none",
      color: "oklch(0.7 0 0)",
    },
    ".cm-activeLineGutter": {
      background: "transparent",
    },
    ".cm-activeLine": {
      background: "oklch(0 0 0 / 0.03)",
    },
    ".cm-selectionBackground": {
      background: "oklch(0.7 0.15 250 / 0.25) !important",
    },
    "&.cm-focused .cm-selectionBackground": {
      background: "oklch(0.7 0.15 250 / 0.3) !important",
    },
    ".cm-cursor": {
      borderLeftColor: "oklch(0.3 0 0)",
      borderLeftWidth: "2px",
    },
    /* Markdown syntax highlighting */
    ".cm-header-1": {
      fontSize: "1.6em",
      fontWeight: "700",
      color: "oklch(0.3 0.05 250)",
    },
    ".cm-header-2": {
      fontSize: "1.35em",
      fontWeight: "600",
      color: "oklch(0.35 0.04 250)",
    },
    ".cm-header-3": {
      fontSize: "1.15em",
      fontWeight: "600",
      color: "oklch(0.4 0.03 250)",
    },
    ".cm-strong": { fontWeight: "700" },
    ".cm-em": { fontStyle: "italic" },
    ".cm-strikethrough": { textDecoration: "line-through" },
    ".cm-link": { color: "oklch(0.5 0.2 250)", textDecoration: "underline" },
    ".cm-url": { color: "oklch(0.55 0.12 250)" },
    ".cm-formatting": { color: "oklch(0.65 0 0)" },
    ".cm-quote": {
      color: "oklch(0.45 0.08 160)",
      fontStyle: "italic",
    },
    ".cm-inline-code": {
      background: "oklch(0.95 0 0)",
      borderRadius: "3px",
      padding: "1px 4px",
      fontFamily:
        '"SF Mono", "Fira Code", "Cascadia Code", monospace',
    },
    ".cm-monospace": {
      fontFamily:
        '"SF Mono", "Fira Code", "Cascadia Code", monospace',
    },
  },
  { dark: false },
);

// Dark theme overrides (extends oneDark)
const darkThemeOverride = EditorView.theme(
  {
    "&": {
      fontSize: "15px",
      fontFamily:
        '"SF Mono", "Fira Code", "Cascadia Code", "JetBrains Mono", monospace',
    },
    ".cm-content": {
      padding: "2rem 3rem",
      minHeight: "calc(100vh - 8rem)",
    },
    ".cm-gutters": {
      background: "transparent",
      border: "none",
    },
    ".cm-activeLineGutter": {
      background: "transparent",
    },
    ".cm-header-1": {
      fontSize: "1.6em",
      fontWeight: "700",
      color: "oklch(0.85 0.08 250)",
    },
    ".cm-header-2": {
      fontSize: "1.35em",
      fontWeight: "600",
      color: "oklch(0.8 0.06 250)",
    },
    ".cm-header-3": {
      fontSize: "1.15em",
      fontWeight: "600",
      color: "oklch(0.75 0.04 250)",
    },
    ".cm-link": { color: "oklch(0.75 0.15 250)" },
    ".cm-url": { color: "oklch(0.65 0.1 250)" },
    ".cm-formatting": { color: "oklch(0.5 0 0)" },
    ".cm-quote": {
      color: "oklch(0.65 0.06 160)",
      fontStyle: "italic",
    },
    ".cm-inline-code": {
      background: "oklch(0.25 0 0)",
      borderRadius: "3px",
      padding: "1px 4px",
    },
  },
  { dark: true },
);

export function Editor() {
  const { activeDocId, documents, updateDocument, theme } = useAppStore();
  const activeDoc = documents.find((d) => d.id === activeDocId);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("split");
  const setView = useEditorStore((s) => s.setView);
  const viewRef = useRef<EditorView | null>(null);
  const convertedRef = useRef<Set<string>>(new Set());

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

  // Memoize extensions
  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
    ],
    [],
  );

  const editorTheme = useMemo(() => {
    if (theme === "dark") return [oneDark, darkThemeOverride];
    return [lightTheme];
  }, [theme]);

  // Convert markdown to HTML for preview
  const previewHtml = useMemo(() => {
    if (!activeDoc?.content) return "";
    try {
      return marked.parse(activeDoc.content) as string;
    } catch {
      return activeDoc.content;
    }
  }, [activeDoc?.content]);

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

  // Cleanup on unmount or doc change
  useEffect(() => {
    return () => {
      setView(null);
      viewRef.current = null;
    };
  }, [activeDocId, setView]);

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
      />
      <div className="flex flex-1 overflow-hidden">
        {/* Editor pane — raw markdown with syntax highlighting */}
        {previewMode !== "preview" && (
          <div
            className={`overflow-auto ${previewMode === "split" ? "w-1/2 border-r border-border" : "flex-1"}`}
          >
            <CodeMirror
              value={activeDoc.content || ""}
              onChange={onChange}
              extensions={extensions}
              theme={editorTheme}
              onCreateEditor={onCreateEditor}
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
        )}
        {/* Preview pane — rendered markdown */}
        {previewMode !== "edit" && (
          <div
            className={`overflow-auto ${previewMode === "split" ? "w-1/2" : "flex-1"}`}
          >
            <div
              className="prose max-w-none px-12 py-8"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
