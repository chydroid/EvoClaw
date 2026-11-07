/**
 * Anthropic 先手回合 thinking 保留策略（对齐 Hermes agent/anthropic_thinking_policy.py）。
 *
 * Anthropic 对 Opus 4.5+ / Sonnet 4.6+ / Haiku 5.5+（含 Fable/Mythos 家族）在模型可见
 * 上下文中**保留并计费**先手回合 assistant thinking 块；老模型（Claude 3 及更早）
 * 接受重放但服务端剥离。中继站（第三方网关）无法校验 Anthropic thinking 签名
 * （signature field），重放签名块会被 400 拒绝，因此默认剥离。
 *
 * 未知/未来 Claude id 默认保留：被服务端剥离的重放零代价，而在应保留的模型上
 * 剥离会每次调用改写已缓存前缀。
 *
 * 决策只依赖 (baseURL, model)——纯函数，可单测；消息转换与上下文计费共享此模块，
 * 避免两处规则漂移（Hermes 同型约束）。
 */

/** family → 从该版本起"保留先手回合 thinking"（对齐 Hermes _KEEP_ALL_FROM） */
const KEEP_ALL_FROM: Record<string, [number, number]> = {
  opus: [4, 5],
  sonnet: [4, 6],
  haiku: [5, 5],
};
/** 未覆盖家族（fable/mythos/未来）的保留门槛：主版本 ≥5 */
const UNKNOWN_FAMILY_KEEP_FROM: [number, number] = [5, 0];

// 版本组件必须是语义 minor（1-2 位）——claude-opus-4-20250514 记为 4.0 而非 4.20250514。
// 同 Hermes：`(\d{1,2})(?=$|[-_.])`
const CLAUDE_VERSION_RE =
  /claude[-_.](opus|sonnet|haiku|fable|mythos)[-_.](\d+)(?:[-_.](\d{1,2})(?=$|[-_.]))?/i;
/** Claude 3.x（version-last：claude-3-5-haiku）一律剥离 */
const LAST_TURN_ONLY_3_RE = /claude[-_.]?3(?!\d)/i;

/** 解析 claude 家族 id → (family, [major, minor])；非 claude 或不可解析 → null */
export function claudeFamilyVersion(model: unknown): { family: string; version: [number, number] } | null {
  if (typeof model !== "string") return null;
  const m = CLAUDE_VERSION_RE.exec(model.trim());  if (!m) return null;
  const family = m[1].toLowerCase();
  const major = Number(m[2]);
  const minor = m[3] ? Number(m[3]) : 0;
  return { family, version: [major, minor] };
}

/** 该 Claude 模型是否在模型可见上下文中保留先手回合 assistant thinking */
export function modelPreservesPriorThinking(model: unknown): boolean {
  if (typeof model !== "string" || !/claude/i.test(model) || LAST_TURN_ONLY_3_RE.test(model)) return false;
  const parsed = claudeFamilyVersion(model);
  if (!parsed) return true; // claude 前缀但无法解析版本（future family 等）→ 默认保留
  const { family, version } = parsed;
  const keepFrom = KEEP_ALL_FROM[family] ?? UNKNOWN_FAMILY_KEEP_FROM;
  return version[0] > keepFrom[0] || (version[0] === keepFrom[0] && version[1] >= keepFrom[1]);
}

/** thinking 重放契约路由（对齐 Hermes anthropic_thinking_route） */
export type ThinkingRoute = "native" | "minimax" | "kimi" | "deepseek" | "third_party";

const NATIVE_HOST_RE =
  /(^|\.)(api\.)?anthropic\.com$|(^|\.)anthropic\.co$/i; // 官方 + 云（Bedrock/Vertex 走 us.anthropic.* / amazonaws）
const NATIVE_CLOUD_RE = /(^|\.)(us|eu|apac)\.anthropic\.|bedrock-runtime\.amazonaws\.com|nousresearch\.com/i;
const MINIMAX_HOST_RE = /minimaxi?\.(com|io)$/i;
const KIMI_HOST_RE = /(moonshot(ai)?\.cn|moonshotai\.com|kimi\.(com|cn)|moonshotai\.(asia|us))$/i;

function hostOf(baseURL: unknown): string {
  try {
    return new URL(String(baseURL)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 哪类 thinking 重放契约适用：
 * - native：Anthropic 官方 / Bedrock / Vertex / Nous Portal（签名可校验）
 * - minimax：MiniMax 的 anthropic 格式端点（其自有签名块，每轮原样重放）
 * - kimi：Kimi（Moonshot）中继
 * - deepseek：DeepSeek thinking 无签名，任何 host 都保持 unsigned-only 契约
 * - third_party：未知中继（含 OpenAI 兼容网关）→ 剥离全部 thinking 块
 */
export function anthropicThinkingRoute(baseURL: unknown, model: unknown): ThinkingRoute {
  const host = hostOf(baseURL);
  if (!host) return "third_party";
  if (MINIMAX_HOST_RE.test(host)) return "minimax";
  if (/deepseek/i.test(String(model ?? ""))) return "deepseek";
  if (KIMI_HOST_RE.test(host)) return "kimi";
  if (NATIVE_HOST_RE.test(host) || NATIVE_CLOUD_RE.test(host)) return "native";
  return "third_party";
}

/** 该路由在 assistant 轮（工具循环前）重放先手回合 thinking 块（含签名） */
export function routeReplaysPriorThinking(route: ThinkingRoute, model: unknown): boolean {
  return route === "minimax" || (route === "native" && modelPreservesPriorThinking(model));
}

/** 一站式：请求 (baseURL, model) 是否重放带签名先手回合 thinking */
export function shouldReplayPriorThinking(baseURL: unknown, model: unknown): boolean {
  return routeReplaysPriorThinking(anthropicThinkingRoute(baseURL, model), model);
}
