/**
 * 多气泡切分（2026-10-08）。
 *
 * 用户原话：「在任务执行过程中，EvoClaw 回复的输出框多次变化，
 * 下一个变化总是会冲掉上一个页面的内容。这是最要命的。
 * 我要求你立即修改为：EvoClaw 的回复可以出现多个回复气泡，
 * 下一条内容不要显示在上一条内容的气泡里，而是要新建一个气泡。」
 *
 * 根因：旧实现靠 `newReply.length < currentContent.length * 0.5`
 * **猜测**是否换轮，换轮时把旧内容塞进同一个气泡的折叠区 → 看起来就是被冲掉。
 * 现在改为由后端显式声明 roundIndex，前端不再猜。
 *
 * 抽成独立模块以便在 node 环境直接单测（WebChatPage 依赖 DOM）。
 */

/** 只依赖 id/role/content 的最小结构；WebChatMessage 天然满足 */
export interface Bubble {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

/** 该条事件是否需要新建气泡 */
export function shouldStartNewBubble(roundIndex: unknown): boolean {
  return typeof roundIndex === "number" && roundIndex > 1;
}

/**
 * 把一轮的生成内容并入消息列表。
 *
 * - `roundIndex` 为 null/1 → 写入**当前活动气泡**（首轮）
 * - `roundIndex` > 1 → **新建气泡**，且**不改动已有气泡的 id**
 *   （改名会打断 showThinking 等按 id 索引的展开状态 —— 自检时发现的 bug）
 * - 同一轮事件重复到达时**幂等**：只更新内容，不重复建气泡
 *
 * @returns 新的消息数组与新的活动气泡 id
 */
export function applyRoundContent<T extends Bubble>(
  prev: T[],
  params: { botMsgId: string; activeBubbleId: string; roundIndex: unknown; reply: string },
): { messages: T[]; activeBubbleId: string } {
  const { botMsgId, roundIndex, reply } = params;
  const activeId = params.activeBubbleId || botMsgId;

  if (!shouldStartNewBubble(roundIndex)) {
    return {
      messages: prev.map((m) => (m.id === activeId ? { ...m, content: reply } : m)),
      activeBubbleId: activeId,
    };
  }

  const n = roundIndex as number;
  const newBubbleId = `${botMsgId}-r${n}`;

  // 幂等：这一轮的气泡已在，只更新内容
  if (prev.some((m) => m.id === newBubbleId)) {
    return {
      messages: prev.map((m) => (m.id === newBubbleId ? { ...m, content: reply } : m)),
      activeBubbleId: newBubbleId,
    };
  }

  // 新建气泡：保留此前所有气泡（**不改名、不覆盖**）
  const created = { id: newBubbleId, role: "assistant", content: reply } as unknown as T;
  return { messages: [...prev, created], activeBubbleId: newBubbleId };
}
