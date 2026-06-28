// 渠道审计：检测渠道配置漏洞、token 泄露、不安全的 webhook URL。
// 对齐 openclaw-main src/security/audit-channel.ts 的核心检查项（DM policy/token/webhook）。
// 纯函数实现，输入为已规范化为 Record 的渠道列表，避免耦合渠道插件内部类型。

export interface ChannelAuditChannel {
  id: string;
  /** 渠道类型：wechat/feishu/dingtalk/telegram/slack/... */
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface ChannelAuditInput {
  channels: ChannelAuditChannel[];
}

export type ChannelAuditSeverity = "info" | "warning" | "error";

export interface ChannelAuditFinding {
  severity: ChannelAuditSeverity;
  rule: string;
  channelId: string;
  channelType: string;
  message: string;
  suggestion?: string;
}

// 凭证相关键名（各渠道通用）
const CREDENTIAL_KEYS = [
  "token",
  "appSecret",
  "botToken",
  "accessToken",
  "apiKey",
  "api_key",
  "secret",
  "password",
];

// 形如 ${ENV_VAR} 的环境变量引用
const ENV_REF_PATTERN = /^\s*\$\{[^}]+\}\s*$/;

// 提示文案中使用的环境变量引用示例（避免模板字面量误解析）
const ENV_REF_EXAMPLE = "${ENV_VAR}";

// 各渠道类型必需的配置键
const REQUIRED_KEYS_BY_TYPE: Record<string, string[]> = {
  wechat: ["token"],
  feishu: ["appId", "appSecret"],
  dingtalk: ["token"],
  telegram: ["botToken"],
  slack: ["botToken"],
  discord: ["botToken"],
};

// 标识允许所有用户访问的键名（不同渠道命名不一）
const ALLOW_ALL_KEYS = ["allowAllUsers", "allowAnyone", "dmPolicy", "openDM"];

function isEnvRef(value: unknown): boolean {
  return typeof value === "string" && ENV_REF_PATTERN.test(value);
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith("http://");
}

function isTruthyFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return /^(true|yes|1|on|open)$/i.test(value.trim());
  }
  return false;
}

/**
 * 审计渠道列表，返回所有风险发现。
 * 检查项：
 * 1. token 明文（凭证键是非空字符串且未引用 ${ENV_VAR}）
 * 2. webhook URL 使用 HTTP 而非 HTTPS
 * 3. enabled=true 但缺少必需配置（按渠道类型）
 * 4. 渠道允许所有人访问（allowAllUsers=true 等且无白名单）
 * 5. 调试模式开启（debug=true）
 */
export function auditChannels(input: ChannelAuditInput): ChannelAuditFinding[] {
  const findings: ChannelAuditFinding[] = [];

  for (const channel of input.channels ?? []) {
    const cfg = channel.config ?? {};
    const base = {
      channelId: channel.id,
      channelType: channel.type,
    };

    // 1. 凭证明文
    for (const credKey of CREDENTIAL_KEYS) {
      const value = cfg[credKey];
      if (typeof value === "string" && value.length > 0 && !isEnvRef(value)) {
        findings.push({
          ...base,
          severity: "error",
          rule: "channel-plaintext-credential",
          message: `渠道配置项 "${credKey}" 为明文凭证（长度 ${value.length}），未使用 ${ENV_REF_EXAMPLE} 引用`,
          suggestion: `迁移到环境变量或密钥管理器，配置中仅保留 ${ENV_REF_EXAMPLE} 引用`,
        });
      }
    }

    // 2. webhook URL HTTP
    for (const webhookKey of ["webhookUrl", "webhook", "callbackUrl", "url"]) {
      const value = cfg[webhookKey];
      if (isHttpUrl(value)) {
        findings.push({
          ...base,
          severity: "warning",
          rule: "channel-insecure-webhook",
          message: `${webhookKey} 使用 HTTP 明文传输，可能被中间人窃听/篡改：${value}`,
          suggestion: "改用 HTTPS webhook，并验证对端证书",
        });
      }
    }

    // 3. enabled=true 但缺少必需配置
    if (channel.enabled) {
      const required = REQUIRED_KEYS_BY_TYPE[channel.type.toLowerCase()];
      if (required && required.length > 0) {
        const missing = required.filter((k) => {
          const v = cfg[k];
          return v === undefined || v === null || v === "";
        });
        if (missing.length > 0) {
          findings.push({
            ...base,
            severity: "error",
            rule: "channel-missing-required-config",
            message: `渠道已启用但缺少必需配置：${missing.join(", ")}`,
            suggestion: "补全渠道凭证与回调配置，或显式设置 enabled=false",
          });
        }
      }
    }

    // 4. 允许所有用户访问且无白名单
    const allowAllOpen = ALLOW_ALL_KEYS.some((k) => {
      const v = cfg[k];
      return isTruthyFlag(v) || (typeof v === "string" && v.toLowerCase() === "open");
    });
    if (allowAllOpen) {
      const allowlist = cfg["allowFrom"] ?? cfg["allowedUsers"] ?? cfg["whitelist"];
      const hasAllowlist =
        Array.isArray(allowlist) && allowlist.length > 0
          ? !allowlist.includes("*")
          : false;
      if (!hasAllowlist) {
        findings.push({
          ...base,
          severity: "warning",
          rule: "channel-open-access",
          message: "渠道开启全员开放访问且未配置白名单，任意用户可与机器人交互",
          suggestion: "配置 allowFrom/allowedUsers 白名单，或显式包含 * 以示已知风险",
        });
      }
    }

    // 5. 调试模式开启
    const debugValue = cfg["debug"] ?? cfg["debugMode"] ?? cfg["verbose"];
    if (isTruthyFlag(debugValue)) {
      findings.push({
        ...base,
        severity: "info",
        rule: "channel-debug-enabled",
        message: "渠道开启调试模式，可能在日志中泄露请求体与凭证",
        suggestion: "生产环境关闭 debug，限制日志输出级别",
      });
    }
  }

  return findings;
}
