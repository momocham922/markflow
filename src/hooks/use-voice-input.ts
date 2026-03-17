import { useState, useRef, useCallback, useEffect } from "react";

interface UseVoiceInputOptions {
  lang?: string;
  onResult?: (text: string, isFinal: boolean) => void;
  onError?: (error: string) => void;
}

interface UseVoiceInputReturn {
  isRecording: boolean;
  isSupported: boolean;
  interimText: string;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

// SpeechRecognition type augmentation
type SpeechRecognitionType = typeof window extends { SpeechRecognition: infer T } ? T : unknown;

function getSpeechRecognition(): SpeechRecognitionType | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function useVoiceInput({
  lang = "ja-JP",
  onResult,
  onError,
}: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [interimText, setInterimText] = useState("");
  const recognitionRef = useRef<ReturnType<typeof createRecognition> | null>(null);
  const isSupported = !!getSpeechRecognition();

  // Stable callback refs
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  useEffect(() => { onResultRef.current = onResult; }, [onResult]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const stop = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsRecording(false);
    setInterimText("");
  }, []);

  const start = useCallback(() => {
    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      onErrorRef.current?.("Speech recognition is not supported in this browser.");
      return;
    }

    stop();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recognition = new (SpeechRecognition as any)();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => {
      let interim = "";
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const text = result[0].transcript.trim();
          if (text) onResultRef.current?.(text, true);
        } else {
          interim += result[0].transcript;
        }
      }
      setInterimText(interim);
    };

    recognition.onerror = (event: { error: string }) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      onErrorRef.current?.(`Voice error: ${event.error}`);
      stop();
    };

    recognition.onend = () => {
      // Auto-restart if still recording (browser may stop after silence)
      if (recognitionRef.current === recognition) {
        try {
          recognition.start();
        } catch {
          stop();
        }
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsRecording(true);
  }, [lang, stop]);

  const toggle = useCallback(() => {
    if (isRecording) {
      stop();
    } else {
      start();
    }
  }, [isRecording, start, stop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
        recognitionRef.current = null;
      }
    };
  }, []);

  return { isRecording, isSupported, interimText, start, stop, toggle };
}

function createRecognition() {
  const SpeechRecognition = getSpeechRecognition();
  if (!SpeechRecognition) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (SpeechRecognition as any)();
}
