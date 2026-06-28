/**
 * cron 协议合规性校验。
 *
 * 灵感来自 openclaw-main 的 cron 校验流程。
 * 校验 cron 任务定义是否符合协议规范：
 *  1. cron 表达式语法正确（5 段或 6 段格式）
 *  2. 时区字段合法（IANA 时区名）
 *  3. 任务 ID 唯一
 *  4. 任务名长度合法（1-100 字符）
 *  5. 任务超时配置合理（不超过 24h）
 *  6. 重试次数配置合理（不超过 10 次）
 *  7. 不允许重复的 cron 表达式 + 时区组合（同一时刻触发冲突，warning）
 *
 * 设计原则：
 *  - 纯函数，无副作用
 *  - 不依赖 cron 解析器（仅做语法/范围/字符校验）
 *  - 多个 findings 一起返回，调用方决定如何呈现
 */

/** 待校验的 cron 任务规范。 */
export interface CronJobSpec {
  /** 任务 ID。 */
  id: string;
  /** 任务名。 */
  name: string;
  /** cron 表达式。 */
  cron: string;
  /** IANA 时区（如 "Asia/Shanghai"）。可选，默认无时区校验。 */
  timezone?: string;
  /** 任务超时（毫秒）。可选。 */
  timeoutMs?: number;
  /** 最大重试次数。可选。 */
  maxRetries?: number;
  /** 是否启用。 */
  enabled: boolean;
  /** 自定义负载。可选。 */
  payload?: Record<string, unknown>;
}

/** 单条校验发现。 */
export interface ConformanceFinding {
  /** 严重级别：error 必须修复；warning 建议修复；info 仅供参考。 */
  severity: "info" | "warning" | "error";
  /** 触发的规则名（用于程序化处理）。 */
  rule: string;
  /** 关联的 job ID（可为空表示全局规则）。 */
  jobId: string;
  /** 人类可读的描述。 */
  message: string;
  /** 修复建议（可选）。 */
  suggestion?: string;
}

// ── 常量 ────────────────────────────────────────────────────────

/** 任务名最大长度。 */
export const MAX_NAME_LENGTH = 100;
/** 任务超时上限（24h）。 */
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** 最大重试次数。 */
export const MAX_RETRIES = 10;
/** 合法的 cron 字段数。 */
export const VALID_CRON_FIELDS_5 = 5;
export const VALID_CRON_FIELDS_6 = 6;

/** IANA 时区粗略格式：大陆/城市（可多段，如 America/Argentina/Buenos_Aires）。 */
const IANA_TZ_PATTERN = /^[A-Za-z_]+(?:\/[A-Za-z_]+)+$/;

/** cron 字段允许的字符：数字、*、-、/、,、?、L、W、# 以及字母（用于 jan-dec/sun-sat）。 */
const CRON_FIELD_TOKEN = /^[0-9A-Za-z*,/\-?LW#]+$/;

/** 各 cron 字段的取值范围。 */
const CRON_FIELD_RANGES: Array<{ name: string; min: number; max: number; allowNames?: string[] }> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, allowNames: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] },
  { name: "dayOfWeek", min: 0, max: 7, allowNames: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
];

/** 月份名称集合。 */
const MONTH_NAMES = new Set(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]);
/** 星期名称集合。 */
const DOW_NAMES = new Set(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);

// ── 校验主入口 ───────────────────────────────────────────────────

/**
 * 校验一组 cron 任务规范的协议合规性。
 * 返回所有 findings（按 severity 降序：error > warning > info）。
 */
