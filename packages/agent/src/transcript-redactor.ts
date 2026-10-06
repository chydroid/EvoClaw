/**
 * Transcript Redactor — 会话持久化脱敏。
 *
 * 背景（真实事故）：
 *   用户在同一天多次发送「添加邮箱 chydroid@163.com，授权码：DCq4QHXN46bMPCc9」。
 *   最终 `data/sessions/**\/*.jsonl` 与 `transcript.jsonl` 里，该授权码以**明文**存在：
 *     - assistant 回复正文中直接复述；
 *     - `tool_calls[].function.arguments` 中作为 `password` 字段值。
 *   而此前的 `redactSensitiveText` 只作用于 LLM 的**最终回复输出**，
 *   持久化链路（session-persistence / session-manager）完全没有脱敏，
 *   导致凭据长期明文落盘（还会被 compaction、记忆归档二次复制）。
 *
 * 设计要点：
 *   1. **保持 JSON 结构合法**：`tool_calls[].function.arguments` 是序列化后的 JSON 字符串，
 *      若直接用正则替换会破坏 `":"` 与引号，产生无法 JSON.parse 的坏行。
 *      因此这里走「解析 → 按 key 精确打码 → 重新序列化」的路径。
 *   2. **按 key 判定而非猜值**：`password` / `token` / `secret` / `授权码` 等键名一旦命中，
 *      其字符串值整体替换为 `[REDACTED]`，不做前缀保留（凭据不应保留任何片段）。
 *   3. 自然语言类字段（content）走通用 `redactSensitiveText`，覆盖「授权码 XXXX」这类散文写法。
 *   4. 纯函数、无 I/O，便于单测。
 */

import { redactSensitiveText } from "@evoclaw/security";

/** 敏感参数名（键名命中即整体打码，不保留任何片段） */
const SENSITIVE_KEY_RE =
  /(pass(word|wd)?|secret|token|api[_-]?key|apikey|auth(orization)?|credential|private[_-]?key|access[_-]?key|授权码|密码|密钥|口令)/i;

/** 打码占位符 */
export const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * 递归脱敏任意值：
 * - 字符串：走通用脱敏（覆盖散文中的凭据）
 * - 对象：键名命中敏感词则整体打码，否则递归
 * - 其它：原样返回
 */
export function redactValueDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value).redacted;
  if (Array.isArray(value)) return value.map(redactValueDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k) && typeof v === "string" && v.length > 0) {
        out[k] = REDACTED_PLACEHOLDER;
      } else {
        out[k] = redactValueDeep(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * 脱敏工具调用数组中的 arguments（JSON 字符串 → 解析 → 打码 → 重新序列化）。
 * 解析失败时退化为纯文本脱敏，绝不抛异常。
 */
export function redactToolCalls(toolCalls: unknown): unknown {
  if (!Array.isArray(toolCalls)) return toolCalls;
  return toolCalls.map((tc) => {
    if (!tc || typeof tc !== "object") return tc;
    const entry = tc as Record<string, unknown>;
    const fn = entry.function;
    if (!fn || typeof fn !== "object") return entry;
    const fnObj = fn as Record<string, unknown>;
    let args = fnObj.arguments;
    if (typeof args === "string") {
      const original = args;
      try {
        args = JSON.stringify(redactValueDeep(JSON.parse(original)));
      } catch {
        // 非 JSON（或已损坏）：退化为文本脱敏，仍保证是字符串
        args = redactSensitiveText(original).redacted;
      }
    } else {
      args = redactValueDeep(args);
    }
    return { ...entry, function: { ...fnObj, arguments: args } };
  });
}

/**
 * 脱敏一段自然语言内容（用于 role=assistant/user/tool 的 content）。
 */
export function redactContent(content: string | null | undefined): string | null | undefined {
  if (typeof content !== "string") return content;
  return redactSensitiveText(content).redacted;
}

/**
 * 脱敏持久化用的 metadata（含 tool_calls / tool_call_id / name / round 等）。
 */
export function redactMetadata(
  metadata: Record<string, unknown> | undefined | object,
): Record<string, unknown> | undefined {
  if (!metadata) return metadata as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata as Record<string, unknown>)) {
    out[k] = k === "tool_calls" ? redactToolCalls(v) : redactValueDeep(v);
  }
  return out;
}

/**
 * 脱敏 SessionManager 的 SessionTurn。
 *
 * 与 `redactMetadata` 的区别：SessionTurn 的 `toolCalls[].arguments` 是**对象**
 * （不是 JSON 字符串），且 `toolResult` 可能是任意结构，需要一并递归处理。
 */
export function redactSessionTurn<T extends {
  content?: string | null;
  toolCalls?: Array<{ id?: string; name?: string; arguments?: Record<string, unknown> }>;
  toolResult?: unknown;
  metadata?: Record<string, unknown>;
}>(turn: T): T {
  if (!turn || typeof turn !== "object") return turn;
  const out: T = { ...turn };
  if (typeof out.content === "string") {
    out.content = redactSensitiveText(out.content).redacted;
  }
  if (Array.isArray(out.toolCalls)) {
    out.toolCalls = out.toolCalls.map((tc) =>
      tc && typeof tc === "object" ? { ...tc, arguments: redactValueDeep(tc.arguments) as Record<string, unknown> } : tc,
    );
  }
  if (out.toolResult !== undefined) {
    out.toolResult = redactValueDeep(out.toolResult);
  }
  if (out.metadata) {
    out.metadata = redactMetadata(out.metadata);
  }
  return out;
}
