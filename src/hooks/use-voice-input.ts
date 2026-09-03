import { useState, useRef, useCallback, useEffect } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { aiProxyHeaders, reportIfQuota } from "@/services/ai-proxy";
import { friendlyErrorMessage, FriendlyError } from "@/lib/friendly-error";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";
const CHUNK_MS = 25000; // 25 second chunks: longer context = better accuracy
const MAX_DURATION_SECONDS = 4 * 60 * 60; // 4 hours hard limit
const MAX_SEND_RETRIES = 2;

// Shown (calmly, in amber) when a LIVE segment can't be transcribed but the
// audio is safe: native capture keeps the full recording and Refine re-runs it.
// This is explicit surfacing, not a silent fallback — the miss AND the remedy
// are made visible so the user isn't alarmed by a raw status code.
const LIVE_SEGMENT_RECOVERABLE_MSG =
  "この区間はライブ表示に取り込めませんでしたが、録音は継続しています。停止後に「Refine」で全体を文字起こし・構造化できます。";

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
  preferDiarization?: boolean;
  onMaxDuration?: () => void;
  initialTranscript?: string;
  onTranscriptUpdate?: (fullTranscript: string) => void;
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

// Split a base64 LINEAR16 (16-bit PCM, mono) buffer into base64 segments each
// ≤ maxSeconds. On Android the native mic bridge keeps recording while the app
// is backgrounded, but the WebView's JS timers freeze — so the first tick after
// returning to the foreground hands back the ENTIRE accumulated buffer (minutes
// of audio) in one getChunk(). The synchronous STT endpoint rejects over-length
// inline audio (~60s → 400 INVALID_ARGUMENT), so we cap each request here,
// mirroring the desktop/Rust path (get_voice_chunk's ~25s cap + drain loop).
// Boundaries stay on 2-byte sample edges (maxBytes is even). Returns the input
// unchanged when already within the limit — the common foreground case pays no
// decode/re-encode cost. Exported for unit testing.
export function splitLinear16Base64(
  base64: string,
  maxSeconds: number,
  sampleRate: number,
): string[] {
  const maxBytes = Math.floor(maxSeconds) * sampleRate * 2; // 2 bytes/sample
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return [base64];
  }
  if (binary.length <= maxBytes) return [base64];
  const segments: string[] = [];
  for (let off = 0; off < binary.length; off += maxBytes) {
    segments.push(btoa(binary.slice(off, off + maxBytes)));
  }
  return segments;
}

