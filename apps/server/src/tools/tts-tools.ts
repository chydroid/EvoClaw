/**
 * TTS Tools — 文本转语音复合工具（Hermes 对齐 Step 5：Provider Registry 链选）
 *
 * 对标 Hermes `tools/tts_tool.py`：文本 → 音频文件（落盘路径），返回给渠道层作附件。
 * EvoClaw 用 `packages/infrastructure/src/tts-providers.ts` 的 ProviderRegistry
 * （8 家内置：edge 免费默认 / openai / elevenlabs / minimax / mistral / gemini / xai / deepinfra）。
 *
 * 本轮改动：
 * - 不再Only OpenAI 直调；默认按链选第一个 isAvailable 的 provider，失败自动降级下一家。
 * - 显式 `provider` 参数优先，链兜底。
 * - 输出格式钳位到 mp3/wav/ogg/opus/flac（Hermes resolve_output_format 语义）。
 * - checkFn 改为「任意一家可用」即暴露工具（edge 免费默认 → 无需 key）。
 */

import type { AgentModelExecutor } from "@evoclaw/agent";
import type { ServiceRegistry } from "@evoclaw/core";
import {
  resolveOutputFormat,
  TTS_DEFAULT_CHAIN,
  createTTSRegistry,
  type ProviderRegistry,
  type TTSProvider,
} from "@evoclaw/infrastructure";
import * as path from "path";
import * as fs from "fs";

/** 服务未注入时的模块级 fallback 实例（惰性、只读 process.env 构建一次） */
let fallbackTtsRegistry: ProviderRegistry<TTSProvider> | null = null;

/**
 * 获取 TTS Provider Registry（优先服务注入，fallback 临时构建）。
 */
function getTtsRegistry(registry: ServiceRegistry | undefined): ProviderRegistry<TTSProvider> {
  const svc = registry?.resolveService<ProviderRegistry<TTSProvider>>("ttsRegistry");
  if (svc) return svc;
  if (!fallbackTtsRegistry) fallbackTtsRegistry = createTTSRegistry(process.env);
  return fallbackTtsRegistry;
}

/**
 * 检测 TTS 工具是否可暴露（checkFn 服务门控）。
 * 链上任意一家 isAvailable 即暴露（edge 免费默认；否则任一云 key 配置即暴露）。
 * 保留历史无参调用形式（fallback 实例）。
 */
export function checkTtsRequirements(registry?: ServiceRegistry): boolean {
  return getTtsRegistry(registry).resolveChain() !== null;
}

/**
 * 合成文本为音频文件。
 *
 * 按 candidates 链依次尝试：成功返回 {path, format, size, provider}；
 * 全部失败抛 Error（附逐家原因，工具层降级为 error 消息）。
 */
