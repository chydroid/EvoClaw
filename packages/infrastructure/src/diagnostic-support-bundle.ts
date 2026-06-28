/**
 * 诊断支持包：将诊断数据脱敏后导出为可分享的 JSON。
 *
 * 灵感来自 openclaw-main 的 src/logging/diagnostic-support-bundle.ts +
 * diagnostic-support-redaction.ts。
 *
 * 用于 bug 报告与远程诊断：导出后可安全地通过邮件/工单发送，不会泄露密钥/PII。
 *
 * 脱敏策略：
 * - DiagnosticPayload：通过 DiagnosticPayloadBuilder.redact 处理 data 字段
 * - configSnapshot：递归脱敏敏感 key
 * - logExcerpt：使用 redactString 移除常见密钥模式（JWT、Bearer token 等）
 */

import { v4 as uuidv4 } from "uuid";
import type { DiagnosticPhase } from "./diagnostic-phase";
import {
  DiagnosticPayloadBuilder,
  DEFAULT_SENSITIVE_KEYS,
  type DiagnosticPayload,
} from "./diagnostic-payload";
import type { StabilityAssessment } from "./diagnostic-stability";

/** 输入：阶段集合（支持 Map 与数组两种形式）。 */
export type PhaseInput =
  | Map<string, DiagnosticPhase[]>
  | Array<{ entityId: string; phases: DiagnosticPhase[] }>;

/** 输入：支持包构建入参。 */
export interface SupportBundleInput {
  /** 自定义 bundle ID（默认随机生成） */
  bundleId?: string;
  createdAt?: Date;
  /** 用户提供的描述 */
  description?: string;

  // ── 来源数据 ──
  phases?: PhaseInput;
  payloads?: DiagnosticPayload[];
  stabilityAssessments?: StabilityAssessment[];

  // ── 系统信息（可选） ──
  systemInfo?: {
    platform?: string;
    nodeVersion?: string;
    arch?: string;
    hostname?: string;
    uptime?: number;
    memoryUsage?: NodeJS.MemoryUsage;
  };

  // ── 配置信息（可选，会自动脱敏） ──
  configSnapshot?: Record<string, unknown>;

  // ── 日志片段（可选，会自动脱敏） ──
  logExcerpt?: string[];
}

/** 输出：脱敏后的支持包。 */
export interface SupportBundle {
  bundleId: string;
  createdAt: Date;
  description?: string;

  // 脱敏后的数据
  phases: Array<{ entityId: string; phases: DiagnosticPhase[] }>;
  payloads: DiagnosticPayload[];
  stabilityAssessments: StabilityAssessment[];

  systemInfo?: SupportBundleInput["systemInfo"];
  /** 已脱敏 */
  configSnapshot?: Record<string, unknown>;
  /** 已脱敏 */
  logExcerpt?: string[];

  // ── 元数据 ──
  redactionSummary: {
    totalFieldsRedacted: number;
    redactedFieldNames: string[];
  };
  generator: {
    name: string;
    version: string;
  };
}

/** 导出选项。 */
export interface SupportBundleExportOptions {
  prettyPrint?: boolean;
  includeStabilityAssessments?: boolean;
  includeConfigSnapshot?: boolean;
  includeLogExcerpt?: boolean;
  /** 额外敏感 key（与 DEFAULT_SENSITIVE_KEYS 合并） */
  additionalSensitiveKeys?: string[];
  /** logExcerpt 截断条数（默认 100） */
  maxLogEntries?: number;
}

/** 生成器信息（从 process.env 读取，避免硬编码版本）。 */
const GENERATOR_NAME = "@evoclaw/infrastructure/diagnostic-support-bundle";

function readGeneratorVersion(): string {
  // 不直接 import package.json 以避免引入对构建时相对路径的依赖
  // 从 process.env 或默认值
  return process.env.EVOCLAW_BUNDLE_GENERATOR_VERSION ?? "0.1.0";
}

/**
 * 支持包构建器（静态方法）。
 */
