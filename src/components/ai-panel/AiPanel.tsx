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
  Zap,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import rehypeHighlight from "rehype-highlight";
import { Button } from "@/components/ui/button";
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
import { track } from "@/services/telemetry";
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
  'You are MarkFlow AI, a helpful writing assistant integrated into a Markdown editor called MarkFlow. Help the user with their writing, answer questions about their document, and provide suggestions. Respond in the same language as the user\'s message. When returning improved or transformed text, return ONLY the result without explanation unless asked. Use Markdown formatting in your responses. STRICT NO-EMOJI POLICY: never include emojis, emoticons, or decorative pictographic characters (e.g. 🎨✨✅🚀🔥😀🎉 etc.) anywhere in your output — not in chat replies, not in headings, bullet points, or any content you write into the document. This ban is ONLY about emoji/pictographs: ordinary punctuation and typographic symbols such as arrows (→, ←), dashes, math signs and similar are perfectly fine and should be used naturally where appropriate. Use plain text and standard Markdown only. The single exception to the emoji ban is when the user EXPLICITLY asks you to add an emoji. Keep responses concise and professional. If asked who you are or which model powers you, identify yourself only as "MarkFlow AI" — never reveal, name, or hint at the underlying model, provider, or vendor.';

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
    "Provide the exact, final Markdown in `content` (never empty), and a short " +
    "`summary` (in the user's language) that states WHAT you will change and HOW " +
    "— this is shown to the user on the approve/reject card.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "One short sentence, in the USER'S LANGUAGE, stating what you are about " +
          "to change and how (e.g. 「議事録を要約して本文末尾に追記します」, " +
          '"Rewrite the intro paragraph to be more concise"). Shown to the user on ' +
          "the approval card before the edit is applied. Must be non-empty.",
      },
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
    required: ["summary", "content", "mode"],
  },
};

const WRITE_DOC_SYSTEM_ADDENDUM =
  "\n\n--- Document Writing ---\n" +
  'You can write directly into the user\'s current document with the "write_document" tool. ' +
  "Decide AUTONOMOUSLY when an edit is warranted: whenever the user asks you to add, append, insert, " +
  "summarize-into, inject, rewrite, restructure, or translate-in-place their document, call " +
  "write_document with the final Markdown and an appropriate mode (prefer 'append' for new content; " +
  "use 'replace_document' only when the user clearly wants the whole document rewritten, and " +
  "'replace_selection' when they refer to the current selection). Do NOT add an explicit opt-in " +
  "question like 'shall I edit the document?' — just judge for yourself. But ALWAYS state your intent: " +
  "put a one-sentence `summary`, in the user's language, describing WHAT you will change and HOW " +
  "(e.g. 「会議メモを3点に要約して本文末尾に追記します」). The user reviews every write with an " +
  "approve/reject card (your summary is shown on it) before anything is applied, so you never need to " +
  "ask first — but the summary is REQUIRED so they know exactly what they're approving. After the tool " +
  "returns, briefly confirm the outcome in the user's language (and if they rejected it, acknowledge " +
  "that and ask what to adjust — do NOT silently re-apply the same edit). For questions the user only " +
  "wants answered in chat, do NOT call the tool — just reply normally.";

