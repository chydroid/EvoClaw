/**
 * Redact — 全栈密钥脱敏。
 *
 * 对标 Hermes v0.18.0 `agent/redact.py` 的 `redact_sensitive_text` +
 * `mask_secret` + `RedactingFormatter`：
 * 30+ 前缀模式覆盖 OpenAI / Anthropic / AWS / GCP / Azure / GitHub /
 * GitLab / Slack / JWT 等，统一占位符 `[REDACTED:<kind>]`。
 *
 * 用途：
 * 1. 日志 formatter：所有 winston/pino 日志在输出前过滤
 * 2. 遥测上报：OTel attributes / Sentry breadcrumb 脱敏
 * 3. 错误堆栈：err.message / err.stack 中的密钥过滤
 * 4. 配置 dump：打印配置对象时自动脱敏
 *
 * 注意：本模块是 best-effort 防护，不保证捕获所有变体。
 * 核心安全仍应通过 secret-manager + file-safety + write-approval 三层防护。
 */

/** 密钥种类 */
export type SecretKind =
  | "openai"
  | "anthropic"
  | "aws_access_key"
  | "aws_secret"
  | "gcp_api_key"
  | "azure_key"
  | "github_token"
  | "gitlab_token"
  | "slack_token"
  | "stripe_key"
  | "jwt"
  | "bearer"
  | "basic_auth"
  | "private_key"
  | "connection_string"
  | "generic_api_key"
  | "unknown";

/** 前缀模式定义 */
interface PrefixPattern {
  /** 密钥种类 */
  kind: SecretKind;
  /** 前缀正则（区分大小写） */
  pattern: RegExp;
  /** 最小密钥长度（含前缀） */
  minLength: number;
}

/**
 * 30+ 前缀模式。
 * 参考各家官方文档的 key 格式规范。
 */
