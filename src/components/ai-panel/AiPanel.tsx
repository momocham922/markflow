import { useState, useRef, useEffect, useCallback } from "react";
import {
  Bot,
  Send,
  X,
  Sparkles,
  FileText,
  Languages,
  Check,
  Minimize,
  Maximize,
  List,
  Copy,
  CornerDownLeft,
  Replace,
  LogIn,
  BookOpen,
  Trash2,
  Globe,
  Paperclip,
  Settings,
  Image as ImageIcon,
  WandSparkles,
  Wrench,
  Plus,
  MessageSquare,
  ChevronDown,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import rehypeHighlight from "rehype-highlight";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  sendToClaude,
  sendWithToolLoop,
  AI_ACTIONS,
  type ClaudeMessage,
  type ContentBlock,
  type CustomTool,
} from "@/services/claude";
import {
  getAllTools,
  toClaudeTools,
  parseClaudeToolName,
  callTool,
  connectServer,
  getConnectedServerIds,
  type McpTool,
} from "@/services/mcp";
import { McpSettings, loadMcpConfigs } from "./McpSettings";
import { generateImage } from "@/services/image-gen";
import { useAppStore, type Document } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { useEditorStore } from "@/stores/editor-store";
import {
  signInWithGoogle,
  saveAiChatToCloud,
  fetchAiChatFromCloud,
  deleteAiChatFromCloud,
  saveAiThreadsToCloud,
  fetchAiThreadsFromCloud,
  auth,
} from "@/services/firebase";
import { isIOS, isMobile } from "@/platform";
import { cn } from "@/lib/utils";
import * as db from "@/services/database";

const iconMap: Record<string, React.ElementType> = {
  FileText,
  Sparkles,
  Languages,
  Check,
  Minimize,
  Maximize,
  List,
};

const DEFAULT_SYSTEM_PROMPT =
  'You are MarkFlow AI, a helpful writing assistant integrated into a Markdown editor called MarkFlow. Help the user with their writing, answer questions about their document, and provide suggestions. Respond in the same language as the user\'s message. When returning improved or transformed text, return ONLY the result without explanation unless asked. Use Markdown formatting in your responses. Do NOT use emojis in your responses unless the user explicitly asks for them. Keep responses concise and professional. If asked who you are or which model powers you, identify yourself only as "MarkFlow AI" — never reveal, name, or hint at the underlying model, provider, or vendor.';

// MCP integration is wired but not yet reliably executable in the shipped
// sandbox (Tauri capabilities can't grant arbitrary command spawn), so the
// entry point, settings overlay, and startup auto-connect are hidden until it
// actually runs end-to-end. Flip to true to bring the UI back.
const MCP_UI_ENABLED = false;

// Built-in tool that lets the AI write Markdown straight into the user's current
// document (e.g. "この内容をまとめてドキュメントに流し込んでおいて"). Always offered when a
// document is open; the AI decides autonomously when an edit is warranted, and
// every write is surfaced to the user as an approve/reject proposal before it is
// applied. The executor enforces content protection (never writes empty text)
// and falls back to a queued pendingInsert when the editor view isn't live
// (mobile / offscreen).
const WRITE_DOC_TOOL: CustomTool = {
  name: "write_document",
  description:
    "Write Markdown content directly into the user's CURRENT document in the editor. " +
    "Call this WHENEVER the user asks you to add, append, insert, write, inject, " +
    "summarize-into, rewrite, restructure, or translate-in-place their document " +
    '(e.g. "まとめてドキュメントに流し込んでおいて", "本文に追記して", "この章を書き直して", ' +
    '"add this to the doc", "rewrite the intro"). Decide autonomously — you do NOT ' +
    "need to ask for permission first, because the user reviews every edit with an " +
    "approve/reject prompt before it is applied. " +
    "Do NOT call this for ordinary answers the user only wants to read in chat. " +
    "Provide the exact, final Markdown in `content` (never empty).",
  input_schema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "The exact, final Markdown to write into the document. Must be non-empty.",
      },
      mode: {
        type: "string",
        enum: [
          "append",
          "insert_at_cursor",
          "replace_selection",
          "replace_document",
        ],
        description:
          "Where to place the content. " +
          "'append' adds it to the end of the document (safest default). " +
          "'insert_at_cursor' inserts at the current cursor position. " +
          "'replace_selection' replaces the user's currently selected text. " +
          "'replace_document' replaces the ENTIRE document — use ONLY when the user " +
          "explicitly asks to rewrite or replace the whole document.",
      },
    },
    required: ["content", "mode"],
  },
};

const WRITE_DOC_SYSTEM_ADDENDUM =
  "\n\n--- Document Writing ---\n" +
  'You can write directly into the user\'s current document with the "write_document" tool. ' +
  "Decide AUTONOMOUSLY when an edit is warranted: whenever the user asks you to add, append, insert, " +
  "summarize-into, inject, rewrite, restructure, or translate-in-place their document, call " +
  "write_document with the final Markdown and an appropriate mode (prefer 'append' for new content; " +
  "use 'replace_document' only when the user clearly wants the whole document rewritten, and " +
  "'replace_selection' when they refer to the current selection). You do NOT need to ask for " +
  "permission first — every write is shown to the user as an approve/reject proposal before it is " +
  "applied, so just call the tool with your best edit. After the tool returns, briefly confirm the " +
  "outcome in the user's language (mention it if they rejected the edit). For questions the user only " +
  "wants answered in chat, do NOT call the tool — just reply normally.";

// Human-readable labels for the write_document modes, shown on the approve/
// reject proposal card so the user knows exactly what the AI is about to do.
const WRITE_MODE_LABELS: Record<string, string> = {
  append: "Append to end of document",
  insert_at_cursor: "Insert at cursor",
  replace_selection: "Replace selected text",
  replace_document: "Rewrite the entire document",
};

interface AiPanelProps {
  onClose: () => void;
  // iOS soft-keyboard state (mobile overlay only). When the keyboard is up we
  // drop the bottom safe-area padding so no phantom gap opens under the input.
  keyboardVisible?: boolean;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: { data: string; mediaType: string }[];
  generatedImage?: { url: string; markdown: string };
}

interface ChatThread {
  id: string;
  title: string;
  createdAt: number;
}

