import { useState, useRef, useCallback, useEffect } from "react";
import { useAuthStore } from "@/stores/auth-store";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";
const CHUNK_MS = 25000; // 25 second chunks: longer context = better accuracy
const MAX_DURATION_SECONDS = 4 * 60 * 60; // 4 hours hard limit

import { isAndroid } from "@/platform";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const useTauriAudio = isTauri && !isAndroid;
const getAndroidAudio = () =>
  isAndroid ? (window as unknown as Record<string, any>).AndroidAudio : null;

export interface UseVoiceInputOptions {
  language?: string;
  deviceName?: string;
  systemAudio?: boolean;
  onTranscript?: (text: string) => void;
  onError?: (error: string) => void;
  onInfo?: (message: string) => void;
  getHints?: () => string[];
  onMaxDuration?: () => void;
}

export interface UseVoiceInputReturn {
  isRecording: boolean;
  isSupported: boolean;
  interimText: string;
  fullTranscript: string;
  duration: number;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  clearTranscript: () => void;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(",")[1] || "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function useVoiceInput({
  language = "ja-JP",
  deviceName,
  systemAudio,
  onTranscript,
  onError,
  onInfo,
  getHints,
  onMaxDuration,
}: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [interimText, setInterimText] = useState("");
  const savedTranscript = (() => {
    try {
      return localStorage.getItem("voice_transcript") || "";
    } catch {
      return "";
    }
  })();
  const [fullTranscript, setFullTranscript] = useState(savedTranscript);
  const [duration, setDuration] = useState(0);

  const isSupported = typeof navigator !== "undefined";

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const transcriptRef = useRef(savedTranscript);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  const onInfoRef = useRef(onInfo);
  const getHintsRef = useRef(getHints);
  const onMaxDurationRef = useRef(onMaxDuration);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    onInfoRef.current = onInfo;
  }, [onInfo]);
  useEffect(() => {
    getHintsRef.current = getHints;
  }, [getHints]);
  useEffect(() => {
    onMaxDurationRef.current = onMaxDuration;
  }, [onMaxDuration]);

  const sendChunk = useCallback(
    async (
      input: Blob | string,
      meta?: { encoding: string; sampleRate: number },
    ) => {
      if (typeof input === "string") {
        if (!input) return;
      } else {
        if (input.size < 200) return;
      }

      try {
        const user = useAuthStore.getState().user;
        if (!user) {
          console.warn(
            "[voice] No authenticated user — skipping transcription",
          );
          return;
        }
        const token = await user.getIdToken();

        const base64 =
          typeof input === "string" ? input : await blobToBase64(input);
        if (!base64) return;

        const byteLen = Math.round((base64.length * 3) / 4);
        console.log(
          `[voice] Sending chunk: ${byteLen} bytes, encoding=${meta?.encoding}, rate=${meta?.sampleRate}`,
        );

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60_000);
        const res = await fetch(`${AI_PROXY_URL}/v1/voice/transcribe`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            audio: base64,
            language,
            ...(meta
              ? {
                  encoding: meta.encoding,
                  sampleRate: meta.sampleRate,
                  channels: 1,
                }
              : {}),
            ...(getHintsRef.current ? { hints: getHintsRef.current() } : {}),
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
          const errText = await res.text();
          console.error("[voice] Transcription failed:", res.status, errText);
          onErrorRef.current?.(`Transcription error: ${res.status}`);
          return;
        }

        const data = await res.json();
        console.log("[voice] STT response:", JSON.stringify(data));
        const text = data.text?.trim();
        if (text) {
          // Multi-pattern hallucination suppression
          const isHallucination = (() => {
            // 1. Entire text is a repeated short phrase (3+ occurrences)
            if (/^(.{1,5}[、。,.!？\s]*)\1{2,}$/.test(text)) return true;
            // 2. Single filler character repeated with punctuation
            if (/^[えあうんはへほ、。\s]{2,}$/.test(text)) return true;
            // 3. Common STT silence hallucinations (Japanese)
            if (
              /^(ご視聴ありがとうございました|チャンネル登録|字幕|おやすみなさい)[。.]?$/.test(
                text,
              )
            )
              return true;
            // 4. Only numbers/punctuation (noise artifacts)
            if (/^[\d、。,.\s-]+$/.test(text)) return true;
            // 5. Very short text (1-2 chars) that's just a filler
            if (
              text.length <= 2 &&
              /^[えあうんはへほおいのでがをにと]$/.test(text)
            )
              return true;
            // 6. Standalone backchannel responses (相槌・接続詞)
            if (
              /^(はい|うん|ええ|そう|そうですね|なるほど|そっか|ふーん|へー|ああ|おお|それで|それから|でも|だから|けど|ただ|まあ)[、。.!？\s]*$/.test(
                text,
              )
            )
              return true;
            // 7. Repeated common words with varied punctuation
            if (
              text.length <= 30 &&
              /^(はい|うん|ええ|そう)[、。,.!？\s]*(はい|うん|ええ|そう)[、。,.!？\s]*/.test(
                text,
              ) &&
              !/[ぁ-ん]{3,}/.test(
                text.replace(/(はい|うん|ええ|そう)[、。,.!？\s]*/g, ""),
              )
            )
              return true;
            // 8. A short phrase repeated 4+ times covers >50% of text (allows prefix)
            const repMatch = text.match(/(.{2,8}[、。,.!？\s]*)\1{3,}/);
            if (repMatch && repMatch[0].length > text.length * 0.5) return true;
            return false;
          })();
          if (isHallucination) {
            console.warn("[voice] Suppressed hallucination:", text);
          } else {
            const displayText = data.taggedText || text;
            transcriptRef.current +=
              (transcriptRef.current ? " " : "") + displayText;
            setFullTranscript(transcriptRef.current);
            setInterimText(text);
            onTranscriptRef.current?.(text);
          }
        }
      } catch (err) {
        console.error("[voice] Transcription error:", err);
        onErrorRef.current?.(`Transcription error: ${err}`);
      }
    },
    [language],
  );

  const stopRecording = useCallback(() => {
    const androidBridge = getAndroidAudio();
    if (androidBridge) {
      try {
        androidBridge.stop();
      } catch {}
    } else if (useTauriAudio) {
      import("@tauri-apps/api/core").then(({ invoke }) => {
        invoke("stop_voice_recording").catch(() => {});
      });
    }

    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (chunkIntervalRef.current) clearInterval(chunkIntervalRef.current);
    if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
    if (maxDurationTimerRef.current) clearTimeout(maxDurationTimerRef.current);
    chunkIntervalRef.current = null;
    durationIntervalRef.current = null;
    maxDurationTimerRef.current = null;
    setIsRecording(false);
    setInterimText("");
  }, []);

  const startRecording = useCallback(async () => {
    if (!isSupported) {
      onErrorRef.current?.("Voice input is not supported");
      return;
    }

    stopRecording();

    try {
      const androidAudio = getAndroidAudio();
      if (isAndroid) {
        // Android: native AudioRecord via JS bridge
        if (!androidAudio) {
          throw new Error(
            "音声キャプチャの初期化中です。数秒後にもう一度お試しください。",
          );
        }
        const bridge = androidAudio;
        if (!bridge.hasPermission()) {
          throw new Error(
            "マイクへのアクセスが拒否されました。設定 → アプリ → MarkFlow → 権限 でマイクを許可してください。",
          );
        }
        const ok = bridge.start();
        if (!ok) throw new Error("マイクの起動に失敗しました。");
        chunkIntervalRef.current = setInterval(async () => {
          try {
            const chunk = bridge.getChunk();
            if (chunk) {
              await sendChunk(chunk, {
                encoding: "LINEAR16",
                sampleRate: 16000,
              });
            }
          } catch (e) {
            console.error("[voice] Android chunk error:", e);
          }
        }, CHUNK_MS);
      } else if (useTauriAudio) {
        // Rust audio capture (macOS/Windows)
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<string>("start_voice_recording", {
          deviceName: deviceName || null,
          systemAudio: systemAudio || false,
        });
        if (result && result.startsWith("mic_unavailable:")) {
          onInfoRef.current?.(
            "マイクが見つかりません（システム音声のみで録音中）",
          );
        } else if (result && result.startsWith("sys_audio_failed:")) {
          onInfoRef.current?.(
            "システム音声の録音に失敗しました（マイクのみで録音中）",
          );
        }

        // Poll Rust buffer every CHUNK_MS and send to transcription API.
        // Use a queue to avoid losing audio chunks during API calls.
        const MAX_QUEUE = 30; // prevent unbounded memory growth
        const chunkQueue: Array<{ audio: string; sample_rate: number }> = [];
        let sending = false;

        const processQueue = async () => {
          if (sending || chunkQueue.length === 0) return;
          sending = true;
          const item = chunkQueue.shift()!;
          try {
            await sendChunk(item.audio, {
              encoding: "LINEAR16",
              sampleRate: item.sample_rate,
            });
          } finally {
            sending = false;
            // Process next queued chunk if any
            if (chunkQueue.length > 0) processQueue();
          }
        };

        chunkIntervalRef.current = setInterval(async () => {
          try {
            const { invoke: inv } = await import("@tauri-apps/api/core");
            const result = await inv<{
              audio: string;
              sample_rate: number;
            } | null>("get_voice_chunk");
            if (result) {
              console.log(
                `[voice] Got chunk from Rust: ${result.audio.length} base64 chars, rate=${result.sample_rate}`,
              );
              if (chunkQueue.length >= MAX_QUEUE) {
                console.warn("[voice] Queue full, dropping oldest chunk");
                chunkQueue.shift();
              }
              chunkQueue.push(result);
              processQueue();
            } else {
              console.log("[voice] No audio data in buffer");
            }
          } catch (e) {
            console.error("[voice] Chunk error:", e);
          }
        }, CHUNK_MS);
      } else {
        // Browser fallback: getUserMedia + MediaRecorder
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(
            "マイクAPIが利用できません。設定でマイク権限を許可してください。",
          );
        }
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              sampleRate: { ideal: 16000 },
              channelCount: { ideal: 1 },
              echoCancellation: true,
              noiseSuppression: true,
            },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("Permission") || msg.includes("NotAllowed")) {
            throw new Error(
              "マイクへのアクセスが拒否されました。設定でマイク権限を許可してください。",
            );
          }
          throw new Error(`マイクの起動に失敗しました: ${msg}`);
        }
        streamRef.current = stream;

        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : MediaRecorder.isTypeSupported("audio/mp4")
            ? "audio/mp4"
            : undefined;

        let chunks: Blob[] = [];

        const createRecorder = () => {
          const rec = new MediaRecorder(
            stream,
            mimeType ? { mimeType } : undefined,
          );
          chunks = [];

          rec.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
          };

          rec.onstop = () => {
            if (chunks.length > 0) {
              const blob = new Blob(chunks, { type: rec.mimeType });
              sendChunk(blob);
            }
          };

          rec.start();
          return rec;
        };

        recorderRef.current = createRecorder();

        chunkIntervalRef.current = setInterval(() => {
          const rec = recorderRef.current;
          if (rec && rec.state === "recording") {
            rec.stop();
            recorderRef.current = createRecorder();
          }
        }, CHUNK_MS);
      }

      // Common setup for both paths
      setDuration(0);
      durationIntervalRef.current = setInterval(() => {
        setDuration((d) => d + 1);
      }, 1000);

      // Auto-stop after MAX_DURATION_SECONDS
      maxDurationTimerRef.current = setTimeout(() => {
        stopRecording();
        onMaxDurationRef.current?.();
      }, MAX_DURATION_SECONDS * 1000);

      setIsRecording(true);
      transcriptRef.current = "";
      setFullTranscript("");
      setInterimText("");
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Failed to start recording";
      onErrorRef.current?.(msg);
      stopRecording();
    }
  }, [isSupported, stopRecording, sendChunk, deviceName, systemAudio]);

  const toggle = useCallback(() => {
    if (isRecording) stopRecording();
    else startRecording();
  }, [isRecording, startRecording, stopRecording]);

  useEffect(() => {
    try {
      if (fullTranscript)
        localStorage.setItem("voice_transcript", fullTranscript);
      else localStorage.removeItem("voice_transcript");
    } catch {}
  }, [fullTranscript]);

  const clearTranscript = useCallback(() => {
    transcriptRef.current = "";
    setFullTranscript("");
    setInterimText("");
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (useTauriAudio) {
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("stop_voice_recording").catch(() => {});
        });
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (chunkIntervalRef.current) clearInterval(chunkIntervalRef.current);
      if (durationIntervalRef.current)
        clearInterval(durationIntervalRef.current);
      if (maxDurationTimerRef.current)
        clearTimeout(maxDurationTimerRef.current);
    };
  }, []);

  return {
    isRecording,
    isSupported,
    interimText,
    fullTranscript,
    duration,
    start: startRecording,
    stop: stopRecording,
    toggle,
    clearTranscript,
  };
}