export function useVoiceInput({
  language = "ja-JP",
  deviceName,
  systemAudio,
  onTranscript,
  onError,
  onInfo,
  getHints,
  preferDiarization,
  onMaxDuration,
  initialTranscript,
  onTranscriptUpdate,
}: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [fullTranscript, setFullTranscript] = useState(initialTranscript || "");
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
  const startTimeRef = useRef(0);
  const transcriptRef = useRef(initialTranscript || "");
  const onTranscriptRef = useRef(onTranscript);
  const onTranscriptUpdateRef = useRef(onTranscriptUpdate);
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
  useEffect(() => {
    onTranscriptUpdateRef.current = onTranscriptUpdate;
  }, [onTranscriptUpdate]);

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

      const user = useAuthStore.getState().user;
      if (!user) {
        console.warn("[voice] No authenticated user — skipping transcription");
        return;
      }

      const base64 =
        typeof input === "string" ? input : await blobToBase64(input);
      if (!base64) return;

      const byteLen = Math.round((base64.length * 3) / 4);
      console.log(
        `[voice] Sending chunk: ${byteLen} bytes, encoding=${meta?.encoding}, rate=${meta?.sampleRate}`,
      );

      const requestBody = JSON.stringify({
        audio: base64,
        language,
        ...(meta
          ? {
              encoding: meta.encoding,
              sampleRate: meta.sampleRate,
              channels: 1,
            }
          : {}),
        ...(!preferDiarization && getHintsRef.current
          ? { hints: getHintsRef.current() }
          : {}),
      });

      for (let attempt = 0; attempt <= MAX_SEND_RETRIES; attempt++) {
        try {
          const token = await user.getIdToken();
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 60_000);
          const res = await fetch(`${AI_PROXY_URL}/v1/voice/transcribe`, {
            method: "POST",
            headers: aiProxyHeaders(token),
            body: requestBody,
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (!res.ok) {
            const errText = await res.text();
            console.error("[voice] Transcription failed:", res.status, errText);
            const wasQuota = reportIfQuota(res.status, errText);
            if (res.status >= 500 && attempt < MAX_SEND_RETRIES) {
              console.log(
                `[voice] Retrying (${attempt + 1}/${MAX_SEND_RETRIES})...`,
              );
              await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
              continue;
            }
            if (wasQuota) return; // quota upsell banner speaks — don't double-message
            // A dropped LIVE segment is recoverable on native platforms: capture
            // keeps the full recording and Refine re-transcribes it. For an
            // over-length request (400 — e.g. a buffer accumulated while
            // backgrounded) or a transient upstream failure (5xx), surface this
            // calmly instead of a raw status code. Not silent: the miss and the
            // remedy are both shown (amber Info).
            if (isTauri && (res.status === 400 || res.status >= 500)) {
              onInfoRef.current?.(LIVE_SEGMENT_RECOVERABLE_MSG);
            } else {
              // Classify off the status (never surface the raw code/body).
              onErrorRef.current?.(
                friendlyErrorMessage(`${res.status} ${errText}`, "voice"),
              );
            }
            return;
          }

          const data = await res.json();
          console.log("[voice] STT response:", JSON.stringify(data));
          const text = data.text?.trim();
          if (text) {
            const isHallucination = (() => {
              if (/^(.{1,5}[、。,.!？\s]*)\1{2,}$/.test(text)) return true;
              if (/^[えあうんはへほ、。\s]{2,}$/.test(text)) return true;
              if (
                /^(ご視聴ありがとうございました|チャンネル登録|字幕|おやすみなさい)[。.]?$/.test(
                  text,
                )
              )
                return true;
              if (/^[\d、。,.\s-]+$/.test(text)) return true;
              if (
                text.length <= 2 &&
                /^[えあうんはへほおいのでがをにと]$/.test(text)
              )
                return true;
              if (
                /^(はい|うん|ええ|そう|そうですね|なるほど|そっか|ふーん|へー|ああ|おお|それで|それから|でも|だから|けど|ただ|まあ)[、。.!？\s]*$/.test(
                  text,
                )
              )
                return true;
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
              const repMatch = text.match(/(.{2,8}[、。,.!？\s]*)\1{3,}/);
              if (repMatch && repMatch[0].length > text.length * 0.3)
                return true;
              if (text.length > 100) {
                const words = text
                  .replace(/[、。,.!？\s]+/g, " ")
                  .trim()
                  .split(" ");
                const freq = new Map<string, number>();
                for (const w of words) {
                  if (w.length >= 1) freq.set(w, (freq.get(w) || 0) + 1);
                }
                for (const [, count] of freq) {
                  if (count >= 10 && count > words.length * 0.4) return true;
                }
              }
              return false;
            })();
            if (isHallucination) {
              console.warn("[voice] Suppressed hallucination:", text);
            } else {
              const displayText = data.taggedText || text;
              transcriptRef.current +=
                (transcriptRef.current ? "\n---\n" : "") + displayText;
              setFullTranscript(transcriptRef.current);
              setInterimText(text);
              onTranscriptRef.current?.(text);
            }
          }
          return;
        } catch (err) {
          const isAbort =
            err instanceof Error &&
            (err.name === "AbortError" || /abort/i.test(err.message));
          const isNetwork =
            err instanceof TypeError && /fetch|network/i.test(err.message);

          if ((isAbort || isNetwork) && attempt < MAX_SEND_RETRIES) {
            console.warn(
              `[voice] ${isAbort ? "Fetch aborted" : "Network error"}, retrying (${attempt + 1}/${MAX_SEND_RETRIES})...`,
            );
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
            continue;
          }
          console.error("[voice] Transcription error:", err);
          // Retries are exhausted. The AbortController here is fired ONLY by the
          // 60s timeout above (there is no external/intentional abort of this
          // fetch), so an abort at this point means this live segment was lost.
          // On native platforms the full recording is archived and Refine
          // re-transcribes it, so surface it calmly (amber) rather than as a
          // hard error — explicitly, never silently.
          if (isTauri) {
            onInfoRef.current?.(LIVE_SEGMENT_RECOVERABLE_MSG);
          } else {
            onErrorRef.current?.(
              isAbort
                ? "音声区間の文字起こしがタイムアウトしました。この区間は取り込めていない可能性があります。"
                : friendlyErrorMessage(err, "voice"),
            );
          }
          return;
        }
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
      onErrorRef.current?.("このデバイスでは音声入力に対応していません。");
      return;
    }

    stopRecording();

    try {
      const androidAudio = getAndroidAudio();
      if (isAndroid) {
        // Android: native AudioRecord via JS bridge
        if (!androidAudio) {
          throw new FriendlyError(
            "音声キャプチャの初期化中です。数秒後にもう一度お試しください。",
          );
        }
        const bridge = androidAudio;
        if (!bridge.hasPermission()) {
          throw new FriendlyError(
            "マイクへのアクセスが拒否されました。設定 → アプリ → MarkFlow → 権限 でマイクを許可してください。",
          );
        }
        const ok = bridge.start();
        if (!ok) throw new FriendlyError("マイクの起動に失敗しました。");
        chunkIntervalRef.current = setInterval(async () => {
          try {
            const chunk = bridge.getChunk();
            if (chunk) {
              // A single getChunk() can span far more than CHUNK_MS when JS
              // timers were frozen (app backgrounded): the bridge returns the
              // whole accumulated buffer on the first foreground tick. Split it
              // into ≤CHUNK_MS segments so an over-length request never hits the
              // synchronous STT limit (would 400). Foreground ticks are already
              // within the limit → returned as-is (single send).
              const segments = splitLinear16Base64(
                chunk,
                CHUNK_MS / 1000,
                16000,
              );
              if (segments.length > 1) {
                console.log(
                  `[voice] Android background catchup: split into ${segments.length} segments`,
                );
              }
              for (const seg of segments) {
                await sendChunk(seg, {
                  encoding: "LINEAR16",
                  sampleRate: 16000,
                });
              }
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
            // Loop to drain all accumulated chunks (handles background throttling)
            let drained = 0;
            while (true) {
              const result = await inv<{
                audio: string;
                sample_rate: number;
              } | null>("get_voice_chunk");
              if (!result) break;
              drained++;
              console.log(
                `[voice] Got chunk ${drained} from Rust: ${result.audio.length} base64 chars, rate=${result.sample_rate}`,
              );
              if (chunkQueue.length >= MAX_QUEUE) {
                console.warn("[voice] Queue full, dropping oldest chunk");
                chunkQueue.shift();
              }
              chunkQueue.push(result);
              processQueue();
            }
            if (drained === 0) {
              console.log("[voice] No audio data in buffer");
            } else if (drained > 1) {
              console.log(
                `[voice] Drained ${drained} chunks (background catchup)`,
              );
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
          console.error("[voice] getUserMedia failed:", msg);
          if (msg.includes("Permission") || msg.includes("NotAllowed")) {
            throw new FriendlyError(
              "マイクへのアクセスが拒否されました。設定でマイク権限を許可してください。",
            );
          }
          // Never surface the raw getUserMedia message — keep it mic-specific
          // and friendly (the raw reason is logged above for debugging).
          throw new FriendlyError(
            "マイクの起動に失敗しました。ほかのアプリがマイクを使用していないか、デバイスの接続をご確認のうえ、もう一度お試しください。",
          );
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
      startTimeRef.current = Date.now();
      setDuration(0);
      durationIntervalRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
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
      // FriendlyError messages (permission/mic guidance above) pass through
      // verbatim; anything else is classified to a localized reason — the raw
      // text never reaches the UI.
      console.error("[voice] startRecording failed:", err);
      onErrorRef.current?.(friendlyErrorMessage(err, "voice"));
      stopRecording();
    }
  }, [isSupported, stopRecording, sendChunk, deviceName, systemAudio]);

  const toggle = useCallback(() => {
    if (isRecording) stopRecording();
    else startRecording();
  }, [isRecording, startRecording, stopRecording]);

  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    onTranscriptUpdateRef.current?.(fullTranscript);
  }, [fullTranscript]);

  const clearTranscript = useCallback(() => {
    transcriptRef.current = "";
    setFullTranscript("");
    setInterimText("");
  }, []);

  // Follow the host's saved transcript when it swaps to a different one — e.g.
  // switching documents. The panel is normally remounted (keyed by doc id), but
  // this guarantees the transcript stays tied to the active document even if the
  // instance is reused: never show one document's transcript on another. Never
  // clobber a live recording in progress.
  const lastInitialRef = useRef(initialTranscript);
  useEffect(() => {
    if (initialTranscript === lastInitialRef.current) return;
    lastInitialRef.current = initialTranscript;
    if (isRecording) return;
    transcriptRef.current = initialTranscript || "";
    setFullTranscript(initialTranscript || "");
    setInterimText("");
  }, [initialTranscript, isRecording]);

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
