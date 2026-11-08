/**
 * TTS Provider Registry（Hermes 对齐 Step 5 —— G5 部分）。
 *
 * 对齐 Hermes `agent/tts_registry.py` + `agent/tts_provider.py` 契约：
 * - TTSProvider ABC：synthesize(text, outputPath, voice?, model?, speed?, format="mp3")
 *   → 返回落盘文件路径（Hermes 是同步方程；EvoClaw Node 环境为 async）。
 * - resolve_output_format：格式钳位到 {mp3,wav,ogg,opus,flac}（Hermes 语义）。
 * - warm()/release()：可选生命周期钩子。
 * - BUILTIN_TTS_PROVIDERS = {edge, elevenlabs, openai, minimax, xai, mistral, gemini, deepinfra}；
 *   同名注册拒绝（内置名冲突校验）。
 *
 * 默认链（工具层未指定 provider 时按序挑第一个 isAvailable）：
 *   edge（免费默认，python edge-tts 子进程；同步可用性探测 `python3 -c "import edge_tts"`，
 *   30s 缓存——module missing 时工具 checkFn 不暴露 edge，链自动落到 openai）
 *   → openai → elevenlabs → minimax → mistral → gemini → xai → deepinfra。
 * 云 provider 均由环境变量 key 探测可用性（缺 key → isAvailable=false，不抛）。
 *
 * 本模块是"文件合成侧"（Hermes tools/tts_tool.py 的方程）；
 * EvoClaw 既有"流式侧"（tts-stream.ts 的 AsyncIterable<TTSChunk>，供 WebUI voice SSE）不受影响。
 */

import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

// ── 类型 ─────────────────────────────────────────────────────────────────────

/** 输出音频容器格式（Hermes resolve_output_format 的允许集）。 */
export type TTSOutputFormat = "mp3" | "wav" | "ogg" | "opus" | "flac";

export interface TTSSynthesizeOptions {
  outputPath?: string;
  voice?: string;
  model?: string;
  /** 1.0 = 常速；edge → ±N% rate，xai → 0.7..1.5，其余透传（仅部分后端支持） */
  speed?: number;
  format?: string;
  /** 语音设计指令（语气/情感——仅 openai-compatible / gemini 等语法感知的后端生效） */
  instructions?: string;
}

/**
 * TTS Provider 抽象（文件合成方程，对齐 Hermes TTSProvider ABC）。
 */
export interface TTSProvider {
  /** 注册名（edge/openai/...） */
  readonly name: string;
  /** 当前是否可用（缺 key / 子进程缺引擎时返回 false——不抛）。 */
  isAvailable(): boolean;
  /**
   * 合成文本 → 音频文件。
   * 成功返回落盘文件路径；失败抛 Error（调用方/工具层负责降级/报错——
   * 工具层用 registry 链尝试下一家）。
   */
  synthesize(text: string, options?: TTSSynthesizeOptions): Promise<string>;
}

/** 输出格式钳位（Hermes resolve_output_format）：未知/空 → mp3。 */
export function resolveOutputFormat(raw?: string): TTSOutputFormat {
  const fmt = (raw ?? "").toLowerCase().replace(/^\./, "").trim();
  if (fmt === "wav" || fmt === "ogg" || fmt === "opus" || fmt === "flac" || fmt === "mp3") return fmt;
  return "mp3";
}

/** 默认输出目录（对标 Hermes ~/voice-memos/：os.tmpdir() 下 evoclaw-tts，避免污染 workspace）。 */
export function defaultTTSOutputDir(): string {
  const dir = path.join(os.tmpdir(), "evoclaw-tts");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 原子写（temp + rename，AGENTS.md 约定）。 */
function writeAtomically(filePath: string, data: Buffer): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + `.tmp-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
  return filePath;
}

/** 响应字节数上限（Hermes TTS_RESPONSE_BODY_LIMIT_BYTES = 16MB）。 */
const TTS_RESPONSE_BODY_LIMIT = 16 * 1024 * 1024;

/** fetch 二进制响应：非 2xx → 抛（含 status + 前 300 字节文本）。 */
async function fetchBinary(
  url: string,
  init: { headers: Record<string, string>; body: string; signal?: AbortSignal }
): Promise<Buffer> {
  const res = await fetch(url, {
    method: "POST",
    headers: init.headers,
    body: init.body,
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`TTS HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > TTS_RESPONSE_BODY_LIMIT) {
    throw new Error(`TTS response exceeds ${TTS_RESPONSE_BODY_LIMIT} bytes`);
  }
  return buf;
}

