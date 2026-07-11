/**
 * Structured Logger — OpenClaw-style logging subsystem.
 *
 * Features:
 * - Log levels: trace, debug, info, warn, error, fatal
 * - Structured JSON output with timestamps
 * - Sensitive data redaction (API keys, tokens, passwords)
 * - Subsystem tagging for filtering
 * - Optional pretty-print for development
 * - File logging with rotating appender (agent.log / errors.log / gateway.log)
 * - Session context injection (session_id in log line)
 */

import path from "path";
import { RotatingFileAppender } from "./rotating-file-appender";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  subsystem: string;
  message: string;
  data?: Record<string, unknown>;
  error?: string;
  stack?: string;
}

export interface LoggerConfig {
  minLevel: LogLevel;
  prettyPrint: boolean;
  enableRedaction: boolean;
  outputStream?: (entry: string) => void;
}

/** setupFileLogging 的参数 */
export interface FileLoggingOptions {
  /** 日志根目录 */
  logDir: string;
  /** 会话 ID，注入到每行日志 */
  sessionId?: string;
  /** profile 名，logDir 路径包含 profile 子目录 */
  profile?: string;
}

// ─── Sensitive key patterns for redaction ─────────────────────────────────────

const SENSITIVE_KEYS = new Set([
  "apiKey", "api_key", "apikey",
  "token", "accessToken", "access_token",
  "refreshToken", "refresh_token",
  "secret", "jwtSecret", "jwt_secret",
  "password", "passwd", "pass",
  "credential", "credentials",
  "privateKey", "private_key",
  "authorization",
  "cookie",
  "web_ui_token", "webUiToken",
  "clientId", "client_id",
  "clientSecret", "client_secret",
  "connectionString", "connection_string",
  "stripeKey", "stripe_key",
  "webhookSecret", "webhook_secret",
  "signingKey", "signing_key",
]);

// 借鉴 hermes-agent redact.py 的 30+ API key 前缀正则
const SENSITIVE_VALUE_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,            // OpenAI keys
  /sk-ant-[a-zA-Z0-9]{20,}/g,        // Anthropic keys
  /AIza[0-9A-Za-z\-_]{35}/g,         // Google API keys
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, // Bearer tokens
  /ghp_[a-zA-Z0-9]{36}/g,            // GitHub personal access tokens
  /gho_[a-zA-Z0-9]{36}/g,            // GitHub OAuth tokens
  /ghs_[a-zA-Z0-9]{36}/g,            // GitHub server-to-server tokens
  /ghr_[a-zA-Z0-9]{76}/g,            // GitHub refresh tokens
  /github_pat_[a-zA-Z0-9_]{20,}/g,   // GitHub fine-grained PATs
  /xox[baprs]-[a-zA-Z0-9-]+/g,       // Slack tokens
  /pplx-[a-zA-Z0-9]{20,}/g,          // Perplexity keys
  /fal_[a-zA-Z0-9]{20,}/g,           // Fal.ai keys
  /fc-[a-zA-Z0-9]{20,}/g,            // Forecast keys
  /bb_live_[a-zA-Z0-9]{20,}/g,       // Browserbase keys
  /AKIA[0-9A-Z]{16}/g,               // AWS access key IDs
  /sk_live_[a-zA-Z0-9]{20,}/g,       // Stripe secret keys
  /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g, // SendGrid keys
  /hf_[a-zA-Z0-9]{20,}/g,            // HuggingFace tokens
  /r8_[a-zA-Z0-9]{20,}/g,            // Replicate keys
  /npm_[a-zA-Z0-9]{36}/g,            // npm tokens
  /pypi-[a-zA-Z0-9]{60,}/g,          // PyPI tokens
  /dop_v1_[a-zA-Z0-9]{20,}/g,        // Doppler tokens
  /am_[a-zA-Z0-9]{20,}/g,            // Amplitude keys
  /tvly-[a-zA-Z0-9]{20,}/g,          // Tavily keys
  /exa-[a-zA-Z0-9]{20,}/g,           // Exa keys
  /gsk_[a-zA-Z0-9]{20,}/g,           // Groq keys
  /syt_[a-zA-Z0-9]{20,}/g,           // Synthesize keys
  /hsk-[a-zA-Z0-9]{20,}/g,           // Hermes keys
  /mem0_[a-zA-Z0-9]{20,}/g,          // Mem0 keys
  /brv_[a-zA-Z0-9]{20,}/g,           // Bravity keys
  /xai-[a-zA-Z0-9]{20,}/g,           // xAI keys
  /ntn_[a-zA-Z0-9]{20,}/g,           // Ntropy keys
  /gAAAA[A-Za-z0-9_=-]{20,}/g,       // Codex encrypted tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM private keys
  // ── 以下为对齐 hermes-agent redact.py 新增的模式 ──
  // ENV 赋值模式：KEY=VALUE（KEY 含 API_KEY/TOKEN/SECRET 等）
  /([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)[A-Z0-9_]*)\s*=\s*(['"]?)(\S+)\2/g,
  // JSON 字段模式："apiKey": "value"
  /("(?:apiKey|api_key|apikey|token|accessToken|access_token|refreshToken|refresh_token|secret|password|credential|privateKey|private_key|clientSecret|client_secret)")\s*:\s*"([^"]+)"/gi,
  // Authorization 头
  /(Authorization:\s*Bearer\s+)(\S+)/gi,
  // Telegram bot token
  /(bot)?(\d{8,}):([-A-Za-z0-9_]{30,})/g,
  // 数据库连接字符串
  /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:]+:)([^@]+)(@)/gi,
  // JWT token（eyJ 开头）
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

