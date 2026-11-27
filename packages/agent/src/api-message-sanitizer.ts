/**
 * api-message-sanitizer — 出站消息净化（每次 LLM 调用前无条件执行）
 *
 * 对标 hermes `sanitize_api_messages`（agent/agent_runtime_helpers.py:2659）：
 * 严格 OpenAI 兼容网关（DeepSeek v4 / Kimi / 各类代理）对消息形态的校验远严于
 * 宽松实现——`content: null`、`tool_calls: []`、重复/孤立 tool_call_id、悬空
 * tool 结果、非法 function.name、畸形 arguments 任意一项都会让**整条会话**此后
 * 每次请求 400。历史一旦被污染（持久化里躺着一条坏消息），后续每轮都失败，
 * 会话等于废掉。
 *
 * 因此在**每次调用的消息副本**上做确定性修复：
 *   - 只改副本，不回写 history（前缀缓存字节稳定，见 AGENTS.md「Prompt cache is sacred」）
 *   - 无改动时返回原数组引用（`!==` 比较可判断是否发生修复）
 *   - 顺序与 hermes 一致：空非末条先被修复，好让替换后的消息参与配对/去重
 *
 * 与 hermes 的两处有意差异（均为本项目网关实测行为，非照抄）：
 *   1. **末条消息** content 为 `null`/缺省时也补占位符。hermes 只修非末条；本项目
 *      网关对 `user content null` 无论位置都返回 400（探针实测），而空串合法。
 *      只补 `null`/缺省、不碰空串/空数组，因此不会误伤设计上的空消息。
 *   2. `tool_calls[].function.arguments` 的归一化放在这里（hermes 在流式构造处做）。
 *      本项目历史消息可被回放/持久化，最后一个收口点就是这里；且探针实测
 *      arguments 为对象（非字符串）直接 400。
 */

/** 结构性消息类型（与 llm-caller 的 LLMMessage 兼容，避免循环依赖） */
export interface SanitizableMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
  [key: string]: unknown;
}

/** hermes `_VALID_API_ROLES` */
const VALID_API_ROLES = new Set(["system", "user", "assistant", "tool", "function", "developer"]);

/** hermes `_INTERRUPTED_PLACEHOLDER` */
export const INTERRUPTED_PLACEHOLDER = "[interrupt: no assistant output for this turn]";

/** hermes `_pair_tool_calls_positionally` 的补桩文案 */
export const UNAVAILABLE_RESULT_PLACEHOLDER = "[Result unavailable — see context summary above]";

/** hermes `_VALID_TOOL_NAME_RE` */
const VALID_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 把回放的工具名强制成 `^[A-Za-z0-9_-]{1,64}$`。
 * 合法名原样返回（identity —— 缓存安全）；非法字符折叠为 `_` 并截断 64；
 * 空/全非法 → `fallback`。确定性，同一个坏名字每次渲染同样字节。
 * 不可用于**实时**工具定义（schema 名必须与派发注册表一致）。
 */
export function coerceToolName(name: unknown, fallback = "invalid_tool_call"): string {
  if (typeof name !== "string") return fallback;
  if (VALID_TOOL_NAME_RE.test(name)) return name;
  const coerced = name
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return coerced.slice(0, 64) || fallback;
}

// ── arguments 修复（对标 hermes _repair_tool_call_arguments） ──

const JSON_CLOSERS: Record<string, string> = { "{": "}", "[": "]" };