export function validateCronProtocol(jobs: CronJobSpec[]): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  const seenIds = new Map<string, number>();   // id → 出现次数
  const seenCronTz = new Map<string, string[]>();  // "cron||tz" → jobId[]

  // 第一遍：检测重复 ID
  for (const job of jobs) {
    const count = seenIds.get(job.id) ?? 0;
    seenIds.set(job.id, count + 1);
  }
  for (const [id, count] of seenIds) {
    if (count > 1) {
      findings.push({
        severity: "error",
        rule: "duplicate-id",
        jobId: id,
        message: `Job ID "${id}" appears ${count} times; IDs must be unique`,
        suggestion: "Rename duplicate jobs to use unique IDs",
      });
    }
  }

  // 第二遍：逐个 job 校验
  for (const job of jobs) {
    // ID 非空
    if (!job.id || job.id.trim().length === 0) {
      findings.push({
        severity: "error",
        rule: "empty-id",
        jobId: job.id || "<empty>",
        message: "Job ID must be non-empty",
        suggestion: "Provide a unique non-empty ID for each job",
      });
    }

    // name 长度 1-100
    if (!job.name || job.name.length === 0) {
      findings.push({
        severity: "error",
        rule: "empty-name",
        jobId: job.id,
        message: "Job name must be non-empty",
        suggestion: "Provide a descriptive name (1-100 characters)",
      });
    } else if (job.name.length > MAX_NAME_LENGTH) {
      findings.push({
        severity: "error",
        rule: "name-too-long",
        jobId: job.id,
        message: `Job name length ${job.name.length} exceeds max ${MAX_NAME_LENGTH}`,
        suggestion: `Shorten the name to <= ${MAX_NAME_LENGTH} characters`,
      });
    }

    // cron 表达式
    const cronCheck = checkCronExpression(job.cron);
    if (!cronCheck.valid) {
      findings.push({
        severity: "error",
        rule: "invalid-cron-expr",
        jobId: job.id,
        message: `Invalid cron expression "${job.cron}": ${cronCheck.reason}`,
        suggestion: "Use 5 or 6 field cron syntax (minute hour day month dow [second])",
      });
    }

    // 时区
    if (job.timezone !== undefined) {
      if (!IANA_TZ_PATTERN.test(job.timezone)) {
        findings.push({
          severity: "error",
          rule: "invalid-timezone",
          jobId: job.id,
          message: `Timezone "${job.timezone}" is not a valid IANA timezone (expected "Area/Location" format)`,
          suggestion: 'Use IANA timezone like "Asia/Shanghai" or "America/New_York"',
        });
      } else if (!isValidIanaTimezone(job.timezone)) {
        findings.push({
          severity: "warning",
          rule: "unknown-timezone",
          jobId: job.id,
          message: `Timezone "${job.timezone}" matches IANA format but is not a known timezone`,
          suggestion: "Verify the timezone name against the IANA timezone database",
        });
      }
    }

    // 超时
    if (job.timeoutMs !== undefined) {
      if (typeof job.timeoutMs !== "number" || !Number.isFinite(job.timeoutMs) || job.timeoutMs < 0) {
        findings.push({
          severity: "error",
          rule: "invalid-timeout",
          jobId: job.id,
          message: `timeoutMs must be a non-negative finite number, got: ${String(job.timeoutMs)}`,
          suggestion: "Use a positive number of milliseconds or omit the field",
        });
      } else if (job.timeoutMs > MAX_TIMEOUT_MS) {
        findings.push({
          severity: "error",
          rule: "timeout-too-large",
          jobId: job.id,
          message: `timeoutMs ${job.timeoutMs} exceeds max ${MAX_TIMEOUT_MS} (24h)`,
          suggestion: "Reduce timeout to <= 24h or split the job into smaller pieces",
        });
      }
    }

    // 重试次数
    if (job.maxRetries !== undefined) {
      if (typeof job.maxRetries !== "number" || !Number.isFinite(job.maxRetries) || job.maxRetries < 0) {
        findings.push({
          severity: "error",
          rule: "invalid-retries",
          jobId: job.id,
          message: `maxRetries must be a non-negative integer, got: ${String(job.maxRetries)}`,
          suggestion: "Use 0-10 retries",
        });
      } else if (job.maxRetries > MAX_RETRIES) {
        findings.push({
          severity: "error",
          rule: "retries-too-large",
          jobId: job.id,
          message: `maxRetries ${job.maxRetries} exceeds max ${MAX_RETRIES}`,
          suggestion: `Reduce retries to <= ${MAX_RETRIES}`,
        });
      }
    }

    // 收集 cron+tz 组合用于冲突检测
    if (cronCheck.valid) {
      const key = `${job.cron}||${job.timezone ?? ""}`;
      const existing = seenCronTz.get(key);
      if (existing) {
        existing.push(job.id);
      } else {
        seenCronTz.set(key, [job.id]);
      }
    }
  }

  // 第三遍：检测重复 cron+tz 组合（warning）
  for (const [, ids] of seenCronTz) {
    if (ids.length > 1) {
      findings.push({
        severity: "warning",
        rule: "duplicate-cron-tz",
        jobId: ids[0],
        message: `Multiple jobs (${ids.length}) share the same cron expression and timezone: ${ids.join(", ")}`,
        suggestion: "Merge these jobs or stagger them to avoid simultaneous firing",
      });
    }
  }

  // 按 severity 降序排序
  const severityRank = { error: 0, warning: 1, info: 2 };
  return findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
}

