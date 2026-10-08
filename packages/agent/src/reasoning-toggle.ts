/**
 * 推理开关：让**不同大模型**都能吐出思考原文。
 *
 * 背景（2026-10-08，用户诉求「要适应不同的大模型都能够显示出来」）：
 * 实测抓原始 SSE 流逐个探测启用中的 provider，发现差异极大 ——
 *
 *   | provider / 模型                | 默认 | +enable_thinking | +reasoning_effort |
 *   |--------------------------------|------|------------------|-------------------|
 *   | mimo-v2.6-flash                | 7 字 | 50 字            | 68 字             |
 *   | agnes-3.0-flash                | 0    | 0                | 0                 |
 *   | deepseek-v4.1-flash            | 0    | 0                | 0（key 已失效）   |
 *
 * 关键结论：**mimo 默认只给 7 字推理**，加上开关后才给 50–68 字。
 * 系统此前从不传任何推理开关，等于把模型已有的能力白白丢掉 ——
 * 这才是"轨迹里几乎没有 reasoning"的真正原因（不是抓取代码的问题）。
 *
 * 注意：不同 provider 的开关名不通用，传错会被忽略或报错，
 * 所以这里按 provider/model 特征**只对确认支持的才加**。
 */

/** 只需要 name/model/id 之类字段的最小 provider 形状 */
export interface ReasoningToggleTarget {
  id?: string;
  name?: string;
  provider?: string;
  model?: string;
  baseURL?: string;
}

/** 归一化：小写 + 去掉分隔符，便于按子串匹配 */
function norm(s: string | undefined): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** provider / 模型名里出现这些片段 → 用 enable_thinking（Qwen / MiMo / GLM / Qwen-compatible 系） */
const ENABLE_THINKING_HINTS = ["qwen", "mimo", "qwen3", "glm", "kimi", "moonshot", "minimax", "stepfun", "hunyuan"];

/** provider / 模型名里出现这些片段 → 用 reasoning_effort（OpenAI / Anthropic 兼容系） */
const REASONING_EFFORT_HINTS = ["openai", "gpt", "o1", "o3", "o4", "claude", "anthropic", "gemini", "google"];

export type ReasoningToggle =
  | { kind: "enable_thinking"; value: true }
  | { kind: "reasoning_effort"; value: "high" }
  | { kind: "none" };

/**
 * 判断某个 provider 该用哪种推理开关。
 * 纯函数，便于单测覆盖各家差异。
 */
export function pickReasoningToggle(p: ReasoningToggleTarget): ReasoningToggle {
  const hay = norm(
    [p.id, p.name, p.provider, p.model, p.baseURL].filter(Boolean).join("")
  );
  if (!hay) return { kind: "none" };

  // DeepSeek 走专有 reasoning_type（调用方已单独处理），这里不重复加
  if (hay.includes("deepseek")) return { kind: "none" };

  if (ENABLE_THINKING_HINTS.some((h) => hay.includes(h))) {
    return { kind: "enable_thinking", value: true };
  }
  if (REASONING_EFFORT_HINTS.some((h) => hay.includes(h))) {
    return { kind: "reasoning_effort", value: "high" };
  }
  return { kind: "none" };
}

/**
 * 就地把推理开关写进请求体。
 * 已显式设置过的字段不覆盖（尊重调用方/用户的显式配置）。
 */
export function applyReasoningToggle(
  body: Record<string, unknown>,
  p: ReasoningToggleTarget
): Record<string, unknown> {
  const toggle = pickReasoningToggle(p);
  if (toggle.kind === "none") return body;

  if (toggle.kind === "enable_thinking") {
    if (body.enable_thinking === undefined) body.enable_thinking = toggle.value;
  } else {
    if (body.reasoning_effort === undefined) body.reasoning_effort = toggle.value;
  }
  return body;
}