// --- Custom Rules Dialog (inline) ---
function RulesEditor({
  open,
  onClose,
  rules,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  rules: string;
  onSave: (rules: string) => void;
}) {
  const [draft, setDraft] = useState(rules);
  useEffect(() => {
    if (open) setDraft(rules);
  }, [open, rules]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium">AI Custom Rules</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 cursor-pointer"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex-1 p-3 flex flex-col gap-2 min-h-0">
        <p className="text-[10px] text-muted-foreground">
          Custom instructions that are always included in the system prompt.
          Example: "Always respond in Japanese." or "Use bullet points for all
          answers."
        </p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Enter custom instructions for the AI..."
          className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring resize-none select-text"
        />
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs cursor-pointer"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="text-xs cursor-pointer"
            onClick={() => {
              onSave(draft);
              onClose();
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AiPanel({ onClose, keyboardVisible = false }: AiPanelProps) {
  const { activeDocId, documents } = useAppStore();
  const user = useAuthStore((s) => s.user);
  const activeDoc = documents.find((d) => d.id === activeDocId);
  const {
    getSelectedText,
    replaceSelection,
    appendToDoc,
    insertAtCursor,
    replaceDocument,
    setPendingInsert,
  } = useEditorStore();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [apiMessages, setApiMessages] = useState<ClaudeMessage[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [threadListOpen, setThreadListOpen] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [allDocsContext, setAllDocsContext] = useState(false);
  // Web search defaults ON — most questions benefit from up-to-date grounding.
  const [webSearch, setWebSearch] = useState(true);
  // Pending write proposal: when the AI decides to edit the document via the
  // write_document tool, the edit is held here and shown as an approve/reject
  // card. `writeResolverRef` unblocks the awaiting tool executor on the choice.
  const [writeProposal, setWriteProposal] = useState<{
    content: string;
    mode: string;
  } | null>(null);
  const writeResolverRef = useRef<((approved: boolean) => void) | null>(null);
  const [customRules, setCustomRules] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [attachedImages, setAttachedImages] = useState<
    { data: string; mediaType: string; preview: string }[]
  >([]);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [mcpTools, setMcpTools] = useState<McpTool[]>([]);
  const [mcpSettingsOpen, setMcpSettingsOpen] = useState(false);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [generatingImage, setGeneratingImage] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevDocIdRef = useRef<string | null>(null);
  const threadListRef = useRef<HTMLDivElement>(null);

  // Load custom rules from DB on mount
  useEffect(() => {
    db.getSetting("ai_custom_rules")
      .then((val) => {
        if (val) setCustomRules(val);
      })
      .catch(() => {});
  }, []);

  // If the panel unmounts while a write proposal is pending, reject it so the
  // awaiting tool executor resolves instead of leaking a hung Promise.
  useEffect(() => {
    return () => {
      if (writeResolverRef.current) {
        writeResolverRef.current(false);
        writeResolverRef.current = null;
      }
    };
  }, []);

  // Auto-connect MCP servers on mount
  useEffect(() => {
    if (!MCP_UI_ENABLED) return;
    loadMcpConfigs()
      .then(async (configs) => {
        const enabled = configs.filter((c) => c.enabled);
        const connected = getConnectedServerIds();
        for (const config of enabled) {
          if (!connected.includes(config.id)) {
            try {
              await connectServer(config);
            } catch {
              // Silently skip servers that fail to connect on startup
            }
          }
        }
        setMcpTools(getAllTools());
      })
      .catch(() => {});
  }, []);

  const refreshMcpTools = useCallback(() => {
    setMcpTools(getAllTools());
  }, []);

  const saveCustomRules = useCallback((rules: string) => {
    setCustomRules(rules);
    db.setSetting("ai_custom_rules", rules).catch(() => {});
    // Cloud sync
    const uid = useAuthStore.getState().user?.uid;
    if (uid) {
      import("@/services/firebase").then(({ saveUserSettingsToFirestore }) => {
        saveUserSettingsToFirestore(uid, { ai_custom_rules: rules }).catch(
          () => {},
        );
      });
    }
  }, []);

  // ─── Thread-based chat persistence ─────────────────────────

  /** Save thread list metadata (local + cloud) */
  const saveThreadList = useCallback(
    (docId: string, threadList: ChatThread[]) => {
      db.setSetting(
        `ai_chat_threads_${docId}`,
        JSON.stringify(threadList),
      ).catch(() => {});
      const uid = useAuthStore.getState().user?.uid;
      if (uid) saveAiThreadsToCloud(uid, docId, threadList).catch(() => {});
    },
    [],
  );

  /** Save chat content for a specific thread (local + cloud) */
  const saveChatHistory = useCallback(
    (
      docId: string,
      threadId: string,
      msgs: ChatMessage[],
      apiMsgs: ClaudeMessage[],
    ) => {
      if (!docId || !threadId || msgs.length === 0) return;
      const toSave = { messages: msgs, apiMessages: apiMsgs };
      const key = `ai_chat_${docId}_${threadId}`;
      db.setSetting(key, JSON.stringify(toSave)).catch(() => {});
      const uid = useAuthStore.getState().user?.uid;
      if (uid)
        saveAiChatToCloud(uid, `${docId}__${threadId}`, toSave).catch(() => {});
    },
    [],
  );

  /** Load thread content (cloud-first, local fallback) */
  const loadThreadContent = useCallback(
    async (docId: string, threadId: string) => {
      const uid = useAuthStore.getState().user?.uid;
      // Cloud first
      if (uid) {
        try {
          const cloudData = await fetchAiChatFromCloud(
            uid,
            `${docId}__${threadId}`,
          );
          if (
            cloudData &&
            Array.isArray(cloudData.messages) &&
            cloudData.messages.length > 0
          ) {
            setMessages(cloudData.messages as ChatMessage[]);
            setApiMessages((cloudData.apiMessages || []) as ClaudeMessage[]);
            return;
          }
        } catch {
          /* cloud unavailable */
        }
      }
      // Local fallback
      try {
        const raw = await db.getSetting(`ai_chat_${docId}_${threadId}`);
        if (raw) {
          const parsed = JSON.parse(raw);
          setMessages(parsed.messages || []);
          setApiMessages(parsed.apiMessages || []);
          return;
        }
      } catch {
        /* ignore */
      }
      setMessages([]);
      setApiMessages([]);
    },
    [],
  );

  /** Load all threads for a document (with backward compat migration) */
  const loadDocThreads = useCallback(
    async (docId: string) => {
      let threadList: ChatThread[] = [];

      // Try cloud first for thread metadata
      const uid = useAuthStore.getState().user?.uid;
      if (uid) {
        try {
          const cloudThreads = await fetchAiThreadsFromCloud(uid, docId);
          if (cloudThreads && cloudThreads.length > 0) {
            threadList = cloudThreads;
          }
        } catch {
          /* cloud unavailable */
        }
      }

      // Local fallback
      if (threadList.length === 0) {
        try {
          const raw = await db.getSetting(`ai_chat_threads_${docId}`);
          if (raw) threadList = JSON.parse(raw);
        } catch {
          /* ignore */
        }
      }

      // Backward compatibility: migrate old single-thread data
      if (threadList.length === 0) {
        let hasOldData = false;
        if (uid) {
          try {
            const oldCloud = await fetchAiChatFromCloud(uid, docId);
            if (
              oldCloud &&
              Array.isArray(oldCloud.messages) &&
              oldCloud.messages.length > 0
            ) {
              hasOldData = true;
              // Migrate to new format
              const defaultId = "default";
              const firstMsg =
                (oldCloud.messages[0] as ChatMessage)?.content || "Chat";
              threadList = [
                {
                  id: defaultId,
                  title: firstMsg.slice(0, 40),
                  createdAt: Date.now(),
                },
              ];
              // Save migrated data under new key
              saveChatHistory(
                docId,
                defaultId,
                oldCloud.messages as ChatMessage[],
                (oldCloud.apiMessages || []) as ClaudeMessage[],
              );
              saveThreadList(docId, threadList);
              // Delete old format
              deleteAiChatFromCloud(uid, docId).catch(() => {});
            }
          } catch {
            /* ignore */
          }
        }
        if (!hasOldData) {
          try {
            const oldLocal = await db.getSetting(`ai_chat_${docId}`);
            if (oldLocal) {
              const parsed = JSON.parse(oldLocal);
              if (parsed.messages?.length > 0) {
                const defaultId = "default";
                const firstMsg =
                  (parsed.messages[0] as ChatMessage)?.content || "Chat";
                threadList = [
                  {
                    id: defaultId,
                    title: firstMsg.slice(0, 40),
                    createdAt: Date.now(),
                  },
                ];
                saveChatHistory(
                  docId,
                  defaultId,
                  parsed.messages,
                  parsed.apiMessages || [],
                );
                saveThreadList(docId, threadList);
                db.setSetting(`ai_chat_${docId}`, "").catch(() => {}); // Clear old
              }
            }
          } catch {
            /* ignore */
          }
        }
      }

      setThreads(threadList);
      const latestId =
        threadList.length > 0 ? threadList[threadList.length - 1].id : null;
      setActiveThreadId(latestId);
      if (latestId && docId) {
        await loadThreadContent(docId, latestId);
      } else {
        setMessages([]);
        setApiMessages([]);
      }
    },
    [saveChatHistory, saveThreadList, loadThreadContent],
  );

  /** Create a new thread */
  const createNewThread = useCallback(() => {
    if (!activeDocId) return;
    // Save current thread first
    if (activeThreadId && messages.length > 0) {
      saveChatHistory(activeDocId, activeThreadId, messages, apiMessages);
    }
    const newThread: ChatThread = {
      id: crypto.randomUUID().slice(0, 8),
      title: "New topic",
      createdAt: Date.now(),
    };
    const newList = [...threads, newThread];
    setThreads(newList);
    setActiveThreadId(newThread.id);
    setMessages([]);
    setApiMessages([]);
    setStreamingText("");
    saveThreadList(activeDocId, newList);
  }, [
    activeDocId,
    activeThreadId,
    messages,
    apiMessages,
    threads,
    saveChatHistory,
    saveThreadList,
  ]);

  /** Switch to a thread */
  const switchThread = useCallback(
    async (threadId: string) => {
      if (!activeDocId || threadId === activeThreadId) return;
      // Save current
      if (activeThreadId && messages.length > 0) {
        saveChatHistory(activeDocId, activeThreadId, messages, apiMessages);
      }
      setActiveThreadId(threadId);
      setStreamingText("");
      setThreadListOpen(false);
      await loadThreadContent(activeDocId, threadId);
    },
    [
      activeDocId,
      activeThreadId,
      messages,
      apiMessages,
      saveChatHistory,
      loadThreadContent,
    ],
  );

  /** Delete a thread */
  const deleteThread = useCallback(
    async (threadId: string) => {
      if (!activeDocId) return;
      const newList = threads.filter((t) => t.id !== threadId);
      setThreads(newList);
      saveThreadList(activeDocId, newList);
      // Delete data
      const key = `ai_chat_${activeDocId}_${threadId}`;
      db.setSetting(key, "").catch(() => {});
      const uid = useAuthStore.getState().user?.uid;
      if (uid)
        deleteAiChatFromCloud(uid, `${activeDocId}__${threadId}`).catch(
          () => {},
        );
      // Switch if needed
      if (activeThreadId === threadId) {
        if (newList.length > 0) {
          const nextId = newList[newList.length - 1].id;
          setActiveThreadId(nextId);
          await loadThreadContent(activeDocId, nextId);
        } else {
          setActiveThreadId(null);
          setMessages([]);
          setApiMessages([]);
        }
      }
    },
    [activeDocId, activeThreadId, threads, saveThreadList, loadThreadContent],
  );

  // Save/restore on document switch
  useEffect(() => {
    if (prevDocIdRef.current !== null && prevDocIdRef.current !== activeDocId) {
      // Save previous thread
      if (prevDocIdRef.current && activeThreadId && messages.length > 0) {
        saveChatHistory(
          prevDocIdRef.current,
          activeThreadId,
          messages,
          apiMessages,
        );
      }
      setStreamingText("");
      setThreadListOpen(false);
      // Reset thread/messages synchronously BEFORE loading the new doc's
      // threads. During the async load there is otherwise a window where
      // activeDocId is already the new doc but activeThreadId/messages still
      // belong to the previous one; the debounced auto-save would then persist
      // the old messages under the new doc. Legacy docs share the hardcoded
      // "default" thread id, so the id-equality guard cannot catch that alias.
      // Clearing activeThreadId to null also makes the subsequent
      // setActiveThreadId("default") a real transition (not a no-op bailout),
      // so the pending stale save timer is reliably cleared.
      setActiveThreadId(null);
      setMessages([]);
      setApiMessages([]);
      if (activeDocId) loadDocThreads(activeDocId);
      else setThreads([]);
    } else if (prevDocIdRef.current === null && activeDocId) {
      loadDocThreads(activeDocId);
    }
    prevDocIdRef.current = activeDocId;
  }, [activeDocId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save chat history on message changes (debounced)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "Latest value" refs: during a document switch there is a render where
  // activeDocId has already advanced to the new doc but activeThreadId/messages
  // still belong to the previous doc (loadDocThreads is async). This guard
  // rejects a stale save whose doc/thread no longer matches the live values.
  // NOTE: thread ids are NOT globally unique — legacy docs share the hardcoded
  // "default" id — so this comparison alone cannot catch a same-id cross-doc
  // alias. The synchronous reset in the document-switch effect above is the
  // primary defense; this ref check is defense-in-depth.
  const activeDocIdRef = useRef(activeDocId);
  activeDocIdRef.current = activeDocId;
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  useEffect(() => {
    if (!activeDocId || !activeThreadId || messages.length === 0) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const docId = activeDocId;
    const threadId = activeThreadId;
    saveTimerRef.current = setTimeout(() => {
      // Skip if the active doc/thread changed since this save was scheduled.
      if (
        activeDocIdRef.current !== docId ||
        activeThreadIdRef.current !== threadId
      )
        return;
      saveChatHistory(docId, threadId, messages, apiMessages);
      // Auto-update thread title from first user message
      const firstUserMsg = messages.find((m) => m.role === "user");
      if (firstUserMsg) {
        const title = firstUserMsg.content.slice(0, 40);
        setThreads((prev) => {
          const updated = prev.map((t) =>
            t.id === threadId ? { ...t, title } : t,
          );
          saveThreadList(docId, updated);
          return updated;
        });
      }
    }, 1000);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [
    messages,
    apiMessages,
    activeDocId,
    activeThreadId,
    saveChatHistory,
    saveThreadList,
  ]);

  // Close thread dropdown on outside click
  useEffect(() => {
    if (!threadListOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        threadListRef.current &&
        !threadListRef.current.contains(e.target as Node)
      ) {
        setThreadListOpen(false);
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [threadListOpen]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
    }
  }, [input]);

  const getSystemPrompt = (): string => {
    if (!customRules.trim()) return DEFAULT_SYSTEM_PROMPT;
    return `${DEFAULT_SYSTEM_PROMPT}\n\n--- User's Custom Instructions ---\n${customRules}`;
  };

  const stripHtml = (html: string) => {
    const parser = new DOMParser();
    const parsed = parser.parseFromString(html, "text/html");
    return parsed.body.textContent || "";
  };

  // Cache for document summaries (avoids re-summarizing unchanged docs)
  const docSummaryCache = useRef<
    Map<string, { hash: number; summary: string }>
  >(new Map());

  const hashContent = (s: string): number => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h;
  };

  const buildDocMeta = (doc: Document): string => {
    const flags: string[] = [];
    if (doc.teamId) flags.push("team");
    else if (doc.isShared) flags.push("shared");
    else flags.push("personal");
    if (doc.docType === "mindmap") flags.push("mindmap");
    const date = new Date(doc.updatedAt)
      .toISOString()
      .slice(0, 16)
      .replace("T", " ");
    return `[${flags.join(",")}] folder="${doc.folder || "/"}" tags=[${(doc.tags || []).join(",")}] updated=${date}`;
  };

  const summarizeDoc = async (text: string): Promise<string> => {
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) return text.slice(0, 500) + "...";
      const result = await sendToClaude(
        token,
        "Summarize this document in 2-3 sentences. Keep the same language. Output ONLY the summary.",
        [{ role: "user", content: text.slice(0, 6000) }],
      );
      return result.trim() || text.slice(0, 500) + "...";
    } catch {
      return text.slice(0, 500) + "...";
    }
  };

  const buildContextPrefix = async (): Promise<string> => {
    const parts: string[] = [];
    const TOKEN_BUDGET = 12000; // ~chars, conservative estimate for context window
    let usedChars = 0;

    if (allDocsContext && documents.length > 1) {
      parts.push("=== All Documents in Workspace ===");

      // Current doc: always full content + full meta
      if (activeDoc) {
        const text = stripHtml(activeDoc.content);
        parts.push(
          `\n--- ${activeDoc.title} (CURRENT) ---\n${buildDocMeta(activeDoc)}\n\n${text}`,
        );
        usedChars += text.length;
      }

      // Other docs: sort by updatedAt desc (most recent first)
      const otherDocs = documents
        .filter((d) => d.id !== activeDocId)
        .sort((a, b) => b.updatedAt - a.updatedAt);

      for (const doc of otherDocs) {
        const text = stripHtml(doc.content);
        const meta = buildDocMeta(doc);
        const contentHash = hashContent(text);

        if (text.length <= 2000 && usedChars + text.length < TOKEN_BUDGET) {
          // Short doc: full content
          parts.push(`\n--- ${doc.title} ---\n${meta}\n\n${text}`);
          usedChars += text.length;
        } else if (usedChars < TOKEN_BUDGET) {
          // Long doc or budget tight: use cached summary or generate one
          const cached = docSummaryCache.current.get(doc.id);
          let summary: string;
          if (cached && cached.hash === contentHash) {
            summary = cached.summary;
          } else {
            summary = await summarizeDoc(text);
            docSummaryCache.current.set(doc.id, { hash: contentHash, summary });
          }
          parts.push(`\n--- ${doc.title} ---\n${meta}\n\n[Summary] ${summary}`);
          usedChars += summary.length;
        } else {
          // Over budget: metadata only
          parts.push(
            `\n--- ${doc.title} ---\n${meta}\n\n[Content omitted — over context budget]`,
          );
        }
      }

      parts.push("\n=== End of Documents ===\n");
    } else if (activeDoc) {
      const text = stripHtml(activeDoc.content);
      parts.push(
        `Current document "${activeDoc.title}":\n${buildDocMeta(activeDoc)}\n\n${text}`,
      );
    }

    const selected = getSelectedText();
    if (selected) {
      parts.push(`\nUser's currently selected text:\n${selected}`);
    }

    return parts.join("\n");
  };

  const handleImageAttach = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // data:image/png;base64,xxxx
        const match = result.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (match) {
          setAttachedImages((prev) => [
            ...prev,
            { data: match[2], mediaType: match[1], preview: result },
          ]);
        }
      };
      reader.readAsDataURL(file);
    }
    // Reset input so the same file can be re-selected
    e.target.value = "";
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const match = result.match(/^data:(image\/[^;]+);base64,(.+)$/);
          if (match) {
            setAttachedImages((prev) => [
              ...prev,
              { data: match[2], mediaType: match[1], preview: result },
            ]);
          }
        };
        reader.readAsDataURL(file);
      }
    }
  };

  const handleMcpToolCall = useCallback(
    async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<unknown> => {
      const parsed = parseClaudeToolName(toolName);
      if (!parsed) throw new Error(`Unknown tool: ${toolName}`);
      return await callTool(parsed.serverId, parsed.toolName, input);
    },
    [],
  );

  // Executor for the built-in write_document tool. Applies the AI's Markdown to
  // the live editor when it's available; otherwise queues it via pendingInsert
  // (mobile / offscreen), which Editor.tsx flushes once the view is focused.
  // Content protection: empty content is rejected so it can never wipe the doc.
  const handleWriteDocTool = useCallback(
    async (input: Record<string, unknown>): Promise<string> => {
      const content = typeof input.content === "string" ? input.content : "";
      const mode = typeof input.mode === "string" ? input.mode : "append";
      if (!content.trim()) {
        return "Error: `content` was empty. Provide the non-empty Markdown to write; nothing was changed.";
      }
      // Surface the edit as an approve/reject proposal and block here until the
      // user decides. Nothing touches the document unless they approve.
      const approved = await new Promise<boolean>((resolve) => {
        writeResolverRef.current = resolve;
        setWriteProposal({ content, mode });
      });
      writeResolverRef.current = null;
      setWriteProposal(null);
      if (!approved) {
        return "The user REVIEWED and REJECTED the proposed document edit. Nothing was written. Do not silently retry the same edit; ask what they'd like changed, or continue the conversation.";
      }
      // iOS: the CodeMirror view sits behind this full-screen overlay and is
      // non-focused, so a direct dispatch doesn't reliably apply the edit.
      // Mirror the manual insert buttons — queue via pendingInsert, close the
      // panel, and let Editor.tsx flush into the (now focused) editor.
      // (Same fix as the manual Replace/Append buttons, commit 756df07.)
      if (isIOS) {
        const pmode =
          mode === "replace_document"
            ? "replaceAll"
            : mode === "replace_selection"
              ? "replace"
              : "append";
        setPendingInsert({ text: content, mode: pmode });
        onClose();
        return `Queued ${content.length} characters to the document (mode: ${mode}); the editor reopened and applied it. Confirm briefly to the user.`;
      }
      let applied = false;
      let queued = false;
      switch (mode) {
        case "replace_document":
          applied = replaceDocument(content);
          if (!applied) {
            setPendingInsert({ text: content, mode: "replaceAll" });
            queued = true;
          }
          break;
        case "replace_selection":
          applied = replaceSelection(content);
          if (!applied) {
            setPendingInsert({ text: content, mode: "replace" });
            queued = true;
          }
          break;
        case "insert_at_cursor":
          applied = insertAtCursor(content);
          if (!applied) {
            // No cursor available offscreen — fall back to append.
            setPendingInsert({ text: content, mode: "append" });
            queued = true;
          }
          break;
        case "append":
        default:
          applied = appendToDoc(content);
          if (!applied) {
            setPendingInsert({ text: content, mode: "append" });
            queued = true;
          }
          break;
      }
      if (applied) {
        return `Done. Wrote ${content.length} characters to the document (mode: ${mode}). The user can undo with Cmd/Ctrl+Z.`;
      }
      if (queued) {
        return `Queued ${content.length} characters to be written to the document (mode: ${mode}); it will be applied when the editor is focused. Tell the user it has been queued.`;
      }
      return "Error: could not write to the document (no active editor).";
    },
    [
      replaceDocument,
      replaceSelection,
      insertAtCursor,
      appendToDoc,
      setPendingInsert,
      onClose,
    ],
  );

  // Unified tool dispatcher for the tool loop: handles the built-in
  // write_document locally and delegates everything else to MCP.
  const handleToolCall = useCallback(
    async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<unknown> => {
      if (toolName === WRITE_DOC_TOOL.name) return handleWriteDocTool(input);
      return handleMcpToolCall(toolName, input);
    },
    [handleWriteDocTool, handleMcpToolCall],
  );

  // Assemble the custom tool list + system prompt for a turn, based on which
  // capabilities are toggled on. Returns undefined tools when none apply so the
  // caller keeps the streaming (no-tool) path for ordinary chat.
  const buildTurnTools = (): {
    tools: CustomTool[] | undefined;
    system: string;
  } => {
    const list: CustomTool[] = [];
    let system = getSystemPrompt();
    // Always give the AI the ability to write into the open document; it decides
    // autonomously when to use it, and every edit is gated behind the user's
    // approve/reject card (handleWriteDocTool).
    if (activeDoc) {
      list.push(WRITE_DOC_TOOL);
      system += WRITE_DOC_SYSTEM_ADDENDUM;
    }
    if (mcpEnabled && mcpTools.length > 0) {
      list.push(...toClaudeTools(mcpTools));
    }
    return { tools: list.length > 0 ? list : undefined, system };
  };

  const handleImageGen = async () => {
    if (!user || !input.trim()) return;
    const prompt = input.trim();

    // Auto-create thread if none exists — otherwise the generated-image
    // messages are never persisted (auto-save requires an activeThreadId),
    // matching handleChat / handleAction.
    if (!activeThreadId && activeDocId) {
      const newThread: ChatThread = {
        id: crypto.randomUUID().slice(0, 8),
        title: prompt.slice(0, 40) || "Image",
        createdAt: Date.now(),
      };
      const newList = [...threads, newThread];
      setThreads(newList);
      setActiveThreadId(newThread.id);
      saveThreadList(activeDocId, newList);
    }

    setInput("");
    setGeneratingImage(true);

    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "user",
        content: `🎨 Generate image: ${prompt}`,
      },
    ]);

    try {
      // Build a detailed image prompt using Claude with document + conversation context
      let imagePrompt = prompt;
      {
        setToolStatus("Building image prompt from context...");
        const docContext = await buildContextPrefix();
        const contextMessages: ClaudeMessage[] = [
          ...(docContext
            ? [
                { role: "user" as const, content: docContext },
                {
                  role: "assistant" as const,
                  content: "I've read the document context.",
                },
              ]
            : []),
          ...apiMessages.slice(-10),
          {
            role: "user" as const,
            content: `Based on the document and conversation above, create a detailed image generation prompt for an AI image generator. The user's request is: "${prompt}"\n\nRespond with ONLY the image generation prompt (no explanation, no markdown, no quotes). The prompt should be detailed, specific, and in the language that best describes the visual content. Include style, composition, colors, and content details.`,
          },
        ];
        try {
          const detailedPrompt = await sendToClaude(
            "",
            "You are a prompt engineer for AI image generation. Convert user requests into detailed, specific image generation prompts. Use the document context to inform your prompts with relevant details.",
            contextMessages,
          );
          if (detailedPrompt.trim()) {
            imagePrompt = detailedPrompt.trim();
          }
        } catch {
          // Fall back to raw prompt if Claude fails
        }
      }

      setToolStatus("Generating image...");
      const result = await generateImage(imagePrompt, (status) =>
        setToolStatus(status),
      );
      setToolStatus(null);

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "Image generated:",
          generatedImage: { url: result.url, markdown: result.markdown },
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Image generation failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    } finally {
      setGeneratingImage(false);
      setToolStatus(null);
    }
  };

  const handleAction = async (actionId: string) => {
    if (!user || !activeDoc) return;
    const action = AI_ACTIONS.find((a) => a.id === actionId);
    if (!action) return;

    // Auto-create thread if none exists
    if (!activeThreadId && activeDocId) {
      const newThread: ChatThread = {
        id: crypto.randomUUID().slice(0, 8),
        title: action.label,
        createdAt: Date.now(),
      };
      const newList = [...threads, newThread];
      setThreads(newList);
      setActiveThreadId(newThread.id);
      saveThreadList(activeDocId, newList);
    }

    const selected = getSelectedText();
    const targetText = selected || stripHtml(activeDoc.content);
    if (!targetText.trim()) return;

    const displayLabel = selected
      ? `${action.label} (selection)`
      : `${action.label} (full document)`;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: displayLabel,
    };
    setMessages((prev) => [...prev, userMsg]);
    setStreaming(true);
    setStreamingText("");

    try {
      const { tools: turnTools, system: turnSystem } = buildTurnTools();
      let result: string;

      if (turnTools) {
        setToolStatus(null);
        result = await sendWithToolLoop(
          turnSystem,
          [{ role: "user", content: `${action.prompt}\n\n${targetText}` }],
          handleToolCall,
          (text) => setStreamingText(text),
          webSearch,
          turnTools,
          (status) => setToolStatus(status),
        );
        setToolStatus(null);
      } else {
        result = await sendToClaude(
          "",
          turnSystem,
          [{ role: "user", content: `${action.prompt}\n\n${targetText}` }],
          (text) => setStreamingText(text),
          webSearch,
        );
      }
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: result,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
        },
      ]);
    } finally {
      setStreaming(false);
      setStreamingText("");
      setToolStatus(null);
    }
  };

  const handleChat = async () => {
    if (!user || (!input.trim() && attachedImages.length === 0)) return;

    // Auto-create thread if none exists
    if (!activeThreadId && activeDocId) {
      const newThread: ChatThread = {
        id: crypto.randomUUID().slice(0, 8),
        title: input.trim().slice(0, 40) || "Chat",
        createdAt: Date.now(),
      };
      const newList = [...threads, newThread];
      setThreads(newList);
      setActiveThreadId(newThread.id);
      saveThreadList(activeDocId, newList);
    }

    const userInput = input.trim();
    setInput("");
    const images = [...attachedImages];
    setAttachedImages([]);

    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "user",
        content: userInput || "(image)",
        images:
          images.length > 0
            ? images.map((i) => ({ data: i.data, mediaType: i.mediaType }))
            : undefined,
      },
    ]);
    setStreaming(true);
    setStreamingText("");

    try {
      const isFirstMessage = apiMessages.length === 0;
      const context = await buildContextPrefix();

      // Build content blocks for multimodal
      const contentBlocks: ContentBlock[] = [];

      // Add images first
      for (const img of images) {
        contentBlocks.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.data },
        });
      }

      // Add text
      const textContent = isFirstMessage
        ? `${context}\n\nUser request: ${userInput}`
        : userInput;
      if (textContent) {
        contentBlocks.push({ type: "text", text: textContent });
      }

      const newApiMessages: ClaudeMessage[] = [
        ...apiMessages,
        {
          role: "user" as const,
          content: images.length > 0 ? contentBlocks : textContent,
        },
      ].slice(-20);

      const { tools: turnTools, system: turnSystem } = buildTurnTools();
      let result: string;

      if (turnTools) {
        setToolStatus(null);
        result = await sendWithToolLoop(
          turnSystem,
          newApiMessages,
          handleToolCall,
          (text) => setStreamingText(text),
          webSearch,
          turnTools,
          (status) => setToolStatus(status),
        );
        setToolStatus(null);
      } else {
        result = await sendToClaude(
          "",
          turnSystem,
          newApiMessages,
          (text) => setStreamingText(text),
          webSearch,
        );
      }

      setApiMessages([
        ...newApiMessages,
        { role: "assistant", content: result },
      ]);
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content: result },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
        },
      ]);
    } finally {
      setStreaming(false);
      setStreamingText("");
      setToolStatus(null);
    }
  };

  // Scroll to bottom within the ScrollArea viewport only
  const scrollToBottom = useCallback((instant?: boolean) => {
    const viewport = scrollAreaRef.current?.querySelector(
      "[data-slot='scroll-area-viewport']",
    );
    if (viewport) {
      viewport.scrollTo({
        top: viewport.scrollHeight,
        behavior: instant ? "instant" : "smooth",
      });
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (streamingText) scrollToBottom(true);
  }, [streamingText, scrollToBottom]);

  if (!user) {
    return (
      <div
        className={`flex h-full w-full flex-col bg-background ${isMobile ? "" : "border-l border-border"}`}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4" />
            <span className="text-sm font-medium">MarkFlow AI</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className={
              isMobile ? "h-11 w-11 cursor-pointer" : "h-6 w-6 cursor-pointer"
            }
            onClick={onClose}
          >
            <X className={isMobile ? "h-5 w-5" : "h-3.5 w-3.5"} />
          </Button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center p-4 space-y-3">
          <Bot className="h-10 w-10 text-muted-foreground" />
          <p className="text-xs text-muted-foreground text-center">
            Sign in with Google to use AI features.
          </p>
          <Button
            size="sm"
            onClick={signInWithGoogle}
            className="gap-2 cursor-pointer"
          >
            <LogIn className="h-3.5 w-3.5" />
            Sign in with Google
          </Button>
        </div>
      </div>
    );
  }

  const hasSelection = !!getSelectedText();

  // Header icon buttons: bigger tap targets on mobile (the toolbar wraps when
  // it runs out of width instead of pushing buttons off the right edge).
  const iconBtn = isMobile
    ? "h-10 w-10 shrink-0 cursor-pointer"
    : "h-6 w-6 cursor-pointer";
  const iconGlyph = isMobile ? "h-5 w-5" : "h-3.5 w-3.5";

  const renderMarkdown = (content: string) => (
    <ReactMarkdown
      // remark-cjk-friendly makes **bold**/_italic_ work when the delimiters sit
      // flush against CJK characters (e.g. これは**太字**です), which CommonMark
      // otherwise renders as literal asterisks.
      remarkPlugins={[remarkGfm, remarkCjkFriendly]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        pre: ({ node, ...props }) => (
          <pre
            className="bg-background/50 rounded p-2 overflow-x-auto max-w-full my-1 text-[11px]"
            {...props}
          />
        ),
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        code: ({ node, className, children, ...props }) => {
          const isInline = !className;
          return isInline ? (
            <code
              className="bg-background/50 rounded px-1 py-0.5 text-[11px]"
              {...props}
            >
              {children}
            </code>
          ) : (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        p: ({ node, ...props }) => (
          <p className="mb-1.5 last:mb-0" {...props} />
        ),
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        ul: ({ node, ...props }) => (
          <ul className="list-disc pl-4 mb-1.5" {...props} />
        ),
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        ol: ({ node, ...props }) => (
          <ol className="list-decimal pl-4 mb-1.5" {...props} />
        ),
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        h1: ({ node, ...props }) => (
          <h1 className="text-sm font-bold mb-1 mt-2" {...props} />
        ),
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        h2: ({ node, ...props }) => (
          <h2 className="text-xs font-bold mb-1 mt-2" {...props} />
        ),
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        h3: ({ node, ...props }) => (
          <h3 className="text-xs font-semibold mb-1 mt-1.5" {...props} />
        ),
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        blockquote: ({ node, ...props }) => (
          <blockquote
            className="border-l-2 border-border pl-2 text-muted-foreground italic my-1"
            {...props}
          />
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );

  return (
    <div
      className={`relative flex h-full w-full flex-col bg-background ${isMobile ? "" : "border-l border-border"}`}
    >
      {/* Custom Rules Editor (overlay) */}
      <RulesEditor
        open={rulesOpen}
        onClose={() => setRulesOpen(false)}
        rules={customRules}
        onSave={saveCustomRules}
      />
      {/* MCP Settings (overlay) */}
      {MCP_UI_ENABLED && (
        <McpSettings
          open={mcpSettingsOpen}
          onClose={() => setMcpSettingsOpen(false)}
          onToolsChanged={refreshMcpTools}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between gap-1 px-3 py-2 border-b border-border">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="h-4 w-4 shrink-0" />
          <span className="truncate text-sm font-medium">MarkFlow AI</span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5">
          <Button
            variant={webSearch ? "secondary" : "ghost"}
            size="icon"
            className={iconBtn}
            onClick={() => setWebSearch(!webSearch)}
            title={webSearch ? "Web search enabled" : "Enable web search"}
          >
            <Globe className={iconGlyph} />
          </Button>
          <Button
            variant={allDocsContext ? "secondary" : "ghost"}
            size="icon"
            className={iconBtn}
            onClick={() => setAllDocsContext(!allDocsContext)}
            title={
              allDocsContext
                ? "Using all documents as context"
                : "Using current document only"
            }
          >
            <BookOpen className={iconGlyph} />
          </Button>
          {MCP_UI_ENABLED && (
            <Button
              variant={
                mcpEnabled && mcpTools.length > 0 ? "secondary" : "ghost"
              }
              size="icon"
              className={iconBtn}
              onClick={() => {
                if (mcpTools.length > 0) {
                  setMcpEnabled(!mcpEnabled);
                } else {
                  setMcpSettingsOpen(true);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMcpSettingsOpen(true);
              }}
              title={
                mcpEnabled && mcpTools.length > 0
                  ? `MCP active (${mcpTools.length} tools) — right-click to configure`
                  : "MCP tools — click to configure"
              }
            >
              <Wrench className={iconGlyph} />
            </Button>
          )}
          <Button
            variant={customRules.trim() ? "secondary" : "ghost"}
            size="icon"
            className={iconBtn}
            onClick={() => setRulesOpen(true)}
            title={
              customRules.trim() ? "Custom rules active" : "Set custom AI rules"
            }
          >
            <Settings className={iconGlyph} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={iconBtn}
            onClick={createNewThread}
            title="New topic"
          >
            <Plus className={iconGlyph} />
          </Button>
          {activeThreadId && messages.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className={iconBtn}
              onClick={() => {
                if (activeThreadId) deleteThread(activeThreadId);
              }}
              title="Delete this topic"
            >
              <Trash2 className={iconGlyph} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={iconBtn}
            onClick={onClose}
          >
            <X className={iconGlyph} />
          </Button>
        </div>
      </div>

      {/* Thread selector bar */}
      {threads.length > 0 && (
        <div className="relative border-b border-border" ref={threadListRef}>
          <button
            className={cn(
              "w-full flex items-center gap-1.5 px-3 text-left hover:bg-accent/50 transition-colors",
              isMobile ? "py-2.5 text-xs" : "py-1.5 text-[11px]",
            )}
            onClick={() => setThreadListOpen(!threadListOpen)}
          >
            <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate font-medium">
              {threads.find((t) => t.id === activeThreadId)?.title ||
                "Select topic"}
            </span>
            <span className="text-[9px] text-muted-foreground">
              {threads.length}
            </span>
            <ChevronDown
              className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${threadListOpen ? "rotate-180" : ""}`}
            />
          </button>
          {threadListOpen && (
            <div className="absolute inset-x-0 top-full z-30 bg-popover border border-border rounded-b-md shadow-lg max-h-48 overflow-y-auto">
              {threads.map((t) => (
                <div
                  key={t.id}
                  className={cn(
                    "flex items-center gap-1.5 px-3 cursor-pointer group transition-colors",
                    isMobile ? "py-2.5 text-xs" : "py-1.5 text-[11px]",
                    t.id === activeThreadId
                      ? "bg-accent"
                      : "hover:bg-accent/50",
                  )}
                  onClick={() => switchThread(t.id)}
                >
                  <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{t.title}</span>
                  <span className="text-[9px] text-muted-foreground">
                    {new Date(t.createdAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  <button
                    className={cn(
                      "shrink-0 transition-opacity hover:opacity-100!",
                      isMobile
                        ? "opacity-70 p-1.5"
                        : "opacity-0 group-hover:opacity-60 p-0.5",
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteThread(t.id);
                    }}
                    title="Delete topic"
                  >
                    <Trash2
                      className={cn(
                        "text-muted-foreground hover:text-destructive",
                        isMobile ? "h-4 w-4" : "h-3 w-3",
                      )}
                    />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Quick actions */}
      <div className="p-2 space-y-1">
        <p className="px-1 text-[10px] text-muted-foreground uppercase tracking-wider">
          Quick Actions {hasSelection ? "(on selection)" : "(on document)"}
        </p>
        <div className="grid grid-cols-2 gap-1">
          {AI_ACTIONS.map((action) => {
            const Icon = iconMap[action.icon] || Sparkles;
            return (
              <Button
                key={action.id}
                variant="ghost"
                size="sm"
                className="justify-start gap-1.5 text-[11px] h-7 cursor-pointer"
                onClick={() => handleAction(action.id)}
                disabled={streaming || !activeDoc}
              >
                <Icon className="h-3 w-3 shrink-0" />
                {action.label}
              </Button>
            );
          })}
        </div>
      </div>

      <Separator />

      {/* Status indicators */}
      {(allDocsContext ||
        webSearch ||
        (mcpEnabled && mcpTools.length > 0) ||
        toolStatus) && (
        <div className="px-3 py-1 bg-accent/50 text-[10px] text-muted-foreground flex items-center gap-2 flex-wrap">
          {allDocsContext && (
            <span className="flex items-center gap-1">
              <BookOpen className="h-3 w-3" />
              {documents.length} docs
            </span>
          )}
          {webSearch && (
            <span className="flex items-center gap-1">
              <Globe className="h-3 w-3" />
              Web search
            </span>
          )}
          {mcpEnabled && mcpTools.length > 0 && (
            <span className="flex items-center gap-1">
              <Wrench className="h-3 w-3" />
              {mcpTools.length} tools
            </span>
          )}
          {toolStatus && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
              ⚡ {toolStatus}
            </span>
          )}
        </div>
      )}

      {/* Messages */}
      <ScrollArea
        ref={scrollAreaRef}
        className="ai-panel-scroll flex-1 min-h-0 p-3"
      >
        <div className="space-y-3">
          {messages.length === 0 && !streaming && (
            <p className="text-xs text-muted-foreground text-center py-8">
              Use quick actions or chat below.
              <br />
              <span className="text-[10px]">Cmd+Enter to send</span>
            </p>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`text-xs ${
                msg.role === "user" ? "text-right" : "bg-muted rounded-md p-2"
              }`}
            >
              {msg.role === "assistant" && (
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-muted-foreground">
                    MarkFlow AI
                  </span>
                  <div className="flex gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 cursor-pointer"
                      onClick={() =>
                        navigator.clipboard.writeText(
                          msg.generatedImage?.markdown || msg.content,
                        )
                      }
                      title="Copy raw text"
                    >
                      <Copy className="h-2.5 w-2.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 cursor-pointer"
                      onClick={() => {
                        const text =
                          msg.generatedImage?.markdown || msg.content;
                        if (isIOS) {
                          setPendingInsert({ text, mode: "replace" });
                          onClose();
                        } else if (!replaceSelection(text)) {
                          alert(
                            "エディタが利用できません。エディタ表示に切り替えてください。",
                          );
                        }
                      }}
                      title={
                        isIOS
                          ? "Insert and return to editor"
                          : "Replace selection / Insert at cursor"
                      }
                    >
                      <Replace className="h-2.5 w-2.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 cursor-pointer"
                      onClick={() => {
                        const text =
                          msg.generatedImage?.markdown || msg.content;
                        if (isIOS) {
                          setPendingInsert({ text, mode: "append" });
                          onClose();
                        } else if (!appendToDoc(text)) {
                          alert(
                            "エディタが利用できません。エディタ表示に切り替えてください。",
                          );
                        }
                      }}
                      title={
                        isIOS
                          ? "Append and return to editor"
                          : "Append to document"
                      }
                    >
                      <CornerDownLeft className="h-2.5 w-2.5" />
                    </Button>
                  </div>
                </div>
              )}
              <div className="leading-relaxed">
                {msg.role === "user" ? (
                  <div className="inline-block text-left">
                    {msg.images && msg.images.length > 0 && (
                      <div className="flex gap-1 justify-end mb-1">
                        {msg.images.map((img, i) => (
                          <img
                            key={i}
                            src={`data:${img.mediaType};base64,${img.data}`}
                            alt=""
                            className="h-16 w-16 object-cover rounded"
                          />
                        ))}
                      </div>
                    )}
                    <span className="inline-block bg-primary text-primary-foreground rounded-md px-2 py-1 select-text">
                      {msg.content}
                    </span>
                  </div>
                ) : (
                  <div className="prose ai-markdown select-text">
                    {renderMarkdown(msg.content)}
                    {msg.generatedImage && (
                      <div className="mt-2 space-y-2">
                        <img
                          src={msg.generatedImage.url}
                          alt=""
                          className="max-w-full max-h-48 rounded-md border border-border"
                        />
                        <div className="flex gap-1">
                          <Button
                            variant="secondary"
                            size="sm"
                            className="text-[10px] h-6 gap-1 cursor-pointer"
                            onClick={() => {
                              if (isIOS) {
                                setPendingInsert({
                                  text: msg.generatedImage!.markdown,
                                  mode: "replace",
                                });
                                onClose();
                              } else if (
                                !insertAtCursor(msg.generatedImage!.markdown)
                              ) {
                                appendToDoc(msg.generatedImage!.markdown);
                              }
                            }}
                          >
                            <CornerDownLeft className="h-2.5 w-2.5" />
                            Insert at cursor
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-[10px] h-6 gap-1 cursor-pointer"
                            onClick={() =>
                              navigator.clipboard.writeText(
                                msg.generatedImage!.markdown,
                              )
                            }
                          >
                            <Copy className="h-2.5 w-2.5" />
                            Copy markdown
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          {/* Write-to-document proposal — the AI decided to edit the doc; apply
              only on explicit approval. */}
          {writeProposal && (
            <div className="rounded-md border border-primary/40 bg-primary/5 p-2 text-xs">
              <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
                <FileText className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span>AIがドキュメントを編集しようとしています</span>
              </div>
              <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                {WRITE_MODE_LABELS[writeProposal.mode] || writeProposal.mode}
              </div>
              <pre className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 text-[11px] leading-snug">
                {writeProposal.content}
              </pre>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className={cn(
                    "flex-1 gap-1 cursor-pointer",
                    isMobile ? "h-9 text-sm" : "h-7 text-xs",
                  )}
                  onClick={() => writeResolverRef.current?.(true)}
                >
                  <Check className={isMobile ? "h-4 w-4" : "h-3 w-3"} />
                  承認
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "flex-1 gap-1 cursor-pointer",
                    isMobile ? "h-9 text-sm" : "h-7 text-xs",
                  )}
                  onClick={() => writeResolverRef.current?.(false)}
                >
                  <X className={isMobile ? "h-4 w-4" : "h-3 w-3"} />
                  拒否
                </Button>
              </div>
            </div>
          )}
          {/* Thinking / loading indicator */}
          {(streaming || generatingImage) &&
            !streamingText &&
            !writeProposal && (
              <div className="text-xs bg-muted rounded-md p-2">
                <div className="flex items-center gap-2">
                  <div className="flex gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce [animation-delay:300ms]" />
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {toolStatus ||
                      (generatingImage ? "Generating image..." : "Thinking...")}
                  </span>
                </div>
              </div>
            )}
          {streaming && streamingText && (
            <div className="text-xs bg-muted rounded-md p-2">
              <span className="text-[10px] text-muted-foreground">
                MarkFlow AI
              </span>
              <div className="leading-relaxed mt-1 prose ai-markdown select-text">
                {renderMarkdown(streamingText)}
                <span className="animate-pulse">|</span>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Attached images preview */}
      {attachedImages.length > 0 && (
        <div className="border-t border-border px-2 py-1 flex gap-1 items-center">
          {attachedImages.map((img, i) => (
            <div key={i} className="relative group">
              <img
                src={img.preview}
                alt=""
                className="h-10 w-10 object-cover rounded border border-border"
              />
              <button
                className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-[8px] opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() =>
                  setAttachedImages((prev) => prev.filter((_, j) => j !== i))
                }
              >
                x
              </button>
            </div>
          ))}
          <span className="text-[10px] text-muted-foreground ml-1">
            <ImageIcon className="h-3 w-3 inline" /> {attachedImages.length}
          </span>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Input — textarea, Cmd+Enter to send */}
      <div
        className={cn(
          "border-t border-border",
          // iOS: keep the home-indicator safe-area padding only when the
          // keyboard is DOWN. With the keyboard up there's no indicator, so the
          // padding would open a phantom gap under the field.
          isIOS
            ? keyboardVisible
              ? "pt-2 pb-2 px-5"
              : "pt-2 pb-7 px-5"
            : "p-2",
        )}
      >
        <div className={cn("flex items-end", isMobile ? "gap-1.5" : "gap-1")}>
          <Button
            variant="ghost"
            size="icon"
            // All three input-row buttons are the SAME compact square (h-9 w-9
            // on mobile) so the row reads as one tidy unit and the textarea no
            // longer has to match a tall 44px control.
            className={cn(
              "shrink-0 cursor-pointer",
              isMobile ? "h-9 w-9" : "h-7 w-7",
            )}
            onClick={handleImageAttach}
            disabled={streaming || generatingImage}
            title="Attach image"
          >
            <Paperclip className={isMobile ? "h-5 w-5" : "h-3.5 w-3.5"} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "shrink-0 cursor-pointer",
              isMobile ? "h-9 w-9" : "h-7 w-7",
              // Tint the wand when it's actionable so its AI-image-generation
              // role is discoverable (touch has no hover tooltip).
              input.trim() && !streaming && !generatingImage
                ? "text-primary"
                : "",
            )}
            onClick={handleImageGen}
            disabled={streaming || generatingImage || !input.trim()}
            title="Generate AI image from prompt"
          >
            <WandSparkles className={isMobile ? "h-5 w-5" : "h-3.5 w-3.5"} />
          </Button>
          <textarea
            ref={textareaRef}
            placeholder={
              isMobile
                ? "Ask about your document..."
                : "Ask about your document... (Cmd+Enter)"
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) {
                e.preventDefault();
                handleChat();
              }
            }}
            onPaste={handlePaste}
            rows={1}
            disabled={streaming}
            className={cn(
              "flex-1 rounded-md border border-input bg-background outline-none focus:ring-1 focus:ring-ring resize-none select-text [&::-webkit-scrollbar]:w-[3px] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border",
              // Mobile: min-h matches the compact 36px buttons and text-base
              // (16px) prevents iOS focus-zoom. Desktop keeps the compact sizing.
              isMobile
                ? "min-h-9 px-3 py-1.5 text-base leading-tight"
                : "px-2 py-1.5 text-xs",
            )}
          />
          <Button
            size="icon"
            className={cn(
              "shrink-0 cursor-pointer",
              isMobile ? "h-9 w-9" : "h-7 w-7",
            )}
            onClick={handleChat}
            disabled={
              streaming ||
              generatingImage ||
              (!input.trim() && attachedImages.length === 0)
            }
          >
            <Send className={isMobile ? "h-5 w-5" : "h-3.5 w-3.5"} />
          </Button>
        </div>
      </div>
    </div>
  );
}
