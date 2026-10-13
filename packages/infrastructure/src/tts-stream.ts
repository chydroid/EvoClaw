/**
 * TTS 流式输出（P2-1 语音模式输出侧）。
 *
 * 对标 Hermes v0.20 流式 TTS：把文本切成 chunk 推给消费方（Web Audio /
 * SSE 音频流）。provider 可插拔——缺 key 时自动降级为静音占位，不报错
 * （AGENTS.md service-gated 模式：功能降级而非失败）。
 *
 * 设计：
 * - TTSProvider 接口：synthesize(text) → 异步 chunk 迭代器
 * - OpenAITTSProvider：OpenAI /api/audio/speech 流式分块（默认 provider，
 *   需 TTS_API_KEY/TTS_ENDPOINT 环境变量；缺 key 时 isAvailable()=false）
 * - 消费方拿到的 TTSChunk 可能是真实音频（base64 PCM）或静音占位（degraded）
 */

// ── 类型 ─────────────────────────────────────────────────────────────────────

/** 单个 TTS 音频 chunk */
export interface TTSChunk {
  /** 音频数据（base64 PCM 16-bit 16kHz 单声道） */
  audio: string;
  /** 采样率（Hz），供 Web Audio 建 AudioBuffer */
  sampleRate: number;
  /** 该 chunk 对应的源文本片段 */
  textFragment: string;
  /** provider 降级模式（无 key / 错误）时为 true，audio 为静音 */
  degraded: boolean;
}

/** TTS provider 抽象（可插拔：OpenAI / Nous Portal / 本地引擎） */
export interface TTSProvider {
  /** 该 provider 当前是否可用（缺 key / 未配置时返回 false） */
  readonly name: string;
  isAvailable(): boolean;
  /** 合成一段文本为音频 chunk 流（按句分块） */
  synthesize(text: string, options?: { onAbort?: () => void; signal?: AbortSignal }): AsyncIterable<TTSChunk>;
}

// ── 句子切分 ─────────────────────────────────────────────────────────────────

/** 按中英文句界切分，限制每片最大字符数（控制单 chunk 音频时长） */
export function splitTextIntoFragments(text: string, maxLen = 80): string[] {
  const clean = (text ?? "").trim();
  if (!clean) return [];
  // 句界：。！？!?\n；;（英文再补 . ）
  const parts = clean.split(/(?<=[。！？!?;\n])|(?<=[.]\s)/g).map((s) => s.trim()).filter(Boolean);
  // 合并过短的片段，避免单 chunk 太短导致 Web Audio 卡顿
  const merged: string[] = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (last && last.length + p.length <= maxLen && !(last.length >= maxLen)) {
      merged[merged.length - 1] = last + p;
    } else {
      merged.push(p);
    }
  }
  return merged.length > 0 ? merged : [clean];
}

// ── 静音占位（降级模式） ─────────────────────────────────────────────────────

const SILENCE_SAMPLE_RATE = 16000;

/** 生成一段约 ms 毫秒的静音 PCM base64（降级时无音频可用，避免 Web Audio 断流） */
function silenceChunk(textFragment: string, ms = 200): TTSChunk {
  const numSamples = Math.floor((SILENCE_SAMPLE_RATE * ms) / 1000);
  const buf = Buffer.alloc(numSamples * 2); // 16-bit
  return { audio: buf.toString("base64"), sampleRate: SILENCE_SAMPLE_RATE, textFragment, degraded: true };
}

// ── OpenAI 兼容 TTS provider ────────────────────────────────────────────────

/**
 * OpenAI 兼容 TTS provider（POST {endpoint}/audio/speech）。
 * 从环境变量读取：
 * - TTS_ENDPOINT（默认 https://api.openai.com/v1）
 * - TTS_API_KEY（必填，缺则 isAvailable()=false，synthesize 走静音降级）
 * - TTS_MODEL（默认 gpt-4o-mini-tts）
 * - TTS_VOICE（默认 alloy）
 * - TTS_SAMPLE_RATE（默认 16000）
 *
 * 响应为 audio/mpeg 或 audio/pcm；这里按 chunk 原样透传 base64，
 * 不做解码重采样（Web Audio 侧按 provider 声明的 sampleRate 建 buffer，
 * 若 provider 返回 mp3 则前端用 <audio> 播放而非 AudioBuffer——
 * 具体协商见 gateway /api/voice/tts 端点的 event 元数据）。
 */
