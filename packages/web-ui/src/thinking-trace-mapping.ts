/**
 * 历史消息映射：把后端 session 接口的 turns 转成前端消息。
 *
 * ★ 这里必须带上 thinkingTrace / thinkingSummary（2026-10-08 修复）
 *
 * 实测踩坑：后端 `/api/sessions/:agentId/:sessionId` **已经**返回 thinkingTrace，
 * 但前端 WebChatPage 加载历史时只映射 role/content/timestamp，把轨迹字段
 * **静默丢弃**。结果：任务执行当场能看到思考过程（走 progress 事件），
 * 一刷新页面就彻底消失 —— 用户反馈「完成后在结果里找不到完成任务的过程」。
 *
 * 独立成模块是为了能在 node 环境直接单测（WebChatPage.tsx 依赖 DOM）。
 */

/** 思考轨迹条目（与后端 packages/agent/src/thinking-trace.ts 对齐） */
export interface ThinkingStep {
  kind: "reasoning" | "decision" | "tool_result" | "error" | "system";
  title: string;
  detail?: string;
  at?: number;
}

export interface MappedMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: string;
  thinkingTrace?: ThinkingStep[];
  thinkingSummary?: string;
}

export function mapSessionTurnsToMessages(
  turns: Array<Record<string, unknown>>,
  sessionId: string
): MappedMessage[] {
  return turns.map((t, i) => ({
    id: `${sessionId}-t${i}`,
    role: (t.role as MappedMessage["role"]) || "assistant",
    content: (t.content as string) || "",
    timestamp: (t.timestamp as string) || new Date().toISOString(),
    // 空数组视为无轨迹，避免渲染出空的思考面板
    ...(Array.isArray(t.thinkingTrace) && t.thinkingTrace.length > 0
      ? { thinkingTrace: t.thinkingTrace as ThinkingStep[] }
      : {}),
    ...(typeof t.thinkingSummary === "string" && t.thinkingSummary
      ? { thinkingSummary: t.thinkingSummary as string }
      : {}),
  }));
}
