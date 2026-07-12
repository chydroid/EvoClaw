import { Express, Request, Response } from "express";
import { ServiceRegistry, EventBus, FeatureFlagStore } from "@evoclaw/core";
import { taskStatusTracker, taskCheckpointManager, ModelFailoverManager, getToolResultMiddleware } from "@evoclaw/agent";
import * as crypto from "crypto";
import { IncomingWebhookManager } from "./webhook-manager";
import type { WebhookEndpoint } from "./webhook-manager";
import { spawn } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { DeadLetterQueue } from "./dead-letter-queue";
import { HealthAggregator } from "./health-aggregator";
import { ReplyReferenceManager } from "./reply-reference";
import { MessageTemplateEngine } from "./message-templates";
import { CanvasHost } from "./canvas-host";
import { FeishuAdapter } from "./channels/feishu";
import { MatrixAdapter } from "./channels/matrix";
import type { ChannelAdapter, ChannelConfig, ChannelType } from "./channel-manager";
import { atomicWriteFileSync } from "./atomic-write";

const CLI_SCRIPT_PATH = path.resolve(__dirname, "..", "..", "..", "apps", "cli", "dist", "index.js");

const ALLOWED_CLI_COMMANDS = [
  "setup", "onboard", "configure", "config", "doctor", "dashboard", "completion",
  "health", "status", "sessions",
  "agent", "agents", "message", "acp",
  "skills", "memory", "models",
  "gateway", "logs", "system",
  "channels", "security", "secrets", "approvals", "pairing",
  "sandbox", "tasks", "hooks",
  "cron", "webhooks", "plugins", "mcp",
  "directory", "docs",
  "update", "backup", "uninstall", "reset",
] as const;

const FORBIDDEN_PATTERNS = [
  /rm\s+-rf/, /sudo\s/, /\|.*rm/, /;\s*rm/, /`.*`/,
  /delete\s+-\w*i\w*/, /DROP\s+TABLE/i, /TRUNCATE/i,
  /format\s+[A-Z]:/i, /del\s+\/f\s+\/s/i,
];

const CLI_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 1024 * 512;

const DATA_DIR = path.resolve(process.cwd(), "data", "config");
const LLM_CONFIG_FILE = path.join(DATA_DIR, "llm-providers.json");
const IMAGE_GEN_CONFIG_FILE = path.join(DATA_DIR, "image-gen-providers.json");
const VIDEO_GEN_CONFIG_FILE = path.join(DATA_DIR, "video-gen-providers.json");
const CHANNELS_CONFIG_FILE = path.join(DATA_DIR, "channels.json");
const ENV_FILE = path.resolve(process.cwd(), ".env");

// ── 默认图片生成提供商 ──────────────────────────────────────────────────────
const DEFAULT_IMAGE_GEN_PROVIDERS: Record<string, unknown>[] = [
  {
    id: "pollinations",
    name: "Pollinations.ai (Free)",
    apiKey: "",
    baseURL: "https://image.pollinations.ai/prompt",
    model: "flux",
    enabled: true,
    order: 1,
  },
  {
    id: "fal",
    name: "Fal.ai",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/flux-2/klein/9b",
    enabled: false,
    order: 2,
  },
  {
    id: "openai",
    name: "OpenAI (DALL-E / GPT Image)",
    apiKey: "",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-image-2",
    enabled: false,
    order: 3,
  },
  {
    id: "google",
    name: "Google (Nano Banana / Imagen)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/nano-banana-2",
    enabled: false,
    order: 4,
  },
  {
    id: "jimeng",
    name: "即梦 (Jimeng / 字节)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/jimeng",
    enabled: false,
    order: 5,
  },
  {
    id: "doubao-image",
    name: "豆包图像 (Doubao / Seedream)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/seedream-5",
    enabled: false,
    order: 6,
  },
  {
    id: "qwen-wanx",
    name: "通义万相 (Wanx)",
    apiKey: "",
    baseURL: "https://dashscope.aliyuncs.com/api/v1",
    model: "wanx-v1",
    enabled: false,
    order: 7,
  },
  {
    id: "kling-image",
    name: "可灵图像 (Kling Image)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/kling/image-to-image",
    enabled: false,
    order: 8,
  },
  {
    id: "zhipu-cogview",
    name: "智谱CogView",
    apiKey: "",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    model: "cogview-4",
    enabled: false,
    order: 9,
  },
  {
    id: "baidu-ernie",
    name: "百度文心一格",
    apiKey: "",
    baseURL: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1",
    model: "ernie-vilg-v2",
    enabled: false,
    order: 10,
  },
  {
    id: "minimax-image",
    name: "MiniMax 图片生成",
    apiKey: "",
    baseURL: "https://api.minimax.chat/v1",
    model: "image-01",
    enabled: false,
    order: 11,
  },
  {
    id: "ideogram",
    name: "Ideogram",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/ideogram/v3",
    enabled: false,
    order: 12,
  },
  {
    id: "recraft",
    name: "Recraft",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/recraft/v4/pro/text-to-image",
    enabled: false,
    order: 13,
  },
];

// ── 默认视频生成提供商 ──────────────────────────────────────────────────────
const DEFAULT_VIDEO_GEN_PROVIDERS: Record<string, unknown>[] = [
  {
    id: "fal",
    name: "Fal.ai (Wan 2.2 Fast)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/wan/v2.2-5b/text-to-video/fast-wan",
    enabled: false,
    order: 1,
  },
  {
    id: "kling",
    name: "可灵视频 (Kling 3.0)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/kling-video/v3/standard/text-to-video",
    enabled: false,
    order: 2,
  },
  {
    id: "doubao-video",
    name: "豆包视频 (Seedance 2.0 / 字节)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "bytedance/seedance-2.0/text-to-video",
    enabled: false,
    order: 3,
  },
  {
    id: "qwen-wan-video",
    name: "通义万相视频 (Wan Video A14B)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/wan/v2.2-a14b/text-to-video",
    enabled: false,
    order: 4,
  },
  {
    id: "luma",
    name: "Luma Dream Machine",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/luma-dream-machine",
    enabled: false,
    order: 5,
  },
  {
    id: "vidu",
    name: "Vidu Q3",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/vidu/q3/text-to-video",
    enabled: false,
    order: 6,
  },
  {
    id: "hailuo",
    name: "海螺视频 (Hailuo 2.3)",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/hailuo-video-2.3/text-to-video",
    enabled: false,
    order: 7,
  },
  {
    id: "seedance",
    name: "Seedance 1.5 Pro",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/seedance-1.5-pro/text-to-video",
    enabled: false,
    order: 8,
  },
  {
    id: "google-veo",
    name: "Google Veo 3.1",
    apiKey: "",
    baseURL: "https://fal.run",
    model: "fal-ai/google/veo-3.1/fast/text-to-video",
    enabled: false,
    order: 9,
  },
  {
    id: "minimax-video",
    name: "MiniMax 视频生成",
    apiKey: "",
    baseURL: "https://api.minimax.chat/v1",
    model: "video-01",
    enabled: false,
    order: 10,
  },
  {
    id: "replicate",
    name: "Replicate",
    apiKey: "",
    baseURL: "https://api.replicate.com/v1",
    model: "lightricks/ltx-video",
    enabled: false,
    order: 11,
  },
  {
    id: "local",
    name: "Local FFmpeg",
    apiKey: "",
    baseURL: "",
    model: "ffmpeg-slideshow",
    enabled: true,
    order: 12,
  },
];

// ── EnvSecretManager: manages sensitive credentials in .env ──────────────────
// JSON configs store "${VAR_NAME}" references; real values live in .env
const ENV_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

class EnvSecretManager {
  private cache: Map<string, string> = new Map();
  private loaded = false;

  /** Load .env file into cache */
  load(): void {
    this.cache.clear();
    try {
      if (!fs.existsSync(ENV_FILE)) { this.loaded = true; return; }
      const lines = fs.readFileSync(ENV_FILE, "utf-8").split("\n");
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        // Remove surrounding quotes if present
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        this.cache.set(key, val);
      }
    } catch { /* ignore */ }
    this.loaded = true;
  }

  /** Get a value from .env cache (also checks process.env) */
  get(key: string): string | undefined {
    if (!this.loaded) this.load();
    return this.cache.get(key) ?? process.env[key];
  }

  /** Set a value in .env cache and persist to file */
  set(key: string, value: string): void {
    if (!this.loaded) this.load();
    this.cache.set(key, value);
    this.persist();
  }

  /** Delete a key from .env cache and persist */
  delete(key: string): void {
    if (!this.loaded) this.load();
    this.cache.delete(key);
    this.persist();
  }

  /** Resolve a value: if it's a ${VAR} reference, return the real value; otherwise return as-is */
  resolve(value: unknown): unknown {
    if (typeof value !== "string") return value;
    const m = value.match(ENV_REF_RE);
    if (m) {
      const resolved = this.get(m[1]);
      return resolved ?? value; // Return reference itself if not found in .env
    }
    return value;
  }

  /** Check if a value is a ${VAR} reference */
  isRef(value: unknown): boolean {
    return typeof value === "string" && ENV_REF_RE.test(value);
  }

  /** Get all key names from cache */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /** Generate an env var name for a provider/channel secret */
  static makeLLMKeyVar(providerId: string): string {
    const safe = providerId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
    return `LLM_${safe}_API_KEY`;
  }

  static makeChannelVar(channelId: string, field: string): string {
    const safe = channelId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
    const safeField = field.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
    return `CHANNEL_${safe}_${safeField}`;
  }

  static makeImageGenKeyVar(providerId: string): string {
    const safe = providerId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
    return `IMAGE_GEN_${safe}_API_KEY`;
  }

  static makeVideoGenKeyVar(providerId: string): string {
    const safe = providerId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
    return `VIDEO_GEN_${safe}_API_KEY`;
  }

  /** Persist all cached values to .env file, preserving comments and structure */
  private persist(): void {
    try {
      // Read existing file to preserve comments and non-secret keys
      const existingLines: string[] = [];
      const existingKeys = new Set<string>();
      if (fs.existsSync(ENV_FILE)) {
        const raw = fs.readFileSync(ENV_FILE, "utf-8");
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) {
            existingLines.push(line);
            continue;
          }
          const eq = trimmed.indexOf("=");
          if (eq < 1) { existingLines.push(line); continue; }
          const key = trimmed.slice(0, eq).trim();
          existingKeys.add(key);
          if (this.cache.has(key)) {
            // Update with new value
            existingLines.push(`${key}=${this.cache.get(key)}`);
          } else {
            existingLines.push(line);
          }
        }
      }

      // Add new keys that don't exist in file yet
      const newKeys = [...this.cache.keys()].filter((k) => !existingKeys.has(k));
      if (newKeys.length > 0) {
        existingLines.push("");
        existingLines.push("# Auto-managed credentials (do not edit manually)");
        for (const key of newKeys) {
          existingLines.push(`${key}=${this.cache.get(key)}`);
        }
      }

      // 原子写入 .env：temp + fsync + rename，防止崩溃时 .env 损坏导致所有环境变量丢失
      const tmpPath = `${ENV_FILE}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
      const fd = fs.openSync(tmpPath, "w");
      try {
        fs.writeFileSync(fd, existingLines.join("\n") + "\n", "utf-8");
        fs.fsyncSync(fd);
      } catch (werr) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw werr;
      }
      fs.closeSync(fd);
      try {
        if (fs.existsSync(ENV_FILE)) {
          const st = fs.statSync(ENV_FILE);
          fs.chmodSync(tmpPath, st.mode);
        }
      } catch { /* ignore */ }
      try {
        fs.renameSync(tmpPath, ENV_FILE);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EXDEV" || code === "EBUSY") {
          // 跨设备回退
          const content = fs.readFileSync(tmpPath, "utf-8");
          const dstTmp = `${ENV_FILE}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.dst.tmp`;
          const fd2 = fs.openSync(dstTmp, "w");
          try {
            fs.writeFileSync(fd2, content, "utf-8");
            fs.fsyncSync(fd2);
          } catch (w2err) {
            try { fs.closeSync(fd2); } catch { /* ignore */ }
            try { fs.unlinkSync(dstTmp); } catch { /* ignore */ }
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
            throw w2err;
          }
          fs.closeSync(fd2);
          try {
            fs.renameSync(dstTmp, ENV_FILE);
          } catch (renameErr) {
            try { fs.unlinkSync(dstTmp); } catch { /* ignore cleanup */ }
            try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup */ }
            throw renameErr;
          }
          try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup */ }
        } else {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          throw err;
        }
      }
    } catch (err) {
      process.stderr.write("[EnvSecretManager] Failed to persist .env:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
    }
  }
}

// Sensitive field names for channels
const CHANNEL_SECRET_FIELDS = ["appId", "appSecret", "verificationToken", "encryptKey"];

export type TaskComplexity = "simple" | "medium" | "complex" | "very_complex";

export interface ComplexityEstimate {
  level: TaskComplexity;
  timeoutMs: number;
  shouldAutoSplit: boolean;
  maxSubtasks: number;
}

const COMPLEXITY_TIMEOUT_MAP: Record<TaskComplexity, number> = {
  simple: 300_000,
  medium: 600_000,
  complex: 1_200_000,
  very_complex: 1_800_000,
};

const COMPLEXITY_PATTERNS: Array<{ patterns: RegExp[]; complexity: TaskComplexity; excludePatterns?: RegExp[] }> = [
  {
    patterns: [
      /实现.*完整.*系统/i, /implement.*complete.*system/i,
      /全栈.*应用/i, /full.?stack.*app/i,
      /设计.*架构.*实现/i, /design.*architecture.*implement/i,
      /从零.*构建/i, /build.*from.*scratch/i,
      /多模块.*项目/i, /multi.?module.*project/i,
      /端到端.*测试/i, /end.?to.?end.*test/i,
      /复杂.*编码.*任务/i, /complex.*coding.*task/i,
      /重构.*整个/i, /refactor.*entire/i,
    ],
    complexity: "very_complex",
  },
  {
    patterns: [
      /创建.*(?:Word|Excel|PPT|文档|表格|演示).*(?:图形|图片|表格|图表|漂亮|完整|详细)/i,
      /create.*(?:Word|Excel|PPT|document|spreadsheet|presentation).*(?:image|picture|table|chart|diagram|pretty|complete|detailed)/i,
      /创建.*项目/i, /create.*project/i,
      /编写.*类.*方法/i, /write.*class.*method/i,
      /实现.*算法/i, /implement.*algorithm/i,
      /开发.*功能/i, /develop.*feature/i,
      /编写.*测试/i, /write.*test/i,
      /代码.*审查/i, /code.*review/i,
      /调试.*修复/i, /debug.*fix/i,
      /数据.*处理.*管道/i, /data.*pipeline/i,
      /API.*服务/i, /api.*server/i,
      /React.*组件/i, /react.*component/i,
      // Download/resource fetching tasks — need more time for web search + fetch + file creation
      // NOTE: "想听/播放/来首" are PLAYBACK intents, NOT download — excluded below via negative lookahead
      /^(?!.*(?:想听|播放|来首|听歌|听一下|放一首)).*下载.*(?:小说|音乐|视频|论文|电子书|书籍|电影|歌曲)/i,
      /^(?!.*(?:want to (?:listen|hear|play)|play some)).*download.*(?:novel|music|video|paper|ebook|book|movie|song)/i,
      /爬取.*(?:小说|文章|内容|数据)/i,
      /scrape.*(?:novel|article|content|data)/i,
      /(?:小说|音乐|视频|论文).*下载/i,
      /(?:novel|music|video|paper).*download/i,
      /^(?!.*(?:想听|播放|来首|听歌|听一下|放一首)).*帮我.*(?:下载|找.*下载|爬取|抓取)/i,
      /^(?!.*(?:want to (?:listen|hear|play)|play some)).*find.*download.*(?:novel|music|video|paper|book|song)/i,
    ],
    complexity: "complex",
    // Exclude simple document creation from complex classification
    excludePatterns: [
      /创建.*(?:Word|Excel|PPT|文档|表格|演示|文稿)/i,
      /create.*(?:Word|Excel|PPT|document|spreadsheet|presentation)/i,
      /写.*(?:文档|表格|报告|方案)/i,
    ],
  },
  {
    patterns: [
      /修改.*文件/i, /modify.*file/i,
      /添加.*功能/i, /add.*feature/i,
      /更新.*配置/i, /update.*config/i,
      /搜索.*信息/i, /search.*info/i,
      /分析.*代码/i, /analyze.*code/i,
      /生成.*报告/i, /generate.*report/i,
    ],
    complexity: "medium",
  },
];

export function estimateTaskComplexity(message: string): ComplexityEstimate {
  const lower = message.toLowerCase();
  let maxComplexity: TaskComplexity = "simple";

  for (const { patterns, complexity, excludePatterns } of COMPLEXITY_PATTERNS) {
    // Check if excluded patterns match
    if (excludePatterns && excludePatterns.some(p => p.test(lower) || p.test(message))) {
      continue;
    }
    if (patterns.some(p => p.test(lower) || p.test(message))) {
      const order: TaskComplexity[] = ["simple", "medium", "complex", "very_complex"];
      if (order.indexOf(complexity) > order.indexOf(maxComplexity)) {
        maxComplexity = complexity;
      }
    }
  }

  const codeBlockCount = (lower.match(/```/g) || []).length / 2;
  const lineCount = message.split("\n").length;
  const wordCount = message.split(/\s+/).filter(Boolean).length;

  if (codeBlockCount >= 3 || lineCount > 30 || wordCount > 200) {
    const order: TaskComplexity[] = ["simple", "medium", "complex", "very_complex"];
    const boosted: TaskComplexity = wordCount > 400 ? "very_complex" : wordCount > 200 ? "complex" : "medium";
    if (order.indexOf(boosted) > order.indexOf(maxComplexity)) {
      maxComplexity = boosted;
    }
  }

  const timeoutMs = COMPLEXITY_TIMEOUT_MAP[maxComplexity];
  const shouldAutoSplit = maxComplexity === "complex" || maxComplexity === "very_complex";
  const maxSubtasks = maxComplexity === "very_complex" ? 8 : maxComplexity === "complex" ? 5 : 3;

  return { level: maxComplexity, timeoutMs, shouldAutoSplit, maxSubtasks };
}

function validateCliCommand(input: string): { valid: boolean; reason?: string } {
  const trimmed = input.trim();
  if (!trimmed) return { valid: false, reason: "Empty command" };
  if (trimmed.length > 2048) return { valid: false, reason: "Command too long (max 2048 chars)" };

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { valid: false, reason: "Command contains forbidden patterns" };
    }
  }

  if (!trimmed.toLowerCase().startsWith("evoclaw ")) return { valid: false, reason: 'Commands must start with "EvoClaw" (e.g. EvoClaw --help)' };

  return { valid: true };
}

function executeCliCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const args = command.replace(/^[Ee][Vv][Oo][Cc][Ll][Aa][Ww]\s*/, "").trim().split(/\s+/).filter(Boolean);

    const childProcess = spawn("node", [CLI_SCRIPT_PATH, ...args], {
      windowsHide: true,
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        timedOut = true;
        childProcess.kill("SIGKILL");
        // 兜底：若进程未在宽限期内退出，强制清理并返回
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode: 1, timedOut: true });
          }
        }, 2000);
      }
    }, CLI_TIMEOUT_MS);

    const onStdoutData = (data: Buffer) => {
      stdout += data.toString("utf8");
      if (stdout.length > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + "\n... (output truncated)";
        childProcess.kill("SIGTERM");
      }
    };

    const onStderrData = (data: Buffer) => {
      stderr += data.toString("utf8");
      if (stderr.length > MAX_OUTPUT_BYTES) {
        stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + "\n... (output truncated)";
      }
    };

    const onClose = (code: number | null) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode: code ?? 1, timedOut });
      }
    };

    const onError = (err: Error) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve({ stdout: "", stderr: err.message, exitCode: 1, timedOut: false });
      }
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      childProcess.stdout?.off("data", onStdoutData);
      childProcess.stderr?.off("data", onStderrData);
      childProcess.off("close", onClose);
      childProcess.off("error", onError);
      // 确保子进程不会继续挂起
      try {
        if (!childProcess.killed) {
          childProcess.kill("SIGKILL");
        }
      } catch { /* ignore */ }
    };

    childProcess.stdout?.on("data", onStdoutData);
    childProcess.stderr?.on("data", onStderrData);
    childProcess.on("close", onClose);
    childProcess.on("error", onError);
  });
}

