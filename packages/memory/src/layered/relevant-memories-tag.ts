/**
 * relevant-memories 标签管理 — 防止召回内容污染历史。
 *
 * 借鉴 TencentDB-Agent-Memory 的 `before_message_write` hook：
 * - 召回时把记忆用 `<relevant-memories>` 标签包裹注入到 user prompt
 * - 写入 L0 / LongTermMemory 前剥离这些标签，防止污染历史
 * - 标签内的内容不进入历史记录，但 LLM 当前轮次能看到
 *
 * 解决问题：召回的记忆被写入对话历史后，后续召回会"召回召回"，形成正反馈噪音。
 */

/** 标签开始标记。 */
export const RELEVANT_MEMORIES_OPEN = "<relevant-memories>";

/** 标签结束标记。 */
export const RELEVANT_MEMORIES_CLOSE = "</relevant-memories>";

/** 任务画布标签开始标记。 */
export const CANVAS_BLOCK_OPEN = "<task-canvas>";

/** 任务画布标签结束标记。 */
export const CANVAS_BLOCK_CLOSE = "</task-canvas>";

/** 所有需要剥离的标签对。 */
const STRIP_TAGS: Array<{ open: string; close: string }> = [
  { open: RELEVANT_MEMORIES_OPEN, close: RELEVANT_MEMORIES_CLOSE },
  { open: CANVAS_BLOCK_OPEN, close: CANVAS_BLOCK_CLOSE },
];

/**
 * 剥离文本中的召回标签（用于写入历史前清理）。
 *
 * @param text 原始文本
 * @returns 清理后的文本（标签 + 标签内内容被移除）
 */
export function stripRecallTags(text: string): string {
  if (!text) return text;
  let result = text;
  for (const { open, close } of STRIP_TAGS) {
    // 移除 <open>...</close>（含内容）
    const re = new RegExp(
      escapeRegex(open) + "[\\s\\S]*?" + escapeRegex(close),
      "g"
    );
    result = result.replace(re, "");
  }
  // 清理多余空行
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 剥离消息数组中所有消息的召回标签。
 *
 * @param messages 消息数组
 * @returns 清理后的消息数组（原地修改 + 返回）
 */
export function stripRecallTagsFromMessages(
  messages: Array<{ role?: string; content?: string | unknown }>
): typeof messages {
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      msg.content = stripRecallTags(msg.content);
    }
  }
  return messages;
}

/**
 * 把召回记忆包裹在 <relevant-memories> 标签内。
 *
 * @param memories 记忆内容数组
 * @returns 包裹后的字符串
 */
export function wrapRelevantMemories(memories: string[]): string {
  if (memories.length === 0) return "";
  const body = memories.map((m) => `  - ${m}`).join("\n");
  return `${RELEVANT_MEMORIES_OPEN}\n${body}\n${RELEVANT_MEMORIES_CLOSE}`;
}

/**
 * 把任务画布 Mermaid 包裹在 <task-canvas> 标签内。
 *
 * @param mermaid Mermaid 文本
 * @returns 包裹后的字符串
 */
export function wrapTaskCanvas(mermaid: string): string {
  if (!mermaid) return "";
  return `${CANVAS_BLOCK_OPEN}\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n${CANVAS_BLOCK_CLOSE}`;
}

/**
 * 检测文本中是否包含召回标签（用于调试 / 日志）。
 */
export function hasRecallTags(text: string): boolean {
  if (!text) return false;
  return STRIP_TAGS.some(
    ({ open, close }) => text.includes(open) && text.includes(close)
  );
}

/** 转义正则特殊字符。 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