function tryParse(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** 把 JSON 字符串字面量里的裸控制字符（0x00-0x1F）转成 \uXXXX。对合法 JSON 是无害的。 */
function escapeControlCharsInStrings(raw: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (inString && ch === "\\" && i + 1 < raw.length) {
      out += raw.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString && ch.charCodeAt(0) < 0x20) {
      out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
    i += 1;
  }
  return out;
}

/**
 * 按栈序补齐 JSON 前缀缺失的右括号，忽略字符串字面量内的分隔符
 * （`{"code": "}"}` 只有一个未闭合花括号）。错配的右括号会在它**之前**
 * 插入缺失的内层右括号：`{"a": [{"b": 1}}` → `{"a": [{"b": 1}]}`。
 * 文本以未闭合字符串结尾时返回 null（内容不可恢复，不得猜测）。
 */
export function rebalanceJsonClosers(raw: string): string | null {
  let out = "";
  const stack: string[] = [];
  let inString = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (inString) {
      if (ch === "\\") {
        out += raw.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if ((ch === "}" || ch === "]") && stack.some((o) => JSON_CLOSERS[o] === ch)) {
      while (JSON_CLOSERS[stack[stack.length - 1]!] !== ch) {
        out += JSON_CLOSERS[stack.pop()!]!;
      }
      stack.pop();
    }
    out += ch;
    i += 1;
  }
  if (inString) return null;
  for (let k = stack.length - 1; k >= 0; k -= 1) out += JSON_CLOSERS[stack[k]!]!;
  return out;
}

/**
 * 修复畸形的 tool_call arguments JSON（截断、尾逗号、Python `None`、控制字符）；
 * 不可修复时返回 `"{}"`，保证请求能发出去。
 * 非字符串输入（对象/数组）→ 重新序列化为 JSON 字符串（探针实测对象形态 400）。
 */
export function repairToolCallArguments(raw: unknown): string {
  // 非字符串：对象/数组重新序列化（保留数据），其余（null/undefined/number/bool）→ "{}"
  if (typeof raw !== "string") {
    if (raw !== null && typeof raw === "object") {
      try {
        return JSON.stringify(raw) || "{}";
      } catch {
        return "{}";
      }
    }
    return "{}";
  }

  const stripped = raw.trim();
  if (!stripped) return "{}";
  if (stripped === "None" || stripped === "null") return "{}";

  // Pass 0：先把字符串里的裸控制字符转义，再尝试严格解析。
  const escaped = escapeControlCharsInStrings(stripped);
  if (tryParse(escaped)) return escaped;

  // Pass 1-2：去尾逗号 + 补/裁括号（字符串感知，有界）
  let fixed = stripped.replace(/,\s*([}\]])/g, "$1");
  fixed = rebalanceJsonClosers(fixed) ?? fixed;
  for (let i = 0; i < 50; i += 1) {
    if (tryParse(fixed)) break;
    const excessCloser =
      (fixed.endsWith("}") && count(fixed, "}") > count(fixed, "{")) ||
      (fixed.endsWith("]") && count(fixed, "]") > count(fixed, "["));
    if (!excessCloser) break;
    fixed = fixed.slice(0, -1);
  }
  if (tryParse(fixed)) return fixed;

  // Pass 3：修复版再转义一次控制字符
  const escapedFixed = escapeControlCharsInStrings(fixed);
  if (escapedFixed !== fixed && tryParse(escapedFixed)) return escapedFixed;

  return "{}";
}

function count(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n += 1;
  return n;
}

// ── 各 pass ──

/** hermes `_content_has_payload`：内容是否含有 API 认可的实质载荷 */
function contentHasPayload(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return content !== null && content !== undefined && content !== "";
  return content.some((block) => {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text") return typeof b.text === "string" && b.text.trim().length > 0;
      return true;
    }
    return Boolean(block);
  });
}

/** hermes `_msg_has_payload`：内容/tool_calls/reasoning 任一非空即算有载荷 */
function messageHasPayload(msg: SanitizableMessage): boolean {
  if (contentHasPayload(msg.content)) return true;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
  const reasoning = msg.reasoning_content;
  if (typeof reasoning === "string" && reasoning.trim().length > 0) return true;
  return Boolean(msg.reasoning ?? msg.reasoning_details);
}

/** pass 1：丢弃 API 不接受的 role */
function dropInvalidRoles(messages: SanitizableMessage[]): SanitizableMessage[] {
  const kept = messages.filter((m) => VALID_API_ROLES.has(m.role));
  return kept.length === messages.length ? messages : kept;
}

/**
 * pass 2：非末条空内容消息补占位符（替换而非删除——保持 role 交替与 tool 配对）。
 * 末条只补 `null`/缺省 content 的 user/assistant（本项目网关对 null 一律 400，
 * 空串合法，见文件头差异说明）。
 */
