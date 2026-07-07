// Task analysis and splitting methods for AgentModelExecutor
// Extracted from agent-model-executor.ts for modularity

import type { PersonaConfig } from "@evoclaw/core";
import type { ModelConfig, ProviderConfig, AgentProgressCallback } from "./types";
import type { TaskCheckpoint } from "./task-checkpoint-manager";
import type { PromptMode } from "./system-prompt";
import { taskStatusTracker } from "./task-status-tracker";
import { taskCheckpointManager } from "./task-checkpoint-manager";
import { collapseNewlines as collapseNewlinesImpl } from "./text-processor";
import { hasActionIntent as hasActionIntentFn } from "./quick-reply";

// ── Types ──

/** Conversation history entry type (mirrors the Map value type) */
export interface ConversationHistoryEntry {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

/** Result type for handleMultipleTasks and executeSubtasksFromCheckpoint */
export interface TaskExecutionResult {
  reply: string;
  tokensUsed: number;
  duration: number;
  permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>;
  toolsExecuted: boolean;
  files?: Array<{ path: string; size: number; downloadUrl: string }>;
}

/** Callback signature for callLLMOnce — used by analyzeUserIntent and decomposeTaskWithLLM */
export type CallLLMOnceFn = (
  provider: ProviderConfig,
  messages: Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>,
  tools: Array<{ type: string; function: Record<string, unknown> }>,
  toolChoice: "auto" | "required" | "none",
) => Promise<{ message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }; tokensUsed: number; promptTokens: number } | null>;

/** Callback signature for tryCallLLM — used by handleMultipleTasks and executeSubtasksFromCheckpoint */
export type TryCallLLMFn = (
  message: string,
  systemPrompt: string,
  installedSkills: unknown[],
  providers: ProviderConfig[],
  startTime: number,
  sessionId: string,
  pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }>,
  attachments?: Array<{ name: string; type: string; size: number; data?: string | null }>,
  onProgress?: AgentProgressCallback,
  searchPreDone?: boolean,
  channel?: string,
) => Promise<TaskExecutionResult | null>;

/** Callback for generating chat response (fallback) */
export type GenerateChatResponseFn = (
  message: string,
  msg: string,
  installedSkills: unknown[],
  skillManager: { searchLocalSkills(query: Record<string, unknown>): Promise<unknown[]>; listSkills(): unknown[]; executeSkill(skillId: string, params: Record<string, unknown>): Promise<unknown> } | undefined,
  pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }>,
) => Promise<string>;

/** Callback for building system prompt */
export type BuildSystemPromptFn = (promptMode?: PromptMode, context?: { skillsPrompt?: string; workspacePath?: string; bootstrapFiles?: Array<{ path: string; content: string }>; channel?: string }) => string;

/** Callback for estimating token count */
export type EstimateTokenCountFn = (text: string) => number;

/** Dependencies needed by task analyzer functions */
export interface TaskAnalyzerDeps {
  providers: ProviderConfig[];
  config: ModelConfig;
  persona: PersonaConfig;
  conversationHistory: Map<string, Array<ConversationHistoryEntry>>;
  callLLMOnce: CallLLMOnceFn;
  tryCallLLM: TryCallLLMFn;
  buildSystemPrompt: BuildSystemPromptFn;
  generateChatResponse: GenerateChatResponseFn;
  estimateTokenCount: EstimateTokenCountFn;
  /** Resolve a service from the registry */
  resolveService: <T>(name: string) => T | undefined;
}

// ── Functions ──

/**
 * LLM-driven task understanding: replaces regex-based parseMultipleTasks.
 * Asks the LLM to analyze whether the user's message contains multiple independent tasks,
 * and if so, what those tasks are. Falls back to single-task if LLM is unavailable.
 */