/** 生成输出文件名（CSPRNG 后缀，防符号链接劫持）。 */
function generateTtsFilename(format: TTSOutputFormat): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = randomBytes(6).toString("hex");
  return `tts-${stamp}-${rand}.${format}`;
}

/** 定位输出路径：显式 outputPath（扩展名按 format 归一）或默认目录。 */
function resolveOutputPath(outputPath: string | undefined, format: TTSOutputFormat): string {
  if (!outputPath) return path.join(defaultTTSOutputDir(), generateTtsFilename(format));
  const ext = path.extname(outputPath);
  const base = ext ? outputPath.slice(0, -ext.length) : outputPath;
  return `${base}.${format}`;
}

// ── Registry（对齐 Hermes ProviderRegistry<P>：register + 同名拒绝 + 链选）───────

/**
 * 通用 Provider 注册表：register() 内置名冲突拒绝；get/has/names；
 * resolveChain(order)：按序返回第一个 isAvailable 的 provider（Hermes 默认链语义）。
 */
export class ProviderRegistry<P extends { name: string; isAvailable(): boolean }> {
  private readonly providers = new Map<string, P>();
  private readonly builtin: ReadonlySet<string>;

  constructor(builtinNames: ReadonlySet<string>) {
    this.builtin = builtinNames;
  }

  /** 注册 provider。内置名冲突/重复注册 → 拒绝（throw，配置错误应快速暴露）。 */
  register(p: P): P {
    if (this.builtin.has(p.name) && this.providers.has(p.name)) {
      throw new Error(`provider '${p.name}' is a built-in name already registered (name collision)`);
    }
    this.providers.set(p.name, p);
    return p;
  }

  get(name: string): P | undefined {
    return this.providers.get(name);
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  names(): string[] {
    return [...this.providers.keys()];
  }

  /** 默认链选：按 order 依次试第一个 isAvailable；全部不可用 → null。 */
  resolveChain(order?: string[]): P | null {
    const names = order && order.length > 0 ? order : [...this.providers.keys()];
    for (const name of names) {
      const p = this.providers.get(name);
      if (p && p.isAvailable()) return p;
    }
    return null;
  }

  /** 全部注册（plugins/globals export 的 EvoClaw 对应物：便于 test/容器注入）。 */
  all(): P[] {
    return [...this.providers.values()];
  }
}

/** Hermes BUILTIN_TTS_PROVIDERS 常量（契约对齐清单）。 */
export const BUILTIN_TTS_PROVIDERS: ReadonlySet<string> = new Set([
  "edge",
  "elevenlabs",
  "openai",
  "minimax",
  "xai",
  "mistral",
  "gemini",
  "deepinfra",
]);

/** 默认链（Hermes create_default_tts_provider 语义：edge 免费优先）。 */
export const TTS_DEFAULT_CHAIN = [
  "edge", "openai", "elevenlabs", "minimax", "mistral", "gemini", "xai", "deepinfra",
];

/** 从 env 构建默认注册表（全部内置 provider；未配置 key 的 instance 上 isAvailable()=false）。 */
export function createTTSRegistry(env: NodeJS.ProcessEnv = process.env): ProviderRegistry<TTSProvider> {
  const registry = new ProviderRegistry<TTSProvider>(BUILTIN_TTS_PROVIDERS);
  registry.register(new EdgeTTSProvider(env));
  registry.register(new ElevenLabsTTSProvider(env));
  registry.register(
    new OpenAiCompatibleTTSProvider("openai", env, {
      baseUrlEnv: "TTS_OPENAI_BASE_URL",
      keyEnvs: ["TTS_API_KEY", "OPENAI_API_KEY", "TTS_OPENAI_API_KEY"],
      defaultModel: env.TTS_MODEL || "gpt-4o-mini-tts",
      defaultVoice: env.TTS_VOICE || "alloy",
    })
  );
  registry.register(new MiniMaxTTSProvider(env));
  registry.register(new XAITTTSProvider(env));
  registry.register(new MistralTTSProvider(env));
  registry.register(new GeminiTTSProvider(env));
  registry.register(
    new OpenAiCompatibleTTSProvider("deepinfra", env, {
      baseUrlEnv: "TTS_DEEPINFRA_BASE_URL",
      keyEnvs: ["TTS_DEEPINFRA_API_KEY", "DEEPINFRA_API_KEY"],
      defaultModel: env.TTS_DEEPINFRA_MODEL || "cartesia/trino-tts-sonar",
      defaultVoice: env.TTS_DEEPINFRA_VOICE || "Carter",
    })
  );
  return registry;
}

// ── python 子进程运行器（edge / 本地 STT 共用） ───────────────────────────────

/**
 * 运行 `python <mod> <args...>`（-m edge_tts 由调用方拼：python -m edge_tts --write-media ...）。
 * timeout → SIGKILL + code=-1；stdout/stderr 各 8MB 上限截断。
 */
export function runPythonProcess(
  python: string,
  args: string[],
  timeoutMs = 120_000
): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(python, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const MAX = 8 * 1024 * 1024;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]).subarray(0, MAX);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(0, MAX);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * 同步探测 python 模块可用性（node 同步 execSync + 30s 缓存）。
 * 注入 execFn 供测试；exec 异常（python 缺失）→ false。
 */
