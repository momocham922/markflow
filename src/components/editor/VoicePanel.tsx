import { useState, useCallback, useRef, useEffect } from "react";
import {
  Mic,
  MicOff,
  Sparkles,
  Trash2,
  Loader2,
  Monitor,
  Info,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { isAndroid, isMobile, isTauri } from "@/platform";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { useAuthStore } from "@/stores/auth-store";
import { auth } from "@/services/firebase";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";

interface VoicePanelProps {
  onInsertMarkdown: (markdown: string) => void;
  onSetContent: (content: string) => void;
  documentContent: string;
}

function extractHints(text: string): string[] {
  const hints = new Set<string>();
  // 漢字複合語（2文字以上 — 固有名詞・ブランド名・専門用語）
  const kanji = text.match(/[一-鿿]{2,}/g);
  if (kanji) kanji.forEach((w) => hints.add(w));
  // カタカナ語（3文字以上）
  const katakana = text.match(/[゠-ヿ]{3,}/g);
  if (katakana) katakana.forEach((w) => hints.add(w));
  // 英単語（大文字始まり3文字以上）
  const english = text.match(/[A-Z][a-zA-Z]{2,}/g);
  if (english) english.forEach((w) => hints.add(w));
  // 長い語を優先（固有名詞は一般語より長い傾向）
  return Array.from(hints)
    .sort((a, b) => b.length - a.length)
    .slice(0, 500);
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function VoicePanel({
  onInsertMarkdown,
  onSetContent,
  documentContent,
}: VoicePanelProps) {
  const [structuring, setStructuring] = useState(false);
  const [refining, setRefining] = useState(false);
  const [refineStage, setRefineStage] = useState<
    "upload" | "transcribe" | "structure" | null
  >(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceInfo, setVoiceInfo] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoStructureInterval, setAutoStructureInterval] = useState<number>(0);
  const [autoElapsed, setAutoElapsed] = useState(0);
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastStructuredRef = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const [audioDevices, setAudioDevices] = useState<string[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [systemAudio, setSystemAudio] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const isDesktop = typeof navigator !== "undefined" && !isMobile;

  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<string[]>("list_audio_devices")
        .then((devices) => {
          setAudioDevices(devices);
        })
        .catch(() => {});
    });
  }, []);

  // Refs to avoid stale closures in setInterval callbacks
  const fullTranscriptRef = useRef("");
  const structuringRef = useRef(false);
  const onInsertRef = useRef(onInsertMarkdown);
  const onSetContentRef = useRef(onSetContent);
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
    getHints: () => extractHints(docContentRef.current),
    onError: (msg) => {
      setVoiceError(msg);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => setVoiceError(null), 8000);
    },
    onInfo: (msg) => setVoiceInfo(msg),
    onMaxDuration: () =>
      setVoiceError("Recording stopped: maximum duration (60 min) reached."),
  });

  useEffect(() => {
    if (!isRecording || !isTauri) {
      setAudioLevel(0);
      return;
    }
    const id = setInterval(async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const level = await invoke<number>("get_voice_level");
        setAudioLevel(level);
      } catch {
        setAudioLevel(0);
      }
    }, 100);
    return () => {
      clearInterval(id);
      setAudioLevel(0);
    };
  }, [isRecording]);

  // Keep refs in sync
  useEffect(() => {
    fullTranscriptRef.current = fullTranscript;
  }, [fullTranscript]);
  useEffect(() => {
    structuringRef.current = structuring;
  }, [structuring]);
  useEffect(() => {
    onInsertRef.current = onInsertMarkdown;
  }, [onInsertMarkdown]);
  useEffect(() => {
    onSetContentRef.current = onSetContent;
  }, [onSetContent]);
  useEffect(() => {
    docContentRef.current = documentContent;
  }, [documentContent]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [fullTranscript, interimText]);

  const doStructure = useCallback(async (manual = false) => {
    const transcript = fullTranscriptRef.current;
    if (!transcript.trim() || structuringRef.current) return;

    const newPart = lastStructuredRef.current
      ? transcript.slice(lastStructuredRef.current.length).trim()
      : transcript.trim();
    if (!manual && newPart.length < 80) return;

    setStructuring(true);
    structuringRef.current = true;
    try {
      const user = useAuthStore.getState().user;
      if (!user) throw new Error("Not authenticated");
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error("No token");

      const existingDoc = docContentRef.current.trim();
      const hasExisting = existingDoc.length > 0;
      const hasNewPart = newPart.length > 0;

      const docVocabulary = hasExisting ? extractHints(existingDoc) : [];
      const vocabularyHint =
        docVocabulary.length > 0
          ? `The following terms appear in the existing document and may have been misrecognized in the transcript — use them as the correct spelling: [${docVocabulary.slice(0, 100).join(", ")}]. `
          : "";

      const sttCorrection =
        "The transcript is from speech-to-text and may contain misrecognitions, especially for proper nouns, brand names, technical terms, personal names, and place names. Correct obvious errors based on context. " +
        vocabularyHint;

      const structuringRules =
        "CRITICAL: You are NOT creating a cleaned-up transcript or conversation log. " +
        "You MUST deeply understand the content and produce an INFORMATIONAL DOCUMENT that a reader can use without having heard the conversation. " +
        "Organize by TOPIC, not chronologically. Extract and distill: key decisions, action items, facts, issues, background context, and conclusions. " +
        "Use speaker information to attribute decisions and opinions where relevant (e.g., 'Aさんが指摘した問題点'), but NEVER format as dialogue (Speaker 0: ... / Speaker 1: ...). " +
        "The transcript contains '---' markers indicating chunk boundaries. Speaker labels are ONLY consistent WITHIN segments between --- markers — the same speaker may have different labels in different segments. Use speech content to identify and unify speakers across segments. " +
        "Omit filler, repetition, backchannel responses, and off-topic tangents. " +
        "Keep the same language as the transcript. Do NOT add generic titles like '会議メモ', '音声メモ', 'Voice Notes'. " +
        "Output ONLY the structured Markdown, no explanations or meta-commentary. Do not truncate.";

      let systemPrompt: string;
      let userContent: string;

      if (hasExisting && hasNewPart) {
        systemPrompt =
          "You are a document assistant. You will receive an EXISTING document and NEW additional voice transcript. " +
          sttCorrection +
          structuringRules +
          " Integrate the new information into the existing document — add to, expand, or reorganize sections as needed. Output the COMPLETE updated document.";
        userContent = `## Existing Document\n\n${existingDoc}\n\n## New Voice Transcript\n\n${newPart}\n\nIntegrate the information from this transcript into the existing document. Output the complete updated document.`;
      } else if (hasExisting) {
        systemPrompt =
          "You are a document assistant. You will receive an EXISTING document and a voice transcript. " +
          sttCorrection +
          structuringRules +
          " Merge the information into a single cohesive document. Preserve the existing document's structure and integrate new information naturally. Output the COMPLETE document.";
        userContent = `## Existing Document\n\n${existingDoc}\n\n## Voice Transcript\n\n${transcript}\n\nMerge the information into one cohesive document. Output the complete document.`;
      } else {
        systemPrompt =
          "You are a document assistant. You will receive a voice transcript to convert into a structured informational document. " +
          sttCorrection +
          structuringRules;
        userContent = `Convert this voice transcript into a structured informational document:\n\n${transcript}`;
      }

      const res = await fetch(`${AI_PROXY_URL}/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          system: systemPrompt,
          messages: [{ role: "user", content: userContent }],
          max_tokens: 16384,
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
          onSetContentRef.current(newOutput);
        } else {
          onInsertRef.current(`\n\n${newOutput}\n`);
        }
        lastStructuredRef.current = transcript;
      }
    } catch (err) {
      console.error("[voice] Structuring failed:", err);
    } finally {
      setStructuring(false);
      structuringRef.current = false;
    }
  }, []);

  const doRefine = useCallback(async () => {
    const transcript = fullTranscriptRef.current;
    if (!transcript.trim() || refining) return;

    setRefining(true);
    try {
      const user = useAuthStore.getState().user;
      if (!user) throw new Error("Not authenticated");
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error("No token");
      const uid = user.uid;
      const bucket = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET;
      if (!bucket) throw new Error("Storage bucket not configured");

      // Stage 1: Upload audio archive
      setRefineStage("upload");
      const { invoke } = await import("@tauri-apps/api/core");

      // Android: get archive path from Kotlin JS bridge
      let androidArchivePath: string | undefined;
      if (isAndroid) {
        const bridge = (window as unknown as Record<string, unknown>)
          .AndroidAudio as { getArchivePath?: () => string | null } | undefined;
        const p = bridge?.getArchivePath?.();
        if (!p) throw new Error("No voice archive available on this device");
        androidArchivePath = p;
      }

      const archiveResult = await invoke<{
        gcs_uri: string;
        download_url: string;
      }>("upload_voice_archive", {
        uid,
        token,
        bucket,
        archivePath: androidArchivePath,
      });

      // Stage 2: Batch transcribe with full-session diarization
      setRefineStage("transcribe");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 11 * 60 * 1000);
      const batchRes = await fetch(
        `${AI_PROXY_URL}/v1/voice/batch-transcribe`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            gcsUri: archiveResult.gcs_uri,
            language: "ja-JP",
          }),
          signal: controller.signal,
        },
      );
      clearTimeout(timeout);

      if (!batchRes.ok) {
        const errText = await batchRes.text();
        throw new Error(
          `Batch transcribe failed: ${batchRes.status} ${errText}`,
        );
      }

      const batchData = await batchRes.json();
      const diarizedTranscript =
        batchData.taggedTranscript || batchData.transcript || "";
      const speakerCount = batchData.speakerCount || 0;

      if (!diarizedTranscript.trim()) {
        throw new Error("Batch transcription returned empty result");
      }

      // Stage 3: Claude refinement with diarized transcript + existing structure
      setRefineStage("structure");
      const existingDoc = docContentRef.current.trim();
      const docVocabulary = existingDoc ? extractHints(existingDoc) : [];
      const vocabularyHint =
        docVocabulary.length > 0
          ? `The following terms appear in the existing document and may have been misrecognized — use them as the correct spelling: [${docVocabulary.slice(0, 100).join(", ")}]. `
          : "";

      const refineSystemPrompt =
        "You are a document assistant performing a FINAL REFINEMENT. " +
        "You will receive a BATCH-DIARIZED TRANSCRIPT processed from the complete recording session with globally consistent speaker labels, " +
        (existingDoc
          ? "and an EXISTING DOCUMENT (a preliminary structure created during recording). "
          : "") +
        "The transcript is from speech-to-text and may contain misrecognitions. Correct obvious errors based on context. " +
        vocabularyHint +
        `There are ${speakerCount} speaker(s) in this recording. ` +
        "CRITICAL: You are NOT creating a cleaned-up transcript. " +
        "Produce a POLISHED, FINAL informational document organized by TOPIC, not chronologically. " +
        "The speaker labels (Speaker 1, Speaker 2, etc.) are globally consistent — trust them for attribution. " +
        "Attribute decisions, opinions, and action items to specific speakers. If speakers introduced themselves, use their names. " +
        "Extract and distill: key decisions, action items, facts, issues, background context, and conclusions. " +
        "Omit filler, repetition, backchannel responses, and off-topic tangents. " +
        "Keep the same language as the transcript. Do NOT add generic titles. " +
        "Output ONLY the structured Markdown, no explanations. Do not truncate.";

      const refineUserContent = existingDoc
        ? `## Batch-Diarized Transcript (${speakerCount} speakers)\n\n${diarizedTranscript}\n\n## Existing Document (preliminary)\n\n${existingDoc}\n\nProduce the final refined document using the diarized transcript as the authoritative source.`
        : `## Batch-Diarized Transcript (${speakerCount} speakers)\n\n${diarizedTranscript}\n\nProduce a polished structured document from this transcript.`;

      const refineRes = await fetch(`${AI_PROXY_URL}/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          system: refineSystemPrompt,
          messages: [{ role: "user", content: refineUserContent }],
          max_tokens: 16384,
          stream: false,
        }),
      });

      if (!refineRes.ok) {
        throw new Error(`Refine structuring failed: ${refineRes.status}`);
      }

      const refineData = await refineRes.json();
      const refinedOutput =
        refineData.content?.[0]?.text || refineData.content || "";

      if (refinedOutput.trim()) {
        onSetContentRef.current(refinedOutput.trim());
      }
    } catch (err) {
      console.error("[voice] Refine failed:", err);
      const msg = err instanceof Error ? err.message : String(err);
      setVoiceError(`Refine failed: ${msg}`);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => setVoiceError(null), 10000);
    } finally {
      setRefining(false);
      setRefineStage(null);
    }
  }, [refining]);

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
        Microphone access is not available. Please check your browser/app
        permissions.
      </div>
    );
  }

  const progress =
    autoStructureInterval > 0 && isRecording
      ? autoElapsed / autoStructureInterval
      : 0;

  return (
    <div className="border-t border-border bg-background">
      {voiceError && (
        <div className="px-4 py-2 text-xs text-destructive bg-destructive/10 border-b border-destructive/20">
          {voiceError}
        </div>
      )}
      {voiceInfo && !voiceError && (
        <div className="flex items-center gap-1.5 px-4 py-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800/40">
          <Info className="h-3 w-3 shrink-0" />
          {voiceInfo}
        </div>
      )}
      {(fullTranscript || isRecording) && (
        <div
          ref={scrollRef}
          className="max-h-32 overflow-y-auto px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap wrap-break-word select-text cursor-text"
        >
          {fullTranscript && (
            <span className="text-foreground">{fullTranscript}</span>
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
          onClick={() => {
            setVoiceError(null);
            setVoiceInfo(null);
            toggle();
          }}
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
          <div
            className="flex items-end gap-px h-4"
            title={`Level: ${Math.round(audioLevel * 100)}%`}
          >
            {[0.15, 0.3, 0.45, 0.6, 0.75].map((threshold, i) => (
              <div
                key={i}
                className={`w-[3px] rounded-sm transition-all duration-75 ${
                  audioLevel >= threshold
                    ? threshold >= 0.75
                      ? "bg-red-500"
                      : threshold >= 0.45
                        ? "bg-amber-400"
                        : "bg-emerald-500"
                    : "bg-muted"
                }`}
                style={{ height: `${4 + i * 3}px` }}
              />
            ))}
          </div>
        )}

        <div className="flex-1" />

        {isTauri && isDesktop && !isRecording && (
          <Button
            variant={systemAudio ? "secondary" : "ghost"}
            size="icon"
            className="h-7 w-7"
            onClick={() => setSystemAudio((v) => !v)}
            title={
              systemAudio
                ? "システム音声 ON（クリックで無効化）"
                : "システム音声も録音（会議等）"
            }
          >
            <Monitor
              className={`h-3.5 w-3.5 ${systemAudio ? "text-amber-500" : ""}`}
            />
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
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}

        <select
          className="h-7 rounded-md border border-input bg-background px-2 text-[11px] outline-none"
          value={autoStructureInterval}
          onChange={(e) => setAutoStructureInterval(Number(e.target.value))}
        >
          <option value={0}>Manual</option>
          <option value={60}>1min auto</option>
          <option value={120}>2min auto</option>
          <option value={180}>3min auto</option>
          <option value={300}>5min auto</option>
        </select>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          onClick={() => doStructure(true)}
          disabled={!fullTranscript.trim() || structuring}
        >
          {structuring ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          Structure
        </Button>

        {isTauri && !isRecording && fullTranscript.trim() && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={() => doRefine()}
            disabled={refining || structuring}
          >
            {refining ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wand2 className="h-3.5 w-3.5" />
            )}
            Refine
          </Button>
        )}

        <Button
          variant="ghost"
          size="icon"
          className={isMobile ? "h-11 w-11" : "h-7 w-7"}
          onClick={() => {
            clearTranscript();
            lastStructuredRef.current = "";
            import("@tauri-apps/api/core")
              .then(({ invoke }) => invoke("clear_voice_archive"))
              .catch(() => {});
            if (isAndroid) {
              const bridge = (window as unknown as Record<string, unknown>)
                .AndroidAudio as { clearArchive?: () => void } | undefined;
              bridge?.clearArchive?.();
            }
          }}
          disabled={!fullTranscript}
          title="Clear transcript"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {refineStage && (
        <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground border-t">
          <Loader2 className="h-3 w-3 animate-spin" />
          <div className="flex gap-1">
            <span
              className={
                refineStage === "upload"
                  ? "font-medium text-foreground"
                  : refineStage === "transcribe" || refineStage === "structure"
                    ? "text-muted-foreground/50"
                    : ""
              }
            >
              Upload
            </span>
            <span>→</span>
            <span
              className={
                refineStage === "transcribe"
                  ? "font-medium text-foreground"
                  : refineStage === "structure"
                    ? "text-muted-foreground/50"
                    : ""
              }
            >
              Analyze
            </span>
            <span>→</span>
            <span
              className={
                refineStage === "structure" ? "font-medium text-foreground" : ""
              }
            >
              Structure
            </span>
          </div>
          {isMobile && (
            <span className="text-[10px] text-amber-500 ml-1">
              — アプリを閉じないでください
            </span>
          )}
        </div>
      )}
    </div>
  );
}
