/**
 * LLM 调用会话作用域（AsyncLocalStorage）。
 *
 * 背景：`callLLMOnce` 是「全仓最后一个收口点」，任何调用方（主循环 /
 * grace call / 摘要 / task-analyzer / server 辅助调用）都会经过它。但它的
 * 参数表里没有 sessionId（`LLMCallerDeps` 是**缓存复用**的，存进去的
 * sessionId 会串味到别的会话），而失败请求转储需要知道「这次失败属于哪个
 * 会话」才能落到 `request_dump_<sid>_<ts>.json`。
 *
 * 用 AsyncLocalStorage 而不是给 `callLLMOnce` 加第 9 个位置参数：
 * - 位置参数表已经很长，再加一个「可选字符串」只会让所有调用点更难读；
 * - ALS 让嵌套调用（压缩摘要器里再调 callLLMOnce）自动继承同一个会话，
 *   不必逐个透传；
 * - 作用域只活在一次调用链内，不会跨请求泄漏。
 *
 * 未设置作用域时（server 辅助调用 / 单测直调）返回 undefined——转储退化为
 * 文件名里的 `session` 占位，不影响主流程。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface LlmCallScope {
  /** 本次 LLM 调用所属会话（可选） */
  sessionId?: string;
}

const storage = new AsyncLocalStorage<LlmCallScope>();

/** 在会话作用域内执行一次 LLM 调用 */
export function runWithLlmCallScope<T>(scope: LlmCallScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** 当前调用链的会话作用域；顶层（无作用域）返回 undefined */
export function getCurrentLlmCallScope(): LlmCallScope | undefined {
  return storage.getStore();
}