export class PythonModuleProbe {
  private cache: { ok: boolean; at: number } | null = null;
  constructor(
    private readonly python: string,
    private readonly mod: string,
    private readonly execFn?: (cmd: string) => void,
    private readonly ttlMs = 30_000
  ) {}

  /** 强制失效缓存（安装引擎后可调用）。 */
  invalidate(): void {
    this.cache = null;
  }

  probeSync(): boolean {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.ok;
    let ok = false;
    try {
      const run = this.execFn ?? ((cmd: string) => execSync(cmd, { stdio: "ignore", timeout: 10_000 }));
      run(`${this.python} -c "import ${this.mod}"`);
      ok = true;
    } catch {
      ok = false;
    }
    this.cache = { ok, at: now };
    return ok;
  }
}

// ── Edge TTS（免费默认；H3: 子进程 edge-tts）─────────────────────────────────

/**
 * Edge TTS（Hermes `_generate_edge_tts`：edge_tts.Communicate(text, **kwargs).save）。
 * TS 实现：python3 -m edge_tts 子进程（免费无 key）；
 * speed 推演对齐 Hermes：rate = round((speed-1)*100) ± N%。
 * 可用性 = python 命令存在 + `import edge_tts` 同步探测（缓存 30s）——
 * 模块未安装时 isAvailable=false，默认链自动落到 openai（缺 key 则整体降级）。
 */
export class EdgeTTSProvider implements TTSProvider {
  readonly name = "edge";
  private readonly python: string;
  private readonly probe: PythonModuleProbe;
  /** 注入 runner 供测试（替代真实子进程执行） */
  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private runner?: (args: string[]) => Promise<{ code: number; stdout: Buffer }>,
    private readonly execProbe?: (cmd: string) => void
  ) {
    this.python = env.EDGE_TTS_PYTHON || "python3";
    this.probe = new PythonModuleProbe(this.python, "edge_tts", this.execProbe);
  }

  isAvailable(): boolean {
    return this.runner !== undefined || this.probe.probeSync();
  }

  async synthesize(text: string, options?: TTSSynthesizeOptions): Promise<string> {
    const format = resolveOutputFormat(options?.format);
    const outPath = resolveOutputPath(options?.outputPath, format);
    const voice = options?.voice || "";
    const speed = options?.speed ?? 1.0;
    // rate 推演对齐 Hermes：speed=2.0 → "+100%"；常速不传 rate。
    const rate = Math.round((speed - 1) * 100);

    const args = [
      "-m", "edge_tts",
      "--write-media", outPath,
      ...(voice ? ["--voice", voice] : []),
      "--text", text,
      ...(rate !== 0 ? ["--rate", `${rate >= 0 ? "+" : ""}${rate}%`] : []),
    ];

    let result: { code: number; stdout: Buffer };
    if (this.runner) {
      result = await this.runner(args);
    } else {
      const r = await runPythonProcess(this.python, args);
      result = { code: r.code, stdout: r.stdout };
    }
    if (result.code !== 0) {
      throw new Error(`edge-tts exited ${result.code}: ${result.stdout.subarray(0, 300).toString("utf-8")}`);
    }
    return outPath;
  }
}

// ── OpenAI 兼容族（openai / deepinfra；xAI 形状相同，public API 独立） ─────────

/**
 * OpenAI 兼容 TTS（POST {base}/audio/speech）。OpenAI/DeepInfra 共用此形状。
 * response_format 用钳位后的格式；speed/instructions 透传（多数兼容后端忽略或扩展）。
 */
export class OpenAiCompatibleTTSProvider implements TTSProvider {
  readonly name: string;
  protected readonly baseUrl: string;
  protected readonly apiKey: string;
  protected readonly defaultModel: string;
  protected readonly defaultVoice: string;

