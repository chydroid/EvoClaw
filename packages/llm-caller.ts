/**
 * llm-caller.ts — LLM Provider 统一调用层
 *
 * 本文件为重构任务生成的骨架，统一错误处理入口。
 * 实际实现位于 /home/chy/EvoClaw/packages/agent/src/llm-caller.ts，
 * 此骨架用于演示统一 ErrorHandler 在 LLM 调用侧的集成方式。
 */

import { createErrorHandler, type ClassifiedError, type ErrorCode } from "@evoclaw/infrastructure/errors";

export interface ProviderConfig {
  id: string;
  name: string;
  provider?: string;
  model?: string;
  apiKey?: string;
}

export interface TryCallLLMOptions {
  provider: ProviderConfig;
  apiURL: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CallLLMOnceResult {
  ok: boolean;
  error?: ClassifiedError;
  errorType?: ErrorCode;
}

/**
 * 统一错误处理：LLM fetch 失败分类
 */
export function classifyFetchError(
  provider: ProviderConfig,
  cause: unknown,
  statusCode?: number,
): ClassifiedError {
  const handler = createErrorHandler();
  return handler.classify({
    cause,
    statusCode,
    domain: "llm",
    context: { provider: provider.name },
  });
}

/**
 * 执行单次 LLM 调用（骨架），失败时按统一 ErrorCode 记录
 */
export async function callLLMOnce(
  provider: ProviderConfig,
  _options: TryCallLLMOptions,
): Promise<CallLLMOnceResult> {
  const handler = createErrorHandler();
  try {
    // 实际实现见 packages/agent/src/llm-caller.ts
    throw new Error("skeleton: see packages/agent/src/llm-caller.ts");
  } catch (err: unknown) {
    const e = handler.classify({ cause: err, domain: "llm", context: { provider: provider.name } });
    handler.onClassified?.(e);
    return { ok: false, error: e, errorType: e.code };
  }
}
