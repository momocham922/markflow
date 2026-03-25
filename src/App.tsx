import { useEffect, useState, useCallback, useRef, lazy, Suspense, type PointerEvent as ReactPointerEvent } from "react";
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
import { PanelLeft, History, PenLine, LayoutGrid, Bot, Share2, ArrowLeft, Upload, Network } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import TurndownService from "turndown";
import { marked } from "marked";
import { getPlatform, isIOS } from "@/platform";
import { useIOSKeyboard } from "@/hooks/use-ios-keyboard";

const CanvasView = lazy(() =>
  import("@/components/canvas/CanvasView").then((m) => ({
    default: m.CanvasView,
  })),
);

const VisualizationView = lazy(() =>
  import("@/components/visualization/VisualizationView").then((m) => ({
    default: m.VisualizationView,
  })),
);

// HTML → Markdown for legacy content export
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

type ViewMode = "editor" | "canvas" | "visualization";
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
    setPendingRestoreContent,
  } = useAppStore();
  const initAuth = useAuthStore((s) => s.init);
  const syncing = useAuthStore((s) => s.syncing);
  // Only show blocking overlay for the very first sync (login/startup)
  const prevSyncingRef = useRef(false);
  const initialSyncDoneRef = useRef(false);
  useEffect(() => {
    if (prevSyncingRef.current && !syncing) {
      initialSyncDoneRef.current = true;
    }
    prevSyncingRef.current = syncing;
  }, [syncing]);
  const [rightPanel, setRightPanel] = useState<RightPanel>("none");
  const [viewMode, setViewMode] = useState<ViewMode>("editor");
  const [updateInfo, setUpdateInfo] = useState<{ version: string; update: unknown } | null>(null);
  const [updateStatus, setUpdateStatus] = useState<"idle" | "downloading" | "error">("idle");
  const [updateError, setUpdateError] = useState("");
  const [closingSyncVisible, setClosingSyncVisible] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  const { viewportHeight, keyboardVisible } = useIOSKeyboard();
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

  // Sync before close — flush DB + cloud sync before window closes
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      const platform = await getPlatform();
      unlisten = await platform.onWindowClose(async () => {
        const authState = useAuthStore.getState();
        const needsSync = !!authState.user;
        if (needsSync) setClosingSyncVisible(true);
        try {
          const { flushPendingSaves } = await import("@/stores/app-store");
          flushPendingSaves();
          if (needsSync) {
            await Promise.race([
              authState.syncToCloud(),
              new Promise((resolve) => setTimeout(resolve, 3000)),
            ]);
          }
        } catch {
          // Best effort
        }
      });
    })();
    return () => { unlisten?.(); };
  }, []);

  // Signal to Rust that frontend is alive (cancels failsafe auto-updater).
  // Delayed 5s to ensure full React tree has rendered without crash.
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("cancel_auto_update");
      } catch {
        // Not in Tauri or command not available — ignore
      }
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  // Auto-update check — on startup and every 30 minutes while app is open
  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const { getSetting } = await import("@/services/database");
        const channel = ((await getSetting("update_channel")) || "stable") as "stable" | "beta";
        const platform = await getPlatform();
        const update = await platform.checkForUpdate(channel);
        if (update) {
          setUpdateInfo({ version: update.version, update });
        }
      } catch {
        // Silently ignore update check failures (offline, dev mode, etc.)
      }
    };
    const startupTimer = setTimeout(checkUpdate, 3000);
    const interval = setInterval(checkUpdate, 30 * 60 * 1000);
    return () => { clearTimeout(startupTimer); clearInterval(interval); };
  }, []);

  const handleInstallUpdate = useCallback(async () => {
    if (!updateInfo) return;
    setUpdateStatus("downloading");
    setUpdateError("");
    try {
      const update = updateInfo.update as { install: () => Promise<void> };
      await update.install();
      const platform = await getPlatform();
      await platform.relaunch();
    } catch (err) {
      setUpdateStatus("error");
      setUpdateError(err instanceof Error ? err.message : String(err));
    }
  }, [updateInfo]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // Suppress native WebKit context menu (custom menus handle right-click)
  useEffect(() => {
    const suppress = (e: MouseEvent) => {
      // Allow native context menu inside CodeMirror editor for copy/paste
      if ((e.target as HTMLElement)?.closest?.(".cm-editor")) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", suppress);
    return () => document.removeEventListener("contextmenu", suppress);
  }, []);

  // Clear lingering WebKit selection artifacts on deselection
  useEffect(() => {
    const handler = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        document.body.style.opacity = "0.999";
        requestAnimationFrame(() => { document.body.style.opacity = ""; });
      }
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, []);

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

  const escTitle = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const exportHtml = useCallback(async () => {
    const doc = documents.find((d) => d.id === activeDocId);
    if (!doc) return;
    const htmlContent = marked.parse(doc.content) as string;
    const html = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>${escTitle(doc.title)}</title>
<style>body{font-family:-apple-system,sans-serif;max-width:700px;margin:2em auto;padding:0 1em;line-height:1.7;}
code{background:#f3f3f3;padding:0.1em 0.3em;border-radius:3px;}
pre{background:#f3f3f3;padding:1em;border-radius:6px;overflow-x:auto;}
blockquote{border-left:3px solid #ddd;margin-left:0;padding-left:1em;color:#666;}
img{max-width:100%;height:auto;}
table{border-collapse:collapse;width:100%;}
th,td{border:1px solid #ddd;padding:0.4em 0.8em;text-align:left;}</style>
</head><body>${htmlContent}</body></html>`;
    const platform = await getPlatform();
    const path = await platform.showSaveDialog({ defaultPath: `${doc.title}.html`, filters: [{ name: "HTML", extensions: ["html"] }] });
    if (path) await platform.writeTextFile(path, html);
  }, [activeDocId, documents]);

  const exportText = useCallback(async () => {
    const doc = documents.find((d) => d.id === activeDocId);
    if (!doc) return;
    const platform = await getPlatform();
    const path = await platform.showSaveDialog({ defaultPath: `${doc.title}.txt`, filters: [{ name: "Text", extensions: ["txt"] }] });
    if (path) await platform.writeTextFile(path, doc.content);
  }, [activeDocId, documents]);

  const exportMarkdown = useCallback(async () => {
    const doc = documents.find((d) => d.id === activeDocId);
    if (!doc) return;
    let md = doc.content;
    if (/^\s*<[a-z][\s\S]*>/i.test(md)) {
      md = turndown.turndown(md);
    }
    const platform = await getPlatform();
    const path = await platform.showSaveDialog({ defaultPath: `${doc.title}.md`, filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (path) await platform.writeTextFile(path, md);
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

  const handlePrint = useCallback(async () => {
    const doc = documents.find((d) => d.id === activeDocId);
    if (!doc) return;
    const htmlContent = marked.parse(doc.content) as string;

    const html = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>${escTitle(doc.title)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:700px;margin:2em auto;padding:0 1em;line-height:1.7;color:#222;}
code{background:#f3f3f3;padding:0.1em 0.3em;border-radius:3px;font-size:0.9em;}
pre{background:#f3f3f3;padding:1em;border-radius:6px;overflow-x:auto;}
blockquote{border-left:3px solid #ddd;margin-left:0;padding-left:1em;color:#666;}
img{max-width:100%;height:auto;}
table{border-collapse:collapse;width:100%;}
th,td{border:1px solid #ddd;padding:0.4em 0.8em;text-align:left;}
@media print { body { margin: 0; } }
</style></head>
<body>${htmlContent}</body>
<script>window.onload = function() { window.print(); }</script>
</html>`;

    try {
      const platform = await getPlatform();
      await platform.printHtml(html);
    } catch (e) {
      console.error("Print failed:", e);
    }
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
        <div
          className={cn(
            "flex flex-col overflow-hidden bg-background",
            !isIOS && "h-screen w-screen",
            isIOS && "safe-top",
          )}
          style={isIOS ? {
            position: "fixed",
            top: 0, left: 0, right: 0,
            ...(keyboardVisible ? { bottom: "auto", height: viewportHeight } : { bottom: 0 }),
          } : undefined}
        >
          {!isIOS && (
            <div
              className="h-7 w-full shrink-0"
              data-tauri-drag-region
            />
          )}
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
      <div
        className={cn(
          "flex flex-col overflow-hidden bg-background",
          !isIOS && "h-screen w-screen",
          isIOS && "safe-top",
        )}
        style={isIOS ? {
          position: "fixed",
          top: 0, left: 0, right: 0,
          ...(keyboardVisible ? { bottom: "auto", height: viewportHeight } : { bottom: 0 }),
        } : undefined}
      >
        {/* Window drag region — desktop only (macOS title bar) */}
        {!isIOS && (
          <div
            className="h-7 w-full shrink-0"
            data-tauri-drag-region
          />
        )}
        {/* Update banner */}
        {updateInfo && (
          <div className="flex items-center justify-between gap-3 bg-primary px-4 py-1.5 text-primary-foreground text-xs shrink-0">
            <span>
              {updateStatus === "downloading" ? "ダウンロード中..." :
               updateStatus === "error" ? `更新失敗: ${updateError}` :
               `MarkFlow v${updateInfo.version} が利用可能です`}
            </span>
            <div className="flex items-center gap-2">
              {updateStatus !== "downloading" && (
                <button
                  className="rounded-md bg-primary-foreground/20 px-3 py-0.5 hover:bg-primary-foreground/30 transition-colors"
                  onClick={() => { setUpdateInfo(null); setUpdateStatus("idle"); }}
                >
                  あとで
                </button>
              )}
              <button
                className="rounded-md bg-primary-foreground text-primary px-3 py-0.5 font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                onClick={handleInstallUpdate}
                disabled={updateStatus === "downloading"}
              >
                {updateStatus === "error" ? "再試行" : updateStatus === "downloading" ? "..." : "アップデート"}
              </button>
            </div>
          </div>
        )}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar — overlay on iOS, inline on desktop */}
          {sidebarOpen && isIOS && (
            <div
              className="fixed inset-0 z-40 bg-black/30"
              onClick={toggleSidebar}
            />
          )}
          {sidebarOpen && (
            <>
              <div
                className={cn(
                  "shrink-0 overflow-hidden",
                  isIOS && "fixed inset-y-0 left-0 z-50 safe-top safe-bottom shadow-xl bg-background"
                )}
                style={{ width: isIOS ? 280 : sidebarWidth }}
              >
                <Sidebar />
              </div>
              {/* Sidebar resize handle — desktop only */}
              {!isIOS && (
                <div
                  className="w-1 shrink-0 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
                  onPointerDown={(e) => handleResizeStart("sidebar", e)}
                />
              )}
            </>
          )}

          {/* Main content */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Top bar — draggable on desktop, normal on iOS */}
            <div
              className={cn("flex items-center justify-between border-b border-border px-3 pb-1.5", isIOS && "pt-1 safe-left safe-right")}
              {...(!isIOS ? { "data-tauri-drag-region": true } : {})}
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
                  <Button
                    variant={viewMode === "visualization" ? "secondary" : "ghost"}
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => setViewMode("visualization")}
                    title="Visualization"
                  >
                    <Network className="h-3.5 w-3.5" />
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
                {!isIOS && (
                  <span className="ml-1 text-[10px] text-muted-foreground hidden sm:inline">
                    Cmd+K search · Cmd+Shift+/ shortcuts
                  </span>
                )}
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
                ) : viewMode === "visualization" ? (
                  <Suspense
                    fallback={
                      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                        Loading visualization...
                      </div>
                    }
                  >
                    <VisualizationView />
                  </Suspense>
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
              {viewMode === "editor" && rightPanel !== "none" && !isIOS && (
                <>
                  {/* Right panel resize handle — desktop */}
                  <div
                    className="w-1 shrink-0 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
                    onPointerDown={(e) => handleResizeStart("right", e)}
                  />
                  <div className="shrink-0 overflow-hidden" style={{ width: rightPanelWidth }}>
                    {rightPanel === "versions" && (
                      <VersionPanel
                        onClose={() => setRightPanel("none")}
                        onViewDiff={setDiffState}
                        onRestore={setPendingRestoreContent}
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

        {/* Right panels — fullscreen overlay on iOS */}
        {isIOS && viewMode === "editor" && rightPanel !== "none" && (
          <div className="fixed inset-0 z-40 flex flex-col safe-top safe-bottom bg-background">
            {rightPanel === "versions" && (
              <VersionPanel
                onClose={() => setRightPanel("none")}
                onViewDiff={setDiffState}
                onRestore={setPendingRestoreContent}
              />
            )}
            {rightPanel === "ai" && (
              <AiPanel onClose={() => setRightPanel("none")} />
            )}
          </div>
        )}

        {/* Syncing overlay — initial sync or closing sync */}
        {(closingSyncVisible || (syncing && !initialSyncDoneRef.current)) && (
          <div className="fixed inset-0 z-100 flex items-center justify-center bg-background/60 backdrop-blur-[2px]">
            <div className="flex items-center gap-3 rounded-lg bg-card border border-border px-5 py-3 shadow-lg">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-sm text-foreground">
                {closingSyncVisible ? "保存中..." : "Syncing..."}
              </span>
            </div>
          </div>
        )}
        {!(isIOS && keyboardVisible) && <StatusBar />}
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

export default App;
