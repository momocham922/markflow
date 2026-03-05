import { useEffect, useState, useCallback, lazy, Suspense } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { Editor } from "@/components/editor/Editor";
import { StatusBar } from "@/components/StatusBar";
import { UserMenu } from "@/components/UserMenu";
import { VersionPanel } from "@/components/version/VersionPanel";
import { AiPanel } from "@/components/ai-panel/AiPanel";
import { ShareDialog } from "@/components/ShareDialog";
import { CommandPalette } from "@/components/CommandPalette";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { PanelLeft, History, PenLine, LayoutGrid, Bot, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const CanvasView = lazy(() =>
  import("@/components/canvas/CanvasView").then((m) => ({
    default: m.CanvasView,
  })),
);

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
  } = useAppStore();
  const initAuth = useAuthStore((s) => s.init);
  const [rightPanel, setRightPanel] = useState<RightPanel>("none");
  const [viewMode, setViewMode] = useState<ViewMode>("editor");
  const [shareOpen, setShareOpen] = useState(false);

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

  const togglePanel = useCallback((panel: "versions" | "ai") => {
    setRightPanel((prev) => (prev === panel ? "none" : panel));
  }, []);

  const exportHtml = useCallback(() => {
    const doc = documents.find((d) => d.id === activeDocId);
    if (!doc) return;
    const html = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>${doc.title}</title>
<style>body{font-family:-apple-system,sans-serif;max-width:700px;margin:2em auto;padding:0 1em;line-height:1.7;}
code{background:#f3f3f3;padding:0.1em 0.3em;border-radius:3px;}
pre{background:#f3f3f3;padding:1em;border-radius:6px;overflow-x:auto;}
blockquote{border-left:3px solid #ddd;margin-left:0;padding-left:1em;color:#666;}</style>
</head><body>${doc.content}</body></html>`;
    downloadFile(html, `${doc.title}.html`, "text/html");
  }, [activeDocId, documents]);

  const exportText = useCallback(() => {
    const doc = documents.find((d) => d.id === activeDocId);
    if (!doc) return;
    const div = document.createElement("div");
    div.innerHTML = doc.content;
    downloadFile(div.textContent || "", `${doc.title}.txt`, "text/plain");
  }, [activeDocId, documents]);

  if (!initialized) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
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
          <div
            className={cn(
              "shrink-0 transition-all duration-200",
              sidebarOpen ? "w-60" : "w-0",
            )}
          >
            {sidebarOpen && <Sidebar />}
          </div>

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
                <span className="ml-2 text-[10px] text-muted-foreground hidden sm:inline">
                  Cmd+K to search
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
                {viewMode === "editor" ? (
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
              {viewMode === "editor" && rightPanel === "versions" && (
                <VersionPanel onClose={() => setRightPanel("none")} />
              )}
              {viewMode === "editor" && rightPanel === "ai" && (
                <AiPanel onClose={() => setRightPanel("none")} />
              )}
            </div>
          </div>
        </div>

        <StatusBar />
        <ShareDialog open={shareOpen} onOpenChange={setShareOpen} />
        <CommandPalette
          onViewChange={setViewMode}
          onTogglePanel={togglePanel}
          onShare={() => setShareOpen(true)}
          onExportHtml={exportHtml}
          onExportText={exportText}
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
