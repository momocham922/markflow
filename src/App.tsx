import {
  useEffect,
  useState,
  useCallback,
  useRef,
  lazy,
  Suspense,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { Editor } from "@/components/editor/Editor";
import { StatusBar } from "@/components/StatusBar";
import { UserMenu } from "@/components/UserMenu";
import {
  VersionPanel,
  type DiffState,
} from "@/components/version/VersionPanel";
import { DiffView } from "@/components/version/DiffView";
import { AiPanel } from "@/components/ai-panel/AiPanel";
import { ShareDialog } from "@/components/ShareDialog";
import { SharedDocView } from "@/components/SharedDocView";
import { CommandPalette } from "@/components/CommandPalette";
import { KeyboardShortcutsDialog } from "@/components/KeyboardShortcutsDialog";
import { useAppStore, type Document } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import {
  useEntitlementStore,
  planLabel,
  featureLabel,
  BILLING_ENABLED,
} from "@/stores/entitlement-store";
import { useResearchStore } from "@/stores/research-store";
import { ResearchSheet } from "@/components/editor/ResearchSheet";
import { PaywallDialog } from "@/components/PaywallDialog";
import { TeamManageDialog } from "@/components/TeamManageDialog";
import { FeedbackDialog } from "@/components/FeedbackDialog";
import { useFeedbackStore } from "@/stores/feedback-store";
import { TelemetryConsentBanner } from "@/components/TelemetryConsentBanner";
import { useTelemetryStore } from "@/stores/telemetry-store";
import { track, getConsent } from "@/services/telemetry";
import { initCrashReporting } from "@/services/crash";
import {
  PanelLeft,
  History,
  PenLine,
  LayoutGrid,
  Bot,
  Share2,
  ArrowLeft,
  Upload,
  Network,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { aiProxyHeaders } from "@/services/ai-proxy";
import { onLocalEdit } from "@/lib/local-edit-signal";
import TurndownService from "turndown";
import { marked } from "marked";
import { getPlatform, isIOS, isMobile, isMac } from "@/platform";
import { useIOSKeyboard } from "@/hooks/use-ios-keyboard";
import { useSwipeSidebar } from "@/hooks/use-swipe-sidebar";

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
    themeSettings,
    customPreviewThemes,
  } = useAppStore();
  const initAuth = useAuthStore((s) => s.init);
  const syncing = useAuthStore((s) => s.syncing);
  // Monetization: owner view-as preview + quota upsell banners
  const viewAsPlan = useEntitlementStore((s) => s.viewAs);
  // Server-confirmed owner flag — gates the view-as preview banner so a stale
  // persisted viewAs (localStorage) can never surface the banner for a
  // non-owner or before the first entitlement fetch reconciles it.
  const isOwner = useEntitlementStore((s) => s.isOwner);
  const setViewAs = useEntitlementStore((s) => s.setViewAs);
  const resetPreviewUsage = useEntitlementStore((s) => s.resetPreviewUsage);
  const lastQuotaError = useEntitlementStore((s) => s.lastQuotaError);
  const clearQuota = useEntitlementStore((s) => s.clearQuota);
  const openPaywall = useEntitlementStore((s) => s.openPaywall);
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
  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    update: unknown;
  } | null>(null);
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "downloading" | "error"
  >("idle");
  const [updateError, setUpdateError] = useState("");
  const [closingSyncVisible, setClosingSyncVisible] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  // Research bottom sheet (mobile). The sheet lives here so it shares this
  // component's single useIOSKeyboard instance.
  const mobileSheetOpen = useResearchStore((s) => s.mobileSheetOpen);
  const researchCardCount = useResearchStore((s) => s.cards.length);
  const setMobileSheetOpen = useResearchStore((s) => s.setMobileSheetOpen);
  const researchAnalyzing = useResearchStore((s) => s.analyzing);
  const { viewportHeight, keyboardVisible } = useIOSKeyboard();
  const { sidebarTranslateX, swiping, backdropOpacity } = useSwipeSidebar(
    sidebarOpen,
    toggleSidebar,
  );
  const [shareToken, setShareToken] = useState<string | null>(() => {
    const match = window.location.hash.match(/^#\/share\/(.+)$/);
    return match ? match[1] : null;
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Resizable panel widths
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [versionPanelWidth, setVersionPanelWidth] = useState(320);
  const [aiPanelWidth, setAiPanelWidth] = useState(420);
  const rightPanelWidth =
    rightPanel === "ai" ? aiPanelWidth : versionPanelWidth;
  const resizingRef = useRef<"sidebar" | "right" | null>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleResizeStart = useCallback(
    (panel: "sidebar" | "right", e: ReactPointerEvent) => {
      e.preventDefault();
      resizingRef.current = panel;
      startXRef.current = e.clientX;
      startWidthRef.current =
        panel === "sidebar" ? sidebarWidth : rightPanelWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const currentRightPanel = rightPanel;

      const handleMove = (ev: globalThis.PointerEvent) => {
        const delta = ev.clientX - startXRef.current;
        if (resizingRef.current === "sidebar") {
          setSidebarWidth(
            Math.max(180, Math.min(480, startWidthRef.current + delta)),
          );
        } else {
          const newWidth = Math.max(
            240,
            Math.min(600, startWidthRef.current - delta),
          );
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
        document.removeEventListener("pointercancel", handleUp);
      };

      document.addEventListener("pointermove", handleMove);
      document.addEventListener("pointerup", handleUp);
      // pointercancel (OS gesture interruption / palm rejection / capture loss)
      // fires *instead* of pointerup — without this the move listener and the
      // stuck body cursor/userSelect would leak and stack across resizes.
      document.addEventListener("pointercancel", handleUp);
    },
    [sidebarWidth, rightPanelWidth, rightPanel],
  );

  /** Parse a share token from various URL formats */
  const parseShareToken = useCallback((input: string): string | null => {
    const trimmed = input.trim();
    // https://markflow.jp/share/{token}
    const https = trimmed.match(/^https:\/\/markflow\.jp\/share\/(.+)$/);
    if (https) return https[1];
    // markflow://share/{token}
    const proto = trimmed.match(/^markflow:\/\/share\/(.+)$/);
    if (proto) return proto[1];
    // #/share/{token}
    const hash = trimmed.match(/#\/share\/(.+)$/);
    if (hash) return hash[1];
    // raw token (32 alphanumeric chars)
    if (/^[a-z0-9]{32}$/.test(trimmed)) return trimmed;
    return null;
  }, []);

  /** Open a shared document by link/token */
  const openShareLink = useCallback(
    (input: string) => {
      const token = parseShareToken(input);
      if (token) {
        setShareToken(token);
      }
    },
    [parseShareToken],
  );

  /**
   * Handle a return from Stripe Checkout / Portal. Two return shapes arrive here
   * (as deep links on native, or as URL-hash navigations on web):
   *   - Checkout: markflow://billing/{success,cancel} (web: markflow.jp/checkout/*)
   *   - Portal:   markflow://billing/updated          (web: markflow.jp/account)
   * On success we poll for the PURCHASED plan specifically (pendingCheckoutPlan)
   * so a transient stale "free" read can't stop the poll and strand a paying
   * user on Free. On a portal return we poll for ANY change (up/down/cancel).
   * Returns true if the URL was a billing return (so callers stop parsing it).
   */
  const handleBillingReturn = useCallback((input: string): boolean => {
    const s = input.trim();
    let action: "success" | "cancel" | "updated" | null = null;
    const deep = s.match(/^markflow:\/\/billing\/(success|cancel|updated)/);
    const checkoutWeb = s.match(
      /^https:\/\/markflow\.jp\/checkout\/(success|cancel)/,
    );
    if (deep) action = deep[1] as "success" | "cancel" | "updated";
    else if (checkoutWeb) action = checkoutWeb[1] as "success" | "cancel";
    else if (/^https:\/\/markflow\.jp\/account(?:[/?#]|$)/.test(s))
      action = "updated";
    if (!action) return false;
    // Best-effort dismiss of the iOS SFSafariViewController; harmless elsewhere.
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("dismiss_safari_vc"))
      .catch(() => {});
    const store = useEntitlementStore.getState();
    if (action === "success") {
      // The plan write lands via webhook a few seconds after redirect; poll for
      // the exact plan just purchased (persisted, so it survives a cold relaunch
      // while the Checkout browser was foreground). Fall back to "pro": a success
      // return unambiguously means a paid plan was bought, so polling for ≥pro is
      // always safe and never stops the poll on a transient stale Free read.
      const target = store.pendingCheckoutPlan ?? "pro";
      store.pollEntitlement({ target });
      store.clearPendingCheckout();
    } else if (action === "updated") {
      // Portal change (upgrade/downgrade/cancel-at-period-end): poll for any move.
      store.pollEntitlement();
    } else {
      // User backed out of Checkout; discard the pending marker.
      store.clearPendingCheckout();
    }
    return true;
  }, []);

  // Listen for hash changes (share links + web billing return)
  useEffect(() => {
    const handleHash = () => {
      if (handleBillingReturn(window.location.hash)) return;
      const token = parseShareToken(window.location.hash);
      setShareToken(token);
    };
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, [parseShareToken, handleBillingReturn]);

  // Listen for deep link events (markflow://share/{token}, markflow://billing/*)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/plugin-deep-link")
      .then(async ({ onOpenUrl, getCurrent }) => {
        // Handle initial launch URL (app was opened via deep link while not running)
        try {
          const initialUrls = await getCurrent();
          if (initialUrls && initialUrls.length > 0) {
            for (const url of initialUrls) {
              if (handleBillingReturn(url)) break;
              const token = parseShareToken(url);
              if (token) {
                setShareToken(token);
                break;
              }
            }
          }
        } catch {}
        // Listen for subsequent deep link events while app is running
        unlisten = await onOpenUrl((urls) => {
          for (const url of urls) {
            if (handleBillingReturn(url)) break;
            const token = parseShareToken(url);
            if (token) {
              setShareToken(token);
              break;
            }
          }
        });
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, [parseShareToken, handleBillingReturn]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    const cleanup = initAuth();
    return cleanup;
  }, [initAuth]);

  // Boot product telemetry (consent-gated, dark-safe) and record the session
  // open. track() is a no-op until the user has consented, so app_open only
  // lands for opted-in users; the endpoint is also server-dark until enabled.
  const initTelemetryStore = useTelemetryStore((s) => s.init);
  useEffect(() => {
    void initTelemetryStore().then(() => {
      track("app_open");
      // Crash reporting shares the analytics consent gate; start it once consent
      // has resolved. No-op unless a DSN was compiled in (DARK build) AND the
      // user consented — see services/crash.ts.
      initCrashReporting();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    return () => {
      unlisten?.();
    };
  }, []);

  // ─── Debounced Slack edit notifications ───
  // Fire on: 10min idle after last edit, document switch, or app close
  const editedDocRef = useRef<{ id: string; title: string } | null>(null);
  const editTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const EDIT_DEBOUNCE_MS = 10 * 60 * 1000; // 10 minutes

  const flushEditNotification = useCallback(async () => {
    if (editTimerRef.current) {
      clearTimeout(editTimerRef.current);
      editTimerRef.current = null;
    }
    const edited = editedDocRef.current;
    if (!edited) return;
    editedDocRef.current = null;
    try {
      const { notifySlack } = await import("@/services/slack-notify");
      const user = useAuthStore.getState().user;
      await notifySlack(edited.id, "edit", {
        docTitle: edited.title,
        authorName: user?.displayName || user?.email || undefined,
      });
    } catch {
      /* ignore */
    }
  }, []);

  // Track edits — called from Editor onChange
  const markDocEdited = useCallback(
    (docId: string, title: string) => {
      editedDocRef.current = { id: docId, title };
      if (editTimerRef.current) clearTimeout(editTimerRef.current);
      editTimerRef.current = setTimeout(
        flushEditNotification,
        EDIT_DEBOUNCE_MS,
      );
    },
    [flushEditNotification],
  );

  // Flush on document switch
  useEffect(() => {
    // When activeDocId changes, flush notification for the previously edited doc
    return () => {
      flushEditNotification();
    };
  }, [activeDocId, flushEditNotification]);

  // Detect *local* user edits only. A store-wide updatedAt watcher would also
  // fire for remote collaborator edits synced from Firestore/Yjs, title
  // auto-derive, and folder moves — all mis-attributed to the current user.
  // The editor emits a local-edit signal that already excludes remote sync.
  useEffect(() => {
    return onLocalEdit(({ docId, title }) => markDocEdited(docId, title));
  }, [markDocEdited]);

  // Flush on app close (augment existing onWindowClose)
  useEffect(() => {
    const handleBeforeUnload = () => {
      flushEditNotification();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [flushEditNotification]);

  // Signal to Rust that frontend is alive (cancels failsafe auto-updater).
  // Also send any pending crash reports from previous sessions.
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("cancel_auto_update");
        // Send pending crash reports to Firestore — ONLY with telemetry
        // consent (same privacy gate as GlitchTip). Without consent, leave them
        // queued in the Rust store; they flush if/when the user opts in.
        if (!getConsent()) return;
        const reports = await invoke<string[]>("get_crash_reports").catch(
          () => [] as string[],
        );
        if (reports.length > 0) {
          const { reportCrash } = await import("@/services/firebase");
          for (const raw of reports) {
            try {
              await reportCrash(JSON.parse(raw));
            } catch {}
          }
          await invoke("clear_crash_reports").catch(() => {});
          console.log(
            `[crash-report] Sent ${reports.length} pending crash report(s)`,
          );
        }
      } catch {}
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  // Global JS error handler → Firestore crash report.
  // Consent-gated at fire time: a user who declined telemetry sends nothing.
  // (GlitchTip captures the same errors when consented + scrubbed; this path
  // additionally covers builds shipped without a DSN.)
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      if (!getConsent()) return;
      import("@/services/firebase").then(({ reportCrash }) => {
        reportCrash({
          type: "js_error",
          message: event.message,
          stack:
            event.error?.stack ||
            `${event.filename}:${event.lineno}:${event.colno}`,
          appVersion: __APP_VERSION__,
          platform: navigator.platform,
        }).catch(() => {});
      });
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      if (!getConsent()) return;
      import("@/services/firebase").then(({ reportCrash }) => {
        reportCrash({
          type: "unhandled_rejection",
          message: String(event.reason),
          stack: event.reason?.stack || "",
          appVersion: __APP_VERSION__,
          platform: navigator.platform,
        }).catch(() => {});
      });
    };
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  // Auto-update check — on startup and every 30 minutes while app is open
  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const { getSetting } = await import("@/services/database");
        const channel = ((await getSetting("update_channel")) || "stable") as
          "stable" | "beta";
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
    return () => {
      clearTimeout(startupTimer);
      clearInterval(interval);
    };
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
        requestAnimationFrame(() => {
          document.body.style.opacity = "";
        });
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

  const escTitle = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
    const path = await platform.showSaveDialog({
      defaultPath: `${doc.title}.html`,
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (path) await platform.writeTextFile(path, html);
  }, [activeDocId, documents]);

  const exportText = useCallback(async () => {
    const doc = documents.find((d) => d.id === activeDocId);
    if (!doc) return;
    const platform = await getPlatform();
    const path = await platform.showSaveDialog({
      defaultPath: `${doc.title}.txt`,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
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
    const path = await platform.showSaveDialog({
      defaultPath: `${doc.title}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
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
        const title =
          file.name.replace(/\.md$/i, "").slice(0, 50) || "Imported";
        const authUser = useAuthStore.getState().user;
        const doc: Document = {
          id: crypto.randomUUID(),
          title,
          content,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          folder: "/",
          tags: [],
          ownerId: authUser?.uid ?? null,
        };
        addDocument(doc);
        setActiveDocId(doc.id);
        // Cloud-first: upload to Firestore immediately so reconciliation never deletes it
        if (authUser) {
          import("@/services/firebase")
            .then(({ saveDocumentToFirestore }) => {
              saveDocumentToFirestore({
                id: doc.id,
                title: doc.title,
                content: doc.content,
                ownerId: authUser.uid,
                ownerName: authUser.displayName || authUser.email || undefined,
                folder: doc.folder,
                tags: doc.tags,
                updatedAt: doc.updatedAt,
              }).catch((err) =>
                console.error("[import] Cloud upload failed:", err),
              );
            })
            .catch(() => {});
        }
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

  // ─── Publish to Web ────────────────────────────────────────

  const [publishUrl, setPublishUrl] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const handlePublish = useCallback(async () => {
    const doc = documents.find((d) => d.id === activeDocId);
    const user = useAuthStore.getState().user;
    if (!doc || !user) {
      setPublishError("ドキュメントを選択してログインしてください");
      return;
    }
    // Web publish is a Pro+ feature (MONETIZATION §1.3). Gate the Free plan
    // once billing is live; open the paywall instead of publishing. Tied to
    // BILLING_ENABLED so the dark period (all current users = internal) is
    // untouched. Server-side belt-and-suspenders: the ai-proxy /p/ serve
    // handler refuses to render pages owned by a Free account.
    if (BILLING_ENABLED) {
      const plan = useEntitlementStore.getState().effectivePlan;
      if (plan === "free") {
        setPublishError("Web公開はProプラン以上の機能です。");
        useEntitlementStore.getState().openPaywall();
        return;
      }
    }
    setPublishing(true);
    setPublishError(null);
    try {
      const { generatePublishHtml } = await import("@/lib/html-publish");
      const html = generatePublishHtml({
        title: doc.title,
        content: doc.content,
        themeId: themeSettings.previewTheme,
        isDark: theme === "dark",
        customPreviewThemes,
        customPreviewCss: themeSettings.customPreviewCss,
      });

      // Step 1: Ensure doc exists in Firestore (setDoc+merge, no transaction)
      const {
        getDoc: fsGetDoc,
        setDoc: fsSetDoc,
        doc: fsDoc,
        collection: fsColl,
        serverTimestamp: fsSt,
      } = await import("firebase/firestore");
      const { firestore } = await import("@/services/firebase");
      const docRef = fsDoc(fsColl(firestore, "documents"), doc.id);
      const snap = await fsGetDoc(docRef);
      if (snap.exists()) {
        // Doc exists — just make sure ownerId is correct
        const cd = snap.data();
        if (cd.ownerId && cd.ownerId !== user.uid) {
          throw new Error("このドキュメントのオーナーではありません");
        }
      } else {
        // Doc doesn't exist — create with all required fields
        await fsSetDoc(docRef, {
          title: doc.title,
          content: doc.content,
          ownerId: user.uid,
          ownerName: user.displayName || user.email || undefined,
          folder: doc.folder ?? "/",
          tags: doc.tags ?? [],
          collaborators: {},
          collaboratorUids: [],
          titlePinned: doc.titlePinned ?? false,
          ...(doc.teamId ? { teamId: doc.teamId } : {}),
          createdAt: fsSt(),
          updatedAt: fsSt(),
        });
      }

      // Step 2: Upload HTML via the ai-proxy /v1/publish endpoint. The server
      // verifies we OWN this document, caps the size, enforces the Pro+ gate, and
      // writes published/{docId}.html with its own service account. Clients can no
      // longer write Storage directly (storage.rules denies published/*). The
      // clean custom-domain URL (markflow.jp/p/{docId}) is served by ai-proxy from
      // the same object.
      const token = await user.getIdToken();
      const proxyBase = import.meta.env.VITE_AI_PROXY_URL || "";
      const pubRes = await fetch(`${proxyBase}/v1/publish`, {
        method: "POST",
        headers: aiProxyHeaders(token),
        body: JSON.stringify({ docId: doc.id, html }),
      });
      if (!pubRes.ok) {
        const bodyText = await pubRes.text().catch(() => "");
        let errCode = "";
        try {
          errCode = JSON.parse(bodyText)?.error || "";
        } catch {}
        if (pubRes.status === 402 || errCode === "plan_required") {
          throw new Error("Web公開はProプラン以上の機能です。");
        }
        if (pubRes.status === 403) {
          throw new Error("このドキュメントのオーナーではありません");
        }
        throw new Error(
          `公開に失敗しました (HTTP ${pubRes.status})${errCode ? `: ${errCode}` : ""}`,
        );
      }
      const publishBase =
        import.meta.env.VITE_PUBLISH_BASE_URL || "https://markflow.jp";
      const url = `${publishBase}/p/${doc.id}`;

      // Step 3: Set publish URL on the doc (merge — works for both existing and new)
      await fsSetDoc(
        docRef,
        {
          publishUrl: url,
          publishedAt: fsSt(),
        },
        { merge: true },
      );

      setPublishUrl(url);
      track("publish", { plan: useEntitlementStore.getState().effectivePlan });
      try {
        await navigator.clipboard.writeText(url);
      } catch {}
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Publish failed:", e);
      setPublishError(msg);
    } finally {
      setPublishing(false);
    }
  }, [activeDocId, documents, theme, themeSettings, customPreviewThemes]);

  const handleUnpublish = useCallback(async () => {
    const doc = documents.find((d) => d.id === activeDocId);
    const user = useAuthStore.getState().user;
    if (!doc || !user) return;
    setPublishing(true);
    try {
      const token = await user.getIdToken();
      const proxyBase = import.meta.env.VITE_AI_PROXY_URL || "";
      const res = await fetch(`${proxyBase}/v1/unpublish`, {
        method: "POST",
        headers: aiProxyHeaders(token),
        body: JSON.stringify({ docId: doc.id }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        throw new Error(
          `公開停止に失敗しました (HTTP ${res.status}) ${bodyText}`,
        );
      }
      const { setPublishUrl: saveUrl } = await import("@/services/firebase");
      await saveUrl(doc.id, null);
      setPublishUrl(null);
    } catch (e) {
      console.error("Unpublish failed:", e);
      setPublishError(e instanceof Error ? e.message : String(e));
    } finally {
      setPublishing(false);
    }
  }, [activeDocId, documents]);

  // Clear publish URL when switching documents
  useEffect(() => {
    setPublishUrl(null);
  }, [activeDocId]);

  if (!initialized) {
    return (
      <div
        className="flex h-screen w-screen items-center justify-center bg-background"
        data-tauri-drag-region
      >
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
            !isMobile && "h-screen w-screen",
            isMobile && "safe-top",
          )}
          style={
            isMobile
              ? {
                  position: "fixed",
                  top: 0,
                  left: 0,
                  right: 0,
                  ...(isIOS && keyboardVisible
                    ? { bottom: "auto", height: viewportHeight }
                    : { bottom: 0 }),
                }
              : undefined
          }
        >
          {!isMobile && (
            <div className="h-7 w-full shrink-0" data-tauri-drag-region />
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
          !isMobile && "h-screen w-screen",
          isMobile && "safe-top",
        )}
        style={
          isMobile
            ? {
                position: "fixed",
                top: 0,
                left: 0,
                right: 0,
                ...(isIOS && keyboardVisible
                  ? { bottom: "auto", height: viewportHeight }
                  : { bottom: 0 }),
              }
            : undefined
        }
      >
        {/* Window drag region — desktop only (macOS title bar) */}
        {/* macOS overlay title bar drag region — Windows has its own title bar */}
        {isMac && (
          <div className="h-7 w-full shrink-0" data-tauri-drag-region />
        )}
        {/* Update banner */}
        {updateInfo && (
          <div className="flex items-center justify-between gap-3 bg-primary px-4 py-1.5 text-primary-foreground text-xs shrink-0">
            <span>
              {updateStatus === "downloading"
                ? "ダウンロード中..."
                : updateStatus === "error"
                  ? `更新失敗: ${updateError}`
                  : `MarkFlow v${updateInfo.version} が利用可能です`}
            </span>
            <div className="flex items-center gap-2">
              {updateStatus !== "downloading" && (
                <button
                  className="rounded-md bg-primary-foreground/20 px-3 py-0.5 hover:bg-primary-foreground/30 transition-colors"
                  onClick={() => {
                    setUpdateInfo(null);
                    setUpdateStatus("idle");
                  }}
                >
                  あとで
                </button>
              )}
              <button
                className="rounded-md bg-primary-foreground text-primary px-3 py-0.5 font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                onClick={handleInstallUpdate}
                disabled={updateStatus === "downloading"}
              >
                {updateStatus === "error"
                  ? "再試行"
                  : updateStatus === "downloading"
                    ? "..."
                    : "アップデート"}
              </button>
            </div>
          </div>
        )}
        {/* Owner view-as preview banner (三田遼平 only; shown while previewing) */}
        {viewAsPlan && isOwner && (
          <div className="flex flex-wrap items-center justify-between gap-2 bg-amber-500 px-4 py-1.5 text-black text-xs shrink-0">
            <span className="font-medium">
              プレビュー中: 一般ユーザー（{planLabel(viewAsPlan)}
              プラン）として表示・課金上限を適用しています
            </span>
            <div className="flex items-center gap-1.5">
              {(["free", "pro", "team"] as const).map((p) => (
                <button
                  key={p}
                  className={cn(
                    "rounded-md px-2 py-0.5 font-medium transition-colors",
                    viewAsPlan === p
                      ? "bg-black text-amber-400"
                      : "bg-black/15 hover:bg-black/25",
                  )}
                  onClick={() => setViewAs(p)}
                >
                  {planLabel(p)}
                </button>
              ))}
              <button
                className="rounded-md bg-black/15 px-2 py-0.5 hover:bg-black/25 transition-colors"
                onClick={() => resetPreviewUsage()}
                title="このプレビューの今月の利用量をリセット（オーナーの自分の利用量のみ）"
              >
                利用量リセット
              </button>
              <button
                className="rounded-md bg-black px-3 py-0.5 font-medium text-amber-400 hover:opacity-90 transition-opacity"
                onClick={() => setViewAs(null)}
              >
                元に戻す
              </button>
            </div>
          </div>
        )}
        {/* Quota exceeded banner (general users + owner-in-preview) */}
        {lastQuotaError && (
          <div className="flex flex-wrap items-center justify-between gap-2 bg-red-600 px-4 py-1.5 text-white text-xs shrink-0">
            <span>
              「{featureLabel(lastQuotaError.feature)}
              」が今月の上限に達しました（
              {planLabel(lastQuotaError.plan)}プラン: {lastQuotaError.used}/
              {lastQuotaError.limit}
              ）。アップグレードで上限を大きく緩和できます。
            </span>
            <div className="flex items-center gap-2">
              {BILLING_ENABLED && (
                <button
                  className="rounded-md bg-white px-3 py-0.5 font-medium text-red-600 hover:opacity-90 transition-opacity"
                  onClick={() => openPaywall(lastQuotaError.feature)}
                >
                  アップグレード
                </button>
              )}
              <button
                className="rounded-md bg-white/20 px-3 py-0.5 hover:bg-white/30 transition-colors"
                onClick={clearQuota}
              >
                閉じる
              </button>
            </div>
          </div>
        )}
        {/* Publish banner */}
        {(publishUrl || publishing || publishError) && (
          <div
            className={cn(
              "flex items-center justify-between gap-3 px-4 py-1.5 text-white text-xs shrink-0",
              publishError ? "bg-red-600" : "bg-green-600",
            )}
          >
            {publishing ? (
              <span>公開中...</span>
            ) : publishError ? (
              <>
                <span className="truncate">公開エラー: {publishError}</span>
                <button
                  className="rounded-md bg-white/20 px-3 py-0.5 hover:bg-white/30 transition-colors"
                  onClick={() => setPublishError(null)}
                >
                  ✕
                </button>
              </>
            ) : (
              <>
                <span className="truncate">
                  公開URL:{" "}
                  <a
                    href={publishUrl!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    {publishUrl}
                  </a>
                  <span className="ml-2 opacity-70">
                    (クリップボードにコピー済み)
                  </span>
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    className="rounded-md bg-white/20 px-3 py-0.5 hover:bg-white/30 transition-colors whitespace-nowrap"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(publishUrl!);
                      } catch {}
                    }}
                  >
                    コピー
                  </button>
                  <button
                    className="rounded-md bg-white/20 px-3 py-0.5 hover:bg-white/30 transition-colors whitespace-nowrap"
                    onClick={() => setPublishUrl(null)}
                  >
                    ✕
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar — swipeable overlay on iOS, inline on desktop */}
          {isMobile && (sidebarOpen || swiping) && (
            <div
              className="fixed inset-0 z-40"
              style={{
                backgroundColor: `rgba(0,0,0,${0.3 * backdropOpacity})`,
              }}
              onClick={toggleSidebar}
            />
          )}
          {isMobile
            ? (sidebarOpen || swiping) && (
                <div
                  className="fixed inset-y-0 left-0 z-50 safe-top shadow-xl bg-background overflow-hidden"
                  style={{
                    width: "min(320px, 85vw)",
                    transform: `translateX(${sidebarTranslateX}px)`,
                    transition: swiping
                      ? "none"
                      : "transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)",
                    willChange: "transform",
                  }}
                >
                  <Sidebar />
                </div>
              )
            : sidebarOpen && (
                <>
                  <div
                    className="shrink-0 overflow-hidden"
                    style={{ width: sidebarWidth }}
                  >
                    <Sidebar />
                  </div>
                  <div
                    className="w-1 shrink-0 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
                    onPointerDown={(e) => handleResizeStart("sidebar", e)}
                  />
                </>
              )}

          {/* Main content */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Top bar — draggable on desktop, normal on iOS */}
            <div
              className={cn(
                "flex items-center justify-between border-b border-border px-3 pb-1.5",
                isMobile && "pt-1 safe-left safe-right",
              )}
              {...(!isMobile ? { "data-tauri-drag-region": true } : {})}
            >
              <div className="flex items-center gap-1">
                {!sidebarOpen && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className={isMobile ? "h-11 w-11" : "h-7 w-7"}
                    onClick={toggleSidebar}
                  >
                    <PanelLeft className={isMobile ? "h-5 w-5" : "h-4 w-4"} />
                  </Button>
                )}
                {/* View mode toggle */}
                {isMobile ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11"
                    onClick={() => {
                      const modes: ViewMode[] = [
                        "editor",
                        "canvas",
                        "visualization",
                      ];
                      setViewMode(
                        modes[(modes.indexOf(viewMode) + 1) % modes.length],
                      );
                    }}
                    title={
                      viewMode === "editor"
                        ? "Editor"
                        : viewMode === "canvas"
                          ? "Canvas"
                          : "Visualization"
                    }
                  >
                    {viewMode === "editor" ? (
                      <PenLine className="h-5 w-5" />
                    ) : viewMode === "canvas" ? (
                      <LayoutGrid className="h-5 w-5" />
                    ) : (
                      <Network className="h-5 w-5" />
                    )}
                  </Button>
                ) : (
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
                      variant={
                        viewMode === "visualization" ? "secondary" : "ghost"
                      }
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => setViewMode("visualization")}
                      title="Visualization"
                    >
                      <Network className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
                {/* Import markdown — desktop only */}
                {!isMobile && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={handleImportMarkdown}
                    title="Import .md file"
                  >
                    <Upload className="h-3.5 w-3.5" />
                  </Button>
                )}
                {!isMobile && (
                  <span className="ml-1 text-[10px] text-muted-foreground hidden sm:inline">
                    Cmd+K search · Cmd+Shift+/ shortcuts
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    isMobile ? "h-11 w-11" : "h-7 w-7",
                    "disabled:opacity-40 disabled:pointer-events-none",
                  )}
                  onClick={() => setShareOpen(true)}
                  disabled={!activeDocId}
                  title="Share"
                >
                  <Share2 className={isMobile ? "h-5 w-5" : "h-4 w-4"} />
                </Button>
                {viewMode === "editor" && (
                  <>
                    {isMobile && researchCardCount > 0 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                          "relative h-11 w-11",
                          mobileSheetOpen && "bg-accent",
                        )}
                        onClick={() => setMobileSheetOpen(true)}
                        title="リサーチ"
                      >
                        {researchAnalyzing ? (
                          <Search className="h-5 w-5 animate-pulse text-blue-500" />
                        ) : (
                          <Search className="h-5 w-5" />
                        )}
                        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-bold text-white">
                          {researchCardCount}
                        </span>
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        isMobile ? "h-11 w-11" : "h-7 w-7",
                        rightPanel === "ai" && "bg-accent",
                        "disabled:opacity-40 disabled:pointer-events-none",
                      )}
                      onClick={() => togglePanel("ai")}
                      disabled={!activeDocId}
                      title="Claude AI"
                    >
                      <Bot className={isMobile ? "h-5 w-5" : "h-4 w-4"} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        isMobile ? "h-11 w-11" : "h-7 w-7",
                        rightPanel === "versions" && "bg-accent",
                        "disabled:opacity-40 disabled:pointer-events-none",
                      )}
                      onClick={() => togglePanel("versions")}
                      disabled={!activeDocId}
                      title="Version history"
                    >
                      <History className={isMobile ? "h-5 w-5" : "h-4 w-4"} />
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
                      <span className="text-sm font-medium">
                        {diffState.title}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {diffState.time}
                      </span>
                    </div>
                    <div className="flex-1 overflow-auto px-6 py-4">
                      <DiffView
                        oldText={diffState.oldText}
                        newText={diffState.newText}
                        fullPage
                      />
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
              {viewMode === "editor" && rightPanel !== "none" && !isMobile && (
                <>
                  {/* Right panel resize handle — desktop */}
                  <div
                    className="w-1 shrink-0 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
                    onPointerDown={(e) => handleResizeStart("right", e)}
                  />
                  <div
                    className="shrink-0 overflow-hidden"
                    style={{ width: rightPanelWidth }}
                  >
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
        {isMobile && viewMode === "editor" && rightPanel !== "none" && (
          <div
            className="fixed z-40 flex flex-col safe-top bg-background"
            style={{
              top: 0,
              left: 0,
              right: 0,
              ...(keyboardVisible
                ? { bottom: "auto", height: viewportHeight }
                : { bottom: 0 }),
            }}
          >
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

        {/* Research bottom sheet — mobile only */}
        {isMobile && mobileSheetOpen && viewMode === "editor" && (
          <ResearchSheet
            viewportHeight={viewportHeight}
            keyboardVisible={keyboardVisible}
          />
        )}

        {/* Syncing overlay — initial sync or closing sync */}
        {(closingSyncVisible || (syncing && !initialSyncDoneRef.current)) && (
          <div
            className="fixed inset-0 z-100 flex items-center justify-center bg-background/60 backdrop-blur-[2px]"
            data-tauri-drag-region
          >
            <div className="flex items-center gap-3 rounded-lg bg-card border border-border px-5 py-3 shadow-lg">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-sm text-foreground">
                {closingSyncVisible ? "保存中..." : "Syncing..."}
              </span>
            </div>
          </div>
        )}
        {!(isMobile && keyboardVisible) && <StatusBar />}
        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          onPublish={handlePublish}
          onUnpublish={handleUnpublish}
          publishUrl={publishUrl}
          publishing={publishing}
        />
        <KeyboardShortcutsDialog
          open={shortcutsOpen}
          onOpenChange={setShortcutsOpen}
        />
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
          onOpenShareLink={openShareLink}
          onPublish={handlePublish}
          onUnpublish={handleUnpublish}
          isPublished={!!publishUrl}
        />
        {/* Hidden file input for markdown import */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,.txt"
          className="hidden"
          onChange={handleFileChange}
        />
        {/* Upgrade/paywall (self-gated behind BILLING_ENABLED via openPaywall) */}
        <PaywallDialog />
        {/* Team management + seat billing (global; opened from UserMenu/Paywall) */}
        <GlobalTeamManageDialog />
        {/* Bug report / feedback (global; opened from UserMenu and crash-prefill) */}
        <GlobalFeedbackDialog />
        {/* Regional analytics consent surface (once, until the user decides) */}
        <TelemetryConsentBanner />
      </div>
    </TooltipProvider>
  );
}

/**
 * Global mount of the feedback dialog, driven by the feedback store's `open`
 * flag. Mounted once here so "問題を報告" (UserMenu) and a throttled crash-prefill
 * both route through openFeedback() to a single instance.
 */
function GlobalFeedbackDialog() {
  const open = useFeedbackStore((s) => s.open);
  const prefillError = useFeedbackStore((s) => s.prefillError);
  const closeFeedback = useFeedbackStore((s) => s.closeFeedback);
  return (
    <FeedbackDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) closeFeedback();
      }}
      prefillError={prefillError}
    />
  );
}

/**
 * Global mount of the team-management dialog, driven by the entitlement store's
 * teamManageOpen flag. Mounted once here (not inside UserMenu) so it can be
 * opened from anywhere — the UserMenu entry AND the Paywall's Team card both
 * route to it via openTeamManage(), and there is exactly one instance.
 */
function GlobalTeamManageDialog() {
  const open = useEntitlementStore((s) => s.teamManageOpen);
  const openTeamManage = useEntitlementStore((s) => s.openTeamManage);
  const closeTeamManage = useEntitlementStore((s) => s.closeTeamManage);
  return (
    <TeamManageDialog
      open={open}
      onOpenChange={(o) => (o ? openTeamManage() : closeTeamManage())}
    />
  );
}

export default App;