export class ProtocolAdapter {
  private savedLLMProviders: Record<string, unknown>[] | null = null;
  private savedImageGenProviders: Record<string, unknown>[] | null = null;
  private savedVideoGenProviders: Record<string, unknown>[] | null = null;
  private savedChannels: Record<string, unknown>[] | null = null;
  private incomingWebhookManager: IncomingWebhookManager;
  private canvasHost: CanvasHost;
  private envSecrets: EnvSecretManager;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.incomingWebhookManager = new IncomingWebhookManager();
    this.incomingWebhookManager.setActionHandler(async (action, payload) => {
      this.eventBus.publish("webhook.triggered", {
        action,
        endpointId: payload.endpointId,
        path: payload.path,
        body: payload.body,
        headers: payload.headers,
        timestamp: new Date().toISOString(),
      }, "protocol-adapter");
      return { statusCode: 200, response: { received: true, action } };
    });
    this.canvasHost = new CanvasHost();
    this.envSecrets = new EnvSecretManager();
    this.envSecrets.load();
  }

  getIncomingWebhookManager(): IncomingWebhookManager {
    return this.incomingWebhookManager;
  }

  loadPersistedConfig(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (err) {
      process.stderr.write(`[ProtocolAdapter] Failed to create config dir: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    try {
      if (fs.existsSync(LLM_CONFIG_FILE)) {
        const raw = fs.readFileSync(LLM_CONFIG_FILE, "utf-8");
        const data = JSON.parse(raw);
        if (data.providers && Array.isArray(data.providers)) {
          // Migrate: convert plaintext apiKeys to ${VAR} references + store in .env
          let needsRewrite = false;
          for (const p of data.providers) {
            const apiKey = p.apiKey as string | undefined;
            if (apiKey && !this.envSecrets.isRef(apiKey) && apiKey !== "" && !apiKey.includes("****")) {
              const varName = EnvSecretManager.makeLLMKeyVar(p.id as string);
              this.envSecrets.set(varName, apiKey);
              p.apiKey = `\${${varName}}`;
              needsRewrite = true;
            }
          }
          if (needsRewrite) {
            this.persistLLMProviders(data.providers);
            process.stdout.write("[ProtocolAdapter] Migrated LLM API keys to .env references\n");
          }

          this.savedLLMProviders = data.providers;
          // Resolve references before applying
          const resolved = this.resolveLLMProviders(data.providers);
          this.applyLLMProviders(resolved);
          process.stdout.write(`[ProtocolAdapter] Loaded ${data.providers.length} LLM providers from disk\n`);
        }
      }
    } catch (err) {
      process.stderr.write("[ProtocolAdapter] Failed to load LLM config:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
    }

    try {
      if (fs.existsSync(IMAGE_GEN_CONFIG_FILE)) {
        const raw = fs.readFileSync(IMAGE_GEN_CONFIG_FILE, "utf-8");
        const data = JSON.parse(raw);
        if (data.providers && Array.isArray(data.providers)) {
          // Migrate: convert plaintext apiKeys to ${VAR} references + store in .env
          let needsRewrite = false;
          for (const p of data.providers) {
            const apiKey = p.apiKey as string | undefined;
            if (apiKey && !this.envSecrets.isRef(apiKey) && apiKey !== "" && !apiKey.includes("****")) {
              const varName = EnvSecretManager.makeImageGenKeyVar(p.id as string);
              this.envSecrets.set(varName, apiKey);
              p.apiKey = `\${${varName}}`;
              needsRewrite = true;
            }
          }
          if (needsRewrite) {
            this.persistImageGenProviders(data.providers);
            process.stdout.write("[ProtocolAdapter] Migrated image-gen API keys to .env references\n");
          }

          this.savedImageGenProviders = data.providers;
          process.stdout.write(`[ProtocolAdapter] Loaded ${data.providers.length} image-gen providers from disk\n`);
        }
      } else {
        // Initialize with defaults and persist
        this.savedImageGenProviders = DEFAULT_IMAGE_GEN_PROVIDERS;
        this.persistImageGenProviders(DEFAULT_IMAGE_GEN_PROVIDERS);
        process.stdout.write("[ProtocolAdapter] Initialized default image-gen providers\n");
      }
    } catch (err) {
      process.stderr.write("[ProtocolAdapter] Failed to load image-gen config:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
    }

    try {
      if (fs.existsSync(VIDEO_GEN_CONFIG_FILE)) {
        const raw = fs.readFileSync(VIDEO_GEN_CONFIG_FILE, "utf-8");
        const data = JSON.parse(raw);
        if (data.providers && Array.isArray(data.providers)) {
          // Migrate: convert plaintext apiKeys to ${VAR} references + store in .env
          let needsRewrite = false;
          for (const p of data.providers) {
            const apiKey = p.apiKey as string | undefined;
            if (apiKey && !this.envSecrets.isRef(apiKey) && apiKey !== "" && !apiKey.includes("****")) {
              const varName = EnvSecretManager.makeVideoGenKeyVar(p.id as string);
              this.envSecrets.set(varName, apiKey);
              p.apiKey = `\${${varName}}`;
              needsRewrite = true;
            }
          }
          if (needsRewrite) {
            this.persistVideoGenProviders(data.providers);
            process.stdout.write("[ProtocolAdapter] Migrated video-gen API keys to .env references\n");
          }

          this.savedVideoGenProviders = data.providers;
          process.stdout.write(`[ProtocolAdapter] Loaded ${data.providers.length} video-gen providers from disk\n`);
        }
      } else {
        // Initialize with defaults and persist
        this.savedVideoGenProviders = DEFAULT_VIDEO_GEN_PROVIDERS;
        this.persistVideoGenProviders(DEFAULT_VIDEO_GEN_PROVIDERS);
        process.stdout.write("[ProtocolAdapter] Initialized default video-gen providers\n");
      }
    } catch (err) {
      process.stderr.write("[ProtocolAdapter] Failed to load video-gen config:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
    }

    try {
      if (fs.existsSync(CHANNELS_CONFIG_FILE)) {
        const raw = fs.readFileSync(CHANNELS_CONFIG_FILE, "utf-8");
        const data = JSON.parse(raw);
        if (data.channels && Array.isArray(data.channels)) {
          // Migrate: convert plaintext channel secrets to ${VAR} references + store in .env
          let needsRewrite = false;
          for (const ch of data.channels) {
            for (const field of CHANNEL_SECRET_FIELDS) {
              const val = ch[field] as string | undefined;
              if (val && !this.envSecrets.isRef(val) && val !== "" && !val.includes("****")) {
                const varName = EnvSecretManager.makeChannelVar(ch.id as string, field);
                this.envSecrets.set(varName, val);
                ch[field] = `\${${varName}}`;
                needsRewrite = true;
              }
            }
          }
          if (needsRewrite) {
            this.persistChannels(data.channels);
            process.stdout.write("[ProtocolAdapter] Migrated channel secrets to .env references\n");
          }

          this.savedChannels = data.channels;
          // Resolve references before applying
          const resolved = this.resolveChannelConfigs(data.channels);
          this.applyChannels(resolved);
          process.stdout.write(`[ProtocolAdapter] Loaded ${data.channels.length} channels from disk\n`);
        }
      }
    } catch (err) {
      process.stderr.write("[ProtocolAdapter] Failed to load channels config:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
    }

    // Sync env secrets to secretsStore so they appear in the Secrets Manager UI
    this.syncEnvSecretsToStore();

    // Load persisted secrets from data/secrets.json
    this.loadPersistedSecrets();
  }

  /** Sync .env secrets into the secretsStore for UI display */
  private syncEnvSecretsToStore(): void {
    const SECRET_PATTERNS = [
      /API_KEY/i, /SECRET/i, /TOKEN/i, /PASSWORD/i, /PRIVATE_KEY/i,
      /APP_ID/i, /APP_SECRET/i, /ENCRYPT_KEY/i, /VERIFICATION_TOKEN/i,
    ];
    for (const key of this.envSecrets.keys()) {
      if (!this.secretsStore.has(key) && SECRET_PATTERNS.some(p => p.test(key))) {
        const value = this.envSecrets.get(key) || "";
        this.secretsStore.set(key, {
          name: key,
          source: "env",
          createdAt: new Date().toISOString(),
          revoked: false,
          rotationVersion: 0,
        });
      }
    }
  }

  /** Load persisted secrets from data/secrets.json */
  private loadPersistedSecrets(): void {
    try {
      const secretsFile = path.join(DATA_DIR, "secrets.json");
      if (fs.existsSync(secretsFile)) {
        const data = JSON.parse(fs.readFileSync(secretsFile, "utf-8"));
        if (data.secrets) {
          for (const s of data.secrets) {
            if (!this.secretsStore.has(s.name)) {
              this.secretsStore.set(s.name, s);
            }
          }
        }
        if (data.auditLog) {
          this.secretsAuditLog = data.auditLog;
        }
      }
    } catch { /* start fresh */ }
  }

  /** Persist secrets to data/secrets.json */
  private persistSecrets(): void {
    try {
      const secretsFile = path.join(DATA_DIR, "secrets.json");
      const data = {
        secrets: Array.from(this.secretsStore.values()),
        auditLog: this.secretsAuditLog,
      };
      atomicWriteFileSync(secretsFile, JSON.stringify(data, null, 2));
    } catch (err) { console.debug("[ProtocolAdapter]", err instanceof Error ? err.message : String(err)); }
  }

  /** Resolve ${VAR} references in LLM providers for runtime use */
  private resolveLLMProviders(providers: Record<string, unknown>[]): Record<string, unknown>[] {
    return providers.map((p) => ({
      ...p,
      apiKey: this.envSecrets.resolve(p.apiKey),
      config: p.config
        ? Object.fromEntries(
            Object.entries(p.config as Record<string, unknown>).map(([k, v]) => [k, this.envSecrets.resolve(v)])
          )
        : p.config,
    }));
  }

  /** Resolve ${VAR} references in channel configs for runtime use */
  private resolveChannelConfigs(channels: Record<string, unknown>[]): Record<string, unknown>[] {
    return channels.map((ch) => {
      const resolved: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(ch)) {
        resolved[key] = this.envSecrets.resolve(value);
      }
      // Also resolve nested settings
      if (ch.settings && typeof ch.settings === "object") {
        resolved.settings = Object.fromEntries(
          Object.entries(ch.settings as Record<string, unknown>).map(([k, v]) => [k, this.envSecrets.resolve(v)])
        );
      }
      return resolved;
    });
  }

  private persistLLMProviders(providers: Record<string, unknown>[]): void {
    try {
      atomicWriteFileSync(LLM_CONFIG_FILE, JSON.stringify({ providers }, null, 2));
    } catch (err) {
      process.stderr.write("[ProtocolAdapter] Failed to persist LLM config:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
    }
  }

  /** Resolve ${VAR} references in image-gen providers for runtime use */
  private resolveImageGenProviders(providers: Record<string, unknown>[]): Record<string, unknown>[] {
    return providers.map((p) => ({
      ...p,
      apiKey: this.envSecrets.resolve(p.apiKey),
    }));
  }

  /** Resolve ${VAR} references in video-gen providers for runtime use */
  private resolveVideoGenProviders(providers: Record<string, unknown>[]): Record<string, unknown>[] {
    return providers.map((p) => ({
      ...p,
      apiKey: this.envSecrets.resolve(p.apiKey),
    }));
  }

  private persistImageGenProviders(providers: Record<string, unknown>[]): void {
    try {
      atomicWriteFileSync(IMAGE_GEN_CONFIG_FILE, JSON.stringify({ providers }, null, 2));
    } catch (err) {
      process.stderr.write("[ProtocolAdapter] Failed to persist image-gen config:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
    }
  }

  private persistVideoGenProviders(providers: Record<string, unknown>[]): void {
    try {
      atomicWriteFileSync(VIDEO_GEN_CONFIG_FILE, JSON.stringify({ providers }, null, 2));
    } catch (err) {
      process.stderr.write("[ProtocolAdapter] Failed to persist video-gen config:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
    }
  }

  private persistChannels(channels: Record<string, unknown>[]): void {
    try {
      atomicWriteFileSync(CHANNELS_CONFIG_FILE, JSON.stringify({ channels }, null, 2));
    } catch (err) {
      process.stderr.write("[ProtocolAdapter] Failed to persist channels config:" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
    }
  }

  private applyLLMProviders(providers: Record<string, unknown>[]): void {
    const executor = this.registry.resolveService<{
      configureProviders(providers: Array<{
        id: string;
        name: string;
        enabled: boolean;
        order: number;
        provider: string;
        model: string;
        apiKey: string;
        baseURL: string;
        maxTokens: number;
        temperature: number;
        timeout: number;
        topP?: number;
      }>): void;
    }>("agentModelExecutor");

    if (!executor) return;

    const configs = providers
      .filter((p) => p.enabled)
      .map((p) => {
        const cfg = p.config as Record<string, unknown> | undefined;
        const maxTokensRaw = cfg?.maxTokens;
        const maxTokens = typeof maxTokensRaw === "number" && Number.isFinite(maxTokensRaw) ? maxTokensRaw : 4096;
        const temperatureRaw = cfg?.temperature;
        const temperature = typeof temperatureRaw === "number" && Number.isFinite(temperatureRaw) ? temperatureRaw : 0.3;
        const timeoutRaw = cfg?.timeout;
        const timeout = typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) ? timeoutRaw : 60000;
        const topPRaw = cfg?.topP;
        const topP = typeof topPRaw === "number" && Number.isFinite(topPRaw) ? topPRaw : 1;
        const orderRaw = p.order;
        const order = typeof orderRaw === "number" && Number.isFinite(orderRaw) ? orderRaw : 1;
        return {
          id: (p.id as string) || "",
          name: (p.name as string) || "",
          enabled: true,
          order,
          provider: (p.id as string) || "custom",
          model: (p.selectedModel as string) || (Array.isArray(p.models) ? (p.models as string[])[0] : "") || "",
          apiKey: (p.apiKey as string) || "",
          baseURL: (p.baseURL as string) || "",
          maxTokens,
          temperature,
          timeout,
          topP,
          models: (p.models as string[]) || [],
        };
      });

    if (configs.length > 0) {
      executor.configureProviders(configs);
    }

    // Sync provider info to CopilotRouter so it knows user's LLM config order
    const copilotRouter = this.registry.resolveService<{
      updateUserProviders(providers: Array<{ id: string; name: string; enabled: boolean; order: number; selectedModel: string; baseURL: string }>): void;
    }>("copilotRouter");
    if (copilotRouter) {
      copilotRouter.updateUserProviders(
        providers.map((p) => {
          const orderRaw = p.order;
          const order = typeof orderRaw === "number" && Number.isFinite(orderRaw) ? orderRaw : 1;
          return {
            id: (p.id as string) || "",
            name: (p.name as string) || "",
            enabled: (p.enabled as boolean) ?? false,
            order,
            selectedModel: (p.selectedModel as string) || "",
            baseURL: (p.baseURL as string) || "",
          };
        })
      );
    }
  }

  private applyChannels(channels: Record<string, unknown>[]): void {
    const channelManager = this.registry.resolveService<{
      registerChannel(config: ChannelConfig): void;
      attachAdapter(adapter: ChannelAdapter): Promise<void>;
      detachAdapter(type: ChannelType): Promise<void>;
      getAdapter(type: ChannelType): ChannelAdapter | undefined;
    }>("channelManager");

    if (!channelManager) return;

    for (const ch of channels) {
      const type = (ch.type as ChannelType) || "";
      const enabled = ch.enabled === true;

      // Merge top-level channel fields into settings (channels.json stores appId/appSecret at top level)
      const rawSettings = (ch.settings as Record<string, unknown>) || {};
      const settings: Record<string, unknown> = { ...rawSettings };
      const knownMetaKeys = new Set(["id", "name", "type", "enabled", "label", "dmPolicy", "allowFrom", "blockFrom", "settings"]);
      for (const [key, value] of Object.entries(ch)) {
        if (!knownMetaKeys.has(key) && value !== undefined && value !== "") {
          settings[key] = value;
        }
      }

      // Register channel config
      const config: ChannelConfig = {
        type,
        enabled,
        label: (ch.label as string) || (ch.name as string) || type,
        dmPolicy: (ch.dmPolicy as "open" | "pairing" | "closed") || "open",
        allowFrom: Array.isArray(ch.allowFrom) ? ch.allowFrom as string[] : [],
        blockFrom: Array.isArray(ch.blockFrom) ? ch.blockFrom as string[] : [],
        settings,
      };
      channelManager.registerChannel(config);

      // Create and attach adapter for enabled channels
      if (enabled) {
        let adapter: ChannelAdapter | undefined;

        switch (type) {
          case "feishu": {
            if (settings.appId && settings.appSecret) {
              adapter = new FeishuAdapter(config);
            }
            break;
          }
          case "matrix": {
            if (settings.homeserver) {
              adapter = new MatrixAdapter(config);
            }
            break;
          }
          // Other channel types can be added here
        }

        if (adapter) {
          channelManager.attachAdapter(adapter).catch((err: unknown) => {
            process.stderr.write(`[ProtocolAdapter] Failed to attach ${type} adapter:` + " " + err + "\n");
          });
          process.stdout.write(`[ProtocolAdapter] Applied channel: ${type} (enabled=${enabled})\n`);
        } else if (type === "feishu" || type === "matrix") {
          process.stderr.write(`[ProtocolAdapter] Channel ${type} is enabled but missing required settings\n`);
        }
      }
    }
  }

  private authProvider: {
    generateToken(userId: string, roles?: string[]): string;
    generateRefreshToken(userId: string, roles?: string[]): string;
    verifyToken(token: string): { userId: string; roles: string[]; type?: "refresh" };
  } | null = null;

  private getAuthProvider(): typeof this.authProvider {
    if (!this.authProvider) {
      this.authProvider = this.registry.resolveService("authProvider") || null;
    }
    return this.authProvider;
  }

  private deadLetterQueue: DeadLetterQueue | null = null;
  private healthAggregator: HealthAggregator | null = null;
  private replyReferenceManager: ReplyReferenceManager | null = null;
  private messageTemplateEngine: MessageTemplateEngine | null = null;

  private secretsStore: Map<string, any> = new Map();
  private secretsAuditLog: Array<any> = [];
  private configRpcStore: Map<string, any> = new Map();
  private configRpcInitialized = false;
  private configRpcWatchers: Map<string, Array<{ subscriptionId: string }>> = new Map();
  private modelsStore: Map<string, any> = new Map();
  private currentModelId: string = "";
  private retentionPolicy: any = {
    maxAgeDays: 30, maxInactiveDays: 7,
    maxSessions: 1000, maxMessagesPerSession: 500,
    enabled: true,
  };
  private retentionStats: any = {
    totalSessions: 0, expiredSessions: 0,
    cleanedUp: 0, lastRun: "",
  };
  private migrationsStore: Map<string, any> = new Map();
  private configSnapshots: Map<string, { config: any; timestamp: string }> = new Map();
  private migrationVersion: number = 0;
  private migrationDataDir: string = "";
  private doctorIssues: Array<any> = [];

  /** 添加审计日志条目，并保持日志不超过 1000 条上限。 */
  private addSecretsAuditEntry(entry: any): void {
    this.secretsAuditLog.push(entry);
    while (this.secretsAuditLog.length > 1000) {
      this.secretsAuditLog.shift();
    }
  }

  /**
   * Initialize migration system: load persisted records and detect version changes.
   */
  initMigrations(dataDir: string, currentVersion: string): void {
    this.migrationDataDir = dataDir;
    // Load persisted migration records
    try {
      const fs = require("fs");
      const path = require("path");
      const migrationFile = path.join(dataDir, "migrations.json");
      if (fs.existsSync(migrationFile)) {
        const saved = JSON.parse(fs.readFileSync(migrationFile, "utf-8"));
        if (saved.migrations) {
          for (const m of saved.migrations) {
            this.migrationsStore.set(m.id, m);
          }
        }
        this.migrationVersion = saved.version || 0;
      }
    } catch (err) { /* start fresh */ process.stderr.write('[ProtocolAdapter] migration store corrupt: ' + err + '\n'); }

    // Detect version change and create migration record
    try {
      const fs = require("fs");
      const path = require("path");
      const versionFile = path.join(dataDir, "last-version.txt");
      let lastVersion = "";
      if (fs.existsSync(versionFile)) {
        lastVersion = fs.readFileSync(versionFile, "utf-8").trim();
      }
      if (lastVersion && lastVersion !== currentVersion) {
        const id = `migration-${lastVersion}-to-${currentVersion}-${Date.now()}`;
        const now = new Date().toISOString();
        const migration = {
          id,
          fromVersion: lastVersion,
          toVersion: currentVersion,
          status: "completed",
          startedAt: now,
          completedAt: now,
          changes: [
            { action: "version_upgrade", path: "system.version", description: `Version upgraded from ${lastVersion} to ${currentVersion}`, from: lastVersion, to: currentVersion },
          ],
        };
        this.migrationsStore.set(id, migration);
        this.migrationVersion++;
        this.persistMigrations();
      }
      // Save current version
      atomicWriteFileSync(versionFile, currentVersion);
    } catch (err) { console.debug("[ProtocolAdapter]", err instanceof Error ? err.message : String(err)); }
  }

  private persistMigrations(): void {
    try {
      if (!this.migrationDataDir) return;
      const migrationFile = path.join(this.migrationDataDir, "migrations.json");
      const data = {
        version: this.migrationVersion,
        migrations: Array.from(this.migrationsStore.values()),
      };
      atomicWriteFileSync(migrationFile, JSON.stringify(data, null, 2));
    } catch { /* non-critical */ }
  }

  private getDeadLetterQueue(): DeadLetterQueue {
    if (!this.deadLetterQueue) {
      this.deadLetterQueue = this.registry.resolveService("deadLetterQueue") || new DeadLetterQueue();
    }
    return this.deadLetterQueue;
  }

  private getHealthAggregator(): HealthAggregator {
    if (!this.healthAggregator) {
      this.healthAggregator = this.registry.resolveService("healthAggregator") || new HealthAggregator();
    }
    return this.healthAggregator;
  }

  private getReplyReferenceManager(): ReplyReferenceManager {
    if (!this.replyReferenceManager) {
      this.replyReferenceManager = this.registry.resolveService("replyReferenceManager") || new ReplyReferenceManager();
    }
    return this.replyReferenceManager;
  }

  private getMessageTemplateEngine(): MessageTemplateEngine {
    if (!this.messageTemplateEngine) {
      this.messageTemplateEngine = this.registry.resolveService("messageTemplateEngine") || new MessageTemplateEngine();
    }
    return this.messageTemplateEngine;
  }

  private handleError(err: unknown, res: Response, defaultMsg: string): void {
    const isProduction = process.env.NODE_ENV === "production";
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ProtocolAdapter] ${defaultMsg}:` + " " + message + "\n");
    res.status(500).json({
      error: defaultMsg,
      ...(isProduction ? {} : { message }),
    });
  }

  private runConfigDiagnostics(): Array<{ path: string; severity: string; message: string; suggestion?: any; currentValue?: any }> {
    const issues: Array<{ path: string; severity: string; message: string; suggestion?: any; currentValue?: any }> = [];
    const config = this.registry.resolveService<any>("config");
    const authConfig = config?.get?.("auth") || config?.auth;
    if (authConfig) {
      if (!authConfig.jwtSecret || /change|dev|secret/i.test(authConfig.jwtSecret)) {
        issues.push({ path: "auth.jwtSecret", severity: "error", message: "JWT 密钥使用默认值或弱密码，存在安全风险", suggestion: "设置强随机密钥（至少16位）", currentValue: "******" });
      }
    }
    const gatewayConfig = config?.get?.("gateway") || config?.gateway;
    if (gatewayConfig) {
      if (gatewayConfig.enableMCP === false && gatewayConfig.enableREST === false) {
        issues.push({ path: "gateway.enableMCP", severity: "warning", message: "MCP 和 REST API 均已禁用，外部无法访问", suggestion: "至少启用一种通信协议" });
      }
    }
    const llmProviders = this.savedLLMProviders || [];
    if (llmProviders.length === 0) {
      issues.push({ path: "llm.providers", severity: "error", message: "未配置任何 LLM 提供商，Agent 无法工作", suggestion: "至少配置一个 LLM 提供商" });
    } else {
      for (const p of llmProviders) {
        if (!p.apiKey || p.apiKey === "" || p.apiKey === "sk-xxx") {
          issues.push({ path: `llm.providers.${p.id || p.name}.apiKey`, severity: "error", message: `LLM 提供商 "${p.name || p.id}" 未配置 API Key`, suggestion: "设置有效的 API Key" });
        }
      }
    }
    const channels = this.savedChannels || [];
    if (channels.length === 0) {
      issues.push({ path: "channels", severity: "warning", message: "未配置任何消息通道", suggestion: "配置至少一个消息通道（如微信、Telegram）" });
    }
    return issues;
  }

  private ensureConfigRpcInitialized(): void {
    if (this.configRpcInitialized) return;
    this.configRpcInitialized = true;
    const config = this.registry.resolveService<any>("config");
    if (config?.get) {
      try {
        const allConfig = config.getAll?.() || {};
        for (const key of Object.keys(allConfig)) {
          this.configRpcStore.set(key, allConfig[key]);
        }
      } catch {
        try {
          const sections = ["server", "auth", "gateway", "persona", "agent", "sandbox", "memory", "security", "evolution"];
          for (const section of sections) {
            const val = config.get(section);
            if (val) this.configRpcStore.set(section, val);
          }
        } catch (err) {
          process.stderr.write(`[ProtocolAdapter] Config RPC store update failed: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }
    if (this.savedLLMProviders && this.savedLLMProviders.length > 0) {
      this.configRpcStore.set("llm.providers", this.savedLLMProviders);
    }
    if (this.savedChannels && this.savedChannels.length > 0) {
      this.configRpcStore.set("channels.list", this.savedChannels);
    }
  }

  mountREST(app: Express): void {
    const ha = this.getHealthAggregator();
    const services = [
      { name: "eventBus", type: "service" as const },
      { name: "sessionManager", type: "service" as const },
      { name: "pluginManager", type: "service" as const },
      { name: "skillManager", type: "service" as const },
      { name: "permissionManager", type: "service" as const },
      { name: "memoryHub", type: "service" as const },
      { name: "evolutionEngine", type: "service" as const },
    ];
    for (const svc of services) {
      const instance = this.registry.resolveService<any>(svc.name);
      if (instance && !ha.getComponent(svc.name)) {
        ha.registerComponent(
          svc.name,
          svc.type,
          async () => {
            try {
              if (instance.healthCheck) {
                const result = await instance.healthCheck();
                return { ok: !!result, responseTimeMs: 0 };
              }
              return { ok: true, responseTimeMs: 0 };
            } catch {
              return { ok: false, error: "Health check failed", responseTimeMs: 0 };
            }
          },
        );
      }
    }
    ha.startPolling();

    app.post("/api/auth/login", (req: Request, res: Response) => {
      try {
        const { username, password } = req.body || {};
        if (!username || !password) {
          res.status(400).json({ error: "Username and password are required" });
          return;
        }
        if (typeof username !== "string" || typeof password !== "string") {
          res.status(400).json({ error: "Username and password must be strings" });
          return;
        }
        if (username.length > 128 || password.length > 256) {
          res.status(400).json({ error: "Username or password too long" });
          return;
        }

        const auth = this.getAuthProvider();
        if (!auth) {
          res.status(503).json({ error: "Authentication service not available" });
          return;
        }

        const token = auth.generateToken(username);
        const refreshToken = auth.generateRefreshToken(username);
        res.json({ token, refreshToken, expiresIn: "24h" });
      } catch (err) {
        this.handleError(err, res, "Login failed");
      }
    });

    app.post("/api/auth/register", (req: Request, res: Response) => {
      try {
        const { username, password } = req.body || {};
        if (!username || !password) {
          res.status(400).json({ error: "Username and password are required" });
          return;
        }
        if (typeof username !== "string" || typeof password !== "string") {
          res.status(400).json({ error: "Username and password must be strings" });
          return;
        }
        if (username.length < 3 || username.length > 64) {
          res.status(400).json({ error: "Username must be 3-64 characters" });
          return;
        }
        if (password.length < 8 || password.length > 128) {
          res.status(400).json({ error: "Password must be 8-128 characters" });
          return;
        }

        const auth = this.getAuthProvider();
        if (!auth) {
          res.status(503).json({ error: "Authentication service not available" });
          return;
        }

        const token = auth.generateToken(username, ["user"]);
        res.status(201).json({ token, userId: username });
      } catch (err) {
        this.handleError(err, res, "Registration failed");
      }
    });

    app.get("/api/auth/check", (req: Request, res: Response) => {
      const auth = this.getAuthProvider();
      if (!auth) {
        res.json({ authenticated: true });
        return;
      }
      const webUiToken = process.env.WEB_UI_TOKEN || "";
      if (!webUiToken) {
        res.json({ authenticated: true });
        return;
      }
      const cookieHeader = req.headers.cookie || "";
      const cookies = cookieHeader.split(";").reduce<Record<string, string>>((acc, c) => {
        const [k, ...v] = c.trim().split("=");
        if (k) acc[k] = decodeURIComponent(v.join("="));
        return acc;
      }, {});
      const tokenFromCookie = cookies["web_ui_token"];
      // 使用常量时间比较防止计时攻击逐字节枚举 token
      const tokensMatch = tokenFromCookie && webUiToken && tokenFromCookie.length === webUiToken.length
        ? crypto.timingSafeEqual(Buffer.from(tokenFromCookie), Buffer.from(webUiToken))
        : false;
      if (tokensMatch) {
        res.json({ authenticated: true });
      } else {
        res.status(401).json({ authenticated: false, error: "Invalid or missing token" });
      }
    });

    // 掩码 skill.config 中的敏感值（API Key / Token / Secret 等），
    // 防止通过 /api/skills 与 /api/skills/:id 泄露真实凭证。
    // 规则：键名匹配 ENV_VAR 模式（大写+下划线，3 字符以上）或包含敏感关键词；
    // 值非空且非掩码占位符时，替换为 "****"。
    const maskSkillConfig = (skill: any): any => {
      if (!skill || typeof skill !== "object") return skill;
      const cfg = skill.config;
      if (!cfg || typeof cfg !== "object") return skill;
      const SENSITIVE_KEY = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|AUTH)/i;
      const ENV_VAR = /^[A-Z][A-Z0-9_]{2,}$/;
      const masked: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(cfg)) {
        if (v === undefined || v === null || v === "") { masked[k] = v; continue; }
        const isSensitive = ENV_VAR.test(k) || SENSITIVE_KEY.test(k);
        if (isSensitive && typeof v === "string") {
          masked[k] = v.includes("****") ? v : "****";
        } else {
          masked[k] = v;
        }
      }
      return { ...skill, config: masked };
    };

    app.get("/api/skills", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          listSkills(): Promise<unknown[]>;
          searchLocalSkills(query: Record<string, unknown>): Promise<unknown>;
          searchRemoteSkills(query: Record<string, unknown>): Promise<unknown>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }

        // If keyword parameter is provided, perform search
        const keyword = req.query.keyword as string;
        if (keyword) {
          const query = { keyword, limit: Math.max(1, Math.min(parseInt(String(req.query.limit), 10) || 20, 1000)) };
          const localResults = await skillManager.searchLocalSkills(query);
          const remoteResults = await skillManager.searchRemoteSkills(query);
          res.json({
            success: true,
            keyword,
            local: localResults,
            remote: remoteResults
          });
          return;
        }

        // Otherwise list all installed skills with optional sorting
        const skills = await skillManager.listSkills();
        const sortBy = req.query.sortBy as string;
        const sortOrder = req.query.sortOrder as string;

        if (sortBy && Array.isArray(skills)) {
          const sorted = [...skills].sort((a: any, b: any) => {
            let valA: any, valB: any;
            switch (sortBy) {
              case "name":
                valA = (a.name || "").toLowerCase();
                valB = (b.name || "").toLowerCase();
                break;
              case "category":
                valA = a.category || "zzz";
                valB = b.category || "zzz";
                break;
              case "status":
                valA = a.lifecycle?.status || "zzz";
                valB = b.lifecycle?.status || "zzz";
                break;
              case "invocations":
                valA = a.stats?.invocationCount || 0;
                valB = b.stats?.invocationCount || 0;
                break;
              case "rating":
                valA = a.stats?.userRating || 0;
                valB = b.stats?.userRating || 0;
                break;
              case "updated":
                valA = a.lifecycle?.lastUpdated || "";
                valB = b.lifecycle?.lastUpdated || "";
                break;
              default:
                return 0;
            }
            const cmp = valA < valB ? -1 : valA > valB ? 1 : 0;
            return sortOrder === "desc" ? -cmp : cmp;
          });
          res.json(sorted.map((s: any) => maskSkillConfig(s)));
          return;
        }

        res.json(Array.isArray(skills) ? skills.map((s: any) => maskSkillConfig(s)) : skills);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/skills/check-updates", async (_req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          checkUpdates(): Promise<Array<{ skillId: string; skillName: string; currentVersion: string; latestVersion: string }>>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const updatesAvailable = await skillManager.checkUpdates();
        res.json({ updatesAvailable });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── Optional skills：列出不默认启用的较重/小众技能 ──
    // 必须定义在 /api/skills/:id 之前，否则 "optional" 会被当作 :id 参数
    app.get("/api/skills/optional", async (_req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          listOptionalSkills(): Promise<Array<{ name: string; description: string; version: string; installed: boolean }>>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const optionalSkills = await skillManager.listOptionalSkills();
        res.json({ optionalSkills });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });



    app.get("/api/skills/:id", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          getSkill(id: string): Promise<unknown>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const skill = await skillManager.getSkill(String(req.params.id));
        if (!skill) {
          res.status(404).json({ error: "Skill not found" });
          return;
        }
        res.json(maskSkillConfig(skill));
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/skills/install", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          installSkill(path: string, force?: boolean): Promise<unknown>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const skillPath = (req.body.path as string) || "";
        if (!skillPath) {
          res.status(400).json({ error: "Skill path is required (body.path)" });
          return;
        }
        // Round 10: 安装重试逻辑 — 对瞬时失败重试一次
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const installed = await skillManager.installSkill(skillPath);
            res.json({ success: true, skill: installed, retries: attempt });
            return;
          } catch (err) {
            lastErr = err;
            const msg = String(err);
            // 仅对瞬时性错误重试（网络/IO/锁竞争），安全扫描失败不重试
            const isTransient = /ECONN|ETIMEDOUT|ENOTFOUND|ECONNRESET|EAI_AGAIN|lock|busy|temp/i.test(msg)
              && !/security|injection|exfiltration|critical/i.test(msg);
            if (!isTransient || attempt === 1) break;
            // 短暂等待后重试
            await new Promise((r) => setTimeout(r, 300));
          }
        }
        res.status(500).json({ error: String(lastErr) });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/skills/refresh", async (_req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          scanAndInstall(dir: string): Promise<{ installed: unknown[]; skipped: string[] }>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        // 扫描 data/skills（用户安装的技能）与 packages/skills/bundled（内置技能）
        const skillsDir = path.resolve(process.cwd(), "..", "..", "data", "skills");
        const bundledSkillsDir = path.resolve(process.cwd(), "..", "..", "packages", "skills", "bundled");
        const dirsToScan: string[] = [skillsDir];
        if (fs.existsSync(bundledSkillsDir)) {
          dirsToScan.push(bundledSkillsDir);
        }
        let totalInstalled = 0;
        let totalSkipped = 0;
        const details: Array<{ dir: string; installed: number; skipped: number }> = [];
        for (const dir of dirsToScan) {
          try {
            const result = await skillManager.scanAndInstall(dir);
            totalInstalled += result.installed.length;
            totalSkipped += result.skipped.length;
            details.push({ dir, installed: result.installed.length, skipped: result.skipped.length });
          } catch (err) {
            process.stderr.write(`[Gateway] Skill refresh scan failed for "${dir}":` + " " + err + "\n");
            details.push({ dir, installed: 0, skipped: 0 });
          }
        }
        res.json({
          installed: totalInstalled,
          skipped: totalSkipped,
          details,
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── Optional skills：安装一个不默认启用的较重/小众技能 ──
    // 从 packages/skills/optional/ 复制到 data/skills/ 并激活
    app.post("/api/skills/install-optional", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          installOptionalSkill(skillName: string): Promise<unknown>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const skillName = (req.body.name as string) || (req.body.skillName as string) || "";
        if (!skillName) {
          res.status(400).json({ error: "Skill name is required (body.name or body.skillName)" });
          return;
        }
        const installed = await skillManager.installOptionalSkill(skillName);
        res.json({ success: true, skill: installed });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── Delete a single skill ──
    app.delete("/api/skills/:id", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          uninstallSkill(id: string): Promise<void>;
          getSkill(id: string): Promise<{ id: string; name: string; installPath: string } | undefined>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const skillId = req.params.id as string;
        const skill = await skillManager.getSkill(skillId);
        if (!skill) {
          res.status(404).json({ error: `Skill "${skillId}" not found` });
          return;
        }
        await skillManager.uninstallSkill(skillId);
        res.json({ success: true, name: skill.name });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ── Batch delete skills ──
    app.post("/api/skills/batch-delete", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          uninstallSkill(id: string): Promise<void>;
          getSkill(id: string): Promise<{ id: string; name: string } | undefined>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const skillIds: string[] = req.body.skillIds || [];
        const success: string[] = [];
        const failed: Array<{ id: string; reason: string }> = [];
        for (const id of skillIds) {
          try {
            const skill = await skillManager.getSkill(id);
            if (!skill) {
              failed.push({ id, reason: "Not found" });
              continue;
            }
            await skillManager.uninstallSkill(id);
            success.push(id);
          } catch (err) {
            failed.push({ id, reason: String(err) });
          }
        }
        res.json({ success, failed, total: skillIds.length });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.put("/api/skills/:id/config", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          getSkill(id: string): Promise<{ id: string; config: Record<string, unknown>; name: string } | undefined>;
          saveSkillConfig(id: string, config: Record<string, unknown>): boolean;
        }>("skillManager");
        const skillId = req.params.id as string;
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const skill = await skillManager.getSkill(skillId);
        if (!skill) {
          res.status(404).json({ error: "Skill not found" });
          return;
        }
        const incomingConfig = req.body.config || {};
        const saved = skillManager.saveSkillConfig(skillId, incomingConfig as Record<string, unknown>);
        if (!saved) {
          res.status(500).json({ error: "Failed to persist skill config" });
          return;
        }
        res.json({ success: true, skill });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/skills/translate", async (_req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          checkAndTranslateInstalledSkills(): Promise<{ checked: number; translated: number }>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const result = await skillManager.checkAndTranslateInstalledSkills();
        res.json({ success: true, ...result });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/skills/:id/evolution", async (req: Request, res: Response) => {
      try {
        const skillCurator = this.registry.resolveService<{
          getSkillEvolution(skillId: string): unknown;
          getAllEvolutions(): unknown[];
          getEvolutionStats(): Record<string, unknown>;
        }>("skillCurator");
        if (!skillCurator) {
          res.status(503).json({ error: "Skill curator not available" });
          return;
        }
        const skillId = String(req.params.id);
        const evolution = skillCurator.getSkillEvolution(skillId);
        if (!evolution) {
          res.status(404).json({ error: "Skill evolution not found" });
          return;
        }
        res.json({ success: true, evolution });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/skills/curate", async (req: Request, res: Response) => {
      try {
        const skillCurator = this.registry.resolveService<{
          extractSkillFromSolution(task: string, solution: string, context: Record<string, unknown>): Promise<unknown>;
        }>("skillCurator");
        if (!skillCurator) {
          res.status(503).json({ error: "Skill curator not available" });
          return;
        }
        const { task, solution, context } = req.body || {};
        if (!task || !solution) {
          res.status(400).json({ error: "task and solution are required" });
          return;
        }
        const skill = await skillCurator.extractSkillFromSolution(
          task,
          solution,
          context || {}
        );
        res.json({ success: true, skill });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/skills/:id/translate", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          getSkill(id: string): Promise<{ id: string; name: string; description: string; installPath: string; body: { instructions: string; examples: string[] }; i18n?: Record<string, unknown> } | undefined>;
          getLocalizationService(): { checkAndTranslateSkill(skill: { name: string; description: string; installPath: string; body: { instructions: string; examples: string[] }; i18n?: Record<string, unknown> }): Promise<Record<string, unknown> | undefined> };
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const skill = await skillManager.getSkill(String(req.params.id));
        if (!skill) {
          res.status(404).json({ error: "Skill not found" });
          return;
        }
        const localization = skillManager.getLocalizationService();
        const i18n = await localization.checkAndTranslateSkill(skill);
        res.json({ success: true, i18n });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/skills/:id/validate-config", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          validateSkillConfig(id: string): Promise<{ valid: boolean; errors: string[]; warnings: string[] }>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const result = await skillManager.validateSkillConfig(String(req.params.id));
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/skills/:id/health-check", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          checkSkillHealth(id: string): Promise<unknown>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const result = await skillManager.checkSkillHealth(String(req.params.id));
        if (!result) {
          res.status(404).json({ error: "Skill not found" });
          return;
        }
        res.json({ success: true, health: result });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/skills/:id/upgrade", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          upgradeSkill(id: string): Promise<{ success: boolean; message: string; newVersion?: string }>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const result = await skillManager.upgradeSkill(String(req.params.id));
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/skills/batch-upgrade", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          upgradeSkill(id: string): Promise<{ success: boolean; message: string; newVersion?: string }>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const { skillIds } = req.body || {};
        if (!Array.isArray(skillIds) || skillIds.length === 0) {
          res.status(400).json({ error: "skillIds array is required" });
          return;
        }
        const results: Array<{ skillId: string; success: boolean; message: string; newVersion?: string }> = [];
        for (const skillId of skillIds) {
          try {
            const result = await skillManager.upgradeSkill(String(skillId));
            results.push({ skillId: String(skillId), ...result });
          } catch (err) {
            results.push({
              skillId: String(skillId),
              success: false,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        res.json({ success: true, results });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ============ ClawHub Marketplace Routes ============

    app.get("/api/marketplace/search", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          searchMarketplace(query: string, category?: string): { packages: unknown[]; total: number };
          getMarketplace(): {
            refreshCatalog(): Promise<number>;
            searchRemote(query: string, limit?: number): Promise<Array<{
              slug: string; displayName: string; summary?: string; version?: string; updatedAt?: number;
              metaContent?: {
                Files?: string[]; Keywords?: string[]; License?: string; DisplayDescription?: string;
                owner?: string; skillMd?: string;
                latest?: { commit?: string | null; publishedAt?: number; version?: string };
              } | null;
            }>>;
          };
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const q = (req.query.q as string) || "";
        if (!q) {
          res.status(400).json({ error: "Query parameter 'q' is required" });
          return;
        }

        // 1) 优先走 ClawHub 官方搜索 API（GET /api/v1/search?q=...）
        let refreshError: string | undefined;
        try {
          const remoteResults = await skillManager.getMarketplace().searchRemote(q, 20);
          // 透传给前端：含 metaContent（skillMd/owner/License 等）供详情面板直接展示
          const results = remoteResults.map((r) => ({
            slug: r.slug,
            name: r.slug,
            displayName: r.displayName,
            summary: r.summary ?? "",
            version: r.version ?? "",
            updatedAt: r.updatedAt,
            owner: r.metaContent?.owner ?? "",
            license: r.metaContent?.License ?? "",
            keywords: r.metaContent?.Keywords ?? [],
            files: r.metaContent?.Files ?? [],
            skillMd: r.metaContent?.skillMd ?? "",
            displayDescription: r.metaContent?.DisplayDescription ?? "",
          }));
          res.json({ success: true, results, total: results.length, partial: false });
          return;
        } catch (err: unknown) {
          refreshError = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[ProtocolAdapter] Remote search failed, falling back to local catalog: ${refreshError}\n`);
        }

        // 2) 回退：刷新本地 catalog 后用本地过滤搜索
        const staleCount = await skillManager.getMarketplace().refreshCatalog().catch((err: unknown) => {
          refreshError = err instanceof Error ? err.message : String(err);
          return -1;
        });
        const searchResult = skillManager.searchMarketplace(q);
        res.json({
          success: true,
          results: searchResult.packages,
          total: searchResult.total,
          partial: staleCount < 0,
          refreshError,
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // 调试端点：检查 ClawHub registry 连通性和响应格式
    app.get("/api/marketplace/debug", async (_req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          getMarketplace(): { searchRemote(query: string, limit?: number): Promise<unknown[]> };
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const debug: { tests: Array<{ query: string; ok: boolean; count: number; error?: string; sample?: unknown }> } = { tests: [] };
        for (const q of ["brainstorming", "*", "trace"]) {
          try {
            const results = await skillManager.getMarketplace().searchRemote(q, 3);
            debug.tests.push({ query: q, ok: true, count: results.length, sample: results[0] });
          } catch (err: unknown) {
            debug.tests.push({ query: q, ok: false, count: 0, error: err instanceof Error ? err.message : String(err) });
          }
        }
        res.json(debug);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/marketplace/install", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          installFromMarketplace(skillName: string): Promise<unknown>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const name = req.body.name as string;
        if (!name) {
          res.status(400).json({ error: "Skill name is required (body.name)" });
          return;
        }
        // Round 10: marketplace 安装重试逻辑 — 网络下载易失败，重试一次
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const skill = await skillManager.installFromMarketplace(name);
            res.json({ success: true, skill, retries: attempt });
            return;
          } catch (err) {
            lastErr = err;
            const msg = String(err);
            // 安全扫描失败不重试
            if (/security|injection|exfiltration|critical/i.test(msg)) break;
            // 非瞬时错误不重试
            const isTransient = /ECONN|ETIMEDOUT|ENOTFOUND|ECONNRESET|EAI_AGAIN|fetch|network|timeout/i.test(msg)
              || attempt === 0;
            if (!isTransient || attempt === 1) break;
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        res.status(500).json({ error: String(lastErr) });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/marketplace/trending", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          getMarketplace(): { refreshCatalog(): Promise<number>; getTrending(limit?: number): unknown[] };
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        let refreshError: string | undefined;
        const staleCount = await skillManager.getMarketplace().refreshCatalog().catch((err: unknown) => {
          refreshError = err instanceof Error ? err.message : String(err);
          return -1;
        });
        const limit = parseInt(req.query.limit as string, 10) || 10;
        const trending = skillManager.getMarketplace().getTrending(limit);
        res.json({ success: true, skills: trending, partial: staleCount < 0, refreshError });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/marketplace/categories", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          getMarketplace(): { refreshCatalog(): Promise<number>; getCategories(): Array<{ name: string; count: number }> };
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        await skillManager.getMarketplace().refreshCatalog().catch((err) => { process.stderr.write('[ProtocolAdapter] refreshCatalog failed: ' + err + '\n'); });
        const categories = skillManager.getMarketplace().getCategories();
        res.json({ success: true, categories });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/marketplace/skills/:slug/details — 从 ClawHub 获取技能完整详情（含完整 SKILL.md）
    // 前端点击技能列表时懒加载调用，确保详情面板始终有完整内容（不依赖搜索结果中的 skillMd 字段）
    app.get("/api/marketplace/skills/:slug/details", async (req: Request, res: Response) => {
      try {
        const slug = String(req.params.slug);
        const skillManager = this.registry.resolveService<{
          getMarketplace(): {
            fetchPackageDetails(name: string): Promise<unknown>;
            searchRemote(query: string, limit?: number): Promise<Array<{
              slug: string; displayName: string; summary?: string; version?: string; updatedAt?: number;
              metaContent?: {
                Files?: string[]; Keywords?: string[]; License?: string; DisplayDescription?: string;
                owner?: string; skillMd?: string;
                latest?: { commit?: string | null; publishedAt?: number; version?: string };
              } | null;
            }>>;
          };
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        // 直接调用 ClawHub 详情 API（GET /api/v1/skills/{slug}），返回 metaContent.skillMd 等完整字段
        const registryURL = process.env.EVOCLAW_MARKETPLACE_REGISTRY_URL || "https://cn.clawhub-mirror.com";
        const detailURL = `${registryURL}/api/v1/skills/${encodeURIComponent(slug)}`;
        const detailRes = await fetch(detailURL, {
          signal: AbortSignal.timeout(15_000),
          headers: { Accept: "application/json" },
        });
        if (!detailRes.ok) {
          res.status(detailRes.status).json({ error: `ClawHub API returned HTTP ${detailRes.status}` });
          return;
        }
        const data = await detailRes.json() as {
          skill?: { slug: string; displayName: string; summary?: string; tags?: Record<string, string>; createdAt: number; updatedAt: number } | null;
          latestVersion?: { version: string; createdAt: number; changelog?: string } | null;
          owner?: { handle?: string | null; displayName?: string | null } | null;
          metaContent?: {
            Files?: string[]; Keywords?: string[]; License?: string; DisplayDescription?: string;
            owner?: string; skillMd?: string; summary?: string; displayName?: string;
            requires?: { env?: string[]; bins?: string[] };
            latest?: { commit?: string | null; publishedAt?: number; version?: string };
          } | null;
        };
        if (!data.skill) {
          res.status(404).json({ error: "Skill not found" });
          return;
        }
        res.json({
          success: true,
          detail: {
            slug: data.skill.slug,
            displayName: data.metaContent?.displayName || data.skill.displayName,
            summary: data.metaContent?.summary || data.skill.summary || "",
            displayDescription: data.metaContent?.DisplayDescription || "",
            version: data.latestVersion?.version || data.metaContent?.latest?.version || "",
            owner: data.metaContent?.owner || data.owner?.handle || "",
            license: data.metaContent?.License || "",
            keywords: data.metaContent?.Keywords || [],
            files: data.metaContent?.Files || [],
            skillMd: data.metaContent?.skillMd || "",
            updatedAt: data.skill.updatedAt,
            createdAt: data.skill.createdAt,
            tags: data.skill.tags ? Object.keys(data.skill.tags) : [],
            requires: data.metaContent?.requires || null,
            detailPageURL: data.metaContent?.owner ? `${registryURL}/${data.metaContent.owner}/${data.skill.slug}` : "",
          },
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/skills/:id/upgrade-from-marketplace", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          upgradeFromMarketplace(skillId: string): Promise<unknown>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const skillId = String(req.params.id);
        const result = await skillManager.upgradeFromMarketplace(skillId);
        if (!result) {
          res.json({ success: true, message: "Skill is already up to date or not found on marketplace" });
          return;
        }
        res.json({ success: true, skill: result });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ============ Skill Integrity Routes (Round 7: 信任链) ============
    // GET /api/skills/integrity/verify — 校验所有已安装技能的完整性
    app.get("/api/skills/integrity/verify", (_req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          verifyAllSkillsIntegrity(): Array<{
            skillId: string;
            skillName: string;
            result: { ok: boolean; missingOrigin: boolean; missingFiles: string[]; mismatchedFiles: unknown[]; lockMismatches: string[]; errors: string[] };
          }>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const results = skillManager.verifyAllSkillsIntegrity();
        const summary = {
          total: results.length,
          ok: results.filter((r) => r.result.ok).length,
          missingOrigin: results.filter((r) => r.result.missingOrigin).length,
          failed: results.filter((r) => !r.result.ok && !r.result.missingOrigin).length,
        };
        res.json({ success: true, summary, results });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/skills/integrity/verify/:id — 校验单个技能的完整性
    app.get("/api/skills/integrity/verify/:id", (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          verifySkillIntegrity(skillId: string): { ok: boolean; missingOrigin: boolean; missingFiles: string[]; mismatchedFiles: unknown[]; lockMismatches: string[]; errors: string[] } | null;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const result = skillManager.verifySkillIntegrity(String(req.params.id));
        if (!result) {
          res.status(404).json({ error: "Skill not found" });
          return;
        }
        res.json({ success: true, result });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/skills/integrity/refresh-lock — 刷新 lock.json
    app.post("/api/skills/integrity/refresh-lock", (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          refreshLockfile(skillsRoot: string): boolean;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const skillsRoot = (req.body && typeof req.body.skillsRoot === "string")
          ? req.body.skillsRoot
          : path.resolve(process.cwd(), "data", "skills");
        const ok = skillManager.refreshLockfile(skillsRoot);
        res.json({ success: ok, skillsRoot });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/skills/integrity/verify-lock — 校验 lock.json
    app.get("/api/skills/integrity/verify-lock", (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          verifyLockfile(skillsRoot: string): { ok: boolean; missingOrigin: boolean; missingFiles: string[]; mismatchedFiles: unknown[]; lockMismatches: string[]; errors: string[] };
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const skillsRoot = (typeof req.query.skillsRoot === "string")
          ? req.query.skillsRoot
          : path.resolve(process.cwd(), "data", "skills");
        const result = skillManager.verifyLockfile(skillsRoot);
        res.json({ success: true, result });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/skills/:id/security-scan — 获取技能安全扫描结果（Round 8: UI verdict chip）
    app.get("/api/skills/:id/security-scan", (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          getSecurityScan(skillId: string): {
            safe: boolean;
            riskLevel: "low" | "medium" | "high" | "critical";
            findings: Array<{
              type: string;
              severity: "low" | "medium" | "high" | "critical";
              description: string;
              location: string;
              recommendation: string;
            }>;
          } | null;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const result = skillManager.getSecurityScan(String(req.params.id));
        if (!result) {
          res.status(404).json({ error: "Skill not found" });
          return;
        }
        res.json({ success: true, scan: result });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/skills/:id/install-binary — 安装技能缺失的系统 binary
    // 优先用技能声明的 openclaw.install 安装步骤，失败 fallback 到系统包管理器。
    // 由 WebUI 按钮触发（避免启动时自动安装带来的副作用）。
    app.post("/api/skills/:id/install-binary", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          installMissingBins(skillId: string): Promise<{
            success: boolean;
            results: Array<{ binary: string; installed: boolean; message: string; error?: string }>;
            stillMissing: string[];
          }>;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const result = await skillManager.installMissingBins(String(req.params.id));
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/skills/system/health — 技能系统健康检查（Round 10: 高可用性）
    app.get("/api/skills/system/health", (_req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          listSkills(): Promise<unknown[]>;
          getMarketplace?(): unknown;
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ status: "unhealthy", error: "Skill manager not available" });
          return;
        }
        // 异步收集健康指标
        (async () => {
          try {
            const skills = await skillManager.listSkills();
            const skillCount = Array.isArray(skills) ? skills.length : 0;
            // 检查是否有 marketplace 可用
            let marketplaceAvailable = false;
            try {
              marketplaceAvailable = typeof skillManager.getMarketplace === "function";
            } catch { /* ignore */ }
            res.json({
              status: "healthy",
              skillCount,
              marketplaceAvailable,
              timestamp: new Date().toISOString(),
            });
          } catch (err) {
            res.status(503).json({
              status: "degraded",
              error: String(err),
              timestamp: new Date().toISOString(),
            });
          }
        })().catch(() => {
          res.status(503).json({ status: "unhealthy", error: "Health check failed" });
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ============ Skill Workshop Routes ============
    // 暴露 SkillWorkshop 能力：提案创建/提交/审核/修订/安装/回滚
    // 对齐 openclaw-main skills/workshop API 形态
    type WorkshopShape = {
      getStats(): { total: number; byStatus: Record<string, number>; avgReviewTime: number };
      getTodayActions(): {
        pendingReview: unknown[];
        recentlyApproved: unknown[];
        recentlyRejected: unknown[];
      };
      listProposals(status?: string): unknown[];
      getProposal(id: string): unknown;
      createProposal(
        name: string,
        description: string,
        author: string,
        files: Array<{ path: string; content: string; type: "skill" | "config" | "asset" | "script" }>
      ): unknown;
      submitProposal(id: string): unknown;
      reviewProposal(id: string, reviewer: string, decision: "approve" | "reject", comment?: string): unknown;
      reviseProposal(
        id: string,
        files: Array<{ path: string; content: string; type: "skill" | "config" | "asset" | "script" }>,
        comment?: string
      ): unknown;
      installApproved(id: string): Promise<boolean>;
      rollback(id: string): boolean;
    };
    const resolveWorkshop = (res: Response): WorkshopShape | null => {
      const skillManager = this.registry.resolveService<{
        getSkillWorkshop(): WorkshopShape | null;
      }>("skillManager");
      if (!skillManager) {
        res.status(503).json({ error: "Skill manager not available" });
        return null;
      }
      const workshop = skillManager.getSkillWorkshop();
      if (!workshop) {
        res.status(503).json({ error: "Skill workshop is disabled" });
        return null;
      }
      return workshop;
    };

    // GET /api/skills/workshop/stats — 工作台总览
    app.get("/api/skills/workshop/stats", (_req: Request, res: Response) => {
      try {
        const workshop = resolveWorkshop(res);
        if (!workshop) return;
        res.json({ success: true, stats: workshop.getStats() });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/skills/workshop/today — 今日待办
    app.get("/api/skills/workshop/today", (_req: Request, res: Response) => {
      try {
        const workshop = resolveWorkshop(res);
        if (!workshop) return;
        res.json({ success: true, ...workshop.getTodayActions() });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/skills/workshop/proposals — 列出提案（可选 status 过滤）
    app.get("/api/skills/workshop/proposals", (req: Request, res: Response) => {
      try {
        const workshop = resolveWorkshop(res);
        if (!workshop) return;
        const status = req.query.status as string | undefined;
        const validStatuses = ["draft", "submitted", "under_review", "approved", "rejected", "quarantined"];
        if (status && !validStatuses.includes(status)) {
          res.status(400).json({ error: `Invalid status. Allowed: ${validStatuses.join(", ")}` });
          return;
        }
        res.json({ success: true, proposals: workshop.listProposals(status) });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/skills/workshop/proposals — 创建提案
    app.post("/api/skills/workshop/proposals", (req: Request, res: Response) => {
      try {
        const workshop = resolveWorkshop(res);
        if (!workshop) return;
        const { name, description, author, files } = req.body || {};
        if (!name || typeof name !== "string" || !name.trim()) {
          res.status(400).json({ error: "name is required" });
          return;
        }
        if (!description || typeof description !== "string") {
          res.status(400).json({ error: "description is required" });
          return;
        }
        if (!author || typeof author !== "string" || !author.trim()) {
          res.status(400).json({ error: "author is required" });
          return;
        }
        if (!Array.isArray(files) || files.length === 0) {
          res.status(400).json({ error: "files (non-empty array) is required" });
          return;
        }
        // 输入校验：限制单文件大小和文件数量，防止资源耗尽
        if (files.length > 20) {
          res.status(400).json({ error: "Too many files (max 20)" });
          return;
        }
        const allowedTypes = ["skill", "config", "asset", "script"];
        const sanitized = files.map((f: any, idx: number) => {
          if (!f || typeof f !== "object") {
            throw new Error(`File at index ${idx} is invalid`);
          }
          if (typeof f.path !== "string" || !f.path.trim()) {
            throw new Error(`File at index ${idx} has invalid path`);
          }
          // 禁止路径穿越
          if (f.path.includes("..") || /^[A-Za-z]:/.test(f.path) || f.path.startsWith("/")) {
            throw new Error(`File at index ${idx} has forbidden path: ${f.path}`);
          }
          if (typeof f.content !== "string" || f.content.length > 512 * 1024) {
            throw new Error(`File at index ${idx} content too large (>512KB) or invalid`);
          }
          const type = typeof f.type === "string" && allowedTypes.includes(f.type) ? f.type : "asset";
          return { path: f.path, content: f.content, type: type as "skill" | "config" | "asset" | "script" };
        });
        const proposal = workshop.createProposal(name.trim(), description, author.trim(), sanitized);
        res.status(201).json({ success: true, proposal });
      } catch (err) {
        res.status(400).json({ error: String(err) });
      }
    });

    // GET /api/skills/workshop/proposals/:id — 获取提案详情
    app.get("/api/skills/workshop/proposals/:id", (req: Request, res: Response) => {
      try {
        const workshop = resolveWorkshop(res);
        if (!workshop) return;
        const proposal = workshop.getProposal(String(req.params.id));
        if (!proposal) {
          res.status(404).json({ error: "Proposal not found" });
          return;
        }
        res.json({ success: true, proposal });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/skills/workshop/proposals/:id/submit — 提交审核
    app.post("/api/skills/workshop/proposals/:id/submit", (req: Request, res: Response) => {
      try {
        const workshop = resolveWorkshop(res);
        if (!workshop) return;
        const proposal = workshop.submitProposal(String(req.params.id));
        if (!proposal) {
          res.status(409).json({ error: "Proposal not found or not in draft status" });
          return;
        }
        res.json({ success: true, proposal });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/skills/workshop/proposals/:id/review — 审核提案
    app.post("/api/skills/workshop/proposals/:id/review", (req: Request, res: Response) => {
      try {
        const workshop = resolveWorkshop(res);
        if (!workshop) return;
        const { reviewer, decision, comment } = req.body || {};
        if (!reviewer || typeof reviewer !== "string") {
          res.status(400).json({ error: "reviewer is required" });
          return;
        }
        if (decision !== "approve" && decision !== "reject") {
          res.status(400).json({ error: "decision must be 'approve' or 'reject'" });
          return;
        }
        const proposal = workshop.reviewProposal(
          String(req.params.id),
          reviewer,
          decision,
          typeof comment === "string" ? comment : undefined
        );
        if (!proposal) {
          res.status(409).json({ error: "Proposal not found or not in reviewable status" });
          return;
        }
        res.json({ success: true, proposal });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/skills/workshop/proposals/:id/revise — 修订提案
    app.post("/api/skills/workshop/proposals/:id/revise", (req: Request, res: Response) => {
      try {
        const workshop = resolveWorkshop(res);
        if (!workshop) return;
        const { files, comment } = req.body || {};
        if (!Array.isArray(files) || files.length === 0) {
          res.status(400).json({ error: "files (non-empty array) is required" });
          return;
        }
        if (files.length > 20) {
          res.status(400).json({ error: "Too many files (max 20)" });
          return;
        }
        const allowedTypes = ["skill", "config", "asset", "script"];
        const sanitized = files.map((f: any, idx: number) => {
          if (!f || typeof f !== "object") {
            throw new Error(`File at index ${idx} is invalid`);
          }
          if (typeof f.path !== "string" || !f.path.trim() || f.path.includes("..") || /^[A-Za-z]:/.test(f.path) || f.path.startsWith("/")) {
            throw new Error(`File at index ${idx} has invalid or forbidden path`);
          }
          if (typeof f.content !== "string" || f.content.length > 512 * 1024) {
            throw new Error(`File at index ${idx} content too large or invalid`);
          }
          const type = typeof f.type === "string" && allowedTypes.includes(f.type) ? f.type : "asset";
          return { path: f.path, content: f.content, type: type as "skill" | "config" | "asset" | "script" };
        });
        const proposal = workshop.reviseProposal(
          String(req.params.id),
          sanitized,
          typeof comment === "string" ? comment : undefined
        );
        if (!proposal) {
          res.status(409).json({ error: "Proposal not found or not in revisable status" });
          return;
        }
        res.json({ success: true, proposal });
      } catch (err) {
        res.status(400).json({ error: String(err) });
      }
    });

    // POST /api/skills/workshop/proposals/:id/install — 安装已批准的提案
    app.post("/api/skills/workshop/proposals/:id/install", async (req: Request, res: Response) => {
      try {
        const workshop = resolveWorkshop(res);
        if (!workshop) return;
        const ok = await workshop.installApproved(String(req.params.id));
        if (!ok) {
          res.status(409).json({ error: "Proposal not found, not approved, or hash verification failed" });
          return;
        }
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // POST /api/skills/workshop/proposals/:id/rollback — 回滚已安装的提案
    app.post("/api/skills/workshop/proposals/:id/rollback", (req: Request, res: Response) => {
      try {
        const workshop = resolveWorkshop(res);
        if (!workshop) return;
        const ok = workshop.rollback(String(req.params.id));
        if (!ok) {
          res.status(409).json({ error: "Proposal not installed or not found" });
          return;
        }
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ============ Bootstrap File Routes ============
    app.get("/api/bootstrap", async (_req: Request, res: Response) => {
      try {
        const bm = this.registry.resolveService<{
          listFiles(): { name: string; description: string; content: string; exists: boolean }[];
          getContext(): { bootstrapPending: boolean; missingFiles: string[] };
          getWorkspacePath(): string;
        }>("bootstrapManager");
        if (!bm) return res.json({ files: [], pending: false, workspacePath: "" });
        const files = bm.listFiles();
        const ctx = bm.getContext();
        res.json({ files, pending: ctx.bootstrapPending, missingFiles: ctx.missingFiles, workspacePath: bm.getWorkspacePath() });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/bootstrap/:filename", (req: Request, res: Response) => {
      try {
        const filename = String(req.params.filename);
        // 白名单校验：与 PUT/DELETE 一致，防止路径穿越
        if (!["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"].includes(filename)) {
          res.status(400).json({ error: "Invalid filename" });
          return;
        }
        const bm = this.registry.resolveService<{
          readBootstrapFile(filename: string): string | null;
        }>("bootstrapManager");
        if (!bm) return res.status(404).json({ error: "Bootstrap manager not found" });
        const content = bm.readBootstrapFile(filename);
        if (content === null) return res.status(404).json({ error: "File not found" });
        res.json({ filename, content });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.put("/api/bootstrap/:filename", (req: Request, res: Response) => {
      try {
        const filename = String(req.params.filename);
        if (!["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"].includes(filename)) {
          res.status(400).json({ error: "Invalid filename" });
          return;
        }
        const bm = this.registry.resolveService<{
          writeBootstrapFile(filename: string, content: string): void;
        }>("bootstrapManager");
        if (!bm) return res.status(404).json({ error: "Bootstrap manager not found" });
        const { content } = req.body || {};
        if (!content) return res.status(400).json({ error: "Content is required" });
        bm.writeBootstrapFile(filename, content);
        res.json({ success: true, filename });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.delete("/api/bootstrap/:filename", (req: Request, res: Response) => {
      try {
        const filename = String(req.params.filename);
        if (!["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"].includes(filename)) {
          res.status(400).json({ error: "Invalid filename" });
          return;
        }
        const bm = this.registry.resolveService<{
          deleteBootstrapFile(filename: string): void;
        }>("bootstrapManager");
        if (!bm) return res.status(404).json({ error: "Bootstrap manager not found" });
        bm.deleteBootstrapFile(filename);
        res.json({ success: true, filename });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/bootstrap/complete", (_req: Request, res: Response) => {
      try {
        const bm = this.registry.resolveService<{
          completeBootstrap(): void;
        }>("bootstrapManager");
        if (!bm) return res.json({ success: false, message: "Not available" });
        bm.completeBootstrap();
        res.json({ success: true, message: "Bootstrap completed" });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ============ Status / Lifecycle Routes ============
    app.get("/api/status", (_req: Request, res: Response) => {
      try {
        const lm = this.registry.resolveService<{
          getAllStatuses(): Array<{ sessionId: string; state: string; currentAction: string; toolCalls: Array<{ name: string; status: string }>; lastActivity: string; tokensUsed: number; duration: number; runId: number; progress?: { current: number; total: number; label: string } }>;
          getStatus(sessionId: string): unknown;
        }>("lifecycleManager");
        const uptime = process.uptime();
        const memUsage = process.memoryUsage();
        res.json({
          online: true,
          uptime: Math.floor(uptime),
          uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
          memory: {
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            rss: Math.round(memUsage.rss / 1024 / 1024),
          },
          platform: process.platform,
          nodeVersion: process.version,
          agentStatuses: lm?.getAllStatuses() || [],
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/status/:sessionId", (req: Request, res: Response) => {
      try {
        const lm = this.registry.resolveService<{
          getStatus(sessionId: string): unknown;
        }>("lifecycleManager");
        if (!lm) return res.json({ sessionId: req.params.sessionId, state: "unknown" });
        const status = lm.getStatus(String(req.params.sessionId));
        if (!status) return res.json({ sessionId: req.params.sessionId, state: "idle" });
        res.json(status);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // Queue routes are defined below in the main routing section.
    // See the "Queue API routes" section for full endpoints.

    // ============ Compaction Routes ============
    app.get("/api/compactions/:sessionId", (req: Request, res: Response) => {
      try {
        const cm = this.registry.resolveService<{
          getCompactionChain(sessionId: string): unknown[];
          loadCompactionChain(sessionId: string): unknown[];
        }>("compactionManager");
        if (!cm) return res.json({ compactions: [] });
        const chain = cm.getCompactionChain(String(req.params.sessionId));
        res.json({ compactions: chain });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/tasks", async (req: Request, res: Response) => {
      try {
        const taskOrchestrator = this.registry.resolveService<{
          createTask(input: unknown): Promise<unknown>;
        }>("taskOrchestrator");
        if (!taskOrchestrator) {
          res.status(503).json({ error: "Task orchestrator not available" });
          return;
        }
        const task = await taskOrchestrator.createTask(req.body);
        res.status(201).json(task);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/tasks/:id", async (req: Request, res: Response) => {
      try {
        const taskOrchestrator = this.registry.resolveService<{
          getTaskStatus(id: string): Promise<unknown>;
        }>("taskOrchestrator");
        if (!taskOrchestrator) {
          res.status(503).json({ error: "Task orchestrator not available" });
          return;
        }
        const status = await taskOrchestrator.getTaskStatus(String(req.params.id));
        res.json(status);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/chat", async (req: Request, res: Response) => {
      const sessionId = (req.body.sessionId as string) || "web-ui";
      let chatTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const message = (req.body.message as string) || "";
        const attachments = req.body.attachments as Array<{ name: string; type: string; size: number; data: string | null }> | undefined;
        const useStream = (req.body.stream as boolean) || (req.query.stream === "true");
        if (!message.trim() && (!attachments || attachments.length === 0)) {
          res.status(400).json({ error: "Message or attachment is required" });
          return;
        }
        // 消息长度上限：防止超长输入长时间占用 LLM 处理链路（DoS 风险）。
        // 限制为 32KB（约 3.2 万字符），覆盖正常对话与代码片段场景。
        const MAX_MESSAGE_LENGTH = 32 * 1024;
        if (message.length > MAX_MESSAGE_LENGTH) {
          res.status(413).json({ error: `Message too large: ${message.length} bytes exceeds limit of ${MAX_MESSAGE_LENGTH} bytes` });
          return;
        }

        const rm = this.getReplyReferenceManager();
        if (rm && (req.body.replyTo || req.body.parentId || req.body.inReplyTo)) {
          try {
            rm.record(req.body.replyTo || req.body.parentId || req.body.inReplyTo, req.body.id || req.body.sessionId || "web-ui", {
              channel: req.body.channel || "webchat",
            });
          } catch (err) { process.stderr.write("[ProtocolAdapter] Failed to record reply reference:" + " " + err + "\n"); }
        }

        const agentExecutor = this.registry.resolveService<{
          chat(prompt: string, context?: Record<string, unknown>, onProgress?: (event: import("@evoclaw/agent").AgentProgressEvent) => void): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests?: Array<{ id: string; operation: string; description: string; target: string }>; files?: Array<{ path: string; size: number; downloadUrl: string }> }>;
          /** End-to-end cancellation: aborts in-flight LLM fetches for a session. */
          abortSession?(sessionId: string): boolean;
          getGreeting(): string | null;
          generateBriefUnderstanding(userMessage: string): Promise<string>;
        }>("agentModelExecutor");

        if (!agentExecutor) {
          res.status(503).json({ error: "Agent model executor not available" });
          return;
        }

        const resolvedSessionId = sessionId;

        // ── SSE Streaming Mode ──
        if (useStream) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("X-Accel-Buffering", "no");
          res.flushHeaders();

          const sendSSE = (event: string, data: unknown) => {
            try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
          };

          try {
            const understanding = await agentExecutor.generateBriefUnderstanding(message);
            if (understanding) {
              sendSSE("understanding", { text: understanding });
            }
          } catch (err) { console.debug("[ProtocolAdapter]", err instanceof Error ? err.message : String(err)); }

          let webSearchCount = 0;
          let webFetchCount = 0;
          let lastSearchReportRound = 0;
          let lastFetchReportCount = 0;

          const onProgress = (event: import("@evoclaw/agent").AgentProgressEvent) => {
            if (event.type === "tool_result" && event.toolName === "web_search") {
              webSearchCount++;
              if (webSearchCount % 3 === 0 || webSearchCount === 1) {
                sendSSE("progress_summary", { type: "search_progress", count: webSearchCount, detail: event.detail });
                lastSearchReportRound = webSearchCount;
              }
            } else if (event.type === "tool_result" && event.toolName === "fetch_node_page") {
              webFetchCount++;
              if (webFetchCount % 3 === 0 || webFetchCount === 1) {
                sendSSE("progress_summary", { type: "fetch_progress", count: webFetchCount, detail: event.detail?.slice(0, 200) });
                lastFetchReportCount = webFetchCount;
              }
            } else if (event.type === "final") {
              if (webSearchCount > lastSearchReportRound) {
                sendSSE("progress_summary", { type: "search_done", count: webSearchCount });
              }
              if (webFetchCount > lastFetchReportCount) {
                sendSSE("progress_summary", { type: "fetch_done", count: webFetchCount });
              }
              sendSSE(event.type, event);
            } else {
              sendSSE(event.type, event);
            }
          };

          const complexity = estimateTaskComplexity(message);
          const CHAT_TIMEOUT = complexity.timeoutMs;
          process.stdout.write(`[ProtocolAdapter] Chat complexity: ${complexity.level}, timeout: ${CHAT_TIMEOUT / 1000}s, autoSplit: ${complexity.shouldAutoSplit}\n`);
          let chatTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
          let keepAliveHandle: ReturnType<typeof setInterval> | undefined;
          // ── End-to-end cancellation: listen for client disconnect ──
          // When the browser closes the SSE connection (user navigates away,
          // clicks "stop", or the network drops), trigger abortSession so the
          // in-flight LLM fetch is cancelled and the tryCallLLM loop short-circuits.
          // Without this, the server keeps processing and burning tokens even
          // though no one is listening. The listener is removed in `finally`.
          let clientDisconnected = false;
          const onClose = () => {
            clientDisconnected = true;
            if (agentExecutor?.abortSession) {
              try { agentExecutor.abortSession(resolvedSessionId); } catch { /* best-effort */ }
            }
          };
          req.on("close", onClose);
          try {
            // Tell the user right away that a long-running task is being processed.
            sendSSE("working", { phase: "working", detail: "正在进行生成，请耐心等待..." });
            keepAliveHandle = setInterval(() => {
              sendSSE("working", { phase: "working", detail: "仍在处理中，请继续等待..." });
            }, 20_000);
            // unref 防止 keepAlive 定时器阻止进程优雅退出（请求挂起期间会一直 tick）
            keepAliveHandle.unref();

            const chatPromise = agentExecutor.chat(message, { sessionId: resolvedSessionId, attachments, complexity: complexity.level, shouldAutoSplit: complexity.shouldAutoSplit, maxSubtasks: complexity.maxSubtasks }, onProgress);
            chatPromise.catch(() => {}); // 防止超时后 unhandledRejection
            const result = await Promise.race([
              chatPromise,
              new Promise<never>((_, reject) => {
                chatTimeoutHandle = setTimeout(() => reject(new Error("CHAT_TIMEOUT")), CHAT_TIMEOUT);
                if (chatTimeoutHandle.unref) chatTimeoutHandle.unref();
              }),
            ]);

            let contextLimit = 128000;
            let sessionTokensUsed = 0;
        try {
          const getProvidersFn2 = (agentExecutor as Record<string, unknown>).getProviders;
          if (typeof getProvidersFn2 === "function") {
            const providersList2 = (getProvidersFn2 as () => Array<{ enabled: boolean; model: string }>)();
            if (providersList2 && providersList2.length > 0) {
              const activeProvider2 = providersList2.find((p) => p.enabled);
              if (activeProvider2?.model) {
                const MODEL_CONTEXT: Record<string, number> = {
                  "gpt-4o": 128000, "gpt-4o-mini": 128000, "gpt-4-turbo": 128000, "gpt-4": 8192, "gpt-3.5-turbo": 16385,
                  "claude-3-5-sonnet": 200000, "claude-3-opus": 200000, "claude-3-sonnet": 200000, "claude-3-haiku": 200000,
                  "claude-sonnet-4-20250514": 200000, "deepseek-chat": 128000, "deepseek-reasoner": 128000,
                  "qwen-max": 32768, "qwen-plus": 131072, "qwen-turbo": 131072,
                  "glm-4": 128000, "glm-4-flash": 128000,
                };
                for (const [pattern, limit] of Object.entries(MODEL_CONTEXT)) {
                  if (activeProvider2.model.includes(pattern.replace("-4-turbo", "").replace("-4o", ""))) {
                    contextLimit = limit;
                    break;
                  }
                }
                if (activeProvider2.model.includes("gpt-4o") || activeProvider2.model.includes("gpt-4-turbo")) contextLimit = 128000;
                if (activeProvider2.model.includes("claude")) contextLimit = 200000;
                if (activeProvider2.model.includes("deepseek")) contextLimit = 128000;
              }
            }
          }
        } catch (err) { /* ignore provider lookup errors */ }
            try {
              const contextEngine = this.registry.resolveService("contextEngine") as { getConfig(): Record<string, unknown> } | undefined;
              if (contextEngine) {
                const cfgMaxRaw = contextEngine.getConfig().maxContextTokens;
                const cfgMax = typeof cfgMaxRaw === "number" && Number.isFinite(cfgMaxRaw) ? cfgMaxRaw : 0;
                if (cfgMax > 0) contextLimit = cfgMax;
              }
            } catch (err) { console.debug("[ProtocolAdapter]", err instanceof Error ? err.message : String(err)); }
            try {
              const lifecycleMgr = this.registry.resolveService<{ getAllStatuses(): Array<{ sessionId: string; tokensUsed?: number }> }>("lifecycleManager");
              if (lifecycleMgr) {
                const s = lifecycleMgr.getAllStatuses().find(s => s.sessionId === resolvedSessionId);
                if (s?.tokensUsed) sessionTokensUsed = s.tokensUsed;
              }
            } catch (err) { console.debug("[ProtocolAdapter]", err instanceof Error ? err.message : String(err)); }

            sendSSE("done", {
              reply: result.reply,
              tokensUsed: result.tokensUsed > 0 ? result.tokensUsed : sessionTokensUsed,
              contextTokens: ("contextTokens" in result ? (result as Record<string, unknown>).contextTokens : 0) || 0,
              contextLimit,
              duration: result.duration,
              sessionId: resolvedSessionId,
              permissionRequests: result.permissionRequests || [],
              files: result.files || [],
            });
          } catch (chatErr) {
            if (clientDisconnected) {
              // Client already left; no point sending an SSE error event.
              console.debug("[ProtocolAdapter] Client disconnected; aborting chat silently");
            } else if (chatErr instanceof Error && chatErr.message === "CHAT_TIMEOUT") {
              sendSSE("error", { message: "⏱️ 处理超时，请稍后重试。替代方案：① 简化您的请求后重试；② 将任务拆分为更小的步骤；③ 检查网络连接是否正常。" });
            } else {
              const errMsg = chatErr instanceof Error ? chatErr.message : String(chatErr);
              sendSSE("error", { message: `❌ 处理请求时出错：${errMsg}\n\n替代方案：① 请稍后重试；② 尝试简化请求；③ 前往 Ops 页面检查系统状态。` });
            }
          } finally {
            req.off("close", onClose);
            if (keepAliveHandle) clearInterval(keepAliveHandle);
            if (chatTimeoutHandle) clearTimeout(chatTimeoutHandle);
            try { res.end(); } catch (err) { console.debug("[ProtocolAdapter]", err instanceof Error ? err.message : String(err)); }
          }
          return;
        }

        // ── Non-streaming Mode (original behavior) ──
        const complexity = estimateTaskComplexity(message);
        const CHAT_TIMEOUT = complexity.timeoutMs;
        process.stdout.write(`[ProtocolAdapter] Chat (non-stream) complexity: ${complexity.level}, timeout: ${CHAT_TIMEOUT / 1000}s\n`);
        const chatPromise = agentExecutor.chat(message, {
          sessionId: resolvedSessionId,
          attachments,
          complexity: complexity.level,
          shouldAutoSplit: complexity.shouldAutoSplit,
          maxSubtasks: complexity.maxSubtasks,
        });

        let result;
        chatPromise.catch(() => {}); // 防止超时后 unhandledRejection
        try {
          result = await Promise.race([
            chatPromise,
            new Promise<never>((_, reject) => {
              chatTimeoutHandle = setTimeout(() => reject(new Error("CHAT_TIMEOUT")), CHAT_TIMEOUT);
              if (chatTimeoutHandle.unref) chatTimeoutHandle.unref();
            }),
          ]);
        } catch (raceErr) {
          if (raceErr instanceof Error && raceErr.message === "CHAT_TIMEOUT") {
            process.stderr.write(`[ProtocolAdapter] Chat request timed out after ${CHAT_TIMEOUT / 1000}s for session "${resolvedSessionId}"\n`);
            res.json({
              reply: "⏱️ 处理超时，请稍后重试。替代方案：\n① 简化您的请求后重试\n② 将任务拆分为更小的步骤\n③ 检查网络连接和模型配置是否正常\n\n需要我帮您将任务拆分后逐步完成吗？",
              tokensUsed: 0,
              contextLimit: 128000,
              duration: CHAT_TIMEOUT,
              sessionId: resolvedSessionId,
              permissionRequests: [],
            });
            return;
          }
          throw raceErr;
        }
        if (chatTimeoutHandle) clearTimeout(chatTimeoutHandle);

        // Resolve context limit from ContextEngine config
        let contextLimit = 128000;
        let sessionTokensUsed = 0;
        try {
          const getProvidersFn = (agentExecutor as Record<string, unknown>).getProviders;
          if (typeof getProvidersFn === "function") {
            const providersList = (getProvidersFn as () => Array<{ enabled: boolean; model: string }>)();
            if (providersList && providersList.length > 0) {
              const activeProvider = providersList.find((p) => p.enabled);
              if (activeProvider?.model) {
                if (activeProvider.model.includes("gpt-4o") || activeProvider.model.includes("gpt-4-turbo")) contextLimit = 128000;
                else if (activeProvider.model.includes("claude")) contextLimit = 200000;
                else if (activeProvider.model.includes("deepseek")) contextLimit = 128000;
                else if (activeProvider.model.includes("qwen")) contextLimit = 131072;
              }
            }
          }
        } catch (err) { /* ignore provider lookup errors */ }
        try {
          const contextEngine = this.registry.resolveService("contextEngine") as {
            getConfig(): Record<string, unknown>;
          } | undefined;
          if (contextEngine) {
            const cfgMaxRaw = contextEngine.getConfig().maxContextTokens;
            const cfgMax = typeof cfgMaxRaw === "number" && Number.isFinite(cfgMaxRaw) ? cfgMaxRaw : 0;
            if (cfgMax > 0) contextLimit = cfgMax;
          }
        } catch (err) { console.debug("[ProtocolAdapter]", err instanceof Error ? err.message : String(err)); }
        try {
          const lifecycleMgr = this.registry.resolveService<{
            getAllStatuses(): Array<{ sessionId: string; tokensUsed?: number; compactionCount?: number }>;
          }>("lifecycleManager");
          if (lifecycleMgr) {
            const statuses = lifecycleMgr.getAllStatuses();
            const sessionStatus = statuses.find(s => s.sessionId === resolvedSessionId);
            if (sessionStatus && sessionStatus.tokensUsed) {
              sessionTokensUsed = sessionStatus.tokensUsed;
            }
          }
        } catch (err) { console.debug("[ProtocolAdapter]", err instanceof Error ? err.message : String(err)); }

        const totalTokensUsed = result.tokensUsed > 0 ? result.tokensUsed : sessionTokensUsed;

        // Record reply reference: user message → agent reply
        try {
          const rm = this.getReplyReferenceManager();
          const userMsgId = `msg_${resolvedSessionId}_${Date.now() - Math.round(result.duration)}`;
          const agentMsgId = `msg_${resolvedSessionId}_${Date.now()}`;
          rm.record(userMsgId, agentMsgId, { channel: "webchat", peer: "user" });
        } catch (err) { console.debug("[ProtocolAdapter]", err instanceof Error ? err.message : String(err)); }

        res.json({
          reply: result.reply,
          tokensUsed: totalTokensUsed,
          contextLimit,
          duration: result.duration,
          sessionId: resolvedSessionId,
          permissionRequests: result.permissionRequests || [],
          files: result.files || [],
        });
        if (chatTimeoutHandle) clearTimeout(chatTimeoutHandle);
        return;
      } catch (err) {
        if (chatTimeoutHandle) clearTimeout(chatTimeoutHandle);
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[ProtocolAdapter] Chat endpoint error: ${errMsg}\n`);
        res.json({
          reply: `❌ 处理您的请求时遇到了问题：${errMsg}\n\n替代方案：\n① 请稍后重试，可能是临时性故障\n② 尝试简化您的请求\n③ 如果问题持续，请前往 Ops 页面检查系统状态\n\n需要我帮您用其他方式完成吗？`,
          tokensUsed: 0,
          duration: 0,
          sessionId: sessionId || "unknown",
          permissionRequests: [],
        });
      }
    });

    // ── Task status polling: real-time progress for long-running chat tasks ──
    app.get("/api/chat/status", (req: Request, res: Response) => {
      const sessionId = (req.query.sessionId as string) || "";
      const status = taskStatusTracker.get(sessionId);
      if (!status) {
        res.json({ phase: "idle", detail: "no active task", progress: 0 });
        return;
      }
      res.json(status);
    });

    // ── End-to-end cancellation endpoint ──
    // Allows the WebUI / external clients to explicitly cancel an in-flight
    // chat for a session. Triggers AgentModelExecutor.abortSession, which
    // fires the per-session AbortController, propagating to:
    //  - in-flight LLM fetch (via signal wired into callLLMOnce)
    //  - tool execution (via retryAsync abortSignal)
    //  - tryCallLLM main loop (short-circuits at the next round boundary)
    app.post("/api/chat/cancel", (req: Request, res: Response) => {
      const sessionId = (req.body.sessionId as string) || (req.query.sessionId as string) || "";
      if (!sessionId) {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }
      const agentExecutor = this.registry.resolveService<{ abortSession?(sessionId: string): boolean }>("agentModelExecutor");
      if (!agentExecutor?.abortSession) {
        res.status(501).json({ error: "Cancellation not supported by this agent executor" });
        return;
      }
      const aborted = agentExecutor.abortSession(sessionId);
      res.json({ aborted, sessionId });
    });

    app.get("/api/chat/checkpoint", (req: Request, res: Response) => {
      const sessionId = (req.query.sessionId as string) || "";
      if (!taskCheckpointManager.has(sessionId)) {
        res.json({ hasCheckpoint: false });
        return;
      }
      const checkpoint = taskCheckpointManager.get(sessionId);
      res.json({ hasCheckpoint: true, checkpoint });
    });

    app.post("/api/chat/resume", async (req: Request, res: Response) => {
      const sessionId = (req.body.sessionId as string) || "";
      const message = (req.body.message as string) || "";
      const useStream = (req.body.stream as boolean) || (req.query.stream === "true");
      let resumeTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

      const agentExecutor = this.registry.resolveService<{
        chat(prompt: string, context?: Record<string, unknown>, onProgress?: (event: import("@evoclaw/agent").AgentProgressEvent) => void): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests?: Array<{ id: string; operation: string; description: string; target: string }>; files?: Array<{ path: string; size: number; downloadUrl: string }> }>;
      }>("agentModelExecutor");

      if (!agentExecutor) {
        res.status(503).json({ error: "Agent model executor not available" });
        return;
      }

      const complexity = estimateTaskComplexity(message);

      if (useStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const sendSSE = (event: string, data: unknown) => {
          try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
        };
        const onProgress = (event: import("@evoclaw/agent").AgentProgressEvent) => {
          sendSSE(event.type, event);
        };

        const CHAT_TIMEOUT = complexity.timeoutMs;
        try {
          const resumeChatPromise = agentExecutor.chat(message, { sessionId, complexity: complexity.level, shouldAutoSplit: complexity.shouldAutoSplit, maxSubtasks: complexity.maxSubtasks }, onProgress);
          resumeChatPromise.catch(() => {}); // 防止超时后 unhandledRejection
          const result = await Promise.race([
            resumeChatPromise,
            new Promise<never>((_, reject) => {
              resumeTimeoutHandle = setTimeout(() => reject(new Error("CHAT_TIMEOUT")), CHAT_TIMEOUT);
              if (resumeTimeoutHandle.unref) resumeTimeoutHandle.unref();
            }),
          ]);
          sendSSE("done", { reply: result.reply, tokensUsed: result.tokensUsed, duration: result.duration, sessionId, resumed: true });
        } catch (chatErr) {
          if (chatErr instanceof Error && chatErr.message === "CHAT_TIMEOUT") {
            sendSSE("error", { message: "⏱️ 恢复任务超时，但进度已保存，可再次恢复。" });
          } else {
            sendSSE("error", { message: String(chatErr) });
          }
        } finally {
          if (resumeTimeoutHandle) clearTimeout(resumeTimeoutHandle);
          try { res.end(); } catch (err) { console.debug("[ProtocolAdapter]", err instanceof Error ? err.message : String(err)); }
        }
        return;
      }

      res.json({ reply: "恢复任务请使用流式模式 (stream: true)", resumed: false });
    });

    app.get("/api/system/services", (_req: Request, res: Response) => {
      const infos = this.registry.getAllServiceInfos?.() || [];
      res.json(infos);
    });

    // ─── Skill Index API ────────────────────────────────────────────────
    // 暴露 SkillIndex 服务的搜索与统计能力，供 WebUI 与外部客户端使用

    app.get("/api/skill-index/search", (req: Request, res: Response) => {
      try {
        const skillIndex = this.registry.resolveService<{
          search(query: string, limit?: number): unknown[];
          getSize(): number;
          getAll(): unknown[];
        }>("skillIndex");
        if (!skillIndex) {
          res.status(503).json({ error: "SkillIndex not available" });
          return;
        }
        const query = String(req.query.q ?? req.query.query ?? "").trim();
        if (!query) {
          res.status(400).json({ error: "Query parameter 'q' is required" });
          return;
        }
        const limit = Math.max(1, Math.min(parseInt(String(req.query.limit), 10) || 10, 100));
        const results = skillIndex.search(query, limit);
        res.json({ query, results, count: results.length });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/skill-index/stats", (_req: Request, res: Response) => {
      try {
        const skillIndex = this.registry.resolveService<{
          getSize(): number;
          getAll(): unknown[];
        }>("skillIndex");
        if (!skillIndex) {
          res.status(503).json({ error: "SkillIndex not available" });
          return;
        }
        res.json({ totalIndexed: skillIndex.getSize() });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Reporting API ──────────────────────────────────────────────────
    // 暴露 ReportGenerator 服务的模板列表能力，供 WebUI 与外部客户端使用

    app.get("/api/reporting/templates", (_req: Request, res: Response) => {
      try {
        const reportGenerator = this.registry.resolveService<{
          getTemplateNames(): string[];
          getTemplate(name: string): unknown;
        }>("reportGenerator");
        if (!reportGenerator) {
          res.status(503).json({ error: "ReportGenerator not available" });
          return;
        }
        const names = reportGenerator.getTemplateNames();
        const templates = names.map((name) => ({ name, template: reportGenerator.getTemplate(name) }));
        res.json({ templates, count: templates.length });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Intelligence API ───────────────────────────────────────────────
    // 暴露 TaskClassifier 服务的分类能力，供 WebUI 与外部客户端使用

    app.get("/api/intelligence/classify", (req: Request, res: Response) => {
      try {
        const taskClassifier = this.registry.resolveService<{
          classify(task: string): unknown;
        }>("taskClassifier");
        if (!taskClassifier) {
          res.status(503).json({ error: "TaskClassifier not available" });
          return;
        }
        const text = String(req.query.text ?? req.query.q ?? "").trim();
        if (!text) {
          res.status(400).json({ error: "Query parameter 'text' is required" });
          return;
        }
        const result = taskClassifier.classify(text);
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Prometheus Metrics Endpoint ────────────────────────────────────
    // 暴露基础运行时指标（服务数、内存使用、运行时长）供 Prometheus/Grafana 抓取。
    // 完整指标由 Observability 服务收集，此处提供最小可用端点。

    app.get("/api/metrics", (_req: Request, res: Response) => {
      try {
        const mem = process.memoryUsage();
        const uptime = process.uptime();
        const services = this.registry.getAllServiceInfos?.() || [];
        const running = services.filter((s: any) => s?.status === "running").length;
        res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
        const lines: string[] = [
          "# HELP evoclaw_services_total Total registered services",
          "# TYPE evoclaw_services_total gauge",
          `evoclaw_services_total ${services.length}`,
          "# HELP evoclaw_services_running Running services count",
          "# TYPE evoclaw_services_running gauge",
          `evoclaw_services_running ${running}`,
          "# HELP evoclaw_process_uptime_seconds Process uptime in seconds",
          "# TYPE evoclaw_process_uptime_seconds gauge",
          `evoclaw_process_uptime_seconds ${uptime.toFixed(2)}`,
          "# HELP evoclaw_process_memory_rss_bytes Resident set size in bytes",
          "# TYPE evoclaw_process_memory_rss_bytes gauge",
          `evoclaw_process_memory_rss_bytes ${mem.rss}`,
          "# HELP evoclaw_process_memory_heap_used_bytes Heap used in bytes",
          "# TYPE evoclaw_process_memory_heap_used_bytes gauge",
          `evoclaw_process_memory_heap_used_bytes ${mem.heapUsed}`,
          "# HELP evoclaw_process_memory_heap_total_bytes Heap total in bytes",
          "# TYPE evoclaw_process_memory_heap_total_bytes gauge",
          `evoclaw_process_memory_heap_total_bytes ${mem.heapTotal}`,
          "",
        ];
        res.send(lines.join("\n"));
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── System info endpoints for Dashboard ────────────────────────────

    app.get("/api/system/sessions", (_req: Request, res: Response) => {
      try {
        const sessionMgr = this.registry.resolveService<any>("sessionManager");
        let allSessions: any[] = [];
        if (sessionMgr) {
          const agents: string[] = sessionMgr.listAgents?.() || [];
          for (const agentId of agents) {
            const agentSessions = sessionMgr.listSessions?.(agentId) || [];
            if (Array.isArray(agentSessions)) {
              allSessions = allSessions.concat(agentSessions);
            }
          }
        }
        const result = allSessions.map((s: any) => ({
          id: s.sessionId || s.id,
          messageCount: s.turnCount || s.messageCount || 0,
          lastActive: s.updatedAt || s.lastActivityAt || new Date().toISOString(),
          compactionCount: s.compactionCount || 0,
          tokensUsed: s.tokenEstimate || s.tokensUsed || 0,
        }));
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/system/providers", (_req: Request, res: Response) => {
      try {
        const executor = this.registry.resolveService<{
          getProviders(): Array<{ id: string; name: string; provider?: string; model?: string; enabled: boolean; order: number; lastError?: string; lastErrorType?: string; successCount?: number; failureCount?: number }>;
        }>("agentModelExecutor");

        const providers = executor?.getProviders() || this.savedLLMProviders || [];
        const result = providers.map((p: any) => ({
          name: p.name || p.id,
          provider: p.provider || p.id,
          model: p.model || "default",
          status: p.enabled !== false ? "active" as const : "inactive" as const,
          lastError: p.lastError || undefined,
          lastErrorType: p.lastErrorType || undefined,
          successCount: p.successCount || 0,
          failureCount: p.failureCount || 0,
        }));

        res.json(result);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/system/bootstrap-files", (_req: Request, res: Response) => {
      try {
        // Bootstrap files are loaded from the workspace directory (same as agent-model-executor)
        const workspacePath = path.resolve("data", "workspace");
        const files = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"];
        const result = files.map((f) => {
          const filePath = path.join(workspacePath, f);
          const exists = fs.existsSync(filePath);
          return {
            path: f,
            exists,
            size: exists ? fs.statSync(filePath).size : 0,
          };
        });
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/system/bootstrap-file/:file", (req: Request, res: Response) => {
      try {
        const filename = String(req.params.file);
        if (!["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"].includes(filename)) {
          res.status(404).json({ error: "Unknown bootstrap file" });
          return;
        }
        const workspacePath = path.resolve("data", "workspace");
        const filePath = path.join(workspacePath, filename);
        if (!fs.existsSync(filePath)) {
          res.json({ path: filename, content: "", editable: true, exists: false });
          return;
        }
        const content = fs.readFileSync(filePath, "utf8");
        res.json({ path: filename, content, editable: true, exists: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.put("/api/system/bootstrap-file/:file", (req: Request, res: Response) => {
      try {
        const filename = String(req.params.file);
        if (!["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"].includes(filename)) {
          res.status(404).json({ error: "Unknown bootstrap file" });
          return;
        }
        const { content } = req.body || {};
        if (typeof content !== "string") {
          res.status(400).json({ error: "content field (string) is required" });
          return;
        }
        const workspacePath = path.resolve("data", "workspace");
        const filePath = path.join(workspacePath, filename);
        if (!fs.existsSync(path.dirname(filePath))) {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
        }
        atomicWriteFileSync(filePath, content);
        res.json({ success: true, path: filename, bytes: Buffer.byteLength(content, "utf8") });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/config/llm", (_req: Request, res: Response) => {
      try {
        const executor = this.registry.resolveService<{
          getRegisteredTools(): unknown[];
          getProviders(): { id: string; name: string; enabled: boolean; order: number }[];
        }>("agentModelExecutor");
        // API keys are now ${VAR} references in JSON — safe to return directly
        // Add hasApiKey flag so frontend knows if a key is configured
        const providers = (this.savedLLMProviders || []).map((p: Record<string, unknown>) => {
          const apiKey = p.apiKey as string | undefined;
          // hasApiKey: true only if there's a real key (not empty, not **** mask, not unresolved reference)
          let hasApiKey = false;
          if (apiKey && !apiKey.includes("****")) {
            if (this.envSecrets.isRef(apiKey)) {
              const resolved = this.envSecrets.resolve(apiKey);
              hasApiKey = !!(resolved && typeof resolved === "string" && !resolved.includes("****"));
            } else {
              hasApiKey = true;
            }
          }
          return { ...p, hasApiKey };
        });
        res.json({
          executorTools: executor?.getRegisteredTools() || [],
          providers,
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.put("/api/config/llm", (req: Request, res: Response) => {
      try {
        const { providers } = req.body || {};
        if (Array.isArray(providers)) {
          const existingProviders = this.savedLLMProviders || [];
          const processedProviders = providers.map((p: Record<string, unknown>) => {
            const existing = existingProviders.find((e: Record<string, unknown>) => e.id === p.id);
            const result = { ...p };

            if (typeof result.apiKey === "string") {
              const apiKey = result.apiKey;
              if (apiKey.includes("****")) {
                // Frontend sent a masked key — keep the existing reference
                result.apiKey = existing?.apiKey ?? "";
              } else if (apiKey && !this.envSecrets.isRef(apiKey)) {
                // Frontend sent a new plaintext key — store in .env, save reference
                const varName = EnvSecretManager.makeLLMKeyVar(result.id as string);
                this.envSecrets.set(varName, apiKey);
                result.apiKey = `\${${varName}}`;
              }
              // If it's already a ${VAR} reference, keep as-is
            }

            return result;
          });
          this.savedLLMProviders = processedProviders;
          this.persistLLMProviders(processedProviders);

          // Resolve references before applying
          const resolved = this.resolveLLMProviders(processedProviders);
          this.applyLLMProviders(resolved);
        }
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/config/image-gen", (_req: Request, res: Response) => {
      try {
        // API keys are ${VAR} references in JSON — safe to return directly
        // Add hasApiKey flag so frontend knows if a key is configured
        const providers = (this.savedImageGenProviders || []).map((p: Record<string, unknown>) => {
          const apiKey = p.apiKey as string | undefined;
          let hasApiKey = false;
          if (apiKey && !apiKey.includes("****")) {
            if (this.envSecrets.isRef(apiKey)) {
              const resolved = this.envSecrets.resolve(apiKey);
              hasApiKey = !!(resolved && typeof resolved === "string" && !resolved.includes("****"));
            } else {
              hasApiKey = true;
            }
          }
          return { ...p, hasApiKey };
        });
        res.json({ providers });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.put("/api/config/image-gen", (req: Request, res: Response) => {
      try {
        const { providers } = req.body || {};
        if (Array.isArray(providers)) {
          const existingProviders = this.savedImageGenProviders || [];
          const processedProviders = providers.map((p: Record<string, unknown>) => {
            const existing = existingProviders.find((e: Record<string, unknown>) => e.id === p.id);
            const result = { ...p };

            if (typeof result.apiKey === "string") {
              const apiKey = result.apiKey;
              if (apiKey.includes("****")) {
                // Frontend sent a masked key — keep the existing reference
                result.apiKey = existing?.apiKey ?? "";
              } else if (apiKey && !this.envSecrets.isRef(apiKey)) {
                // Frontend sent a new plaintext key — store in .env, save reference
                const varName = EnvSecretManager.makeImageGenKeyVar(result.id as string);
                this.envSecrets.set(varName, apiKey);
                result.apiKey = `\${${varName}}`;
              }
              // If it's already a ${VAR} reference, keep as-is
            }

            return result;
          });
          this.savedImageGenProviders = processedProviders;
          this.persistImageGenProviders(processedProviders);
        }
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/config/video-gen", (_req: Request, res: Response) => {
      try {
        // API keys are ${VAR} references in JSON — safe to return directly
        // Add hasApiKey flag so frontend knows if a key is configured
        const providers = (this.savedVideoGenProviders || []).map((p: Record<string, unknown>) => {
          const apiKey = p.apiKey as string | undefined;
          let hasApiKey = false;
          if (apiKey && !apiKey.includes("****")) {
            if (this.envSecrets.isRef(apiKey)) {
              const resolved = this.envSecrets.resolve(apiKey);
              hasApiKey = !!(resolved && typeof resolved === "string" && !resolved.includes("****"));
            } else {
              hasApiKey = true;
            }
          }
          return { ...p, hasApiKey };
        });
        res.json({ providers });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.put("/api/config/video-gen", (req: Request, res: Response) => {
      try {
        const { providers } = req.body || {};
        if (Array.isArray(providers)) {
          const existingProviders = this.savedVideoGenProviders || [];
          const processedProviders = providers.map((p: Record<string, unknown>) => {
            const existing = existingProviders.find((e: Record<string, unknown>) => e.id === p.id);
            const result = { ...p };

            if (typeof result.apiKey === "string") {
              const apiKey = result.apiKey;
              if (apiKey.includes("****")) {
                // Frontend sent a masked key — keep the existing reference
                result.apiKey = existing?.apiKey ?? "";
              } else if (apiKey && !this.envSecrets.isRef(apiKey)) {
                // Frontend sent a new plaintext key — store in .env, save reference
                const varName = EnvSecretManager.makeVideoGenKeyVar(result.id as string);
                this.envSecrets.set(varName, apiKey);
                result.apiKey = `\${${varName}}`;
              }
              // If it's already a ${VAR} reference, keep as-is
            }

            return result;
          });
          this.savedVideoGenProviders = processedProviders;
          this.persistVideoGenProviders(processedProviders);
        }
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/config/channels", (_req: Request, res: Response) => {
      // Channel secrets are now ${VAR} references — safe to return directly
      // Add has* flags so frontend knows which secrets are configured
      const channels = (this.savedChannels || []).map((ch: Record<string, unknown>) => {
        const result = { ...ch };
        for (const field of CHANNEL_SECRET_FIELDS) {
          const val = ch[field] as string | undefined;
          const hasKey = `has${field.charAt(0).toUpperCase()}${field.slice(1)}`;
          let configured = false;
          if (val && !val.includes("****")) {
            if (this.envSecrets.isRef(val)) {
              const resolved = this.envSecrets.resolve(val);
              configured = !!(resolved && typeof resolved === "string" && !resolved.includes("****"));
            } else {
              configured = true;
            }
          }
          (result as Record<string, unknown>)[hasKey] = configured;
        }
        return result;
      });
      res.json({ channels });
    });

    app.put("/api/config/channels", (req: Request, res: Response) => {
      const { channels } = req.body || {};
      if (Array.isArray(channels)) {
        const existingChannels = this.savedChannels || [];
        const processedChannels = channels.map((ch: Record<string, unknown>) => {
          const existing = existingChannels.find((e: Record<string, unknown>) => e.id === ch.id || e.type === ch.type);
          const result: Record<string, unknown> = existing ? { ...existing, ...ch } : { ...ch };

          // Preserve settings sub-object if it exists in existing but not in new
          if (existing?.settings && !ch.settings) {
            result.settings = existing.settings;
          }

          // Process sensitive fields: store plaintext in .env, save ${VAR} reference
          for (const field of CHANNEL_SECRET_FIELDS) {
            const val = result[field] as string | undefined;
            if (typeof val === "string") {
              if (val.includes("****")) {
                // Frontend sent a masked value — keep the existing reference
                result[field] = existing?.[field] ?? "";
              } else if (val && !this.envSecrets.isRef(val)) {
                // Frontend sent a new plaintext value — store in .env, save reference
                const varName = EnvSecretManager.makeChannelVar(ch.id as string, field);
                this.envSecrets.set(varName, val);
                result[field] = `\${${varName}}`;
              }
              // If it's already a ${VAR} reference, keep as-is
            }
          }

          return result;
        });
        this.savedChannels = processedChannels;
        this.persistChannels(processedChannels);

        // Resolve references before applying
        const resolved = this.resolveChannelConfigs(processedChannels);
        this.applyChannels(resolved);
      }
      res.json({ success: true });
    });

    app.post("/api/channels/:id/test", async (req: Request, res: Response) => {
      try {
        const channelId = String(req.params.id);
        const channelManager = this.registry.resolveService<{
          getAdapter(type: string): { healthCheck(): Promise<import("./channel-manager.js").ChannelHealthResult> } | undefined;
        }>("channelManager");
        if (!channelManager) {
          res.status(503).json({ status: "error", message: "Channel manager not available" });
          return;
        }
        const adapter = channelManager.getAdapter(channelId);
        if (!adapter) {
          res.status(404).json({ status: "error", message: `No adapter found for channel: ${channelId}. Please save the configuration first and ensure the channel is enabled.` });
          return;
        }
        const result = await adapter.healthCheck();
        res.json({
          status: result.healthy ? "ok" : "error",
          message: result.message,
          details: result.details,
          suggestions: result.suggestions,
        });
      } catch (err) {
        res.status(500).json({ status: "error", message: String(err) });
      }
    });

    app.get("/api/evolution/dashboard", async (_req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          getCycleHistory(): Promise<unknown[]>;
          getFeedbackHistory(): unknown[];
          getLearningStats(): unknown;
          getLearningEntries(filter?: Record<string, unknown>): unknown[];
          getLearningSessions(): unknown[];
          getActiveProgressReports(): unknown[];
        }>("evolutionEngine");
        if (!evolutionEngine) {
          res.json({ cycles: [], feedback: [], patterns: [], learning: null, summary: { totalCycles: 0, successRate: 0, avgEvaluationScore: 0, totalCandidates: 0 } });
          return;
        }
        const cycles = await evolutionEngine.getCycleHistory();
        const feedback = evolutionEngine.getFeedbackHistory();
        const learning = evolutionEngine.getLearningStats();
        const cycleList = cycles as Array<Record<string, unknown>>;

        // Get patterns from ExperienceAnalyzer
        const experienceAnalyzer = this.registry.resolveService<{
          getPatterns(): Array<{ id: string; type: string; category: string; description: string; confidence: number; frequency: number }>;
        }>("experienceAnalyzer");
        const rawPatterns = experienceAnalyzer?.getPatterns() || [];
        const patterns = rawPatterns.map((p) => ({
          name: p.category || p.type || p.id,
          count: p.frequency || 0,
          confidence: p.confidence || 0,
        }));

        // Map cycles to frontend-expected format
        const mappedCycles = cycleList.map((c) => {
          const candidatesGeneratedRaw = c.candidatesGenerated;
          const candidatesGenerated = Array.isArray(c.candidates) ? c.candidates.length : (typeof candidatesGeneratedRaw === "number" && Number.isFinite(candidatesGeneratedRaw) ? candidatesGeneratedRaw : 0);
          const candidatesPassedRaw = c.candidatesPassed;
          const candidatesPassed = Array.isArray(c.candidates) ? (c.candidates as unknown[]).filter((x) => (x as Record<string, unknown>)?.passed).length : (typeof candidatesPassedRaw === "number" && Number.isFinite(candidatesPassedRaw) ? candidatesPassedRaw : 0);
          const scoreRaw = (c.evaluation as Record<string, unknown>)?.score;
          const evalScoreRaw = c.evaluationScore;
          const score = typeof scoreRaw === "number" && Number.isFinite(scoreRaw) ? scoreRaw : 0;
          const evalScore = typeof evalScoreRaw === "number" && Number.isFinite(evalScoreRaw) ? evalScoreRaw : 0;
          return {
            id: String(c.id || ""),
            source: String(c.source || c.trigger || ""),
            status: String(c.status || "unknown"),
            startedAt: c.startedAt ? new Date(c.startedAt as string | number).toISOString() : "",
            completedAt: c.completedAt ? new Date(c.completedAt as string | number).toISOString() : null,
            duration: c.startedAt && c.completedAt
              ? new Date(c.completedAt as string | number).getTime() - new Date(c.startedAt as string | number).getTime()
              : 0,
            candidatesGenerated,
            candidatesPassed,
            evaluationScore: score || evalScore,
          };
        });

        res.json({
          cycles: mappedCycles,
          feedback,
          patterns,
          learning,
          summary: {
            totalCycles: cycleList.length,
            successRate: cycleList.length > 0
              ? cycleList.filter((c) => c.status === "completed").length / cycleList.length
              : 0,
            avgEvaluationScore: mappedCycles.length > 0
              ? mappedCycles.reduce((sum, c) => sum + c.evaluationScore, 0) / mappedCycles.length
              : 0,
            totalCandidates: mappedCycles.reduce((sum, c) => sum + c.candidatesGenerated, 0),
          },
        });
      } catch (err) {
        res.status(500).json({ cycles: [], feedback: [], patterns: [], learning: null, summary: { totalCycles: 0, successRate: 0, avgEvaluationScore: 0, totalCandidates: 0 } });
      }
    });

    app.get("/api/evolution/learning/stats", async (_req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          getLearningStats(): unknown;
        }>("evolutionEngine");
        if (!evolutionEngine) {
          res.json({ totalEntries: 0, resolvedEntries: 0, unresolvedEntries: 0, resolutionRate: 0 });
          return;
        }
        res.json(evolutionEngine.getLearningStats());
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/evolution/learning/entries", async (req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          getLearningEntries(filter?: Record<string, unknown>): unknown[];
        }>("evolutionEngine");
        if (!evolutionEngine) { res.json([]); return; }
        const filter: Record<string, unknown> = {};
        if (req.query.trigger) filter.trigger = String(req.query.trigger);
        if (req.query.category) filter.category = String(req.query.category);
        if (req.query.resolved !== undefined) filter.resolved = req.query.resolved === "true";
        if (req.query.severity) filter.severity = String(req.query.severity);
        if (req.query.source) filter.source = String(req.query.source);
        if (req.query.tags) filter.tags = String(req.query.tags).split(",");
        if (req.query.limit) filter.limit = Math.max(1, Math.min(parseInt(String(req.query.limit), 10) || 50, 1000));
        if (req.query.offset) filter.offset = Math.max(0, parseInt(String(req.query.offset), 10) || 0);
        res.json(evolutionEngine.getLearningEntries(filter));
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/evolution/learning/sessions", async (_req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          getLearningSessions(): unknown[];
        }>("evolutionEngine");
        if (!evolutionEngine) { res.json([]); return; }
        res.json(evolutionEngine.getLearningSessions());
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/evolution/progress/active", async (_req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          getActiveProgressReports(): unknown[];
        }>("evolutionEngine");
        if (!evolutionEngine) { res.json([]); return; }
        res.json(evolutionEngine.getActiveProgressReports());
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/evolution/learning/correction", async (req: Request, res: Response) => {
      try {
        const { title, context, originalError, correction, preferredApproach, source, tags, triggerEvolution } = req.body || {};
        this.eventBus.publish("user.correction_received", {
          title, context, originalError, correction, preferredApproach,
          source: source || "api", tags, triggerEvolution,
          taskId: `correction-${Date.now()}`,
          description: title || context,
        }, "protocol-adapter").catch(() => { /* EventBus 内部已 allSettled，此处兜底 */ });
        res.status(202).json({ status: "recorded", message: "Correction learning entry created" });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/evolution/learning/gap", async (req: Request, res: Response) => {
      try {
        const { capability, title, context, suggestedSolution, source, tags, triggerEvolution } = req.body || {};
        this.eventBus.publish("capability.gap_detected", {
          capability, title: title || capability, context, suggestedSolution,
          source: source || "api", tags, triggerEvolution,
          taskId: `gap-${Date.now()}`,
          description: context || `缺少能力: ${capability || ""}`,
        }, "protocol-adapter");
        res.status(202).json({ status: "recorded", message: "Capability gap recorded" });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/evolution/learning/failure", async (req: Request, res: Response) => {
      try {
        const { service, endpoint, error: errorMsg, context, rootCause, fallback, fallbackCode, source, severity, tags, triggerEvolution } = req.body || {};
        this.eventBus.publish("external.failure_detected", {
          service, endpoint, error: errorMsg, context, rootCause, fallback, fallbackCode,
          source: source || "api", severity, tags, triggerEvolution,
          taskId: `failure-${Date.now()}`,
          description: context || `外部依赖失败: ${service || endpoint || ""}`,
        }, "protocol-adapter").catch(() => { /* EventBus 内部已 allSettled，此处兜底 */ });
        res.status(202).json({ status: "recorded", message: "External failure recorded" });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/evolution/learning/improvement", async (req: Request, res: Response) => {
      try {
        const { title, description, context, isOutdated, newApproach, recommendedAction, improvedCode, source, tags, triggerEvolution } = req.body || {};
        this.eventBus.publish("knowledge.improvement_found", {
          title, description, context, isOutdated, newApproach, recommendedAction, improvedCode,
          source: source || "api", tags, triggerEvolution,
          taskId: `improvement-${Date.now()}`,
        }, "protocol-adapter").catch(() => { /* EventBus 内部已 allSettled，此处兜底 */ });
        res.status(202).json({ status: "recorded", message: "Knowledge improvement recorded" });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/evolution/trigger", async (req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          triggerManualEvolution(targetSkill: string | null, description: string, source?: string): Promise<{ id: string; status: string; source: string; startedAt: Date }>;
        }>("evolutionEngine");
        if (!evolutionEngine) {
          res.status(503).json({ error: "Evolution engine not available" });
          return;
        }
        const { targetSkill, description, source } = req.body || {};
        const effectiveDescription = description || `Manual evolution triggered at ${new Date().toISOString()}`;
        const cycle = await evolutionEngine.triggerManualEvolution(
          targetSkill || null,
          effectiveDescription,
          source
        );
        res.json({ success: true, cycle: { id: cycle.id, status: cycle.status, source: cycle.source, startedAt: cycle.startedAt } });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/evolution/trigger-skill", async (req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          triggerSkillEvolution(skillId: string, skillName: string, errorInfo?: string): Promise<{ id: string; status: string; source: string; startedAt: Date }>;
        }>("evolutionEngine");
        if (!evolutionEngine) {
          res.status(503).json({ error: "Evolution engine not available" });
          return;
        }
        const { skillId, skillName, errorInfo } = req.body || {};
        if (!skillId || !skillName) {
          res.status(400).json({ error: "skillId and skillName are required" });
          return;
        }
        const cycle = await evolutionEngine.triggerSkillEvolution(skillId, skillName, errorInfo);
        res.json({ success: true, cycle: { id: cycle.id, status: cycle.status, source: cycle.source, startedAt: cycle.startedAt } });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/evolution/feedback", async (req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          submitUserFeedback(cycleId: string, adopted: boolean, comment?: string): Promise<void>;
        }>("evolutionEngine");
        if (!evolutionEngine) {
          res.status(503).json({ error: "Evolution engine not available" });
          return;
        }
        const { cycleId, adopted, comment } = req.body || {};
        if (!cycleId || adopted === undefined) {
          res.status(400).json({ error: "cycleId and adopted are required" });
          return;
        }
        await evolutionEngine.submitUserFeedback(cycleId, adopted, comment);
        res.json({ success: true, message: "Feedback recorded" });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/evolution/stats", async (_req: Request, res: Response) => {
      try {
        const evolutionEngine = this.registry.resolveService<{
          getEvolutionStats(): Record<string, unknown>;
        }>("evolutionEngine");
        if (!evolutionEngine) {
          res.status(503).json({ error: "Evolution engine not available" });
          return;
        }
        res.json(evolutionEngine.getEvolutionStats());
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/system/audit", async (req: Request, res: Response) => {
      try {
        const auditCenter = this.registry.resolveService<{
          query(query: Record<string, unknown>): { records: unknown[]; total: number };
          getStatistics(): unknown;
          getAlerts(acknowledged?: boolean): unknown[];
        }>("auditCenter");
        if (!auditCenter) {
          res.status(503).json({ error: "Audit center not available" });
          return;
        }
        const stats = auditCenter.getStatistics();
        const alerts = auditCenter.getAlerts(false);
        res.json({ stats, alerts });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/persona/greeting", (_req: Request, res: Response) => {
      try {
        const executor = this.registry.resolveService<{
          getGreeting(): string | null;
          getPersona(): { name: string; title: string; masterTerm: string; tone: string };
          hasBeenGreeted(): boolean;
        }>("agentModelExecutor");
        if (!executor) {
          res.json({
            greeting: "您好主人！我是 EvoClaw小助手 您的专属EvoClaw智能助理 🧬\n\n很高兴为您服务！有什么需要，随时吩咐我！",
            name: "EvoClaw小助手",
            masterTerm: "主人",
            isFirstSession: true,
          });
          return;
        }
        const greeting = executor.getGreeting();
        const persona = executor.getPersona();
        res.json({
          greeting: greeting || "",
          name: persona.name,
          masterTerm: persona.masterTerm,
          isFirstSession: greeting !== null,
        });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/permission/approve", async (req: Request, res: Response) => {
      try {
        const { requestId, whitelist } = req.body || {};
        if (!requestId) {
          res.status(400).json({ error: "requestId is required" });
          return;
        }

        const permMgr = this.registry.resolveService<{
          approveRequest(id: string, addToWhitelist?: boolean): { id: string; operation: string; target: string; status: string } | undefined;
          denyRequest(id: string): { id: string; operation: string; target: string; status: string } | undefined;
          getPendingRequests(): Array<{ id: string; operation: string; target: string; description: string; status: string }>;
          addToWhitelist(operation: string, target: string): unknown;
          removeFromWhitelist(operation: string, target: string): boolean;
          getWhitelist(): Array<{ operation: string; targetPattern: string; createdAt: Date }>;
        }>("permissionManager");

        if (!permMgr) {
          res.status(503).json({ error: "Permission manager not available" });
          return;
        }

        const result = permMgr.approveRequest(String(requestId), whitelist === true);
        if (!result) {
          res.status(404).json({ error: "Request not found or already processed" });
          return;
        }

        // Sync to PermissionRelay so the Permissions page shows the decision
        const permRelay = this.registry.resolveService<{
          approve(id: string, by?: string): unknown;
          deny(id: string, reason?: string, by?: string): unknown;
        }>("permissionRelay");
        if (permRelay) {
          permRelay.approve(String(requestId), "webui");
        }

        res.json({ success: true, request: result });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/permission/deny", async (req: Request, res: Response) => {
      try {
        const { requestId } = req.body || {};
        if (!requestId) {
          res.status(400).json({ error: "requestId is required" });
          return;
        }

        const permMgr = this.registry.resolveService<{
          denyRequest(id: string): { id: string; operation: string; target: string; status: string } | undefined;
          getPendingRequests(): Array<{ id: string; operation: string; target: string; description: string; status: string }>;
        }>("permissionManager");

        if (!permMgr) {
          res.status(503).json({ error: "Permission manager not available" });
          return;
        }

        const result = permMgr.denyRequest(String(requestId));
        if (!result) {
          res.status(404).json({ error: "Request not found or already processed" });
          return;
        }

        // Sync to PermissionRelay so the Permissions page shows the decision
        const permRelay = this.registry.resolveService<{
          approve(id: string, by?: string): unknown;
          deny(id: string, reason?: string, by?: string): unknown;
        }>("permissionRelay");
        if (permRelay) {
          permRelay.deny(String(requestId), "Denied from Web UI", "webui");
        }

        res.json({ success: true, request: result });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/permission/requests", async (_req: Request, res: Response) => {
      try {
        const permMgr = this.registry.resolveService<{
          getPendingRequests(): Array<{ id: string; operation: string; target: string; description: string; status: string }>;
        }>("permissionManager");

        if (!permMgr) {
          res.json({ requests: [] });
          return;
        }

        res.json({ requests: permMgr.getPendingRequests() });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/permission/whitelist", async (_req: Request, res: Response) => {
      try {
        const permMgr = this.registry.resolveService<{
          getWhitelist(): Array<{ operation: string; targetPattern: string; createdAt: Date }>;
        }>("permissionManager");

        if (!permMgr) {
          res.json({ whitelist: [] });
          return;
        }

        res.json({ whitelist: permMgr.getWhitelist() });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.delete("/api/permission/whitelist", async (req: Request, res: Response) => {
      try {
        const { operation, target } = req.body || {};
        if (!operation || !target) {
          res.status(400).json({ error: "operation and target are required" });
          return;
        }

        const permMgr = this.registry.resolveService<{
          removeFromWhitelist(operation: string, target: string): boolean;
        }>("permissionManager");

        if (!permMgr) {
          res.status(503).json({ error: "Permission manager not available" });
          return;
        }

        const removed = permMgr.removeFromWhitelist(String(operation), String(target));
        res.json({ success: removed });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // 新增白名单条目。支持两种负载：
    //   1. { path, permissions } —— allowlist add 单条（CLI 兼容）
    //   2. { entries: [{ operation, target }] } 或顶层数组 —— 批量导入（policy 文件）
    app.post("/api/permission/whitelist", async (req: Request, res: Response) => {
      try {
        const permMgr = this.registry.resolveService<{
          addToWhitelist(operation: string, target: string): unknown;
        }>("permissionManager");

        if (!permMgr) {
          res.status(503).json({ error: "Permission manager not available" });
          return;
        }

        const body = req.body || {};
        const entries: Array<{ operation: string; target: string }> = [];
        if (typeof body.path === "string" && typeof body.permissions === "string") {
          entries.push({ operation: body.permissions, target: body.path });
        } else if (Array.isArray(body)) {
          for (const e of body) {
            if (e && typeof e.operation === "string" && typeof e.target === "string") {
              entries.push({ operation: e.operation, target: e.target });
            }
          }
        } else if (Array.isArray(body.entries)) {
          for (const e of body.entries) {
            if (e && typeof e.operation === "string" && typeof e.target === "string") {
              entries.push({ operation: e.operation, target: e.target });
            }
          }
        }

        if (entries.length === 0) {
          res.status(400).json({ error: "path and permissions (or entries[]) are required" });
          return;
        }

        let added = 0;
        for (const e of entries) {
          permMgr.addToWhitelist(e.operation, e.target);
          added++;
        }
        res.json({ success: true, added });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/cli/execute", async (req: Request, res: Response) => {
      try {
        const { command } = req.body || {};
        if (!command || typeof command !== "string") {
          res.status(400).json({ error: "Command is required" });
          return;
        }

        const validation = validateCliCommand(command);
        if (!validation.valid) {
          res.status(400).json({ error: validation.reason || "Invalid command" });
          return;
        }

        const startTime = Date.now();
        const result = await executeCliCommand(command);
        const duration = Date.now() - startTime;

        if (result.timedOut) {
          res.json({
            success: false,
            output: result.stdout || result.stderr || "",
            error: result.stderr || "Command timed out after 30 seconds",
            exitCode: -1,
            duration,
            timedOut: true,
          });
          return;
        }

        res.json({
          success: result.exitCode === 0,
          output: result.stdout || result.stderr || "",
          error: result.exitCode !== 0 ? (result.stderr || `Command exited with code ${result.exitCode}`) : null,
          exitCode: result.exitCode,
          duration,
          timedOut: false,
        });
      } catch (err) {
        this.handleError(err, res, "CLI execution failed");
      }
    });

    // ─── Plugin API routes ──────────────────────────────────────────────────

    app.get("/api/plugins", async (_req: Request, res: Response) => {
      try {
        const pluginManager = this.registry.resolveService("pluginManager") as { getPlugins(): Array<{ manifest: { name: string; version: string; description: string; author?: string }; status: string; error?: string }> } | undefined;
        const localizationService = this.registry.resolveService<{
          needsChineseTranslation(text: string): boolean;
          translateToChinese(text: string, context?: string): Promise<string>;
        }>("localizationService");

        const plugins = pluginManager?.getPlugins() ?? [];

        const enrichedPlugins = await Promise.all(plugins.map(async (p) => {
          const result: Record<string, unknown> = {
            manifest: p.manifest,
            status: p.status,
            error: p.error,
          };

          if (localizationService && p.manifest.description && localizationService.needsChineseTranslation(p.manifest.description)) {
            try {
              const description_zh = await localizationService.translateToChinese(p.manifest.description, `插件"${p.manifest.name}"的描述`);
              if (description_zh && description_zh !== p.manifest.description) {
                result.i18n = { description_zh, translatedAt: new Date().toISOString() };
              }
            } catch (err) { console.debug("[ProtocolAdapter]", err instanceof Error ? err.message : String(err)); }
          }

          return result;
        }));

        res.json({
          success: true,
          plugins: enrichedPlugins,
        });
      } catch (err) {
        this.handleError(err, res, "Failed to list plugins");
      }
    });

    app.post("/api/plugins/install", async (req: Request, res: Response) => {
      try {
        let { name, version, source } = req.body;
        if (!name) {
          res.status(400).json({ success: false, error: "Plugin name is required" });
          return;
        }

        // Strip @tag suffix from name if present (e.g. "@scope/pkg@latest" → "@scope/pkg")
        const lastAt = name.lastIndexOf("@");
        if (lastAt > 0 && !name.slice(0, lastAt).endsWith("/")) {
          const possibleTag = name.slice(lastAt + 1);
          if (/^[a-zA-Z0-9._-]+$/.test(possibleTag)) {
            name = name.slice(0, lastAt);
          }
        }

        const pluginManager = this.registry.resolveService("pluginManager") as {
          registerPlugin(plugin: unknown): Promise<void>;
          getPlugins(): Array<{ manifest: { name: string; version: string; description: string }; status: string; error?: string }>;
        } | undefined;

        if (!pluginManager) {
          res.status(503).json({ error: "Plugin manager not available" });
          return;
        }

        // Try to dynamically import built-in plugin
        try {
          const { BUILTIN_PLUGIN_FACTORIES } = await import("@evoclaw/agent/plugins");
          const factory = BUILTIN_PLUGIN_FACTORIES.find((f: () => { manifest: { name: string } }) => {
            try { return f().manifest.name.toLowerCase() === name.toLowerCase(); } catch (err) { console.debug("[ProtocolAdapter]", err instanceof Error ? err.message : String(err)); return false; }
          });
          if (factory) {
            const plugin = factory();
            await pluginManager.registerPlugin(plugin);
            res.json({ success: true, message: `Plugin "${plugin.manifest.name}" installed`, plugin: { name: plugin.manifest.name, version: plugin.manifest.version } });
            return;
          }
        } catch {
          // Dynamic import may fail if @evoclaw/agent is not built
        }

        // Fallback: create a minimal stub plugin for community/third-party plugins
        // This allows any plugin name to be installed as a lightweight passthrough
        const existing = pluginManager.getPlugins().find((p) => p.manifest.name.toLowerCase() === name.toLowerCase());
        if (existing) {
          res.json({ success: true, message: `Plugin "${name}" is already installed`, plugin: { name: existing.manifest.name, version: existing.manifest.version } });
          return;
        }

        const stubPlugin = {
          manifest: {
            name,
            version: version || "0.1.0",
            description: `${name} — community plugin`,
            author: source || "community",
          },
          hooks: [],
          async init() {
            process.stdout.write(`[PluginManager] Community plugin "${name}" initialized (stub)\n`);
          },
          async shutdown() {},
          async healthCheck() {
            return { healthy: true, message: "Active (community stub)" };
          },
        };
        await pluginManager.registerPlugin(stubPlugin);
        res.json({ success: true, message: `Plugin "${name}" installed (community)`, plugin: { name, version: version || "0.1.0" } });
      } catch (err) {
        this.handleError(err, res, "Failed to install plugin");
      }
    });

    // List available built-in plugins (not yet installed)
    // Derives from BUILTIN_PLUGIN_FACTORIES manifest, excluding already-installed ones.
    app.get("/api/plugins/available", async (_req: Request, res: Response) => {
      try {
        const pluginManager = this.registry.resolveService("pluginManager") as {
          getPlugins(): Array<{ manifest: { name: string; version: string; description: string; author?: string }; status: string; error?: string }>;
        } | undefined;
        const installedNames = new Set(
          (pluginManager?.getPlugins() ?? []).map(p => p.manifest.name.toLowerCase())
        );

        // Load BUILTIN_PLUGIN_FACTORIES dynamically (avoids hard dependency in gateway)
        let available: Array<{ id: string; name: string; version: string; description: string; author: string; installed: boolean }> = [];
        try {
          const mod = await import("@evoclaw/agent/plugins");
          const factories: Array<() => { manifest: { name: string; version: string; description: string; author?: string } }> = mod.BUILTIN_PLUGIN_FACTORIES || [];
          available = factories.map(factory => {
            const plugin = factory();
            const m = plugin.manifest;
            return {
              id: m.name.toLowerCase().replace(/\s+/g, "-"),
              name: m.name,
              version: m.version,
              description: m.description,
              author: m.author || "evoclaw",
              installed: installedNames.has(m.name.toLowerCase()),
            };
          });
        } catch {
          // If agent package not available, return empty list
        }

        res.json({ success: true, available });
      } catch (err) {
        this.handleError(err, res, "Failed to list available plugins");
      }
    });

    app.delete("/api/plugins/:name", async (req: Request, res: Response) => {
      try {
        const name = String(req.params.name);
        const pluginManager = this.registry.resolveService("pluginManager") as { unregisterPlugin(name: string): Promise<void> } | undefined;
        if (pluginManager) {
          await pluginManager.unregisterPlugin(name);
        }
        res.json({ success: true, message: `Plugin "${name}" removed` });
      } catch (err) {
        this.handleError(err, res, "Failed to remove plugin");
      }
    });

    app.post("/api/plugins/:name/toggle", (req: Request, res: Response) => {
      try {
        const name = String(req.params.name);
        const { status } = req.body;
        if (status !== "enabled" && status !== "disabled") {
          res.status(400).json({ error: "Invalid status, must be 'enabled' or 'disabled'" });
          return;
        }
        const pluginManager = this.registry.resolveService("pluginManager") as { setPluginStatus(name: string, status: "active" | "disabled"): void } | undefined;
        if (pluginManager) {
          pluginManager.setPluginStatus(name, status === "enabled" ? "active" : "disabled");
        }
        res.json({ success: true, name, status });
      } catch (err) {
        this.handleError(err, res, "Failed to toggle plugin");
      }
    });

    // ─── Scheduler / Cron API routes ────────────────────────────────────────

    app.get("/api/scheduler/tasks", (_req: Request, res: Response) => {
      try {
        const scheduleManager = this.registry.resolveService("scheduleManager") as {
          listTasks(): Array<Record<string, unknown>>;
          getStats(): Record<string, unknown>;
        } | undefined;
        if (!scheduleManager) {
          res.json({ tasks: [], stats: { totalTasks: 0, activeTasks: 0, totalRuns: 0, totalErrors: 0 } });
          return;
        }
        const tasks = scheduleManager.listTasks();
        const stats = scheduleManager.getStats();
        res.json({ success: true, tasks, stats });
      } catch (err) {
        this.handleError(err, res, "Failed to list scheduler tasks");
      }
    });

    app.post("/api/scheduler/tasks", (req: Request, res: Response) => {
      try {
        const scheduleManager = this.registry.resolveService("scheduleManager") as {
          createTask(opts: {
            name: string;
            cronExpression: string;
            description?: string;
            handlerType: string;
            handlerConfig?: Record<string, unknown>;
            enabled?: boolean;
          }): Record<string, unknown>;
        } | undefined;
        if (!scheduleManager) {
          res.status(503).json({ error: "Scheduler not available" });
          return;
        }

        const { name, cronExpression, description, handlerType, enabled } = req.body || {};
        if (!name || !cronExpression) {
          res.status(400).json({ error: "name and cronExpression are required" });
          return;
        }
        if (/[;|$`&\n\r]/.test(cronExpression)) {
          res.status(400).json({ error: "cronExpression contains invalid characters" });
          return;
        }

        // Map Web UI handler types to ScheduleManager handler types
        const handlerTypeMap: Record<string, string> = {
          system: "system_cleanup",
          skills: "custom",
          memory: "custom",
          chat: "custom",
          email_check: "email_check",
          report_generate: "report_generate",
          browser_action: "browser_action",
          system_cleanup: "system_cleanup",
          custom: "custom",
        };
        const mappedHandlerType = handlerTypeMap[handlerType] || "custom";

        const task = scheduleManager.createTask({
          name,
          cronExpression,
          description: description || "",
          handlerType: mappedHandlerType as "email_check" | "report_generate" | "browser_action" | "system_cleanup" | "custom",
          enabled: enabled !== false,
        });

        res.status(201).json({ success: true, task });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
      }
    });

    app.put("/api/scheduler/tasks/:taskId", (req: Request, res: Response) => {
      try {
        const scheduleManager = this.registry.resolveService("scheduleManager") as {
          updateTask(taskId: string, updates: Record<string, unknown>): Record<string, unknown> | null;
        } | undefined;
        if (!scheduleManager) {
          res.status(503).json({ error: "Scheduler not available" });
          return;
        }

        const taskId = String(req.params.taskId);
        const updates: Record<string, unknown> = {};
        if (req.body.name !== undefined) updates.name = req.body.name;
        if (req.body.cronExpression !== undefined) updates.cronExpression = req.body.cronExpression;
        if (req.body.description !== undefined) updates.description = req.body.description;
        if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;

        const result = scheduleManager.updateTask(taskId, updates);
        if (!result) {
          res.status(404).json({ error: "Task not found" });
          return;
        }
        res.json({ success: true, task: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
      }
    });

    app.delete("/api/scheduler/tasks/:taskId", (req: Request, res: Response) => {
      try {
        const scheduleManager = this.registry.resolveService("scheduleManager") as {
          deleteTask(taskId: string): boolean;
        } | undefined;
        if (!scheduleManager) {
          res.status(503).json({ error: "Scheduler not available" });
          return;
        }

        const taskId = String(req.params.taskId);
        const removed = scheduleManager.deleteTask(taskId);
        if (!removed) {
          res.status(404).json({ error: "Task not found" });
          return;
        }
        res.json({ success: true });
      } catch (err) {
        this.handleError(err, res, "Failed to delete task");
      }
    });

    app.post("/api/scheduler/tasks/:taskId/run", async (req: Request, res: Response) => {
      try {
        const scheduleManager = this.registry.resolveService("scheduleManager") as {
          executeTask(taskId: string): Promise<Record<string, unknown>>;
        } | undefined;
        if (!scheduleManager) {
          res.status(503).json({ error: "Scheduler not available" });
          return;
        }

        const taskId = String(req.params.taskId);
        const result = await scheduleManager.executeTask(taskId);
        res.json({ success: result.success, result });
      } catch (err) {
        this.handleError(err, res, "Failed to execute task");
      }
    });

    app.get("/api/scheduler/history", (req: Request, res: Response) => {
      try {
        const scheduleManager = this.registry.resolveService("scheduleManager") as {
          getRunHistory(taskId?: string, limit?: number): Array<Record<string, unknown>>;
        } | undefined;
        if (!scheduleManager) {
          res.json({ history: [] });
          return;
        }
        const taskId = req.query.taskId as string | undefined;
        const limit = parseInt(String(req.query.limit || "20"), 10) || 20;
        const history = scheduleManager.getRunHistory(taskId, limit);
        res.json({ success: true, history });
      } catch (err) {
        this.handleError(err, res, "Failed to get scheduler history");
      }
    });

    // ─── Session API routes ─────────────────────────────────────────────────

    app.get("/api/sessions", (_req: Request, res: Response) => {
      try {
        const sessionManager = this.registry.resolveService("sessionManager") as {
          listAgents(): string[];
          listSessions(agentId: string): Array<{ sessionId: string; agentId: string; status: string; turnCount: number; createdAt: string; updatedAt: string }>;
        } | undefined;

        if (!sessionManager) {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.json({ success: true, sessions: [] });
          return;
        }

        const agents = sessionManager.listAgents();
        const allSessions: unknown[] = [];
        for (const agentId of agents) {
          const sessions = sessionManager.listSessions(agentId);
          for (const s of sessions) {
            allSessions.push(s);
          }
        }

        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.json({ success: true, sessions: allSessions });
      } catch (err) {
        this.handleError(err, res, "Failed to list sessions");
      }
    });

    app.get("/api/sessions/:agentId/:sessionId", (req: Request, res: Response) => {
      try {
        const agentId = String(req.params.agentId);
        const sessionId = String(req.params.sessionId);
        const sessionManager = this.registry.resolveService("sessionManager") as {
          loadSession(agentId: string, sessionId: string): { session: Record<string, unknown>; turns: Array<Record<string, unknown>>; predecessorId?: string; successorId?: string } | null;
        } | undefined;

        if (!sessionManager) {
          res.status(404).json({ success: false, error: "Session manager not available" });
          return;
        }

        const result = sessionManager.loadSession(agentId, sessionId);
        if (!result) {
          res.status(404).json({ success: false, error: "Session not found" });
          return;
        }

        res.json({ success: true, ...result });
      } catch (err) {
        this.handleError(err, res, "Failed to load session");
      }
    });

    app.post("/api/sessions", (req: Request, res: Response) => {
      try {
        const { agentId, sessionId } = req.body;
        const sessionManager = this.registry.resolveService("sessionManager") as {
          createSession(agentId: string, options?: { sessionId?: string }): Record<string, unknown>;
        } | undefined;

        if (!sessionManager) {
          res.status(500).json({ success: false, error: "Session manager not available" });
          return;
        }

        const session = sessionManager.createSession(agentId ?? "default", { sessionId });
        res.json({ success: true, session });
      } catch (err) {
        this.handleError(err, res, "Failed to create session");
      }
    });

    // 重命名会话（更新 customName）
    app.patch("/api/sessions/:agentId/:sessionId", (req: Request, res: Response) => {
      try {
        const agentId = String(req.params.agentId);
        const sessionId = String(req.params.sessionId);
        const sessionManager = this.registry.resolveService("sessionManager") as {
          loadSessionMeta(agentId: string, sessionId: string): import("@evoclaw/agent").SessionInfo | null;
          updateSessionMeta(session: import("@evoclaw/agent").SessionInfo): void;
        } | undefined;

        if (!sessionManager) {
          res.status(500).json({ success: false, error: "Session manager not available" });
          return;
        }

        const session = sessionManager.loadSessionMeta(agentId, sessionId);
        if (!session) {
          res.status(404).json({ success: false, error: "Session not found" });
          return;
        }

        const body = req.body as { customName?: string };
        if (body.customName !== undefined) {
          session.customName = body.customName.trim() || undefined;
        }
        sessionManager.updateSessionMeta(session);
        res.json({ success: true, session });
      } catch (err) {
        this.handleError(err, res, "Failed to rename session");
      }
    });

    app.delete("/api/sessions/:agentId/:sessionId", (req: Request, res: Response) => {
      try {
        const agentId = String(req.params.agentId);
        const sessionId = String(req.params.sessionId);
        const sessionManager = this.registry.resolveService("sessionManager") as {
          deleteSession(agentId: string, sessionId: string): boolean;
        } | undefined;

        if (!sessionManager) {
          res.status(500).json({ success: false, error: "Session manager not available" });
          return;
        }

        const success = sessionManager.deleteSession(agentId, sessionId);
        if (success) {
          // 清理 executor 中的会话级缓存（conversationHistory/iterationBudgets 等），防止 Map 无限增长
          const executor = this.registry.resolveService<{ clearChatHistory(sessionId?: string): void }>("agentModelExecutor");
          try { executor?.clearChatHistory(sessionId); } catch { /* ignore */ }
          res.json({ success: true, message: "Session deleted successfully" });
        } else {
          res.status(404).json({ success: false, error: "Session not found" });
        }
      } catch (err) {
        this.handleError(err, res, "Failed to delete session");
      }
    });

    // ─── Queue API routes ──────────────────────────────────────────────────

    app.get("/api/queue/:sessionId", (req: Request, res: Response) => {
      try {
        const sessionId = String(req.params.sessionId);
        const queueManager = this.registry.resolveService("queueManager") as {
          getQueue(sessionId: string): Array<Record<string, unknown>>;
        } | undefined;

        if (!queueManager) {
          res.status(503).json({ success: false, error: "Queue manager not available" });
          return;
        }

        const queue = queueManager.getQueue(sessionId);
        res.json({ success: true, queue });
      } catch (err) {
        this.handleError(err, res, "Failed to get queue");
      }
    });

    app.get("/api/queue", (_req: Request, res: Response) => {
      try {
        const queueManager = this.registry.resolveService("queueManager") as {
          getQueue(sessionId: string): Array<Record<string, unknown>>;
          getAllSessions(): string[];
        } | undefined;

        if (!queueManager) {
          res.json({ success: true, sessions: [] });
          return;
        }

        const sessionIds = queueManager.getAllSessions();
        const allQueues: Record<string, Array<Record<string, unknown>>> = {};
        for (const sid of sessionIds) {
          allQueues[sid] = queueManager.getQueue(sid);
        }
        res.json({ success: true, sessions: allQueues });
      } catch (err) {
        this.handleError(err, res, "Failed to get all queues");
      }
    });

    app.post("/api/queue/enqueue", (req: Request, res: Response) => {
      try {
        const { sessionId, message, mode } = req.body || {};
        if (!sessionId || !message) {
          res.status(400).json({ success: false, error: "sessionId and message are required" });
          return;
        }

        const queueManager = this.registry.resolveService("queueManager") as {
          enqueue(sessionId: string, message: string, mode?: string): Record<string, unknown>;
          getQueue(sessionId: string): Array<Record<string, unknown>>;
        } | undefined;

        if (!queueManager) {
          res.status(503).json({ success: false, error: "Queue manager not available" });
          return;
        }

        // Check queue size limit (10 max)
        const queue = queueManager.getQueue(sessionId);
        if (queue.length >= 10) {
          res.status(429).json({ success: false, error: "Queue is full (max 10 messages)" });
          return;
        }

        const item = queueManager.enqueue(sessionId, String(message), mode || "followup");
        res.json({ success: true, item });
      } catch (err) {
        this.handleError(err, res, "Failed to enqueue message");
      }
    });

    app.post("/api/queue/dequeue", (req: Request, res: Response) => {
      try {
        const { sessionId } = req.body || {};
        if (!sessionId) {
          res.status(400).json({ success: false, error: "sessionId is required" });
          return;
        }

        const queueManager = this.registry.resolveService("queueManager") as {
          dequeue(sessionId: string): Record<string, unknown> | undefined;
        } | undefined;

        if (!queueManager) {
          res.status(503).json({ success: false, error: "Queue manager not available" });
          return;
        }

        const item = queueManager.dequeue(sessionId);
        if (!item) {
          res.json({ success: true, item: null });
          return;
        }
        res.json({ success: true, item });
      } catch (err) {
        this.handleError(err, res, "Failed to dequeue message");
      }
    });

    app.post("/api/queue/mark-done", (req: Request, res: Response) => {
      try {
        const { itemId, result } = req.body || {};
        if (!itemId) {
          res.status(400).json({ success: false, error: "itemId is required" });
          return;
        }

        const queueManager = this.registry.resolveService("queueManager") as {
          markDone(itemId: string, result?: string): void;
        } | undefined;

        if (!queueManager) {
          res.status(503).json({ success: false, error: "Queue manager not available" });
          return;
        }

        queueManager.markDone(itemId, result);
        res.json({ success: true });
      } catch (err) {
        this.handleError(err, res, "Failed to mark item as done");
      }
    });

    app.delete("/api/queue/:itemId", (req: Request, res: Response) => {
      try {
        const itemId = String(req.params.itemId);
        const queueManager = this.registry.resolveService("queueManager") as {
          removeItem(itemId: string): boolean;
        } | undefined;

        if (!queueManager) {
          res.status(503).json({ success: false, error: "Queue manager not available" });
          return;
        }

        const removed = queueManager.removeItem(itemId);
        if (!removed) {
          res.status(404).json({ success: false, error: "Queue item not found" });
          return;
        }
        res.json({ success: true });
      } catch (err) {
        this.handleError(err, res, "Failed to delete queue item");
      }
    });

    app.put("/api/queue/reorder", (req: Request, res: Response) => {
      try {
        const { sessionId, orderedIds } = req.body || {};
        if (!sessionId || !Array.isArray(orderedIds)) {
          res.status(400).json({ success: false, error: "sessionId and orderedIds (array) are required" });
          return;
        }

        const queueManager = this.registry.resolveService("queueManager") as {
          reorderItems(sessionId: string, orderedIds: string[]): boolean;
        } | undefined;

        if (!queueManager) {
          res.status(503).json({ success: false, error: "Queue manager not available" });
          return;
        }

        const ok = queueManager.reorderItems(sessionId, orderedIds);
        res.json({ success: ok });
      } catch (err) {
        this.handleError(err, res, "Failed to reorder queue");
      }
    });

    app.put("/api/queue/move", (req: Request, res: Response) => {
      try {
        const { sessionId, itemId, direction } = req.body || {};
        if (!sessionId || !itemId || !direction) {
          res.status(400).json({ success: false, error: "sessionId, itemId, and direction are required" });
          return;
        }

        const queueManager = this.registry.resolveService("queueManager") as {
          moveItem(sessionId: string, itemId: string, direction: "up" | "down"): boolean;
        } | undefined;

        if (!queueManager) {
          res.status(503).json({ success: false, error: "Queue manager not available" });
          return;
        }

        const ok = queueManager.moveItem(sessionId, itemId, direction);
        res.json({ success: ok });
      } catch (err) {
        this.handleError(err, res, "Failed to move queue item");
      }
    });

    app.put("/api/queue/:itemId", (req: Request, res: Response) => {
      try {
        const itemId = String(req.params.itemId);
        const { message } = req.body || {};
        if (!message) {
          res.status(400).json({ success: false, error: "message is required" });
          return;
        }

        const queueManager = this.registry.resolveService("queueManager") as {
          updateItem(itemId: string, message: string): Record<string, unknown> | undefined;
        } | undefined;

        if (!queueManager) {
          res.status(503).json({ success: false, error: "Queue manager not available" });
          return;
        }

        const updated = queueManager.updateItem(itemId, String(message));
        if (!updated) {
          res.status(404).json({ success: false, error: "Queue item not found or not editable" });
          return;
        }
        res.json({ success: true, item: updated });
      } catch (err) {
        this.handleError(err, res, "Failed to update queue item");
      }
    });

    app.post("/api/queue/clear", (req: Request, res: Response) => {
      try {
        const { sessionId } = req.body || {};
        if (!sessionId) {
          res.status(400).json({ success: false, error: "sessionId is required" });
          return;
        }

        const queueManager = this.registry.resolveService("queueManager") as {
          getQueue(sessionId: string): Array<Record<string, unknown>>;
          clearQueue(sessionId: string): void;
        } | undefined;

        if (!queueManager) {
          res.status(503).json({ success: false, error: "Queue manager not available" });
          return;
        }

        // 清空前先获取数量，用于返回 cleared 计数
        const cleared = queueManager.getQueue(sessionId).length;
        queueManager.clearQueue(sessionId);
        res.json({ success: true, cleared });
      } catch (err) {
        this.handleError(err, res, "Failed to clear queue");
      }
    });

    // ─── Channel API routes ──────────────────────────────────────────────────

    app.get("/api/channels/status", (_req: Request, res: Response) => {
      try {
        const channelManager = this.registry.resolveService("channelManager") as {
          getAllStatuses(): Array<{ type: string; label: string; enabled: boolean; connected: boolean; messageCount: number }>;
        } | undefined;

        res.json({
          success: true,
          channels: channelManager?.getAllStatuses() ?? [],
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get channel status");
      }
    });

    app.get("/api/channels/active", (_req: Request, res: Response) => {
      try {
        const channelManager = this.registry.resolveService("channelManager") as {
          getActiveChannels(): string[];
        } | undefined;

        res.json({
          success: true,
          activeChannels: channelManager?.getActiveChannels() ?? [],
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get active channels");
      }
    });

    app.get("/api/channels/approved", (req: Request, res: Response) => {
      try {
        const channel = req.query.channel as string;
        const channelManager = this.registry.resolveService("channelManager") as {
          getDMPolicy(channel: string): string;
          isPeerApproved?: (channel: string, peerId: string) => boolean;
        } | undefined;

        res.json({
          success: true,
          channel,
          dmPolicy: channelManager?.getDMPolicy(channel ?? "webchat"),
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get approved peers");
      }
    });

    app.post("/api/channels/pairing/approve", (req: Request, res: Response) => {
      try {
        const { code } = req.body;
        const channelManager = this.registry.resolveService("channelManager") as {
          approvePairing(code: string): boolean;
        } | undefined;

        const result = channelManager?.approvePairing(code ?? "") ?? false;
        res.json({ success: result, message: result ? "Pairing approved" : "Invalid pairing code" });
      } catch (err) {
        this.handleError(err, res, "Failed to approve pairing");
      }
    });

    // 拒绝（丢弃）待审批的配对码。路径参数：:channel :code
    app.delete("/api/channels/pairing/:channel/:code", (req: Request, res: Response) => {
      try {
        const { channel, code } = req.params || {};
        if (!channel || !code) {
          res.status(400).json({ error: "channel and code are required" });
          return;
        }
        const channelManager = this.registry.resolveService("channelManager") as {
          rejectPairing(code: string, channel?: string): boolean;
        } | undefined;

        const result = channelManager?.rejectPairing(String(code), String(channel)) ?? false;
        res.json({ success: result, message: result ? "Pairing rejected" : "Invalid or expired pairing code" });
      } catch (err) {
        this.handleError(err, res, "Failed to reject pairing");
      }
    });

    // ─── Commitments (OpenClaw 兼容) ─────────────────────────────────────
    // 由 packages/agent 的 CommitmentManager 支撑，已注册为 "commitmentManager" 服务。
    // 端点：GET /api/commitments, GET /api/commitments/summary,
    //       GET /api/commitments/:id, POST /api/commitments/:id/dismiss
    app.get("/api/commitments", async (_req: Request, res: Response) => {
      try {
        const mgr = this.registry.resolveService<{
          list(filter?: unknown): unknown[];
        }>("commitmentManager");
        if (!mgr) {
          res.json({ commitments: [] });
          return;
        }
        res.json({ commitments: mgr.list() });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // summary 必须在 :id 之前注册，避免 "summary" 被当作 id
    app.get("/api/commitments/summary", async (req: Request, res: Response) => {
      try {
        const mgr = this.registry.resolveService<{
          list(filter?: unknown): unknown[];
        }>("commitmentManager");
        if (!mgr) {
          res.json({ total: 0, pending: 0, inProgress: 0, overdue: 0 });
          return;
        }
        const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
        // CommitmentFilter.status 接受数组；用 any 绕过字面量联合类型限制
        const filter: { status: string[]; sessionId?: string } = { status: ["pending", "in_progress"] };
        if (sessionId) filter.sessionId = sessionId;
        const all = mgr.list(filter) as Array<{ status?: string; deadline?: number }>;
        const pending = all.filter((c) => c.status === "pending").length;
        const inProgress = all.filter((c) => c.status === "in_progress").length;
        const now = Date.now();
        const overdue = all.filter((c) => c.deadline && c.deadline < now).length;
        res.json({ total: all.length, pending, inProgress, overdue });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/commitments/:id", async (req: Request, res: Response) => {
      try {
        const mgr = this.registry.resolveService<{
          get(id: string): unknown;
        }>("commitmentManager");
        if (!mgr) {
          res.status(503).json({ error: "Commitment manager not available" });
          return;
        }
        const found = mgr.get(String(req.params.id));
        if (!found) {
          res.status(404).json({ error: "Commitment not found" });
          return;
        }
        res.json({ commitment: found });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/commitments/:id/dismiss", async (req: Request, res: Response) => {
      try {
        const mgr = this.registry.resolveService<{
          cancel(id: string, reason?: string): unknown;
        }>("commitmentManager");
        if (!mgr) {
          res.status(503).json({ error: "Commitment manager not available" });
          return;
        }
        const id = String(req.params.id);
        const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
        const result = mgr.cancel(id, reason);
        if (!result) {
          res.json({ success: false, dismissed: [], failed: [{ id, reason: "not found or invalid transition" }] });
          return;
        }
        res.json({ success: true, dismissed: [id], failed: [] });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Feishu Webhook ──────────────────────────────────────────────────

    app.post("/api/channels/feishu/webhook", async (req: Request, res: Response) => {
      try {
        const channelManager = this.registry.resolveService("channelManager") as {
          getAdapter(type: string): { handleWebhookEvent(body: Record<string, unknown>, headers?: Record<string, string>, rawBody?: string): Promise<{ challenge?: string }> } | undefined;
        } | undefined;
        if (!channelManager) {
          res.status(503).json({ error: "Channel manager not available" });
          return;
        }
        const adapter = channelManager.getAdapter("feishu");
        if (!adapter) {
          res.status(404).json({ error: "Feishu adapter not found" });
          return;
        }
        // 校验最小 payload 结构：飞书 webhook 事件至少包含 "event" 或 "type" 或 "challenge" 字段，
        // 空 body 或非对象 body 直接返回 400，避免无效请求被静默接受。
        const body = req.body as Record<string, unknown>;
        if (!body || typeof body !== "object" || Object.keys(body).length === 0) {
          res.status(400).json({ error: "Empty or invalid webhook payload" });
          return;
        }
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") headers[key] = value;
        }
        // Pass raw body for signature verification
        const rawBody = typeof (req as any).rawBody === "string" ? (req as any).rawBody : JSON.stringify(req.body);
        const result = await adapter.handleWebhookEvent(body, headers, rawBody);
        res.json(result.challenge ? { challenge: result.challenge } : {});
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── DingTalk Webhook ───────────────────────────────────────────────

    app.post("/api/channels/dingtalk/webhook", async (req: Request, res: Response) => {
      try {
        const channelManager = this.registry.resolveService("channelManager") as {
          getAdapter(type: string): { handleWebhookEvent(body: Record<string, unknown>, headers?: Record<string, string>): Promise<{ challenge?: string }> } | undefined;
        } | undefined;
        if (!channelManager) {
          res.status(503).json({ error: "Channel manager not available" });
          return;
        }
        const adapter = channelManager.getAdapter("dingtalk");
        if (!adapter) {
          res.status(404).json({ error: "DingTalk adapter not found" });
          return;
        }
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") headers[key] = value;
        }
        const result = await adapter.handleWebhookEvent(req.body as Record<string, unknown>, headers);
        res.json(result.challenge ? { challenge: result.challenge } : {});
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── WhatsApp Webhook ───────────────────────────────────────────────

    // GET 用于 Meta webhook 验证（hub.challenge）
    app.get("/api/channels/whatsapp/webhook", (req: Request, res: Response) => {
      try {
        const channelManager = this.registry.resolveService("channelManager") as {
          getAdapter(type: string): { verifyWebhook(mode: string, token: string, challenge: string): string | null } | undefined;
        } | undefined;
        const adapter = channelManager?.getAdapter("whatsapp");
        if (!adapter) {
          res.status(404).json({ error: "WhatsApp adapter not found" });
          return;
        }
        const mode = (req.query["hub.mode"] as string) ?? "";
        const token = (req.query["hub.verify_token"] as string) ?? "";
        const challenge = (req.query["hub.challenge"] as string) ?? "";
        const result = adapter.verifyWebhook(mode, token, challenge);
        if (result !== null) {
          res.type("text/plain").send(result);
        } else {
          res.status(403).send("Forbidden");
        }
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/channels/whatsapp/webhook", async (req: Request, res: Response) => {
      try {
        const channelManager = this.registry.resolveService("channelManager") as {
          getAdapter(type: string): { handleWebhook(body: unknown, headers?: Record<string, string>, rawBody?: string): Promise<void> } | undefined;
        } | undefined;
        if (!channelManager) {
          res.status(503).json({ error: "Channel manager not available" });
          return;
        }
        const adapter = channelManager.getAdapter("whatsapp");
        if (!adapter) {
          res.status(404).json({ error: "WhatsApp adapter not found" });
          return;
        }
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") headers[key] = value;
        }
        const rawBody = typeof (req as any).rawBody === "string" ? (req as any).rawBody : JSON.stringify(req.body);
        await adapter.handleWebhook(req.body, headers, rawBody);
        res.json({});
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Slack Webhook ──────────────────────────────────────────────────

    app.post("/api/channels/slack/webhook", async (req: Request, res: Response) => {
      try {
        const channelManager = this.registry.resolveService("channelManager") as {
          getAdapter(type: string): { handleEvent(body: Record<string, unknown>, headers?: Record<string, string>, rawBody?: string): Promise<{ challenge?: string }> } | undefined;
        } | undefined;
        if (!channelManager) {
          res.status(503).json({ error: "Channel manager not available" });
          return;
        }
        const adapter = channelManager.getAdapter("slack");
        if (!adapter) {
          res.status(404).json({ error: "Slack adapter not found" });
          return;
        }
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") headers[key] = value;
        }
        const rawBody = typeof (req as any).rawBody === "string" ? (req as any).rawBody : JSON.stringify(req.body);
        const result = await adapter.handleEvent(req.body as Record<string, unknown>, headers, rawBody);
        res.json(result.challenge ? { challenge: result.challenge } : {});
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── Telegram Webhook ───────────────────────────────────────────────

    app.post("/api/channels/telegram/webhook", async (req: Request, res: Response) => {
      try {
        const channelManager = this.registry.resolveService("channelManager") as {
          getAdapter(type: string): { handleWebhook(body: unknown, headers?: Record<string, string>): Promise<void> } | undefined;
        } | undefined;
        if (!channelManager) {
          res.status(503).json({ error: "Channel manager not available" });
          return;
        }
        const adapter = channelManager.getAdapter("telegram");
        if (!adapter) {
          res.status(404).json({ error: "Telegram adapter not found" });
          return;
        }
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") headers[key] = value;
        }
        await adapter.handleWebhook(req.body, headers);
        res.json({});
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── WeChat Webhook ─────────────────────────────────────────────────

    // GET 用于公众号 URL 验证（返回 echostr）
    app.get("/api/channels/wechat/webhook", (req: Request, res: Response) => {
      try {
        const channelManager = this.registry.resolveService("channelManager") as {
          getAdapter(type: string): { verifySignature(timestamp: string, nonce: string, signature: string): boolean } | undefined;
        } | undefined;
        const adapter = channelManager?.getAdapter("wechat");
        if (!adapter) {
          res.status(404).json({ error: "WeChat adapter not found" });
          return;
        }
        const signature = (req.query.signature as string) ?? "";
        const timestamp = (req.query.timestamp as string) ?? "";
        const nonce = (req.query.nonce as string) ?? "";
        const echostr = (req.query.echostr as string) ?? "";
        if (adapter.verifySignature(timestamp, nonce, signature)) {
          res.type("text/plain").send(echostr);
        } else {
          res.status(403).send("Forbidden");
        }
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/channels/wechat/webhook", async (req: Request, res: Response) => {
      try {
        const channelManager = this.registry.resolveService("channelManager") as {
          getAdapter(type: string): {
            handleOfficialMessage(xmlBody: string, signatureParams: { timestamp: string; nonce: string; signature: string }): Promise<string>;
            handleWeComWebhook(body: Record<string, unknown>, signatureParams: { timestamp: string; nonce: string; signature: string }): Promise<void>;
          } | undefined;
        } | undefined;
        if (!channelManager) {
          res.status(503).json({ error: "Channel manager not available" });
          return;
        }
        const adapter = channelManager.getAdapter("wechat");
        if (!adapter) {
          res.status(404).json({ error: "WeChat adapter not found" });
          return;
        }
        const signatureParams = {
          timestamp: (req.query.timestamp as string) ?? "",
          nonce: (req.query.nonce as string) ?? "",
          signature: (req.query.signature as string) ?? "",
        };
        // 企业微信 bot webhook 发送 JSON，公众号发送 XML
        if (req.is("application/json")) {
          await adapter.handleWeComWebhook(req.body as Record<string, unknown>, signatureParams);
          res.json({});
        } else {
          const rawBody = typeof (req as any).rawBody === "string" ? (req as any).rawBody : String(req.body ?? "");
          const result = await adapter.handleOfficialMessage(rawBody, signatureParams);
          res.type("text/plain").send(result);
        }
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // ─── WeChat iLink API Proxy ──────────────────────────────────────────

    const WEIXIN_API_BASE = "https://ilinkai.weixin.qq.com";
    const DEFAULT_BOT_TYPE = "3";

    // Request a QR code from WeChat iLink server
    app.post("/api/channels/wechat/pair-request", async (_req: Request, res: Response) => {
      try {
        const url = `${WEIXIN_API_BASE}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(DEFAULT_BOT_TYPE)}`;
        const apiRes = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "iLink-App-Id": "bot",
            "iLink-App-ClientVersion": "0",
          },
          body: JSON.stringify({ local_token_list: [] }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!apiRes.ok) {
          res.status(502).json({ success: false, error: `WeChat API returned ${apiRes.status}` });
          return;
        }
        const data = await apiRes.json() as { qrcode?: string; qrcode_img_content?: string };
        if (!data.qrcode || !data.qrcode_img_content) {
          res.status(502).json({ success: false, error: "WeChat API did not return QR code" });
          return;
        }
        // Return the QR code URL and the internal qrcode key for polling
        res.json({
          success: true,
          qrcodeKey: data.qrcode,
          pairUrl: data.qrcode_img_content,
        });
      } catch (err) {
        this.handleError(err, res, "Failed to request WeChat QR code");
      }
    });

    // Poll WeChat iLink server for QR scan status
    app.get("/api/channels/wechat/pair-status", async (req: Request, res: Response) => {
      const qrcode = req.query.qrcode as string;
      if (!qrcode) {
        res.status(400).json({ error: "Missing qrcode parameter" });
        return;
      }
      try {
        const url = `${WEIXIN_API_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
        const apiRes = await fetch(url, {
          method: "GET",
          headers: {
            "iLink-App-Id": "bot",
            "iLink-App-ClientVersion": "0",
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!apiRes.ok) {
          res.status(502).json({ error: `WeChat API returned ${apiRes.status}` });
          return;
        }
        const data = await apiRes.json() as {
          status?: string;
          bot_token?: string;
          ilink_bot_id?: string;
          baseurl?: string;
          ilink_user_id?: string;
        };

        // If confirmed, save credentials
        if (data.status === "confirmed" && data.bot_token && data.ilink_bot_id) {
          try {
            const fs = await import("fs");
            const path = await import("path");
            const os = await import("os");
            const normalizedId = data.ilink_bot_id.replace(/@/g, "-");
            if (normalizedId.includes("..")) {
              throw new Error("Invalid bot ID: path traversal detected");
            }
            const stateDir = process.env.EVOCLAW_STATE_DIR || path.join(os.homedir(), ".evoclaw");
            const accountsDir = path.join(stateDir, "evoclaw-weixin", "accounts");
            fs.mkdirSync(accountsDir, { recursive: true });
            const accountFile = path.join(accountsDir, `${normalizedId}.json`);
            atomicWriteFileSync(accountFile, JSON.stringify({
              token: data.bot_token,
              baseUrl: data.baseurl || WEIXIN_API_BASE,
              savedAt: new Date().toISOString(),
              ...(data.ilink_user_id ? { userId: data.ilink_user_id } : {}),
            }, null, 2));
            // Update accounts index
            const indexPath = path.join(stateDir, "evoclaw-weixin", "accounts.json");
            let index: string[] = [];
            try { if (fs.existsSync(indexPath)) index = JSON.parse(fs.readFileSync(indexPath, "utf-8")); } catch (err) { console.debug("[ProtocolAdapter]", err instanceof Error ? err.message : String(err)); }
            if (!index.includes(normalizedId)) {
              index.push(normalizedId);
              atomicWriteFileSync(indexPath, JSON.stringify(index, null, 2));
            }
            // Emit event to start Weixin monitor
            this.eventBus?.publish("weixin:start-monitor", {}, "protocol-adapter");
          } catch (saveErr) {
            process.stderr.write("[WeChat] Failed to save credentials:" + " " + saveErr + "\n");
          }
        }

        res.json(data);
      } catch (err) {
        this.handleError(err, res, "Failed to poll WeChat QR status");
      }
    });

    // Manually start Weixin monitor for configured accounts
    app.post("/api/channels/weixin/start-monitor", async (_req: Request, res: Response) => {
      try {
        // We'll emit an event to notify the server to start the Weixin monitor
        // The actual monitor is managed in the main server class
        this.eventBus?.publish("weixin:start-monitor", {}, "protocol-adapter");
        res.json({ success: true, message: "Weixin monitor start requested" });
      } catch (err) {
        this.handleError(err, res, "Failed to start Weixin monitor");
      }
    });

    // Check Weixin connection status
    app.get("/api/channels/weixin/status", async (_req: Request, res: Response) => {
      try {
        const fs = await import("fs");
        const path = await import("path");
        const os = await import("os");
        const stateDir = process.env.EVOCLAW_STATE_DIR || path.join(os.homedir(), ".evoclaw");
        const indexPath = path.join(stateDir, "evoclaw-weixin", "accounts.json");

        let connected = false;
        let accountCount = 0;
        try {
          if (fs.existsSync(indexPath)) {
            const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
            accountCount = Array.isArray(index) ? index.length : 0;
            connected = accountCount > 0;
          }
        } catch { /* */ }

        res.json({ success: true, connected, accountCount });
      } catch (err) {
        this.handleError(err, res, "Failed to check Weixin status");
      }
    });

    // ─── WebSocket / Streaming status ────────────────────────────────────────

    app.get("/api/ws/connections", (_req: Request, res: Response) => {
      try {
        const protocolHandler = this.registry.resolveService("protocolHandler") as {
          getConnectionCount(): number;
          getConnectedClients(): Array<{ id: string; role: string; connectedAt: Date; remoteAddress: string }>;
        } | undefined;

        res.json({
          success: true,
          connectionCount: protocolHandler?.getConnectionCount() ?? 0,
          clients: protocolHandler?.getConnectedClients() ?? [],
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get WS connections");
      }
    });

    // ─── Context Engine ─────────────────────────────────────────────────────

    app.get("/api/context/status", (_req: Request, res: Response) => {
      try {
        const contextEngine = this.registry.resolveService("contextEngine") as {
          getConfig(): Record<string, unknown>;
        } | undefined;

        res.json({
          success: true,
          config: contextEngine?.getConfig() ?? {},
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get context config");
      }
    });

    // ─── Event Ledger (ACP event sourcing) ──────────────────────────────────

    app.get("/api/events", (req: Request, res: Response) => {
      try {
        const eventLedger = this.registry.resolveService("eventLedger") as {
          query(query: { sessionId?: string; agentId?: string; types?: string[]; from?: string; to?: string; limit?: number }): Array<Record<string, unknown>>;
          snapshot(): Record<string, unknown>;
        } | undefined;

        if (!eventLedger) {
          res.json({ events: [], total: 0 });
          return;
        }

        const query: Record<string, unknown> = {};
        if (req.query.sessionId) query.sessionId = String(req.query.sessionId);
        if (req.query.agentId) query.agentId = String(req.query.agentId);
        // EventLedger.query 期望 types (string[]) / from / to (ISO string)，
        // 而非 type (string) / fromTime / toTime (number)。
        if (req.query.type) query.types = [String(req.query.type)];
        if (req.query.fromTime) {
          const ts = parseInt(String(req.query.fromTime), 10);
          if (!Number.isFinite(ts)) {
            res.status(400).json({ error: "Invalid fromTime" });
            return;
          }
          query.from = new Date(ts).toISOString();
        }
        if (req.query.toTime) {
          const ts = parseInt(String(req.query.toTime), 10);
          if (!Number.isFinite(ts)) {
            res.status(400).json({ error: "Invalid toTime" });
            return;
          }
          query.to = new Date(ts).toISOString();
        }
        if (req.query.limit) query.limit = Math.max(1, Math.min(parseInt(String(req.query.limit), 10) || 50, 1000));

        const events = eventLedger.query(query as any);
        res.json({ events, total: events.length });
      } catch (err) {
        this.handleError(err, res, "Failed to query events");
      }
    });

    app.get("/api/events/snapshot", (_req: Request, res: Response) => {
      try {
        const eventLedger = this.registry.resolveService("eventLedger") as {
          snapshot(): Record<string, unknown>;
        } | undefined;

        if (!eventLedger) {
          res.json({ nextSeq: 0, entryCount: 0, types: {} });
          return;
        }

        res.json(eventLedger.snapshot());
      } catch (err) {
        this.handleError(err, res, "Failed to get event snapshot");
      }
    });

    // ─── Permission Relay ──────────────────────────────────────────────────

    app.get("/api/permission-relay/pending", (_req: Request, res: Response) => {
      try {
        const permissionRelay = this.registry.resolveService("permissionRelay") as {
          getPending(): Array<Record<string, unknown>>;
          getHistory(limit?: number): Array<Record<string, unknown>>;
        } | undefined;

        if (!permissionRelay) {
          res.json({ requests: [] });
          return;
        }

        res.json({ requests: permissionRelay.getPending() });
      } catch (err) {
        this.handleError(err, res, "Failed to get pending permissions");
      }
    });

    app.get("/api/permission-relay/history", (req: Request, res: Response) => {
      try {
        const permissionRelay = this.registry.resolveService("permissionRelay") as {
          getHistory(limit?: number): Array<Record<string, unknown>>;
        } | undefined;

        if (!permissionRelay) {
          res.json({ history: [] });
          return;
        }

        const limit = parseInt(String(req.query.limit || "50"), 10) || 50;
        res.json({ history: permissionRelay.getHistory(limit) });
      } catch (err) {
        this.handleError(err, res, "Failed to get permission history");
      }
    });

    app.post("/api/permission-relay/:id/approve", (req: Request, res: Response) => {
      try {
        const permissionRelay = this.registry.resolveService("permissionRelay") as {
          approve(id: string, by?: string): Record<string, unknown> | null;
        } | undefined;

        if (!permissionRelay) {
          res.status(503).json({ error: "Permission relay not available" });
          return;
        }

        const result = permissionRelay.approve(String(req.params.id), "webui");
        if (!result) {
          res.status(404).json({ error: "Request not found" });
          return;
        }
        res.json({ success: true, request: result });
      } catch (err) {
        this.handleError(err, res, "Failed to approve permission");
      }
    });

    app.post("/api/permission-relay/:id/deny", (req: Request, res: Response) => {
      try {
        const permissionRelay = this.registry.resolveService("permissionRelay") as {
          deny(id: string, reason?: string, by?: string): Record<string, unknown> | null;
        } | undefined;

        if (!permissionRelay) {
          res.status(503).json({ error: "Permission relay not available" });
          return;
        }

        const { reason } = req.body || {};
        const result = permissionRelay.deny(String(req.params.id), reason || "Denied by user", "webui");
        if (!result) {
          res.status(404).json({ error: "Request not found" });
          return;
        }
        res.json({ success: true, request: result });
      } catch (err) {
        this.handleError(err, res, "Failed to deny permission");
      }
    });

    // ─── Crestodian (Operations Manager) ───────────────────────────────────

    app.get("/api/crestodian/health", (_req: Request, res: Response) => {
      try {
        const serviceNames = [
          "eventBus", "sessionManager", "pluginManager", "skillManager",
          "permissionManager", "memoryHub", "evolutionEngine", "agentModelExecutor",
          "channelManager", "securityGovernor", "auditCenter",
        ];
        const services: Record<string, { status: string }> = {};
        for (const name of serviceNames) {
          const svc = this.registry.resolveService(name);
          services[name] = { status: svc ? "running" : "stopped" };
        }
        const os = require("os");
        const cpuUsage = process.cpuUsage();
        const memUsage = process.memoryUsage();
        res.json({
          status: "ok",
          services,
          uptimeMs: Math.floor(process.uptime() * 1000),
          os: {
            hostname: os.hostname(),
            platform: os.platform(),
            arch: os.arch(),
            cpus: os.cpus().length,
            totalMem: os.totalmem(),
            freeMem: os.freemem(),
            loadAvg: os.loadavg ? os.loadavg() : [],
          },
          process: {
            pid: process.pid,
            memoryRss: memUsage.rss,
            memoryHeapUsed: memUsage.heapUsed,
            cpuUser: cpuUsage.user,
            cpuSystem: cpuUsage.system,
          },
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get health");
      }
    });

    app.get("/api/crestodian/overview", (_req: Request, res: Response) => {
      try {
        const crestodian = this.registry.resolveService("crestodian") as {
          getOverview(): Record<string, unknown>;
          renderOverview(): string;
        } | undefined;

        if (!crestodian) {
          res.json({ status: "unavailable", services: [] });
          return;
        }

        res.json(crestodian.getOverview());
      } catch (err) {
        this.handleError(err, res, "Failed to get overview");
      }
    });

    app.get("/api/crestodian/diagnostics", (_req: Request, res: Response) => {
      try {
        const os = require("os");
        const memUsage = process.memoryUsage();
        const cpuUsage = process.cpuUsage();
        res.json({
          status: "ok",
          collectedAt: Date.now(),
          os: {
            hostname: os.hostname(),
            platform: os.platform(),
            arch: os.arch(),
            cpus: os.cpus().length,
            totalMem: Math.round(os.totalmem() / 1024 / 1024),
            freeMem: Math.round(os.freemem() / 1024 / 1024),
            loadAvg: os.loadavg ? os.loadavg() : [],
            uptime: Math.floor(os.uptime()),
          },
          process: {
            pid: process.pid,
            rss: Math.round(memUsage.rss / 1024 / 1024),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            cpuUser: cpuUsage.user,
            cpuSystem: cpuUsage.system,
            uptime: Math.floor(process.uptime()),
            nodeVersion: process.version,
          },
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get diagnostics");
      }
    });

    // ─── Incoming Webhook API routes ────────────────────────────────────────

    app.post("/api/webhooks", (req: Request, res: Response) => {
      try {
        const { id, path: hookPath, method, authToken, action, description, enabled } = req.body || {};
        if (!id || !hookPath || !method || !action) {
          res.status(400).json({ error: "id, path, method, and action are required" });
          return;
        }
        if (method !== "POST" && method !== "GET") {
          res.status(400).json({ error: "method must be POST or GET" });
          return;
        }

        const endpoint = this.incomingWebhookManager.register({
          id,
          path: hookPath,
          method,
          authToken,
          action,
          description,
          enabled: enabled !== false,
        });

        res.status(201).json({ success: true, endpoint });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("already exists")) {
          res.status(409).json({ error: message });
          return;
        }
        this.handleError(err, res, "Failed to create webhook");
      }
    });

    app.get("/api/webhooks", (_req: Request, res: Response) => {
      try {
        const endpoints = this.incomingWebhookManager.list();
        res.json({ success: true, endpoints });
      } catch (err) {
        this.handleError(err, res, "Failed to list webhooks");
      }
    });

    app.get("/api/webhooks/:id", (req: Request, res: Response) => {
      try {
        const endpoint = this.incomingWebhookManager.get(String(req.params.id));
        if (!endpoint) {
          res.status(404).json({ error: "Webhook not found" });
          return;
        }
        res.json({ success: true, endpoint });
      } catch (err) {
        this.handleError(err, res, "Failed to get webhook");
      }
    });

    app.delete("/api/webhooks/:id", (req: Request, res: Response) => {
      try {
        const removed = this.incomingWebhookManager.delete(String(req.params.id));
        if (!removed) {
          res.status(404).json({ error: "Webhook not found" });
          return;
        }
        res.json({ success: true });
      } catch (err) {
        this.handleError(err, res, "Failed to delete webhook");
      }
    });

    app.put("/api/webhooks/:id", (req: Request, res: Response) => {
      try {
        const { path: hookPath, method, authToken, action, description, enabled } = req.body || {};
        const updates: Partial<Omit<WebhookEndpoint, "id" | "createdAt">> = {};
        if (hookPath !== undefined) updates.path = hookPath;
        if (method !== undefined) {
          if (method !== "POST" && method !== "GET") {
            res.status(400).json({ error: "method must be POST or GET" });
            return;
          }
          updates.method = method;
        }
        if (authToken !== undefined) updates.authToken = authToken;
        if (action !== undefined) updates.action = action;
        if (description !== undefined) updates.description = description;
        if (enabled !== undefined) updates.enabled = enabled;

        const endpoint = this.incomingWebhookManager.update(String(req.params.id), updates);
        if (!endpoint) {
          res.status(404).json({ error: "Webhook not found" });
          return;
        }
        res.json({ success: true, endpoint });
      } catch (err) {
        this.handleError(err, res, "Failed to update webhook");
      }
    });

    app.post("/api/webhooks/:id/test", async (req: Request, res: Response) => {
      try {
        const endpoint = this.incomingWebhookManager.get(String(req.params.id));
        if (!endpoint) {
          res.status(404).json({ error: "Webhook not found" });
          return;
        }

        const testHeaders: Record<string, string> = { "content-type": "application/json" };
        if (endpoint.authToken) {
          testHeaders["x-webhook-token"] = endpoint.authToken;
        }

        const testBody = req.body?.testPayload ?? { test: true, timestamp: new Date().toISOString() };
        const result = await this.incomingWebhookManager.trigger(
          endpoint.id,
          endpoint.path,
          endpoint.method,
          testHeaders,
          testBody
        );

        res.json({
          success: result.statusCode >= 200 && result.statusCode < 300,
          statusCode: result.statusCode,
          response: result.response,
          eventLog: result.eventLog,
        });
      } catch (err) {
        this.handleError(err, res, "Failed to test webhook");
      }
    });

    app.all("/hooks/*", async (req: Request, res: Response) => {
      try {
        const requestPath = "/" + req.params[0];
        const requestMethod = req.method.toUpperCase();

        const endpoint = this.incomingWebhookManager.matchEndpoint(requestPath, requestMethod);
        if (!endpoint) {
          res.status(404).json({ error: "No matching webhook endpoint found" });
          return;
        }

        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") {
            headers[key] = value;
          } else if (Array.isArray(value)) {
            headers[key] = value.join(", ");
          }
        }

        const body = req.body ?? {};
        const result = await this.incomingWebhookManager.trigger(
          endpoint.id,
          requestPath,
          requestMethod,
          headers,
          body
        );

        res.status(result.statusCode).json(result.response ?? { received: true });
      } catch (err) {
        this.handleError(err, res, "Webhook processing failed");
      }
    });

    // ─── Sandbox API routes ──────────────────────────────────────────────

    app.get("/api/sandbox/backends", async (_req: Request, res: Response) => {
      try {
        const sandboxManager = this.registry.resolveService<{
          listBackends(): Promise<Array<{ type: string; available: boolean }>>;
        }>("sandboxManager");

        if (!sandboxManager) {
          res.json({ backends: [] });
          return;
        }

        const backends = await sandboxManager.listBackends();
        res.json({ backends });
      } catch (err) {
        this.handleError(err, res, "Failed to list sandbox backends");
      }
    });

    app.post("/api/sandbox/sessions", async (req: Request, res: Response) => {
      try {
        const { backend, docker, ssh } = req.body || {};
        if (!backend || !["docker", "ssh", "process"].includes(backend)) {
          res.status(400).json({ error: "backend must be one of: docker, ssh, process" });
          return;
        }

        const sandboxManager = this.registry.resolveService<{
          createSession(config: { backend: string; docker?: unknown; ssh?: unknown }): Promise<unknown>;
        }>("sandboxManager");

        if (!sandboxManager) {
          res.status(503).json({ error: "Sandbox service not available" });
          return;
        }

        const session = await sandboxManager.createSession({ backend, docker, ssh });
        res.status(201).json({ success: true, session });
      } catch (err) {
        this.handleError(err, res, "Failed to create sandbox session");
      }
    });

    app.get("/api/sandbox/sessions", (_req: Request, res: Response) => {
      try {
        const sandboxManager = this.registry.resolveService<{
          listSessions(): Array<{ id: string; backend: string; status: string; executeCount: number }>;
        }>("sandboxManager");

        if (!sandboxManager) {
          res.json({ sessions: [] });
          return;
        }

        res.json({ sessions: sandboxManager.listSessions() });
      } catch (err) {
        this.handleError(err, res, "Failed to list sandbox sessions");
      }
    });

    app.post("/api/sandbox/sessions/:id/exec", async (req: Request, res: Response) => {
      try {
        const { command, interpreter, timeoutMs, env, workdir } = req.body || {};
        const sessionId = String(req.params.id);

        const sandboxManager = this.registry.resolveService<{
          execute(sessionId: string, command: string[], options?: unknown): Promise<unknown>;
          executeScript(sessionId: string, script: string, options?: unknown): Promise<unknown>;
        }>("sandboxManager");

        if (!sandboxManager) {
          res.status(503).json({ error: "Sandbox service not available" });
          return;
        }

        let result;
        if (interpreter && typeof command === "string") {
          result = await sandboxManager.executeScript(sessionId, command, { interpreter, timeoutMs });
        } else if (Array.isArray(command)) {
          result = await sandboxManager.execute(sessionId, command, { timeoutMs, env, workdir });
        } else {
          res.status(400).json({ error: "command is required (string for script, array for exec)" });
          return;
        }

        res.json({ success: true, result });
      } catch (err) {
        this.handleError(err, res, "Failed to execute in sandbox");
      }
    });

    app.delete("/api/sandbox/sessions/:id", async (req: Request, res: Response) => {
      try {
        const sandboxManager = this.registry.resolveService<{
          destroySession(sessionId: string): Promise<void>;
        }>("sandboxManager");

        if (!sandboxManager) {
          res.status(503).json({ error: "Sandbox service not available" });
          return;
        }

        await sandboxManager.destroySession(String(req.params.id));
        res.json({ success: true });
      } catch (err) {
        this.handleError(err, res, "Failed to destroy sandbox session");
      }
    });

    // ─── Device Pairing API routes ──────────────────────────────────────────

    app.post("/api/pairing/init", (req: Request, res: Response) => {
      try {
        const { deviceType, deviceName } = req.body || {};
        if (!deviceType || !["web", "mobile", "desktop", "cli"].includes(deviceType)) {
          res.status(400).json({ error: "deviceType must be one of: web, mobile, desktop, cli" });
          return;
        }

        const devicePairingManager = this.registry.resolveService<{
          initiatePairing(deviceType: string, deviceName: string): { pairingCode: string; challenge: string; expiresAt: Date };
        }>("devicePairingManager");

        if (!devicePairingManager) {
          res.status(503).json({ error: "Device pairing service not available" });
          return;
        }

        const result = devicePairingManager.initiatePairing(deviceType, deviceName || "Unknown");
        res.json({ success: true, ...result });
      } catch (err) {
        this.handleError(err, res, "Failed to initiate pairing");
      }
    });

    app.post("/api/pairing/verify", async (req: Request, res: Response) => {
      try {
        const { pairingCode, publicKey, signature, deviceName } = req.body || {};
        if (!pairingCode || !publicKey || !signature) {
          res.status(400).json({ error: "pairingCode, publicKey, and signature are required" });
          return;
        }

        const devicePairingManager = this.registry.resolveService<{
          completePairing(params: { pairingCode: string; publicKey: string; signature: string; deviceName?: string }): unknown;
        }>("devicePairingManager");

        if (!devicePairingManager) {
          res.status(503).json({ error: "Device pairing service not available" });
          return;
        }

        const device = await devicePairingManager.completePairing({
          pairingCode,
          publicKey,
          signature,
          deviceName,
        });

        if (!device) {
          res.status(401).json({ error: "Pairing verification failed" });
          return;
        }

        res.json({ success: true, device });
      } catch (err) {
        this.handleError(err, res, "Failed to verify pairing");
      }
    });

    app.get("/api/pairing/devices", (_req: Request, res: Response) => {
      try {
        const devicePairingManager = this.registry.resolveService<{
          listTrustedDevices(): unknown[];
        }>("devicePairingManager");

        if (!devicePairingManager) {
          res.json({ devices: [] });
          return;
        }

        res.json({ devices: devicePairingManager.listTrustedDevices() });
      } catch (err) {
        this.handleError(err, res, "Failed to list devices");
      }
    });

    app.delete("/api/pairing/devices/:id", (req: Request, res: Response) => {
      try {
        const devicePairingManager = this.registry.resolveService<{
          removeDevice(deviceId: string): boolean;
          revokeDevice(deviceId: string): boolean;
        }>("devicePairingManager");

        if (!devicePairingManager) {
          res.status(503).json({ error: "Device pairing service not available" });
          return;
        }

        const deviceId = String(req.params.id);
        devicePairingManager.revokeDevice(deviceId);
        const removed = devicePairingManager.removeDevice(deviceId);

        res.json({ success: removed });
      } catch (err) {
        this.handleError(err, res, "Failed to remove device");
      }
    });

    app.post("/api/pairing/challenge", (_req: Request, res: Response) => {
      try {
        const devicePairingManager = this.registry.resolveService<{
          generateChallenge(): string;
        }>("devicePairingManager");

        if (!devicePairingManager) {
          res.status(503).json({ error: "Device pairing service not available" });
          return;
        }

        const challenge = devicePairingManager.generateChallenge();
        res.json({ challenge });
      } catch (err) {
        this.handleError(err, res, "Failed to generate challenge");
      }
    });

    // ─── Failover API routes ──────────────────────────────────────────────

    app.get("/api/system/failover/status", (_req: Request, res: Response) => {
      try {
        const failoverManager = this.registry.resolveService("failoverManager") as ModelFailoverManager | undefined;

        if (!failoverManager) {
          res.json({ status: "unavailable", message: "Failover manager not registered" });
          return;
        }

        res.json({
          status: "active",
          summary: failoverManager.getSummary(),
          providers: failoverManager.getAllHealth(),
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get failover status");
      }
    });

    app.post("/api/system/failover/reset", (req: Request, res: Response) => {
      try {
        const failoverManager = this.registry.resolveService("failoverManager") as ModelFailoverManager | undefined;

        if (!failoverManager) {
          res.json({ status: "unavailable", message: "Failover manager not registered" });
          return;
        }

        const { providerId } = req.body as { providerId?: string };

        if (providerId) {
          failoverManager.resetCircuit(providerId);
          res.json({ status: "ok", message: `Circuit reset for provider "${providerId}"` });
        } else {
          failoverManager.resetAllCircuits();
          res.json({ status: "ok", message: "All circuits reset" });
        }
      } catch (err) {
        this.handleError(err, res, "Failed to reset circuit breaker");
      }
    });

    app.get("/api/files/download/*", (req: Request, res: Response) => {
      try {
        let filePath = req.params[0] as string;
        if (!filePath || filePath.includes("..")) {
          res.status(400).json({ error: "Invalid file path" });
          return;
        }

        const workspacePath = path.resolve(process.env.EvoClaw_WORKSPACE || path.join(process.cwd(), "data", "workspace"));

        // If the path starts with "data/workspace", strip it — it's an absolute-style path
        // that should be relative to the workspace root
        const workspacePrefix = "data/workspace/";
        if (filePath.startsWith(workspacePrefix) || filePath.startsWith(workspacePrefix.replace(/\//g, "\\"))) {
          filePath = filePath.slice(workspacePrefix.length);
        }

        // Also handle URL-decoded paths that may contain backslashes
        filePath = filePath.replace(/\\/g, "/");

        const fullPath = path.resolve(workspacePath, filePath);

        if (!fullPath.startsWith(path.resolve(workspacePath))) {
          res.status(403).json({ error: "Access denied: path traversal detected" });
          return;
        }

        if (!fs.existsSync(fullPath)) {
          res.status(404).json({ error: "File not found" });
          return;
        }

        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          res.status(400).json({ error: "Path is a directory, not a file" });
          return;
        }

        const filename = path.basename(fullPath);
        const ext = path.extname(fullPath).toLowerCase();

        // 图片文件内联显示，其他文件以附件方式下载
        const imageMimeTypes: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".svg": "image/svg+xml",
          ".bmp": "image/bmp",
          ".ico": "image/x-icon",
        };

        if (imageMimeTypes[ext]) {
          res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`);
          res.setHeader("Content-Type", imageMimeTypes[ext]);
        } else {
          res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
          res.setHeader("Content-Type", "application/octet-stream");
        }
        res.setHeader("Content-Length", stat.size);
        const stream = fs.createReadStream(fullPath);
        stream.on("error", (err) => {
          if (!res.headersSent) {
            res.status(500).json({ error: "Failed to read file" });
          } else {
            // Headers already sent — destroy the response to abort download
            res.destroy(err);
          }
          process.stderr.write("[ProtocolAdapter] createReadStream error for" + " " + fullPath + ":" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
        });
        // 客户端中途断开时销毁读取流，防止文件描述符泄漏
        res.on("close", () => { if (!stream.destroyed) stream.destroy(); });
        stream.pipe(res);
      } catch (err) {
        this.handleError(err, res, "Failed to download file");
      }
    });

    app.get("/api/files/list", (req: Request, res: Response) => {
      try {
        const dirPath = (req.query.path as string) || ".";
        // 拒绝包含 ".." 的相对路径穿越尝试；后续通过 workspace 边界校验确保安全。
        // 注意：之前 `path.resolve(dirPath) !== path.normalize(dirPath)` 对所有相对路径恒为 true
        // （resolve 返回绝对路径，normalize 保留相对形式），导致合法相对路径（如 "packages"、"."）
        // 被误拒。已移除该错误检查，仅保留 ".." 检查 + workspace startsWith 边界校验。
        if (dirPath.includes("..")) {
          res.status(400).json({ error: "Invalid path" });
          return;
        }

        const workspacePath = process.env.EvoClaw_WORKSPACE || path.resolve(process.cwd(), "data", "workspace");
        const fullPath = path.resolve(workspacePath, dirPath);

        if (!fullPath.startsWith(path.resolve(workspacePath))) {
          res.status(403).json({ error: "Access denied" });
          return;
        }

        if (!fs.existsSync(fullPath)) {
          res.status(404).json({ error: "Directory not found" });
          return;
        }

        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        const files = entries.map((entry) => {
          const entryPath = path.join(fullPath, entry.name);
          let size = 0;
          try { size = fs.statSync(entryPath).size; } catch { /* size defaults to 0 */ }
          return {
            name: entry.name,
            path: path.relative(workspacePath, entryPath).replace(/\\/g, "/"),
            isDirectory: entry.isDirectory(),
            size,
            downloadUrl: entry.isFile() ? `/api/files/download/${path.relative(workspacePath, entryPath).replace(/\\/g, "/")}` : undefined,
          };
        });

        res.json({ path: dirPath, files });
      } catch (err) {
        this.handleError(err, res, "Failed to list files");
      }
    });

    // ─── Dead Letter Queue API routes ──────────────────────────────────────

    app.get("/api/dlq", (req: Request, res: Response) => {
      try {
        const dlq = this.getDeadLetterQueue();
        const query: Record<string, unknown> = {};
        if (req.query.channel) query.channel = String(req.query.channel);
        if (req.query.type) query.failureType = String(req.query.type);
        // Frontend sends: "pending" (unreplayed), "dead" (replayed), "retrying" (replayed with retries)
        const statusParam = String(req.query.status || "").toLowerCase();
        if (statusParam === "pending") query.unreplayed = true;
        if (req.query.limit) query.limit = Math.max(1, Math.min(parseInt(String(req.query.limit), 10) || 50, 1000));
        const messages = dlq.query(query as any);
        const stats = dlq.getStats();
        // Map backend DeadLetter to frontend-compatible format
        let mapped = messages.map((m: any) => ({
          id: m.id,
          type: m.channel,
          payload: m.content,
          reason: m.error,
          attempts: m.retryCount,
          maxAttempts: 3,
          enqueuedAt: m.deadLetteredAt,
          lastAttemptAt: m.deadLetteredAt,
          status: m.replayed ? "dead" : "pending",
          // Extra fields for detail view
          channel: m.channel,
          target: m.target,
          contentType: m.contentType,
          failureType: m.failureType,
          originalSentAt: m.originalSentAt,
          metadata: m.metadata,
        }));
        // Client-side status filtering for "dead" (replayed) entries
        if (statusParam === "dead") {
          mapped = mapped.filter((m: any) => m.status === "dead");
        }
        res.json({ success: true, messages: mapped, total: stats.total, stats });
      } catch (err) {
        this.handleError(err, res, "Failed to query dead letter queue");
      }
    });

    app.post("/api/dlq/:id/retry", (req: Request, res: Response) => {
      try {
        const dlq = this.getDeadLetterQueue();
        const id = String(req.params.id);
        const entry = dlq.get(id);
        if (!entry) {
          res.status(404).json({ error: "Dead letter not found" });
          return;
        }
        const ok = dlq.markReplayed(id, true);
        res.json({ success: ok, id });
      } catch (err) {
        this.handleError(err, res, "Failed to retry dead letter");
      }
    });

    app.post("/api/dlq/retry-all", (req: Request, res: Response) => {
      try {
        const dlq = this.getDeadLetterQueue();
        const unreplayed = dlq.getUnreplayed();
        let retried = 0;
        for (const entry of unreplayed) {
          if (dlq.markReplayed(entry.id, true)) retried++;
        }
        res.json({ success: true, retried, total: unreplayed.length });
      } catch (err) {
        this.handleError(err, res, "Failed to retry all dead letters");
      }
    });

    app.delete("/api/dlq/purge", (_req: Request, res: Response) => {
      try {
        const dlq = this.getDeadLetterQueue();
        // Purge all: delete all DLQ entries
        const channels = dlq.listChannels();
        let deleted = 0;
        for (const ch of channels) {
          const entries = dlq.query({ channel: ch });
          for (const entry of entries) {
            if (dlq.delete(entry.id)) deleted++;
          }
        }
        res.json({ success: true, deleted });
      } catch (err) {
        this.handleError(err, res, "Failed to purge dead letter queue");
      }
    });

    app.delete("/api/dlq/:id", (req: Request, res: Response) => {
      try {
        const dlq = this.getDeadLetterQueue();
        const id = String(req.params.id);
        const ok = dlq.delete(id);
        if (!ok) {
          res.status(404).json({ error: "Dead letter not found" });
          return;
        }
        res.json({ success: true, id });
      } catch (err) {
        this.handleError(err, res, "Failed to delete dead letter");
      }
    });

    // ─── Health Aggregator API routes ──────────────────────────────────────

    app.get("/api/health/full", async (_req: Request, res: Response) => {
      try {
        const ha = this.getHealthAggregator();
        const report = await ha.checkAll();
        const statusMap: Record<string, string> = { ok: "healthy", down: "unhealthy", degraded: "degraded", unknown: "unknown" };
        const components = report.components.map((c: any) => ({
          name: c.name,
          status: statusMap[c.status] || c.status,
          latencyMs: c.responseTimeMs ?? -1,
          lastCheck: c.lastCheckedAt ? new Date(c.lastCheckedAt).toISOString() : "",
          message: c.error || undefined,
          details: c.metadata || undefined,
        }));
        res.json({ overall: statusMap[report.overall] || report.overall, components, timestamp: new Date(report.computedAt).toISOString() });
      } catch (err) {
        this.handleError(err, res, "Failed to get full health report");
      }
    });

    app.get("/api/health/component/:name", (req: Request, res: Response) => {
      try {
        const ha = this.getHealthAggregator();
        const name = String(req.params.name);
        const component = ha.getComponent(name);
        if (!component) {
          res.status(404).json({ error: "Component not found" });
          return;
        }
        const statusMap: Record<string, string> = { ok: "healthy", down: "unhealthy", degraded: "degraded", unknown: "unknown" };
        res.json({
          name: component.name,
          status: statusMap[component.status] || component.status,
          latencyMs: component.responseTimeMs ?? -1,
          lastCheck: component.lastCheckedAt ? new Date(component.lastCheckedAt).toISOString() : "",
          message: component.error || undefined,
          details: component.metadata || undefined,
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get component health");
      }
    });

    app.post("/api/health/component/:name/check", async (req: Request, res: Response) => {
      try {
        const ha = this.getHealthAggregator();
        const name = String(req.params.name);
        const result = await ha.checkComponent(name);
        if (!result) {
          res.status(404).json({ error: "Component not found" });
          return;
        }
        const statusMap: Record<string, string> = { ok: "healthy", down: "unhealthy", degraded: "degraded", unknown: "unknown" };
        res.json({
          name: result.name,
          status: statusMap[result.status] || result.status,
          latencyMs: result.responseTimeMs ?? -1,
          lastCheck: result.lastCheckedAt ? new Date(result.lastCheckedAt).toISOString() : "",
          message: result.error || undefined,
          details: result.metadata || undefined,
        });
      } catch (err) {
        this.handleError(err, res, "Failed to check component health");
      }
    });

    // ─── Reply Reference API routes ────────────────────────────────────────

    app.get("/api/reply-refs", (req: Request, res: Response) => {
      try {
        const rm = this.getReplyReferenceManager();
        const channelId = req.query.channelId as string | undefined;
        const rootId = req.query.rootId as string | undefined;
        const stats = {
          totalRefs: rm.countRefs(),
          totalChains: rm.countChains(),
        };

        if (rootId) {
          const tree = rm.getReplyTree(rootId);
          const nodesObj: Record<string, unknown> = {};
          for (const [key, value] of tree.nodes) {
            nodesObj[key] = value;
          }
          res.json({ success: true, stats, refs: [], tree: { ...tree, nodes: nodesObj } });
          return;
        }

        // Return all reply refs for the listing page
        const refs: Array<Record<string, unknown>> = [];
        // Iterate chains to build flat ref list
        for (const ref of (rm as any).refs.values() as Iterable<import("./reply-reference").ReplyRef>) {
          const entry: Record<string, unknown> = {
            id: ref.childId,
            parentId: ref.parentId,
            rootId: ref.chainId,
            author: ref.peer || "agent",
            content: `[reply] ${ref.parentId.slice(0, 8)}... → ${ref.childId.slice(0, 8)}...`,
            timestamp: new Date(ref.timestamp).toISOString(),
            channelId: ref.channel,
            depth: ref.depth,
            crossChannel: ref.crossChannel,
          };
          // Filter by channelId if specified
          if (channelId && ref.channel !== channelId) continue;
          refs.push(entry);
        }

        res.json({ success: true, stats, refs, channelId: channelId || null });
      } catch (err) {
        this.handleError(err, res, "Failed to list reply references");
      }
    });

    app.get("/api/reply-refs/:rootId/tree", (req: Request, res: Response) => {
      try {
        const rm = this.getReplyReferenceManager();
        const rootId = String(req.params.rootId);
        const tree = rm.getReplyTree(rootId);
        const nodesObj: Record<string, unknown> = {};
        for (const [key, value] of tree.nodes) {
          nodesObj[key] = value;
        }
        res.json({ success: true, tree: { ...tree, nodes: nodesObj } });
      } catch (err) {
        this.handleError(err, res, "Failed to get reply tree");
      }
    });

    app.get("/api/reply-refs/:rootId/chain", (req: Request, res: Response) => {
      try {
        const rm = this.getReplyReferenceManager();
        const rootId = String(req.params.rootId);
        const chain = rm.getChainContext(rootId);
        res.json({ success: true, chain });
      } catch (err) {
        this.handleError(err, res, "Failed to get reply chain");
      }
    });

    app.post("/api/reply-refs", (req: Request, res: Response) => {
      try {
        const rm = this.getReplyReferenceManager();
        const { parentId, childId, channel } = req.body || {};
        if (!parentId || !childId) {
          res.status(400).json({ error: "parentId and childId are required" });
          return;
        }
        rm.record(parentId, childId, { channel: channel || "unknown" });
        res.json({ success: true });
      } catch (err) {
        this.handleError(err, res, "Failed to record reply reference");
      }
    });

    // ─── Message Template API routes ───────────────────────────────────────

    app.get("/api/message-templates", (_req: Request, res: Response) => {
      try {
        const engine = this.getMessageTemplateEngine();
        const names = engine.listTemplates();
        const templates = names.map((name) => ({
          id: name,
          content: engine.getTemplate(name),
        }));
        res.json({ success: true, templates });
      } catch (err) {
        this.handleError(err, res, "Failed to list message templates");
      }
    });

    app.get("/api/message-templates/:id", (req: Request, res: Response) => {
      try {
        const engine = this.getMessageTemplateEngine();
        const id = String(req.params.id);
        const content = engine.getTemplate(id);
        if (content === null) {
          res.status(404).json({ error: "Template not found" });
          return;
        }
        res.json({ success: true, id, content });
      } catch (err) {
        this.handleError(err, res, "Failed to get message template");
      }
    });

    app.post("/api/message-templates", (req: Request, res: Response) => {
      try {
        const engine = this.getMessageTemplateEngine();
        const { id, content } = req.body || {};
        if (!id || !content) {
          res.status(400).json({ error: "id and content are required" });
          return;
        }
        engine.register(String(id), String(content));
        res.status(201).json({ success: true, id });
      } catch (err) {
        this.handleError(err, res, "Failed to create message template");
      }
    });

    app.put("/api/message-templates/:id", (req: Request, res: Response) => {
      try {
        const engine = this.getMessageTemplateEngine();
        const id = String(req.params.id);
        const { content } = req.body || {};
        if (!content) {
          res.status(400).json({ error: "content is required" });
          return;
        }
        engine.register(id, String(content));
        res.json({ success: true, id });
      } catch (err) {
        this.handleError(err, res, "Failed to update message template");
      }
    });

    app.delete("/api/message-templates/:id", (req: Request, res: Response) => {
      try {
        const engine = this.getMessageTemplateEngine();
        const id = String(req.params.id);
        const removed = engine.unregister(id);
        if (!removed) {
          res.status(404).json({ error: "Template not found" });
          return;
        }
        res.json({ success: true, id });
      } catch (err) {
        this.handleError(err, res, "Failed to delete message template");
      }
    });

    app.post("/api/message-templates/:id/render", (req: Request, res: Response) => {
      try {
        const engine = this.getMessageTemplateEngine();
        const id = String(req.params.id);
        const { variables, format } = req.body || {};
        const rendered = engine.renderNamed(id, variables || {}, format);
        res.json({ success: true, id, rendered });
      } catch (err) {
        this.handleError(err, res, "Failed to render message template");
      }
    });

    // ─── Secrets Manager API routes ──────────────────────────────────────

    app.get("/api/secrets", (_req: Request, res: Response) => {
      try {
        const secrets = Array.from(this.secretsStore.values()).map((s: any) => ({
          name: s.name,
          source: s.source,
          createdAt: s.createdAt,
          expiresAt: s.expiresAt,
          revoked: s.revoked,
          rotationVersion: s.rotationVersion,
          lastRotatedAt: s.lastRotatedAt,
        }));
        res.json({ secrets });
      } catch (err) {
        this.handleError(err, res, "Failed to list secrets");
      }
    });

    app.post("/api/secrets", (req: Request, res: Response) => {
      try {
        const { name, value, ttlMs } = req.body || {};
        if (!name || !value) {
          res.status(400).json({ error: "name and value are required" });
          return;
        }
        const now = new Date().toISOString();
        const entry: any = {
          name,
          value,
          source: "registered",
          createdAt: now,
          expiresAt: ttlMs ? new Date(Date.now() + ttlMs).toISOString() : undefined,
          revoked: false,
          rotationVersion: 0,
          lastRotatedAt: undefined,
        };
        this.secretsStore.set(name, entry);
        this.addSecretsAuditEntry({
          secretName: name,
          operation: "register",
          accessedBy: "api",
          timestamp: now,
          success: true,
        });
        this.persistSecrets();
        res.status(201).json({
          name: entry.name,
          source: entry.source,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
          revoked: entry.revoked,
          rotationVersion: entry.rotationVersion,
          lastRotatedAt: entry.lastRotatedAt,
        });
      } catch (err) {
        this.handleError(err, res, "Failed to register secret");
      }
    });

    app.get("/api/secrets/audit", (req: Request, res: Response) => {
      try {
        const name = req.query.name as string | undefined;
        const logs = name
          ? this.secretsAuditLog.filter((l: any) => l.secretName === name)
          : this.secretsAuditLog;
        res.json({ logs });
      } catch (err) {
        this.handleError(err, res, "Failed to get audit logs");
      }
    });

    app.post("/api/secrets/generate-apikey", (req: Request, res: Response) => {
      try {
        const { prefix } = req.body || {};
        const key = `${prefix || "evc"}_${Date.now().toString(36)}_${crypto.randomBytes(8).toString("hex")}`;
        const name = `apikey_${prefix || "default"}_${Date.now()}`;
        const now = new Date().toISOString();
        this.secretsStore.set(name, {
          name,
          value: key,
          source: "registered",
          createdAt: now,
          revoked: false,
          rotationVersion: 0,
        });
        this.addSecretsAuditEntry({
          secretName: name,
          operation: "generate-apikey",
          accessedBy: "api",
          timestamp: now,
          success: true,
        });
        this.persistSecrets();
        res.json({ apiKey: key, name });
      } catch (err) {
        this.handleError(err, res, "Failed to generate API key");
      }
    });

    app.post("/api/secrets/:name/get", (req: Request, res: Response) => {
      try {
        const name = String(req.params.name);
        const { requester } = req.body || {};
        const entry = this.secretsStore.get(name);
        if (!entry) {
          res.status(404).json({ error: "Secret not found" });
          return;
        }
        if (entry.revoked) {
          res.status(403).json({ error: "Secret has been revoked" });
          return;
        }
        this.addSecretsAuditEntry({
          secretName: name,
          operation: "get",
          accessedBy: requester || "api",
          timestamp: new Date().toISOString(),
          success: true,
        });
        const maskedValue = entry.value && entry.value.length > 8
          ? entry.value.slice(0, 4) + "****" + entry.value.slice(-4)
          : "****";
        res.json({ value: maskedValue, masked: true });
      } catch (err) {
        this.handleError(err, res, "Failed to get secret");
      }
    });

    app.post("/api/secrets/:name/rotate", async (req: Request, res: Response) => {
      try {
        const name = String(req.params.name);
        const entry = this.secretsStore.get(name);
        if (!entry) {
          res.status(404).json({ error: "Secret not found" });
          return;
        }
        const now = new Date().toISOString();
        entry.rotationVersion += 1;
        entry.lastRotatedAt = now;
        // Generate a new random value instead of appending version suffix
        const crypto = await import("crypto");
        entry.value = crypto.randomBytes(32).toString("hex");
        this.addSecretsAuditEntry({
          secretName: name,
          operation: "rotate",
          accessedBy: "api",
          timestamp: now,
          success: true,
        });
        this.persistSecrets();
        res.json({
          name: entry.name,
          source: entry.source,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
          revoked: entry.revoked,
          rotationVersion: entry.rotationVersion,
          lastRotatedAt: entry.lastRotatedAt,
        });
      } catch (err) {
        this.handleError(err, res, "Failed to rotate secret");
      }
    });

    app.post("/api/secrets/:name/revoke", (req: Request, res: Response) => {
      try {
        const name = String(req.params.name);
        const entry = this.secretsStore.get(name);
        if (!entry) {
          res.status(404).json({ error: "Secret not found" });
          return;
        }
        entry.revoked = true;
        this.addSecretsAuditEntry({
          secretName: name,
          operation: "revoke",
          accessedBy: "api",
          timestamp: new Date().toISOString(),
          success: true,
        });
        this.persistSecrets();
        res.status(204).end();
      } catch (err) {
        this.handleError(err, res, "Failed to revoke secret");
      }
    });

    app.delete("/api/secrets/:name", (req: Request, res: Response) => {
      try {
        const name = String(req.params.name);
        const deleted = this.secretsStore.delete(name);
        if (!deleted) {
          res.status(404).json({ error: "Secret not found" });
          return;
        }
        this.addSecretsAuditEntry({
          secretName: name,
          operation: "delete",
          accessedBy: "api",
          timestamp: new Date().toISOString(),
          success: true,
        });
        this.persistSecrets();
        res.status(204).end();
      } catch (err) {
        this.handleError(err, res, "Failed to delete secret");
      }
    });

    // ─── Config RPC API routes ──────────────────────────────────────────

    app.get("/api/config-rpc", (req: Request, res: Response) => {
      try {
        this.ensureConfigRpcInitialized();
        const prefix = req.query.prefix as string | undefined;
        const configManager = this.registry.resolveService<{
          list(prefix?: string): Array<{ path: string; value: unknown; source: string }>;
        }>("configManager");
        if (configManager) {
          const entries = configManager.list(prefix);
          res.json({ entries });
          return;
        }
        let entries = Array.from(this.configRpcStore.entries()).map(([p, v]) => ({
          path: p,
          value: v,
          source: "memory",
        }));
        if (prefix) {
          entries = entries.filter((e) => e.path.startsWith(prefix));
        }
        res.json({ entries });
      } catch (err) {
        this.handleError(err, res, "Failed to list config entries");
      }
    });

    app.post("/api/config-rpc/batch", (req: Request, res: Response) => {
      try {
        const { paths } = req.body || {};
        if (!Array.isArray(paths)) {
          res.status(400).json({ error: "paths must be an array" });
          return;
        }
        const configManager = this.registry.resolveService<{
          batchGet(paths: string[]): Array<{ path: string; value: unknown }>;
        }>("configManager");
        if (configManager) {
          const results = configManager.batchGet(paths);
          res.json({ results });
          return;
        }
        const results = paths.map((p: string) => ({
          path: p,
          value: this.configRpcStore.has(p) ? this.configRpcStore.get(p) : null,
        }));
        res.json({ results });
      } catch (err) {
        this.handleError(err, res, "Failed to batch read config");
      }
    });

    app.get("/api/config-rpc/:path", (req: Request, res: Response) => {
      try {
        this.ensureConfigRpcInitialized();
        const dotPath = String(req.params.path);
        const configManager = this.registry.resolveService<{
          get(path: string): { path: string; value: unknown } | null;
        }>("configManager");
        if (configManager) {
          const result = configManager.get(dotPath);
          if (!result) {
            res.status(404).json({ error: "Config path not found" });
            return;
          }
          res.json(result);
          return;
        }
        if (!this.configRpcStore.has(dotPath)) {
          res.status(404).json({ error: "Config path not found" });
          return;
        }
        res.json({ path: dotPath, value: this.configRpcStore.get(dotPath) });
      } catch (err) {
        this.handleError(err, res, "Failed to read config");
      }
    });

    app.post("/api/config-rpc/:path", (req: Request, res: Response) => {
      try {
        const dotPath = String(req.params.path);
        const { value } = req.body || {};
        const configManager = this.registry.resolveService<{
          set(path: string, value: unknown): { path: string; value: unknown };
        }>("configManager");
        if (configManager) {
          const result = configManager.set(dotPath, value);
          res.json(result);
          return;
        }
        this.configRpcStore.set(dotPath, value);
        res.json({ path: dotPath, value });
      } catch (err) {
        this.handleError(err, res, "Failed to write config");
      }
    });

    app.post("/api/config-rpc/:path/watch", (req: Request, res: Response) => {
      try {
        const dotPath = String(req.params.path);
        const subscriptionId = `sub_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
        if (!this.configRpcWatchers.has(dotPath)) {
          this.configRpcWatchers.set(dotPath, []);
        }
        const list = this.configRpcWatchers.get(dotPath)!;
        // 防止 Map 无限增长：每路径最多保留 100 个订阅，超出时淘汰最旧的
        const MAX_WATCHERS_PER_PATH = 100;
        if (list.length >= MAX_WATCHERS_PER_PATH) {
          list.splice(0, list.length - MAX_WATCHERS_PER_PATH + 1);
        }
        list.push({ subscriptionId });
        res.json({ subscriptionId });
      } catch (err) {
        this.handleError(err, res, "Failed to watch config path");
      }
    });

    // 取消订阅，清理 watcher
    app.delete("/api/config-rpc/:path/watch/:subscriptionId", (req: Request, res: Response) => {
      try {
        const dotPath = String(req.params.path);
        const subscriptionId = String(req.params.subscriptionId);
        const list = this.configRpcWatchers.get(dotPath);
        if (list) {
          const idx = list.findIndex((w) => w.subscriptionId === subscriptionId);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) this.configRpcWatchers.delete(dotPath);
        }
        res.json({ success: true });
      } catch (err) {
        this.handleError(err, res, "Failed to unwatch config path");
      }
    });

    // ─── Model Switcher API routes ──────────────────────────────────────

    app.get("/api/models", (_req: Request, res: Response) => {
      try {
        const modelSwitcher = this.registry.resolveService<{
          listModels(): Array<{
            id: string; name: string; provider: string;
            model: string; capabilities: string[];
            maxTokens: number; costPer1k: { input: number; output: number };
            status: string;
          }>;
        }>("modelSwitcher");
        if (modelSwitcher) {
          const models = modelSwitcher.listModels();
          res.json({ models });
          return;
        }
        const models = Array.from(this.modelsStore.values());
        res.json({ models });
      } catch (err) {
        this.handleError(err, res, "Failed to list models");
      }
    });

    app.get("/api/models/current", (_req: Request, res: Response) => {
      try {
        const modelSwitcher = this.registry.resolveService<{
          getCurrentModel(): {
            id: string; name: string; provider: string;
            model: string; capabilities: string[];
            maxTokens: number; costPer1k: { input: number; output: number };
            status: string;
          };
        }>("modelSwitcher");
        if (modelSwitcher) {
          const model = modelSwitcher.getCurrentModel();
          res.json({ model });
          return;
        }
        const model = this.currentModelId
          ? this.modelsStore.get(this.currentModelId)
          : null;
        if (!model) {
          // Fallback: return the first active provider from saved LLM providers
          const providers = this.savedLLMProviders;
          if (providers && providers.length > 0) {
            const activeProvider = providers.find((p: any) => p.enabled !== false) || providers[0];
            res.json({
              model: {
                id: (activeProvider as any).id || (activeProvider as any).name,
                name: (activeProvider as any).name || (activeProvider as any).id,
                provider: (activeProvider as any).provider || (activeProvider as any).name,
                model: (activeProvider as any).model || (activeProvider as any).defaultModel || "",
                status: "active",
              },
            });
            return;
          }
          res.status(404).json({ error: "No current model configured" });
          return;
        }
        res.json({ model });
      } catch (err) {
        this.handleError(err, res, "Failed to get current model");
      }
    });

    app.post("/api/models/switch", (req: Request, res: Response) => {
      try {
        const { modelId } = req.body || {};
        if (!modelId) {
          res.status(400).json({ error: "modelId is required" });
          return;
        }
        const modelSwitcher = this.registry.resolveService<{
          switchModel(modelId: string): { previous: string; current: string };
        }>("modelSwitcher");
        if (modelSwitcher) {
          const result = modelSwitcher.switchModel(modelId);
          res.json(result);
          return;
        }
        const previous = this.currentModelId;
        if (!this.modelsStore.has(modelId)) {
          res.status(404).json({ error: "Model not found" });
          return;
        }
        this.currentModelId = modelId;
        res.json({ previous, current: modelId });
      } catch (err) {
        this.handleError(err, res, "Failed to switch model");
      }
    });

    app.post("/api/models/test", (req: Request, res: Response) => {
      try {
        const { modelId } = req.body || {};
        if (!modelId) {
          res.status(400).json({ error: "modelId is required" });
          return;
        }
        const modelSwitcher = this.registry.resolveService<{
          testModel(modelId: string): { success: boolean; latencyMs: number };
        }>("modelSwitcher");
        if (modelSwitcher) {
          const result = modelSwitcher.testModel(modelId);
          res.json(result);
          return;
        }
        const start = Date.now();
        const exists = this.modelsStore.has(modelId);
        const latencyMs = Date.now() - start;
        res.json({ success: exists, latencyMs });
      } catch (err) {
        this.handleError(err, res, "Failed to test model");
      }
    });

    // ─── Retention API routes ───────────────────────────────────────────

    app.get("/api/retention/policy", (_req: Request, res: Response) => {
      try {
        res.json({ policy: this.retentionPolicy });
      } catch (err) {
        this.handleError(err, res, "Failed to get retention policy");
      }
    });

    app.put("/api/retention/policy", (req: Request, res: Response) => {
      try {
        const { policy } = req.body || {};
        if (!policy) {
          res.status(400).json({ error: "policy is required" });
          return;
        }
        // 过滤危险键防止原型污染
        const safePolicy = { ...policy };
        delete (safePolicy as any).__proto__;
        delete (safePolicy as any).constructor;
        delete (safePolicy as any).prototype;
        Object.assign(this.retentionPolicy, safePolicy);
        res.json({ policy: this.retentionPolicy });
      } catch (err) {
        this.handleError(err, res, "Failed to update retention policy");
      }
    });

    app.get("/api/retention/stats", async (_req: Request, res: Response) => {
      try {
        const sessionManager = this.registry.resolveService<any>("sessionManager");
        let allSessions: any[] = [];
        if (sessionManager) {
          const agents: string[] = sessionManager.listAgents?.() || [];
          for (const agentId of agents) {
            const agentSessions = sessionManager.listSessions?.(agentId) || [];
            if (Array.isArray(agentSessions)) {
              allSessions = allSessions.concat(agentSessions);
            }
          }
        }
        const totalSessions = allSessions.length;
        const now = Date.now();
        const maxAgeMs = (this.retentionPolicy.maxAgeDays || 30) * 86400000;
        const maxInactiveMs = (this.retentionPolicy.maxInactiveDays || 7) * 86400000;
        let expiredSessions = 0;
        for (const s of allSessions) {
          const lastActive = s.lastActivityAt || s.updatedAt || s.createdAt || 0;
          const created = s.createdAt || 0;
          if ((now - lastActive > maxInactiveMs) || (now - created > maxAgeMs)) {
            expiredSessions++;
          }
        }
        res.json({
          totalSessions,
          expiredSessions,
          cleanedUp: this.retentionStats.cleanedUp || 0,
          lastRun: this.retentionStats.lastRun || "",
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get retention stats");
      }
    });

    app.post("/api/retention/run", async (_req: Request, res: Response) => {
      try {
        const sessionManager = this.registry.resolveService<any>("sessionManager");
        let cleaned = 0;
        if (sessionManager) {
          const agents: string[] = sessionManager.listAgents?.() || [];
          let allSessions: any[] = [];
          for (const agentId of agents) {
            const agentSessions = sessionManager.listSessions?.(agentId) || [];
            if (Array.isArray(agentSessions)) {
              allSessions = allSessions.concat(agentSessions);
            }
          }
          const now = Date.now();
          const maxAgeMs = (this.retentionPolicy.maxAgeDays || 30) * 86400000;
          const maxInactiveMs = (this.retentionPolicy.maxInactiveDays || 7) * 86400000;
          const executor = this.registry.resolveService<{ clearChatHistory(sessionId?: string): void }>("agentModelExecutor");
          for (const s of allSessions) {
            const lastActive = s.lastActivityAt || s.updatedAt || s.createdAt || 0;
            const created = s.createdAt || 0;
            if ((now - lastActive > maxInactiveMs) || (now - created > maxAgeMs)) {
              const sid = s.id || s.sessionId;
              let deleted = false;
              if (sid && sessionManager.deleteSession?.(sid)) deleted = true;
              else if (sid && sessionManager.removeSession?.(sid)) deleted = true;
              else if (sid && sessionManager.destroySession?.(sid)) deleted = true;
              if (deleted) {
                try { executor?.clearChatHistory(sid); } catch { /* ignore */ }
                cleaned++;
              }
            }
          }
        }
        this.retentionStats.cleanedUp = (this.retentionStats.cleanedUp || 0) + cleaned;
        this.retentionStats.lastRun = new Date().toISOString();
        res.json({ cleaned });
      } catch (err) {
        this.handleError(err, res, "Failed to run retention cleanup");
      }
    });

    // ─── Feature Flags API routes ───────────────────────────────────────

    const getFlagStore = (): FeatureFlagStore | null => {
      try {
        return this.registry.resolveService<FeatureFlagStore>("featureFlagStore") ?? null;
      } catch (err) { console.debug("[ProtocolAdapter]", err instanceof Error ? err.message : String(err)); return null; }
    };

    app.get("/api/feature-flags", (_req: Request, res: Response) => {
      try {
        const store = getFlagStore();
        const flags = store ? store.listFlags().map(f => ({
          key: f.key,
          name: f.key,
          description: f.description,
          enabled: f.enabled,
          defaultValue: f.enabled,
          rolloutPercent: f.rolloutPercent,
          environments: f.environments,
          owner: f.owner,
          updatedAt: new Date(f.updatedAt).toISOString(),
        })) : [];
        res.json({ flags });
      } catch (err) {
        this.handleError(err, res, "Failed to list feature flags");
      }
    });

    app.get("/api/feature-flags/:key", (req: Request, res: Response) => {
      try {
        const key = String(req.params.key);
        const store = getFlagStore();
        if (!store) {
          res.status(404).json({ error: "Feature flag store not available" });
          return;
        }
        const flag = store.getFlag(key);
        if (!flag) {
          res.status(404).json({ error: "Feature flag not found" });
          return;
        }
        res.json({
          key: flag.key,
          name: flag.key,
          description: flag.description,
          enabled: flag.enabled,
          defaultValue: flag.enabled,
          rolloutPercent: flag.rolloutPercent,
          environments: flag.environments,
          owner: flag.owner,
          updatedAt: new Date(flag.updatedAt).toISOString(),
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get feature flag");
      }
    });

    app.post("/api/feature-flags/:key", (req: Request, res: Response) => {
      try {
        const key = String(req.params.key);
        const { enabled } = req.body || {};
        if (typeof enabled !== "boolean") {
          res.status(400).json({ error: "enabled must be a boolean" });
          return;
        }
        const store = getFlagStore();
        if (!store) {
          res.status(503).json({ error: "Feature flag store not available" });
          return;
        }
        const existing = store.getFlag(key);
        if (existing) {
          if (enabled) {
            store.enable(key);
          } else {
            store.disable(key);
          }
        } else {
          // Register a new flag on-the-fly
          store.register({
            key,
            description: "",
            enabled,
            updatedAt: Date.now(),
          });
        }
        const updated = store.getFlag(key)!;
        res.json({
          key: updated.key,
          name: updated.key,
          description: updated.description,
          enabled: updated.enabled,
          defaultValue: updated.enabled,
          rolloutPercent: updated.rolloutPercent,
          owner: updated.owner,
          updatedAt: new Date(updated.updatedAt).toISOString(),
        });
      } catch (err) {
        this.handleError(err, res, "Failed to set feature flag");
      }
    });

    app.post("/api/feature-flags/:key/evaluate", (req: Request, res: Response) => {
      try {
        const key = String(req.params.key);
        const { context } = req.body || {};
        const store = getFlagStore();
        if (!store) {
          res.status(503).json({ error: "Feature flag store not available" });
          return;
        }
        const flag = store.getFlag(key);
        if (!flag) {
          res.status(404).json({ error: "Feature flag not found" });
          return;
        }
        const userId = context?.userId as string | undefined;
        const channel = context?.channel as string | undefined;
        const result = store.evaluate(key, { userId, channel, context });
        const reason = result ? "flag_enabled" : "flag_disabled";
        res.json({ enabled: result, reason });
      } catch (err) {
        this.handleError(err, res, "Failed to evaluate feature flag");
      }
    });

    // ─── Config Migration API routes ────────────────────────────────────

    app.get("/api/config/migrations", (_req: Request, res: Response) => {
      const migrations = Array.from(this.migrationsStore.values());
      res.json({ migrations });
    });

    app.post("/api/config/migrations/:id/run", async (req: Request, res: Response) => {
      try {
        const id = String(req.params.id);
        const now = new Date().toISOString();
        const config = this.registry.resolveService<any>("config");
        const currentConfig = config?.get ? (config.get("") || {}) : {};
        const snapshotId = `pre-migration-${id}`;
        this.configSnapshots.set(snapshotId, { config: JSON.parse(JSON.stringify(currentConfig)), timestamp: now });
        // 上限保护：保留最近 50 条快照，避免无界增长
        while (this.configSnapshots.size > 50) {
          const oldest = this.configSnapshots.keys().next().value;
          if (oldest) this.configSnapshots.delete(oldest);
          else break;
        }
        const migration = {
          id,
          fromVersion: String(this.migrationVersion),
          toVersion: String(this.migrationVersion + 1),
          status: "completed",
          startedAt: now,
          completedAt: now,
          changes: [{ action: "snapshot", path: "*", description: "配置快照已保存" }],
          snapshotId,
        };
        this.migrationVersion++;
        this.migrationsStore.set(id, migration);
        this.persistMigrations();
        res.json(migration);
      } catch (err) {
        this.handleError(err, res, "Failed to run migration");
      }
    });

    app.post("/api/config/migrations/:id/rollback", async (req: Request, res: Response) => {
      try {
        const id = String(req.params.id);
        const migration = this.migrationsStore.get(id);
        if (!migration) {
          res.status(404).json({ error: "Migration not found" });
          return;
        }
        const snapshot = this.configSnapshots.get(migration.snapshotId);
        const failedKeys: string[] = [];
        if (snapshot) {
          const config = this.registry.resolveService<any>("config");
          if (config?.set) {
            for (const [key, value] of Object.entries(snapshot.config)) {
              try { config.set(key, value); } catch (err) { process.stderr.write(`[ProtocolAdapter] Config rollback failed for key "${key}":` + " " + err + "\n"); failedKeys.push(key); }
            }
          }
        }
        migration.status = "rolled_back";
        migration.completedAt = new Date().toISOString();
        this.migrationVersion = Math.max(0, this.migrationVersion - 1);
        this.persistMigrations();
        res.json({ ...migration, rollbackFailures: failedKeys.length > 0 ? failedKeys : undefined });
      } catch (err) {
        this.handleError(err, res, "Failed to rollback migration");
      }
    });

    app.get("/api/config/migration-status", (_req: Request, res: Response) => {
      const migrations = Array.from(this.migrationsStore.values());
      const lastMigration = migrations.length > 0 ? migrations[migrations.length - 1] : undefined;
      const pendingCount = migrations.filter((m: any) => m.status === "pending").length;
      res.json({
        currentVersion: String(this.migrationVersion),
        pendingCount,
        lastMigration,
      });
    });

    // ─── Config Doctor API routes ───────────────────────────────────────

    app.get("/api/config/doctor", (_req: Request, res: Response) => {
      try {
        const issues = this.runConfigDiagnostics();
        const healthy = issues.filter((i: any) => i.severity === "error").length === 0;
        res.json({ issues, healthy });
      } catch (err) {
        this.handleError(err, res, "Failed to run diagnostics");
      }
    });

    app.post("/api/config/doctor/fix", (req: Request, res: Response) => {
      try {
        const { path, value } = req.body || {};
        const config = this.registry.resolveService<any>("config");
        if (config?.set) {
          config.set(path, value);
          res.json({ fixed: true });
        } else if (this.configRpcStore) {
          this.configRpcStore.set(path, value);
          res.json({ fixed: true });
        } else {
          res.json({ fixed: false });
        }
      } catch (err) {
        this.handleError(err, res, "Failed to fix issue");
      }
    });

    app.post("/api/config/doctor/fix-all", (_req: Request, res: Response) => {
      try {
        const issues = this.runConfigDiagnostics();
        let fixed = 0;
        for (const issue of issues) {
          if (issue.suggestion !== undefined && issue.severity !== "error") {
            const config = this.registry.resolveService<any>("config");
            if (config?.set) { config.set(issue.path, issue.suggestion); fixed++; }
            else if (this.configRpcStore) { this.configRpcStore.set(issue.path, issue.suggestion); fixed++; }
          }
        }
        res.json({ fixed, remaining: issues.length - fixed });
      } catch (err) {
        this.handleError(err, res, "Failed to fix all issues");
      }
    });

    // ─── Canvas API routes ────────────────────────────────────────────

    // List all canvas projects
    app.get("/api/canvas/projects", (_req: Request, res: Response) => {
      try {
        const projects = this.canvasHost.listProjects();
        res.json({ projects, total: projects.length });
      } catch (err) {
        this.handleError(err, res, "Failed to list canvas projects");
      }
    });

    // Create a new canvas project
    app.post("/api/canvas/projects", (req: Request, res: Response) => {
      try {
        const { name, html } = req.body || {};
        if (!name || typeof name !== "string") {
          res.status(400).json({ error: "Project name is required" });
          return;
        }
        const project = this.canvasHost.createProject(name, html);
        res.status(201).json(project);
      } catch (err) {
        this.handleError(err, res, "Failed to create canvas project");
      }
    });

    // Get a canvas project
    app.get("/api/canvas/projects/:id", (req: Request, res: Response) => {
      try {
        const project = this.canvasHost.getProject(String(req.params.id));
        if (!project) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        res.json(project);
      } catch (err) {
        this.handleError(err, res, "Failed to get canvas project");
      }
    });

    // Delete a canvas project
    app.delete("/api/canvas/projects/:id", (req: Request, res: Response) => {
      try {
        const ok = this.canvasHost.deleteProject(String(req.params.id));
        if (!ok) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        res.json({ deleted: true });
      } catch (err) {
        this.handleError(err, res, "Failed to delete canvas project");
      }
    });

    // Read a file from a canvas project
    app.get("/api/canvas/projects/:id/files/:filename", (req: Request, res: Response) => {
      try {
        const content = this.canvasHost.readFile(String(req.params.id), String(req.params.filename));
        if (content === null) {
          res.status(404).json({ error: "File not found" });
          return;
        }
        res.type("text/plain").send(content);
      } catch (err) {
        this.handleError(err, res, "Failed to read canvas file");
      }
    });

    // Write a file to a canvas project
    app.put("/api/canvas/projects/:id/files/:filename", (req: Request, res: Response) => {
      try {
        const { content } = req.body || {};
        if (typeof content !== "string") {
          res.status(400).json({ error: "File content is required" });
          return;
        }
        const ok = this.canvasHost.writeFile(String(req.params.id), String(req.params.filename), content);
        if (!ok) {
          res.status(404).json({ error: "Project not found or invalid filename" });
          return;
        }
        res.json({ written: true });
      } catch (err) {
        this.handleError(err, res, "Failed to write canvas file");
      }
    });

    // Eval script in canvas context
    app.post("/api/canvas/projects/:id/eval", (req: Request, res: Response) => {
      try {
        const { script } = req.body || {};
        if (!script || typeof script !== "string") {
          res.status(400).json({ error: "Script is required" });
          return;
        }
        const result = this.canvasHost.evalScript(String(req.params.id), script);
        res.json(result);
      } catch (err) {
        this.handleError(err, res, "Failed to eval canvas script");
      }
    });

    // Get project snapshot
    app.get("/api/canvas/projects/:id/snapshot", (req: Request, res: Response) => {
      try {
        const snapshot = this.canvasHost.snapshot(String(req.params.id));
        if (!snapshot) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        res.json(snapshot);
      } catch (err) {
        this.handleError(err, res, "Failed to get canvas snapshot");
      }
    });

    // A2UI push — receive JSONL data and broadcast to frontend
    app.post("/api/canvas/a2ui-push", (req: Request, res: Response) => {
      try {
        const { projectId, data } = req.body || {};
        if (!projectId || typeof projectId !== "string") {
          res.status(400).json({ error: "projectId is required" });
          return;
        }
        if (!data) {
          res.status(400).json({ error: "data is required" });
          return;
        }
        this.canvasHost.emit("a2ui-push", { projectId, data, timestamp: Date.now() });
        res.json({ received: true });
      } catch (err) {
        this.handleError(err, res, "Failed to process A2UI push");
      }
    });

    // SSE event stream for real-time canvas updates
    app.get("/api/canvas/events", (req: Request, res: Response) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("data: {\"type\":\"connected\"}\n\n");

      // 与 chat SSE 一致，每条 write 包 try/catch：客户端断连后 res.write
      // 会抛 ERR_STREAM_WRITE_AFTER_END，若不捕获会变成未处理异常。
      const onFileChanged = (evt: { projectId: string; filename: string }) => {
        try { res.write(`data: ${JSON.stringify({ type: "file-changed", ...evt })}\n\n`); } catch { /* client gone */ }
      };
      const onProjectCreated = (project: any) => {
        try { res.write(`data: ${JSON.stringify({ type: "project-created", projectId: project.id })}\n\n`); } catch { /* client gone */ }
      };
      const onProjectDeleted = (id: string) => {
        try { res.write(`data: ${JSON.stringify({ type: "project-deleted", projectId: id })}\n\n`); } catch { /* client gone */ }
      };
      const onA2uiPush = (evt: { projectId: string; data: any; timestamp: number }) => {
        try { res.write(`data: ${JSON.stringify({ type: "a2ui-push", ...evt })}\n\n`); } catch { /* client gone */ }
      };

      this.canvasHost.on("file-changed", onFileChanged);
      this.canvasHost.on("project-created", onProjectCreated);
      this.canvasHost.on("project-deleted", onProjectDeleted);
      this.canvasHost.on("a2ui-push", onA2uiPush);

      req.on("close", () => {
        this.canvasHost.off("file-changed", onFileChanged);
        this.canvasHost.off("project-created", onProjectCreated);
        this.canvasHost.off("project-deleted", onProjectDeleted);
        this.canvasHost.off("a2ui-push", onA2uiPush);
      });
    });

    // ── 符号画布（SymbolicMemoryCanvas）路由 ──
    // 借鉴 Infinite-Canvas 的可视化节点图思路，暴露 Agent 执行过程中累积的
    // 任务状态节点图（工具调用 → 节点，节点间自动连线）。

    // GET /api/canvas-graph/snapshot — 返回当前画布的完整节点+边数据
    app.get("/api/canvas-graph/snapshot", (_req: Request, res: Response) => {
      try {
        const hub = this.registry.resolveService<{
          getCanvasSnapshot(): { nodes: unknown[]; edges: unknown[]; sessionKey: string; createdAt: number } | null;
        }>("memoryHub");
        if (!hub) {
          res.status(503).json({ error: "MemoryHub not available" });
          return;
        }
        const snapshot = hub.getCanvasSnapshot();
        if (!snapshot) {
          res.json({ active: false, nodes: [], edges: [], sessionKey: "", createdAt: 0 });
          return;
        }
        res.json({ active: true, ...snapshot });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/canvas-graph/mermaid — 返回当前画布的 Mermaid 文本
    app.get("/api/canvas-graph/mermaid", (_req: Request, res: Response) => {
      try {
        const hub = this.registry.resolveService<{ getCanvasMermaid(): string }>("memoryHub");
        if (!hub) {
          res.status(503).json({ error: "MemoryHub not available" });
          return;
        }
        const mermaid = hub.getCanvasMermaid();
        res.type("text/plain").send(mermaid || "");
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // POST /api/canvas-graph/apply-ops — 应用 CanvasAgentOp 数组到画布
    // 借鉴 Infinite-Canvas 的 canvas_apply_ops：前端/Agent 通过 ops 修改画布
    app.post("/api/canvas-graph/apply-ops", (req: Request, res: Response) => {
      try {
        const hub = this.registry.resolveService<{
          applyCanvasOps(ops: unknown[]): { nodes: unknown[]; edges: unknown[] } | null;
        }>("memoryHub");
        if (!hub) {
          res.status(503).json({ error: "MemoryHub not available" });
          return;
        }
        const ops = Array.isArray(req.body?.ops) ? req.body.ops : [];
        if (ops.length === 0) {
          res.status(400).json({ error: "Missing 'ops' array in body" });
          return;
        }
        const result = hub.applyCanvasOps(ops);
        if (!result) {
          res.json({ active: false, nodes: [], edges: [] });
          return;
        }
        res.json({ active: true, ...result });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // ── 分层记忆 Stats API ──
    // 暴露 L0/L1/L2/L3 各层状态指标，供 WebUI MemoryHubPage 展示。

    app.get("/api/memory/layered-stats", (_req: Request, res: Response) => {
      try {
        const hub = this.registry.resolveService<{ getLayeredStats(): unknown }>("memoryHub");
        if (!hub) {
          res.status(503).json({ error: "MemoryHub not available" });
          return;
        }
        const stats = hub.getLayeredStats();
        if (!stats) {
          res.json({ active: false, turnCount: 0, l0: { sessionCount: 0, totalMessages: 0, sessions: [] }, l1: { totalMemories: 0, pendingCount: 0, dedupSkippedTotal: 0, byType: {}, byPriority: {} }, l2: { sceneCount: 0, lastTrigger: null }, l3: { personaEntries: 0, lastUpdatedAt: null }, canvas: { nodeCount: 0, edgeCount: 0, active: false, sessionKey: null }, config: {} });
          return;
        }
        res.json({ active: true, ...stats });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.get("/api/memory/semantic-search", async (req: Request, res: Response) => {
      try {
        const hub = this.registry.resolveService<{ semanticSearch(q: string, limit?: number): Promise<unknown[]> }>("memoryHub");
        if (!hub) {
          res.status(503).json({ error: "MemoryHub not available" });
          return;
        }
        const q = typeof req.query.q === "string" ? req.query.q : "";
        const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "10"), 10) || 10));
        const results = await hub.semanticSearch(q, limit);
        res.json({ query: q, results });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // ── Agent 工具缓存 / Token 预算 Stats API ──
    // 暴露 AgentModelExecutor 的 ToolResultCache 与 TokenBudgetOptimizer 状态。

    app.get("/api/agent/tool-cache-stats", (_req: Request, res: Response) => {
      try {
        const executor = this.registry.resolveService<{ getToolResultCacheStats(): unknown }>("agentModelExecutor");
        if (!executor) {
          res.json({ enabled: false, hits: 0, misses: 0, size: 0, hitRate: 0, byTool: {} });
          return;
        }
        const stats = executor.getToolResultCacheStats();
        res.json({ enabled: !!stats, ...(stats as object || {}) });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    app.get("/api/agent/token-budget-report", (_req: Request, res: Response) => {
      try {
        const executor = this.registry.resolveService<{ getTokenBudgetReport(): unknown }>("agentModelExecutor");
        if (!executor) {
          res.json({ enabled: false });
          return;
        }
        const report = executor.getTokenBudgetReport();
        res.json({ enabled: !!report, report });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // ── v0.70 借鉴 OpenSpace 闭环演化引擎：工具质量/录制/演化触发器/血缘 DAG ──

    // GET /api/agent/tool-quality-stats — 工具质量统计（惩罚因子/成功率/问题工具）
    app.get("/api/agent/tool-quality-stats", (_req: Request, res: Response) => {
      try {
        const executor = this.registry.resolveService<{ getToolQualityReport?: () => unknown }>("agentModelExecutor");
        if (!executor?.getToolQualityReport) {
          res.json({ enabled: false, summary: { totalTools: 0, problematicTools: 0 }, byTool: [], problematicTools: [], recommendations: [] });
          return;
        }
        const report = executor.getToolQualityReport();
        res.json({ enabled: true, ...(report as object || {}) });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/agent/recording-stats — 任务录制统计
    app.get("/api/agent/recording-stats", (_req: Request, res: Response) => {
      try {
        const executor = this.registry.resolveService<{ getRecordingStats?: () => unknown }>("agentModelExecutor");
        if (!executor?.getRecordingStats) {
          res.json({ enabled: false, recordings: [] });
          return;
        }
        const stats = executor.getRecordingStats();
        res.json({ enabled: true, stats });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/agent/evolution-trigger-stats — 三触发器演化统计
    app.get("/api/agent/evolution-trigger-stats", (_req: Request, res: Response) => {
      try {
        const executor = this.registry.resolveService<{ getEvolutionTriggerStats?: () => unknown }>("agentModelExecutor");
        if (!executor?.getEvolutionTriggerStats) {
          res.json({ enabled: false });
          return;
        }
        const stats = executor.getEvolutionTriggerStats();
        res.json({ enabled: true, stats });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/skills/lineage-stats — 技能版本血缘 DAG 统计
    app.get("/api/skills/lineage-stats", (_req: Request, res: Response) => {
      try {
        const skillMgr = this.registry.resolveService<{ getLineageStats?: () => unknown }>("skillManager");
        if (!skillMgr?.getLineageStats) {
          res.json({ enabled: false, totalLineages: 0, activeLineages: 0, roots: 0 });
          return;
        }
        const stats = skillMgr.getLineageStats();
        res.json({ enabled: true, ...(stats as object || {}) });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // ── v0.70 一线 AI Agent 能力对齐模块 stats 端点 ──
    // 7 类新工具（git/code-intel/apply-patch/vision/batch/workflow/checkpoint-dlq）
    // 模块本身无内置 stats 计数器，端点返回服务注册状态 + 占位 stats，供 WebUI 卡片确认服务可达。

    // GET /api/agent/git-stats — GitOperations 调用统计
    app.get("/api/agent/git-stats", (_req: Request, res: Response) => {
      try {
        const gitOps = this.registry.resolveService<unknown>("gitOperations");
        const available = !!gitOps;
        res.json({
          available,
          serviceName: "GitOperations",
          version: "v0.70",
          registered: available,
          note: available ? "stats counters not yet instrumented" : "service not registered",
          stats: {
            successCount: 0,
            failureCount: 0,
            lastInvokedAt: null,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/agent/code-intel-stats — CodeIntelligence 调用统计
    app.get("/api/agent/code-intel-stats", (_req: Request, res: Response) => {
      try {
        const codeIntel = this.registry.resolveService<unknown>("codeIntelligence");
        const available = !!codeIntel;
        res.json({
          available,
          serviceName: "CodeIntelligence",
          version: "v0.70",
          registered: available,
          note: available ? "stats counters not yet instrumented" : "service not registered",
          stats: {
            parseSymbols: 0,
            findReferences: 0,
            planRename: 0,
            applyRename: 0,
            cacheHitRate: 0,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/agent/apply-patch-stats — applyPatch 调用统计
    app.get("/api/agent/apply-patch-stats", (_req: Request, res: Response) => {
      try {
        // applyPatch 通过工具注册，无独立 service 实例
        const executor = this.registry.resolveService<{ getRegisteredTools?: () => Array<{ name: string }> }>("agentModelExecutor");
        const registered = !!executor?.getRegisteredTools?.().some((t) => t.name === "apply_patch");
        res.json({
          available: registered,
          serviceName: "ApplyPatch",
          version: "v0.70",
          registered,
          note: registered ? "tool registered via agentModelExecutor; stats counters not yet instrumented" : "tool not registered",
          stats: {
            successCount: 0,
            failureCount: 0,
            averageHunks: 0,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/agent/vision-stats — VisionAnalyzer 调用统计
    app.get("/api/agent/vision-stats", (_req: Request, res: Response) => {
      try {
        const vision = this.registry.resolveService<unknown>("visionAnalyzer");
        const available = !!vision;
        res.json({
          available,
          serviceName: "VisionAnalyzer",
          version: "v0.70",
          registered: available,
          note: available ? "stats counters not yet instrumented" : "service not registered",
          stats: {
            analyze: 0,
            describeScreen: 0,
            findElements: 0,
            detectUIIssues: 0,
            compareImages: 0,
            cacheHitRate: 0,
            inFlightHitRate: 0,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/agent/batch-stats — BatchExecutor 调用统计
    app.get("/api/agent/batch-stats", (_req: Request, res: Response) => {
      try {
        // BatchExecutor 通过 vision-batch-tools 按需实例化，无独立 service 注册
        const executor = this.registry.resolveService<{ getRegisteredTools?: () => Array<{ name: string }> }>("agentModelExecutor");
        const registered = !!executor?.getRegisteredTools?.().some((t) => t.name === "batch_execute");
        res.json({
          available: registered,
          serviceName: "BatchExecutor",
          version: "v0.70",
          registered,
          note: registered ? "tool registered via agentModelExecutor; stats counters not yet instrumented" : "tool not registered",
          stats: {
            executeParallel: 0,
            executeSequential: 0,
            executeDAG: 0,
            averageConcurrency: 0,
            timeoutCount: 0,
            retryCount: 0,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/agent/workflow-stats — WorkflowEngine 调用统计
    app.get("/api/agent/workflow-stats", (_req: Request, res: Response) => {
      try {
        // WorkflowEngine 通过 vision-batch-tools 按需实例化，无独立 service 注册
        const executor = this.registry.resolveService<{ getRegisteredTools?: () => Array<{ name: string }> }>("agentModelExecutor");
        const registered = !!executor?.getRegisteredTools?.().some((t) => t.name === "workflow_execute");
        res.json({
          available: registered,
          serviceName: "WorkflowEngine",
          version: "v0.70",
          registered,
          note: registered ? "tool registered via agentModelExecutor; stats counters not yet instrumented" : "tool not registered",
          stats: {
            execute: 0,
            resume: 0,
            nodeSuccessRate: 0,
            averageExecutionMs: 0,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/agent/checkpoint-stats — SessionCheckpointManager + DLQBatchRetry 统计
    app.get("/api/agent/checkpoint-stats", (_req: Request, res: Response) => {
      try {
        // SessionCheckpointManager / DLQBatchRetry 通过 vision-batch-tools 按需实例化，无独立 service 注册
        const executor = this.registry.resolveService<{ getRegisteredTools?: () => Array<{ name: string }> }>("agentModelExecutor");
        const dlq = this.registry.resolveService<unknown>("deadLetterQueue");
        const registered = !!executor?.getRegisteredTools?.().some((t) => t.name === "checkpoint_save");
        res.json({
          available: registered,
          serviceName: "SessionCheckpointManager+DLQBatchRetry",
          version: "v0.70",
          registered,
          dlqAvailable: !!dlq,
          note: registered ? "tool registered via agentModelExecutor; stats counters not yet instrumented" : "tool not registered",
          stats: {
            save: 0,
            load: 0,
            delete: 0,
            diff: 0,
            dlqRetrySuccessRate: 0,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // ── v0.56/v0.57 能力模块 stats 端点 ──
    // 这些模块以单例/纯函数形式存在于 @evoclaw/agent，未注册为 Service，
    // 端点返回模块可用性 + 占位 stats，供 WebUI EnhancementHubPage 卡片确认服务可达。

    // GET /api/agent/pruner-stats — ToolOutputPruner 3-pass 裁剪统计
    app.get("/api/agent/pruner-stats", (_req: Request, res: Response) => {
      try {
        res.json({
          available: true,
          serviceName: "ToolOutputPruner",
          version: "v0.56",
          registered: false,
          note: "module available; stats counters not yet instrumented",
          stats: {
            deduplicated: 0,
            summarized: 0,
            argsTruncated: 0,
            originalChars: 0,
            prunedChars: 0,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/agent/error-recovery-stats — ErrorRecoveryExecutor 统计
    app.get("/api/agent/error-recovery-stats", (_req: Request, res: Response) => {
      try {
        res.json({
          available: true,
          serviceName: "ErrorRecoveryExecutor",
          version: "v0.56",
          registered: false,
          note: "module available; stats counters not yet instrumented",
          stats: {
            recovered: 0,
            failovered: 0,
            retried: 0,
            byAction: {},
          },
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/agent/concurrent-stats — ConcurrentToolExecutor 统计
    app.get("/api/agent/concurrent-stats", (_req: Request, res: Response) => {
      try {
        res.json({
          available: true,
          serviceName: "ConcurrentToolExecutor",
          version: "v0.56",
          registered: false,
          note: "module available; stats counters not yet instrumented",
          stats: {
            executed: 0,
            parallelized: 0,
            sequential: 0,
            timeouts: 0,
            averageConcurrency: 0,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/agent/iteration-budget — IterationBudget 统计
    app.get("/api/agent/iteration-budget", (_req: Request, res: Response) => {
      try {
        res.json({
          available: true,
          serviceName: "IterationBudget",
          version: "v0.56",
          registered: false,
          note: "module available; stats counters not yet instrumented",
          stats: {
            used: 0,
            remaining: 0,
            max: 90,
            exhausted: false,
            executeCodeRefunds: 0,
            runtimeErrorRefunds: 0,
            compactionRefunds: 0,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/agent/persistence-stats — ToolResultPersistenceManager 统计
    app.get("/api/agent/persistence-stats", (_req: Request, res: Response) => {
      try {
        res.json({
          available: true,
          serviceName: "ToolResultPersistenceManager",
          version: "v0.57",
          registered: false,
          note: "module available; stats counters not yet instrumented",
          stats: {
            persisted: 0,
            spilled: 0,
            totalChars: 0,
            turnBudgetChars: 200000,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/agent/schema-sanitizer-stats — SchemaSanitizer 统计
    app.get("/api/agent/schema-sanitizer-stats", (_req: Request, res: Response) => {
      try {
        res.json({
          available: true,
          serviceName: "SchemaSanitizer",
          version: "v0.57",
          registered: false,
          note: "module available; stats counters not yet instrumented",
          stats: {
            sanitized: 0,
            byBackend: {},
            strippedKeys: 0,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/agent/coercer-stats — ToolArgumentCoercer 统计
    app.get("/api/agent/coercer-stats", (_req: Request, res: Response) => {
      try {
        res.json({
          available: true,
          serviceName: "ToolArgumentCoercer",
          version: "v0.57",
          registered: false,
          note: "module available; stats counters not yet instrumented",
          stats: {
            coerced: 0,
            byType: { stringToInt: 0, stringToNumber: 0, stringToBool: 0, jsonToObject: 0, bareToArray: 0 },
            failed: 0,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/agent/rate-guard-stats — CrossSessionRateGuard 统计
    app.get("/api/agent/rate-guard-stats", (_req: Request, res: Response) => {
      try {
        res.json({
          available: true,
          serviceName: "CrossSessionRateGuard",
          version: "v0.57",
          registered: false,
          note: "module available; stats counters not yet instrumented",
          stats: {
            breakerTripped: 0,
            genuineRateLimits: 0,
            transientLimits: 0,
            activeProviders: 0,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/agent/streaming-recovery-stats — StreamingRecoveryManager 统计
    app.get("/api/agent/streaming-recovery-stats", (_req: Request, res: Response) => {
      try {
        res.json({
          available: true,
          serviceName: "StreamingRecoveryManager",
          version: "v0.57",
          registered: false,
          note: "module available; stats counters not yet instrumented",
          stats: {
            recovered: 0,
            byStrategy: {
              partialStreamRecovery: 0,
              truncatedToolCallRetries: 0,
              lengthContinueRetries: 0,
              thinkingPrefillRetries: 0,
              postToolEmptyRetried: 0,
              housekeepingFallback: 0,
            },
            usedPartialContent: 0,
          },
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // GET /api/agent/middleware-stats — ToolResultMiddleware 统计
    app.get("/api/agent/middleware-stats", (_req: Request, res: Response) => {
      try {
        const mw = getToolResultMiddleware();
        const stats = mw.getStats();
        const config = mw.getConfig();
        res.json({
          available: true,
          serviceName: "ToolResultMiddleware",
          version: "v0.57",
          registered: false,
          note: "singleton stats via getStats()",
          stats,
          config,
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // ── Heartbeat API ──

    // GET /api/agent/heartbeat-status — Returns current heartbeat state
    app.get("/api/agent/heartbeat-status", (_req: Request, res: Response) => {
      try {
        const agentExecutor = this.registry.resolveService<{
          getHeartbeatStatus(): {
            enabled: boolean;
            active: boolean;
            intervalMs: number;
            lastFireTime: Date | null;
            nextFireTime: Date | null;
            isIdle: boolean;
            activeConversations: number;
          };
        }>("agentModelExecutor");
        if (!agentExecutor) {
          res.status(503).json({ error: "Agent executor not available" });
          return;
        }
        const status = agentExecutor.getHeartbeatStatus();
        res.json({
          enabled: status.enabled,
          active: status.active,
          state: status.isIdle ? "idle" : "busy",
          intervalMs: status.intervalMs,
          lastFireTime: status.lastFireTime?.toISOString() ?? null,
          nextFireTime: status.nextFireTime?.toISOString() ?? null,
          activeConversations: status.activeConversations,
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get heartbeat status");
      }
    });

    // POST /api/agent/heartbeat/config — Update heartbeat config
    app.post("/api/agent/heartbeat/config", (req: Request, res: Response) => {
      try {
        const agentExecutor = this.registry.resolveService<{
          configureHeartbeat(config: { intervalMs?: number; enabled?: boolean }): void;
          startHeartbeat(): void;
          stopHeartbeat(): void;
          getHeartbeatStatus(): {
            enabled: boolean;
            active: boolean;
            intervalMs: number;
            lastFireTime: Date | null;
            nextFireTime: Date | null;
            isIdle: boolean;
            activeConversations: number;
          };
        }>("agentModelExecutor");
        if (!agentExecutor) {
          res.status(503).json({ error: "Agent executor not available" });
          return;
        }

        const { intervalMs, enabled } = req.body as { intervalMs?: number; enabled?: boolean };

        if (intervalMs !== undefined && (typeof intervalMs !== "number" || intervalMs < 60000)) {
          res.status(400).json({ error: "intervalMs must be a number >= 60000 (1 minute)" });
          return;
        }
        if (enabled !== undefined && typeof enabled !== "boolean") {
          res.status(400).json({ error: "enabled must be a boolean" });
          return;
        }

        agentExecutor.configureHeartbeat({ intervalMs, enabled });

        // Auto-start heartbeat if enabled and not already running
        if (enabled === true) {
          agentExecutor.startHeartbeat();
        } else if (enabled === false) {
          agentExecutor.stopHeartbeat();
        }

        const status = agentExecutor.getHeartbeatStatus();
        res.json({
          success: true,
          enabled: status.enabled,
          active: status.active,
          intervalMs: status.intervalMs,
          nextFireTime: status.nextFireTime?.toISOString() ?? null,
        });
      } catch (err) {
        this.handleError(err, res, "Failed to configure heartbeat");
      }
    });

    // ── MoA (Mixture-of-Agents) 推理引擎 ──────────────────

    // GET /api/moa/status — 获取 MoA 配置与统计
    app.get("/api/moa/status", (_req: Request, res: Response) => {
      try {
        const moa = this.registry.resolveService<{
          getConfig(): unknown;
          getStats(): {
            totalRuns: number; successfulRuns: number; failedRuns: number;
            totalLatencyMs: number; totalTokens: number; totalCost: number;
            averageLatencyMs: number;
          };
        }>("moaEngine");
        if (!moa) {
          res.json({
            config: null,
            stats: {
              totalRuns: 0, successfulRuns: 0, failedRuns: 0,
              totalLatencyMs: 0, totalTokens: 0, totalCost: 0, averageLatencyMs: 0,
            },
            available: false,
          });
          return;
        }
        res.json({
          config: moa.getConfig(),
          stats: moa.getStats(),
          available: true,
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get MoA status");
      }
    });

    // POST /api/moa/run — 执行 MoA 推理流水线
    app.post("/api/moa/run", async (req: Request, res: Response) => {
      try {
        const moa = this.registry.resolveService<{
          execute(prompt: string, context?: unknown): Promise<{
            finalAnswer: string;
            proposals: Array<{ model: string; content: string; latency: number }>;
            aggregation: { strategy: string; aggregatedContent: string };
            verification?: { passed: boolean; conflicts: unknown[] };
            totalLatency: number;
            totalTokens: number;
            totalCost: number;
          }>;
        }>("moaEngine");
        if (!moa) {
          res.status(503).json({ error: "MoA engine not available" });
          return;
        }
        const { prompt, context } = req.body as { prompt?: string; context?: unknown };
        if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
          res.status(400).json({ error: "prompt is required and must be a non-empty string" });
          return;
        }
        const result = await moa.execute(prompt, context);
        res.json({
          prompt,
          proposals: result.proposals.map((p) => ({
            model: p.model, content: p.content, latency: p.latency,
            tokens: 0, success: true,
          })),
          aggregation: result.aggregation,
          ...(result.verification ? { verification: result.verification } : {}),
          finalAnswer: result.finalAnswer,
          stats: {
            totalLatencyMs: result.totalLatency,
            totalTokens: result.totalTokens,
            totalCost: result.totalCost,
          },
        });
      } catch (err) {
        this.handleError(err, res, "Failed to run MoA inference");
      }
    });

    // GET /api/moa/history — 获取 MoA 执行历史（服务未追踪时返回空）
    app.get("/api/moa/history", (_req: Request, res: Response) => {
      try {
        const moa = this.registry.resolveService<{
          getHistory?: () => unknown;
        }>("moaEngine");
        if (!moa || typeof moa.getHistory !== "function") {
          res.json({ history: [], total: 0 });
          return;
        }
        const history = moa.getHistory();
        const arr = Array.isArray(history) ? history : [];
        res.json({ history: arr, total: arr.length });
      } catch (err) {
        this.handleError(err, res, "Failed to get MoA history");
      }
    });

    // ── Kanban 多 Agent 工作队列 ──────────────────────────

    // GET /api/kanban/boards — 列出所有看板
    app.get("/api/kanban/boards", (_req: Request, res: Response) => {
      try {
        const kanban = this.registry.resolveService<{
          listBoards(): Array<{ boardId: string; tenant: string | null; createdAt: string }>;
        }>("kanbanBoard");
        if (!kanban) {
          res.status(503).json({ error: "Kanban board service not available" });
          return;
        }
        const boards = kanban.listBoards();
        res.json({ boards });
      } catch (err) {
        this.handleError(err, res, "Failed to list kanban boards");
      }
    });

    // POST /api/kanban/boards — 创建看板
    app.post("/api/kanban/boards", async (req: Request, res: Response) => {
      try {
        const kanban = this.registry.resolveService<{
          createBoard(boardId: string, options?: { tenant?: string }): Promise<void>;
        }>("kanbanBoard");
        if (!kanban) {
          res.status(503).json({ error: "Kanban board service not available" });
          return;
        }
        const { boardId, tenant } = req.body as { boardId?: string; tenant?: string };
        if (!boardId || typeof boardId !== "string" || boardId.trim().length === 0) {
          res.status(400).json({ error: "boardId is required" });
          return;
        }
        await kanban.createBoard(boardId, tenant ? { tenant } : undefined);
        res.json({ success: true, boardId });
      } catch (err) {
        this.handleError(err, res, "Failed to create kanban board");
      }
    });

    // GET /api/kanban/boards/:id/tasks — 列出看板任务
    app.get("/api/kanban/boards/:id/tasks", (req: Request, res: Response) => {
      try {
        const kanban = this.registry.resolveService<{
          listTasks(boardId: string, status?: string, tenant?: string | null): unknown[];
        }>("kanbanBoard");
        if (!kanban) {
          res.status(503).json({ error: "Kanban board service not available" });
          return;
        }
        const boardId = String(req.params.id);
        const status = typeof req.query.status === "string" ? req.query.status : undefined;
        const tenant = typeof req.query.tenant === "string" ? req.query.tenant : undefined;
        const tasks = kanban.listTasks(
          boardId,
          status,
          tenant === undefined ? undefined : tenant === "" ? null : tenant,
        );
        res.json({ tasks });
      } catch (err) {
        this.handleError(err, res, "Failed to list kanban tasks");
      }
    });

    // POST /api/kanban/boards/:id/tasks — 添加任务到看板
    app.post("/api/kanban/boards/:id/tasks", async (req: Request, res: Response) => {
      try {
        const kanban = this.registry.resolveService<{
          addTask(boardId: string, task: {
            title: string; description?: string; priority?: string;
            dependencies?: string[]; tenant?: string;
          }): Promise<unknown>;
        }>("kanbanBoard");
        if (!kanban) {
          res.status(503).json({ error: "Kanban board service not available" });
          return;
        }
        const boardId = String(req.params.id);
        const body = req.body as {
          title?: string; description?: string; priority?: string;
          dependencies?: string[]; tenant?: string;
        };
        if (!body.title || typeof body.title !== "string" || body.title.trim().length === 0) {
          res.status(400).json({ error: "title is required" });
          return;
        }
        const task = await kanban.addTask(boardId, {
          title: body.title,
          description: body.description ?? "",
          ...(body.priority ? { priority: body.priority } : {}),
          ...(Array.isArray(body.dependencies) ? { dependencies: body.dependencies } : {}),
          ...(body.tenant ? { tenant: body.tenant } : {}),
        });
        res.json(task);
      } catch (err) {
        this.handleError(err, res, "Failed to add kanban task");
      }
    });

    // POST /api/kanban/tasks/:id/claim — 领取任务
    app.post("/api/kanban/tasks/:id/claim", async (req: Request, res: Response) => {
      try {
        const kanban = this.registry.resolveService<{
          claimTask(agentId: string, taskId: string): Promise<unknown>;
        }>("kanbanBoard");
        if (!kanban) {
          res.status(503).json({ error: "Kanban board service not available" });
          return;
        }
        const taskId = String(req.params.id);
        const { agentId } = req.body as { agentId?: string };
        if (!agentId || typeof agentId !== "string" || agentId.trim().length === 0) {
          res.status(400).json({ error: "agentId is required" });
          return;
        }
        const task = await kanban.claimTask(agentId, taskId);
        res.json(task);
      } catch (err) {
        this.handleError(err, res, "Failed to claim kanban task");
      }
    });

    // POST /api/kanban/tasks/:id/complete — 完成任务
    app.post("/api/kanban/tasks/:id/complete", async (req: Request, res: Response) => {
      try {
        const kanban = this.registry.resolveService<{
          completeTask(taskId: string, result: unknown): Promise<unknown>;
        }>("kanbanBoard");
        if (!kanban) {
          res.status(503).json({ error: "Kanban board service not available" });
          return;
        }
        const taskId = String(req.params.id);
        const { result } = req.body as { result?: unknown };
        const task = await kanban.completeTask(taskId, result);
        res.json(task);
      } catch (err) {
        this.handleError(err, res, "Failed to complete kanban task");
      }
    });

    // GET /api/kanban/boards/:id/stats — 获取看板统计
    app.get("/api/kanban/boards/:id/stats", (req: Request, res: Response) => {
      try {
        const kanban = this.registry.resolveService<{
          getStats(boardId: string): {
            total: number;
            byStatus: Record<string, number>;
            byPriority: { high: number; medium: number; low: number };
          };
        }>("kanbanBoard");
        if (!kanban) {
          res.status(503).json({ error: "Kanban board service not available" });
          return;
        }
        const boardId = String(req.params.id);
        const stats = kanban.getStats(boardId);
        res.json(stats);
      } catch (err) {
        this.handleError(err, res, "Failed to get kanban board stats");
      }
    });

    // ── Computer Use 桌面控制 ─────────────────────────────

    // GET /api/computer-use/status — 获取后端可用性与屏幕尺寸
    app.get("/api/computer-use/status", async (_req: Request, res: Response) => {
      try {
        const backend = this.registry.resolveService<{
          readonly name: string;
          isAvailable(): boolean;
          getScreenSize(): Promise<{ width: number; height: number }>;
        }>("computerBackend");
        if (!backend) {
          res.json({ isAvailable: false });
          return;
        }
        let isAvailable = false;
        let screenSize: { width: number; height: number } | undefined;
        try {
          isAvailable = backend.isAvailable();
          if (isAvailable) {
            screenSize = await backend.getScreenSize();
          }
        } catch {
          isAvailable = false;
        }
        res.json({
          isAvailable,
          ...(backend.name ? { backend: backend.name } : {}),
          ...(screenSize ? { screenSize } : {}),
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get computer-use status");
      }
    });

    // POST /api/computer-use/screenshot — 截取屏幕
    app.post("/api/computer-use/screenshot", async (_req: Request, res: Response) => {
      try {
        const backend = this.registry.resolveService<{
          screenshot(): Promise<Buffer>;
          getScreenSize(): Promise<{ width: number; height: number }>;
          isAvailable(): boolean;
        }>("computerBackend");
        if (!backend || !backend.isAvailable()) {
          res.status(503).json({ error: "Computer backend not available" });
          return;
        }
        const buf = await backend.screenshot();
        const size = await backend.getScreenSize();
        res.json({
          image: buf.toString("base64"),
          width: size.width,
          height: size.height,
          takenAt: new Date().toISOString(),
        });
      } catch (err) {
        this.handleError(err, res, "Failed to take screenshot");
      }
    });

    // POST /api/computer-use/mouse-click — 鼠标点击
    app.post("/api/computer-use/mouse-click", async (req: Request, res: Response) => {
      try {
        const backend = this.registry.resolveService<{
          mouseClick(x: number, y: number, button: string, doubleClick: boolean): Promise<void>;
          isAvailable(): boolean;
        }>("computerBackend");
        if (!backend || !backend.isAvailable()) {
          res.status(503).json({ error: "Computer backend not available" });
          return;
        }
        const { x, y, button, doubleClick } = req.body as {
          x?: number; y?: number; button?: string; doubleClick?: boolean;
        };
        if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
          res.status(400).json({ error: "x and y must be finite numbers" });
          return;
        }
        const btn = button === "right" ? "right" : button === "middle" ? "middle" : "left";
        await backend.mouseClick(x, y, btn, doubleClick === true);
        res.json({
          success: true,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        this.handleError(err, res, "Failed to perform mouse click");
      }
    });

    // POST /api/computer-use/key-type — 输入文本
    app.post("/api/computer-use/key-type", async (req: Request, res: Response) => {
      try {
        const backend = this.registry.resolveService<{
          keyType(text: string): Promise<void>;
          isAvailable(): boolean;
        }>("computerBackend");
        if (!backend || !backend.isAvailable()) {
          res.status(503).json({ error: "Computer backend not available" });
          return;
        }
        const { text } = req.body as { text?: string };
        if (typeof text !== "string") {
          res.status(400).json({ error: "text must be a string" });
          return;
        }
        await backend.keyType(text);
        res.json({
          success: true,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        this.handleError(err, res, "Failed to type text");
      }
    });

    // POST /api/computer-use/key-press — 按组合键
    app.post("/api/computer-use/key-press", async (req: Request, res: Response) => {
      try {
        const backend = this.registry.resolveService<{
          keyPress(keys: string[]): Promise<void>;
          isAvailable(): boolean;
        }>("computerBackend");
        if (!backend || !backend.isAvailable()) {
          res.status(503).json({ error: "Computer backend not available" });
          return;
        }
        const { keys } = req.body as { keys?: string[] };
        if (!Array.isArray(keys) || keys.length === 0) {
          res.status(400).json({ error: "keys must be a non-empty array of strings" });
          return;
        }
        await backend.keyPress(keys);
        res.json({
          success: true,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        this.handleError(err, res, "Failed to press keys");
      }
    });

    // ── Tool Search 工具搜索 ──────────────────────────────

    // GET /api/tool-search/stats — 获取搜索引擎统计
    app.get("/api/tool-search/stats", (_req: Request, res: Response) => {
      try {
        const engine = this.registry.resolveService<{
          isActivated(): boolean;
          getVisibleTools(): Array<{ name: string; alwaysVisible?: boolean }>;
        }>("toolSearchEngine");
        if (!engine) {
          res.json({
            totalTools: 0, activated: false, mode: "auto",
            visibleTools: 0, deferrableTools: 0,
          });
          return;
        }
        // 服务若暴露 tools/config 则使用；否则从 getVisibleTools 估算
        const svc = engine as unknown as {
          isActivated(): boolean;
          tools?: Array<{ name: string; alwaysVisible?: boolean }>;
          config?: { mode: string };
          getVisibleTools(): Array<{ name: string; alwaysVisible?: boolean }>;
        };
        const allTools = Array.isArray(svc.tools) ? svc.tools : svc.getVisibleTools();
        const visible = allTools.filter((t) => t.alwaysVisible);
        const deferrable = allTools.filter((t) => !t.alwaysVisible);
        res.json({
          totalTools: allTools.length,
          activated: svc.isActivated(),
          mode: svc.config?.mode ?? "auto",
          visibleTools: visible.length,
          deferrableTools: deferrable.length,
        });
      } catch (err) {
        this.handleError(err, res, "Failed to get tool-search stats");
      }
    });

    // POST /api/tool-search/search — 搜索工具
    app.post("/api/tool-search/search", (req: Request, res: Response) => {
      try {
        const engine = this.registry.resolveService<{
          search(query: string, maxResults?: number): Array<{
            name: string; score: number; matchedTerms: string[]; reason: string;
          }>;
        }>("toolSearchEngine");
        if (!engine) {
          res.json({ results: [] });
          return;
        }
        const { query, maxResults } = req.body as { query?: string; maxResults?: number };
        if (!query || typeof query !== "string" || query.trim().length === 0) {
          res.status(400).json({ error: "query is required and must be a non-empty string" });
          return;
        }
        const limit = typeof maxResults === "number" && maxResults > 0 ? maxResults : undefined;
        const results = engine.search(query, limit);
        res.json({ results });
      } catch (err) {
        this.handleError(err, res, "Failed to search tools");
      }
    });

    // GET /api/tool-search/tools — 列出已索引工具
    app.get("/api/tool-search/tools", (_req: Request, res: Response) => {
      try {
        const engine = this.registry.resolveService<{
          getVisibleTools(): Array<{ name: string; description: string; category?: string; alwaysVisible?: boolean }>;
          isActivated(): boolean;
        }>("toolSearchEngine");
        if (!engine) {
          res.json({ tools: [] });
          return;
        }
        // 当引擎未激活时 getVisibleTools 返回全部；激活时返回 always-visible + 桥接工具
        const svc = engine as unknown as {
          tools?: Array<{ name: string; description: string; category?: string; alwaysVisible?: boolean }>;
          getVisibleTools(): Array<{ name: string; description: string; category?: string; alwaysVisible?: boolean }>;
          isActivated(): boolean;
        };
        // 优先使用 tools 数组（含全部已注册工具）
        const tools = Array.isArray(svc.tools) ? svc.tools : svc.getVisibleTools();
        res.json({ tools });
      } catch (err) {
        this.handleError(err, res, "Failed to list indexed tools");
      }
    });
  }
}