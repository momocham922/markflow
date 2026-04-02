import { useState, useRef, useCallback, useEffect } from "react";
import { useAuthStore } from "@/stores/auth-store";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";
const CHUNK_MS = 8000; // 8 second chunks: fewer boundaries = better accuracy

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface UseVoiceInputOptions {
  language?: string;
  onTranscript?: (text: string) => void;
  onError?: (error: string) => void;
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
  onTranscript,
  onError,
}: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [fullTranscript, setFullTranscript] = useState("");
  const [duration, setDuration] = useState(0);

  const isSupported = typeof navigator !== "undefined";

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const transcriptRef = useRef("");
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

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
          console.warn("[voice] No authenticated user — skipping transcription");
          return;
        }
        const token = await user.getIdToken();

        const base64 =
          typeof input === "string" ? input : await blobToBase64(input);
        if (!base64) return;

        const byteLen = Math.round((base64.length * 3) / 4);
        console.log(`[voice] Sending chunk: ${byteLen} bytes, encoding=${meta?.encoding}, rate=${meta?.sampleRate}`);

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
            // 1. Repeated short phrases: え、え、え / はい。はい。 / ん、ん、ん
            if (text.length <= 30 && /^(.{1,5}[、。,.!？\s]*)\1{2,}/.test(text)) return true;
            // 2. Single filler character repeated with punctuation
            if (/^[えあうんはへほ、。\s]{2,}$/.test(text)) return true;
            // 3. Common STT silence hallucinations (Japanese)
            if (/^(ご視聴ありがとうございました|チャンネル登録|字幕|おやすみなさい)[。.]?$/.test(text)) return true;
            // 4. Only numbers/punctuation (noise artifacts)
            if (/^[\d、。,.\s-]+$/.test(text)) return true;
            // 5. Very short text (1-2 chars) that's just a filler
            if (text.length <= 2 && /^[えあうんはへほおいのでがをにと]$/.test(text)) return true;
            return false;
          })();
          if (isHallucination) {
            console.warn("[voice] Suppressed hallucination:", text);
          } else {
            transcriptRef.current +=
              (transcriptRef.current ? " " : "") + text;
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
    // Stop Rust audio capture if in Tauri
    if (isTauri) {
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
    chunkIntervalRef.current = null;
    durationIntervalRef.current = null;
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
      if (isTauri) {
        // Rust audio capture — bypasses WKWebView getUserMedia restriction
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("start_voice_recording");

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
              console.log(`[voice] Got chunk from Rust: ${result.audio.length} base64 chars, rate=${result.sample_rate}`);
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
            "Microphone API not available. Grant microphone permission in System Settings.",
          );
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: { ideal: 16000 },
            channelCount: { ideal: 1 },
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
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
  }, [isSupported, stopRecording, sendChunk]);

  const toggle = useCallback(() => {
    if (isRecording) stopRecording();
    else startRecording();
  }, [isRecording, startRecording, stopRecording]);

  const clearTranscript = useCallback(() => {
    transcriptRef.current = "";
    setFullTranscript("");
    setInterimText("");
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isTauri) {
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("stop_voice_recording").catch(() => {});
        });
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (chunkIntervalRef.current) clearInterval(chunkIntervalRef.current);
      if (durationIntervalRef.current)
        clearInterval(durationIntervalRef.current);
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
