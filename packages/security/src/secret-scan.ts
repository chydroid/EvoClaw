// 明文密钥扫描 — 检测配置对象中的明文凭据。
//
// 与 transcript-redactor.ts 互补：
//   - transcript-redactor: 用于运行时日志/文本的脱敏（替换模式 + 统计）
//   - secret-scan: 用于静态配置对象的明文密钥检测（不替换，仅产出 findings）
//
// 灵感来自 openclaw-main 的 src/secrets/runtime/secret-scan.ts
// （hasSecretRefCandidate / hasCredentialBearingObjectValue）。
// EvoClaw 实现独立：默认规则集 + 递归遍历 + 环境变量引用豁免。

/** 单次扫描发现 */
export interface SecretScanFinding {
  /** 规则 ID（如 "aws-access-key"） */
  ruleId: string;
  /** 严重程度 */
  severity: "info" | "warning" | "error";
  /** 配置键路径（如 "channels.wechat.token"） */
  key: string;
  /** 脱敏后的值（保留前 4 + 后 4 字符 + ***） */
  matchedValue: string;
  /** 规则描述 */
  rule: string;
}

/** 密钥检测规则 */
export interface SecretScanRule {
  /** 规则 ID（唯一标识） */
  id: string;
  /** 规则名称 */
  name: string;
  /** 匹配模式（正则） */
  pattern: RegExp;
  /** 严重程度 */
  severity: "info" | "warning" | "error";
  /** 已知的合法环境变量名（豁免扫描） */
  exemptKeys?: string[];
  /** 可选：仅当 key 名匹配此模式时才检测（用于 generic 类规则） */
  keyNamePattern?: RegExp;
}

