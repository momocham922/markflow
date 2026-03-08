import { useEffect, useState, useCallback, useRef, lazy, Suspense, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { Editor } from "@/components/editor/Editor";
import { StatusBar } from "@/components/StatusBar";
import { UserMenu } from "@/components/UserMenu";
import { VersionPanel, type DiffState } from "@/components/version/VersionPanel";
import { DiffView } from "@/components/version/DiffView";
import { AiPanel } from "@/components/ai-panel/AiPanel";
import { ShareDialog } from "@/components/ShareDialog";
import { SharedDocView } from "@/components/SharedDocView";
import { CommandPalette } from "@/components/CommandPalette";
import { KeyboardShortcutsDialog } from "@/components/KeyboardShortcutsDialog";
import { useAppStore, type Document } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { PanelLeft, History, PenLine, LayoutGrid, Bot, Share2, ArrowLeft, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import TurndownService from "turndown";
import { marked } from "marked";

const CanvasView = lazy(() =>
  import("@/components/canvas/CanvasView").then((m) => ({
    default: m.CanvasView,
  })),
);

// HTML → Markdown for legacy content export
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

type ViewMode = "editor" | "canvas";
type RightPanel = "none" | "versions" | "ai";

function App() {
  const {
    sidebarOpen,
    toggleSidebar,
    theme,
    initialized,
    loadDocuments,
    activeDocId,
    documents,
    addDocument,
    setActiveDocId,
  } = useAppStore();
  const initAuth = useAuthStore((s) => s.init);
  const [rightPanel, setRightPanel] = useState<RightPanel>("none");
  const [viewMode, setViewMode] = useState<ViewMode>("editor");
  const [shareOpen, setShareOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  const [shareToken, setShareToken] = useState<string | null>(() => {
    const match = window.location.hash.match(/^#\/share\/(.+)$/);
    return match ? match[1] : null;
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Resizable panel widths
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [versionPanelWidth, setVersionPanelWidth] = useState(320);
  const [aiPanelWidth, setAiPanelWidth] = useState(420);
  const rightPanelWidth = rightPanel === "ai" ? aiPanelWidth : versionPanelWidth;
  const resizingRef = useRef<"sidebar" | "right" | null>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleResizeStart = useCallback(
    (panel: "sidebar" | "right", e: ReactPointerEvent) => {
      e.preventDefault();
      resizingRef.current = panel;
      startXRef.current = e.clientX;
      startWidthRef.current = panel === "sidebar" ? sidebarWidth : rightPanelWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const currentRightPanel = rightPanel;

      const handleMove = (ev: globalThis.PointerEvent) => {
        const delta = ev.clientX - startXRef.current;
        if (resizingRef.current === "sidebar") {
          setSidebarWidth(Math.max(180, Math.min(480, startWidthRef.current + delta)));
        } else {
          const newWidth = Math.max(240, Math.min(600, startWidthRef.current - delta));
          if (currentRightPanel === "ai") {
            setAiPanelWidth(newWidth);
          } else {
            setVersionPanelWidth(newWidth);
          }
        }
      };

      const handleUp = () => {
        resizingRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("pointermove", handleMove);
        document.removeEventListener("pointerup", handleUp);
      };

      document.addEventListener("pointermove", handleMove);
      document.addEventListener("pointerup", handleUp);
    },
    [sidebarWidth, rightPanelWidth, rightPanel],
  );

  // Listen for hash changes (share links)
  useEffect(() => {
    const handleHash = () => {
      const match = window.location.hash.match(/^#\/share\/(.+)$/);
      setShareToken(match ? match[1] : null);
    };
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    const cleanup = initAuth();
    return cleanup;
  }, [initAuth]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // Keyboard shortcut: Cmd+Shift+?
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "/" && e.metaKey && e.shiftKey) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      }
      // Cmd+P for print
      if (e.key === "p" && e.metaKey && !e.shiftKey) {
        e.preventDefault();
        handlePrint();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeDocId, documents]);

  const togglePanel = useCallback((panel: "versions" | "ai") => {
    setRightPanel((prev) => (prev === panel ? "none" : panel));
  }, []);

  // ─── Export functions ────────────────────────────────────

  const exportHtml = useCallback(() => {
    const doc = documents.find((d) => d.id === activeDocId);
    if (!doc) return;
        const htmlContent = marked.parse(doc.content) as string;
    const html = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>${doc.title}</title>
<style>body{font-family:-apple-system,sans-serif;max-width:700px;margin:2em auto;padding:0 1em;line-height:1.7;}
code{background:#f3f3f3;padding:0.1em 0.3em;border-radius:3px;}
pre{background:#f3f3f3;padding:1em;border-radius:6px;overflow-x:auto;}
blockquote{border-left:3px solid #ddd;margin-left:0;padding-left:1em;color:#666;}</style>
</head><body>${htmlContent}</body></html>`;
    downloadFile(html, `${doc.title}.html`, "text/html");
  }, [activeDocId, documents]);

  const exportText = useCallback(() => {
    const doc = documents.find((d) => d.id === activeDocId);
    if (!doc) return;
    downloadFile(doc.content, `${doc.title}.txt`, "text/plain");
  }, [activeDocId, documents]);

  const exportMarkdown = useCallback(() => {
    const doc = documents.find((d) => d.id === activeDocId);
    if (!doc) return;
    // Content is already markdown (CodeMirror editor), but handle legacy HTML
    let md = doc.content;
    if (/^\s*<[a-z][\s\S]*>/i.test(md)) {
      md = turndown.turndown(md);
    }
    downloadFile(md, `${doc.title}.md`, "text/markdown");
  }, [activeDocId, documents]);

  // ─── Import Markdown ─────────────────────────────────────

  const handleImportMarkdown = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const content = reader.result as string;
        const title = file.name.replace(/\.md$/i, "").slice(0, 50) || "Imported";
        const doc: Document = {
          id: crypto.randomUUID(),
          title,
          content,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          folder: "/",
          tags: [],
          ownerId: null,
        };
        addDocument(doc);
        setActiveDocId(doc.id);
      };
      reader.readAsText(file);
      // Reset so the same file can be imported again
      e.target.value = "";
    },
    [addDocument, setActiveDocId],
  );

  // ─── Print / PDF ─────────────────────────────────────────

  const handlePrint = useCallback(() => {
    const doc = documents.find((d) => d.id === activeDocId);
    if (!doc) return;
        const htmlContent = marked.parse(doc.content) as string;
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;
    printWindow.document.write(`<!DOCTYPE html>
<html><head><title>${doc.title}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:700px;margin:2em auto;padding:0 1em;line-height:1.7;color:#222;}
h1{font-size:1.8em;margin-top:1em;} h2{font-size:1.4em;} h3{font-size:1.2em;}
code{background:#f3f3f3;padding:0.1em 0.3em;border-radius:3px;font-size:0.9em;}
pre{background:#f3f3f3;padding:1em;border-radius:6px;overflow-x:auto;}
blockquote{border-left:3px solid #ddd;margin-left:0;padding-left:1em;color:#666;}
table{border-collapse:collapse;width:100%;}
th,td{border:1px solid #ddd;padding:0.4em 0.8em;text-align:left;}
img{max-width:100%;}
@media print{body{margin:0;padding:1cm;}}
</style>
</head><body>${htmlContent}</body></html>`);
    printWindow.document.close();
    printWindow.onload = () => {
      printWindow.print();
      printWindow.close();
    };
  }, [activeDocId, documents]);

  if (!initialized) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // Shared document view (via hash route)
  if (shareToken) {
    return (
      <TooltipProvider>
        <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
          <div
            className="h-7 w-full shrink-0"
            onMouseDown={() => getCurrentWindow().startDragging()}
          />
          <div className="flex-1 overflow-hidden">
            <SharedDocView
              token={shareToken}
              onBack={() => {
                window.location.hash = "";
                setShareToken(null);
              }}
            />
          </div>
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex h-screen w-screen flex-col overflow-hidden">
        {/* Window drag region — full width, topmost element */}
        <div
          className="h-7 w-full shrink-0"
          onMouseDown={() => getCurrentWindow().startDragging()}
        />
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar */}
          {sidebarOpen && (
            <>
              <div className="shrink-0 overflow-hidden" style={{ width: sidebarWidth }}>
                <Sidebar />
              </div>
              {/* Sidebar resize handle */}
              <div
                className="w-1 shrink-0 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
                onPointerDown={(e) => handleResizeStart("sidebar", e)}
              />
            </>
          )}

          {/* Main content */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Top bar */}
            <div
              className="flex items-center justify-between border-b border-border px-3 pb-1.5"
            >
              <div className="flex items-center gap-1">
                {!sidebarOpen && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={toggleSidebar}
                  >
                    <PanelLeft className="h-4 w-4" />
                  </Button>
                )}
                {/* View mode toggle */}
                <div className="flex items-center rounded-md border border-border p-0.5">
                  <Button
                    variant={viewMode === "editor" ? "secondary" : "ghost"}
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => setViewMode("editor")}
                    title="Editor"
                  >
                    <PenLine className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant={viewMode === "canvas" ? "secondary" : "ghost"}
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => setViewMode("canvas")}
                    title="Canvas"
                  >
                    <LayoutGrid className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {/* Import markdown */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleImportMarkdown}
                  title="Import .md file"
                >
                  <Upload className="h-3.5 w-3.5" />
                </Button>
                <span className="ml-1 text-[10px] text-muted-foreground hidden sm:inline">
                  Cmd+K search · Cmd+Shift+/ shortcuts
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setShareOpen(true)}
                  title="Share"
                >
                  <Share2 className="h-4 w-4" />
                </Button>
                {viewMode === "editor" && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn("h-7 w-7", rightPanel === "ai" && "bg-accent")}
                      onClick={() => togglePanel("ai")}
                      title="Claude AI"
                    >
                      <Bot className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn("h-7 w-7", rightPanel === "versions" && "bg-accent")}
                      onClick={() => togglePanel("versions")}
                      title="Version history"
                    >
                      <History className="h-4 w-4" />
                    </Button>
                  </>
                )}
                <UserMenu />
              </div>
            </div>
            <div className="flex flex-1 overflow-hidden">
              <div className="flex-1 overflow-hidden">
                {diffState ? (
                  <div className="flex h-full flex-col">
                    <div className="flex items-center gap-2 border-b border-border px-4 py-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 text-xs"
                        onClick={() => setDiffState(null)}
                      >
                        <ArrowLeft className="h-3.5 w-3.5" />
                        Back to editor
                      </Button>
                      <div className="h-4 w-px bg-border" />
                      <span className="text-sm font-medium">{diffState.title}</span>
                      <span className="text-xs text-muted-foreground">{diffState.time}</span>
                    </div>
                    <div className="flex-1 overflow-auto px-6 py-4">
                      <DiffView oldText={diffState.oldText} newText={diffState.newText} fullPage />
                    </div>
                  </div>
                ) : viewMode === "editor" ? (
                  <Editor />
                ) : (
                  <Suspense
                    fallback={
                      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                        Loading canvas...
                      </div>
                    }
                  >
                    <CanvasView />
                  </Suspense>
                )}
              </div>
              {viewMode === "editor" && rightPanel !== "none" && (
                <>
                  {/* Right panel resize handle */}
                  <div
                    className="w-1 shrink-0 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
                    onPointerDown={(e) => handleResizeStart("right", e)}
                  />
                  <div className="shrink-0 overflow-hidden" style={{ width: rightPanelWidth }}>
                    {rightPanel === "versions" && (
                      <VersionPanel
                        onClose={() => setRightPanel("none")}
                        onViewDiff={setDiffState}
                      />
                    )}
                    {rightPanel === "ai" && (
                      <AiPanel onClose={() => setRightPanel("none")} />
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <StatusBar />
        <ShareDialog open={shareOpen} onOpenChange={setShareOpen} />
        <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        <CommandPalette
          onViewChange={setViewMode}
          onTogglePanel={togglePanel}
          onShare={() => setShareOpen(true)}
          onExportHtml={exportHtml}
          onExportText={exportText}
          onExportMarkdown={exportMarkdown}
          onImportMarkdown={handleImportMarkdown}
          onPrint={handlePrint}
          onShowShortcuts={() => setShortcutsOpen(true)}
        />
        {/* Hidden file input for markdown import */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,.txt"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
    </TooltipProvider>
  );
}

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default App;
