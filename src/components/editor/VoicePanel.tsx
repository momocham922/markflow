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
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { isAndroid, isMobile, isTauri } from "@/platform";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { useAuthStore } from "@/stores/auth-store";
import { useResearchStore } from "@/stores/research-store";
import type { ResearchCard } from "@/stores/research-store";
import { triggerResearchAnalysis } from "@/hooks/use-research-pipeline";
import { auth } from "@/services/firebase";
import { aiProxyHeaders, reportIfQuota } from "@/services/ai-proxy";
import { extractHints } from "@/lib/text-utils";
import { friendlyErrorMessage } from "@/lib/friendly-error";
import { track } from "@/services/telemetry";
import {
  newRefineJobId,
  sha256Hex,
  type CreateRefineJobBody,
} from "@/services/refine-jobs";
import {
  recordLocalRefineFailure,
  runRefineStream,
} from "@/services/refine-runner";
import { isRefineBusy, useRefineStore } from "@/stores/refine-store";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";

/**
 * Build the "Questions Context" block for Structure/Refine. Speaker-questions
 * are prompts the user may ASK — NOT facts and NOT meeting speech — so they go
 * into their own trailing '## 確認したいこと' section, kept separate from the
 * web-research '## 補足情報（Web調査）' section and never woven into the body.
 */
function buildQuestionsContext(questionCards: ResearchCard[]): string {
  return (
    "\n\n## Questions Context (follow-up questions to ASK — NOT meeting content)\n" +
    "These are candidate questions the user may want to ASK the other participants. " +
    "They are NOT facts and NOT anything anyone said. Follow the SEPARATION RULE: " +
    "collect them under a SINGLE trailing section titled '## 確認したいこと' " +
    "(translate the title to match the document's language), placed AFTER any " +
    "'## 補足情報（Web調査）' section and clearly separate from it. Render as a " +
    "bulleted checklist of the questions themselves; you MAY drop any ' — *intent*' " +
    "annotation and merge duplicate/near-identical questions. Do NOT weave them " +
    "into the minutes body. Omit the section entirely if none are meaningful.\n\n" +
    questionCards.map((c) => c.summary).join("\n")
  );
}

export interface VoiceDataUpdate {
  voiceTranscript?: string | null;
  voiceGcsUri?: string | null;
  voiceRecordedAt?: number | null;
  // Internal intent flag (never persisted). When true, the app-store voice-loss
  // guard is bypassed so a deliberate reset — the "Clear transcript" button or
  // starting a fresh recording — may null the voice fields. Absent/false means
  // any null over an existing non-empty voice value is treated as accidental
  // (e.g. a passive re-render) and dropped. See app-store.updateDocument.
  __voiceClear?: boolean;
}

interface VoicePanelProps {
  /** The open document — Refine jobs are tracked per document. */
  documentId: string;
  onInsertMarkdown: (markdown: string) => void;
  onSetContent: (content: string) => void;
  documentContent: string;
  onTranscriptChange?: (transcript: string) => void;
  onRecordingChange?: (isRecording: boolean) => void;
  voiceTranscript?: string | null;
  voiceGcsUri?: string | null;
  onVoiceDataChange?: (update: VoiceDataUpdate) => void;
}