// ── 表达式校验 ──────────────────────────────────────────────────

/**
 * 检查 cron 表达式段数与字段字符。
 * 仅做语法/范围校验，不解析语义（不计算下次触发时间）。
 */
export function checkCronExpression(expr: string): { valid: boolean; reason: string } {
  if (typeof expr !== "string") {
    return { valid: false, reason: "expression must be a string" };
  }
  const trimmed = expr.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: "expression is empty" };
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== VALID_CRON_FIELDS_5 && fields.length !== VALID_CRON_FIELDS_6) {
    return {
      valid: false,
      reason: `expected ${VALID_CRON_FIELDS_5} or ${VALID_CRON_FIELDS_6} fields, got ${fields.length}`,
    };
  }

  // 6 段时第 1 段为秒
  const hasSecond = fields.length === VALID_CRON_FIELDS_6;
  const offset = hasSecond ? 1 : 0;

  // 校验秒字段（如有）
  if (hasSecond) {
    const secondCheck = checkField(fields[0], "second", 0, 59);
    if (!secondCheck.valid) return secondCheck;
  }

  // 校验其余 5 个标准字段
  for (let i = 0; i < CRON_FIELD_RANGES.length; i++) {
    const fieldSpec = CRON_FIELD_RANGES[i];
    const value = fields[i + offset];
    const check = checkField(value, fieldSpec.name, fieldSpec.min, fieldSpec.max, fieldSpec.allowNames);
    if (!check.valid) return check;
  }

  return { valid: true, reason: "" };
}

/**
 * 校验单个字段：字符集 + 每段取值范围。
 */
function checkField(
  value: string,
  fieldName: string,
  min: number,
  max: number,
  allowNames?: string[],
): { valid: boolean; reason: string } {
  if (!CRON_FIELD_TOKEN.test(value)) {
    return { valid: false, reason: `field "${fieldName}" contains illegal characters: "${value}"` };
  }

  // 按 , 分割
  const segments = value.split(",");
  for (const seg of segments) {
    const segCheck = checkSegment(seg, fieldName, min, max, allowNames);
    if (!segCheck.valid) return segCheck;
  }

  return { valid: true, reason: "" };
}

