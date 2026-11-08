/**
 * STT（语音转文本）Provider Registry（Hermes 对齐 Step 5 —— G5 部分）。
 *
 * 对齐 Hermes `tools/transcription_common.py` + `agent/transcription_provider.py` 契约：
 * - TranscriptionProvider.transcribe(file_path, model?, language?)
 *   → 信封 {success, transcript, provider, error}——**永不抛**（服务失败即信封内回报）。
 * - streaming_capable：本轮最小面不做流式（P2：本地更快 whisper 流式会话）。
 * - BUILTIN_STT_PROVIDERS = {local, local_command, groq, openai, mistral, xai, elevenlabs, deepinfra}；
 *   本轮实现其中 7 家（local 免费默认 + 6 家云），local_command 为 P2（内置名受冲突保护不注册）。
 *
 * 默认链：local → openai → groq → mistral → xai → elevenlabs → deepinfra
 * （env STT_PROVIDER 显式指定时只试该家，失败即信封错误，不链选）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runPythonProcess, PythonModuleProbe } from "./tts-providers";

// ── 类型 ─────────────────────────────────────────────────────────────────────

/** 转写结果信封（对齐 TranscriptionProvider.transcribe 契约：永不抛）。 */
export interface TranscriptionEnvelope {
  success: boolean;
  transcript: string;
  provider: string;
  error?: string;
}

export interface TranscribeOptions {
  model?: string;
  language?: string;
}

/** STT Provider 抽象。 */
export interface TranscriptionProvider {
  readonly name: string;
  isAvailable(): boolean;
  /** 音频文件路径 → 信封。provider 内部必须捕获一切异常（对齐 Hermes）。 */
  transcribe(filePath: string, options?: TranscribeOptions): Promise<TranscriptionEnvelope>;
}

/**
 * Hermes BUILTIN_STT_PROVIDERS 全量 8 名（local_command 为 P2：内置名受冲突保护，本轮不注册实现）。
 */
export const BUILTIN_STT_PROVIDERS: ReadonlySet<string> = new Set([
  "local",
  "local_command",
  "groq",
  "openai",
  "mistral",
  "xai",
  "elevenlabs",
  "deepinfra",
]);

/** 默认链（Hermes 默认 local faster-whisper 优先）。 */
export const STT_DEFAULT_CHAIN = [
  "local", "openai", "groq", "mistral", "xai", "elevenlabs", "deepinfra",
];

/** 音频文件字节上限（16MB，与 TTS 返回上限对称）。 */
const STT_FILE_LIMIT = 16 * 1024 * 1024;

function envelope(provider: string, transcript: string): TranscriptionEnvelope {
  return { success: true, transcript, provider };
}

function failure(provider: string, err: unknown): TranscriptionEnvelope {
  return { success: false, transcript: "", provider, error: err instanceof Error ? err.message : String(err) };
}

/** 校验音频文件存在/大小（超限返回错误信封）。 */
function checkAudioFile(filePath: string): { ok: true } | { ok: false; error: string } {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: `audio file not found: ${filePath}` };
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { ok: false, error: `not a file: ${filePath}` };
  if (stat.size > STT_FILE_LIMIT) return { ok: false, error: `audio file exceeds ${STT_FILE_LIMIT} bytes: ${filePath}` };
  return { ok: true };
}

// ── 本地 faster-whisper（默认免费） ───────────────────────────────────────────

/**
 * 本地转写（Hermes transcription_local：faster_whisper.WhisperModel）。
 * TS 对应：`python3 -c "<script>" <file> <model> <language?>` 子进程。
 * 输出 = transcription JSON {text, language, duration, segments}（faster-whisper CLI 风格），
 * 便于与本类 runner 注入测试同构。
 */
