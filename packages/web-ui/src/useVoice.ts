/**
 * useVoice — 浏览器端语音识别 Hook（基于 Web Speech API）
 *
 * 特性：
 * - 支持连续识别与临时结果
 * - 自动注入到输入框
 * - 可启停、错误处理、浏览器支持检测
 */
import { useState, useRef, useCallback, useEffect } from "react";

export type VoiceState = "idle" | "listening" | "speaking" | "error";

export interface UseVoiceOptions {
  language?: string;
  continuous?: boolean;
  interimResults?: boolean;
  autoSubmit?: boolean;
  onResult?: (text: string, isFinal: boolean) => void;
  onError?: (error: string) => void;
  onStateChange?: (state: VoiceState) => void;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

const getSpeechRecognition = (): (new () => SpeechRecognitionLike) | undefined => {
  if (typeof window === "undefined") return undefined as any;
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || undefined;
};

export function isSpeechRecognitionSupported(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as any;
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export function useVoice(options: UseVoiceOptions = {}) {
  const {
    language = "zh-CN",
    continuous = true,
    interimResults = true,
    autoSubmit = false,
    onResult,
    onError,
    onStateChange,
  } = options;

  const [state, setState] = useState<VoiceState>("idle");
  const [supported, setSupported] = useState<boolean>(isSpeechRecognitionSupported());
  const [lastError, setLastError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef<string>("");

  const updateState = useCallback((next: VoiceState) => {
    setState(next);
    onStateChange?.(next);
  }, [onStateChange]);

  const stopListening = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch { /* noop */ }
    updateState("idle");
  }, [updateState]);

  const startListening = useCallback(() => {
    if (!supported) {
      const msg = "当前浏览器不支持 Web Speech API";
      setLastError(msg);
      onError?.(msg);
      updateState("error");
      return;
    }
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* noop */ }
    }
    transcriptRef.current = "";
    const SR = getSpeechRecognition();
    if (!SR) return;
    const rec: SpeechRecognitionLike = new SR();
    rec.lang = language;
    rec.continuous = continuous;
    rec.interimResults = interimResults;
    rec.maxAlternatives = 1;

    rec.onstart = () => updateState("listening");
    rec.onend = () => {
      updateState("idle");
      recognitionRef.current = null;
    };
    rec.onerror = (event: any) => {
      const msg = event?.error ? String(event.error) : "语音识别出错";
      // aborted/no-speech 不算错误
      if (msg === "aborted" || msg === "no-speech") {
        updateState("idle");
        return;
      }
      setLastError(msg);
      onError?.(msg);
      updateState("error");
    };
    rec.onresult = (event: any) => {
      let final = "";
      let interim = "";
      if (event.results && event.results.length > 0) {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const alt = result.length > 0 ? result[0] : null;
          if (!alt) continue;
          if (result.isFinal) {
            final += alt.transcript;
          } else {
            interim += alt.transcript;
          }
        }
      }
      const text = final || interim;
      transcriptRef.current = text;
      onResult?.(text, !!final);
      if (final && autoSubmit) {
        stopListening();
      }
    };

    recognitionRef.current = rec;
    try {
      rec.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      onError?.(msg);
      updateState("error");
    }
  }, [supported, language, continuous, interimResults, autoSubmit, onResult, onError, updateState, stopListening]);

  const toggleListening = useCallback(() => {
    if (state === "listening") {
      stopListening();
    } else {
      startListening();
    }
  }, [state, startListening, stopListening]);

  useEffect(() => {
    setSupported(isSpeechRecognitionSupported());
  }, []);

  useEffect(() => {
    return () => {
      try { recognitionRef.current?.abort(); } catch { /* noop */ }
    };
  }, []);

  return {
    state,
    supported,
    lastError,
    isListening: state === "listening",
    startListening,
    stopListening,
    toggleListening,
    transcript: transcriptRef.current,
  };
}