async function synthesizeTts(
  reg: ProviderRegistry<TTSProvider>,
  text: string,
  options: {
    outputPath?: string;
    format?: string;
    speed?: number;
    voice?: string;
    model?: string;
    instructions?: string;
    provider?: string;
  }
): Promise<{ path: string; format: string; size: number; provider: string }> {
  const format = resolveOutputFormat(options.format);
  // 显式 provider 优先，其后为默认链（去重保序）
  const order = options.provider
    ? [options.provider, ...TTS_DEFAULT_CHAIN.filter((n) => n !== options.provider)]
    : TTS_DEFAULT_CHAIN;
  const seen = new Set<string>();
  const candidates = order
    .map((n) => reg.get(n))
    .filter((p): p is TTSProvider => {
      if (!p || seen.has(p.name)) return false;
      seen.add(p.name);
      return true;
    });
  // 显式未知 provider → 快速报错（对齐 Hermes：不静默降级到默认链，参数错误需暴露）
  if (options.provider && !reg.has(options.provider)) {
    throw new Error(`Unknown TTS provider: ${options.provider}. Registered: ${reg.names().join(", ")}`);
  }

  const errors: string[] = [];
  for (const p of candidates) {
    if (!p.isAvailable()) {
      errors.push(`${p.name}: not available`);
      continue;
    }
    try {
      const head = await p.synthesize(text, {
        outputPath: options.outputPath,
        format,
        speed: options.speed,
        voice: options.voice,
        model: options.model,
        instructions: options.instructions,
      });
      const stat = fs.statSync(head);
      return { path: head, format, size: stat.size, provider: p.name };
    } catch (err) {
      errors.push(`${p.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`All TTS providers failed (${errors.join(" | ")})`);
}

/**
 * 注册 TTS 工具到 AgentModelExecutor。
 *
 * schema 对齐 Hermes TTS_SCHEMA + provider 选择：
 *   - text (required): 要转为语音的文本
 *   - provider (optional): 指定 provider（如 "edge"）；缺省按链选（edge 免费优先）
 *   - voice (optional): 音色（edge: 如 en-US-AriaNeural；各默认见 provider 默认值）
 *   - output_path (optional): 输出文件路径（扩展名即格式）
 *   - speed (optional): 播放速度（0.25-4.0，默认 1.0）
 *   - instructions (optional): 语音设计指令（仅部分后端支持）
 */
export function registerTtsTools(executor: AgentModelExecutor, registry?: ServiceRegistry): void {
  const checkFn = (): boolean => checkTtsRequirements(registry);

  const definition = {
    name: "text_to_speech",
    description:
      "Convert text to speech audio. Returns a file path that can be sent as an audio attachment. " +
      "Works with the first available provider from the chain: edge (free, python edge-tts), openai, " +
      "elevenlabs, minimax, mistral, gemini, xai, deepinfra. " +
      "Use for: reading text aloud, generating audio clips, voice messages.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "The text to convert to speech. Maximum 4096 characters; longer input will be truncated or rejected.",
        },
        provider: {
          type: "string",
          required: false,
          description:
            "Optional provider name to force: edge/openai/elevenlabs/minimax/mistral/gemini/xai/deepinfra. Default: first available in the chain (edge first).",
        },
        voice: {
          type: "string",
          required: false,
          description:
            "Optional voice/voice-id. Edge uses Microsoft Neural voices (e.g. en-US-AriaNeural); other backends use their own voice ids (OpenAI: alloy/nova/...).",
        },
        output_path: {
          type: "string",
          description:
            "Optional output file path. If unspecified, saves to a temp dir. Extension selects format (clamped to mp3/wav/ogg/opus/flac).",
        },
        speed: {
          type: "number",
          required: false,
          description:
            "Playback speed multiplier. 1.0 = normal, 0.5 = very slow, 2.0 = fast. Range: 0.25-4.0.",
        },
        instructions: {
          type: "string",
          description:
            "Optional voice-design guidance: tone, emotion, pacing, accent, whispering. " +
            "Forwarded to syntax-aware backends (Edge: ignored; OpenAI-compatible: passed through).",
        },
      },
      required: ["text"],
    },
  };

  const handler = async (params: Record<string, unknown>): Promise<unknown> => {
    let text = String(params.text || "");
    if (!text.trim()) {
      return { error: "text is required" };
    }
    if (text.length > 4096) {
      return {
        error: `Text exceeds maximum length (4096 chars). Current: ${text.length}. Please shorten or split into multiple calls.`,
      };
    }

    try {
      const result = await synthesizeTts(getTtsRegistry(registry), text, {
        outputPath: typeof params.output_path === "string" ? params.output_path : undefined,
        format: typeof params.output_path === "string"
          ? path.extname(params.output_path).replace(".", "")
          : undefined,
        speed: typeof params.speed === "number" ? params.speed : undefined,
        voice: typeof params.voice === "string" ? params.voice : undefined,
        instructions: typeof params.instructions === "string" ? params.instructions : undefined,
        provider: typeof params.provider === "string" ? params.provider : undefined,
      });

      return {
        path: result.path,
        format: result.format,
        size: result.size,
        provider: result.provider,
        message: `Audio saved to ${result.path} (${(result.size / 1024).toFixed(1)} KB, ${result.format}, via ${result.provider})`,
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  executor.registerTool(
    "text_to_speech",
    definition,
    handler,
    checkFn,
  );
}
