import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 工具调用上下文（P1 execute_code RPC 加固）。
 *
 * 工具处理器默认拿不到 sessionId —— 它只是 handler(params)。
 * 但审计与安全策略需要「这次调用属于哪个会话 / 哪一轮」：
 * - execute_code programmatic 审计记录必须可归属到 session/run；
 * - 嵌套的 executeToolByName（脚本 → 工具 → 再调工具）应继承同一上下文。
 *
 * 用 AsyncLocalStorage 而不是给 args 注入 `_sessionId`：后者会进入模型可见的
 * 工具参数与历史，破坏 prompt 缓存稳定性，也可能被脚本伪造。
 */
export interface ToolRuntimeContext {
  sessionId: string;
  /** 单次 chat()/turn 的运行标识；程序化脚本的 RPC token 与之绑定 */
  runId: string;
}

const storage = new AsyncLocalStorage<ToolRuntimeContext>();

/** 在工具调用上下文中执行 handler（由 llm-caller 在派发点包裹） */
export function runWithToolCallContext<T>(ctx: ToolRuntimeContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** 当前异步调用链的工具上下文；顶层（无上下文）返回 undefined */
export function getCurrentToolCallContext(): ToolRuntimeContext | undefined {
  return storage.getStore();
}
