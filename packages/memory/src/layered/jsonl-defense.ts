/**
 * 四层 JSONL 防御 — 数据鲁棒性工具。
 *
 * 借鉴 TencentDB-Agent-Memory 的 `src/offload/storage.ts` 四层防御：
 *   1. sanitizeText — 源文本清理（控制字符、UNSAFE_CHAR_RE）
 *   2. sanitizeJsonLine — 写入时清理 + roundtrip 验证
 *   3. validateEntry — schema 验证（必填字段）
 *   4. parseJsonlSafe — 容忍解析 + 损坏统计
 *
 * 解决问题：JSONL 文件在崩溃 / 编码异常 / 恶意输入下容易产生损坏行，
 * 传统 `JSON.parse(line)` 会 throw 导致整文件无法加载。
 */

/** 不安全字符正则：控制字符（除了 \t \n \r）+ BOM + 零宽字符。 */
const UNSAFE_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFEFF\u200B-\u200D\u2060]/g;

/** 第 1 层：清理源文本。 */
export function sanitizeText(text: string): string {
  if (typeof text !== "string") return "";
  return text
    .replace(UNSAFE_CHAR_RE, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

/** 第 2 层：清理 JSON 行 + roundtrip 验证。 */
export function sanitizeJsonLine(line: string): string {
  if (typeof line !== "string") return "";
  // 移除控制字符（保留 JSON 结构字符）
  const cleaned = line.replace(UNSAFE_CHAR_RE, "");
  // roundtrip 验证：parse + stringify 保证可解析
  try {
    const obj = JSON.parse(cleaned);
    return JSON.stringify(obj);
  } catch {
    // 无法解析的行返回空字符串（调用方应跳过）
    return "";
  }
}

/** 第 3 层：schema 验证结果。 */
export interface ValidationResult<T> {
  valid: boolean;
  entry?: T;
  error?: string;
}

/**
 * 第 3 层：验证 entry 是否符合 schema（必填字段检查）。
 * @param entry 待验证对象
 * @param requiredFields 必填字段列表
 */
export function validateEntry<T = Record<string, unknown>>(
  entry: unknown,
  requiredFields: string[] = []
): ValidationResult<T> {
  if (!entry || typeof entry !== "object") {
    return { valid: false, error: "entry is not an object" };
  }
  const obj = entry as Record<string, unknown>;
  for (const field of requiredFields) {
    if (!(field in obj) || obj[field] === undefined || obj[field] === null) {
      return { valid: false, error: `missing required field: ${field}` };
    }
  }
  return { valid: true, entry: obj as T };
}

/** 第 4 层：解析结果。 */
export interface ParseResult<T> {
  entries: T[];
  totalLines: number;
  validLines: number;
  corruptLines: number;
  corruptLineNumbers: number[];
}

/**
 * 第 4 层：容忍式 JSONL 解析。
 *
 * 逐行解析，损坏行跳过并记录行号，不抛异常。
 * 适用于从磁盘加载 JSONL 文件时防御各种损坏。
 */
export function parseJsonlSafe<T = unknown>(
  text: string,
  options?: {
    requiredFields?: string[];
    skipEmpty?: boolean;
  }
): ParseResult<T> {
  const requiredFields = options?.requiredFields ?? [];
  const skipEmpty = options?.skipEmpty ?? true;
  const entries: T[] = [];
  const corruptLineNumbers: number[] = [];
  let totalLines = 0;
  let validLines = 0;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || (skipEmpty && raw.trim() === "")) continue;
    totalLines++;

    // 先用 sanitizeJsonLine 清理 + 验证可解析
    const cleaned = sanitizeJsonLine(raw);
    if (!cleaned) {
      corruptLineNumbers.push(i + 1);
      continue;
    }

    try {
      const obj = JSON.parse(cleaned);
      // schema 验证
      const vr = validateEntry<T>(obj, requiredFields);
      if (!vr.valid || !vr.entry) {
        corruptLineNumbers.push(i + 1);
        continue;
      }
      entries.push(vr.entry);
      validLines++;
    } catch {
      corruptLineNumbers.push(i + 1);
    }
  }

  return {
    entries,
    totalLines,
    validLines,
    corruptLines: corruptLineNumbers.length,
    corruptLineNumbers,
  };
}

/**
 * 把 entry 序列化为安全的 JSONL 行（含末尾换行）。
 *
 * 写入前调用此函数，保证写入的行可被 parseJsonlSafe 解析回来。
 */
export function serializeJsonlLine(entry: unknown): string {
  try {
    const json = JSON.stringify(entry);
    if (!json) return "";
    // roundtrip 验证
    JSON.parse(json);
    // 清理控制字符（保留 JSON 结构）
    return json.replace(UNSAFE_CHAR_RE, "") + "\n";
  } catch {
    return "";
  }
}
