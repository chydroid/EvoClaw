// 危险配置标记系统 — 结构化的危险配置项检测。
//
// 与 audit-config.ts 中扁平的危险开关列表互补：
//   - audit-config.ts: 用于 audit-config 模块的扁平 key 检测（如 "allowEval"）
//   - dangerous-config-flags.ts: 用于运行时配置的层级化检测
//     （如 "security.allowEval"）+ 安全值白名单 + 不安全值模式 + 环境感知
//
// 灵感来自 openclaw-main 的 src/security/dangerous-config-flags.ts，
// 但 EvoClaw 实现独立、自包含，不依赖 openclaw 的配置类型。

/** 配置严重程度 */
export type ConfigFlagSeverity = "info" | "warning" | "error" | "critical";

/** 适用环境 */
export type ConfigEnvironment = "production" | "staging" | "development";

/** 危险配置标记定义 */
export interface DangerousConfigFlag {
  /** 配置键（支持点号路径，如 "security.allowEval"） */
  key: string;
  /** 描述 */
  description: string;
  /** 严重程度 */
  severity: ConfigFlagSeverity;
  /** 安全值白名单（值在此列表中视为安全） */
  safeValues?: unknown[];
  /** 不安全值模式（值匹配任一 pattern 视为不安全） */
  unsafePatterns?: RegExp[];
  /** 适用环境列表（未指定则适用于所有环境） */
  appliesTo?: ConfigEnvironment[];
}

/** 单次扫描发现 */
export interface ConfigFlagFinding {
  /** 配置键 */
  key: string;
  /** 严重程度 */
  severity: ConfigFlagSeverity;
  /** 描述 */
  description: string;
  /** 实际值（来自配置） */
  actualValue?: unknown;
  /** 安全值列表 */
  safeValues?: unknown[];
}

// 默认危险配置标记清单
export const DANGEROUS_CONFIG_FLAGS: DangerousConfigFlag[] = [
  {
    key: "security.allowEval",
    description: "允许执行 eval / new Function",
    severity: "error",
    safeValues: [false],
  },
  {
    key: "security.disableSandbox",
    description: "禁用技能沙箱",
    severity: "error",
    safeValues: [false],
  },
  {
    key: "security.allowRoot",
    description: "允许 root 运行",
    severity: "critical",
    safeValues: [false],
  },
  {
    key: "security.dangerouslyDisableAuth",
    description: "禁用认证",
    severity: "critical",
    safeValues: [false],
    appliesTo: ["production"],
  },
  {
    key: "gateway.cors.origin",
    description: "CORS origin 通配符",
    severity: "warning",
    unsafePatterns: [/^\*$/],
  },
  {
    key: "gateway.cors.credentials",
    description: "CORS credentials 与 origin=* 同时启用",
    severity: "error",
    safeValues: [false],
  },
  {
    key: "gateway.tls.enabled",
    description: "TLS 禁用",
    severity: "error",
    safeValues: [true],
    appliesTo: ["production"],
  },
  {
    key: "gateway.host",
    description: "网关绑定到 0.0.0.0（公网可访问）",
    severity: "warning",
    unsafePatterns: [/^0\.0\.0\.0$/],
  },
  {
    key: "tools.allowWildcard",
    description: "工具策略使用通配符",
    severity: "warning",
    safeValues: [false],
  },
  {
    key: "skills.allowUnsignedMarketplace",
    description: "允许未签名 marketplace 技能",
    severity: "warning",
    safeValues: [false],
  },
  {
    key: "logging.redactSecrets",
    description: "禁用日志脱敏",
    severity: "error",
    safeValues: [true],
  },
  {
    key: "debug.enabled",
    description: "调试模式启用（生产环境危险）",
    severity: "warning",
    safeValues: [false],
    appliesTo: ["production"],
  },
];

// 自定义标记注册表（运行时可扩展）
const customFlags: DangerousConfigFlag[] = [];

/**
 * 沿点号路径获取嵌套对象中的值。
 *
 * @example getPath({ security: { allowEval: true } }, "security.allowEval") → true
 * @param config 配置对象
 * @param path 点号路径
 * @returns 路径上的值；不存在时返回 undefined
 */
