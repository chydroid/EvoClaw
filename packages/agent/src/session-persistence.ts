// Session persistence and compaction for AgentModelExecutor
// Extracted from agent-model-executor.ts for modularity

import * as fs from "fs";
import * as path from "path";
import type { MemoryEntry, MemorySearchQuery, MemorySearchResult, PluginManager } from "@evoclaw/core";
import { estimateMessagesTokens } from "./error-classifier";
import { redactContent, redactMetadata } from "./transcript-redactor";
import type { CompactionManager } from "./compaction-manager";
import type { AgentLifecycleManager } from "./agent-lifecycle";
import type { SessionManager } from "./session-manager";
import { shouldIdleCompact, idleFloorTokens, type IdleCompactionTracker } from "./idle-compaction";
import { anchoredContextTokens, type UsageAnchor } from "./usage-anchor";
import { takePreparedSummary, discardPreparedCompaction } from "./prepared-compaction";

/**
 * R11 GAP-1：usage anchor 会话注册表（module-level Map）。
 * llm-caller 捕获锚 → 此处存；needsCompaction / estimateRequestTokens 消费；
 * compactConversationHistory 压缩成功 → 清锚（前缀改写，指纹必然失配）。
 * 与 conversationHistory 同生命周期（内存态，进程重启自然失效回退估算）。
 */
const usageAnchors = new Map<string, UsageAnchor>();

/**
 * R11 GAP-4：落盘静默失败记账（hermes fail-closed 语义的最小对位）。
 *
 * hermes conversation_compression_checkpoint.py：压缩前 fail-closed 门——必需的
 * 预压缩 checkpoint 不可用时，压缩**拒绝执行**（BLOCKED_MISSING_PREREQUISITE），
 * 会话停下而不是无损上下文被压缩掉。
 *
 * EvoClaw 前提实证（与 hermes 的差异）：JSONL 持久层是 append-only（persistSessionTurn /
 * persistToolExecutionCheckpoint），压缩只重写内存 conversationHistory——天然就是
 * 「checkpoint 先于压缩存在」的架构。但三个 persist 函数的写入失败是**静默吞掉**
 * （只写 stderr）：落盘坏了 → 内存照常累积 → 压缩照常重写内存 → 未归档上下文
 * 真丢。这里用落盘失败计数做轻量门禁：persistSessionTurn / persistToolExecutionCheckpoint
 * 失败时按会话记账；compactConversationHistory 执行前发现「落盘已坏且从未成功
 * 恢复过」→ 拒绝压缩（fail-closed），宁可不压缩也不丢未归档上下文。stderr 里的
 * 修复提示给运维一条明确恢复路径（与 hermes _CHECKPOINT_REQUIRED_REMEDIATION 同语义）。
 */
const persistFailureCounts = new Map<string, number>();

function recordPersistFailure(sessionId: string): void {
  persistFailureCounts.set(sessionId, (persistFailureCounts.get(sessionId) ?? 0) + 1);
}

export function getUsageAnchorRegistry(): {
  get(sessionId: string): UsageAnchor | undefined;
  set(sessionId: string, anchor: UsageAnchor | null): void;
  clear(sessionId: string): void;
} {
  return {
    get: (sessionId) => usageAnchors.get(sessionId),
    set: (sessionId, anchor) => {
      if (anchor) usageAnchors.set(sessionId, anchor);
      else usageAnchors.delete(sessionId);
    },
    clear: (sessionId) => usageAnchors.delete(sessionId),
  };
}