// 默认密钥检测规则
export const DEFAULT_SECRET_RULES: SecretScanRule[] = [
  {
    id: "aws-access-key",
    name: "AWS Access Key ID",
    pattern: /AKIA[0-9A-Z]{16}/,
    severity: "error",
  },
  {
    id: "aws-secret-key",
    name: "AWS Secret Access Key",
    pattern: /aws_secret_access_key\s*=\s*["']?[A-Za-z0-9/+=]{40}["']?/i,
    severity: "error",
  },
  {
    id: "github-token",
    name: "GitHub Token",
    pattern: /gh[ps]_[A-Za-z0-9]{36}/,
    severity: "error",
  },
  {
    id: "openai-api-key",
    name: "OpenAI API Key",
    pattern: /sk-[A-Za-z0-9]{48}/,
    severity: "error",
  },
  {
    id: "anthropic-api-key",
    name: "Anthropic API Key",
    pattern: /sk-ant-[A-Za-z0-9-]{93}/,
    severity: "error",
  },
  {
    id: "google-api-key",
    name: "Google API Key",
    pattern: /AIza[0-9A-Za-z\-_]{35}/,
    severity: "error",
  },
  {
    id: "jwt-token",
    name: "JWT Token",
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
    severity: "warning",
  },
  {
    id: "private-key-pem",
    name: "PEM Private Key",
    pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    severity: "error",
  },
  {
    id: "slack-token",
    name: "Slack Token",
    pattern: /xox[baprs]-[A-Za-z0-9-]+/,
    severity: "error",
  },
  {
    id: "stripe-key",
    name: "Stripe Key",
    pattern: /sk_(live|test)_[A-Za-z0-9]{24}/,
    severity: "error",
  },
  {
    id: "generic-api-key",
    name: "Generic API Key（疑似）",
    // 仅匹配 value 部分（32+ 字符的字母数字+连字符序列）
    pattern: /\b[A-Za-z0-9_\-]{32,}\b/,
    severity: "warning",
    // 仅当 key 名看起来像 API key / secret / token 时才检测
    keyNamePattern: /api[_-]?key|apikey|secret[_-]?key|access[_-]?token/i,
    exemptKeys: ["api_key_placeholder", "api_key_example"],
  },
];

// 环境变量引用模式（形如 ${VAR_NAME} 或 ${env.VAR_NAME}），豁免扫描
const ENV_VAR_REFERENCE = /^\$\{[A-Z_][A-Z0-9_]*\}$/;

/**
 * 脱敏字符串值：保留前 4 + 后 4 字符，中间替换为 ***。
 * 短字符串（<=8 字符）整体替换为 ***，避免泄露更多信息。
 *
 * @param value 原始字符串
 * @returns 脱敏后的字符串
 */
export function redactValue(value: string): string {
  if (value.length <= 8) return "***";
  return value.slice(0, 4) + "***" + value.slice(-4);
}

/**
 * 判断一个键名是否应被豁免。
 * 兼容大小写与下划线/连字符差异。
 */
function isExemptKey(keyName: string, exemptKeys: string[]): boolean {
  const normalized = keyName.toLowerCase();
  return exemptKeys.some((ex) => ex.toLowerCase() === normalized);
}

/**
 * 判断值是否为环境变量引用（豁免）。
 */
function isEnvVarReference(value: string): boolean {
  return ENV_VAR_REFERENCE.test(value);
}

/**
 * 递归扫描配置对象，收集所有明文密钥发现。
 *
 * 算法：
 *   1. 遍历对象/数组
 *   2. 对每个字符串值：
 *      - 若匹配 ENV_VAR_REFERENCE → 豁免（${VAR_NAME} 形式）
 *      - 若 key 名在 opts.exemptKeys 或 rule.exemptKeys 中 → 豁免
 *      - 否则对每个 rule.pattern 检测，命中则产生 finding
 *   3. 用 WeakSet 跟踪已访问对象，防止循环引用
 *
 * @param config 待扫描的配置对象
 * @param opts 选项：rules? exemptKeys? basePath?
 * @returns 所有发现
 */
export function scanSecrets(
  config: Record<string, unknown>,
  opts?: {
    rules?: SecretScanRule[];
    exemptKeys?: string[];
    basePath?: string;
  },
): SecretScanFinding[] {
  const rules = opts?.rules ?? DEFAULT_SECRET_RULES;
  const exemptKeys = opts?.exemptKeys ?? [];
  const basePath = opts?.basePath ?? "";
  const findings: SecretScanFinding[] = [];
  const seen = new WeakSet<object>();

  function visit(value: unknown, keyPath: string, keyName: string): void {
    // 字符串值：检测明文密钥
    if (typeof value === "string") {
      // 空字符串跳过
      if (value.length === 0) return;
      // 环境变量引用豁免
      if (isEnvVarReference(value)) return;
      // 全局豁免键
      if (isExemptKey(keyName, exemptKeys)) return;

      for (const rule of rules) {
        // 规则级豁免
        if (rule.exemptKeys && isExemptKey(keyName, rule.exemptKeys)) {
          continue;
        }
        // keyNamePattern 过滤：若规则指定了 key 名模式，且 key 名不匹配，跳过
        if (rule.keyNamePattern && !rule.keyNamePattern.test(keyName)) {
          continue;
        }
        // 重置 lastIndex（防止全局正则的状态污染）
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(value)) {
          findings.push({
            ruleId: rule.id,
            severity: rule.severity,
            key: keyPath || keyName,
            matchedValue: redactValue(value),
            rule: rule.name,
          });
          // 同一字符串匹配多个规则时，记录所有命中（便于审计）
          // 但避免同一规则重复命中（已用 lastIndex 重置）
        }
      }
      return;
    }

    // 数组：递归每个元素
    if (Array.isArray(value)) {
      if (seen.has(value)) return;
      seen.add(value);
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        const childPath = keyPath ? `${keyPath}[${i}]` : `[${i}]`;
        visit(item, childPath, keyName);
      }
      return;
    }

    // 普通对象：递归每个字段
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (seen.has(obj)) return;
      seen.add(obj);
      for (const [k, v] of Object.entries(obj)) {
        const childPath = keyPath ? `${keyPath}.${k}` : k;
        visit(v, childPath, k);
      }
      return;
    }

    // 数字、布尔、null/undefined 不视为密钥
  }

  visit(config, basePath, basePath);

  return findings;
}

/**
 * 便捷封装：判断配置对象是否包含任何明文密钥。
 *
 * @param config 待检测的配置对象
 * @param opts 选项（同 scanSecrets）
 * @returns 是否包含明文密钥
 */
export function hasPlaintextSecrets(
  config: Record<string, unknown>,
  opts?: {
    rules?: SecretScanRule[];
    exemptKeys?: string[];
    basePath?: string;
  },
): boolean {
  return scanSecrets(config, opts).length > 0;
}

/**
 * 便捷封装：获取默认规则列表（便于查阅/扩展）。
 */
export function getDefaultSecretRules(): SecretScanRule[] {
  return [...DEFAULT_SECRET_RULES];
}
