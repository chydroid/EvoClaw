import type { AgentModelExecutor } from "@evoclaw/agent";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { randomBytes } from "crypto";

/**
 * TTS Tools — 文本转语音复合工具
 *
 * 对标 Hermes `tools/tts_tool.py`：让 Agent 在对话中调用 TTS 引擎
 * 将文本转为音频文件，返回文件路径供渠道层作为附件发送。
 *
 * EvoClaw 已有 `OpenAITTSProvider`（packages/infrastructure/src/tts-stream.ts）
 * 但仅用于流式语音模式输出侧（Web Audio / SSE），从未注册为模型可调用工具。
 * 此处直接调用 OpenAI /audio/speech 端点，保存完整音频文件。
 */

/** TTS 输出格式 */
const TTS_FORMATS = ["mp3", "opus", "aac", "flac", "pcm", "wav"] as const;

/**
 * 获取默认 TTS 输出目录（对标 Hermes ~/voice-memos/）。
 * 使用 os.tmpdir() 下的 evoclaw-tts 子目录，避免污染 workspace。
 */
function getDefaultOutputDir(): string {
  const dir = path.join(os.tmpdir(), "evoclaw-tts");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 生成安全的输出文件名（CSPRNG 后缀，防止符号链接劫持）。
 */
function generateTtsFilename(ext: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = randomBytes(6).toString("hex");
  return `tts-${stamp}-${rand}.${ext}`;
}

/**
 * 检测 TTS 是否可用（checkFn 服务门控）。
 * 需要 TTS_API_KEY 或 TTS_ENDPOINT + TTS_API_KEY 环境变量。
 */
export function checkTtsRequirements(): boolean {
  return Boolean(process.env.TTS_API_KEY);
}

/**
 * 合成文本为音频文件。
 *
 * 直接调用 OpenAI 兼容 /audio/speech 端点（支持 instructions 指令），
 * 保存完整音频到 output_path，返回文件信息。
 */
async function synthesizeTts(
  text: string,
  options: {
    outputPath?: string;
    format?: string;
    speed?: number;
    instructions?: string;
  },
): Promise<{ path: string; format: string; size: number; duration: number }> {
  const endpoint = (process.env.TTS_ENDPOINT || "https://api.openai.com/v1").replace(/\/$/, "");
  const apiKey = process.env.TTS_API_KEY;
  const model = process.env.TTS_MODEL || "gpt-4o-mini-tts";
  const voice = process.env.TTS_VOICE || "alloy";

  if (!apiKey) {
    return {
      path: "",
      format: "",
      size: 0,
      duration: 0,
    };
  }

  const format = (options.format || "mp3").toLowerCase();
  if (!TTS_FORMATS.includes(format as (typeof TTS_FORMATS)[number])) {
    throw new Error(`Unsupported format: ${format}. Supported: ${TTS_FORMATS.join(", ")}`);
  }

  // 构造请求体
  const body: Record<string, unknown> = {
    model,
    voice,
    input: text,
    response_format: format,
  };
  if (options.speed !== undefined) {
    // OpenAI TTS 不支持 speed 参数；部分兼容网关支持 speed
    // 透传但不作为核心依赖
    body.speed = options.speed;
  }
  if (options.instructions) {
    body.instructions = options.instructions;
  }

  const res = await fetch(`${endpoint}/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`TTS API error (${res.status}): ${errText.slice(0, 300)}`);
  }

  const audioBuf = Buffer.from(await res.arrayBuffer());

  // 确定输出路径
  const outputDir = options.outputPath ? path.dirname(options.outputPath) : getDefaultOutputDir();
  const filename = options.outputPath
    ? path.basename(options.outputPath)
    : generateTtsFilename(format);
  const outputPath = path.join(outputDir, filename);

  // 确保目录存在
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 原子写入（temp + rename，对标 AGENTS.md atomicWriteFile 约定）
  const tmpFile = outputPath + `.tmp-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmpFile, audioBuf);
  fs.renameSync(tmpFile, outputPath);

  const stat = fs.statSync(outputPath);

  return {
    path: outputPath,
    format,
    size: stat.size,
    duration: 0, // OpenAI TTS API 不返回时长，需前端按采样率估算
  };
}

/**
 * 注册 TTS 工具到 AgentModelExecutor。
 *
 * 注册 `text_to_speech` 工具，schema 对标 Hermes TTS_SCHEMA：
 *   - text (required): 要转为语音的文本
 *   - output_path (optional): 输出文件路径
 *   - speed (optional): 播放速度（0.25-4.0，默认 1.0）
 *   - instructions (optional): 语音设计指令（语气/情感/语速/口音）
 */
export function registerTtsTools(executor: AgentModelExecutor): void {
  // checkFn：仅在 TTS_API_KEY 配置时暴露工具
  const checkFn = (): boolean => checkTtsRequirements();

  const definition = {
    name: "text_to_speech",
    description:
      "Convert text to speech audio. Returns a file path that can be sent as an audio attachment. " +
      "Requires TTS_API_KEY to be configured. " +
      "Supports OpenAI-compatible TTS endpoints (default: OpenAI gpt-4o-mini-tts). " +
      "Use for: reading text aloud, generating audio clips, voice messages.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "The text to convert to speech. Maximum 4096 characters for OpenAI; longer input will be truncated.",
        },
        output_path: {
          type: "string",
          description:
            "Optional output file path. If not specified, saves to a temporary directory. Default format: mp3.",
        },
        speed: {
          type: "number",
          description:
            "Playback speed multiplier. 1.0 = normal, 0.5 = very slow, 2.0 = fast. Range: 0.25-4.0.",
        },
        instructions: {
          type: "string",
          description:
            "Optional voice-design guidance: tone, emotion, pacing, accent, whispering. " +
            "Forwarded to the OpenAI backend. Silently ignored by backends that don't support it.",
        },
      },
      required: ["text"],
    },
  };

  const handler = async (params: Record<string, unknown>): Promise<unknown> => {
    const text = String(params.text || "");
    if (!text.trim()) {
      return { error: "text is required" };
    }

    if (text.length > 4096) {
      return {
        error: `Text exceeds maximum length (4096 chars). Current: ${text.length}. Please shorten or split into multiple calls.`,
      };
    }

    try {
      const result = await synthesizeTts(text, {
        outputPath: typeof params.output_path === "string" ? params.output_path : undefined,
        format: typeof params.output_path === "string"
          ? path.extname(params.output_path).replace(".", "")
          : undefined,
        speed: typeof params.speed === "number" ? params.speed : undefined,
        instructions: typeof params.instructions === "string" ? params.instructions : undefined,
      });

      if (!result.path) {
        return { error: "TTS is not available. Please configure TTS_API_KEY environment variable." };
      }

      return {
        path: result.path,
        format: result.format,
        size: result.size,
        message: `Audio saved to ${result.path} (${(result.size / 1024).toFixed(1)} KB, ${result.format})`,
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