/** 校验单个 , 分隔段：可能是单值、范围、step、列表。 */
function checkSegment(
  seg: string,
  fieldName: string,
  min: number,
  max: number,
  allowNames?: string[],
): { valid: boolean; reason: string } {
  // 处理 step：A/B
  let rangePart = seg;
  let stepPart: string | undefined;
  const slashIdx = seg.indexOf("/");
  if (slashIdx >= 0) {
    rangePart = seg.slice(0, slashIdx);
    stepPart = seg.slice(slashIdx + 1);
    if (stepPart.length === 0) {
      return { valid: false, reason: `field "${fieldName}" has empty step after "/" in "${seg}"` };
    }
    if (!/^\d+$/.test(stepPart)) {
      return { valid: false, reason: `field "${fieldName}" step "${stepPart}" must be a number` };
    }
    const stepNum = parseInt(stepPart, 10);
    if (stepNum <= 0) {
      return { valid: false, reason: `field "${fieldName}" step must be >= 1, got ${stepNum}` };
    }
  }

  if (rangePart === "*" || rangePart === "?") {
    return { valid: true, reason: "" };
  }

  // 处理范围：A-B
  const dashIdx = rangePart.indexOf("-");
  if (dashIdx >= 0) {
    const loStr = rangePart.slice(0, dashIdx);
    const hiStr = rangePart.slice(dashIdx + 1);
    const lo = parseValue(loStr, allowNames);
    const hi = parseValue(hiStr, allowNames);
    if (lo === null || hi === null) {
      return { valid: false, reason: `field "${fieldName}" range "${rangePart}" has non-numeric value` };
    }
    // dayOfWeek 的 7 等价于 0（周日），允许 7
    const effMax = fieldName === "dayOfWeek" ? 7 : max;
    if (lo < min || lo > effMax || hi < min || hi > effMax) {
      return { valid: false, reason: `field "${fieldName}" range ${lo}-${hi} out of bounds [${min},${effMax}]` };
    }
    if (lo > hi) {
      return { valid: false, reason: `field "${fieldName}" range ${lo}-${hi} has lo > hi` };
    }
    return { valid: true, reason: "" };
  }

  // 单值
  const num = parseValue(rangePart, allowNames);
  if (num === null) {
    return { valid: false, reason: `field "${fieldName}" value "${rangePart}" is not a valid number` };
  }
  const effMax = fieldName === "dayOfWeek" ? 7 : max;
  if (num < min || num > effMax) {
    return { valid: false, reason: `field "${fieldName}" value ${num} out of bounds [${min},${effMax}]` };
  }

  return { valid: true, reason: "" };
}

/** 解析单值：数字或月份/星期名称。 */
function parseValue(s: string, allowNames?: string[]): number | null {
  if (/^\d+$/.test(s)) {
    return parseInt(s, 10);
  }
  if (allowNames) {
    const lower = s.toLowerCase();
    if (allowNames.includes(lower)) {
      // 名称映射到 1-12 或 0-6
      if (MONTH_NAMES.has(lower)) {
        return MONTH_NAMES_LIST.indexOf(lower) + 1;
      }
      if (DOW_NAMES.has(lower)) {
        return DOW_NAMES_LIST.indexOf(lower);
      }
    }
  }
  return null;
}

const MONTH_NAMES_LIST = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW_NAMES_LIST = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * 校验 IANA 时区是否合法（仅做格式与已知时区集合校验）。
 * 不引入 Intl 时区库依赖，使用 ECMAScript 内置 Intl.DateTimeFormat。
 */
export function isValidIanaTimezone(tz: string): boolean {
  if (!IANA_TZ_PATTERN.test(tz)) return false;
  try {
    // Intl.DateTimeFormat 在传入不支持的时区时会抛 RangeError
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * 预估下一次触发时间（不依赖 cron 解析器，用简单算法）。
 * 此函数仅用于协议校验时的辅助提示，不需要精确。
 */
export function nextRunHint(expr: string, from: Date = new Date()): string {
  const check = checkCronExpression(expr);
  if (!check.valid) {
    return `invalid expression: ${check.reason}`;
  }
  // 简化实现：返回 expr 本身 + 提示
  return `${expr} (use a cron parser for exact next-run time; reference point: ${from.toISOString()})`;
}

/**
 * 工具函数：判断给定的 findings 中是否存在 error 级别的项。
 */
export function hasErrors(findings: ConformanceFinding[]): boolean {
  return findings.some((f) => f.severity === "error");
}

/**
 * 工具函数：按 rule 名筛选 findings。
 */
export function findingsByRule(findings: ConformanceFinding[], rule: string): ConformanceFinding[] {
  return findings.filter((f) => f.rule === rule);
}
