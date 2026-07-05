/**
 * MessageUtils — 消息工具函数
 *
 * 借鉴 OpenSpace agents/message_utils.py：
 *   - cap_message_content 头尾保留（保留语义）
 *   - 截断后注入"已丢弃 N 条"系统消息
 *
 * EvoClaw 落地点：
 *   - context-engine.ts 装配上下文时调用 capMessageContent
 *   - conversation-formatter.ts 截断后调用 injectTruncationNotice
 */

// ── 单条消息头尾保留截断（借鉴 OpenSpace cap_message_content） ───

/**
 * 截断单条消息内容，保留头部和尾部。
 *
 * 比简单 `[:max]` 更保留语义：
 *   - 工具结果通常首部是元数据（结构/schema）
 *   - 尾部是结论（status/result）
 *   - 中间是冗长数据
 *
 * @param content 原始内容
 * @param maxLen 最大长度（字符数）
 * @returns 截断后的内容（含中间 truncation 标记）
 */
export function capMessageContent(content: string, maxLen: number = 8000): string {
  if (!content) return content;
  if (content.length <= maxLen) return content;

  const halfLen = Math.floor(maxLen / 2);
  const head = content.slice(0, halfLen);
  const tail = content.slice(-halfLen);
  const truncatedCount = content.length - maxLen;

  return `${head}\n... [truncated ${truncatedCount} chars in the middle] ...\n${tail}`;
}

// ── 截断通知注入（借鉴 OpenSpace message_utils.py line 91-101） ───

export interface AgentMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** 工具调用 ID（如果是 tool 消息） */
  tool_call_id?: string;
  /** 工具名 */
  tool_name?: string;
  /** 名称（如果是 user 消息） */
  name?: string;
}

/**
 * 在消息列表中注入"已丢弃 N 条"系统消息。
 *
 * 用于让 LLM 知道有上下文丢失，避免它假设对话完整。
 *
 * @param messages 截断后的消息列表
 * @param droppedCount 被丢弃的消息数
 * @returns 注入了通知的新消息列表
 */
export function injectTruncationNotice<T extends AgentMessage>(
  messages: T[],
  droppedCount: number,
): T[] {
  if (droppedCount <= 0) return messages;

  const notice: AgentMessage = {
    role: "system",
    content: `[INTERNAL ORCHESTRATION NOTE] ${droppedCount} earlier message(s) were truncated to fit context window. The conversation may reference content that is no longer visible.`,
  };

  // 通知插入到开头（system 消息后）
  const result: T[] = [];
  let inserted = false;

  for (const msg of messages) {
    if (!inserted && msg.role !== "system") {
      result.push(notice as unknown as T);
      inserted = true;
    }
    result.push(msg);
  }

  // 如果全是 system 消息，追加到末尾
  if (!inserted) {
    result.push(notice as unknown as T);
  }

  return result;
}

// ── 头尾保留截断 + 通知注入的组合 ──────────────────────────────

/**
 * 截断消息列表中过长的单条消息（头尾保留），并注入截断通知。
 *
 * @param messages 原始消息列表
 * @param maxMessageLen 单条消息最大长度
 * @returns 截断后的消息列表 + 截断统计
 */
export function capMessages<T extends AgentMessage>(
  messages: T[],
  maxMessageLen: number = 8000,
): { messages: T[]; cappedCount: number } {
  let cappedCount = 0;
  const result = messages.map((msg) => {
    if (msg.content && msg.content.length > maxMessageLen) {
      cappedCount++;
      return { ...msg, content: capMessageContent(msg.content, maxMessageLen) };
    }
    return msg;
  });

  return { messages: result, cappedCount };
}

// ── 错误首行精简提取（借鉴 OpenSpace analyzer.py line 686-698） ───

/**
 * 从错误输出中提取首行（最关键的错误信息）。
 *
 * 借鉴 OpenSpace analyzer.py：
 *   - error 时只取 stderr.strip().split("\n")[0][:200]
 *   - 加上 cmd: {前 100 字符}
 */
export function extractErrorFirstLine(
  stderr: string,
  cmd?: string,
  maxErrorLen: number = 200,
  maxCmdLen: number = 100,
): { errorLine: string; cmdLine: string } {
  let errorLine = "";
  if (stderr) {
    const trimmed = stderr.trim();
    const firstLine = trimmed.split("\n")[0];
    errorLine = firstLine.slice(0, maxErrorLen);
  }

  let cmdLine = "";
  if (cmd) {
    cmdLine = `cmd: ${cmd.slice(0, maxCmdLen)}`;
  }

  return { errorLine, cmdLine };
}

// ── 分节截断常量（借鉴 OpenSpace analyzer.py line 48-52） ──────

/**
 * 按内容类型分配 token 预算的常量。
 *
 * 比单一全局 MAX_CHARS 更精细化：
 *   - 错误堆栈保留更多（1000）
 *   - 成功结果次之（800）
 *   - 工具参数最短（500）
 *   - 内嵌 agent 摘要最长（1500）
 */
export const SECTION_MAX_CHARS = {
  TOOL_ERROR: 1000,
  TOOL_SUCCESS: 800,
  TOOL_ARGS: 500,
  TOOL_SUMMARY: 1500,
  USER_MESSAGE: 12000,
  ASSISTANT_MESSAGE: 8000,
  SYSTEM_MESSAGE: 4000,
} as const;

/**
 * 根据 message role 选择对应的 maxLen。
 */
export function getMaxLenForMessage(msg: AgentMessage): number {
  if (msg.role === "tool") {
    // 工具消息：根据内容判断是错误还是成功
    const content = msg.content?.toLowerCase() ?? "";
    if (content.includes("error") || content.includes("failed") || content.includes("exception")) {
      return SECTION_MAX_CHARS.TOOL_ERROR;
    }
    return SECTION_MAX_CHARS.TOOL_SUCCESS;
  }
  if (msg.role === "user") return SECTION_MAX_CHARS.USER_MESSAGE;
  if (msg.role === "assistant") return SECTION_MAX_CHARS.ASSISTANT_MESSAGE;
  if (msg.role === "system") return SECTION_MAX_CHARS.SYSTEM_MESSAGE;
  return SECTION_MAX_CHARS.TOOL_SUCCESS;
}
