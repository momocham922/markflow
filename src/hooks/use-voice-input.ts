import { useState, useRef, useCallback, useEffect } from "react";
import { useAuthStore } from "@/stores/auth-store";

const AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || "";
const CHUNK_MS = 2500; // 2.5 second audio chunks

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

  // Don't gate on navigator.mediaDevices — WKWebView may not expose it
  // until getUserMedia is actually called. Errors are caught in startRecording.
  const isSupported = typeof navigator !== "undefined";

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptRef = useRef("");
  const processingRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);

  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const sendChunk = useCallback(
    async (audioBlob: Blob) => {
      if (audioBlob.size < 200) return; // skip silence/tiny chunks
      if (processingRef.current) return; // prevent overlapping requests
      processingRef.current = true;

      try {
        const user = useAuthStore.getState().user;
        if (!user) return;
        const token = await user.getIdToken();
        const base64 = await blobToBase64(audioBlob);
        if (!base64) return;

        const res = await fetch(`${AI_PROXY_URL}/v1/voice/transcribe`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ audio: base64, language }),
        });

        if (!res.ok) {
          console.warn("[voice] Transcription failed:", res.status);
          return;
        }

        const data = await res.json();
        if (data.text?.trim()) {
          transcriptRef.current +=
            (transcriptRef.current ? " " : "") + data.text.trim();
          setFullTranscript(transcriptRef.current);
          setInterimText(data.text.trim());
          onTranscriptRef.current?.(data.text.trim());
        }
      } catch (err) {
        console.error("[voice] Transcription error:", err);
      } finally {
        processingRef.current = false;
      }
    },
    [language],
  );

  const stopRecording = useCallback(() => {
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
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone API not available. Grant microphone permission in System Settings.");
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

      // Detect supported MIME type (Safari: mp4/aac, Chrome: webm/opus)
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : undefined;

      let chunks: Blob[] = [];

      const createRecorder = () => {
        const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
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

      // Cycle: stop → send → start new recording every CHUNK_MS
      chunkIntervalRef.current = setInterval(() => {
        const rec = recorderRef.current;
        if (rec && rec.state === "recording") {
          rec.stop(); // triggers onstop → sendChunk
          recorderRef.current = createRecorder();
        }
      }, CHUNK_MS);

      // Duration counter
      setDuration(0);
      durationIntervalRef.current = setInterval(() => {
        setDuration((d) => d + 1);
      }, 1000);

      setIsRecording(true);
      transcriptRef.current = "";
      setFullTranscript("");
      setInterimText("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start recording";
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
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (chunkIntervalRef.current) clearInterval(chunkIntervalRef.current);
      if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
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