  constructor(
    name: string,
    env: NodeJS.ProcessEnv,
    defaults: {
      baseUrlEnv: string;
      keyEnvs: string[];
      defaultModel: string;
      defaultVoice: string;
      defaultBaseUrl?: string;
    }
  ) {
    this.name = name;
    this.baseUrl = (env[defaults.baseUrlEnv] || defaults.defaultBaseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    this.apiKey = defaults.keyEnvs.map((k) => env[k] || "").find((v) => v.length > 0) ?? "";
    this.defaultModel = defaults.defaultModel;
    this.defaultVoice = defaults.defaultVoice;
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async synthesize(text: string, options?: TTSSynthesizeOptions): Promise<string> {
    if (!this.isAvailable()) throw new Error(`provider '${this.name}' not configured (missing API key)`);
    const format = resolveOutputFormat(options?.format);
    const outPath = resolveOutputPath(options?.outputPath, format);
    const body: Record<string, unknown> = {
      model: options?.model || this.defaultModel,
      voice: options?.voice || this.defaultVoice,
      input: text,
      response_format: format,
    };
    if (options?.speed !== undefined) body.speed = options.speed;
    if (options?.instructions) body.instructions = options.instructions;

    const data = await fetchBinary(`${this.baseUrl}/audio/speech`, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    return writeAtomically(outPath, data);
  }
}

/**
 * xAI TTS（Hermes _generate_xai_tts：OpenAI 形状 + language/sample_rate/bit_rate 附加参数）。
 */
export class XAITTTSProvider extends OpenAiCompatibleTTSProvider {
  readonly name = "xai";

  constructor(env: NodeJS.ProcessEnv = process.env) {
    super("xai", env, {
      baseUrlEnv: "TTS_XAI_BASE_URL",
      keyEnvs: ["XAI_API_KEY", "TTS_XAI_API_KEY"],
      defaultModel: env.TTS_XAI_MODEL || "grok-tts",
      defaultVoice: env.TTS_XAI_VOICE || "eve",
      defaultBaseUrl: "https://api.x.ai/v1",
    });
  }

  async synthesize(text: string, options?: TTSSynthesizeOptions): Promise<string> {
    if (!this.isAvailable()) throw new Error("xai not configured (missing XAI_API_KEY)");
    const format = resolveOutputFormat(options?.format);
    const outPath = resolveOutputPath(options?.outputPath, format);
    const body: Record<string, unknown> = {
      model: options?.model || this.defaultModel,
      voice: options?.voice || this.defaultVoice,
      input: text,
      response_format: format,
    };
    if (options?.speed !== undefined) body.speed = options.speed;
    if (options?.instructions) body.instructions = options.instructions;

    const data = await fetchBinary(`${this.baseUrl}/audio/speech`, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    return writeAtomically(outPath, data);
  }
}

// ── ElevenLabs（/v1/text-to-speech/{voice_id}） ───────────────────────────────

/** Hermes _generate_elevenlabs 契约：xi-api-key 头 + text-to-speech/{voice_id}。 */
export class ElevenLabsTTSProvider implements TTSProvider {
  readonly name = "elevenlabs";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultVoiceId: string;
  private readonly defaultModelId: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.baseUrl = (env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io/v1").replace(/\/$/, "");
    this.apiKey = env.ELEVENLABS_API_KEY || "";
    this.defaultVoiceId = env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB"; // Adam（Hermes 默认）
    this.defaultModelId = env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async synthesize(text: string, options?: TTSSynthesizeOptions): Promise<string> {
    if (!this.isAvailable()) throw new Error("elevenlabs not configured (missing ELEVENLABS_API_KEY)");
    const format = resolveOutputFormat(options?.format);
    const outPath = resolveOutputPath(options?.outputPath, format);
    const voiceId = options?.voice || this.defaultVoiceId;
    const body = JSON.stringify({
      text,
      model_id: options?.model || this.defaultModelId,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
      },
    });
    // 注意：elevenlabs voice_settings 无 speed 字段（speed 忽略，路径不修改——对齐 Hermes）。
    const data = await fetchBinary(`${this.baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}`, {
      headers: { "Content-Type": "application/json", "xi-api-key": this.apiKey, Accept: "audio/mpeg" },
      body,
    });
    return writeAtomically(outPath, data);
  }
}

// ── Mistral（/v1/audio/speech；voxtral-mini-tts）──────────────────────────────

export class MistralTTSProvider implements TTSProvider {
  readonly name = "mistral";
  private readonly baseUrl = "https://api.mistral.ai";
  private readonly apiKey: string;
  private readonly defaultModel = "voxtral-mini-tts-2603";
  private readonly defaultVoice = "c69964a6-ab8b-4f8a-9465-ec0925096ec8"; // Paul（Hermes 默认）

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.apiKey = env.MISTRAL_API_KEY || "";
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async synthesize(text: string, options?: TTSSynthesizeOptions): Promise<string> {
    if (!this.isAvailable()) throw new Error("mistral not configured (missing MISTRAL_API_KEY)");
    const format = resolveOutputFormat(options?.format);
    const outPath = resolveOutputPath(options?.outputPath, format);
    const body = JSON.stringify({
      model: options?.model || this.defaultModel,
      voice: options?.voice || this.defaultVoice,
      input: text,
      format,
    });
    const data = await fetchBinary(`${this.baseUrl}/v1/audio/speech`, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body,
    });
    return writeAtomically(outPath, data);
  }
}

// ── Gemini（generateContent responseModalities=AUDIO）──────────────────────────

/** Hermes DEFAULT_GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts"。 */
export class GeminiTTSProvider implements TTSProvider {
  readonly name = "gemini";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel = "gemini-2.5-flash-preview-tts";
  private readonly defaultVoice = "Kore";

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.baseUrl = (env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    this.apiKey = env.GEMINI_API_KEY || "";
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async synthesize(text: string, options?: TTSSynthesizeOptions): Promise<string> {
    if (!this.isAvailable()) throw new Error("gemini not configured (missing GEMINI_API_KEY)");
    const format = resolveOutputFormat(options?.format);
    const outPath = resolveOutputPath(options?.outputPath, format);
    const model = options?.model || this.defaultModel;
    // voice：beta 期 voice_name 不稳定 → 首轮把 voice 作为风格指令注入 prompt（Hermes 同构）。
    const spoken = options?.voice || this.defaultVoice;
    const style = [options?.instructions, spoken && `Voice: ${spoken}.`].filter(Boolean).join(" ");
    const inputText = style ? `${style}\n\n${text}` : text;

    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: inputText }] }],
      generationConfig: { responseModalities: ["AUDIO"] },
    });
    const res = await fetch(`${this.baseUrl}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`gemini TTS HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>;
      error?: { message?: string };
    };
    if (json.error?.message) throw new Error(`gemini TTS error: ${json.error.message.slice(0, 300)}`);
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const b64 = parts.find((p) => p.inlineData?.data)?.inlineData?.data;
    if (!b64) throw new Error("gemini TTS returned no audio inlineData");
    const data = Buffer.from(b64, "base64");
    if (data.length > TTS_RESPONSE_BODY_LIMIT) throw new Error("gemini TTS audio exceeds size limit");
    return writeAtomically(outPath, data);
  }
}