function repairEmptyMessages(messages: SanitizableMessage[]): SanitizableMessage[] {
  if (messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  let changed = false;
  const repaired = messages.map((msg, idx) => {
    if (msg.role !== "assistant" && msg.role !== "user") return msg;
    if (messageHasPayload(msg)) return msg;
    if (idx !== lastIdx) {
      changed = true;
      return { ...msg, content: INTERRUPTED_PLACEHOLDER };
    }
    // 末条：只救 null/缺省（空串/空数组是合法的设计态，不动）
    if (msg.content === null || msg.content === undefined) {
      changed = true;
      return { ...msg, content: INTERRUPTED_PLACEHOLDER };
    }
    return msg;
  });
  return changed ? repaired : messages;
}

/** pass 3：assistant 上的空/非法 tool_calls 数组 → 删键（严格网关对 `[]` 直接 400） */
function dropEmptyToolCallsArrays(messages: SanitizableMessage[]): SanitizableMessage[] {
  let changed = false;
  const normalized = messages.map((msg) => {
    if (msg.role !== "assistant" || !("tool_calls" in msg)) return msg;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return msg;
    changed = true;
    const { tool_calls: _dropped, ...rest } = msg;
    return rest as SanitizableMessage;
  });
  return changed ? normalized : messages;
}

/** tool_calls 的元素结构（宽松读取） */
interface ToolCallShape {
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
  [key: string]: unknown;
}

function readToolCalls(msg: SanitizableMessage): ToolCallShape[] {
  return Array.isArray(msg.tool_calls) ? (msg.tool_calls as ToolCallShape[]) : [];
}

/** 取 tool_call 的 id（去空白，非字符串转字符串） */
function toolCallId(tc: ToolCallShape): string {
  const id = tc.id;
  if (typeof id === "string") return id.trim();
  if (typeof id === "number") return String(id);
  return "";
}

function toolCallName(tc: ToolCallShape): string {
  const name = tc.function?.name;
  return typeof name === "string" ? name : "";
}

/**
 * pass 4：把每个 `function.name` 强制成网关安全字符集；同时归一 `arguments` 为
 * 合法 JSON 字符串。copy-on-write——只替换发生变化的 tool_call 元素，未变化的
 * 消息对象保持引用不变（缓存字节稳定）。
 */
function repairToolCalls(messages: SanitizableMessage[]): SanitizableMessage[] {
  let changed = false;
  const repaired = messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const tcs = readToolCalls(msg);
    if (tcs.length === 0) return msg;
    let msgChanged = false;
    const nextTcs = tcs.map((tc) => {
      if (!tc || typeof tc !== "object") {
        msgChanged = true;
        return { id: "", type: "function", function: { name: "invalid_tool_call", arguments: "{}" } };
      }
      const name = toolCallName(tc);
      const coerced = coerceToolName(name);
      const rawArgs = tc.function?.arguments;
      const args = repairToolCallArguments(rawArgs);
      if (coerced === name && args === rawArgs) return tc;
      msgChanged = true;
      return {
        ...tc,
        type: typeof tc.type === "string" ? tc.type : "function",
        function: { ...(tc.function ?? {}), name: coerced, arguments: args },
      };
    });
    if (!msgChanged) return msg;
    changed = true;
    return { ...msg, tool_calls: nextTcs };
  });
  return changed ? repaired : messages;
}

/** pass 5：丢弃缺 id 的 tool 结果 */
function dropResultsWithoutIds(messages: SanitizableMessage[]): SanitizableMessage[] {
  const kept = messages.filter(
    (m) => !(m.role === "tool" && (typeof m.tool_call_id !== "string" || !m.tool_call_id.trim())),
  );
  return kept.length === messages.length ? messages : kept;
}

/**
 * pass 6：位置配对。严格网关（DeepSeek v4 / Kimi）要求带 tool_calls 的 assistant
 * 消息**紧随其后**就有覆盖每个 id 的 tool 结果。滚动遍历：
 *   (a) 不紧跟声明它的 assistant 的 tool 结果 → 丢弃（含出现在调用之前的）
 *   (b) 紧跟的 tool 段未覆盖的已声明 id → 在段末补桩
 * 新 assistant / user / 末尾都会 flush 未应答的声明。
 */
