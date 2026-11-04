/**
 * Turn Finalizer — 终末安全网模块
 *
 * 对标 hermes-agent 的 agent/turn_finalizer.py。
 *
 * Hermes 的核心设计哲学：turn 结束不是"模型说了什么就交付什么"，
 * 而是经过多层安全网的后处理——静默停止检测、文件变更 footer、
 * 异常退出说明、流恢复。每一层都是确定性的（不调 LLM），
 * 从工具执行记录中构建结构化说明。
 *
 * EvoClaw 此前缺少这一层。completion-truthfulness.ts 只做"对账"
 * （检测虚假完成声明），不做"合成"（在静默停止时构建可见结束说明）。
 * 这正是 sess_mw23sp1y_e557da27 的场景：模型做完 8 个只读调查后
 * 戛然而止，没有汇报完成状态——因为没有任何结构机制强制它这样做。
 *
 * 三个结构机制：
 *
 * 1. 静默停止检测器（Silent Stop Detector）
 *    当 turn 以工具结果结尾、无后续 assistant 文本时，
 *    从工具执行记录构建一段完成状态摘要。
 *    对标 Hermes turn_finalizer 的 pending-tool-result 检测。
 *
 * 2. 完成状态强制器（Completion Status Enforcer）
 *    当 turn 执行过工具但最终回复不含完成状态标记时，
 *    在回复末尾追加结构化工状态块。
 *    这不是提示词 nudge——它是确定性的后处理，
 *    从 createdFiles/modifiedFiles/successfulToolCalls 构建。
 *
 * 3. 碎片终止守卫（Degenerate Final Guard）
 *    当 turn 做了工具工作后以碎片（≤24 字符、无句末标点）结束时，
 *    注入续跑 nudge 让模型重新产出完整回复。
 *    对标 Hermes turn_final_response 的 looks_like_degenerate_final。
 *
 * 设计原则：
 *   - 纯函数，不调 LLM（确定性后处理）
 *   - 幂等：运行两次结果相同
 *   - 只追加，不删除：绝不从 finalReply 中移除内容
 *   - 失败不阻断：任何异常只记日志，不抛给调用方
 */

// ── 类型定义 ──────────────────────────────────────────────────────────────────

/** 工具执行统计 */
export interface ToolExecutionStats {
  /** 成功执行的工具调用数 */
  successful: number;
  /** 失败执行的工具调用数 */
  failed: number;
  /** 本轮创建的文件路径 */
  createdFiles: string[];
  /** 本轮修改的文件路径 */
  modifiedFiles: string[];
  /** 本轮执行的 shell 命令 */
  executedCommands: string[];
}