// Built-in tool that lets the AI generate an image from a text prompt during a
// chat turn (e.g. "まとめと、生成したアイキャッチ画像をドキュメント末尾に追記して").
// Without this the AI could only write text and had no way to produce/embed an
// image mid-conversation — image generation was a separate manual button. The
// tool generates the image, uploads it to Firebase Storage, and RETURNS ready-to-
// embed Markdown (`![alt](url)`) so the AI can include it in a following
// write_document call (or show it in chat). Metering is enforced server-side.
const GENERATE_IMAGE_TOOL: CustomTool = {
  name: "generate_image",
  description:
    "Generate a NEW image from a text prompt using MarkFlow's AI image generator. " +
    "Each successful call consumes one of the user's image credits, so only call it " +
    "when the user CLEARLY and EXPLICITLY asks you to create/generate/draw/make an " +
    'image, illustration, eyecatch, or thumbnail (e.g. "アイキャッチ画像を生成して", ' +
    '"この内容に合う画像を作って", "generate an image of..."). Do NOT call it for ' +
    "how-to or informational questions that merely mention images (e.g. " +
    '"how do I add an image in Markdown?", "画像ってどうやって入れるの?"), and do NOT ' +
    "call it to reference or re-insert an image that already exists — answer those in " +
    "chat instead. " +
    "On success the image is uploaded and shown in the chat, and this tool returns a " +
    "short PLACEHOLDER TOKEN (not a URL). " +
    "IMPORTANT: if the user wanted the image placed in their document, call " +
    "write_document and put that placeholder token verbatim into `content` where the " +
    "image should appear (it is swapped for the real image automatically). Never write " +
    "out an image URL yourself. If the user only wanted to see it, just reply — the " +
    "image is already shown in the chat. " +
    "Provide a DETAILED, specific, descriptive prompt (subject, style, composition, " +
    "colors, mood) — terse prompts like 'a circle' are often declined by the model.",
  input_schema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "A detailed, specific description of the image to generate. Include " +
          "subject, style, composition, colors, and mood. Draw on the document " +
          "and conversation context. Must be non-empty.",
      },
    },
    required: ["prompt"],
  },
};

const GENERATE_IMAGE_SYSTEM_ADDENDUM =
  "\n\n--- Image Generation ---\n" +
  'You can generate images with the "generate_image" tool, but ONLY when the user clearly and ' +
  "explicitly asks you to create/generate/draw/make an image, illustration, eyecatch, or thumbnail " +
  "— each successful generation spends one of the user's image credits, so never call it for " +
  "how-to questions that merely mention images, or to reference an image that already exists. " +
  "Call generate_image with a detailed descriptive prompt. On success it uploads the image, shows " +
  "it in the chat, and returns a short PLACEHOLDER TOKEN (like [[MARKFLOW_IMAGE_1]]) — never a URL. " +
  "If the user wants the image in their document (e.g. 「末尾に追記して」), call write_document and put " +
  "that placeholder token verbatim into `content` where the image belongs (combined with any text " +
  "they asked for, such as a summary); the token is swapped for the real image automatically. NEVER " +
  "write out an image URL yourself. If a single request asks for BOTH text (a summary, notes) AND an " +
  "image, generate the image first, then make ONE write_document call whose content contains both " +
  "the text and the placeholder token. If the user only wanted to SEE the image, do NOT call " +
  "write_document and do NOT repeat the token in chat — the image is already displayed. If the model " +
  "declines a prompt, tell the user and retry with a more specific, descriptive prompt.";