/** Conversation history entry type */
export interface SessionHistoryEntry {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

/** Memory hub interface for session persistence */
export interface SessionMemoryHub {
  getLongTerm(): {
    store(entry: MemoryEntry): Promise<MemoryEntry>;
    search(query: MemorySearchQuery): Promise<MemorySearchResult[]>;
  };
}

/** Dependencies needed by session persistence functions */
export interface SessionPersistenceDeps {
  sessionDataDir: string;
  sessionPersistenceEnabled: boolean;
  autoCompactionEnabled: boolean;
  compactionTokenThreshold: number;
  conversationHistory: Map<string, Array<SessionHistoryEntry>>;
  compactionManager: CompactionManager | null;
  lifecycleManager: AgentLifecycleManager | null;
  sessionManager: SessionManager | null;
  memoryHub: SessionMemoryHub | null;
  /**
   * LLM 摘要生成器（可选）。
   * 对标 Hermes ContextCompressor._generate_summary：用辅助 LLM 生成结构化摘要，
   * 而非规则提取。定义 buildLLMSummaryPrompt 但此前从未调用（死代码），现接入活路径。
   * 调用方传入 (prompt) => Promise<string>，compactConversationHistory 在
   * compactionManager 可用时优先使用 LLM 摘要，失败则回退规则提取。
   */
  llmSummarizer?: (prompt: string) => Promise<string>;
  /**
   * 空闲触发压缩阈值（秒）。0/未设置 = 关闭（默认）。
   * 对标 hermes `compression.idle_compact_after_seconds` 的 opt-in 语义。
   */
  idleCompactAfterSeconds?: number;
  /** 空闲触发压缩的会话级活动/产出追踪器。 */
  idleCompactionTracker?: import("./idle-compaction").IdleCompactionTracker;
  /**
   * R11 GAP-23：todo 快照提供器（压缩后重注入）。
   * 对标 hermes _fold_todo_snapshot：返回 formatForInjection() 渲染的活跃
   * todo 列表（无活跃项 → null 不注入）。TodoStore 实例在工具层
   * （apps/server tools/todo-tools.ts），packages/agent 经此回调解耦。
   */
  todoSnapshotProvider?: (sessionId: string) => string | null;
  /**
   * ★ 2026-11-23 P2 接线：插件管理器。compactConversationHistory 在压缩前后
   *   分别派发 before_compaction / after_compaction 钩子（Memory Enhancer
   *   借此在压缩前落盘会话洞察）。未提供则零开销（此前零派发点）。
   */
  pluginManager?: PluginManager | null;
  /** 压缩触发原因（钩子载荷）：auto=token 超限，manual=斜杠命令，byte_guard=字节守卫。 */
  compactionReason?: "auto" | "manual" | "overflow" | "byte_guard";
}

/** Compute the file path for a session's JSONL persistence file */
export function sessionFilePath(deps: SessionPersistenceDeps, sessionId: string): string {
  if (!fs.existsSync(deps.sessionDataDir)) {
    fs.mkdirSync(deps.sessionDataDir, { recursive: true });
  }
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(deps.sessionDataDir, `${safeId}.jsonl`);
  if (!path.resolve(filePath).startsWith(path.resolve(deps.sessionDataDir))) {
    throw new Error("Invalid session ID: path traversal detected");
  }
  return filePath;
}

/** Persist a single conversation turn to the session file */
export function persistSessionTurn(
  deps: SessionPersistenceDeps,
  sessionId: string,
  role: string,
  content: string | null,
  metadata?: Record<string, unknown>,
): void {
  if (!deps.sessionPersistenceEnabled) return;
  try {
    const filePath = sessionFilePath(deps, sessionId);
    // fix-3: 保留 tool_calls / tool_call_id / name 字段，支持工具消息持久化
    // 安全：落盘前脱敏，防止授权码/密码/token 明文写入 session JSONL
    const entry = JSON.stringify({
      role,
      content: redactContent(content),
      timestamp: new Date().toISOString(),
      ...(redactMetadata(metadata) || {}),
    });
    fs.appendFileSync(filePath, entry + "\n", "utf-8");
    // R11 GAP-4：落盘成功 → 清本会话失败计数（恢复后压缩门自动重新放行）。
    persistFailureCounts.delete(sessionId);
  } catch (err) {
    recordPersistFailure(sessionId);
    process.stderr.write(`[SessionPersistence] Failed to persist session turn: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ── fix-3: 工具执行增量持久化（防止崩溃丢失进度） ──

/**
 * 工具执行检查点持久化选项
 */
export interface ToolCheckpointMetadata {
  /** 工具调用 ID */
  tool_call_id?: string;
  /** 工具名称 */
  name?: string;
  /** assistant 消息的 tool_calls 数组 */
  tool_calls?: SessionHistoryEntry["tool_calls"];
  /** token 使用量 */
  tokensUsed?: number;
  /** 当前工具执行轮次 */
  round?: number;
}

/**
 * 持久化工具执行检查点。
 *
 * 在每个工具执行轮次后调用，将 assistant 消息（含 tool_calls）和工具响应消息
 * 追加到 session JSONL 文件。这样即使进程崩溃，下次启动时可通过 loadSessionHistory
 * 恢复到最后一个检查点，避免丢失已完成的工具执行进度。
 *
 * 借鉴 hermes-agent 的增量 session 持久化（每个工具结果后刷盘）。
 *
 * @param role 消息角色（assistant/tool）
 * @param content 消息内容
 * @param metadata 工具相关元数据
 */
export function persistToolExecutionCheckpoint(
  deps: SessionPersistenceDeps,
  sessionId: string,
  role: string,
  content: string | null,
  metadata?: ToolCheckpointMetadata,
): void {
  if (!deps.sessionPersistenceEnabled) return;
  try {
    const filePath = sessionFilePath(deps, sessionId);
    // 安全：工具调用参数（含 password/授权码）落盘前脱敏
    const entry = JSON.stringify({
      role,
      content: redactContent(content),
      timestamp: new Date().toISOString(),
      ...(redactMetadata(metadata) || {}),
    });
    fs.appendFileSync(filePath, entry + "\n", "utf-8");
    persistFailureCounts.delete(sessionId); // GAP-4：落盘恢复 → 清失败计数
  } catch (err) {
    recordPersistFailure(sessionId);
    process.stderr.write(`[SessionPersistence] Failed to persist tool checkpoint: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/** Persist a conversation turn for early-return paths (skill install, config query, etc.) */
export function persistEarlyReturn(
  deps: SessionPersistenceDeps,
  sessionId: string,
  userMessage: string,
  assistantReply: string,
): void {
  if (!sessionId || !assistantReply) return;
  // Persist via SessionManager (primary)
  // Note: user turn was already persisted at chat() entry, so only persist assistant turn
  if (deps.sessionManager) {
    try {
      const agentId = "default";
      deps.sessionManager.getOrCreateSession(agentId, sessionId);
      deps.sessionManager.appendTurn(agentId, sessionId, {
        turnIndex: 0, role: "assistant", content: assistantReply, timestamp: new Date().toISOString(),
      });
    } catch (err) {
      process.stderr.write(`[SessionPersistence] persistEarlyReturn SessionManager failed: ${err}\n`);
    }
  }
  // Also persist via legacy file-based method (assistant only — user was persisted early)
  persistSessionTurn(deps, sessionId, "assistant", assistantReply);
  // Update in-memory conversation history
  const history = deps.conversationHistory.get(sessionId) || [];
  history.push({ role: "user", content: userMessage });
  history.push({ role: "assistant", content: assistantReply });
  deps.conversationHistory.set(sessionId, history);
}

/** Load session history from the JSONL persistence file */
export function loadSessionHistory(
  deps: SessionPersistenceDeps,
  sessionId: string,
): Array<{ role: string; content: string | null }> {
  if (!deps.sessionPersistenceEnabled) return [];
  try {
    const filePath = sessionFilePath(deps, sessionId);
    if (!fs.existsSync(filePath)) return [];
    const data = fs.readFileSync(filePath, "utf-8");
    const lines = data.split("\n").filter((l) => l.trim());
    return lines.map((line) => {
      try {
        const entry = JSON.parse(line);
        // fix-3: 保留 tool_calls / tool_call_id / name 字段，
        // 使崩溃恢复后能重建完整的工具调用序列。
        // 注意：返回类型声明为 { role, content } 但实际包含额外字段，
        // 调用方（如 closeInterruptedToolSequence）通过 SessionHistoryEntry 访问。
        return {
          role: entry.role,
          content: entry.content,
          ...(entry.tool_calls ? { tool_calls: entry.tool_calls } : {}),
          ...(entry.tool_call_id ? { tool_call_id: entry.tool_call_id } : {}),
          ...(entry.name ? { name: entry.name } : {}),
        };
      } catch {
        return null; // skip malformed JSON lines in session history
      }
    }).filter((entry): entry is { role: string; content: string | null } => entry !== null);
  } catch (err) {
    process.stderr.write(`[SessionPersistence] Failed to load session history: ${err instanceof Error ? err.message : String(err)}\n`);
    return [];
  }
}

// ── fix-2: 中断后孤儿 tool_call 清理（对齐 hermes close_interrupted_tool_sequence） ──

/**
 * 检测并修复中断的 tool_call 序列。
 *
 * 当 LLM 流式响应中途中断（网络错误/超时/用户 abort）时，assistant 消息可能
 * 包含 tool_calls 但没有对应的 tool response 消息跟随。下一轮发送给 provider
 * 时会返回 400 错误："messages must end with a tool message after a tool_call"。
 *
 * 此函数扫描历史末尾的 assistant 消息，如果发现 tool_calls 缺失对应的 tool
 * response，则追加合成的 tool 消息（content 标注中断），使序列闭合。
 *
 * 等价于 hermes-agent 的 close_interrupted_tool_sequence。
 *
 * @returns 追加的合成消息数量（0 表示无需修复）
 */
export function closeInterruptedToolSequence(
  deps: SessionPersistenceDeps,
  sessionId: string,
): number {
  const history = deps.conversationHistory.get(sessionId);
  if (!history || history.length === 0) return 0;

  // 找到最后一条 assistant 消息（可能带 tool_calls）
  let lastAssistantIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
    // 如果遇到 user 消息，说明序列已闭合（user 发了新消息），无需修复
    if (history[i].role === "user") return 0;
  }
  if (lastAssistantIdx === -1) return 0;

  const lastAssistant = history[lastAssistantIdx];
  const toolCalls = lastAssistant.tool_calls;
  if (!toolCalls || toolCalls.length === 0) return 0;

  // 收集该 assistant 消息之后所有 tool response 的 tool_call_id
  const respondedIds = new Set<string>();
  for (let i = lastAssistantIdx + 1; i < history.length; i++) {
    const entry = history[i];
    if (entry.role === "tool" && entry.tool_call_id) {
      respondedIds.add(entry.tool_call_id);
    }
  }

  // 找出缺失 response 的 tool_call
  const orphanCalls = toolCalls.filter((tc) => !respondedIds.has(tc.id));
  if (orphanCalls.length === 0) return 0;

  // 追加合成 tool response 消息使序列闭合
  const syntheticMessages: SessionHistoryEntry[] = orphanCalls.map((tc) => ({
    role: "tool",
    tool_call_id: tc.id,
    name: tc.function?.name || "unknown",
    content: JSON.stringify({
      error: "interrupted",
      reason: "Tool call was interrupted before completion (stream aborted or timed out).",
      timestamp: Date.now(),
    }),
  }));

  history.push(...syntheticMessages);

  process.stderr.write(
    `[SessionPersistence] Closed ${syntheticMessages.length} interrupted tool_call(s) for session "${sessionId}"\n`,
  );

  return syntheticMessages.length;
}

/** Check if a session's conversation history needs compaction */
export function needsCompaction(
  deps: SessionPersistenceDeps,
  sessionId: string,
  systemPrompt: string,
  maxTokens: number,
): boolean {
  if (!deps.autoCompactionEnabled) return false;
  const history = deps.conversationHistory.get(sessionId) || [];
  // R11 GAP-1（usage anchor）：provider 真实 prompt_tokens 优先——锚绑定已计价
  // 前缀时用「锚 + delta 粗估」替代全量 chars×0.25（CJK 低估可达 2×）。
  // 锚缺失/失配（压缩、剪枝改写过前缀）→ fail-closed 回退旧估算路径。
  const usageAnchor = getUsageAnchorRegistry().get(sessionId);
  if (usageAnchor) {
    // 锚值 = 完整请求 promptTokens（sys/skills/tail/tools/当前 user 全含），
    // 不再另加 systemTokens（重复计）。delta（锚后追加的轮次）内部粗估。
    // fail-closed：指纹失配 → null → 走下方旧全量估算。
    const anchored = anchoredContextTokens(history, usageAnchor);
    if (anchored !== null) {
      return anchored > deps.compactionTokenThreshold;
    }
  }
  const systemTokens = estimateMessagesTokens([{ role: "system", content: systemPrompt }]);
  const historyTokens = estimateMessagesTokens(history.map((h) => ({ role: h.role, content: h.content })));
  const totalTokens = systemTokens + historyTokens;
  return totalTokens > deps.compactionTokenThreshold;
}

/**
 * R11 GAP-2（prepared compaction）：与 needsCompaction 同口径的 token 探针
 * （锚优先，回退 chars×0.25 全量估算），供预压缩频带判定消费。
 * 非负数；异常归 0（预压缩侧把 ≤0 视为「不准备」）。
 */
export function needsCompactionProbe(
  deps: SessionPersistenceDeps,
  sessionId: string,
  systemPrompt: string,
): number {
  try {
    const history = deps.conversationHistory.get(sessionId) || [];
    const usageAnchor = getUsageAnchorRegistry().get(sessionId);
    if (usageAnchor) {
      const anchored = anchoredContextTokens(history, usageAnchor);
      if (anchored !== null) return anchored;
    }
    const systemTokens = estimateMessagesTokens([{ role: "system", content: systemPrompt }]);
    const historyTokens = estimateMessagesTokens(history.map((h) => ({ role: h.role, content: h.content })));
    return systemTokens + historyTokens;
  } catch {
    return 0;
  }
}

/** Compact conversation history by summarizing older turns and keeping recent ones */
export async function compactConversationHistory(
  deps: SessionPersistenceDeps,
  sessionId: string,
  keepRecentTurns: number = 3,
): Promise<void> {
  const history = deps.conversationHistory.get(sessionId);
  if (!history || history.length <= keepRecentTurns * 2) return;

  // ── R11 GAP-4：压缩前 fail-closed 门（对标 hermes conversation_compression_checkpoint）──
  // 持久层静默失败未恢复（会话有落盘失败记录且此后无一次成功落盘）→ 拒绝压缩：
  // 压缩重写内存 history，未归档进 JSONL 的上下文会真丢。宁可不压缩（下轮重试
  // 触发同样的拒绝，运维看 stderr 修复），也不丢未归档上下文。
  const persistFailures = persistFailureCounts.get(sessionId) ?? 0;
  if (persistFailures > 0) {
    process.stderr.write(
      `[SessionPersistence] Compaction BLOCKED for session "${sessionId}": ${persistFailures} persist failure(s) since last successful write. ` +
      `Fix the persistence path (disk full / permissions / path), then the gate clears on the next successful append.\n`,
    );
    return;
  }

  const recentEntries = history.slice(-keepRecentTurns * 2);
  const olderEntries = history.slice(0, -(keepRecentTurns * 2));

  // ★ 2026-11-23 P2 接线：before_compaction（Memory Enhancer 借此在压缩前
  //   落盘会话洞察；instructions 返回目前无消费方，仅透传结果不阻断压缩）。
  if (deps.pluginManager?.hasHooks("before_compaction")) {
    try {
      await deps.pluginManager.runHooks({
        type: "before_compaction",
        context: { sessionId },
        turnCount: olderEntries.length,
        reason: deps.compactionReason ?? "auto",
      });
    } catch (err) {
      process.stderr.write(`[SessionPersistence] before_compaction hook failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Use CompactionManager if available for richer summary with successor transcripts
  let summary = "";
  let successorId = sessionId;
  // ── R11 GAP-2：取用预压缩摘要（若窗口仍一致）。命中 → 跳过同步 LLM 摘要
  // 调用（首 token 延迟的来源）；失配/无候选 → 照旧内联（fail-closed）。
  const prepared = takePreparedSummary(sessionId, history);
  if (deps.compactionManager) {
    const olderTurnData = olderEntries.map((e) => ({ role: e.role, content: e.content }));

    // ── LLM 摘要（优先）──
    // 对标 Hermes ContextCompressor._generate_summary：用辅助 LLM 生成结构化摘要。
    // buildLLMSummaryPrompt 此前是死代码（定义但从未调用），现接入活路径。
    // LLM 调用失败时回退规则提取（buildSummary），保证不中断压缩流程。
    let compaction = deps.compactionManager.buildSummary(sessionId, olderTurnData);
    if (prepared) {
      // GAP-2：预压缩摘要直接替换（后台 pass 已用同一 buildLLMSummaryPrompt 生成）
      compaction = {
        ...compaction,
        summary: prepared,
      };
      process.stdout.write(`[SessionPersistence] Used prepared compaction summary for session "${sessionId}" (spliced, no inline LLM call)\n`);
    } else if (deps.llmSummarizer) {
      try {
        const llmPrompt = deps.compactionManager.buildLLMSummaryPrompt(olderTurnData);
        const llmSummaryText = await deps.llmSummarizer(llmPrompt);
        if (llmSummaryText && llmSummaryText.trim()) {
          // 用 LLM 摘要替换规则摘要的 summary 字段
          compaction = {
            ...compaction,
            summary: llmSummaryText.trim(),
          };
        }
      } catch (err) {
        process.stderr.write(`[SessionPersistence] LLM summarizer failed, falling back to rule-based: ${err}\n`);
      }
    }

    summary = deps.compactionManager.buildSuccessorPrompt(compaction);
    successorId = compaction.successorSessionId;

    // Flush to long-term memory
    if (deps.memoryHub) {
      const memEntry = deps.compactionManager.buildMemoryEntry(compaction);
      const longTerm = deps.memoryHub.getLongTerm();
      longTerm.store({
        content: memEntry.content,
        type: memEntry.type,
        metadata: {
          source: memEntry.metadata.source,
          sessionId,
          userId: "default",
          tags: memEntry.metadata.tags,
          importance: memEntry.metadata.importance,
          associations: [],
          entities: [],
        },
        ttl: 30 * 24 * 3600 * 1000,
        embedding: null,
        id: "",
        createdAt: new Date(),
        accessedAt: new Date(),
      }).catch((err: unknown) => process.stderr.write(`[SessionPersistence] Memory flush failed: ${err}\n`));
    }

    // Emit lifecycle event
    if (deps.lifecycleManager) {
      deps.lifecycleManager.compacted(sessionId, olderEntries.length, successorId);
    }
  } else {
    // Fallback to simple compaction
    if (prepared) {
      // GAP-2：预压缩摘要命中（无 compactionManager 的路径）
      summary = prepared;
      process.stdout.write(`[SessionPersistence] Used prepared compaction summary for session "${sessionId}" (spliced, no inline LLM call)\n`);
    } else {
      const userMessages = olderEntries
        .filter((e) => e.role === "user" && e.content)
        .map((e) => e.content as string);
      const assistantMessages = olderEntries
        .filter((e) => e.role === "assistant" && e.content)
        .map((e) => e.content as string);
      if (userMessages.length > 0 || assistantMessages.length > 0) {
        summary = `[Compacted ${olderEntries.length} turns. `;
        if (userMessages.length > 0) {
          summary += `User discussed: ${userMessages.map((m) => m.slice(0, 80)).join("; ")}. `;
        }
        if (assistantMessages.length > 0) {
          summary += `Assistant covered: ${assistantMessages.map((m) => m.slice(0, 80)).join("; ")}.`;
        }
        summary += "]";
      }
    }
  }

  const compacted: Array<{ role: string; content: string | null }> = [
    { role: "system", content: summary || "[Previous conversation has been compacted.]" },
    ...recentEntries,
  ];

  // ── fix-5: 确保压缩后的历史以 user turn 结束（对齐 hermes _ensure_compressed_has_user_turn） ──
  // 如果压缩后历史末尾不是 user 消息，LLM 可能没有明确的"用户请求"可响应，
  // 导致生成不相关或困惑的回复。此函数检查末尾并在必要时追加合成 user 消息。
  if (compacted.length > 0) {
    const lastEntry = compacted[compacted.length - 1];
    if (lastEntry.role !== "user") {
      compacted.push({
        role: "user",
        content: "[Context was compacted. Please continue from where we left off based on the summary above.]",
      });
      process.stdout.write(`[SessionPersistence] Appended synthetic user turn after compaction for session "${sessionId}"\n`);
    }
  }

  // ── R11 GAP-23：todo 压缩后重注入（对标 hermes _fold_todo_snapshot）──
  // 此前 todo-store.ts 的 formatForInjection() 是死码（getTodoStore 导出零消费），
  // 头注释声称「压缩后重新注入」但三处 grep 无调用——注释与实现不符
  // （v20 Task 6 同型事故源头：压缩后模型丢 todo 列表 → 重做已完成工作）。
  // hermes 语义：压缩结果折叠**活跃**（pending/in_progress）todo 快照，
  // 已完成项不注入（防止重做）；快照以 synthetic user 行落在压缩后历史末尾。
  // EvoClaw 差异：hermes 用 _strip_stale_todo_snapshot 剥旧快照再折新的；
  // EvoClaw 的压缩是摘要式（旧段进摘要，快照不逐字残留），且 TodoStore 实例
  // 在 apps/server 工具层 → 经 todoSnapshotProvider 回调注入（依赖倒置，
  // packages/agent 不 import apps/server）。
  if (deps.todoSnapshotProvider) {
    try {
      const todoSnapshot = deps.todoSnapshotProvider(sessionId);
      if (todoSnapshot) {
        compacted.push({ role: "user", content: todoSnapshot });
        process.stdout.write(`[SessionPersistence] Re-injected todo snapshot after compaction for session "${sessionId}"\n`);
      }
    } catch (err) {
      // 快照注入失败不阻断压缩（模型仍有摘要可用）
      process.stderr.write(`[SessionPersistence] Todo snapshot injection failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  deps.conversationHistory.set(sessionId, compacted);
  // R11 GAP-1：压缩改写了已计价前缀 → usage anchor 指纹必然失配，立即清锚
  // （fail-closed：下次 LLM 调用重新捕获新锚）。不清的话 anchoredContextTokens
  // 返回 null 也是回退，但显式清掉避免每轮白算一次前缀指纹。
  getUsageAnchorRegistry().clear(sessionId);
  // R11 GAP-2：压缩成功 = 会话边界 → 丢弃预压缩候选（若有残余/在飞 pass）。
  discardPreparedCompaction(sessionId);
  process.stdout.write(`[SessionPersistence] Compacted session "${sessionId}" -> "${successorId}": ${olderEntries.length} older turns summarized, ${recentEntries.length} recent turns kept.\n`);

  // ★ 2026-11-23 P2 接线：after_compaction（Memory Enhancer 记录压缩完成日志）。
  if (deps.pluginManager?.hasHooks("after_compaction")) {
    try {
      await deps.pluginManager.runHooks({
        type: "after_compaction",
        context: { sessionId },
        summary: summary || "[Previous conversation has been compacted.]",
        turnCount: olderEntries.length,
        successorSessionId: successorId,
      });
    } catch (err) {
      process.stderr.write(`[SessionPersistence] after_compaction hook failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Fallback: Store compacted summary in long-term memory (only when CompactionManager not available, as it already handles this)
  if (!deps.compactionManager && deps.memoryHub && summary) {
    const longTerm = deps.memoryHub.getLongTerm();
    longTerm.store({
      content: summary,
      type: "system",
      metadata: {
        source: "compaction",
        sessionId: sessionId,
        userId: "default",
        tags: ["conversation", "compacted"],
        importance: 0.6,
        associations: [],
        entities: [],
      },
      ttl: 30 * 24 * 3600 * 1000, // 30 days
      embedding: null,
      id: "",
      createdAt: new Date(),
      accessedAt: new Date(),
    }).catch((err: unknown) => process.stderr.write(`[SessionPersistence] Failed to store compaction summary: ${err}\n`));
  }
}

// ── 空闲触发压缩（对标 hermes `_idle_compaction` + `_should_idle_compact`）──

/** 空闲压缩决策/执行结果（供上层 emit 状态消息与日志）。 */
export interface IdleCompactionOutcome {
  /** 是否实际执行了空闲压缩 */
  triggered: boolean;
  /** 空闲秒数（triggered 时有值） */
  idleGapSeconds?: number;
  /** 压缩前 token 估算 */
  tokensBefore?: number;
  /** 压缩后 token 估算（实际产出，用于抬高下次 floor） */
  tokensAfter?: number;
  /** 因何未触发（方便诊断，未触发时可能带） */
  skipReason?: "disabled" | "no-tracker" | "no-prior-activity" | "below-threshold" | "cooldown";
}

/**
 * 计算当前会话的请求 token 估算（系统提示 + 历史），与 needsCompaction 口径一致。
 */
function estimateRequestTokens(
  deps: SessionPersistenceDeps,
  sessionId: string,
  systemPrompt: string,
): number {
  const history = deps.conversationHistory.get(sessionId) || [];
  // R11 GAP-1：与 needsCompaction 同口径——锚有效时用 provider 真值优先。
  const usageAnchor = getUsageAnchorRegistry().get(sessionId);
  if (usageAnchor) {
    const anchored = anchoredContextTokens(history, usageAnchor);
    if (anchored !== null) return anchored;
  }
  const systemTokens = estimateMessagesTokens([{ role: "system", content: systemPrompt }]);
  const historyTokens = estimateMessagesTokens(history.map((h) => ({ role: h.role, content: h.content })));
  return systemTokens + historyTokens;
}

/**
 * 若满足空闲触发条件，执行一次空闲压缩。
 *
 * 不变式（对齐 hermes）：
 * - 默认关闭：`idleCompactAfterSeconds <= 0` 或未注入追踪器 → 不做事、零成本。
 * - 首次活动前（追踪器无记录）→ 不触发（gap 未知）。
 * - 冷却期（压缩失败 / 反抖动）→ 不触发。
 * - floor 由 `compactionTokenThreshold × summary_target_ratio` 计算，`lastCompactionTokens`
 *   抬高有效 floor 防反复压缩（#97239）。
 * - 压缩后记录**实际产出** token 抬高下次 floor，并刷新活动时间。
 *
 * @param now 当前时间戳（测试可注入）。调用方应在「读取 gap 之后、本轮任何活动之前」调用，
 *            这样 gap 反映的是上一轮结束到本轮开始之间的真实空闲。
 */
export async function maybeIdleCompact(
  deps: SessionPersistenceDeps,
  sessionId: string,
  systemPrompt: string,
  now: number = Date.now(),
): Promise<IdleCompactionOutcome> {
  const idleAfter = deps.idleCompactAfterSeconds ?? 0;
  const tracker: IdleCompactionTracker | undefined = deps.idleCompactionTracker;
  if (!deps.autoCompactionEnabled || idleAfter <= 0) return { triggered: false, skipReason: "disabled" };
  if (!tracker) return { triggered: false, skipReason: "no-tracker" };

  const idleGapSeconds = tracker.getIdleGapSeconds(sessionId, now);
  if (idleGapSeconds === null) return { triggered: false, skipReason: "no-prior-activity" };

  const tokensBefore = estimateRequestTokens(deps, sessionId, systemPrompt);
  const floorTokens = idleFloorTokens(deps.compactionTokenThreshold);
  const cooldownActive = deps.compactionManager?.shouldSkipCompaction() ?? false;
  const lastCompactionTokens = tracker.getLastCompactionTokens(sessionId);

  if (!shouldIdleCompact({
    enabled: true,
    idleAfterSeconds: idleAfter,
    idleGapSeconds,
    tokens: tokensBefore,
    floorTokens,
    cooldownActive,
    lastCompactionTokens,
  })) {
    return {
      triggered: false,
      skipReason: cooldownActive ? "cooldown" : "below-threshold",
      idleGapSeconds,
      tokensBefore,
    };
  }

  process.stderr.write(
    `[SessionPersistence] Idle compaction: ${Math.round(idleGapSeconds)}s idle >= ${idleAfter}s, ` +
    `~${tokensBefore} tokens > floor ${floorTokens} (last compaction produced ${lastCompactionTokens}) ` +
    `for session "${sessionId}"\n`,
  );

  await compactConversationHistory(deps, sessionId);

  const tokensAfter = estimateRequestTokens(deps, sessionId, systemPrompt);
  tracker.recordCompaction(sessionId, tokensAfter, now);
  // 让 CompactionManager 的反抖动计数器生效（此前 recordCompressionEffect 是死代码）：
  // 连续两次无效压缩会让后续空闲压缩在冷却内被拒绝，避免反复白跑全量摘要。
  deps.compactionManager?.recordCompressionEffect(tokensBefore, tokensAfter);

  return { triggered: true, idleGapSeconds, tokensBefore, tokensAfter };
}
