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
  Wrench,
  Wand2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { useEditorStore } from "@/stores/editor-store";
import { signInWithGoogle } from "@/services/firebase";
import { isIOS } from "@/platform";
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
  "You are a helpful writing assistant integrated into a Markdown editor called MarkFlow. Help the user with their writing, answer questions about their document, and provide suggestions. Respond in the same language as the user's message. When returning improved or transformed text, return ONLY the result without explanation unless asked. Use Markdown formatting in your responses. Do NOT use emojis in your responses unless the user explicitly asks for them. Keep responses concise and professional.";

interface AiPanelProps {
  onClose: () => void;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: { data: string; mediaType: string }[];
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
  useEffect(() => { if (open) setDraft(rules); }, [open, rules]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium">AI Custom Rules</span>
        <Button variant="ghost" size="icon" className="h-6 w-6 cursor-pointer" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex-1 p-3 flex flex-col gap-2 min-h-0">
        <p className="text-[10px] text-muted-foreground">
          Custom instructions that are always included in the system prompt. Example: "Always respond in Japanese." or "Use bullet points for all answers."
        </p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Enter custom instructions for the AI..."
          className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring resize-none select-text"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" className="text-xs cursor-pointer" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" className="text-xs cursor-pointer" onClick={() => { onSave(draft); onClose(); }}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AiPanel({ onClose }: AiPanelProps) {
  const { activeDocId, documents } = useAppStore();
  const user = useAuthStore((s) => s.user);
  const activeDoc = documents.find((d) => d.id === activeDocId);
  const { getSelectedText, replaceSelection, appendToDoc, insertAtCursor } = useEditorStore();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [apiMessages, setApiMessages] = useState<ClaudeMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [allDocsContext, setAllDocsContext] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [customRules, setCustomRules] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [attachedImages, setAttachedImages] = useState<{ data: string; mediaType: string; preview: string }[]>([]);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [mcpTools, setMcpTools] = useState<McpTool[]>([]);
  const [mcpSettingsOpen, setMcpSettingsOpen] = useState(false);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [generatingImage, setGeneratingImage] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevDocIdRef = useRef<string | null>(null);

  // Load custom rules from DB on mount
  useEffect(() => {
    db.getSetting("ai_custom_rules").then((val) => {
      if (val) setCustomRules(val);
    }).catch(() => {});
  }, []);

  // Auto-connect MCP servers on mount
  useEffect(() => {
    loadMcpConfigs().then(async (configs) => {
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
    }).catch(() => {});
  }, []);

  const refreshMcpTools = useCallback(() => {
    setMcpTools(getAllTools());
  }, []);

  const saveCustomRules = useCallback((rules: string) => {
    setCustomRules(rules);
    db.setSetting("ai_custom_rules", rules).catch(() => {});
  }, []);

  // Reset conversation on document switch
  useEffect(() => {
    if (
      prevDocIdRef.current !== null &&
      prevDocIdRef.current !== activeDocId
    ) {
      setMessages([]);
      setApiMessages([]);
      setStreamingText("");
    }
    prevDocIdRef.current = activeDocId;
  }, [activeDocId]);

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

  const buildContextPrefix = (): string => {
    const parts: string[] = [];

    if (allDocsContext && documents.length > 1) {
      parts.push("=== All Documents in Workspace ===");
      for (const doc of documents) {
        const text = stripHtml(doc.content);
        const preview =
          text.length > 800 ? text.slice(0, 800) + "..." : text;
        parts.push(
          `\n--- ${doc.title} ${doc.id === activeDocId ? "(CURRENT)" : ""} ---\n${preview}`,
        );
      }
      parts.push("\n=== End of Documents ===\n");
    } else if (activeDoc) {
      parts.push(
        `Current document "${activeDoc.title}":\n${stripHtml(activeDoc.content)}`,
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

  const handleMcpToolCall = useCallback(async (toolName: string, input: Record<string, unknown>): Promise<unknown> => {
    const parsed = parseClaudeToolName(toolName);
    if (!parsed) throw new Error(`Unknown tool: ${toolName}`);
    return await callTool(parsed.serverId, parsed.toolName, input);
  }, []);

  const handleImageGen = async () => {
    if (!user || !input.trim()) return;
    const prompt = input.trim();
    setInput("");
    setGeneratingImage(true);

    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", content: `🎨 Generate image: ${prompt}` },
    ]);

    try {
      const result = await generateImage(prompt, (status) => setToolStatus(status));
      setToolStatus(null);

      if (!insertAtCursor(result.markdown)) {
        appendToDoc(result.markdown);
      }

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Image generated and inserted:\n\n${result.markdown}`,
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
      const claudeTools = mcpEnabled && mcpTools.length > 0 ? toClaudeTools(mcpTools) : undefined;
      let result: string;

      if (claudeTools && claudeTools.length > 0) {
        setToolStatus(null);
        result = await sendWithToolLoop(
          getSystemPrompt(),
          [{ role: "user", content: `${action.prompt}\n\n${targetText}` }],
          handleMcpToolCall,
          (text) => setStreamingText(text),
          webSearch,
          claudeTools,
          (status) => setToolStatus(status),
        );
        setToolStatus(null);
      } else {
        result = await sendToClaude(
          "",
          getSystemPrompt(),
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
        images: images.length > 0 ? images.map((i) => ({ data: i.data, mediaType: i.mediaType })) : undefined,
      },
    ]);
    setStreaming(true);
    setStreamingText("");

    try {
      const isFirstMessage = apiMessages.length === 0;
      const context = buildContextPrefix();

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

      const claudeTools = mcpEnabled && mcpTools.length > 0 ? toClaudeTools(mcpTools) : undefined;
      let result: string;

      if (claudeTools && claudeTools.length > 0) {
        setToolStatus(null);
        result = await sendWithToolLoop(
          getSystemPrompt(),
          newApiMessages,
          handleMcpToolCall,
          (text) => setStreamingText(text),
          webSearch,
          claudeTools,
          (status) => setToolStatus(status),
        );
        setToolStatus(null);
      } else {
        result = await sendToClaude(
          "",
          getSystemPrompt(),
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
      <div className="flex h-full w-full flex-col border-l border-border bg-background">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4" />
            <span className="text-sm font-medium">Claude AI</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className={isIOS ? "h-9 w-9 cursor-pointer" : "h-6 w-6 cursor-pointer"}
            onClick={onClose}
          >
            <X className={isIOS ? "h-5 w-5" : "h-3.5 w-3.5"} />
          </Button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center p-4 space-y-3">
          <Bot className="h-10 w-10 text-muted-foreground" />
          <p className="text-xs text-muted-foreground text-center">
            Sign in with Google to use AI features powered by Claude Opus 4.6
            via Vertex AI.
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

  const renderMarkdown = (content: string) => (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        pre: ({ node, ...props }) => (
          <pre
            className="bg-background/50 rounded p-2 overflow-x-auto my-1 text-[11px]"
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
        p: ({ node, ...props }) => <p className="mb-1.5 last:mb-0" {...props} />,
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
    <div className="relative flex h-full w-full flex-col border-l border-border bg-background">
      {/* Custom Rules Editor (overlay) */}
      <RulesEditor
        open={rulesOpen}
        onClose={() => setRulesOpen(false)}
        rules={customRules}
        onSave={saveCustomRules}
      />
      {/* MCP Settings (overlay) */}
      <McpSettings
        open={mcpSettingsOpen}
        onClose={() => setMcpSettingsOpen(false)}
        onToolsChanged={refreshMcpTools}
      />

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4" />
          <span className="text-sm font-medium">Claude AI</span>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant={webSearch ? "secondary" : "ghost"}
            size="icon"
            className="h-6 w-6 cursor-pointer"
            onClick={() => setWebSearch(!webSearch)}
            title={webSearch ? "Web search enabled" : "Enable web search"}
          >
            <Globe className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant={allDocsContext ? "secondary" : "ghost"}
            size="icon"
            className="h-6 w-6 cursor-pointer"
            onClick={() => setAllDocsContext(!allDocsContext)}
            title={
              allDocsContext
                ? "Using all documents as context"
                : "Using current document only"
            }
          >
            <BookOpen className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant={mcpEnabled && mcpTools.length > 0 ? "secondary" : "ghost"}
            size="icon"
            className="h-6 w-6 cursor-pointer"
            onClick={() => {
              if (mcpTools.length > 0) {
                setMcpEnabled(!mcpEnabled);
              } else {
                setMcpSettingsOpen(true);
              }
            }}
            onContextMenu={(e) => { e.preventDefault(); setMcpSettingsOpen(true); }}
            title={mcpEnabled && mcpTools.length > 0
              ? `MCP active (${mcpTools.length} tools) — right-click to configure`
              : "MCP tools — click to configure"}
          >
            <Wrench className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant={customRules.trim() ? "secondary" : "ghost"}
            size="icon"
            className="h-6 w-6 cursor-pointer"
            onClick={() => setRulesOpen(true)}
            title={customRules.trim() ? "Custom rules active" : "Set custom AI rules"}
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 cursor-pointer"
              onClick={() => {
                setMessages([]);
                setApiMessages([]);
              }}
              title="Clear conversation"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={isIOS ? "h-9 w-9 cursor-pointer" : "h-6 w-6 cursor-pointer"}
            onClick={onClose}
          >
            <X className={isIOS ? "h-5 w-5" : "h-3.5 w-3.5"} />
          </Button>
        </div>
      </div>

      {/* Quick actions */}
      <div className="p-2 space-y-1">
        <p className="px-1 text-[10px] text-muted-foreground uppercase tracking-wider">
          Quick Actions{" "}
          {hasSelection ? "(on selection)" : "(on document)"}
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
      {(allDocsContext || webSearch || (mcpEnabled && mcpTools.length > 0) || toolStatus) && (
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
      <ScrollArea ref={scrollAreaRef} className="ai-panel-scroll flex-1 min-h-0 p-3">
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
                msg.role === "user"
                  ? "text-right"
                  : "bg-muted rounded-md p-2"
              }`}
            >
              {msg.role === "assistant" && (
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-muted-foreground">
                    Claude
                  </span>
                  <div className="flex gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 cursor-pointer"
                      onClick={() =>
                        navigator.clipboard.writeText(msg.content)
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
                        if (!replaceSelection(msg.content)) {
                          alert("エディタが利用できません。エディタ表示に切り替えてください。");
                        }
                      }}
                      title="Replace selection / Insert at cursor"
                    >
                      <Replace className="h-2.5 w-2.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 cursor-pointer"
                      onClick={() => {
                        if (!appendToDoc(msg.content)) {
                          alert("エディタが利用できません。エディタ表示に切り替えてください。");
                        }
                      }}
                      title="Append to document"
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
                  </div>
                )}
              </div>
            </div>
          ))}
          {streaming && streamingText && (
            <div className="text-xs bg-muted rounded-md p-2">
              <span className="text-[10px] text-muted-foreground">
                Claude
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
                onClick={() => setAttachedImages((prev) => prev.filter((_, j) => j !== i))}
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
      <div className="border-t border-border p-2">
        <div className="flex gap-1 items-end">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 cursor-pointer"
            onClick={handleImageAttach}
            disabled={streaming || generatingImage}
            title="Attach image"
          >
            <Paperclip className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 cursor-pointer"
            onClick={handleImageGen}
            disabled={streaming || generatingImage || !input.trim()}
            title="Generate image from prompt"
          >
            <Wand2 className="h-3.5 w-3.5" />
          </Button>
          <textarea
            ref={textareaRef}
            placeholder="Ask about your document... (Cmd+Enter)"
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
            className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring resize-none select-text [&::-webkit-scrollbar]:w-[3px] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border"
          />
          <Button
            size="icon"
            className="h-7 w-7 shrink-0 cursor-pointer"
            onClick={handleChat}
            disabled={streaming || generatingImage || (!input.trim() && attachedImages.length === 0)}
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
