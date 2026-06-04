import { useState, useCallback, useRef, useEffect } from "react";
import { Mic, MicOff, Sparkles, Trash2, Loader2, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isMobile, isTauri } from "@/platform";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { useAuthStore } from "@/stores/auth-store";
import { auth } from "@/services/firebase";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";

interface VoicePanelProps {
  onInsertMarkdown: (markdown: string) => void;
  onReplaceMarkdown: (oldMarkdown: string, newMarkdown: string) => void;
  documentContent: string;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function VoicePanel({ onInsertMarkdown, onReplaceMarkdown, documentContent }: VoicePanelProps) {
  const [structuring, setStructuring] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [autoStructureInterval, setAutoStructureInterval] = useState<number>(0);
  const [autoElapsed, setAutoElapsed] = useState(0);
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastStructuredRef = useRef("");
  const lastStructuredOutputRef = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const [audioDevices, setAudioDevices] = useState<string[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [systemAudio, setSystemAudio] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<string[]>("list_audio_devices").then((devices) => {
        setAudioDevices(devices);
      }).catch(() => {});
    });
  }, []);

  // Refs to avoid stale closures in setInterval callbacks
  const fullTranscriptRef = useRef("");
  const structuringRef = useRef(false);
  const onInsertRef = useRef(onInsertMarkdown);
  const onReplaceRef = useRef(onReplaceMarkdown);
  const docContentRef = useRef(documentContent);

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
    deviceName: selectedDevice || undefined,
    systemAudio,
    onError: (msg) => setVoiceError(msg),
    onMaxDuration: () => setVoiceError("Recording stopped: maximum duration (60 min) reached."),
  });

  useEffect(() => {
    if (!isRecording || !isTauri) { setAudioLevel(0); return; }
    const id = setInterval(async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const level = await invoke<number>("get_voice_level");
        setAudioLevel(level);
      } catch { setAudioLevel(0); }
    }, 100);
    return () => { clearInterval(id); setAudioLevel(0); };
  }, [isRecording]);

  // Keep refs in sync
  useEffect(() => { fullTranscriptRef.current = fullTranscript; }, [fullTranscript]);
  useEffect(() => { structuringRef.current = structuring; }, [structuring]);
  useEffect(() => { onInsertRef.current = onInsertMarkdown; }, [onInsertMarkdown]);
  useEffect(() => { onReplaceRef.current = onReplaceMarkdown; }, [onReplaceMarkdown]);
  useEffect(() => { docContentRef.current = documentContent; }, [documentContent]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [fullTranscript, interimText]);

  const doStructure = useCallback(async () => {
    const transcript = fullTranscriptRef.current;
    if (!transcript.trim() || structuringRef.current) return;

    setStructuring(true);
    structuringRef.current = true;
    try {
      const user = useAuthStore.getState().user;
      if (!user) throw new Error("Not authenticated");
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error("No token");

      const existingDoc = docContentRef.current.trim();
      const hasExisting = existingDoc.length > 0;

      const systemPrompt = hasExisting
        ? "You are a document assistant. You will receive an EXISTING document and a NEW voice transcript. " +
          "Merge them into a single, well-structured Markdown document. " +
          "Preserve the existing document's structure and content, and integrate the new transcript naturally. " +
          "Update, expand, or reorganize sections as needed to incorporate the new information. " +
          "Keep the same language. Do NOT add generic titles. Output ONLY the final Markdown."
        : "You are a document assistant. Convert the ENTIRE voice transcript into a single, well-structured Markdown document. " +
          "Integrate all content coherently — do not produce fragments or partial updates. " +
          "Use appropriate headings, bullet points, and formatting. " +
          "Keep the same language as the transcript. " +
          "Do NOT add generic titles like 'Voice Notes', '音声メモ', '会議メモ', etc. " +
          "Output ONLY the structured Markdown content, no explanations or meta-commentary.";

      const userContent = hasExisting
        ? `## Existing Document\n\n${existingDoc}\n\n## New Voice Transcript\n\n${transcript}\n\nMerge these into one cohesive Markdown document.`
        : `Convert this complete voice transcript into one structured Markdown document:\n\n${transcript}`;

      const res = await fetch(`${AI_PROXY_URL}/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          system: systemPrompt,
          messages: [{ role: "user", content: userContent }],
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
        const newOutput = markdown.trim();
        if (hasExisting) {
          // Replace entire document content with merged result
          onReplaceRef.current(docContentRef.current, newOutput);
        } else if (lastStructuredOutputRef.current) {
          onReplaceRef.current(lastStructuredOutputRef.current, `\n\n${newOutput}\n`);
        } else {
          onInsertRef.current(`\n\n${newOutput}\n`);
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

        {isRecording && (
          <div className="flex items-end gap-px h-4" title={`Level: ${Math.round(audioLevel * 100)}%`}>
            {[0.15, 0.3, 0.45, 0.6, 0.75].map((threshold, i) => (
              <div
                key={i}
                className={`w-[3px] rounded-sm transition-all duration-75 ${
                  audioLevel >= threshold
                    ? threshold >= 0.75 ? "bg-red-500" : threshold >= 0.45 ? "bg-amber-400" : "bg-emerald-500"
                    : "bg-muted"
                }`}
                style={{ height: `${4 + i * 3}px` }}
              />
            ))}
          </div>
        )}

        <div className="flex-1" />

        {isTauri && isMac && !isMobile && !isRecording && (
          <Button
            variant={systemAudio ? "secondary" : "ghost"}
            size="icon"
            className="h-7 w-7"
            onClick={() => setSystemAudio((v) => !v)}
            title={systemAudio ? "システム音声 ON（クリックで無効化）" : "システム音声も録音（会議等）"}
          >
            <Monitor className={`h-3.5 w-3.5 ${systemAudio ? "text-amber-500" : ""}`} />
          </Button>
        )}

        {isTauri && audioDevices.length > 0 && !isRecording && (
          <select
            className="h-7 max-w-[120px] rounded-md border border-input bg-background px-1.5 text-[11px] outline-none truncate"
            value={selectedDevice}
            onChange={(e) => setSelectedDevice(e.target.value)}
            title={selectedDevice || "Default microphone"}
          >
            <option value="">Default mic</option>
            {audioDevices.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        )}

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
