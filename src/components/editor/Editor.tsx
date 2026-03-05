import { useEffect, useCallback, useState, useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
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

export function Editor() {
  const { activeDocId, documents, updateDocument, theme, themeSettings } = useAppStore();
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
    const preset = editorThemes[themeSettings.editorTheme] ?? editorThemes.default;
    return theme === "dark" ? preset.dark : preset.light;
  }, [theme, themeSettings.editorTheme]);

  // Convert markdown to HTML for preview
  const previewHtml = useMemo(() => {
    if (!activeDoc?.content) return "";
    try {
      return marked.parse(activeDoc.content) as string;
    } catch {
      return activeDoc.content;
    }
  }, [activeDoc?.content]);

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
            className={`overflow-auto editor-scroll ${previewMode === "split" ? "w-1/2 border-r border-border" : "flex-1"}`}
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
            className={`overflow-auto preview-scroll ${previewMode === "split" ? "w-1/2" : "flex-1"}`}
          >
            {previewThemeCss && <style>{previewThemeCss}</style>}
            {themeSettings.customPreviewCss && (
              <style>{themeSettings.customPreviewCss}</style>
            )}
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