/** 对话消息的最小结构（用于静默停止检测） */
export interface ConversationMessageLite {
  role: string;
  content: string | null | undefined;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

/** 静默停止检测结果 */
export interface SilentStopVerdict {
  /** 是否检测到静默停止 */
  isSilentStop: boolean;
  /** 合成的状态摘要（isSilentStop 为 true 时非空） */
  summary: string;
  /** 检测原因 */
  reason: string;
}

/** 完成状态强制结果 */
export interface CompletionStatusVerdict {
  /** 是否追加了状态块 */
  appended: boolean;
  /** 追加后的状态块（appended 为 true 时非空） */
  statusBlock: string;
  /** 检测原因 */
  reason: string;
}

/** 碎片终止检测结果 */
export interface DegenerateFinalVerdict {
  /** 是否检测到碎片终止 */
  isDegenerate: boolean;
  /** 续跑 nudge 内容（isDegenerate 为 true 时非空） */
  nudge: string;
  /** 检测原因 */
  reason: string;
}

/** Turn Finalizer 总结果 */
export interface FinalizerVerdict {
  /** 最终回复（可能经过静默停止合成或状态块追加） */
  finalReply: string;
  /** 是否触发了静默停止合成 */
  silentStopSynthesized: boolean;
  /** 是否追加了完成状态块 */
  completionStatusAppended: boolean;
  /** 是否检测到碎片终止 */
  degenerateFinalDetected: boolean;
  /** 是否需要续跑（碎片终止时为 true） */
  shouldContinue: boolean;
  /** 诊断信息 */
  diagnostics: string[];
}

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** 碎片终止的最大字符数（对标 Hermes STOP_PATH_MIN_CHARS 的补集） */
const DEGENERATE_FINAL_MAX_CHARS = 24;

/** 完成状态标记正则——检测回复是否已包含完成状态汇报 */
const COMPLETION_STATUS_PATTERNS = [
  /✅.*完成/,
  /🔄.*进行中/,
  /❌.*未完成/,
  /任务完成/,
  /完成状态/,
  /交付物/,
  /剩余工作/,
  /完成情况/,
  /progress/i,
  /status.*report/i,
];

/** 文件路径提取正则——从回复文本中提取声称的文件路径 */
const CLAIMED_PATH_PATTERN = /`(?:\/[\w./-]+|[A-Za-z]:[\\/][\w\\/.-]+|[\w/-]+\.[a-zA-Z]{1,5})`/g;

/** 工具调用 ID 前缀——用于识别 assistant 消息中的 tool_calls */
const TOOL_CALL_ID_PREFIX = "call_";

// ── 静默停止检测器 ─────────────────────────────────────────────────────────────

/**
 * 检测静默停止。
 *
 * 触发条件（全部满足）：
 * 1. finalReply 为空或仅为碎片（≤24 字符、无句末标点）
 * 2. conversationMessages 的最后一条是 tool result（role=tool）
 * 3. 最后一条 tool result 之后没有 assistant 文本消息
 * 4. 本轮执行过至少一次工具
 *
 * 这是 sess_mw23sp1y_e557da27 的精确场景：
 * 模型做完 8 个只读调查后，对话以 tool result 结尾，
 * 没有 assistant 文本汇报完成状态。
 *
 * @param conversationMessages 本轮对话消息（含 system/user/assistant/tool）
 * @param finalReply 模型最终回复（可能为空）
 * @param toolStats 工具执行统计
 * @returns 静默停止检测结果
 */
export function detectSilentStop(
  conversationMessages: Array<ConversationMessageLite>,
  finalReply: string,
  toolStats: ToolExecutionStats,
): SilentStopVerdict {
  // 条件 1：finalReply 为空或碎片
  const replyText = (finalReply || "").trim();
  const isReplyEmpty = replyText.length === 0;
  const isReplyFragment =
    replyText.length > 0 &&
    replyText.length <= DEGENERATE_FINAL_MAX_CHARS &&
    !/[。！？.!?]/.test(replyText);

  if (!isReplyEmpty && !isReplyFragment) {
    return {
      isSilentStop: false,
      summary: "",
      reason: `Reply is substantive (${replyText.length} chars)`,
    };
  }

  // 条件 4：本轮执行过工具
  if (toolStats.successful === 0 && toolStats.failed === 0) {
    return {
      isSilentStop: false,
      summary: "",
      reason: "No tools executed this turn",
    };
  }

  // 条件 2+3：最后一条是 tool result，且其后没有 assistant 文本
  let lastMessage: ConversationMessageLite | undefined;
  for (let i = conversationMessages.length - 1; i >= 0; i--) {
    const msg = conversationMessages[i];
    if (msg.role === "assistant" && msg.content && msg.content.trim().length > 0) {
      // 有后续 assistant 文本 → 不是静默停止
      return {
        isSilentStop: false,
        summary: "",
        reason: "Assistant text follows last tool result",
      };
    }
    if (msg.role === "tool") {
      lastMessage = msg;
      break;
    }
    if (msg.role === "assistant" && msg.content && msg.content.trim().length > 0) {
      break;
    }
    // 跳过 system/user 消息继续往前找
  }

  if (!lastMessage || lastMessage.role !== "tool") {
    return {
      isSilentStop: false,
      summary: "",
      reason: "Turn does not end with a tool result",
    };
  }

  // 合成状态摘要
  const summary = synthesizeSilentStopSummary(conversationMessages, toolStats);

  return {
    isSilentStop: true,
    summary,
    reason: "Turn ended with tool result(s) and no assistant text summary",
  };
}

/**
 * 从工具执行记录构建静默停止的合成摘要。
 *
 * 对标 Hermes turn_finalizer 的 pending-tool-result 合成。
 * 不是提示词——是从工具执行状态确定性构建的可见结束说明。
 */
function synthesizeSilentStopSummary(
  _conversationMessages: Array<ConversationMessageLite>,
  toolStats: ToolExecutionStats,
): string {
  const parts: string[] = [];

  parts.push("📋 **任务状态汇报**（系统自动合成——模型在工具执行后未给出文字总结）");

  parts.push(
    `- 工具调用：${toolStats.successful} 次成功` +
      (toolStats.failed > 0 ? `，${toolStats.failed} 次失败` : ""),
  );

  if (toolStats.createdFiles.length > 0) {
    parts.push(`- 已创建文件：${toolStats.createdFiles.slice(0, 5).join("、")}${toolStats.createdFiles.length > 5 ? " 等" : ""}`);
  }
  if (toolStats.modifiedFiles.length > 0) {
    parts.push(`- 已修改文件：${toolStats.modifiedFiles.slice(0, 5).join("、")}${toolStats.modifiedFiles.length > 5 ? " 等" : ""}`);
  }
  if (toolStats.executedCommands.length > 0) {
    parts.push(`- 已执行命令：${toolStats.executedCommands.slice(0, 3).join("、")}${toolStats.executedCommands.length > 3 ? " 等" : ""}`);
  }

  parts.push("- 状态：🔄 进行中（模型未给出最终结论）");
  parts.push("");
  parts.push("如需了解具体进展，请查看上方工具执行记录。如需继续，请发送「继续」。");

  return parts.join("\n");
}

// ── 完成状态强制器 ─────────────────────────────────────────────────────────────

/**
 * 检测回复是否已包含完成状态汇报。
 *
 * 对标 Hermes SOUL.md："finished work gets a short report of what changed,
 * what's verified, and what's left"。
 *
 * 检测：回复文本是否包含完成状态标记（✅完成/🔄进行中/❌未完成/交付物/剩余工作等）。
 */
export function hasCompletionStatusReport(reply: string): boolean {
  const text = reply || "";
  return COMPLETION_STATUS_PATTERNS.some((p) => p.test(text));
}

/**
 * 强制追加完成状态块。
 *
 * 触发条件（全部满足）：
 * 1. 本轮执行过工具（successful + failed > 0）
 * 2. 回复不含完成状态标记
 * 3. 回复非空（空回复由静默停止检测器处理）
 *
 * 动作：在回复末尾追加结构化工状态块。
 * 这不是提示词 nudge——它是确定性的后处理，
 * 从工具执行记录构建，模型无法忽略。
 *
 * @param finalReply 模型最终回复
 * @param toolStats 工具执行统计
 * @returns 完成状态强制结果
 */
export function enforceCompletionStatus(
  finalReply: string,
  toolStats: ToolExecutionStats,
): CompletionStatusVerdict {
  const replyText = (finalReply || "").trim();

  // 条件 3：回复为空 → 由静默停止检测器处理
  if (replyText.length === 0) {
    return {
      appended: false,
      statusBlock: "",
      reason: "Reply is empty (handled by silent stop detector)",
    };
  }

  // 条件 1：本轮执行过工具
  if (toolStats.successful === 0 && toolStats.failed === 0) {
    return {
      appended: false,
      statusBlock: "",
      reason: "No tools executed this turn",
    };
  }

  // 条件 2：回复已包含完成状态标记
  if (hasCompletionStatusReport(replyText)) {
    return {
      appended: false,
      statusBlock: "",
      reason: "Reply already contains completion status report",
    };
  }

  // 构建结构状态块
  const statusBlock = buildCompletionStatusBlock(toolStats);

  return {
    appended: true,
    statusBlock,
    reason: `Tools executed (${toolStats.successful} success) but reply lacks completion status report`,
  };
}

/**
 * 从工具执行记录构建结构化工状态块。
 *
 * 对标 Hermes _append_file_mutation_footer 的设计哲学：
 * "structurally prevents over-claiming past the model"。
 * 这里不是防 over-claiming（那是 completion-truthfulness 的职责），
 * 而是防 under-reporting（模型做了工作但不汇报）。
 */
function buildCompletionStatusBlock(toolStats: ToolExecutionStats): string {
  const parts: string[] = [];
  parts.push("");
  parts.push("---");
  parts.push("📋 **任务状态**（系统自动追加——回复未包含完成状态汇报）");

  parts.push(`- 工具调用：${toolStats.successful} 次成功` + (toolStats.failed > 0 ? `，${toolStats.failed} 次失败` : ""));

  if (toolStats.createdFiles.length > 0) {
    parts.push(`- 创建文件：${toolStats.createdFiles.slice(0, 5).map((p) => `\`${p}\``).join("、")}${toolStats.createdFiles.length > 5 ? " 等" : ""}`);
  }
  if (toolStats.modifiedFiles.length > 0) {
    parts.push(`- 修改文件：${toolStats.modifiedFiles.slice(0, 5).map((p) => `\`${p}\``).join("、")}${toolStats.modifiedFiles.length > 5 ? " 等" : ""}`);
  }
  if (toolStats.executedCommands.length > 0) {
    parts.push(`- 执行命令：${toolStats.executedCommands.slice(0, 3).map((c) => `\`${c}\``).join("、")}${toolStats.executedCommands.length > 3 ? " 等" : ""}`);
  }

  parts.push(`- 状态：✅ 已完成（${toolStats.successful} 次工具调用）`);
  parts.push("");

  return parts.join("\n");
}

// ── 碎片终止守卫 ───────────────────────────────────────────────────────────────

/**
 * 检测碎片终止。
 *
 * 对标 Hermes turn_final_response 的 looks_like_degenerate_final。
 *
 * 触发条件（全部满足）：
 * 1. 本轮执行过工具（toolStats.successful + failed > 0）
 * 2. 最终回复是碎片（≤24 字符、无句末标点）
 * 3. 碎片不是完成状态汇报（如"任务完成"是完成状态，不算碎片）
 *
 * 动作：注入续跑 nudge 让模型重新产出完整回复。
 * 最多 2 次（同 Hermes codex_ack_continuations < 2）。
 *
 * @param finalReply 模型最终回复
 * @param toolStats 工具执行统计
 * @param nudgeAttempts 已尝试的 nudge 次数
 * @param maxAttempts 最大 nudge 次数（默认 2）
 * @returns 碎片终止检测结果
 */
export function detectDegenerateFinal(
  finalReply: string,
  toolStats: ToolExecutionStats,
  nudgeAttempts: number,
  maxAttempts: number = 2,
): DegenerateFinalVerdict {
  const replyText = (finalReply || "").trim();

  // 条件 1：本轮执行过工具
  if (toolStats.successful === 0 && toolStats.failed === 0) {
    return {
      isDegenerate: false,
      nudge: "",
      reason: "No tools executed this turn",
    };
  }

  // 条件 2：碎片判定
  const isFragment =
    replyText.length > 0 &&
    replyText.length <= DEGENERATE_FINAL_MAX_CHARS &&
    !/[。！？.!?]/.test(replyText);

  if (!isFragment) {
    return {
      isDegenerate: false,
      nudge: "",
      reason: `Reply is substantive (${replyText.length} chars)`,
    };
  }

  // 条件 3：碎片是完成状态汇报 → 不算碎片
  if (hasCompletionStatusReport(replyText)) {
    return {
      isDegenerate: false,
      nudge: "",
      reason: `Fragment is a completion status report`,
    };
  }

  // nudge 次数检查
  if (nudgeAttempts >= maxAttempts) {
    return {
      isDegenerate: false,
      nudge: "",
      reason: `Nudge attempts exhausted (${nudgeAttempts}/${maxAttempts})`,
    };
  }

  const nudge =
    "[系统提示] 你已完成了工具执行，但最终回复过于简短（" +
    `"${replyText}"，${replyText.length} 字符），未汇报完成状态。` +
    "请基于已执行的工具结果，用自然语言总结回答用户的问题，" +
    "包括：已完成的工作、交付物（文件路径/变更摘要）、以及剩余工作（如有）。" +
    "直接输出总结，不要调用工具。";

  return {
    isDegenerate: true,
    nudge,
    reason: `Degenerate final: ${replyText.length}-char fragment "${replyText}" ended turn after tool execution`,
  };
}

// ── 综合终末安全网 ──────────────────────────────────────────────────────────────

/**
 * Turn Finalizer 总入口。
 *
 * 执行顺序：
 * 1. 静默停止检测 → 若触发，合成状态摘要作为 finalReply
 * 2. 碎片终止检测 → 若触发，返回 shouldContinue=true（调用方注入 nudge 续跑）
 * 3. 完成状态强制 → 若触发，追加结构状态块
 *
 * 设计原则：
 *   - 纯函数，不调 LLM
 *   - 幂等：运行两次结果相同
 *   - 只追加，不删除
 *   - 失败不阻断：任何异常只记日志
 *
 * @param finalReply 模型最终回复
 * @param conversationMessages 本轮对话消息
 * @param toolStats 工具执行统计
 * @param degenerateNudgeAttempts 碎片终止 nudge 已尝试次数
 * @returns 终末安全网总结果
 */
export function runTurnFinalizer(
  finalReply: string,
  conversationMessages: Array<ConversationMessageLite>,
  toolStats: ToolExecutionStats,
  degenerateNudgeAttempts: number = 0,
): FinalizerVerdict {
  const diagnostics: string[] = [];
  let reply = finalReply || "";
  let silentStopSynthesized = false;
  let completionStatusAppended = false;
  let degenerateFinalDetected = false;
  let shouldContinue = false;

  // 1. 静默停止检测
  try {
    const silentStop = detectSilentStop(conversationMessages, reply, toolStats);
    if (silentStop.isSilentStop) {
      reply = silentStop.summary;
      silentStopSynthesized = true;
      diagnostics.push(`Silent stop detected: ${silentStop.reason}`);
    }
  } catch (err) {
    diagnostics.push(`Silent stop detection failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. 碎片终止检测
  try {
    const degenerate = detectDegenerateFinal(reply, toolStats, degenerateNudgeAttempts);
    if (degenerate.isDegenerate) {
      degenerateFinalDetected = true;
      shouldContinue = true;
      diagnostics.push(`Degenerate final detected: ${degenerate.reason}`);
    }
  } catch (err) {
    diagnostics.push(`Degenerate final detection failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. 完成状态强制（仅在不需要续跑时执行）
  if (!shouldContinue) {
    try {
      const completion = enforceCompletionStatus(reply, toolStats);
      if (completion.appended) {
        reply += completion.statusBlock;
        completionStatusAppended = true;
        diagnostics.push(`Completion status appended: ${completion.reason}`);
      }
    } catch (err) {
      diagnostics.push(`Completion status enforcement failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    finalReply: reply,
    silentStopSynthesized,
    completionStatusAppended,
    degenerateFinalDetected,
    shouldContinue,
    diagnostics,
  };
}
