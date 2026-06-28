// 配置审计：检测危险配置项、prototype pollution、不安全默认值。
// 对齐 openclaw-main src/security/audit-config-basics + dangerous-config-flags 的核心检查项。
// 保持纯函数 + 零依赖，便于在 AuditCenter 中复用与测试。

export interface ConfigAuditInput {
  /** 待审计的配置对象 */
  config: Record<string, unknown>;
  /** 配置文件路径（用于错误定位） */
  configPath?: string;
  /** 严格模式（更多检查，例如更激进的密钥识别） */
  strictMode?: boolean;
}

export type ConfigAuditSeverity = "info" | "warning" | "error";

export interface ConfigAuditFinding {
  severity: ConfigAuditSeverity;
  /** 规则 ID（如 "config-prototype-pollution"） */
  rule: string;
  /** 配置路径（如 "channels.wechat.token"） */
  path: string;
  message: string;
  suggestion?: string;
}

// prototype pollution 与代码执行相关的危险键
const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// 危险配置键：值为真值时视为高风险开关
interface DangerousFlagDescriptor {
  key: string;
  rule: string;
  message: string;
  suggestion: string;
}

const DANGEROUS_FLAGS: DangerousFlagDescriptor[] = [
  {
    key: "allowEval",
    rule: "config-allow-eval",
    message: "allowEval=true 允许执行任意代码，存在 RCE 风险",
    suggestion: "保持 allowEval=false，使用受限的工具调用通道替代 eval",
  },
  {
    key: "disableSandbox",
    rule: "config-disable-sandbox",
    message: "disableSandbox=true 关闭沙箱隔离，工具执行将直接访问宿主环境",
    suggestion: "保持沙箱开启；仅在受控可信环境临时禁用",
  },
  {
    key: "allowRoot",
    rule: "config-allow-root",
    message: "allowRoot=true 允许以 root/管理员身份运行，提升提权风险",
    suggestion: "使用非特权用户运行服务进程",
  },
  {
    key: "dangerouslyDisableAuth",
    rule: "config-disable-auth",
    message: "dangerouslyDisableAuth=true 关闭鉴权，存在未授权访问风险",
    suggestion: "仅在本地调试使用，生产环境务必开启鉴权",
  },
];

// 密钥相关的键名模式（不区分大小写）
const SECRET_KEY_PATTERN = /(?:^|[-_])(password|passwd|secret|token|apikey|api_key|accesskey|access_key|privatekey|private_key)(?:[-_]|$)/i;

// 形如 ${ENV_VAR} 或 ${ env.ENV_VAR } 的环境变量引用
const ENV_REF_PATTERN = /^\s*\$\{[^}]+\}\s*$/;

// 提示文案中使用的环境变量引用示例（避免模板字面量误解析）
const ENV_REF_EXAMPLE = "${ENV_VAR}";

// 不安全监听地址
const UNSAFE_HOSTS = new Set(["0.0.0.0", "::", "*", "[::]"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof RegExp) &&
    !(value instanceof Error)
  );
}

function isEnvRef(value: unknown): boolean {
  return typeof value === "string" && ENV_REF_PATTERN.test(value);
}

/** 递归遍历配置，针对每个键值对触发检测回调。 */
function walkConfig(
  node: unknown,
  path: string,
  onEntry: (key: string, value: unknown, path: string) => void,
  visited: WeakSet<object>,
): void {
  if (!isPlainObject(node)) {
    return;
  }
  if (visited.has(node)) {
    return;
  }
  visited.add(node);
  for (const [key, value] of Object.entries(node)) {
    const childPath = path ? `${path}.${key}` : key;
    onEntry(key, value, childPath);
    if (isPlainObject(value)) {
      walkConfig(value, childPath, onEntry, visited);
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (isPlainObject(item)) {
          walkConfig(item, `${childPath}[${i}]`, onEntry, visited);
        }
      }
    }
  }
}

function isTruthyFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return /^(true|yes|1|on)$/i.test(value.trim());
  }
  if (typeof value === "number") return value !== 0;
  return false;
}

/**
 * 审计配置对象，返回所有风险发现。
 * 检查项：
 * 1. prototype pollution 危险键（__proto__/constructor/prototype）
 * 2. 危险开关（allowEval/disableSandbox/allowRoot 等）
 * 3. 明文密钥（key 名含 password/secret/token/apikey 且值非空且未引用 ${ENV_VAR}）
 * 4. 不安全监听地址（host/bind: 0.0.0.0）
 * 5. CORS 通配（cors: "*" 或 cors.origin: "*"）
 */
export function auditConfig(input: ConfigAuditInput): ConfigAuditFinding[] {
  const findings: ConfigAuditFinding[] = [];
  const strictMode = input.strictMode === true;
  const configPrefix = input.configPath ?? "<config>";

  walkConfig(
    input.config,
    "",
    (key, value, path) => {
      // 1. prototype pollution 危险键
      if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
        findings.push({
          severity: "error",
          rule: "config-prototype-pollution",
          path: path || key,
          message: `检测到危险键 "${key}"，可能导致 prototype pollution 攻击`,
          suggestion: "拒绝包含 __proto__/constructor/prototype 的配置键，改用安全合并",
        });
        return;
      }

      // 2. 危险开关
      const flagDescriptor = DANGEROUS_FLAGS.find((d) => d.key === key);
      if (flagDescriptor && isTruthyFlag(value)) {
        findings.push({
          severity: "error",
          rule: flagDescriptor.rule,
          path: path || key,
          message: flagDescriptor.message,
          suggestion: flagDescriptor.suggestion,
        });
      }

      // 3. 明文密钥
      if (SECRET_KEY_PATTERN.test(key) && typeof value === "string" && value.length > 0) {
        if (!isEnvRef(value)) {
          findings.push({
            severity: strictMode ? "error" : "warning",
            rule: "config-plaintext-secret",
            path: path || key,
            message: `配置项 "${key}" 疑似明文密钥（长度 ${value.length}），未使用 ${ENV_REF_EXAMPLE} 引用`,
            suggestion: `将密钥迁移到环境变量或密钥管理器，配置中仅保留 ${ENV_REF_EXAMPLE} 引用`,
          });
        }
      }

      // 4. 不安全监听地址
      if (
        (key === "host" || key === "bind" || key === "listen") &&
        typeof value === "string" &&
        UNSAFE_HOSTS.has(value.trim())
      ) {
        findings.push({
          severity: "warning",
          rule: "config-unsafe-bind",
          path: path || key,
          message: `${key}="${value}" 绑定到所有网卡，外部网络可直接访问`,
          suggestion: '改为 "127.0.0.1" 或具体内网地址，通过反向代理对外暴露',
        });
      }

      // 5. CORS 通配
      if (key === "cors" && typeof value === "string" && value.trim() === "*") {
        findings.push({
          severity: "warning",
          rule: "config-cors-wildcard",
          path: path || key,
          message: 'cors="*" 允许任意来源跨域访问',
          suggestion: "限定为可信来源列表，避免通配符",
        });
      }
      if (key === "origin" && typeof value === "string" && value.trim() === "*") {
        // 仅当父路径含 cors 时报
        if (/cors/i.test(path)) {
          findings.push({
            severity: "warning",
            rule: "config-cors-wildcard",
            path: path || key,
            message: 'cors.origin="*" 允许任意来源跨域访问',
            suggestion: "限定为可信来源列表，避免通配符",
          });
        }
      }
    },
    new WeakSet<object>(),
  );

  // 顶层 config 不为对象时
  if (!isPlainObject(input.config)) {
    findings.push({
      severity: "warning",
      rule: "config-invalid-root",
      path: configPrefix,
      message: "配置根节点不是普通对象，审计结果可能不完整",
    });
  }

  return findings;
}
