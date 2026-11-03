/**
 * agent-model-executor.ts — Agent 模型执行器骨架
 *
 * 本文件为重构任务生成的骨架，统一错误处理入口。
 * 实际实现位于 /home/chy/EvoClaw/packages/agent/src/agent-model-executor.ts，
 * 此骨架用于演示统一 ErrorHandler 在 Agent 执行侧的集成方式。
 */

import { createErrorHandler, type ClassifiedError, type ErrorCode } from "@evoclaw/infrastructure/errors";

export interface ProviderStats {
  successCount: number;
  failureCount: number;
  lastError?: string;
  lastErrorType?: ErrorCode;
}

export interface AgentProgressCallback {
  (e: { type: "error"; phase: string; detail: string; progress: number }): void;
}

/**
 * 统一错误处理：记录 Provider 失败（ErrorCode 收敛）
 */
export function recordProviderFailure(
  stats: ProviderStats,
  classified: ClassifiedError,
): ProviderStats {
  const next: ProviderStats = { ...stats };
  next.failureCount += 1;
  next.lastError = classified.message;
  next.lastErrorType = classified.code;
  return next;
}

/**
 * 统一错误处理：向用户报告 LLM 侧错误（走 ErrorHandler.forUser）
 */
export function reportLLMError(
  e: ClassifiedError,
  providerName: string,
  onProgress?: AgentProgressCallback,
): void {
  const handler = createErrorHandler();
  const friendly = handler.forUser(e);
  const detail = friendly.actionableHint
    ? `${friendly.userMessage}\n💡 ${friendly.actionableHint}`
    : friendly.userMessage;
  onProgress?.({
    type: "error",
    phase: "generating",
    detail: `[${providerName}] ${detail}`,
    progress: 30,
  });
}
