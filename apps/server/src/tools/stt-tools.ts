/**
 * STT Tools — 语音转文本复合工具（Hermes 对齐 Step 5）
 *
 * 对标 Hermes `tools/transcription_tool.py`：取音频文件 → 转写文本。
 * EvoClaw 用 `packages/infrastructure/src/stt-providers.ts` 的 SttRegistry
 * （7 家：local faster-whisper 免费默认 / openai / groq / mistral / xai / elevenlabs / deepinfra）。
 *
 * 信封语义：transcribe 永不抛（provider 内捕获一切异常）；工具层把逐家错误聚合成 error 返回。
 * checkFn：链上任意一家 isAvailable 即暴露工具（local 免费默认 → 无云 key 也可用）。
 */

import type { AgentModelExecutor } from "@evoclaw/agent";
import type { ServiceRegistry } from "@evoclaw/core";
import {
  STT_DEFAULT_CHAIN,
  createSttRegistry,
  type SttRegistry,
  type TranscriptionEnvelope,
} from "@evoclaw/infrastructure";
import * as fs from "fs";

/** 服务未注入时的模块级 fallback 实例（惰性、只读 process.env 构建一次） */
let fallbackSttRegistry: SttRegistry | null = null;

function getSttRegistry(registry: ServiceRegistry | undefined): SttRegistry {
  const svc = registry?.resolveService<SttRegistry>("sttRegistry");
  if (svc) return svc;
  if (!fallbackSttRegistry) fallbackSttRegistry = createSttRegistry(process.env);
  return fallbackSttRegistry;
}

/**
 * 检测 STT 工具是否可暴露（checkFn 服务门控）。
 * 链上任意一家 isAvailable 即暴露（local 免费默认；否则任一云 key 配置即暴露）。
 */
export function checkSttRequirements(registry?: ServiceRegistry): boolean {
  return getSttRegistry(registry).resolveChain() !== null;
}

/**
 * 转写音频文件。
 *
 * 按 candidates 链依次尝试：首个成功信封即返回；全部失败 → failure 信封（聚合逐家 error）。
 */
async function transcribeWithProviders(
  reg: SttRegistry,
  audioPath: string,
  options: { model?: string; language?: string; provider?: string }
): Promise<TranscriptionEnvelope> {
  if (!fs.existsSync(audioPath)) {
    return { success: false, transcript: "", provider: "chain", error: `audio file not found: ${audioPath}` };
  }
  if (!fs.statSync(audioPath).isFile()) {
    return { success: false, transcript: "", provider: "chain", error: `not a file: ${audioPath}` };
  }

  const order = options.provider
    ? [options.provider, ...STT_DEFAULT_CHAIN.filter((n) => n !== options.provider)]
    : STT_DEFAULT_CHAIN;
  const seen = new Set<string>();
  const candidates = order
    .map((n) => reg.get(n))
    .filter((p): p is NonNullable<typeof p> => {
      if (!p || seen.has(p.name)) return false;
      seen.add(p.name);
      return true;
    });
  // 显式未知 provider → 快速报错（不静默降级到默认链，参数错误需暴露）
  if (options.provider && !reg.has(options.provider)) {
    return { success: false, transcript: "", provider: "chain", error: `Unknown STT provider: ${options.provider}. Registered: ${reg.names().join(", ")}` };
  }

  const errors: string[] = [];
  for (const p of candidates) {
    if (!p.isAvailable()) {
      errors.push(`${p.name}: not available`);
      continue;
    }
    const env = await p.transcribe(audioPath, { model: options.model, language: options.language });
    if (env.success) return env;
    errors.push(`${p.name}: ${env.error ?? "failed"}`);
  }
  return { success: false, transcript: "", provider: "chain", error: `All STT providers failed (${errors.join(" | ")})` };
}

/**
 * 注册 STT 工具到 AgentModelExecutor。
 *
 * schema 对标 Hermes transcription_tool_schema：
 *   - audio_path (required): 待转写音频文件路径（mp3/wav/ogg/opus/flac，≤16MB）
 *   - provider (optional): 指定 provider（如 "local"）；缺省按链选（local 免费优先）
 *   - language (optional): 语言代码（如 zh/en；缺省自动检测）
 *   - model (optional): 模型名（不同 provider 默认不同）
 */
export function registerSttTools(executor: AgentModelExecutor, registry?: ServiceRegistry): void {
  const checkFn = (): boolean => checkSttRequirements(registry);

  const definition = {
    name: "audio_to_text",
    description:
      "Transcribe an audio file to text. Returns the transcript with the provider used. " +
      "Provider chain: local faster-whisper (free, cpu) → openai → groq → mistral → xai → elevenlabs → deepinfra. " +
      "Use for: voice messages, meeting recordings, audio notes.",
    parameters: {
      type: "object",
      properties: {
        audio_path: {
          type: "string",
          description: "Path to the audio file to transcribe. Supported: mp3/wav/ogg/opus/flac, up to 16MB.",
        },
        provider: {
          type: "string",
          required: false,
          description: "Optional provider name to force: local/openai/groq/mistral/xai/elevenlabs/deepinfra. Default: first available in the chain (local first).",
        },
        language: {
          type: "string",
          required: false,
          description: "Optional language code (e.g. zh, en). If unspecified, auto-detected by the backend.",
        },
        model: {
          type: "string",
          required: false,
          description: "Optional model override (e.g. whisper-large-v3). Defaults differ per provider.",
        },
      },
      required: ["audio_path"],
    },
  };

  const handler = async (params: Record<string, unknown>): Promise<unknown> => {
    const audioPath = String(params.audio_path || "");
    if (!audioPath.trim()) {
      return { error: "audio_path is required" };
    }
    const env = await transcribeWithProviders(getSttRegistry(registry), audioPath, {
      model: typeof params.model === "string" ? params.model : undefined,
      language: typeof params.language === "string" ? params.language : undefined,
      provider: typeof params.provider === "string" ? params.provider : undefined,
    });
    return env;
  };

  executor.registerTool(
    "audio_to_text",
    definition,
    handler,
    checkFn,
  );
}