function getPath(config: unknown, path: string): unknown {
  if (!config || typeof config !== "object") return undefined;
  const parts = path.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * 判断值是否匹配任一不安全模式。
 * 仅字符串值参与模式匹配。
 */
function matchesUnsafePattern(value: unknown, patterns: RegExp[]): boolean {
  if (typeof value !== "string") return false;
  return patterns.some((p) => p.test(value));
}

/**
 * 判断值是否在安全值白名单中。
 * 使用严格相等。
 */
function isInSafeValues(value: unknown, safeValues: unknown[]): boolean {
  return safeValues.some((safe) => value === safe);
}

/**
 * 判断值是否为真值（兼容字符串 "true"/"yes"/"1"/"on"）。
 */
function isTruthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return /^(true|yes|1|on)$/i.test(value.trim());
  }
  if (typeof value === "number") return value !== 0;
  return false;
}

/**
 * 扫描配置对象，识别危险配置项。
 *
 * 检测逻辑：
 *   1. 遍历 DANGEROUS_CONFIG_FLAGS + 自定义标记
 *   2. 用点号路径取值
 *   3. 若 appliesTo 已指定且 environment 不在 appliesTo 中 → 跳过
 *   4. 若值存在：
 *      - 若有 safeValues 且值不在 safeValues 中 → finding
 *      - 若有 unsafePatterns 且值匹配任一 pattern → finding
 *      - 若既无 safeValues 也无 unsafePatterns，按 isTruthy 判断（真值 → finding）
 *
 * @param config 待扫描的配置对象
 * @param opts 选项：environment?
 * @returns 所有发现的危险配置项
 */
export function scanDangerousConfigFlags(
  config: Record<string, unknown>,
  opts?: { environment?: ConfigEnvironment },
): ConfigFlagFinding[] {
  const findings: ConfigFlagFinding[] = [];
  const environment = opts?.environment;
  const allFlags = [...DANGEROUS_CONFIG_FLAGS, ...customFlags];

  for (const flag of allFlags) {
    // 环境过滤
    if (flag.appliesTo && environment) {
      if (!flag.appliesTo.includes(environment)) {
        continue;
      }
    }

    const value = getPath(config, flag.key);

    // 值不存在视为未配置，跳过
    if (value === undefined || value === null) {
      continue;
    }

    let isUnsafe = false;

    if (flag.safeValues && flag.safeValues.length > 0) {
      // 用 safeValues 模式：值不在白名单中即为不安全
      if (!isInSafeValues(value, flag.safeValues)) {
        isUnsafe = true;
      }
    } else if (flag.unsafePatterns && flag.unsafePatterns.length > 0) {
      // 用 unsafePatterns 模式：值匹配任一 pattern 即为不安全
      if (matchesUnsafePattern(value, flag.unsafePatterns)) {
        isUnsafe = true;
      }
    } else {
      // 既无 safeValues 也无 unsafePatterns，按真值判断（真值 → 不安全）
      if (isTruthy(value)) {
        isUnsafe = true;
      }
    }

    if (isUnsafe) {
      findings.push({
        key: flag.key,
        severity: flag.severity,
        description: flag.description,
        actualValue: value,
        safeValues: flag.safeValues,
      });
    }
  }

  return findings;
}

/**
 * 获取指定键的危险标记。
 *
 * 在 DANGEROUS_CONFIG_FLAGS 与自定义标记中查找。
 *
 * @param key 配置键（如 "security.allowEval"）
 * @returns 标记定义；不存在时返回 null
 */
export function getDangerousFlag(key: string): DangerousConfigFlag | null {
  const allFlags = [...DANGEROUS_CONFIG_FLAGS, ...customFlags];
  return allFlags.find((f) => f.key === key) ?? null;
}

/**
 * 添加自定义危险配置标记。
 *
 * 允许插件或运行时扩展检测项，重复 key 会覆盖旧值。
 *
 * @param flag 危险配置标记定义
 */
export function registerDangerousFlag(flag: DangerousConfigFlag): void {
  // 删除同 key 旧标记
  const idx = customFlags.findIndex((f) => f.key === flag.key);
  if (idx >= 0) {
    customFlags.splice(idx, 1);
  }
  customFlags.push(flag);
}

/**
 * 清空所有自定义危险配置标记（仅供测试使用）。
 */
export function clearCustomDangerousFlags(): void {
  customFlags.length = 0;
}
