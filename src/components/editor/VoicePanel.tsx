import { useState, useCallback, useRef, useEffect } from "react";
import { Mic, MicOff, Sparkles, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isMobile } from "@/platform";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { useAuthStore } from "@/stores/auth-store";
import { auth } from "@/services/firebase";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";

interface VoicePanelProps {
  onInsertMarkdown: (markdown: string) => void;
  onReplaceMarkdown: (oldMarkdown: string, newMarkdown: string) => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function VoicePanel({ onInsertMarkdown, onReplaceMarkdown }: VoicePanelProps) {
  const [structuring, setStructuring] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [autoStructureInterval, setAutoStructureInterval] = useState<number>(0);
  const [autoElapsed, setAutoElapsed] = useState(0);
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastStructuredRef = useRef("");
  const lastStructuredOutputRef = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Refs to avoid stale closures in setInterval callbacks
  const fullTranscriptRef = useRef("");
  const structuringRef = useRef(false);
  const onInsertRef = useRef(onInsertMarkdown);
  const onReplaceRef = useRef(onReplaceMarkdown);

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

  // Keep refs in sync
  useEffect(() => { fullTranscriptRef.current = fullTranscript; }, [fullTranscript]);
  useEffect(() => { structuringRef.current = structuring; }, [structuring]);
  useEffect(() => { onInsertRef.current = onInsertMarkdown; }, [onInsertMarkdown]);
  useEffect(() => { onReplaceRef.current = onReplaceMarkdown; }, [onReplaceMarkdown]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [fullTranscript, interimText]);

  const doStructure = useCallback(async () => {
    const transcript = fullTranscriptRef.current;
    if (!transcript.trim() || structuringRef.current) return;
    if (transcript === lastStructuredRef.current) return;

    setStructuring(true);
    structuringRef.current = true;
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
            "You are a document assistant. Convert the ENTIRE voice transcript into a single, well-structured Markdown document. " +
            "Integrate all content coherently — do not produce fragments or partial updates. " +
            "Use appropriate headings, bullet points, and formatting. " +
            "Keep the same language as the transcript. " +
            "Do NOT add generic titles like 'Voice Notes', '音声メモ', '会議メモ', etc. " +
            "Output ONLY the structured Markdown content, no explanations or meta-commentary.",
          messages: [
            {
              role: "user",
              content: `Convert this complete voice transcript into one structured Markdown document:\n\n${transcript}`,
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
        const newOutput = `\n\n${markdown.trim()}\n`;
        if (lastStructuredOutputRef.current) {
          onReplaceRef.current(lastStructuredOutputRef.current, newOutput);
        } else {
          onInsertRef.current(newOutput);
        }
        lastStructuredOutputRef.current = newOutput;
        lastStructuredRef.current = transcript;
      }
    } catch (err) {
      console.error("[voice] Structuring failed:", err);
    } finally {
      setStructuring(false);
      structuringRef.current = false;
    }
  }, []);

  // Auto-structure timer — stable callback, no deps on fullTranscript/structuring
  useEffect(() => {
    if (autoTimerRef.current) clearInterval(autoTimerRef.current);
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    setAutoElapsed(0);

    if (autoStructureInterval > 0 && isRecording) {
      autoTimerRef.current = setInterval(() => {
        doStructure();
        setAutoElapsed(0);
      }, autoStructureInterval * 1000);

      countdownTimerRef.current = setInterval(() => {
        setAutoElapsed((prev) => {
          const next = prev + 1;
          return next >= autoStructureInterval ? 0 : next;
        });
      }, 1000);
    }
    return () => {
      if (autoTimerRef.current) clearInterval(autoTimerRef.current);
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    };
  }, [autoStructureInterval, isRecording, doStructure]);

  if (!isSupported) {
    return (
      <div className="border-t border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground text-center">
        Microphone access is not available. Please check your browser/app permissions.
      </div>
    );
  }

  const progress = autoStructureInterval > 0 && isRecording
    ? autoElapsed / autoStructureInterval
    : 0;

  return (
    <div className="border-t border-border bg-background">
      {voiceError && (
        <div className="px-4 py-2 text-xs text-destructive bg-destructive/10 border-b border-destructive/20">
          {voiceError}
        </div>
      )}
      {(fullTranscript || isRecording) && (
        <div
          ref={scrollRef}
          className="max-h-32 overflow-y-auto px-4 py-2 text-sm leading-relaxed wrap-break-word"
        >
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
      )}

      {/* Auto-structure progress bar */}
      {autoStructureInterval > 0 && isRecording && (
        <div className="px-3 pb-1">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary/60 transition-all duration-1000 ease-linear"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
            <span className="text-[10px] text-muted-foreground font-mono tabular-nums w-8 text-right">
              {autoStructureInterval - autoElapsed}s
            </span>
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-border/50">
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

        {isRecording && (
          <span className="text-xs text-muted-foreground font-mono tabular-nums">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse mr-1.5" />
            {formatDuration(duration)}
          </span>
        )}

        <div className="flex-1" />

        <select
          className="h-7 rounded-md border border-input bg-background px-2 text-[11px] outline-none"
          value={autoStructureInterval}
          onChange={(e) => setAutoStructureInterval(Number(e.target.value))}
        >
          <option value={0}>Manual</option>
          <option value={15}>15s auto</option>
          <option value={30}>30s auto</option>
          <option value={45}>45s auto</option>
          <option value={60}>1min auto</option>
          <option value={120}>2min auto</option>
          <option value={180}>3min auto</option>
          <option value={300}>5min auto</option>
        </select>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() => doStructure()}
          disabled={!fullTranscript.trim() || structuring}
        >
          {structuring ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          Structure
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className={isMobile ? "h-11 w-11" : "h-7 w-7"}
          onClick={() => { clearTranscript(); lastStructuredRef.current = ""; lastStructuredOutputRef.current = ""; }}
          disabled={!fullTranscript}
          title="Clear transcript"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