// generate_image hands the model a [[MARKFLOW_IMAGE_n]] placeholder token for
// embedding via write_document. If the model instead echoes that token into its
// chat reply, strip it so the user never sees a raw token (the image is already
// shown as a preview card). Also collapses the blank line a lone token leaves.
const IMAGE_PLACEHOLDER_RE = /[ \t]*\[\[MARKFLOW_IMAGE_\d+\]\][ \t]*/g;
function stripImagePlaceholders(text: string): string {
  if (!text.includes("[[MARKFLOW_IMAGE_")) return text;
  return text
    .replace(IMAGE_PLACEHOLDER_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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
  // Track textarea focus so mobile can collapse the quick-actions / topic bar
  // and give the message list + input row more room while typing.
  const [inputFocused, setInputFocused] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [allDocsContext, setAllDocsContext] = useState(false);
  // Web search defaults ON — most questions benefit from up-to-date grounding.
  const [webSearch, setWebSearch] = useState(true);
  // Document editing has NO manual toggle. In chat the AI decides autonomously
  // whether an edit is warranted (the write_document tool is always offered) and
  // states what/how it will edit; the user then approves or rejects it on the
  // card below. Quick actions still NEVER write (they pass allowWrite:false).
  // Pending write proposal: when the AI decides to edit the document via the
  // write_document tool, the edit is held here and shown as an approve/reject
  // card. `summary` is the AI's own statement of what/how. `writeResolverRef`
  // unblocks the awaiting tool executor on the choice.
  const [writeProposal, setWriteProposal] = useState<{
    summary: string;
    content: string;
    mode: string;
  } | null>(null);
  const writeResolverRef = useRef<((approved: boolean) => void) | null>(null);
  // generate_image returns a short, stable PLACEHOLDER token to the model (never
  // the raw Firebase URL) and stores placeholder → real Markdown here. When the
  // model later calls write_document, handleWriteDocTool substitutes the tokens
  // back to the real `![alt](url)` before writing. This means the long, opaque,
  // percent-encoded image URL never round-trips through the LLM — eliminating the
  // "one wrong character → permanently embedded 404 image" failure mode — and the
  // model can't accidentally paste the URL into a chat reply and double-render the
  // image (the preview card already shows it).
  const imagePlaceholdersRef = useRef<Map<string, string>>(new Map());
  const imagePlaceholderSeqRef = useRef(0);
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
      const rawContent = typeof input.content === "string" ? input.content : "";
      const mode = typeof input.mode === "string" ? input.mode : "append";
      const summary =
        typeof input.summary === "string" ? input.summary.trim() : "";
      // Resolve any generate_image placeholder tokens back to the real
      // `![alt](url)` Markdown. The model only ever sees/echoes the opaque token,
      // so this is the single point where the true image URL enters the document
      // — no transcription risk. Unknown tokens are left as-is (harmless text).
      let content = rawContent;
      if (
        imagePlaceholdersRef.current.size > 0 &&
        content.includes("[[MARKFLOW_IMAGE_")
      ) {
        for (const [token, markdown] of imagePlaceholdersRef.current) {
          content = content.split(token).join(markdown);
        }
      }
      if (!content.trim()) {
        return "Error: `content` was empty. Provide the non-empty Markdown to write; nothing was changed.";
      }
      // Surface the edit as an approve/reject proposal and block here until the
      // user decides. Nothing touches the document unless they approve. The
      // summary (the AI's stated intent) is shown on the card.
      const approved = await new Promise<boolean>((resolve) => {
        writeResolverRef.current = resolve;
        setWriteProposal({ summary, content, mode });
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

  // Executor for the built-in generate_image tool. Generates an image from the
  // AI's prompt, uploads it to Firebase Storage, shows it in the chat, and
  // returns the ready-to-embed Markdown so the AI can include it in a following
  // write_document call. Returns a plain (non-throwing) message on decline so the
  // tool loop keeps going and the AI can retry with a better prompt.
  const handleGenerateImageTool = useCallback(
    async (input: Record<string, unknown>): Promise<string> => {
      const prompt =
        typeof input.prompt === "string" ? input.prompt.trim() : "";
      if (!prompt) {
        return "Error: `prompt` was empty. Provide a detailed image description; nothing was generated.";
      }
      try {
        setToolStatus("Generating image...");
        const result = await generateImage(prompt, (status) =>
          setToolStatus(status),
        );
        setToolStatus(null);
        // Show the generated image in chat so the user sees it immediately,
        // mirroring the manual image button's UX.
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "Image generated:",
            generatedImage: { url: result.url, markdown: result.markdown },
          },
        ]);
        // Hand the model a short PLACEHOLDER token instead of the real URL. The
        // token is substituted back to `result.markdown` at write time
        // (handleWriteDocTool), so the opaque URL never passes through the LLM.
        const token = `[[MARKFLOW_IMAGE_${++imagePlaceholderSeqRef.current}]]`;
        imagePlaceholdersRef.current.set(token, result.markdown);
        return (
          "Image generated and uploaded, and it is already shown in the chat. " +
          "To place it in the user's document, call write_document and put this " +
          "EXACT placeholder token on its own line where the image should go: " +
          token +
          " — do NOT write out any URL or invent Markdown; the token is replaced " +
          "with the real image automatically when the document is written. " +
          "If the user only wanted to see the image (not add it to the document), " +
          "do NOT call write_document and do NOT repeat the token — just reply " +
          "briefly in chat, since the image is already displayed above."
        );
      } catch (err) {
        setToolStatus(null);
        // The model declined this prompt (recitation/safety) — tell the AI to
        // retry more descriptively rather than failing the whole turn.
        if (err instanceof Error && err.name === "ImagePromptDeclined") {
          return `The image model declined this prompt (${err.message}). Retry generate_image with a more specific, descriptive, original prompt (subject, style, composition, colors).`;
        }
        const detail = err instanceof Error ? err.message : String(err);
        return `Error: image generation failed (${detail}). You may tell the user it failed, or retry with a different prompt.`;
      }
    },
    [],
  );

  // Unified tool dispatcher for the tool loop: handles the built-in
  // write_document / generate_image locally and delegates everything else to MCP.
  const handleToolCall = useCallback(
    async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<unknown> => {
      if (toolName === WRITE_DOC_TOOL.name) return handleWriteDocTool(input);
      if (toolName === GENERATE_IMAGE_TOOL.name)
        return handleGenerateImageTool(input);
      return handleMcpToolCall(toolName, input);
    },
    [handleWriteDocTool, handleGenerateImageTool, handleMcpToolCall],
  );

  // Assemble the custom tool list + system prompt for a turn, based on which
  // capabilities are toggled on. Returns undefined tools when none apply so the
  // caller keeps the streaming (no-tool) path for ordinary chat.
  const buildTurnTools = (opts?: {
    allowWrite?: boolean;
  }): {
    tools: CustomTool[] | undefined;
    system: string;
  } => {
    const list: CustomTool[] = [];
    let system = getSystemPrompt();
    // The write_document tool is offered to CHAT (allowWrite:true) so the AI can
    // autonomously decide to edit when the user's request calls for it. Quick
    // actions pass allowWrite:false so they can never edit the document — their
    // result is applied only via the manual Replace/Append buttons. Every write
    // is still gated behind the approve/reject card (handleWriteDocTool).
    if (activeDoc && opts?.allowWrite) {
      list.push(WRITE_DOC_TOOL);
      system += WRITE_DOC_SYSTEM_ADDENDUM;
      // Offer image generation alongside writing so the AI can fulfil combined
      // requests ("summarize AND add a generated eyecatch image to the doc") in
      // one turn: generate_image returns embeddable Markdown, write_document
      // places it. Gated to the same chat path as write_document.
      list.push(GENERATE_IMAGE_TOOL);
      system += GENERATE_IMAGE_SYSTEM_ADDENDUM;
    }
    if (mcpEnabled && mcpTools.length > 0) {
      list.push(...toClaudeTools(mcpTools));
    }
    return { tools: list.length > 0 ? list : undefined, system };
  };

  // Surface AI failures with a friendly, localized message — NEVER the raw error
  // string, which can leak model/provider/endpoint/stack details (security). The
  // real detail goes only to the console and telemetry for debugging.
  const pushFriendlyError = (
    where: "chat" | "quick_action" | "image_gen",
    err: unknown,
  ) => {
    // A user-initiated abort (stop button / unmount) isn't a failure.
    if (err instanceof DOMException && err.name === "AbortError") return;
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[AiPanel] ${where} failed:`, detail);
    track("ai_error", { where, detail: detail.slice(0, 300) });
    let friendly: string;
    if (detail.includes("quota_exceeded")) {
      friendly =
        "AIの利用回数が上限に達しました。プランをご確認のうえ、時間をおいて再度お試しください。";
    } else if (where === "image_gen") {
      // The model declined this specific prompt (recitation/safety) — tell the
      // user to rephrase rather than implying a system failure.
      friendly =
        err instanceof Error && err.name === "ImagePromptDeclined"
          ? "このプロンプトでは画像を生成できませんでした。より具体的で独自性のある表現に変えて、もう一度お試しください。"
          : "画像の生成に失敗しました。もう一度お試しください。";
    } else {
      friendly = "AIの応答に失敗しました。もう一度お試しください。";
    }
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "assistant", content: friendly },
    ]);
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
        content: `Generate image: ${prompt}`,
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
      pushFriendlyError("image_gen", err);
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
      // Quick actions never edit the document — the user applies the result via
      // the Replace/Append buttons on the answer instead.
      const { tools: turnTools, system: turnSystem } = buildTurnTools({
        allowWrite: false,
      });
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
      pushFriendlyError("quick_action", err);
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

      // Chat always offers the write_document tool; the AI decides on its own
      // whether to edit, and every edit is confirmed on the approve/reject card.
      const { tools: turnTools, system: turnSystem } = buildTurnTools({
        allowWrite: true,
      });
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

      // Strip any [[MARKFLOW_IMAGE_n]] placeholder the model may have echoed into
      // its reply — it's only meant to travel to write_document, never to the user.
      const displayResult = stripImagePlaceholders(result);
      setApiMessages([
        ...newApiMessages,
        { role: "assistant", content: displayResult },
      ]);
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content: displayResult },
      ]);
    } catch (err) {
      pushFriendlyError("chat", err);
    } finally {
      setStreaming(false);
      setStreamingText("");
      setToolStatus(null);
    }
  };

  // Scroll to bottom within the native scroll container only
  const scrollToBottom = useCallback((instant?: boolean) => {
    const viewport = scrollAreaRef.current;
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

  // The keyboard shrinks the scroll viewport; re-pin the latest message above it
  // so the newest content stays visible instead of hiding behind the keyboard.
  useEffect(() => {
    if (keyboardVisible) scrollToBottom(true);
  }, [keyboardVisible, scrollToBottom]);

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

  // On mobile, while the input is focused (iOS = keyboardVisible; Android/Web =
  // inputFocused) collapse the quick-actions and topic-selector bars so the
  // message list + input row get the full height. The outer overlay height is
  // fixed by App.tsx, so the reclaimed space flows into the flex-1 ScrollArea —
  // this does not affect the ISSUE-2 keyboard geometry.
  const collapseForKeyboard = isMobile && (keyboardVisible || inputFocused);

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
            // Touch has no hover tooltip and the `secondary` tint is nearly
            // invisible next to the other ghost icons, so on mobile give the ON
            // state a solid primary fill + ring — otherwise users assume web
            // search is OFF (it defaults ON) and tap it, turning it off.
            className={cn(
              iconBtn,
              isMobile &&
                webSearch &&
                "bg-primary text-primary-foreground hover:bg-primary/90 ring-1 ring-primary",
            )}
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
      {threads.length > 0 && !collapseForKeyboard && (
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

      {/* Quick actions — hidden while typing on mobile to free up height. */}
      {!collapseForKeyboard && (
        <>
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
        </>
      )}

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
            <span
              className={cn(
                "flex items-center gap-1",
                isMobile && "font-medium text-primary",
              )}
            >
              <Globe className="h-3 w-3" />
              Web search{isMobile ? " ON" : ""}
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
              <Zap className="h-3 w-3" /> {toolStatus}
            </span>
          )}
        </div>
      )}

      {/* Messages — native overflow scroll so touch-scroll works inside the
          mobile WebView and stays contained (never drags the outer UI frame). */}
      <div
        ref={scrollAreaRef}
        className="ai-panel-scroll min-h-0 flex-1 overflow-y-auto p-3"
        style={{
          WebkitOverflowScrolling: "touch",
          overscrollBehavior: "contain",
        }}
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
              {writeProposal.summary && (
                <p className="mb-2 text-[11px] leading-snug text-foreground/90">
                  {writeProposal.summary}
                </p>
              )}
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
      </div>

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
            : isMobile
              ? "px-2 pt-2"
              : "p-2",
        )}
        // Android: lift the input row above the OS navigation bar. When the
        // keyboard is up the keyboard covers the nav bar, so the nav-bar inset
        // would open a phantom gap between the field and the keyboard top —
        // drop it to the base padding then. iOS handles this via its own pb-*
        // branch above; desktop needs no inset.
        style={
          !isIOS && isMobile
            ? {
                paddingBottom: keyboardVisible
                  ? "0.5rem"
                  : "max(var(--safe-area-bottom), 0.5rem)",
              }
            : undefined
        }
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
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
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