function pairToolCallsPositionally(messages: SanitizableMessage[]): SanitizableMessage[] {
  const paired: SanitizableMessage[] = [];
  const declared = new Map<string, ToolCallShape>();
  let dropped = 0;
  let stubs = 0;

  const flushUnanswered = (): void => {
    if (declared.size === 0) return;
    for (const key of [...declared.keys()].sort()) {
      const tc = declared.get(key)!;
      paired.push({
        role: "tool",
        name: toolCallName(tc) || undefined,
        content: UNAVAILABLE_RESULT_PLACEHOLDER,
        tool_call_id: key,
      });
      stubs += 1;
    }
    declared.clear();
  };

  for (const msg of messages) {
    if (msg.role === "assistant") {
      // 新 assistant 轮关闭上一段 tool 结果：仍未应答的一律补桩
      flushUnanswered();
      for (const tc of readToolCalls(msg)) {
        const id = toolCallId(tc);
        if (id) declared.set(id, tc);
      }
    } else if (msg.role === "tool") {
      const id = typeof msg.tool_call_id === "string" ? msg.tool_call_id.trim() : "";
      if (!id || !declared.has(id)) {
        dropped += 1;
        continue;
      }
      declared.delete(id);
    } else if (msg.role === "user") {
      flushUnanswered();
    }
    paired.push(msg);
  }
  flushUnanswered();

  if (dropped === 0 && stubs === 0) return messages;
  return paired;
}

/**
 * pass 7：去重 tool_call_id（严格网关对重复 id 直接 400）。
 * 跟踪**未应答**的调用（而非见过的所有 id——llama.cpp 会给所有调用同一个 id），
 * 同一 assistant 消息内的重复声明折叠。
 */
function dedupeToolCallIds(messages: SanitizableMessage[]): SanitizableMessage[] {
  const outstanding = new Set<string>();
  const deduped: SanitizableMessage[] = [];
  let removed = 0;

  for (const msg of messages) {
    if (msg.role === "assistant" && readToolCalls(msg).length > 0) {
      const kept: ToolCallShape[] = [];
      for (const tc of readToolCalls(msg)) {
        const id = toolCallId(tc);
        if (id && outstanding.has(id)) {
          removed += 1;
          continue;
        }
        if (id) outstanding.add(id);
        kept.push(tc);
      }
      if (kept.length !== readToolCalls(msg).length) {
        if (kept.length > 0) {
          deduped.push({ ...msg, tool_calls: kept });
        } else {
          const { tool_calls: _dropped, ...rest } = msg;
          deduped.push(rest as SanitizableMessage);
        }
        continue;
      }
    } else if (msg.role === "tool") {
      const id = typeof msg.tool_call_id === "string" ? msg.tool_call_id.trim() : "";
      if (id && !outstanding.has(id)) {
        removed += 1;
        continue;
      }
      if (id) outstanding.delete(id);
    }
    deduped.push(msg);
  }

  return removed === 0 ? messages : deduped;
}

/**
 * pass 8：tool 结果的 `name` 对齐到其调用声明的 function.name
 * （Google 对不一致直接 400；只改「存在且不一致」的，干净记录保持字节一致）。
 */
function realignToolResultNames(messages: SanitizableMessage[]): SanitizableMessage[] {
  const callNames = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const tc of readToolCalls(msg)) {
      const id = toolCallId(tc);
      const name = toolCallName(tc);
      if (id && name) callNames.set(id, name);
    }
  }
  let changed = false;
  const aligned = messages.map((msg) => {
    if (msg.role !== "tool") return msg;
    const id = typeof msg.tool_call_id === "string" ? msg.tool_call_id.trim() : "";
    const expected = callNames.get(id);
    const current = msg.name;
    if (expected && typeof current === "string" && current && current !== expected) {
      changed = true;
      return { ...msg, name: expected };
    }
    return msg;
  });
  return changed ? aligned : messages;
}

/**
 * 出站消息净化：每次 LLM 调用前无条件执行（对标 hermes `sanitize_api_messages`）。
 * 顺序即语义——空消息先被修复，替换后的消息再参与配对/去重。
 * 无改动时返回原数组引用。
 */
export function sanitizeApiMessages<T extends SanitizableMessage>(messages: T[]): T[] {
  if (messages.length === 0) return messages;
  let out: SanitizableMessage[] = messages;
  out = dropInvalidRoles(out);
  out = repairEmptyMessages(out);
  out = dropEmptyToolCallsArrays(out);
  out = repairToolCalls(out);
  out = dropResultsWithoutIds(out);
  out = pairToolCallsPositionally(out);
  out = dedupeToolCallIds(out);
  out = realignToolResultNames(out);
  return out as T[];
}