const PREFIX_PATTERNS: PrefixPattern[] = [
  // OpenAI
  { kind: "openai", pattern: /sk-[a-zA-Z0-9]/, minLength: 20 },
  { kind: "openai", pattern: /sk-proj-[a-zA-Z0-9]/, minLength: 28 },
  { kind: "openai", pattern: /sk-ant-[a-zA-Z0-9]/, minLength: 28 },
  // Anthropic
  { kind: "anthropic", pattern: /sk-ant-api[0-9]?-[a-zA-Z0-9]/, minLength: 30 },
  // AWS
  { kind: "aws_access_key", pattern: /AKIA[0-9A-Z]/, minLength: 16 },
  { kind: "aws_access_key", pattern: /ASIA[0-9A-Z]/, minLength: 16 },
  { kind: "aws_secret", pattern: /aws_secret_access_key\s*[=:]\s*[A-Za-z0-9/+=]{40}/, minLength: 60 },
  // GCP
  { kind: "gcp_api_key", pattern: /AIza[0-9A-Za-z_-]/, minLength: 35 },
  // Azure
  { kind: "azure_key", pattern: /[0-9a-f]{32}-[0-9a-f]{32}/, minLength: 65 },
  // GitHub
  { kind: "github_token", pattern: /ghp_[A-Za-z0-9]/, minLength: 36 },
  { kind: "github_token", pattern: /gho_[A-Za-z0-9]/, minLength: 36 },
  { kind: "github_token", pattern: /ghu_[A-Za-z0-9]/, minLength: 36 },
  { kind: "github_token", pattern: /ghs_[A-Za-z0-9]/, minLength: 36 },
  { kind: "github_token", pattern: /ghr_[A-Za-z0-9]/, minLength: 36 },
  // GitLab
  { kind: "gitlab_token", pattern: /glpat-[A-Za-z0-9_-]/, minLength: 25 },
  // Slack
  { kind: "slack_token", pattern: /xox[baprs]-[A-Za-z0-9-]/, minLength: 25 },
  // Stripe
  { kind: "stripe_key", pattern: /sk_live_[A-Za-z0-9]/, minLength: 32 },
  { kind: "stripe_key", pattern: /sk_test_[A-Za-z0-9]/, minLength: 32 },
  { kind: "stripe_key", pattern: /rk_live_[A-Za-z0-9]/, minLength: 32 },
  { kind: "stripe_key", pattern: /rk_test_[A-Za-z0-9]/, minLength: 32 },
  // JWT（三个 base64 段，以 eyJ 开头）
  { kind: "jwt", pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, minLength: 30 },
  // Bearer token（Authorization header）
  { kind: "bearer", pattern: /[Bb]earer\s+[A-Za-z0-9_-]+/, minLength: 15 },
  // Basic auth
  { kind: "basic_auth", pattern: /[Bb]asic\s+[A-Za-z0-9+/=]+/, minLength: 15 },
  // Private key
  { kind: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, minLength: 30 },
  // Connection string
  { kind: "connection_string", pattern: /(?:postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^\s:]+:[^\s@]+@/, minLength: 20 },
  // 通用 API key（key=XXX 或 api_key=XXX）
  { kind: "generic_api_key", pattern: /(?:api[_-]?key|secret|password|passwd|token)\s*[=:]\s*['"]?[A-Za-z0-9_-]{16,}/i, minLength: 25 },
];

/** 脱敏结果 */
export interface RedactResult {
  /** 脱敏后的文本 */
  redacted: string;
  /** 命中的脱敏次数 */
  count: number;
  /** 命中的种类 */
  kinds: SecretKind[];
}

/**
 * 对文本进行密钥脱敏。
 * 命中的密钥替换为 `[REDACTED:<kind>]`，保留前 4 个字符用于上下文识别。
 *
 * @param text 待脱敏的文本
 * @param options 选项
 *   - preservePrefix: 是否保留前 4 字符（默认 true，便于日志上下文）
 *   - placeholder: 自定义占位符（默认 `[REDACTED:<kind>]`）
 */
export function redactSensitiveText(
  text: string,
  options?: {
    preservePrefix?: boolean;
    placeholder?: (kind: SecretKind, prefix: string) => string;
  },
): RedactResult {
  if (!text || typeof text !== "string") {
    return { redacted: text ?? "", count: 0, kinds: [] };
  }

  const preservePrefix = options?.preservePrefix ?? true;
  const placeholder =
    options?.placeholder ??
    ((kind: SecretKind, prefix: string) =>
      preservePrefix ? `${prefix}...[REDACTED:${kind}]` : `[REDACTED:${kind}]`);

  let result = text;
  let count = 0;
  const kinds = new Set<SecretKind>();

  // 按模式长度降序处理（避免短前缀覆盖长前缀，如 sk-ant- 应优先于 sk-）
  const sortedPatterns = [...PREFIX_PATTERNS].sort((a, b) => {
    const aLen = String(a.pattern).length;
    const bLen = String(b.pattern).length;
    return bLen - aLen;
  });

  for (const { kind, pattern, minLength } of sortedPatterns) {
    // 使用 replace 的回调形式处理每个匹配
    result = result.replace(pattern, (match) => {
      if (match.length < minLength) return match;
      count++;
      kinds.add(kind);
      // 提取前缀（前 4 字符或匹配开头）
      const prefix = preservePrefix ? match.slice(0, 4) : "";
      return placeholder(kind, prefix);
    });
  }

  return {
    redacted: result,
    count,
    kinds: Array.from(kinds),
  };
}

/**
 * 部分遮蔽密钥（保留首尾，中间用 * 替换）。
 * 用于 UI 展示场景（如配置面板显示部分密钥让用户确认）。
 *
 * 例：`sk-abc123xyz789` → `sk-a***789`
 */
export function maskSecret(secret: string, options?: { visiblePrefix?: number; visibleSuffix?: number }): string {
  if (!secret) return "";
  const visiblePrefix = options?.visiblePrefix ?? 4;
  const visibleSuffix = options?.visibleSuffix ?? 4;
  if (secret.length <= visiblePrefix + visibleSuffix) {
    // 过短的密钥全部遮蔽
    return "*".repeat(secret.length);
  }
  const prefix = secret.slice(0, visiblePrefix);
  const suffix = secret.slice(-visibleSuffix);
  const masked = "*".repeat(Math.min(secret.length - visiblePrefix - visibleSuffix, 20));
  return `${prefix}${masked}${suffix}`;
}

/**
 * 检测文本中是否包含可能的密钥（不脱敏，仅判断）。
 * 用于输入校验场景。
 */
export function containsSecret(text: string): boolean {
  if (!text) return false;
  for (const { pattern, minLength } of PREFIX_PATTERNS) {
    const m = pattern.exec(text);
    if (m && m[0].length >= minLength) return true;
  }
  return false;
}

/**
 * 脱敏对象中的敏感字段（递归）。
 * 字段名匹配 /key|secret|token|password|passwd|credential/i 的字符串值会被脱敏。
 *
 * @param obj 待脱敏的对象
 * @param depth 最大递归深度（默认 5）
 */
export function redactObject<T>(obj: T, depth = 5): T {
  if (depth <= 0 || obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    return redactSensitiveText(obj).redacted as unknown as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, depth - 1)) as unknown as T;
  }

  if (typeof obj === "object" && obj instanceof Object) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof value === "string" && /key|secret|token|password|passwd|credential|authorization/i.test(key)) {
        result[key] = maskSecret(value);
      } else {
        result[key] = redactObject(value, depth - 1);
      }
    }
    return result as unknown as T;
  }

  return obj;
}

/**
 * 创建 winston 兼容的日志 formatter。
 * 在日志输出前对 message 和 meta 进行脱敏。
 *
 * 用法：
 * ```ts
 * import winston from "winston";
 * const logger = winston.createLogger({
 *   format: winston.format.combine(
 *     winston.format.simple(),
 *     redactingFormatter(),
 *   ),
 *   transports: [new winston.transports.Console()],
 * });
 * ```
 */
export function redactingFormatter() {
  return {
    transform(info: { message?: string; [k: string]: unknown }): typeof info {
      if (info.message) {
        info.message = redactSensitiveText(String(info.message)).redacted;
      }
      // 对 meta 字段进行对象级脱敏（排除 message 已处理）
      const redacted = redactObject(info, 3);
      Object.assign(info, redacted);
      return info;
    },
  };
}

/** URL 内嵌凭据脱敏：https://user:pass@host → https://[REDACTED:url-cred]@host */
export function redactUrlCredentials(url: string): string {
  if (!url) return url;
  return url.replace(
    /(\w+):\/\/[^\s:]+:[^\s@]+@/,
    "$1://[REDACTED:url-cred]@",
  );
}

/** 环境变量值脱敏：保留 key，仅脱敏 value */
export function redactEnvValue(key: string, value: string): string {
  if (!value) return value;
  // 已知敏感 env key
  if (/(?:key|secret|token|password|passwd|credential|api_key|private_key)/i.test(key)) {
    return maskSecret(value);
  }
  // 值本身可能是密钥
  if (containsSecret(value)) {
    return maskSecret(value);
  }
  return value;
}