export class OpenAITTSProvider implements TTSProvider {
  readonly name = "openai-tts";
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly sampleRate: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.endpoint = (env.TTS_ENDPOINT || "https://api.openai.com/v1").replace(/\/$/, "");
    this.apiKey = env.TTS_API_KEY || "";
    this.model = env.TTS_MODEL || "gpt-4o-mini-tts";
    this.voice = env.TTS_VOICE || "alloy";
    this.sampleRate = Number(env.TTS_SAMPLE_RATE || 16000);
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async *synthesize(text: string, options?: { signal?: AbortSignal }): AsyncIterable<TTSChunk> {
    if (!this.isAvailable()) {
      // 降级：无 key 时输出静音 chunk，保持流不中断（前端可据此识别降级态）
      for (const frag of splitTextIntoFragments(text)) {
        yield silenceChunk(frag);
      }
      return;
    }

    const res = await fetch(`${this.endpoint}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, voice: this.voice, input: text }),
      signal: options?.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      process.stderr.write(`[TTS] OpenAI TTS failed (${res.status}): ${errText.slice(0, 200)}\n`);
      // 错误降级为静音，保证调用方流不断
      for (const frag of splitTextIntoFragments(text)) {
        yield silenceChunk(frag);
      }
      return;
    }

    const audioBuf = Buffer.from(await res.arrayBuffer());
    // 按 ~256KB 切块推送（约 8 秒 16kHz 16-bit PCM），避免单 chunk 过大
    const CHUNK_SIZE = 256 * 1024;
    const fragments = splitTextIntoFragments(text);
    let fragIdx = 0;
    for (let offset = 0; offset < audioBuf.length; offset += CHUNK_SIZE) {
      if (options?.signal?.aborted) break;
      const slice = audioBuf.subarray(offset, Math.min(offset + CHUNK_SIZE, audioBuf.length));
      const frag = fragments[fragIdx] ?? "";
      fragIdx = Math.min(fragIdx + 1, fragments.length - 1);
      yield {
        audio: slice.toString("base64"),
        sampleRate: this.sampleRate,
        textFragment: frag,
        degraded: false,
      };
    }
    if (options?.signal?.aborted) return;
  }
}

// ── 默认 provider 工厂 ───────────────────────────────────────────────────────

/** 根据环境变量构造默认 TTS provider（缺 key 自动降级静音，不报错） */
export function createDefaultTTSProvider(env: NodeJS.ProcessEnv = process.env): TTSProvider {
  return new OpenAITTSProvider(env);
}

// ── barge-in 会话注册表（P2-1 打断机制） ────────────────────────────────────

/** 进行中的 TTS 播放会话（前端开始播音频时 register，barge-in 或播完时 cancel） */
export interface TTSPlaybackSession {
  id: string;
  abortController: AbortController;
  /** 注册时刻（防悬挂会话清理用） */
  createdAt: number;
}

const SESSION_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * TTS 播放会话注册表：把每个进行中的 TTS 流挂到一个 AbortController 上，
 * barge-in 时按 session 取消该流（用户开口 → 前端检测 → 调 cancel(sessionId)）。
 * 对齐 Hermes barge-in 打断正在播的 TTS stream 语义。
 */
export class TTSPlaybackRegistry {
  private sessions = new Map<string, TTSPlaybackSession>();

  /** 注册一个新的可打断 TTS 流，返回其 AbortController（synthesize 时传入 signal） */
  register(sessionId: string): AbortController {
    this.gc();
    const controller = new AbortController();
    this.sessions.set(sessionId, { id: sessionId, abortController: controller, createdAt: Date.now() });
    return controller;
  }

  /** barge-in：取消指定会话的 TTS 流。返回是否命中。 */
  cancel(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.abortController.abort(new Error(`TTS barge-in on session ${sessionId}`));
    this.sessions.delete(sessionId);
    return true;
  }

  /** 正常播完后调用，仅注销（不 abort） */
  complete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  activeCount(): number {
    return this.sessions.size;
  }

  /** 取消全部活动会话（server shutdown / 全局打断） */
  cancelAll(): number {
    const ids = [...this.sessions.keys()];
    for (const id of ids) this.cancel(id);
    return ids.length;
  }

  /** 清理悬挂超时的会话（防崩溃残留 Map 泄漏） */
  private gc(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.createdAt > SESSION_MAX_AGE_MS) {
        this.sessions.delete(id);
      }
    }
  }
}

