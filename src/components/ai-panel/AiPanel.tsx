import { useState, useRef, useEffect } from "react";
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
  Settings,
  Copy,
  CornerDownLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { sendToClaude, AI_ACTIONS, type ClaudeMessage } from "@/services/claude";
import { useAppStore } from "@/stores/app-store";
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

interface AiPanelProps {
  onClose: () => void;
  onInsert?: (text: string) => void;
}

export function AiPanel({ onClose, onInsert }: AiPanelProps) {
  const { activeDocId, documents } = useAppStore();
  const activeDoc = documents.find((d) => d.id === activeDocId);

  const [apiKey, setApiKey] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [messages, setMessages] = useState<ClaudeMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    db.getSetting("claude_api_key").then((key) => {
      if (key) setApiKey(key);
      else setShowSettings(true);
    }).catch(() => {});
  }, []);

  const saveApiKey = async (key: string) => {
    setApiKey(key);
    try {
      await db.setSetting("claude_api_key", key);
    } catch {}
    setShowSettings(false);
  };

  const stripHtml = (html: string) => {
    const div = document.createElement("div");
    div.innerHTML = html;
    return div.textContent || "";
  };

  const handleAction = async (actionId: string) => {
    if (!apiKey || !activeDoc) return;
    const action = AI_ACTIONS.find((a) => a.id === actionId);
    if (!action) return;

    const docText = stripHtml(activeDoc.content);
    const userMsg: ClaudeMessage = {
      role: "user",
      content: `${action.prompt}\n\n${docText}`,
    };

    setMessages((prev) => [...prev, { role: "user", content: action.label }]);
    setStreaming(true);
    setStreamingText("");

    try {
      const result = await sendToClaude(
        apiKey,
        "You are a helpful writing assistant integrated into a Markdown editor called MarkFlow. Respond in the same language as the input text unless asked to translate.",
        [userMsg],
        (text) => setStreamingText(text),
      );
      setMessages((prev) => [...prev, { role: "assistant", content: result }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Unknown error"}` },
      ]);
    } finally {
      setStreaming(false);
      setStreamingText("");
    }
  };

  const handleChat = async () => {
    if (!apiKey || !input.trim()) return;

    const context = activeDoc ? `Current document:\n${stripHtml(activeDoc.content)}\n\n` : "";
    const userMsg: ClaudeMessage = {
      role: "user",
      content: `${context}${input}`,
    };

    const displayMsg: ClaudeMessage = { role: "user", content: input };
    setMessages((prev) => [...prev, displayMsg]);
    setInput("");
    setStreaming(true);
    setStreamingText("");

    try {
      const allMessages = [...messages.filter((m) => m.role !== "user" || !AI_ACTIONS.some((a) => a.label === m.content)), userMsg];
      const result = await sendToClaude(
        apiKey,
        "You are a helpful writing assistant integrated into a Markdown editor called MarkFlow. Help the user with their writing, answer questions about their document, and provide suggestions. Respond in the same language as the user's message.",
        allMessages.slice(-10),
        (text) => setStreamingText(text),
      );
      setMessages((prev) => [...prev, { role: "assistant", content: result }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Unknown error"}` },
      ]);
    } finally {
      setStreaming(false);
      setStreamingText("");
    }
  };

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  if (showSettings) {
    return (
      <div className="flex h-full w-80 flex-col border-l border-border bg-background">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-sm font-medium">API Key Setup</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Enter your Anthropic API key to enable AI features.
          </p>
          <input
            type="password"
            placeholder="sk-ant-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            size="sm"
            className="w-full"
            onClick={() => saveApiKey(apiKey)}
            disabled={!apiKey.trim()}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-80 flex-col border-l border-border bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4" />
          <span className="text-sm font-medium">Claude AI</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setShowSettings(true)}
            title="API settings"
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Quick actions */}
      <div className="p-2 space-y-1">
        <p className="px-1 text-[10px] text-muted-foreground uppercase tracking-wider">
          Quick Actions
        </p>
        <div className="grid grid-cols-2 gap-1">
          {AI_ACTIONS.map((action) => {
            const Icon = iconMap[action.icon] || Sparkles;
            return (
              <Button
                key={action.id}
                variant="ghost"
                size="sm"
                className="justify-start gap-1.5 text-[11px] h-7"
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

      {/* Messages */}
      <ScrollArea className="flex-1 p-3">
        <div className="space-y-3">
          {messages.length === 0 && !streaming && (
            <p className="text-xs text-muted-foreground text-center py-8">
              Use quick actions or chat to get AI assistance with your document.
            </p>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`text-xs ${
                msg.role === "user"
                  ? "text-right"
                  : "bg-muted rounded-md p-2"
              }`}
            >
              {msg.role === "assistant" && (
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-muted-foreground">Claude</span>
                  <div className="flex gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      onClick={() => navigator.clipboard.writeText(msg.content)}
                      title="Copy"
                    >
                      <Copy className="h-2.5 w-2.5" />
                    </Button>
                    {onInsert && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5"
                        onClick={() => onInsert(msg.content)}
                        title="Insert into editor"
                      >
                        <CornerDownLeft className="h-2.5 w-2.5" />
                      </Button>
                    )}
                  </div>
                </div>
              )}
              <div className="whitespace-pre-wrap leading-relaxed">
                {msg.role === "user" ? (
                  <span className="inline-block bg-primary text-primary-foreground rounded-md px-2 py-1">
                    {msg.content}
                  </span>
                ) : (
                  msg.content
                )}
              </div>
            </div>
          ))}
          {streaming && streamingText && (
            <div className="text-xs bg-muted rounded-md p-2">
              <span className="text-[10px] text-muted-foreground">Claude</span>
              <div className="whitespace-pre-wrap leading-relaxed mt-1">
                {streamingText}
                <span className="animate-pulse">|</span>
              </div>
            </div>
          )}
          <div ref={scrollRef} />
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="border-t border-border p-2">
        <div className="flex gap-1">
          <input
            type="text"
            placeholder="Ask Claude anything..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleChat();
              }
            }}
            disabled={streaming}
            className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={handleChat}
            disabled={streaming || !input.trim()}
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