// ── MiniMax（t2a_v2 shape；JSON 响应内 base64 audio）─────────────────────────

/** 对齐 Hermes _generate_minimax：base_url t2a_v2，model speech-02-hd，voice English_expressive_narrator。 */
export class MiniMaxTTSProvider implements TTSProvider {
  readonly name = "minimax";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel = "speech-02-hd";
  private readonly defaultVoice = "English_expressive_narrator";

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const cn = env.MINIMAX_CN === "1";
    this.baseUrl = (
      env.MINIMAX_BASE_URL || (cn ? "https://api.minimaxi.com/v1/t2a_v2" : "https://api.minimax.io/v1/t2a_v2")
    ).replace(/\/$/, "");
    this.apiKey = env.MINIMAX_API_KEY || "";
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async synthesize(text: string, options?: TTSSynthesizeOptions): Promise<string> {
    if (!this.isAvailable()) throw new Error("minimax not configured (missing MINIMAX_API_KEY)");
    const format = resolveOutputFormat(options?.format);
    const outPath = resolveOutputPath(options?.outputPath, format);
    const voiceSetting: Record<string, unknown> = {
      voice_id: options?.voice || this.defaultVoice,
      speed: options?.speed ?? 1,
      vol: 1,
      pitch: 0,
    };
    const body = JSON.stringify({
      model: options?.model || this.defaultModel,
      stream: false,
      text_type: "text",
      text,
      voice_setting: voiceSetting,
      audio_setting: { sample_rate: 32000, bitrate: 128000, format },
    });

    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`minimax TTS HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      data?: { audio?: string; status?: number };
      baseResponse?: { errorCode?: string | number; errorMsg?: string };
    };
    const ec = json.baseResponse?.errorCode;
    if (ec !== undefined && ec !== 0) {
      throw new Error(`minimax TTS error ${ec}: ${json.baseResponse?.errorMsg ?? ""}`);
    }
    const b64 = json.data?.audio;
    if (!b64) throw new Error("minimax TTS returned no audio data");
    const data = Buffer.from(b64, "base64");
    return writeAtomically(outPath, data);
  }
}