export async function analyzeUserIntent(
  deps: TaskAnalyzerDeps,
  message: string,
  _sessionId: string,
): Promise<string[]> {
  // Quick shortcuts — no LLM needed
  if (!message || message.trim().length < 3) return [message];

  const enabledProviders = deps.providers.filter((p) => p.enabled).sort((a, b) => a.order - b.order);
  if (enabledProviders.length === 0) {
    // No LLM available, fall back to treating as single task
    return [message];
  }

  const analysisPrompt = `You are a task analyzer. Analyze the user's message and determine if it contains multiple independent tasks or a single coherent request.

Rules:
- A "task" is an independent request that can be handled separately from others
- Context, conditions, explanations, and constraints are NOT separate tasks — they are part of the same task
- Questions, reasoning problems, puzzles, and analysis requests are single tasks even if they contain multiple sentences
- Only split if the user explicitly asks for multiple unrelated things (e.g., "do A and also do B" where A and B are independent)

Respond with JSON only:
- If single task: {"tasks": ["<original message>"]}
- If multiple independent tasks: {"tasks": ["<task 1>", "<task 2>", ...]}

User message:
"""
${message}
"""

JSON response:`;

  const provider = enabledProviders[0];
  try {
    const result = await deps.callLLMOnce(
      provider,
      [
        { role: "system", content: "You are a task analyzer. Respond with JSON only. No explanation." },
        { role: "user", content: analysisPrompt },
      ],
      [], // no tools
      "none"
    );

    if (result?.message?.content) {
      const content = result.message.content.trim();
      // Extract JSON from the response (may be wrapped in markdown code block)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
          // Validate: each task should be a non-empty string
          const validTasks = parsed.tasks.filter((t: unknown) => typeof t === "string" && t.trim().length > 0);
          if (validTasks.length > 0) {
            process.stdout.write(`[TaskAnalyzer] LLM task analysis: ${validTasks.length} task(s) detected\n`);
            return validTasks;
          }
        }
      }
    }
  } catch (err) {
    process.stderr.write(`[TaskAnalyzer] LLM task analysis failed, treating as single task: ${err}\n`);
  }

  // Fallback: treat as single task
  return [message];
}

/**
 * LLM-driven task decomposition: replaces regex-based decomposeTaskForAutoSplit.
 * Asks the LLM to break down a complex task into subtasks.
 */
export async function decomposeTaskWithLLM(
  deps: TaskAnalyzerDeps,
  message: string,
  maxSubtasks: number,
): Promise<Array<{ id: string; description: string }>> {
  const enabledProviders = deps.providers.filter((p) => p.enabled).sort((a, b) => a.order - b.order);
  if (enabledProviders.length === 0) {
    // Fallback to simple 3-step decomposition
    return [
      { id: "sub-1", description: "分析需求并设计方案" },
      { id: "sub-2", description: "实现核心功能" },
      { id: "sub-3", description: "测试验证和完善" },
    ];
  }

  const decompPrompt = `You are a task decomposition expert. Break down the following task into ${maxSubtasks} or fewer concrete, actionable subtasks.

Rules:
- Each subtask should be a specific, executable step
- Subtasks should be ordered logically (dependencies first)
- Each subtask should be completable independently
- Use the same language as the user's message

Respond with JSON only:
{"subtasks": [{"id": "sub-1", "description": "..."}, {"id": "sub-2", "description": "..."}, ...]}

Task:
"""
${message}
"""

JSON response:`;

  const provider = enabledProviders[0];
  try {
    const result = await deps.callLLMOnce(
      provider,
      [
        { role: "system", content: "You are a task decomposition expert. Respond with JSON only. No explanation." },
        { role: "user", content: decompPrompt },
      ],
      [],
      "none"
    );

    if (result?.message?.content) {
      const content = result.message.content.trim();
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.subtasks) && parsed.subtasks.length > 0) {
          return parsed.subtasks.slice(0, maxSubtasks).map((s: Record<string, unknown>, i: number) => ({
            id: (s.id as string) || `sub-${i + 1}`,
            description: (s.description as string) || String(s),
          }));
        }
      }
    }
  } catch (err) {
    process.stderr.write(`[TaskAnalyzer] LLM task decomposition failed, using fallback: ${err}\n`);
  }

  // Fallback
  return [
    { id: "sub-1", description: "分析需求并设计方案" },
    { id: "sub-2", description: "实现核心功能" },
    { id: "sub-3", description: "测试验证和完善" },
  ];
}

