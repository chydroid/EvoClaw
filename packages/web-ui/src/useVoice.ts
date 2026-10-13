/**
 * useVoice — 浏览器端语音识别 Hook（基于 Web Speech API）
 *
 * 特性：
 * - 支持连续识别与临时结果
 * - 自动注入到输入框
 * - 可启停、错误处理、浏览器支持检测
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { voiceApi, type VoiceTTSChunk } from "./api-client";

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

// ── P2-1 语音输出侧：流式 TTS + barge-in 打断 ─────────────────────────────

export type TTSState = "idle" | "speaking" | "error";

export interface UseTTSOptions {
  /** 播放某 agent 的内容（默认 webchat 会话） */
  sessionId?: string;
  onStateChange?: (state: TTSState) => void;
  onError?: (error: string) => void;
}

/**
 * useTTS — 浏览器端流式 TTS 播放 + barge-in 打断。
 *
 * - speak(text)：经 voiceApi.tts() 拉 SSE 音频流，逐 chunk 用 Web Audio 播放
 *   （AudioContext 按 chunk 声明的 sampleRate 建 AudioBuffer 顺序排队）
 * - bargeIn()：用户开口时调用 voiceApi.bargeIn(sessionId)，中断本地播放队列
 * - 降级态（degraded chunk，如 TTS key 未配置）跳过播放但不报错（service-gated）
 * - 组件卸载自动取消进行中的流
 */
export function useTTS(options: UseTTSOptions = {}) {
  const { sessionId = "webchat", onStateChange, onError } = options;

  const [state, setState] = useState<TTSState>("idle");
  const [supported, setSupported] = useState<boolean>(
    typeof window !== "undefined" && !!(window.AudioContext || (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext),
  );
  const [lastError, setLastError] = useState<string | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const cancelRef = useRef<{ cancel: () => void } | null>(null);

  const getAudioCtx = (): AudioContext | null => {
    if (audioCtxRef.current) return audioCtxRef.current;
    if (!supported) return null;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    audioCtxRef.current = new AC();
    return audioCtxRef.current;
  };

  const setTTSState = useCallback((next: TTSState) => {
    setState(next);
    onStateChange?.(next);
  }, [onStateChange]);

  /** 把一个 base64 PCM/MP3 chunk 播放到 AudioContext 队列 */
  const playChunk = useCallback((chunk: VoiceTTSChunk): void => {
    if (chunk.degraded || !chunk.audio) return; // 降级态跳过，不断流也不报错
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => { /* 自动播放策略阻塞，静默 */ });
    }
    const binary = atob(chunk.audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    // 音频按 provider 声明的 sampleRate 建 buffer；OpenAI 默认返回 mp3 时
    // 浏览器 decodeAudioData 可自动解码（mp3 字节流 + 标称采样率）
    ctx.decodeAudioData(bytes.buffer.slice(0), (buffer) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
    }, () => { /* 解码失败（如格式不匹配）静默降级，不影响后续 chunk */ });
  }, [supported]);

  const speak = useCallback((text: string): { cancel: () => void } | null => {
    if (!supported || !text.trim()) {
      setLastError("TTS 不可用（浏览器不支持 AudioContext 或文本为空）");
      setTTSState("error");
      return null;
    }
    // 先打断自己上一轮未播完的流
    if (cancelRef.current) cancelRef.current.cancel();

    setTTSState("speaking");
    const handle = voiceApi.tts(
      text,
      sessionId,
      (chunk) => playChunk(chunk),
      () => { setTTSState("idle"); },
      (msg, aborted) => {
        if (aborted) { setTTSState("idle"); return; } // barge-in/取消不算错误
        setLastError(msg);
        onError?.(msg);
        setTTSState("error");
      },
    );
    cancelRef.current = handle;
    return handle;
  }, [supported, sessionId, playChunk, setTTSState, onError]);

  /** barge-in：打断正在播的 TTS（前端检测到用户开口时调用） */
  const bargeIn = useCallback((): void => {
    if (cancelRef.current) {
      cancelRef.current.cancel();
      cancelRef.current = null;
    }
    voiceApi.bargeIn(sessionId).catch(() => { /* barge-in 失败不影响本地停止 */ });
    setTTSState("idle");
  }, [sessionId, setTTSState]);

  const stop = useCallback((): void => {
    if (cancelRef.current) {
      cancelRef.current.cancel();
      cancelRef.current = null;
    }
    setTTSState("idle");
  }, [setTTSState]);

  useEffect(() => {
    return () => {
      if (cancelRef.current) {
        cancelRef.current.cancel();
        cancelRef.current = null;
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => { /* noop */ });
        audioCtxRef.current = null;
      }
    };
  }, []);

  return {
    state,
    supported,
    lastError,
    isSpeaking: state === "speaking",
    speak,
    stop,
    bargeIn,
  };
}