function ResearchTriggerButton() {
  const analyzing = useResearchStore((s) => s.analyzing);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 shrink-0"
      onClick={triggerResearchAnalysis}
      disabled={analyzing}
      title="Analyze now"
    >
      {analyzing ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
      ) : (
        <Search className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}

/**
 * Mobile entry point to the research bottom sheet. The sheet (not this button)
 * holds the toggles + manual "今すぐ解析", so this stays a compact icon that
 * never crowds the transcription controls row. Shows a live card count badge.
 */
function MobileResearchButton() {
  const count = useResearchStore((s) => s.cards.length);
  const analyzing = useResearchStore((s) => s.analyzing);
  const setMobileSheetOpen = useResearchStore((s) => s.setMobileSheetOpen);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative h-8 w-8 shrink-0"
      onClick={() => setMobileSheetOpen(true)}
      title="リサーチ"
    >
      {analyzing ? (
        <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
      ) : (
        <Search className="h-4 w-4" />
      )}
      {count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-blue-500 px-1 text-[9px] font-semibold text-white">
          {count}
        </span>
      )}
    </Button>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/**
 * Prepare the live transcript for display: strip raw diarization labels
 * (e.g. "[Speaker 0]") — these are for internal pipeline use only and must
 * never be shown raw — and split chunk boundaries ("\n---\n") into segments
 * so they can be rendered as visual divider lines.
 */
function toTranscriptSegments(raw: string): string[] {
  return raw
    .split(/\n---\n/)
    .map((seg) =>
      seg
        .replace(/\[Speaker[^\]]*\]\s*/gi, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    )
    .filter((seg) => seg.length > 0);
}

export function VoicePanel({
  documentId,
  onInsertMarkdown,
  onSetContent,
  documentContent,
  onTranscriptChange,
  onRecordingChange,
  voiceTranscript: savedVoiceTranscript,
  voiceGcsUri: savedVoiceGcsUri,
  onVoiceDataChange,
}: VoicePanelProps) {
  const [structuring, setStructuring] = useState(false);
  const [hasArchive, setHasArchive] = useState(false);
  // Refine runs as a server-side job tracked per document (refine-store), so its
  // progress survives this panel closing or the document being switched.
  const refineState = useRefineStore((s) => s.byDoc[documentId]);
  const refining = isRefineBusy(refineState);
  const refineStage =
    refineState?.phase === "upload" ||
    refineState?.phase === "transcribe" ||
    refineState?.phase === "structure"
      ? refineState.phase
      : null;
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceInfo, setVoiceInfo] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoStructureInterval, setAutoStructureInterval] = useState<number>(0);
  const [autoElapsed, setAutoElapsed] = useState(0);
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastStructuredRef = useRef("");
  // Mirror of lastStructuredRef for the UI: the transcript text as of the last
  // successful Structure run. Drives the highlighted divider in the preview.
  // (A ref alone doesn't trigger re-render.)
  const [lastStructuredText, setLastStructuredText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  // Chunks from the last archive upload this session. Lets a Refine retry skip
  // re-uploading (and re-splitting) the audio. Long recordings (>58min) are
  // split into ≤55min parts with 20s overlap to clear chirp_3's 60-min limit.
  const uploadedChunksRef = useRef<Array<{
    gcsUri: string;
    startSec: number;
    durationSec: number;
  }> | null>(null);

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
  const refiningRef = useRef(false);
  const onInsertRef = useRef(onInsertMarkdown);
  const onSetContentRef = useRef(onSetContent);
  const docContentRef = useRef(documentContent);
  const sttVocabRef = useRef<Set<string>>(new Set());
  const onVoiceDataChangeRef = useRef(onVoiceDataChange);
  const savedVoiceGcsUriRef = useRef(savedVoiceGcsUri);
  const hasArchiveRef = useRef(false);
  const documentIdRef = useRef(documentId);

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
    getHints: () => {
      const vocabHints = Array.from(sttVocabRef.current).slice(0, 30);
      const docHints = extractHints(docContentRef.current).slice(0, 70);
      const merged = new Set([...vocabHints, ...docHints]);
      return Array.from(merged).slice(0, 100);
    },
    preferDiarization: systemAudio,
    onError: (msg) => {
      setVoiceError(msg);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => setVoiceError(null), 8000);
    },
    onInfo: (msg) => setVoiceInfo(msg),
    onMaxDuration: () =>
      setVoiceError("録音を停止しました（最長4時間に達しました）。"),
    initialTranscript: savedVoiceTranscript || "",
    onTranscriptUpdate: (text) => {
      onVoiceDataChangeRef.current?.({ voiceTranscript: text || null });
    },
  });

  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<boolean>("check_voice_archive")
        .then((exists) => {
          if (exists) setHasArchive(true);
        })
        .catch(() => {});
    });
  }, []);

  // Background-gap notice (mobile). While the app is backgrounded / screen-off,
  // the WebView's JS timers freeze, so the LIVE transcript can't advance — but
  // native capture keeps recording the full session into the Refine archive
  // (iOS AVAudioEngine / Android microphone foreground service). On return, make
  // that explicit rather than leaving a silent gap: the audio was preserved and
  // "Refine" re-transcribes + structures the whole recording. Active only while
  // recording; the listener is removed as soon as recording stops.
  useEffect(() => {
    if (!isMobile || !isRecording) return;
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else if (hiddenAt) {
        const gapSec = Math.round((Date.now() - hiddenAt) / 1000);
        hiddenAt = 0;
        if (gapSec >= 5) {
          setVoiceInfo(
            `バックグラウンド中の約${gapSec}秒はライブ表示に反映されませんが、音声は録音され続けています。停止後に「Refine」で全体を文字起こし・構造化できます。`,
          );
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [isRecording]);

  useEffect(() => {
    if (isRecording) {
      setHasArchive(true);
      uploadedChunksRef.current = null;
      // A fresh recording supersedes any prior archive reference — this null is
      // intentional, so bypass the voice-loss guard.
      onVoiceDataChangeRef.current?.({
        voiceGcsUri: null,
        voiceRecordedAt: null,
        __voiceClear: true,
      });
    }
  }, [isRecording]);

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

  useEffect(() => {
    onTranscriptChange?.(fullTranscript);
  }, [fullTranscript, onTranscriptChange]);

  useEffect(() => {
    onRecordingChange?.(isRecording);
  }, [isRecording, onRecordingChange]);

  // Keep refs in sync
  useEffect(() => {
    fullTranscriptRef.current = fullTranscript;
  }, [fullTranscript]);
  useEffect(() => {
    hasArchiveRef.current = hasArchive;
  }, [hasArchive]);
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
    onVoiceDataChangeRef.current = onVoiceDataChange;
  }, [onVoiceDataChange]);
  useEffect(() => {
    savedVoiceGcsUriRef.current = savedVoiceGcsUri;
  }, [savedVoiceGcsUri]);
  useEffect(() => {
    documentIdRef.current = documentId;
  }, [documentId]);
  useEffect(() => {
    refiningRef.current = refining;
  }, [refining]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [fullTranscript, interimText]);

  const doStructure = useCallback(async (manual = false) => {
    const transcript = fullTranscriptRef.current;
    if (!transcript.trim() || structuringRef.current || refiningRef.current)
      return;

    const newPart = lastStructuredRef.current
      ? transcript.slice(lastStructuredRef.current.length).trim()
      : transcript.trim();
    if (!manual && newPart.length < 80) return;

    setStructuring(true);
    structuringRef.current = true;
    const structureStartedAt = Date.now();
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
        "CONSOLIDATION (CRITICAL — the document must be non-redundant): Each distinct topic, decision, fact, definition, number, or conclusion must appear EXACTLY ONCE, in the single most relevant section. Conversations naturally circle back to the same topic — do NOT create a new section, and do NOT restate the point, each time it recurs. Instead, gather everything about a topic into its one section. Never repeat the same conclusion/figure/definition/action item across multiple sections; if it is relevant elsewhere, refer to it in one short phrase rather than duplicating the content. Before finalizing, scan your own output and merge any sections or bullets that cover the same subject. A tight, well-consolidated document is strongly preferred over a long, exhaustive, repetitive one. " +
        "Use speaker information INTERNALLY to understand context and perspectives. NEVER output raw speaker labels like 'Speaker 0', 'speaker1'. If a speaker's name is identifiable from the transcript, use their real name for attribution (e.g., '田中さんが指摘した問題点'). Otherwise describe by role or paraphrase without attribution. " +
        "The transcript contains '---' markers indicating chunk boundaries. Speaker labels are ONLY consistent WITHIN segments between --- markers — the same speaker may have different labels in different segments. Use speech content to identify and unify speakers across segments. " +
        "Omit filler, repetition, backchannel responses, and off-topic tangents. " +
        "Keep the same language as the transcript. Do NOT add generic titles like '会議メモ', '音声メモ', 'Voice Notes'. " +
        "SEPARATION RULE: If web-search supplementary information is provided in the input (a 'Research Context' block), it is NOT part of the meeting and MUST NOT be woven into the minutes body. Place it in a SINGLE dedicated section at the very end of the document, titled '## 補足情報（Web調査）' (translate the title to match the document's language), clearly separated from the meeting minutes. Include ONLY research points that ADD information the minutes do not already contain — never restate a fact, figure, or conclusion that already appears in the body. Keep each supplement concise (a sentence or two) and, where useful, note which meeting topic it supplements. Do NOT create this section if no research information was provided. " +
        "If a 'Questions Context' block is provided, collect those follow-up questions under a SEPARATE trailing section '## 確認したいこと' (match the document's language), placed after '## 補足情報（Web調査）'; they are prompts to ask, NOT facts, and MUST NOT enter the minutes body. Omit if none. " +
        "Output ONLY the structured Markdown, no explanations or meta-commentary. Do not truncate. " +
        'FINALLY, after the document, append a single line: <!--VOCAB:["term1","term2",...]-->  containing up to 50 key proper nouns, person names, technical terms, project names, and specialized vocabulary that appeared in or were corrected from the transcript. Include the CORRECT spelling. This line will be stripped and used to improve future speech recognition — it is NOT part of the document.';

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

      const { useResearchStore } = await import("@/stores/research-store");
      // Weave research either when the global toggle is on, OR when the user
      // queued specific cards ("組み込む") for the next run. Individual queued
      // cards are honored even if the global toggle is off.
      const includeAll = useResearchStore.getState().includeInStructure;
      const includedCards = useResearchStore
        .getState()
        .cards.filter(
          (c) =>
            !c.integrated && c.summary && (includeAll || c.queuedForStructure),
        );
      // Web-research (facts) and speaker-questions (prompts to ask) are woven
      // into SEPARATE trailing sections — never mixed into the minutes body.
      const researchCards = includedCards.filter((c) => c.type !== "question");
      const questionCards = includedCards.filter((c) => c.type === "question");
      if (researchCards.length > 0) {
        userContent +=
          "\n\n## Research Context (web search — SUPPLEMENTARY, NOT meeting content)\n" +
          "The following was gathered via web search during the recording — background reference, NOT something anyone said in the meeting. " +
          "Follow the SEPARATION RULE: put these in the trailing '## 補足情報（Web調査）' section, NOT in the minutes body. " +
          "For EACH item: use a natural H3 heading like '### 〇〇の件について' (never the raw query); write 1–2 concise sentences (do not dump the summary verbatim); include ONLY what adds to the minutes; and, if it clearly supplements a specific meeting section, add a link on its own line — [本文「<見出し>」への補足](#<見出し>) — copying that body heading VERBATIM. Cite sources as markdown links.\n\n" +
          researchCards
            .map((c) => {
              const srcList = c.sources
                .map((s) => `  - [${s.title}](${s.url})`)
                .join("\n");
              return `### ${c.type}: ${c.query}\n${c.summary}\n${srcList}`;
            })
            .join("\n\n");
      }
      if (questionCards.length > 0) {
        userContent += buildQuestionsContext(questionCards);
      }

      const res = await fetch(`${AI_PROXY_URL}/v1/chat`, {
        method: "POST",
        headers: aiProxyHeaders(token),
        body: JSON.stringify({
          system: systemPrompt,
          messages: [{ role: "user", content: userContent }],
          // Max out at opus-5's full 128K streaming ceiling so even very long
          // meetings never truncate. It's a cap, not a charge.
          max_tokens: 128000,
          stream: true,
        }),
      });

      if (!res.ok) {
        reportIfQuota(res.status, await res.text().catch(() => ""));
        throw new Error(`Structure failed: ${res.status}`);
      }

      const structReader = res.body?.getReader();
      if (!structReader) throw new Error("No response body");
      const structDecoder = new TextDecoder();
      let structSseBuffer = "";
      let markdown = "";
      let structStopReason = "";
      while (true) {
        const { done, value } = await structReader.read();
        if (done) break;
        structSseBuffer += structDecoder.decode(value, { stream: true });
        const sseLines = structSseBuffer.split("\n");
        structSseBuffer = sseLines.pop() || "";
        for (const sseLine of sseLines) {
          if (!sseLine.startsWith("data: ")) continue;
          const ssePayload = sseLine.slice(6).trim();
          if (ssePayload === "[DONE]") continue;
          try {
            const sseEvt = JSON.parse(ssePayload);
            if (sseEvt.type === "content_block_delta" && sseEvt.delta?.text) {
              markdown += sseEvt.delta.text;
            } else if (
              sseEvt.type === "message_delta" &&
              sseEvt.delta?.stop_reason
            ) {
              structStopReason = sseEvt.delta.stop_reason;
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }

      // No-silent-failure: warn when the model hit the output cap and truncated.
      // Persistent (no auto-dismiss): the document is about to be replaced with a
      // possibly-truncated result, so the user MUST see this to recover from
      // version history. Cleared by the X button or the next run.
      if (structStopReason === "max_tokens") {
        if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
        setVoiceError(
          "構造化がモデルの最大出力長に達し、末尾が切り捨てられた可能性があります。ドキュメントが短くなっていたらバージョン履歴から復元してください。会議が長い場合は分割をおすすめします。",
        );
      }

      if (markdown.trim()) {
        // Extract vocabulary feedback from <!--VOCAB:[...]-->
        const vocabMatch = markdown.match(
          /<!--\s*VOCAB\s*:\s*(\[.*?\])\s*-->/s,
        );
        let cleanOutput = markdown;
        if (vocabMatch) {
          cleanOutput = markdown.replace(vocabMatch[0], "").trim();
          try {
            const terms: string[] = JSON.parse(vocabMatch[1]);
            for (const t of terms) {
              if (t && t.length >= 2) sttVocabRef.current.add(t);
            }
            console.log(
              `[voice] Extracted ${terms.length} vocab terms for STT hints (total: ${sttVocabRef.current.size})`,
            );
          } catch {
            console.warn("[voice] Failed to parse VOCAB JSON");
          }
        }

        if (hasExisting) {
          onSetContentRef.current(cleanOutput);
        } else {
          onInsertRef.current(`\n\n${cleanOutput}\n`);
        }
        lastStructuredRef.current = transcript;
        setLastStructuredText(transcript);
        track("structure_completed", {
          manual,
          ms: Date.now() - structureStartedAt,
          output_chars: cleanOutput.length,
          new_chars: newPart.length,
          has_existing: hasExisting,
          research_cards: includedCards.length,
          stop_reason: structStopReason,
        });
        // Mark only the cards we actually wove in (clears their queued flag);
        // don't touch cards that weren't included this run. Covers both
        // research and question cards.
        if (includedCards.length > 0) {
          const store = useResearchStore.getState();
          for (const c of includedCards) store.markIntegrated(c.id);
        }
      }
    } catch (err) {
      console.error("[voice] Structuring failed:", err);
      const statusMatch = /Structure failed: (\d{3})/.exec(
        err instanceof Error ? err.message : "",
      );
      track("structure_failed", {
        manual,
        ms: Date.now() - structureStartedAt,
        status: statusMatch ? Number(statusMatch[1]) : 0,
      });
      // Surface the failure so a manual "Structure" click never fails silently
      // (the user would otherwise stare at an unchanged document). Auto-runs
      // stay quiet — they retry on the next interval, and quota 429s already
      // raise the global banner via reportIfQuota().
      if (manual) {
        // Never echo the raw upstream message/status — route through the shared
        // classifier so the user only ever sees a localized, friendly reason.
        setVoiceError(friendlyErrorMessage(err, "voice"));
        if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
        errorTimerRef.current = setTimeout(() => setVoiceError(null), 12000);
      }
    } finally {
      setStructuring(false);
      structuringRef.current = false;
    }
  }, []);

  const doRefine = useCallback(async () => {
    const docId = documentIdRef.current;
    const refineStore = useRefineStore.getState();
    const prevState = refineStore.byDoc[docId];
    if (!docId || isRefineBusy(prevState)) return;
    const transcript = fullTranscriptRef.current;
    // Refine re-transcribes the recording from its native archive, so it does
    // NOT require a live transcript: a fully-backgrounded session has an empty
    // live transcript (JS timers were frozen) but the complete audio was still
    // captured. Proceed whenever an archive — or a previously uploaded URI —
    // exists, even with no live text.
    if (
      !transcript.trim() &&
      !hasArchiveRef.current &&
      !savedVoiceGcsUriRef.current
    )
      return;

    const startedAt = Date.now();
    refineStore.begin(docId, "");
    // Only the upload happens on this device; everything after it is a
    // server-side job that keeps running if the app goes away.
    let stage: "upload" | "transcribe" = "upload";
    try {
      const user = useAuthStore.getState().user;
      if (!user) throw new Error("Not authenticated");
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error("No token");
      const uid = user.uid;
      const bucket = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET;
      if (!bucket) throw new Error("Storage bucket not configured");

      // Stage 1: Upload audio archive → chunks (skip if already uploaded this
      // session). Recordings >18min are split into ≤18min parts (20s overlap) to
      // stay under BatchRecognize's ~20min inline-results limit.
      let chunks = uploadedChunksRef.current;
      if (chunks) {
        console.log(
          "[voice] Reusing uploaded chunks for refine retry:",
          chunks.length,
        );
      } else {
        const { invoke } = await import("@tauri-apps/api/core");

        let androidArchivePath: string | undefined;
        if (isAndroid) {
          const bridge = (window as unknown as Record<string, unknown>)
            .AndroidAudio as
            | {
                getArchivePath?: () => string | null;
              }
            | undefined;
          const p = bridge?.getArchivePath?.();
          if (!p) throw new Error("No voice archive available on this device");
          androidArchivePath = p;
        }

        try {
          const archiveResult = await invoke<{
            gcs_uri: string;
            download_url: string;
            chunks: Array<{
              gcs_uri: string;
              start_sec: number;
              duration_sec: number;
            }>;
          }>("upload_voice_archive", {
            uid,
            token,
            bucket,
            archivePath: androidArchivePath,
          });
          chunks = (archiveResult.chunks || []).map((c) => ({
            gcsUri: c.gcs_uri,
            startSec: c.start_sec,
            durationSec: c.duration_sec,
          }));
          if (chunks.length === 0 && archiveResult.gcs_uri) {
            chunks = [
              { gcsUri: archiveResult.gcs_uri, startSec: 0, durationSec: 0 },
            ];
          }
          uploadedChunksRef.current = chunks;
          onVoiceDataChangeRef.current?.({
            voiceGcsUri: chunks[0]?.gcsUri || null,
            voiceRecordedAt: Date.now(),
          });
        } catch (e) {
          // Archive gone (app restart / temp cleanup, or a doc whose voice
          // metadata was recovered from the cloud) but a prior GCS URI was saved.
          // Re-derive chunks from the stored WAV: a long single file would exceed
          // BatchRecognize's ~20min inline limit, so Rust downloads it and
          // re-splits into ≤18min overlapping parts (short files come back
          // unchanged, no re-upload).
          if (savedVoiceGcsUriRef.current) {
            const prepared = await invoke<{
              gcs_uri: string;
              download_url: string;
              chunks: Array<{
                gcs_uri: string;
                start_sec: number;
                duration_sec: number;
              }>;
            }>("prepare_gcs_voice_chunks", {
              uid,
              token,
              bucket,
              gcsUri: savedVoiceGcsUriRef.current,
            });
            chunks = (prepared.chunks || []).map((c) => ({
              gcsUri: c.gcs_uri,
              startSec: c.start_sec,
              durationSec: c.duration_sec,
            }));
            if (chunks.length === 0) {
              chunks = [
                {
                  gcsUri: savedVoiceGcsUriRef.current,
                  startSec: 0,
                  durationSec: 0,
                },
              ];
            }
            uploadedChunksRef.current = chunks;
          } else {
            throw e;
          }
        }
      }

      stage = "transcribe";
      const audioKey = JSON.stringify(
        chunks.map((c) => [c.gcsUri, c.startSec, c.durationSec]),
      );

      // Re-running Refine on the same audio after a failure whose transcript was
      // already saved: resume that job so speech-to-text isn't paid for twice.
      if (
        prevState?.phase === "error" &&
        prevState.jobId &&
        prevState.audioKey === audioKey &&
        (prevState.job?.transcriptChars ?? 0) > 0
      ) {
        refineStore.patch(docId, {
          jobId: prevState.jobId,
          job: prevState.job,
          audioKey,
          phase: "structure",
        });
        track("refine_resumed", {
          reason: "rerun",
          stage: "structure",
          has_transcript: true,
        });
        await runRefineStream(docId, { jobId: prevState.jobId, resume: true });
        return;
      }

      // The prompt is built server-side from these inputs (see
      // server/ai-proxy/refine.ts). The hash of the document as it is now lets
      // the result be applied automatically only if nothing changed meanwhile.
      const existingRaw = docContentRef.current;
      const existingDoc = existingRaw.trim();
      const { useResearchStore: getResearchStore } =
        await import("@/stores/research-store");
      // Weave research when the global toggle is on OR specific cards were
      // queued for the next run ("組み込む").
      const includeAllRefine = getResearchStore.getState().includeInStructure;
      const refineIncludedCards = getResearchStore
        .getState()
        .cards.filter(
          (c) =>
            !c.integrated &&
            c.summary &&
            (includeAllRefine || c.queuedForStructure),
        );
      const refineResearchCards = refineIncludedCards.filter(
        (c) => c.type !== "question",
      );
      const refineQuestionCards = refineIncludedCards.filter(
        (c) => c.type === "question",
      );
      const body: CreateRefineJobBody = {
        jobId: newRefineJobId(),
        docId,
        language: "ja-JP",
        chunks,
        baseContentHash: await sha256Hex(existingRaw),
        existingDoc,
        vocabulary: existingDoc ? extractHints(existingDoc).slice(0, 100) : [],
        researchCards: refineResearchCards.map((c) => ({
          type: c.type,
          query: c.query,
          summary: c.summary,
          sources: c.sources.map((src) => ({ title: src.title, url: src.url })),
        })),
        questionCards: refineQuestionCards.map((c) => ({ summary: c.summary })),
        includedCardIds: refineIncludedCards.map((c) => c.id),
      };
      refineStore.patch(docId, { audioKey });
      track("refine_started", {
        chunks: chunks.length,
        audio_sec: Math.round(
          chunks.reduce((sum, c) => sum + (c.durationSec || 0), 0),
        ),
        doc_chars: existingDoc.length,
        research_cards: refineResearchCards.length,
        question_cards: refineQuestionCards.length,
        upload_ms: Date.now() - startedAt,
      });
      await runRefineStream(docId, body);
    } catch (err) {
      console.error("[voice] Refine failed:", err);
      recordLocalRefineFailure(docId, err, stage);
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

  // Cleanup on unmount: clear the error timer. A running Refine is NOT
  // cancelled — it is a server-side job the Editor keeps following.
  useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

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
        <div
          className="px-4 py-2 text-xs text-destructive bg-destructive/10 border-b border-destructive/20 cursor-pointer"
          onClick={() => setVoiceError(null)}
          title="Click to dismiss"
        >
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
          {fullTranscript &&
            (() => {
              // Segments already covered by the last Structure run. The divider
              // above the first NOT-yet-structured segment marks where Structure
              // most recently ran, and gets highlighted.
              const structuredCount = lastStructuredText
                ? toTranscriptSegments(lastStructuredText).length
                : 0;
              return toTranscriptSegments(fullTranscript).map((seg, i) => {
                const isStructureBoundary = i > 0 && i === structuredCount;
                return (
                  <div
                    key={i}
                    className={
                      i === 0
                        ? ""
                        : isStructureBoundary
                          ? "mt-2 border-t-2 border-primary pt-2"
                          : "mt-2 border-t border-border pt-2"
                    }
                  >
                    {isStructureBoundary && (
                      <span className="mb-1 block text-[10px] font-medium text-primary">
                        最新の構造化位置
                      </span>
                    )}
                    <span className="text-foreground">{seg}</span>
                  </div>
                );
              });
            })()}
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
      <div
        className={`flex items-center border-t border-border/50 ${isMobile ? "gap-1.5 px-2 py-2 overflow-x-auto" : "gap-2 px-3 py-2"}`}
      >
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

        {isTauri && isDesktop && audioDevices.length > 0 && !isRecording && (
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
          className={`rounded-md border border-input bg-background text-[11px] outline-none shrink-0 ${isMobile ? "h-8 px-2" : "h-7 px-2"}`}
          value={autoStructureInterval}
          onChange={(e) => setAutoStructureInterval(Number(e.target.value))}
        >
          <option value={0}>{isMobile ? "手動" : "Manual"}</option>
          <option value={60}>1min</option>
          <option value={120}>2min</option>
          <option value={180}>3min</option>
          <option value={300}>5min</option>
        </select>

        {isRecording && !isMobile && <ResearchTriggerButton />}
        {isMobile && <MobileResearchButton />}

        <Button
          variant="outline"
          size="sm"
          className="gap-1 text-xs shrink-0"
          onClick={() => doStructure(true)}
          disabled={!fullTranscript.trim() || structuring}
          title="Structure"
        >
          {structuring ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          Structure
        </Button>

        {isTauri && !isRecording && (hasArchive || !!savedVoiceGcsUri) && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-xs shrink-0"
            onClick={() => doRefine()}
            disabled={refining || structuring}
            title="Refine"
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
          className={`shrink-0 ${isMobile ? "h-8 w-8" : "h-7 w-7"}`}
          onClick={() => {
            clearTranscript();
            lastStructuredRef.current = "";
            setLastStructuredText("");
            sttVocabRef.current.clear();
            uploadedChunksRef.current = null;
            setHasArchive(false);
            // Explicit user intent to discard voice data — bypass the guard.
            onVoiceDataChangeRef.current?.({
              voiceTranscript: null,
              voiceGcsUri: null,
              voiceRecordedAt: null,
              __voiceClear: true,
            });
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
          <span
            className={`text-[10px] ml-1 ${refineStage === "upload" ? "text-amber-500" : ""}`}
          >
            {refineStage === "upload"
              ? "— アップロードが終わるまでアプリを閉じないでください"
              : "— サーバーで処理中です。アプリを閉じても続きます"}
          </span>
        </div>
      )}
    </div>
  );
}