export class LocalFasterWhisperProvider implements TranscriptionProvider {
  readonly name = "local";
  private readonly python: string;
  private readonly probe: PythonModuleProbe;
  /** faster-whisper 模型缓存目录（Hermes：HUGGINGFACE 默认缓存即可） */
  readonly modelDefault = "base";

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private runner?: (args: string[]) => Promise<{ code: number; stdout: Buffer }>,
    private readonly execProbe?: (cmd: string) => void
  ) {
    this.python = env.STT_PYTHON || "python3";
    this.probe = new PythonModuleProbe(this.python, "faster_whisper", this.execProbe);
  }

  isAvailable(): boolean {
    return this.runner !== undefined || this.probe.probeSync();
  }

  async transcribe(filePath: string, options?: TranscribeOptions): Promise<TranscriptionEnvelope> {
    const check = checkAudioFile(filePath);
    if (!check.ok) return failure(this.name, new Error(check.error));
    const model = options?.model || this.modelDefault;
    const args = [
      "-c",
      `import json,sys\nfrom faster_whisper import WhisperModel\n` +
        `model = WhisperModel(sys.argv[2], device="cpu", compute_type="int8")\n` +
        `segments, info = model.transcribe(sys.argv[1], language=sys.argv[3] or None, vad_filter=True)\n` +
        `print(json.dumps({"text":"".join(seg.text for seg in segments),"language":info.language,"duration":info.duration}))`,
      filePath,
      model,
      options?.language || "",
    ];
    try {
      const r = this.runner
        ? await this.runner(args)
        : await runPythonProcess(this.python, args, 300_000);
      if (r.code !== 0) {
        return failure(this.name, new Error(`faster-whisper exited ${r.code}: ${r.stdout.subarray(0, 300).toString("utf-8")}`));
      }
      const parsed = JSON.parse(r.stdout.toString("utf-8").trim());
      return envelope(this.name, String(parsed.text ?? ""));
    } catch (err) {
      return failure(this.name, err instanceof Error ? err : new Error(String(err)));
    }
  }
}

// ── 云侧 OpenAI 形状族（groq / openai / xai / deepinfra；mistral 同形状但 base 不同）─

/**
 * OpenAI 兼容转写：POST {base}/audio/transcriptions multipart（file + model + language?）。
 * 信封化失败：非 2xx / 网络 / 解析错误全部包进 envelope（对齐 Hermes except → fail envelope）。
 */