export class SupportBundleBuilder {
  /** 构建脱敏后的支持包。 */
  static build(
    input: SupportBundleInput,
    opts: SupportBundleExportOptions = {},
  ): SupportBundle {
    const sensitiveKeys: string[] = [
      ...DEFAULT_SENSITIVE_KEYS,
      ...(opts.additionalSensitiveKeys ?? []),
    ];
    const redactedFieldNames = new Set<string>();
    let totalFieldsRedacted = 0;

    // 1. phases：直接拷贝（不含敏感字段，仅含 kind/startedAt/durationMs 等）
    const phases = normalizePhases(input.phases);

    // 2. payloads：脱敏
    const payloads = (input.payloads ?? []).map((p) => {
      const r = DiagnosticPayloadBuilder.redact(p, sensitiveKeys);
      if (r.redacted && r.redactedFields) {
        for (const f of r.redactedFields) redactedFieldNames.add(f);
        totalFieldsRedacted += r.redactedFields.length;
      }
      return r;
    });

    // 3. stabilityAssessments：仅含诊断证据，无敏感字段，直接拷贝
    const stabilityAssessments = opts.includeStabilityAssessments === false
      ? []
      : (input.stabilityAssessments ?? []).map((a) => ({
          ...a,
          evidence: a.evidence ? { ...a.evidence } : {},
        }));

    // 4. configSnapshot：递归脱敏
    let configSnapshot: Record<string, unknown> | undefined;
    if (opts.includeConfigSnapshot !== false && input.configSnapshot) {
      const redactedConfig = redactConfigRecord(
        input.configSnapshot,
        sensitiveKeys,
        "",
        redactedFieldNames,
      );
      // 统计脱敏字段数（从 set 推断）
      configSnapshot = redactedConfig as Record<string, unknown>;
    }

    // 5. logExcerpt：使用正则脱敏常见密钥模式
    let logExcerpt: string[] | undefined;
    if (opts.includeLogExcerpt !== false && input.logExcerpt) {
      const limit = opts.maxLogEntries ?? 100;
      logExcerpt = input.logExcerpt.slice(0, limit).map((line) => {
        const redacted = redactString(line);
        if (redacted !== line) {
          totalFieldsRedacted += 1;
          redactedFieldNames.add("logExcerpt[line]");
        }
        return redacted;
      });
    }

    return {
      bundleId: input.bundleId ?? uuidv4(),
      createdAt: input.createdAt ?? new Date(),
      description: input.description,
      phases,
      payloads,
      stabilityAssessments,
      systemInfo: input.systemInfo,
      configSnapshot,
      logExcerpt,
      redactionSummary: {
        totalFieldsRedacted,
        redactedFieldNames: Array.from(redactedFieldNames).sort(),
      },
      generator: {
        name: GENERATOR_NAME,
        version: readGeneratorVersion(),
      },
    };
  }

  /** 序列化为 JSON 字符串。 */
  static toJSON(bundle: SupportBundle, prettyPrint?: boolean): string {
    return JSON.stringify(
      bundle,
      prettyPrint ? null : undefined,
      prettyPrint ? 2 : 0,
    );
  }

  /** 估算 bundle 大小（字节，UTF-8）。 */
  static estimateSize(bundle: SupportBundle): number {
    return Buffer.byteLength(SupportBundleBuilder.toJSON(bundle), "utf8");
  }

  /** 检查 bundle 是否在大小限制内。 */
  static isWithinSizeLimit(bundle: SupportBundle, maxBytes: number): boolean {
    return SupportBundleBuilder.estimateSize(bundle) <= maxBytes;
  }
}

/** 将 PhaseInput 统一为数组形式。 */
function normalizePhases(
  input: PhaseInput | undefined,
): Array<{ entityId: string; phases: DiagnosticPhase[] }> {
  if (!input) return [];
  if (input instanceof Map) {
    return Array.from(input.entries()).map(([entityId, phases]) => ({
      entityId,
      phases: phases.map((p) => ({ ...p })),
    }));
  }
  return input.map((entry) => ({
    entityId: entry.entityId,
    phases: entry.phases.map((p) => ({ ...p })),
  }));
}

/** 递归脱敏 config record。 */
function redactConfigRecord(
  value: unknown,
  sensitiveKeys: string[],
  pathPrefix: string,
  redactedFields: Set<string>,
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) =>
      redactConfigRecord(
        item,
        sensitiveKeys,
        `${pathPrefix}[${i}]`,
        redactedFields,
      ),
    );
  }
  const lowerSet = new Set(sensitiveKeys.map((k) => k.toLowerCase()));
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    const fieldPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (lowerSet.has(key.toLowerCase())) {
      out[key] = "***REDACTED***";
      redactedFields.add(fieldPath);
    } else if (val !== null && typeof val === "object") {
      out[key] = redactConfigRecord(val, sensitiveKeys, fieldPath, redactedFields);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/** 日志行脱敏：移除常见密钥模式。 */
const LOG_REDACT_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Basic Auth
  { pattern: /\bBasic\s+[A-Za-z0-9+/]+={0,2}/g, replacement: "Basic <redacted>" },
  // Cookie 头
  { pattern: /\b(Cookie|Set-Cookie)\s*:\s*[^\r\n]+/g, replacement: "$1: <redacted>" },
  // AWS access key ID
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replacement: "<redacted-aws-key>" },
  // JWT
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "<redacted-jwt>" },
  // Bearer token
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, replacement: "Bearer <redacted>" },
  // JSON 字段："apiKey": "value"
  {
    pattern: /("(?:apiKey|api_key|apikey|token|accessToken|access_token|refreshToken|refresh_token|secret|password|passwd|credential|credentials|privateKey|private_key|clientSecret|client_secret|authorization|cookie)")\s*:\s*"([^"]+)"/gi,
    replacement: '$1: "<redacted>"',
  },
  // 数据库连接字符串密码
  {
    pattern: /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:]+:)([^@]+)(@)/gi,
    replacement: "$1<redacted>$3",
  },
];

/** 脱敏字符串中的常见密钥模式。 */
export function redactString(value: string): string {
  let result = value;
  for (const { pattern, replacement } of LOG_REDACT_PATTERNS) {
    // 重置 lastIndex 以防 stateful 正则
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}
