import { Express, Request, Response } from "express";
import { ServiceRegistry, EventBus, FeatureFlagStore } from "@evoclaw/core";
import { taskStatusTracker, taskCheckpointManager, ModelFailoverManager } from "@evoclaw/agent";
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
          try { fs.renameSync(dstTmp, ENV_FILE); } catch { /* ignore */ }
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
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
      }
    }, CLI_TIMEOUT_MS);

    childProcess.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
      if (stdout.length > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + "\n... (output truncated)";
        childProcess.kill("SIGTERM");
      }
    });

    childProcess.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
      if (stderr.length > MAX_OUTPUT_BYTES) {
        stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + "\n... (output truncated)";
      }
    });

    childProcess.on("close", (code) => {
      clearTimeout(timeoutId);
      if (!resolved) {
        resolved = true;
        resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode: code ?? 1, timedOut });
      }
    });

    childProcess.on("error", (err) => {
      clearTimeout(timeoutId);
      if (!resolved) {
        resolved = true;
        resolve({ stdout: "", stderr: err.message, exitCode: 1, timedOut: false });
      }
    });
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
      process.stderr.write(`[ProtocolAdapter] Failed to create config dir: ${err instanceof Error ? err.message : String(err)}`);
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
            process.stdout.write("[ProtocolAdapter] Migrated LLM API keys to .env references");
          }

          this.savedLLMProviders = data.providers;
          // Resolve references before applying
          const resolved = this.resolveLLMProviders(data.providers);
          this.applyLLMProviders(resolved);
          process.stdout.write(`[ProtocolAdapter] Loaded ${data.providers.length} LLM providers from disk`);
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
            process.stdout.write("[ProtocolAdapter] Migrated image-gen API keys to .env references");
          }

          this.savedImageGenProviders = data.providers;
          process.stdout.write(`[ProtocolAdapter] Loaded ${data.providers.length} image-gen providers from disk`);
        }
      } else {
        // Initialize with defaults and persist
        this.savedImageGenProviders = DEFAULT_IMAGE_GEN_PROVIDERS;
        this.persistImageGenProviders(DEFAULT_IMAGE_GEN_PROVIDERS);
        process.stdout.write("[ProtocolAdapter] Initialized default image-gen providers");
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
            process.stdout.write("[ProtocolAdapter] Migrated video-gen API keys to .env references");
          }

          this.savedVideoGenProviders = data.providers;
          process.stdout.write(`[ProtocolAdapter] Loaded ${data.providers.length} video-gen providers from disk`);
        }
      } else {
        // Initialize with defaults and persist
        this.savedVideoGenProviders = DEFAULT_VIDEO_GEN_PROVIDERS;
        this.persistVideoGenProviders(DEFAULT_VIDEO_GEN_PROVIDERS);
        process.stdout.write("[ProtocolAdapter] Initialized default video-gen providers");
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
            process.stdout.write("[ProtocolAdapter] Migrated channel secrets to .env references");
          }

          this.savedChannels = data.channels;
          // Resolve references before applying
          const resolved = this.resolveChannelConfigs(data.channels);
          this.applyChannels(resolved);
          process.stdout.write(`[ProtocolAdapter] Loaded ${data.channels.length} channels from disk`);
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
      .map((p) => ({
        id: (p.id as string) || "",
        name: (p.name as string) || "",
        enabled: true,
        order: (p.order as number) ?? 1,
        provider: (p.id as string) || "custom",
        model: (p.selectedModel as string) || (Array.isArray(p.models) ? (p.models as string[])[0] : "") || "",
        apiKey: (p.apiKey as string) || "",
        baseURL: (p.baseURL as string) || "",
        maxTokens: (p.config as Record<string, unknown>)?.maxTokens as number ?? 4096,
        temperature: (p.config as Record<string, unknown>)?.temperature as number ?? 0.3,
        timeout: (p.config as Record<string, unknown>)?.timeout as number ?? 60000,
        topP: (p.config as Record<string, unknown>)?.topP as number ?? 1,
        models: (p.models as string[]) || [],
      }));

    if (configs.length > 0) {
      executor.configureProviders(configs);
    }

    // Sync provider info to CopilotRouter so it knows user's LLM config order
    const copilotRouter = this.registry.resolveService<{
      updateUserProviders(providers: Array<{ id: string; name: string; enabled: boolean; order: number; selectedModel: string; baseURL: string }>): void;
    }>("copilotRouter");
    if (copilotRouter) {
      copilotRouter.updateUserProviders(
        providers.map((p) => ({
          id: (p.id as string) || "",
          name: (p.name as string) || "",
          enabled: (p.enabled as boolean) ?? false,
          order: (p.order as number) ?? 1,
          selectedModel: (p.selectedModel as string) || "",
          baseURL: (p.baseURL as string) || "",
        }))
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
            process.stderr.write(`[ProtocolAdapter] Failed to attach ${type} adapter:` + " " + err);
          });
          process.stdout.write(`[ProtocolAdapter] Applied channel: ${type} (enabled=${enabled})`);
        } else if (type === "feishu" || type === "matrix") {
          process.stderr.write(`[ProtocolAdapter] Channel ${type} is enabled but missing required settings`);
        }
      }
    }
  }

  private authProvider: {
    generateToken(userId: string, roles?: string[]): string;
    generateRefreshToken(userId: string): string;
    verifyToken(token: string): { userId: string; roles: string[] };
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
    } catch { /* start fresh */ }

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
    process.stderr.write(`[ProtocolAdapter] ${defaultMsg}:` + " " + message);
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
          process.stderr.write(`[ProtocolAdapter] Config RPC store update failed: ${err instanceof Error ? err.message : String(err)}`);
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
      if (tokenFromCookie && tokenFromCookie === webUiToken) {
        res.json({ authenticated: true });
      } else {
        res.status(401).json({ authenticated: false, error: "Invalid or missing token" });
      }
    });

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
          const query = { keyword, limit: parseInt(req.query.limit as string) || 20 };
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
          res.json(sorted);
          return;
        }
        
        res.json(skills);
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
        res.json(skill);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post("/api/skills/install", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          installSkill(path: string): Promise<unknown>;
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
        const installed = await skillManager.installSkill(skillPath);
        res.json({ success: true, skill: installed });
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
        const skillsDir = path.resolve(process.cwd(), "..", "..", "data", "skills");
        const result = await skillManager.scanAndInstall(skillsDir);
        res.json({
          installed: result.installed.length,
          skipped: result.skipped.length,
          details: result,
        });
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
          searchMarketplace(query: string, category?: string): unknown;
          getMarketplace(): { refreshCatalog(): Promise<number>; search(query: Record<string, unknown>): unknown };
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        const q = (req.query.q as string) || "";
        const category = req.query.category as string | undefined;
        if (!q) {
          res.status(400).json({ error: "Query parameter 'q' is required" });
          return;
        }
        await skillManager.getMarketplace().refreshCatalog().catch(() => {});
        const results = skillManager.searchMarketplace(q, category);
        res.json({ success: true, results });
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
        const skill = await skillManager.installFromMarketplace(name);
        res.json({ success: true, skill });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/marketplace/trending", async (req: Request, res: Response) => {
      try {
        const skillManager = this.registry.resolveService<{
          getMarketplace(): { refreshCatalog(): Promise<number>; getTrending(limit?: number): unknown };
        }>("skillManager");
        if (!skillManager) {
          res.status(503).json({ error: "Skill manager not available" });
          return;
        }
        await skillManager.getMarketplace().refreshCatalog().catch(() => {});
        const limit = parseInt(req.query.limit as string, 10) || 10;
        const trending = skillManager.getMarketplace().getTrending(limit);
        res.json({ success: true, trending });
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
        await skillManager.getMarketplace().refreshCatalog().catch(() => {});
        const categories = skillManager.getMarketplace().getCategories();
        res.json({ success: true, categories });
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
        const bm = this.registry.resolveService<{
          readBootstrapFile(filename: string): string | null;
        }>("bootstrapManager");
        if (!bm) return res.status(404).json({ error: "Bootstrap manager not found" });
        const content = bm.readBootstrapFile(String(req.params.filename));
        if (content === null) return res.status(404).json({ error: "File not found" });
        res.json({ filename: req.params.filename, content });
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

        const rm = this.getReplyReferenceManager();
        if (rm && (req.body.replyTo || req.body.parentId || req.body.inReplyTo)) {
          try {
            rm.record(req.body.replyTo || req.body.parentId || req.body.inReplyTo, req.body.id || req.body.sessionId || "web-ui", {
              channel: req.body.channel || "webchat",
            });
          } catch (err) { process.stderr.write("[ProtocolAdapter] Failed to record reply reference:" + " " + err); }
        }

        const agentExecutor = this.registry.resolveService<{
          chat(prompt: string, context?: Record<string, unknown>, onProgress?: (event: import("@evoclaw/agent").AgentProgressEvent) => void): Promise<{ reply: string; tokensUsed: number; duration: number; permissionRequests?: Array<{ id: string; operation: string; description: string; target: string }>; files?: Array<{ path: string; size: number; downloadUrl: string }> }>;
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
          process.stdout.write(`[ProtocolAdapter] Chat complexity: ${complexity.level}, timeout: ${CHAT_TIMEOUT / 1000}s, autoSplit: ${complexity.shouldAutoSplit}`);
          let chatTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
          let keepAliveHandle: ReturnType<typeof setInterval> | undefined;
          try {
            // Tell the user right away that a long-running task is being processed.
            sendSSE("working", { phase: "working", detail: "正在进行生成，请耐心等待..." });
            keepAliveHandle = setInterval(() => {
              sendSSE("working", { phase: "working", detail: "仍在处理中，请继续等待..." });
            }, 20_000);

            const result = await Promise.race([
              agentExecutor.chat(message, { sessionId: resolvedSessionId, attachments, complexity: complexity.level, shouldAutoSplit: complexity.shouldAutoSplit, maxSubtasks: complexity.maxSubtasks }, onProgress),
              new Promise<never>((_, reject) => {
                chatTimeoutHandle = setTimeout(() => reject(new Error("CHAT_TIMEOUT")), CHAT_TIMEOUT);
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
                const cfgMax = contextEngine.getConfig().maxContextTokens as number;
                if (cfgMax && cfgMax > 0) contextLimit = cfgMax;
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
            if (chatErr instanceof Error && chatErr.message === "CHAT_TIMEOUT") {
              sendSSE("error", { message: "⏱️ 处理超时，请稍后重试。替代方案：① 简化您的请求后重试；② 将任务拆分为更小的步骤；③ 检查网络连接是否正常。" });
            } else {
              const errMsg = chatErr instanceof Error ? chatErr.message : String(chatErr);
              sendSSE("error", { message: `❌ 处理请求时出错：${errMsg}\n\n替代方案：① 请稍后重试；② 尝试简化请求；③ 前往 Ops 页面检查系统状态。` });
            }
          } finally {
            if (keepAliveHandle) clearInterval(keepAliveHandle);
            try { res.end(); } catch (err) { console.debug("[ProtocolAdapter]", err instanceof Error ? err.message : String(err)); }
          }
          return;
        }

        // ── Non-streaming Mode (original behavior) ──
        const complexity = estimateTaskComplexity(message);
        const CHAT_TIMEOUT = complexity.timeoutMs;
        process.stdout.write(`[ProtocolAdapter] Chat (non-stream) complexity: ${complexity.level}, timeout: ${CHAT_TIMEOUT / 1000}s`);
        const chatPromise = agentExecutor.chat(message, {
          sessionId: resolvedSessionId,
          attachments,
          complexity: complexity.level,
          shouldAutoSplit: complexity.shouldAutoSplit,
          maxSubtasks: complexity.maxSubtasks,
        });

        let result;
        try {
          result = await Promise.race([
            chatPromise,
            new Promise<never>((_, reject) => {
              chatTimeoutHandle = setTimeout(() => reject(new Error("CHAT_TIMEOUT")), CHAT_TIMEOUT);
            }),
          ]);
        } catch (raceErr) {
          if (raceErr instanceof Error && raceErr.message === "CHAT_TIMEOUT") {
            process.stderr.write(`[ProtocolAdapter] Chat request timed out after ${CHAT_TIMEOUT / 1000}s for session "${resolvedSessionId}"`);
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
            const cfgMax = contextEngine.getConfig().maxContextTokens as number;
            if (cfgMax && cfgMax > 0) contextLimit = cfgMax;
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
        process.stderr.write(`[ProtocolAdapter] Chat endpoint error: ${errMsg}`);
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
          const result = await Promise.race([
            agentExecutor.chat(message, { sessionId, complexity: complexity.level, shouldAutoSplit: complexity.shouldAutoSplit, maxSubtasks: complexity.maxSubtasks }, onProgress),
            new Promise<never>((_, reject) => {
              resumeTimeoutHandle = setTimeout(() => reject(new Error("CHAT_TIMEOUT")), CHAT_TIMEOUT);
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
        const mappedCycles = cycleList.map((c) => ({
          id: String(c.id || ""),
          source: String(c.source || c.trigger || ""),
          status: String(c.status || "unknown"),
          startedAt: c.startedAt ? new Date(c.startedAt as string | number).toISOString() : "",
          completedAt: c.completedAt ? new Date(c.completedAt as string | number).toISOString() : null,
          duration: c.startedAt && c.completedAt
            ? new Date(c.completedAt as string | number).getTime() - new Date(c.startedAt as string | number).getTime()
            : 0,
          candidatesGenerated: Array.isArray(c.candidates) ? c.candidates.length : (c.candidatesGenerated as number || 0),
          candidatesPassed: Array.isArray(c.candidates) ? (c.candidates as unknown[]).filter((x) => (x as Record<string, unknown>)?.passed).length : (c.candidatesPassed as number || 0),
          evaluationScore: (c.evaluation as Record<string, unknown>)?.score as number || (c.evaluationScore as number || 0),
        }));

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
        if (req.query.limit) filter.limit = parseInt(String(req.query.limit), 10);
        if (req.query.offset) filter.offset = parseInt(String(req.query.offset), 10);
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
        }, "protocol-adapter");
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
        }, "protocol-adapter");
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
        }, "protocol-adapter");
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
            process.stdout.write(`[PluginManager] Community plugin "${name}" initialized (stub)`);
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
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") headers[key] = value;
        }
        // Pass raw body for signature verification
        const rawBody = typeof (req as any).rawBody === "string" ? (req as any).rawBody : JSON.stringify(req.body);
        const result = await adapter.handleWebhookEvent(req.body as Record<string, unknown>, headers, rawBody);
        res.json(result.challenge ? { challenge: result.challenge } : {});
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
            process.stderr.write("[WeChat] Failed to save credentials:" + " " + saveErr);
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
          query(query: { sessionId?: string; agentId?: string; type?: string; fromTime?: number; toTime?: number; limit?: number }): Array<Record<string, unknown>>;
          snapshot(): Record<string, unknown>;
        } | undefined;

        if (!eventLedger) {
          res.json({ events: [], total: 0 });
          return;
        }

        const query: Record<string, unknown> = {};
        if (req.query.sessionId) query.sessionId = String(req.query.sessionId);
        if (req.query.agentId) query.agentId = String(req.query.agentId);
        if (req.query.type) query.type = String(req.query.type);
        if (req.query.fromTime) query.fromTime = parseInt(String(req.query.fromTime), 10);
        if (req.query.toTime) query.toTime = parseInt(String(req.query.toTime), 10);
        if (req.query.limit) query.limit = parseInt(String(req.query.limit), 10);

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
          res.json({ entries: 0, firstSeq: 0, lastSeq: 0 });
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

        const limit = parseInt(String(req.query.limit || "50"), 10);
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
        fs.createReadStream(fullPath).pipe(res);
      } catch (err) {
        this.handleError(err, res, "Failed to download file");
      }
    });

    app.get("/api/files/list", (req: Request, res: Response) => {
      try {
        const dirPath = (req.query.path as string) || ".";
        if (dirPath.includes("..") || path.resolve(dirPath) !== path.normalize(dirPath)) {
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
        if (req.query.limit) query.limit = parseInt(String(req.query.limit), 10);
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
        this.secretsAuditLog.push({
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
        const key = `${prefix || "evc"}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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
        this.secretsAuditLog.push({
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
        this.secretsAuditLog.push({
          secretName: name,
          operation: "get",
          accessedBy: requester || "api",
          timestamp: new Date().toISOString(),
          success: true,
        });
        const maskedValue = entry.value.length > 8
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
        this.secretsAuditLog.push({
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
        this.secretsAuditLog.push({
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
        this.secretsAuditLog.push({
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
        const subscriptionId = `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        if (!this.configRpcWatchers.has(dotPath)) {
          this.configRpcWatchers.set(dotPath, []);
        }
        this.configRpcWatchers.get(dotPath)!.push({ subscriptionId });
        res.json({ subscriptionId });
      } catch (err) {
        this.handleError(err, res, "Failed to watch config path");
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
        Object.assign(this.retentionPolicy, policy);
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
          for (const s of allSessions) {
            const lastActive = s.lastActivityAt || s.updatedAt || s.createdAt || 0;
            const created = s.createdAt || 0;
            if ((now - lastActive > maxInactiveMs) || (now - created > maxAgeMs)) {
              const sid = s.id || s.sessionId;
              if (sid && sessionManager.deleteSession?.(sid)) { cleaned++; }
              else if (sid && sessionManager.removeSession?.(sid)) { cleaned++; }
              else if (sid && sessionManager.destroySession?.(sid)) { cleaned++; }
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
              try { config.set(key, value); } catch (err) { process.stderr.write(`[ProtocolAdapter] Config rollback failed for key "${key}":` + " " + err); failedKeys.push(key); }
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

      const onFileChanged = (evt: { projectId: string; filename: string }) => {
        res.write(`data: ${JSON.stringify({ type: "file-changed", ...evt })}\n\n`);
      };
      const onProjectCreated = (project: any) => {
        res.write(`data: ${JSON.stringify({ type: "project-created", projectId: project.id })}\n\n`);
      };
      const onProjectDeleted = (id: string) => {
        res.write(`data: ${JSON.stringify({ type: "project-deleted", projectId: id })}\n\n`);
      };
      const onA2uiPush = (evt: { projectId: string; data: any; timestamp: number }) => {
        res.write(`data: ${JSON.stringify({ type: "a2ui-push", ...evt })}\n\n`);
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
  }
}