export class OpenAiCompatibleSttProvider implements TranscriptionProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;

  constructor(
    name: string,
    env: NodeJS.ProcessEnv,
    cfg: { baseUrlEnv: string; keyEnvs: string[]; defaultModel: string; defaultBaseUrl: string }
  ) {
    this.name = name;
    this.baseUrl = (env[cfg.baseUrlEnv] || cfg.defaultBaseUrl).replace(/\/$/, "");
    this.apiKey = cfg.keyEnvs.map((k) => env[k] || "").find((v) => v.length > 0) ?? "";
    this.defaultModel = cfg.defaultModel;
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async transcribe(filePath: string, options?: TranscribeOptions): Promise<TranscriptionEnvelope> {
    const check = checkAudioFile(filePath);
    if (!check.ok) return failure(this.name, new Error(check.error));
    if (!this.isAvailable()) return failure(this.name, new Error(`provider '${this.name}' not configured (missing API key)`));
    try {
      const form = new FormData();
      form.set("file", new Blob([fs.readFileSync(filePath)], { type: "audio/mpeg" }), path.basename(filePath));
      form.set("model", options?.model || this.defaultModel);
      if (options?.language) form.set("language", options.language);

      const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(300_000),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        return failure(this.name, new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`));
      }
      const json = (await res.json()) as { text?: string };
      return envelope(this.name, String(json.text ?? ""));
    } catch (err) {
      return failure(this.name, err instanceof Error ? err : new Error(String(err)));
    }
  }
}

// ── ElevenLabs（POST /v1/speech-to-text） ──────────────────────────────────────

/** 对齐 Hermes _transcribe_elevenlabs：POST /v1/speech-to-text（multipart + xi-api-key）。 */
export class ElevenLabsSttProvider implements TranscriptionProvider {
  readonly name = "elevenlabs";
  private readonly baseUrl = "https://api.elevenlabs.io/v1";
  private readonly apiKey: string;
  private readonly defaultModel = "scribe_v1";

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.apiKey = env.ELEVENLABS_API_KEY || "";
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async transcribe(filePath: string, options?: TranscribeOptions): Promise<TranscriptionEnvelope> {
    const check = checkAudioFile(filePath);
    if (!check.ok) return failure(this.name, new Error(check.error));
    if (!this.isAvailable()) return failure(this.name, new Error("elevenlabs not configured (missing ELEVENLABS_API_KEY)"));
    try {
      const form = new FormData();
      form.set("file", new Blob([fs.readFileSync(filePath)], { type: "audio/mpeg" }), path.basename(filePath));
      if (options?.model) form.set("model_id", options.model);

      const res = await fetch(`${this.baseUrl}/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": this.apiKey },
        body: form,
        signal: AbortSignal.timeout(300_000),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        return failure(this.name, new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`));
      }
      const json = (await res.json()) as { text?: string };
      return envelope(this.name, String(json.text ?? ""));
    } catch (err) {
      return failure(this.name, err instanceof Error ? err : new Error(String(err)));
    }
  }
}

// ── Registry + 默认构建 ───────────────────────────────────────────────────────

/** 注册表（内置名冲突拒绝——对齐 Hermes BUILTIN 名冲突校验）。 */
export class SttRegistry {
  private readonly providers = new Map<string, TranscriptionProvider>();

  register(p: TranscriptionProvider): TranscriptionProvider {
    if (BUILTIN_STT_PROVIDERS.has(p.name) && this.providers.has(p.name)) {
      throw new Error(`stt provider '${p.name}' is a built-in name already registered (name collision)`);
    }
    this.providers.set(p.name, p);
    return p;
  }

  get(name: string): TranscriptionProvider | undefined {
    return this.providers.get(name);
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  names(): string[] {
    return [...this.providers.keys()];
  }

  /** 默认链选：按 order 试第一个 isAvailable；全部不可用 → null。 */
  resolveChain(order?: string[]): TranscriptionProvider | null {
    const names = order && order.length > 0 ? order : [...this.providers.keys()];
    for (const name of names) {
      const p = this.providers.get(name);
      if (p && p.isAvailable()) return p;
    }
    return null;
  }
}

/** 创建默认 STT 注册表（env 驱动；显式 STT_PROVIDER 选择后按其链序注册）。 */
export function createSttRegistry(env: NodeJS.ProcessEnv = process.env): SttRegistry {
  const registry = new SttRegistry();
  registry.register(new LocalFasterWhisperProvider(env));
  registry.register(
    new OpenAiCompatibleSttProvider("openai", env, {
      baseUrlEnv: "STT_OPENAI_BASE_URL",
      keyEnvs: ["OPENAI_API_KEY", "STT_API_KEY", "STT_OPENAI_API_KEY"],
      defaultModel: "whisper-1",
      defaultBaseUrl: "https://api.openai.com/v1",
    })
  );
  registry.register(
    new OpenAiCompatibleSttProvider("groq", env, {
      baseUrlEnv: "STT_GROQ_BASE_URL",
      keyEnvs: ["GROQ_API_KEY"],
      defaultModel: "whisper-large-v3-turbo",
      defaultBaseUrl: "https://api.groq.com/openai/v1",
    })
  );
  registry.register(
    new OpenAiCompatibleSttProvider("mistral", env, {
      baseUrlEnv: "STT_MISTRAL_BASE_URL",
      keyEnvs: ["MISTRAL_API_KEY"],
      defaultModel: "voxtral-mini-latest",
      defaultBaseUrl: "https://api.mistral.ai/v1",
    })
  );
  registry.register(
    new OpenAiCompatibleSttProvider("xai", env, {
      baseUrlEnv: "STT_XAI_BASE_URL",
      keyEnvs: ["XAI_API_KEY"],
      defaultModel: "whisper-large-v3",
      defaultBaseUrl: "https://api.x.ai/v1",
    })
  );
  registry.register(new ElevenLabsSttProvider(env));
  registry.register(
    new OpenAiCompatibleSttProvider("deepinfra", env, {
      baseUrlEnv: "STT_DEEPINFRA_BASE_URL",
      keyEnvs: ["DEEPINFRA_API_KEY"],
      defaultModel: "whisper-large-v3",
      defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
    })
  );
  return registry;
}
