/**
 * LLM API 端点 URL 构造器
 *
 * 历史问题：旧代码只认 `/v1` 后缀，遇到 `/v2`（如讯飞 MaaS）的 baseURL
 * 会错误地追加 `/v1`，产生 `/v2/v1/chat/completions` → 网关 404。
 *
 * 现在统一用 `/\/v\d+$/` 识别任意版本号（v1/v2/v3...），只有
 * baseURL 不含版本段时才默认补 `/v1`。
 */

/** 判断 URL 是否已含版本段（如 /v1、/v2）。 */
function hasVersionSegment(url: string): boolean {
  return /\/v\d+$/.test(url);
}

/**
 * 构造 OpenAI 兼容 Chat Completions 端点 URL。
 * 输入示例：
 *   "https://api.openai.com"        → https://api.openai.com/v1/chat/completions
 *   "https://api.openai.com/v1"     → https://api.openai.com/v1/chat/completions
 *   "https://maas.xf-yun.com/v2"    → https://maas.xf-yun.com/v2/chat/completions
 *   "https://gw.com/v1/chat/completions" → 原样返回
 */
export function buildChatCompletionsUrl(baseURL: string): string {
  let url = (baseURL || "").replace(/\/+$/, "");
  if (url.endsWith("/chat/completions")) return url;
  if (!hasVersionSegment(url)) url = `${url}/v1`;
  return `${url}/chat/completions`;
}

/**
 * 构造 Anthropic Messages API 端点 URL。
 * 输入示例：
 *   "https://api.anthropic.com"     → https://api.anthropic.com/v1/messages
 *   "https://api.anthropic.com/v1"  → https://api.anthropic.com/v1/messages
 *   "https://api.anthropic.com/v2"  → https://api.anthropic.com/v2/messages
 *   "https://gw.com/v1/messages"    → 原样返回
 *   "https://gw.com/v1/chat/completions" → 剥掉 chat/completions 后走标准逻辑
 */
export function buildAnthropicMessagesUrl(baseURL: string): string {
  let url = (baseURL || "").replace(/\/+$/, "");
  if (url.endsWith("/messages")) return url;
  if (url.endsWith("/chat/completions")) {
    url = url.slice(0, -"/chat/completions".length);
  }
  if (!hasVersionSegment(url)) url = `${url}/v1`;
  return `${url}/messages`;
}