/**
 * Regex-based multi-task parsing.
 * Splits a user message into multiple independent tasks based on punctuation and conjunctions.
 */
export function parseMultipleTasks(message: string): string[] {
  const tasks: string[] = [];

  // If the message contains a URL, don't split it — the URL is part of the same task
  if (/https?:\/\/[^\s<>"']+/i.test(message)) {
    return [message];
  }

  // Don't split logic puzzles, riddles, or reasoning problems — they are single coherent tasks
  // even though they may contain multiple sentences with periods
  const puzzleIndicators = /(?:过河|推理|逻辑|谜题|智力题|脑筋急转弯|数学题|证明|假设|如果.*那么|当.*时|只能|规则如下|条件是|请给出.*方案|请解释|请分析|river.crossing|puzzle|riddle|logic|prove|assuming|if.*then|given.*find)/i;
  if (puzzleIndicators.test(message)) {
    return [message];
  }

  const isShortFollowup = (s: string): boolean => {
    return /^(帮我|给我|请帮我|麻烦|请问|你帮我|能帮我).{0,8}$/.test(s.trim());
  };

  const isQuestionOnly = (s: string): boolean => {
    const trimmed = s.trim();
    return /^(什么|怎么|如何|为什么|哪|几|多少|是不是|能不能|可以|吗|呢|谁|何时|哪里)/.test(trimmed)
      || /^(what|how|why|when|where|who|which|is|can|do|does|are)/i.test(trimmed);
  };

  let remaining = message.trim();

  // Split on Chinese period/exclamation only (NOT question marks — they indicate
  // conversational questions, not separate tasks)
  const separators = [/[。！]/g];

  for (const sep of separators) {
    const parts = remaining.split(sep).filter(p => p.trim().length > 2);
    if (parts.length > 1) {
      const realTasks = parts.map(p => p.trim()).filter(p => !isShortFollowup(p) && !isQuestionOnly(p));
      return realTasks.length >= 2 ? realTasks : [message];
    }
  }

  // Also split on double-newline (explicit paragraph separators)
  const paragraphs = remaining.split(/\n\s*\n/).filter(p => p.trim().length > 2);
  if (paragraphs.length > 1) {
    return paragraphs.map(p => p.trim());
  }

  const conjunctionPatterns = [
    /(同时|并且|然后|接着|还要|另外|也请)/g,
    /(and|also|then|next)/gi
  ];

  const conjunctionWords = new Set(["and", "also", "then", "next", "同时", "并且", "然后", "接着", "还要", "另外", "也请"]);

  for (const pattern of conjunctionPatterns) {
    if (pattern.test(message)) {
      // Don't split if conjunction is inside quotes (e.g. book titles like "Pride and Prejudice" or 《War and Peace》)
      const quotedConjunctions = message.match(/["'""「」『』《》][^"'"\n「」『』《》]*?(?:and|also|then|next|同时|并且|然后|接着|还要|另外|也请)[^"'"\n「」『』《》]*?["'""「」『』《》]/gi);
      if (quotedConjunctions && quotedConjunctions.length > 0) {
        continue; // Skip splitting — conjunction is part of a quoted title
      }
      const parts = message.split(pattern);
      for (const part of parts) {
        const trimmed = part.trim();
        // Skip parts that are just the conjunction word itself
        if (trimmed && trimmed.length > 2 && !conjunctionWords.has(trimmed.toLowerCase())) {
          tasks.push(trimmed);
        }
      }
      if (tasks.length > 1) return tasks;
    }
  }

  return [message];
}

/**
 * Sequential execution of multiple tasks detected from a single user message.
 */
export async function handleMultipleTasks(
  deps: TaskAnalyzerDeps,
  tasks: string[],
  sessionId: string,
  pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }>,
  startTime: number,
  attachments?: Array<{ name: string; type: string; size: number; data?: string | null }>,
  onProgress?: AgentProgressCallback,
  channel?: string,
): Promise<TaskExecutionResult> {
  const results: string[] = [];
  let totalTokens = 0;

  results.push(`检测到您有 ${tasks.length} 个任务需要处理，我将依次为您执行：`);

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    results.push(`\n--- 任务 ${i + 1}：${task} ---`);

    const systemPrompt = deps.buildSystemPrompt(undefined, { channel });
    const skillManager = deps.resolveService<{
      searchLocalSkills(query: Record<string, unknown>): Promise<unknown[]>;
      listSkills(): unknown[];
      executeSkill(skillId: string, params: Record<string, unknown>): Promise<unknown>;
    }>("skillManager");
    const installedSkills = await skillManager?.listSkills() || [];
    const enabledProviders = deps.providers.filter((p) => p.enabled).sort((a, b) => a.order - b.order);

    let taskResult: string = "";
    let tokensUsed = 0;

    if (enabledProviders.length > 0) {
      const result = await deps.tryCallLLM(task, systemPrompt, installedSkills, enabledProviders, startTime, sessionId, pendingPermissions, attachments, onProgress, false, channel);
      if (result) {
        taskResult = result.reply;
        tokensUsed = result.tokensUsed;
        if (!result.toolsExecuted && hasActionIntentFn(task)) {
          const msg = task.toLowerCase();
          const fallback = await deps.generateChatResponse(task, msg, installedSkills, skillManager, pendingPermissions);
          taskResult = result.reply + "\n\n" + fallback;
        }
      }
    }

    if (!taskResult) {
      const msg = task.toLowerCase();
      taskResult = await deps.generateChatResponse(task, msg, installedSkills, skillManager, pendingPermissions);
      tokensUsed = deps.estimateTokenCount(systemPrompt + task + taskResult);
    }

    totalTokens += tokensUsed;
    results.push(taskResult);
  }

  results.push(`\n--- 所有任务处理完成 ---`);
  results.push(`共完成 ${tasks.length} 个任务，耗时 ${Math.floor((Date.now() - startTime) / 1000)} 秒。`);

  return {
    reply: results.join("\n"),
    tokensUsed: totalTokens,
    duration: Date.now() - startTime,
    permissionRequests: [...pendingPermissions],
    toolsExecuted: true,
  };
}

/**
 * Pattern-based task splitting for auto-split.
 * Uses coding pattern heuristics to decompose a task into phases.
 */
export function decomposeTaskForAutoSplit(message: string, maxSubtasks: number): Array<{ id: string; description: string }> {
  const subtasks: Array<{ id: string; description: string }> = [];
  const lower = message.toLowerCase();

  const codingPatterns: Array<{ test: RegExp; phases: string[] }> = [
    {
      test: /实现|implement|编写|write|开发|develop|创建.*类|create.*class/i,
      phases: ["设计数据结构和接口定义", "实现核心逻辑和算法", "编写错误处理和边界检查", "添加单元测试"],
    },
    {
      test: /算法|algorithm|排序|sort|搜索|search|图|graph/i,
      phases: ["分析算法需求和时间复杂度要求", "实现核心算法逻辑", "处理边界情况和异常", "编写测试用例验证正确性"],
    },
    {
      test: /API|接口|服务|server|路由|route/i,
      phases: ["定义API接口和数据模型", "实现核心路由和业务逻辑", "添加中间件和错误处理", "编写API测试"],
    },
    {
      test: /重构|refactor|优化|optimize|改进|improve/i,
      phases: ["分析现有代码识别问题", "制定重构方案", "逐步实施重构", "验证重构后功能正确性"],
    },
    {
      test: /调试|debug|修复|fix|排错|troubleshoot/i,
      phases: ["复现问题并收集错误信息", "定位问题根因", "实施修复方案", "验证修复效果并添加回归测试"],
    },
  ];

  let matchedPhases: string[] | null = null;
  for (const pattern of codingPatterns) {
    if (pattern.test.test(lower)) {
      matchedPhases = pattern.phases;
      break;
    }
  }

  if (!matchedPhases) {
    if (lower.includes("测试") || lower.includes("test")) {
      matchedPhases = ["分析测试需求和覆盖范围", "编写核心测试用例", "添加边界和异常测试", "运行测试并验证结果"];
    } else if (lower.length > 200 || lower.split("\n").length > 10) {
      matchedPhases = ["分析需求并设计方案", "实现第一部分功能", "实现第二部分功能", "整合测试和验证"];
    } else {
      matchedPhases = ["分析需求并设计方案", "实现核心功能", "测试验证和完善"];
    }
  }

  const selectedPhases = matchedPhases.slice(0, maxSubtasks);
  for (let i = 0; i < selectedPhases.length; i++) {
    subtasks.push({
      id: `sub-${i + 1}`,
      description: selectedPhases[i],
    });
  }

  return subtasks;
}

/**
 * Execute subtasks from checkpoint with retry logic.
 * Uses a chatFn callback for LLM interaction instead of calling this.chat() directly.
 */
export async function executeSubtasksFromCheckpoint(
  deps: TaskAnalyzerDeps,
  checkpoint: TaskCheckpoint,
  sessionId: string,
  pendingPermissions: Array<{ id: string; operation: string; description: string; target: string }>,
  startTime: number,
  attachments: Array<{ name: string; type: string; size: number; data?: string | null }> | undefined,
  onProgress?: AgentProgressCallback,
  channel?: string,
): Promise<TaskExecutionResult | null> {
  const subtaskResults: string[] = [];
  let totalTokensUsed = 0;
  const allFiles: Array<{ path: string; size: number; downloadUrl: string }> = [];
  let failedCount = 0;

  const systemPrompt = deps.buildSystemPrompt(undefined, { channel });

  const skillManager = deps.resolveService<{
    searchLocalSkills(query: Record<string, unknown>): Promise<unknown[]>;
    listSkills(): unknown[];
    executeSkill(skillId: string, params: Record<string, unknown>): Promise<unknown>;
  }>("skillManager");
  const installedSkills = await skillManager?.listSkills() || [];
  const enabledProviders = deps.providers.filter((p) => p.enabled).sort((a, b) => a.order - b.order);

  if (enabledProviders.length === 0) {
    return null;
  }

  const completedContext = checkpoint.subtasks
    .filter(s => s.status === "completed" && s.result)
    .map(s => `### ${s.description}\n${s.result}`)
    .join("\n\n");

  for (let i = 0; i < checkpoint.subtasks.length; i++) {
    const subtask = checkpoint.subtasks[i];
    if (subtask.status === "completed") {
      subtaskResults.push(`✅ **${subtask.description}**: 已完成`);
      continue;
    }

    const baseProgress = checkpoint.totalSubtasks > 0 ? 20 + Math.floor((i / checkpoint.totalSubtasks) * 70) : 20;
    taskStatusTracker.set(sessionId, "subtask_executing", `执行子任务 ${i + 1}/${checkpoint.totalSubtasks}: ${subtask.description}`, baseProgress, i, checkpoint.totalSubtasks, subtask.description);
    onProgress?.({ type: "subtask_start", phase: "subtask_executing", detail: `开始子任务 ${i + 1}/${checkpoint.totalSubtasks}: ${subtask.description}`, progress: baseProgress, subtaskIndex: i, subtaskTotal: checkpoint.totalSubtasks });

    const subtaskPrompt = completedContext
      ? `${checkpoint.originalMessage}\n\n## 已完成的子任务结果\n\n${completedContext}\n\n## 当前子任务\n请完成以下子任务: ${subtask.description}\n\n注意：这是拆分后的子任务之一，请专注于完成当前子任务，不要重复已完成的工作。`
      : `${checkpoint.originalMessage}\n\n请完成以下子任务: ${subtask.description}\n\n注意：这是拆分后的子任务之一，请专注于完成当前子任务。`;

    const SUBTASK_TIMEOUT = 300_000;
    let subtaskResult: string | null = null;
    let subtaskTokens = 0;

    try {
      const resultPromise = deps.tryCallLLM(
        subtaskPrompt, systemPrompt, installedSkills, enabledProviders,
        startTime, sessionId, pendingPermissions, attachments, onProgress, false, channel
      );
      resultPromise.catch(() => {}); // 防止超时后 unhandledRejection
      let subtaskTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<null>((resolve) => {
        subtaskTimeoutHandle = setTimeout(() => resolve(null), SUBTASK_TIMEOUT);
        if (subtaskTimeoutHandle.unref) subtaskTimeoutHandle.unref();
      });
      try {
        const result = await Promise.race([resultPromise, timeoutPromise]);
        if (result) {
          subtaskResult = result.reply;
          subtaskTokens = result.tokensUsed;
          if (result.files) allFiles.push(...result.files);
        }
      } finally {
        if (subtaskTimeoutHandle) clearTimeout(subtaskTimeoutHandle);
      }
    } catch (err) {
      process.stderr.write(`[TaskAnalyzer] Subtask "${subtask.description}" failed:` + " " + err + "\n");
    }

    if (subtaskResult) {
      taskCheckpointManager.updateSubtask(sessionId, subtask.id, "completed", subtaskResult.slice(0, 2000));
      subtaskResults.push(`✅ **${subtask.description}**:\n${subtaskResult}`);
      totalTokensUsed += subtaskTokens;
      onProgress?.({ type: "subtask_done", phase: "subtask_executing", detail: `子任务 ${i + 1} 完成: ${subtask.description}`, progress: baseProgress + Math.floor(70 / checkpoint.totalSubtasks) });
    } else {
      let retryCount = 0;
      let retrySucceeded = false;
      while (retryCount < 2) {
        retryCount++;
        process.stdout.write(`[TaskAnalyzer] Retrying subtask "${subtask.description}" (attempt ${retryCount + 1})\n`);
        try {
          const retryPromise = deps.tryCallLLM(
            subtaskPrompt, systemPrompt, installedSkills, enabledProviders,
            startTime, sessionId, pendingPermissions, attachments, onProgress, false, channel
          );
          retryPromise.catch(() => {}); // 防止超时后 unhandledRejection
          let retryTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const retryTimeoutPromise = new Promise<null>((resolve) => {
            retryTimeoutHandle = setTimeout(() => resolve(null), SUBTASK_TIMEOUT);
            if (retryTimeoutHandle.unref) retryTimeoutHandle.unref();
          });
          try {
            const retryResult = await Promise.race([retryPromise, retryTimeoutPromise]);
            if (retryResult) {
              taskCheckpointManager.updateSubtask(sessionId, subtask.id, "completed", retryResult.reply.slice(0, 2000));
              subtaskResults.push(`✅ **${subtask.description}** (重试成功):\n${retryResult.reply}`);
              totalTokensUsed += retryResult.tokensUsed;
              if (retryResult.files) allFiles.push(...retryResult.files);
              onProgress?.({ type: "subtask_done", phase: "subtask_executing", detail: `子任务 ${i + 1} 重试成功: ${subtask.description}`, progress: baseProgress + Math.floor(70 / checkpoint.totalSubtasks) });
              retrySucceeded = true;
              break;
            }
          } finally {
            if (retryTimeoutHandle) clearTimeout(retryTimeoutHandle);
          }
        } catch (retryErr) {
          process.stderr.write(`[TaskAnalyzer] Subtask retry failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}\n`);
        }
      }

      if (!retrySucceeded) {
        taskCheckpointManager.updateSubtask(sessionId, subtask.id, "failed", undefined, "Subtask execution failed after retry");
        subtaskResults.push(`❌ **${subtask.description}**: 执行失败（已重试）`);
        failedCount++;
        onProgress?.({ type: "subtask_error", phase: "subtask_executing", detail: `子任务 ${i + 1} 失败: ${subtask.description}`, progress: baseProgress });
      }
    }
  }

  const finalProgress = failedCount === 0 ? 100 : (checkpoint.totalSubtasks > 0 ? Math.floor((checkpoint.totalSubtasks - failedCount) / checkpoint.totalSubtasks * 100) : 0);
  taskStatusTracker.set(sessionId, "done", `所有子任务执行完成 (${checkpoint.totalSubtasks - failedCount}/${checkpoint.totalSubtasks} 成功)`, finalProgress);

  const summaryHeader = failedCount === 0
    ? `🎉 所有 ${checkpoint.totalSubtasks} 个子任务已成功完成！`
    : `⚠️ ${checkpoint.totalSubtasks - failedCount}/${checkpoint.totalSubtasks} 个子任务完成，${failedCount} 个失败。`;

  // When some subtasks failed, append alternative suggestions
  const failureFooter = failedCount > 0
    ? `\n\n---\n💡 **替代方案建议：**\n① 尝试单独重新执行失败的任务，可能只是临时故障\n② 简化任务描述后重试，避免过于复杂的指令\n③ 如果是网络/下载相关任务，检查网络连接后重试\n④ 提供更多上下文信息，帮助我更准确地完成任务\n\n需要我帮您重新尝试失败的任务吗？`
    : "";

  const reply = `${summaryHeader}\n\n${subtaskResults.join("\n\n")}${failureFooter}\n\n---\n📊 总耗时: ${Math.floor((Date.now() - startTime) / 1000)}秒 | Token使用: ${totalTokensUsed}`;

  return {
    reply: collapseNewlinesImpl(reply),
    tokensUsed: totalTokensUsed,
    duration: Date.now() - startTime,
    permissionRequests: [...pendingPermissions],
    toolsExecuted: true,
    files: allFiles,
  };
}

/**
 * Dynamic tool call limit computation.
 * Adjusts the maximum number of tool rounds based on message complexity.
 */
export function computeDynamicToolLimit(
  deps: TaskAnalyzerDeps,
  message: string,
  baseLimit: number,
  cap: number,
  sessionId: string,
): number {
  const lower = message.toLowerCase();
  let limit = baseLimit;

  const complexPatterns = [
    /搜索.*新闻|search.*news/i,
    /整理.*报告|compile.*report/i,
    /分析.*代码|analyze.*code/i,
    /调试|debug/i,
    /部署|deploy/i,
    /重构|refactor/i,
    /批量|batch/i,
    /对比.*分析|comparative.*analysis/i,
    /多步|multi.?step/i,
    /完整.*流程|complete.*workflow/i,
  ];
  const veryComplexPatterns = [
    /搜索.*整理.*报告/i,
    /分析.*修复.*测试/i,
    /调研.*对比.*建议/i,
    /全面.*分析.*方案/i,
    /帮我.*搜索.*github/i,
    /本周.*重大.*新闻/i,
  ];

  if (veryComplexPatterns.some(p => p.test(lower))) {
    limit = Math.min(cap, baseLimit + 20);
  } else if (complexPatterns.some(p => p.test(lower))) {
    limit = Math.min(cap, baseLimit + 10);
  }

  if (hasActionIntentFn(message)) {
    limit = Math.min(cap, limit + 5);
  }

  const sessionHistory = deps.conversationHistory.get(sessionId) || [];
  if (sessionHistory.length > 20) {
    limit = Math.max(baseLimit, limit - 5);
  }

  return Math.min(cap, limit);
}
