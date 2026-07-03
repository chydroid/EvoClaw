/**
 * Reasoning-timeouts — 推理模型感知的 stale-timeout 下限。
 *
 * 对标 Hermes `agent/reasoning_timeouts.py`：
 *   推理模型（o1/o3/Claude Opus 4.x/DeepSeek R1/Qwen3/Nemotron/Grok reasoning）
 *   在产出第一个 content token 前会输出长 thinking 块，常规 90~180s stale
 *   检测器会误判为卡死并杀掉连接，触发 BrokenPipeError / RemoteProtocolError。
 *
 * 本模块提供 floor（下限）：调用方按 `max(default, floor)` 应用，
 * 且仅在用户未显式配置 per-model stale_timeout_seconds 时生效。
 *
 * 匹配规则：
 *   - 取 model slug（剥掉 `openai/` 这类聚合器前缀）
 *   - 起锚定 regex `^<slug>(?:$|[\-._])`，避免 `olmo-1` 误命中 `o1`
 *   - 长 slug 优先（`o3-mini` 优先于 `o3`）
 *
 * 这是一个 FLOOR：
 *   1. 不覆盖用户显式配置
 *   2. 不主动降低既有阈值
 *   3. 对非推理模型返回 null（无影响）
 */

/**
 * (slug, floor_seconds) — 推理模型 stale-timeout 下限表。
 * 来源：hermes-agent agent/reasoning_timeouts.py 行 62-111。
 */
export const REASONING_STALE_TIMEOUT_FLOORS: ReadonlyArray<readonly [string, number]> = [
  // NVIDIA Nemotron — hosted NIM 上游 60-180s idle kill
  ["nemotron-3-ultra", 600],
  ["nemotron-3-super", 600],
  ["nemotron-3-nano", 300],
  // DeepSeek R1 / reasoner
  ["deepseek-r1", 600],
  ["deepseek-reasoner", 600],
  // Qwen QwQ + Qwen3 thinking 家族
  ["qwq-32b", 300],
  ["qwen3", 180],
  // OpenAI o-series — 已知多分钟 TTFB
  ["o1", 600],
  ["o1-mini", 600],
  ["o1-pro", 600],
  ["o1-preview", 600],
  ["o3", 600],
  ["o3-pro", 600],
  ["o3-mini", 300],
  ["o4-mini", 300],
  // Anthropic Claude 4.x thinking 变体
  ["claude-opus-4", 240],
  ["claude-sonnet-4.5", 180],
  ["claude-sonnet-4.6", 180],
  // xAI Grok reasoning 变体
  ["grok-4-fast-reasoning", 300],
  ["grok-4.20-reasoning", 300],
  ["grok-4-fast-non-reasoning", 180],
];

// 编译后的 regex 缓存（slug → 锚定正则）
const patternCache = new Map<string, RegExp>();

function getPattern(slug: string): RegExp {
  let compiled = patternCache.get(slug);
  if (!compiled) {
    // 起锚定 + slug + (结尾或 -/_/. 分隔)
    compiled = new RegExp(`^${escapeRegex(slug)}(?:$|[\\-._])`);
    patternCache.set(slug, compiled);
  }
  return compiled;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 匹配 model_lower，返回首个命中的 floor。
 * 长 slug 优先（o3-mini 优先于 o3）。
 */
function matchAny(modelLower: string): number | null {
  // 按 slug 长度降序，避免短前缀覆盖长前缀
  const sorted = [...REASONING_STALE_TIMEOUT_FLOORS].sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [slug, floor] of sorted) {
    if (getPattern(slug).test(modelLower)) {
      return floor;
    }
  }
  return null;
}

/**
 * 返回已知推理模型的 stale-timeout 下限（秒）。
 *
 * 非推理模型或空输入返回 null。匹配使用 slug 起锚定 regex：
 *   - `openai/o3-mini` 命中 `o3-mini` slug（`/` 是分隔符）
 *   - `olmo-1` 不命中 `o1`（`o1` 不在 slug 起始位置）
 *   - `anthropic/claude-opus-4-6` 命中 `claude-opus-4`
 *
 * 这是一个 FLOOR — 调用方必须按 `max(default, floor)` 应用，
 * 且仅在用户未显式配置 per-model stale_timeout_seconds 时调用。
 *
 * @param model 模型 id（可含聚合器前缀，如 `openai/o3-mini`）
 * @returns floor 秒数，或 null
 *
 * @example
 * ```ts
 * getReasoningStaleTimeoutFloor("openai/o3-mini"); // 300
 * getReasoningStaleTimeoutFloor("deepseek/deepseek-r1"); // 600
 * getReasoningStaleTimeoutFloor("gpt-4o"); // null
 * getReasoningStaleTimeoutFloor(""); // null
 * ```
 */
export function getReasoningStaleTimeoutFloor(model: string | null | undefined): number | null {
  if (!model || typeof model !== "string") return null;
  let name = model.trim().toLowerCase();
  if (!name) return null;
  // 剥掉聚合器前缀（最后一个 `/` 之前的部分）
  const slashIdx = name.lastIndexOf("/");
  if (slashIdx >= 0) {
    name = name.slice(slashIdx + 1);
  }
  return matchAny(name);
}

/**
 * 应用 floor 到默认超时：`max(default, floor)`。
 * 若 model 不在推理模型表里，直接返回 default。
 *
 * @example
 * ```ts
 * applyReasoningFloor("openai/o3-mini", 90); // 300
 * applyReasoningFloor("gpt-4o", 90); // 90
 * ```
 */
export function applyReasoningFloor(model: string | null | undefined, defaultTimeout: number): number {
  const floor = getReasoningStaleTimeoutFloor(model);
  if (floor === null) return defaultTimeout;
  return Math.max(defaultTimeout, floor);
}

/**
 * 判断 model 是否为已知推理模型（用于日志/调试）。
 */
export function isKnownReasoningModel(model: string | null | undefined): boolean {
  return getReasoningStaleTimeoutFloor(model) !== null;
}
