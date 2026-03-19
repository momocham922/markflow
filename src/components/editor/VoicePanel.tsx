import { useState, useCallback, useRef, useEffect } from "react";
import { Mic, MicOff, Sparkles, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { useAuthStore } from "@/stores/auth-store";
import { auth } from "@/services/firebase";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";

interface VoicePanelProps {
  onInsertMarkdown: (markdown: string) => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function VoicePanel({ onInsertMarkdown }: VoicePanelProps) {
  const [structuring, setStructuring] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [autoStructureInterval, setAutoStructureInterval] = useState<number>(0); // 0 = manual
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastStructuredRef = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const {
    isRecording,
    isSupported,
    interimText,
    fullTranscript,
    duration,
    toggle,
    clearTranscript,
  } = useVoiceInput({
    language: "ja-JP",
    onError: (msg) => setVoiceError(msg),
  });

  // Auto-scroll to bottom when new text arrives
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [fullTranscript, interimText]);

  const structureTranscript = useCallback(
    async (text?: string) => {
      const transcript = text || fullTranscript;
      if (!transcript.trim() || structuring) return;
      if (transcript === lastStructuredRef.current) return;

      setStructuring(true);
      try {
        const user = useAuthStore.getState().user;
        if (!user) throw new Error("Not authenticated");
        const token = await auth.currentUser?.getIdToken();
        if (!token) throw new Error("No token");

        const res = await fetch(`${AI_PROXY_URL}/v1/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            system:
              "You are a document assistant. Convert voice transcripts into well-structured Markdown. " +
              "Use appropriate headings (##, ###), bullet points, and formatting. " +
              "Keep the same language as the transcript. " +
              "Output ONLY the structured Markdown, no explanations.",
            messages: [
              {
                role: "user",
                content: `Convert this voice transcript into structured Markdown:\n\n${transcript}`,
              },
            ],
            max_tokens: 4096,
            stream: false,
          }),
        });

        if (!res.ok) throw new Error(`Structure failed: ${res.status}`);

        const data = await res.json();
        const markdown =
          data.content?.[0]?.text ||
          data.content?.map((c: { text?: string }) => c.text || "").join("") ||
          "";

        if (markdown.trim()) {
          onInsertMarkdown(
            `\n\n## 📝 Voice Notes\n\n${markdown.trim()}\n`,
          );
          lastStructuredRef.current = transcript;
        }
      } catch (err) {
        console.error("[voice] Structuring failed:", err);
      } finally {
        setStructuring(false);
      }
    },
    [fullTranscript, structuring, onInsertMarkdown],
  );

  // Auto-structure timer
  useEffect(() => {
    if (autoTimerRef.current) clearInterval(autoTimerRef.current);
    if (autoStructureInterval > 0 && isRecording) {
      autoTimerRef.current = setInterval(() => {
        structureTranscript();
      }, autoStructureInterval * 1000);
    }
    return () => {
      if (autoTimerRef.current) clearInterval(autoTimerRef.current);
    };
  }, [autoStructureInterval, isRecording, structureTranscript]);

  if (!isSupported) {
    return (
      <div className="border-t border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground text-center">
        Microphone access is not available. Please check your browser/app permissions.
      </div>
    );
  }

  return (
    <div className="border-t border-border bg-background">
      {/* Error banner */}
      {voiceError && (
        <div className="px-4 py-2 text-xs text-destructive bg-destructive/10 border-b border-destructive/20">
          {voiceError}
        </div>
      )}
      {/* Transcript area */}
      {(fullTranscript || isRecording) && (
        <ScrollArea className="max-h-32">
          <div ref={scrollRef} className="px-4 py-2 text-sm leading-relaxed">
            {fullTranscript && (
              <span className="text-foreground">{fullTranscript}</span>
            )}
            {isRecording && interimText && (
              <span className="text-muted-foreground animate-pulse ml-1">
                {interimText}
              </span>
            )}
            {isRecording && !fullTranscript && !interimText && (
              <span className="text-muted-foreground animate-pulse">
                Listening...
              </span>
            )}
          </div>
        </ScrollArea>
      )}

      {/* Controls */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-border/50">
        {/* Record toggle */}
        <Button
          variant={isRecording ? "destructive" : "default"}
          size="sm"
          className="gap-1.5"
          onClick={() => { setVoiceError(null); toggle(); }}
        >
          {isRecording ? (
            <>
              <MicOff className="h-3.5 w-3.5" />
              Stop
            </>
          ) : (
            <>
              <Mic className="h-3.5 w-3.5" />
              Record
            </>
          )}
        </Button>

        {/* Duration */}
        {isRecording && (
          <span className="text-xs text-muted-foreground font-mono tabular-nums">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse mr-1.5" />
            {formatDuration(duration)}
          </span>
        )}

        <div className="flex-1" />

        {/* Auto-structure select */}
        <select
          className="h-7 rounded-md border border-input bg-background px-2 text-[11px] outline-none"
          value={autoStructureInterval}
          onChange={(e) => setAutoStructureInterval(Number(e.target.value))}
        >
          <option value={0}>Manual</option>
          <option value={30}>30s auto</option>
          <option value={60}>1min auto</option>
          <option value={120}>2min auto</option>
        </select>

        {/* Structure button */}
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() => structureTranscript()}
          disabled={!fullTranscript.trim() || structuring}
        >
          {structuring ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          Structure
        </Button>

        {/* Clear */}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={clearTranscript}
          disabled={!fullTranscript}
          title="Clear transcript"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