// ─── Level ordering ────────────────────────────────────────────────────────────

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: "\x1b[90m",   // gray
  debug: "\x1b[36m",   // cyan
  info: "\x1b[32m",    // green
  warn: "\x1b[33m",    // yellow
  error: "\x1b[31m",   // red
  fatal: "\x1b[35m",   // magenta
};

const RESET = "\x1b[0m";

// ─── Logger ────────────────────────────────────────────────────────────────────

export class Logger {
  private config: LoggerConfig;
  private static instance: Logger | null = null;
  /** 文件 Appender 集合（setupFileLogging 后启用） */
  private fileAppenders: {
    agent: RotatingFileAppender | null;
    errors: RotatingFileAppender | null;
    gateway: RotatingFileAppender | null;
  } = { agent: null, errors: null, gateway: null };
  /** 会话上下文（注入到日志行） */
  private sessionContext: string | null = null;

  constructor(config?: Partial<LoggerConfig>) {
    this.config = {
      minLevel: (process.env.LOG_LEVEL as LogLevel) || "info",
      prettyPrint: process.env.NODE_ENV !== "production",
      enableRedaction: true,
      ...config,
    };
  }

  /** Get or create the singleton logger instance */
  static getInstance(config?: Partial<LoggerConfig>): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(config);
    }
    return Logger.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    Logger.instance = null;
  }

  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ── File logging ──

  /**
   * 启用文件日志：创建 3 个 RotatingFileAppender
   * - agent.log（INFO+，所有子系统）
   * - errors.log（WARN+，仅错误）
   * - gateway.log（INFO+，仅 gateway 子系统）
   *
   * profile 感知：若提供 profile，则日志写到 logDir/profile/ 子目录。
   */
  setupFileLogging(options: FileLoggingOptions): void {
    this.closeFileAppenders();

    const effectiveLogDir = options.profile
      ? path.join(options.logDir, options.profile)
      : options.logDir;

    if (options.sessionId) {
      this.sessionContext = options.sessionId;
    }

    this.fileAppenders.agent = new RotatingFileAppender({
      filePath: path.join(effectiveLogDir, "agent.log"),
      sync: true,
    });
    this.fileAppenders.errors = new RotatingFileAppender({
      filePath: path.join(effectiveLogDir, "errors.log"),
      sync: true,
    });
    this.fileAppenders.gateway = new RotatingFileAppender({
      filePath: path.join(effectiveLogDir, "gateway.log"),
      sync: true,
    });
  }

  /** 设置会话上下文，注入到后续日志行 */
  setSessionContext(sessionId: string): void {
    this.sessionContext = sessionId;
  }

  /** 清除会话上下文 */
  clearSessionContext(): void {
    this.sessionContext = null;
  }

  /** 关闭所有文件 Appender（优雅关闭时调用） */
  closeFileAppenders(): void {
    for (const key of ["agent", "errors", "gateway"] as const) {
      this.fileAppenders[key]?.close();
      this.fileAppenders[key] = null;
    }
  }

  // ── Public log methods ──

  trace(subsystem: string, message: string, data?: Record<string, unknown>): void {
    this.log("trace", subsystem, message, data);
  }

  debug(subsystem: string, message: string, data?: Record<string, unknown>): void {
    this.log("debug", subsystem, message, data);
  }

  info(subsystem: string, message: string, data?: Record<string, unknown>): void {
    this.log("info", subsystem, message, data);
  }

  warn(subsystem: string, message: string, data?: Record<string, unknown>): void {
    this.log("warn", subsystem, message, data);
  }

  error(subsystem: string, message: string, error?: Error | string, data?: Record<string, unknown>): void {
    const errStr = error instanceof Error ? error.message : error;
    const stack = error instanceof Error ? error.stack : undefined;
    this.log("error", subsystem, message, data, errStr, stack);
  }

  fatal(subsystem: string, message: string, error?: Error | string, data?: Record<string, unknown>): void {
    const errStr = error instanceof Error ? error.message : error;
    const stack = error instanceof Error ? error.stack : undefined;
    this.log("fatal", subsystem, message, data, errStr, stack);
  }

  // ── Internal ──

  private log(
    level: LogLevel,
    subsystem: string,
    message: string,
    data?: Record<string, unknown>,
    errorMsg?: string,
    stack?: string
  ): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.config.minLevel]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      subsystem,
      message,
      data: data ? this.redactSensitive(data) : undefined,
      // 安全：error message 和 stack 可能含连接字符串（含密码）、
      // SQL 语句、文件路径等敏感信息，必须经过脱敏
      error: errorMsg ? this.redactValue(errorMsg) : undefined,
      stack: stack ? this.redactValue(stack) : undefined,
    };

    const output = this.config.prettyPrint
      ? this.formatPretty(entry)
      : JSON.stringify(entry);

    if (this.config.outputStream) {
      this.config.outputStream(output);
    } else {
      const dest = level === "error" || level === "fatal" ? process.stderr : process.stdout;
      dest.write(output + "\n");
    }

    // 文件日志：根据级别和子系统分发到对应 Appender
    this.writeToFiles(level, subsystem, entry);
  }

  /** 将日志行写入文件 Appender（agent.log / errors.log / gateway.log） */
  private writeToFiles(level: LogLevel, subsystem: string, entry: LogEntry): void {
    if (!this.fileAppenders.agent && !this.fileAppenders.errors && !this.fileAppenders.gateway) {
      return;
    }
    const line = this.formatFileLine(entry) + "\n";
    const levelOrd = LEVEL_ORDER[level];

    // agent.log: INFO+，所有子系统
    if (this.fileAppenders.agent && levelOrd >= LEVEL_ORDER["info"]) {
      this.fileAppenders.agent.append(line);
    }
    // errors.log: WARN+，仅错误
    if (this.fileAppenders.errors && levelOrd >= LEVEL_ORDER["warn"]) {
      this.fileAppenders.errors.append(line);
    }
    // gateway.log: INFO+，仅 gateway 子系统
    if (
      this.fileAppenders.gateway &&
      levelOrd >= LEVEL_ORDER["info"] &&
      this.isGatewaySubsystem(subsystem)
    ) {
      this.fileAppenders.gateway.append(line);
    }
  }

  /** 格式化文件日志行：[timestamp] [LEVEL] [session_id] [subsystem] message */
  private formatFileLine(entry: LogEntry): string {
    const level = entry.level.toUpperCase();
    const sessionPart = this.sessionContext ? ` [${this.sessionContext}]` : "";
    let line = `[${entry.timestamp}] [${level}]${sessionPart} [${entry.subsystem}] ${entry.message}`;
    if (entry.error) {
      line += ` | error=${entry.error}`;
    }
    if (entry.data && Object.keys(entry.data).length > 0) {
      line += ` | ${JSON.stringify(entry.data)}`;
    }
    return line;
  }

  /** 判断是否为 gateway 子系统（"gateway" 或 "gateway:*"） */
  private isGatewaySubsystem(subsystem: string): boolean {
    return subsystem === "gateway" || subsystem.startsWith("gateway:");
  }

  private formatPretty(entry: LogEntry): string {
    const color = LEVEL_COLORS[entry.level] || "";
    const levelPad = entry.level.toUpperCase().padEnd(5);
    const time = entry.timestamp.split("T")[1]?.slice(0, 12) || entry.timestamp;

    const sessionPart = this.sessionContext ? ` [${this.sessionContext}]` : "";
    let line = `${color}[${time}] ${levelPad}${RESET}${sessionPart} [${entry.subsystem}] ${entry.message}`;
    if (entry.error) {
      line += ` | error=${entry.error}`;
    }
    if (entry.data && Object.keys(entry.data).length > 0) {
      line += ` | ${JSON.stringify(entry.data)}`;
    }
    return line;
  }

  private redactSensitive(data: Record<string, unknown>): Record<string, unknown> {
    if (!this.config.enableRedaction) return data;

    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.has(key) || SENSITIVE_KEYS.has(lowerKey)) {
        redacted[key] = "[REDACTED]";
      } else if (typeof value === "string") {
        redacted[key] = this.redactValue(value);
      } else if (Array.isArray(value)) {
        // 安全：递归脱敏数组元素（含嵌套数组），防止 [{ apiKey: "xxx" }] 等嵌套敏感数据泄漏
        redacted[key] = value.map((v) => this.redactUnknown(v));
      } else if (value instanceof Map) {
        // 安全：递归脱敏 Map 的值（键假定非敏感），防止 { config: Map([["token","xxx"]]) } 泄漏
        redacted[key] = new Map(
          [...value].map(([k, v]) => [
            k,
            typeof v === "string"
              ? this.redactValue(v)
              : typeof v === "object" && v !== null
                ? this.redactSensitive(v as Record<string, unknown>)
                : v,
          ]),
        );
      } else if (value instanceof Set) {
        // 安全：递归脱敏 Set 元素
        redacted[key] = new Set(
          [...value].map((v) =>
            typeof v === "string"
              ? this.redactValue(v)
              : typeof v === "object" && v !== null
                ? this.redactSensitive(v as Record<string, unknown>)
                : v
          ),
        );
      } else if (typeof value === "object" && value !== null) {
        redacted[key] = this.redactSensitive(value as Record<string, unknown>);
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  private redactValue(value: string): string {
    let result = value;
    for (const pattern of SENSITIVE_VALUE_PATTERNS) {
      result = result.replace(pattern, "[REDACTED]");
    }
    return result;
  }

  /** 脱敏任意类型的值，支持嵌套数组/对象/Map/Set 的递归处理。 */
  private redactUnknown(value: unknown): unknown {
    if (typeof value === "string") return this.redactValue(value);
    if (Array.isArray(value)) return value.map((v) => this.redactUnknown(v));
    if (value instanceof Map) {
      return new Map([...value].map(([k, v]) => [k, this.redactUnknown(v)]));
    }
    if (value instanceof Set) {
      return new Set([...value].map((v) => this.redactUnknown(v)));
    }
    if (typeof value === "object" && value !== null) {
      return this.redactSensitive(value as Record<string, unknown>);
    }
    return value;
  }
}

// ── Convenience exports ────────────────────────────────────────────────────────

/** Create a subsystem-scoped logger */
export function createSubsystemLogger(subsystem: string): {
  trace: (msg: string, data?: Record<string, unknown>) => void;
  debug: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, err?: Error | string, data?: Record<string, unknown>) => void;
  fatal: (msg: string, err?: Error | string, data?: Record<string, unknown>) => void;
} {
  const logger = Logger.getInstance();
  return {
    trace: (msg, data) => logger.trace(subsystem, msg, data),
    debug: (msg, data) => logger.debug(subsystem, msg, data),
    info: (msg, data) => logger.info(subsystem, msg, data),
    warn: (msg, data) => logger.warn(subsystem, msg, data),
    error: (msg, err, data) => logger.error(subsystem, msg, err, data),
    fatal: (msg, err, data) => logger.fatal(subsystem, msg, err, data),
  };
}