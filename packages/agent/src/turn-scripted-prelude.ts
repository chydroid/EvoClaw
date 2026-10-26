/**
 * TurnScriptedPrelude — 脚本化工具调用序列（对标 hermes-agent agent/turn_scripted_prelude.py）
 *
 * 在 turn 的第一次模型调用前执行预定义的工具调用序列。
 * 每个 step yield (content, toolName, args)：助手文本 + 工具调用。
 * 工具结果发送回 generator，后续 step 可使用前面的结果。
 *
 * 设计约束：
 *   - 在 provider 调用前运行 → 不修改任何缓存内容
 *   - system prompt 不变
 *   - 不添加 user row
 *   - 角色交替：user → assistant(tool_calls) → tool → ... → assistant(model)
 *   - 不计入 API 调用
 *   - 不触发 pre/post_api_request hook
 *
 * 使用场景：
 *   - 桌面端 onboarding 开场动画
 *   - 自动环境检查（git status, system info 等）
 *   - 任何需要在首次模型调用前完成的确定性工具序列
 */

import * as crypto from "crypto";

// ─── 类型 ──────────────────────────────────────────────────

/** 预lude step：yield (content, toolName, args) */
export interface PreludeStep {
  content: string;
  toolName: string;
  args: Record<string, unknown>;
}

/** 预lude 结果 */
export interface PreludeResult {
  /** 预lude 是否成功完成 */
  completed: boolean;
  /** 预lude 步骤数 */
  stepCount: number;
  /** 最后一步工具结果 */
  lastToolResult?: string;
  /** 是否应该结束 turn */
  shouldEndTurn: boolean;
  /** 是否应该跳过模型调用 */
  shouldSkipModel: boolean;
}

/** 预lude 回调 */
export interface PreludeCallbacks {
  /** 执行工具调用（返回结果字符串） */
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** 构建确定性 call_id */
  buildCallId?: (sessionId: string, name: string, args: Record<string, unknown>, index: number) => string;
  /** 中断检查 */
  isInterrupted?: () => boolean;
}

// ─── 确定性 call_id ────────────────────────────────────────

/**
 * 生成确定性 call_id（种子为 session + tool + args + index）。
 * 同一会话同一位置的同一工具调用产生相同 id，重放时字节稳定。
 */
export function preludeCallId(
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  index: number,
): string {
  const sortedArgs = JSON.stringify(args, Object.keys(args).sort());
  const seed = `${sessionId}:${name}:${sortedArgs}:${index}`;
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

// ─── 核心函数 ──────────────────────────────────────────────

/**
 * 执行脚本化预lude。
 *
 * 逐个步骤执行工具调用，将结果传回 generator。
 * 返回预lude 结果，调用方根据 shouldEndTurn / shouldSkipModel 决定后续流程。
 */
export async function runScriptedPrelude(
  steps: AsyncGenerator<PreludeStep, void, string | undefined> | null,
  sessionId: string,
  callbacks: PreludeCallbacks,
): Promise<PreludeResult> {
  if (!steps) {
    return { completed: false, stepCount: 0, shouldEndTurn: false, shouldSkipModel: false };
  }

  const result: PreludeResult = {
    completed: false,
    stepCount: 0,
    shouldEndTurn: false,
    shouldSkipModel: false,
  };

  let toolResult: string | undefined = undefined;
  let index = 0;

  try {
    while (!callbacks.isInterrupted?.()) {
      const step = await steps.next(toolResult);

      if (step.done) {
        result.completed = true;
        break;
      }

      const { content, toolName, args } = step.value;
      const callId = callbacks.buildCallId
        ? callbacks.buildCallId(sessionId, toolName, args, index)
        : preludeCallId(sessionId, toolName, args, index);

      // 执行工具调用
      const output = await callbacks.executeTool(toolName, args);
      toolResult = output;
      result.lastToolResult = output;
      index++;
      result.stepCount++;
    }
  } catch (err) {
    // 预lude 执行失败：不阻断 turn，记录错误
    console.warn(`[TurnScriptedPrelude] Prelude failed at step ${index}: ${err}`);
  } finally {
    try {
      await steps.return(undefined);
    } catch {
      // generator 已关闭
    }
  }

  return result;
}

/**
 * 运行预lude 并返回 turn 控制指令。
 *
 * 返回值：
 *   - "return" → 立即结束 turn（result 已设置）
 *   - "break" → 跳过模型调用
 *   - "run" → 正常运行（无预lude 或预lude 完成）
 */
export async function playPrelude(
  steps: AsyncGenerator<PreludeStep, void, string | undefined> | null,
  sessionId: string,
  callbacks: PreludeCallbacks,
): Promise<{ action: "return" | "break" | "run"; result: PreludeResult }> {
  const result = await runScriptedPrelude(steps, sessionId, callbacks);

  if (result.shouldEndTurn) {
    return { action: "return", result };
  }

  return { action: "run", result };
}

// ─── 预lude 生成器工厂 ────────────────────────────────────

/**
 * 创建环境检查预lude（检查 git status, system info 等）。
 * 在首次模型调用前执行，结果可被后续 step 使用。
 */
export function createEnvironmentCheckPrelude(
  sessionId: string,
): AsyncGenerator<PreludeStep, void, string | undefined> {
  return (async function* () {
    // Step 1: 检查工作目录
    yield {
      content: "Checking workspace environment...",
      toolName: "shell_exec",
      args: { command: "pwd && ls -la", timeout_ms: 5000 },
    };

    // Step 2: 检查 git 状态（如果有 git 结果可用）
    yield {
      content: "Checking git status...",
      toolName: "shell_exec",
      args: { command: "git status --short 2>/dev/null || echo 'not a git repo'", timeout_ms: 5000 },
    };
  })();
}

/**
 * 创建简单的预lude（单步工具调用）。
 */
export function createSimplePrelude(
  sessionId: string,
  steps: Array<{ content: string; toolName: string; args: Record<string, unknown> }>,
): AsyncGenerator<PreludeStep, void, string | undefined> {
  return (async function* () {
    for (const step of steps) {
      yield step;
    }
  })();
}
