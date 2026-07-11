/**
 * LayeredMemory — 统一的分层记忆 facade。
 *
 * 借鉴 TencentDB-Agent-Memory 的 TdaiCore 设计：把 L0/L1/L2/L3 + 符号记忆
 * 封装成一个单一入口，对 MemoryHub 暴露 turn-commit / before-recall 两个
 * 主接口，对应"写"和"读"两条链路。
 *
 * 写链路（captureTurn）：
 *   1. L0: 追加原始消息到会话 JSONL
 *   2. L1: 启发式提取原子记忆
 *   3. L2: 累积到一定数量后聚合成情境块
 *   4. L3: 周期性刷新用户画像（默认每 5 个 turn 刷一次）
 *
 * 读链路（recall）：
 *   1. 从 L1 原子记忆里按关键词检索 top-N
 *   2. 拼上 L3 用户画像（稳定上下文）
 *   3. 返回 prependContext（注入到 user prompt 末尾）
 *
 * 与 MemoryHub 已有能力的关系：
 * - LayeredMemory 只负责"分层"链路（L0→L1→L2→L3）
 * - MemoryHub 继续负责向量检索、FTS5、curator、knowledge graph
 * - MemoryHub.recall() 会同时调用 LayeredMemory.recall() 注入分层结果
 */

import * as fs from "fs";
import * as path from "path";
import { ConversationRecorder, type ConversationMessage } from "./conversation-recorder";
import { AtomicMemoryExtractor, type AtomicMemory } from "./atomic-memory-extractor";
import { SceneBlockAggregator, type SceneBlock } from "./scene-block-aggregator";
import { PersonaProfileGenerator, type PersonaProfile } from "./persona-profile";
import { SymbolicMemoryCanvas, type MemoryCanvas } from "./symbolic-memory-canvas";
import { applyCanvasAgentOps, type CanvasAgentOp } from "./canvas-agent-ops";
import { appendJsonlAtomic, atomicWriteFileSync } from "./atomic-write";
import { parseJsonlSafe } from "./jsonl-defense";
import { L1Dedupifier, applyDedupDecisions, type DedupDecision, type EmbedFn } from "./l1-dedup";
import { applyRecallBudget, type RecallBudgetOptions } from "./recall-budget";
import { wrapRelevantMemories, wrapTaskCanvas } from "./relevant-memories-tag";
import { TaskBoundaryJudge, shouldEndCanvas, type TaskBoundaryDecision } from "./task-boundary";
import { L2Trigger, type L2TriggerState } from "./l2-trigger";
import { BackgroundTaskRegistry } from "./bg-tasks";
import { quickTokenEstimate } from "./token-estimate";

/** 单轮对话输入。 */
export interface TurnInput {
  /** 用户消息文本。 */
  userText: string;
  /** 助手响应文本。 */
  assistantText: string;
  /** 会话键。 */
  sessionKey: string;
  /** 子会话 ID（可选）。 */
  sessionId?: string;
  /** 时间戳（默认 Date.now()）。 */
  timestamp?: number;
  /** 附加元数据。 */
  metadata?: Record<string, unknown>;
}

/** 召回结果。 */
export interface LayeredRecallResult {
  /** 注入到用户消息末尾的上下文（动态，本轮相关）。 */
  prependContext: string;
  /** 注入到系统提示的稳定上下文（画像）。 */
  appendSystemContext: string;
  /** 召回的 L1 记忆列表。 */
  l1Memories: AtomicMemory[];
  /** 召回的 L2 场景块列表（若有）。 */
  l2Scenes?: SceneBlock[];
  /** L3 画像（如有）。 */
  personaProfile: PersonaProfile | null;
  /** 任务画布 Mermaid 文本（若有）。 */
  canvasMermaid?: string;
  /** 任务边界判定结果。 */
  taskBoundary?: TaskBoundaryDecision;
  /** 召回策略名。 */
  strategy: string;
  /** 召回统计。 */
  stats?: {
    l1Hits: number;
    l2Hits: number;
    l3Injected: boolean;
    canvasInjected: boolean;
    budgetUsed: number;
    budgetExhausted: boolean;
    dedupSkipped: number;
  };
}

/** LayeredMemory 配置。 */
export interface LayeredMemoryConfig {
  /** 每多少个 turn 触发一次 L2 聚合。默认 5。 */
  l2AggregateEveryNTurns?: number;
  /** 每多少个 turn 刷新一次 L3 画像。默认 5。 */
  l3RefreshEveryNTurns?: number;
  /** L1 召回时返回的最大记忆数。默认 5。 */
  l1RecallLimit?: number;
  /** L1 召回最低优先级阈值。默认 50。 */
  l1MinPriority?: number;
  /** 是否启用符号记忆画布注入。默认 true。 */
  enableSymbolicCanvas?: boolean;
  /** L1 最大记忆数（防止无限增长，超出后按 LRU+优先级淘汰）。默认 1000。 */
  l1MaxMemories?: number;
  /** 是否启用 L1 智能去重。默认 true。 */
  enableL1Dedup?: boolean;
  /** 是否启用 L1 持久化到 JSONL。默认 true。 */
  enableL1Persistence?: boolean;
  /** 是否启用 L2 场景块召回（recall 时同时搜 L2）。默认 true。 */
  enableL2Recall?: boolean;
  /** 是否启用画布自动启动（根据任务边界判定）。默认 true。 */
  enableCanvasAutoStart?: boolean;
  /** 是否启用召回预算控制。默认 true。 */
  enableRecallBudget?: boolean;
  /** 召回预算配置。 */
  recallBudgetOptions?: RecallBudgetOptions;
  /** Embedding 函数（可选，用于 L1 向量去重）。 */
  embedFn?: EmbedFn;
}

const DEFAULT_CONFIG: Required<LayeredMemoryConfig> = {
  l2AggregateEveryNTurns: 5,
  l3RefreshEveryNTurns: 5,
  l1RecallLimit: 5,
  l1MinPriority: 50,
  enableSymbolicCanvas: true,
  l1MaxMemories: 1000,
  enableL1Dedup: true,
  enableL1Persistence: true,
  enableL2Recall: true,
  enableCanvasAutoStart: true,
  enableRecallBudget: true,
  recallBudgetOptions: {},
  embedFn: undefined as unknown as EmbedFn,
};

/**
 * 分层记忆系统主入口。
 *
 * 使用方式：
 *   const mem = new LayeredMemory(dataDir);
 *   mem.captureTurn({ userText: "我喜欢 TypeScript", assistantText: "好的", sessionKey: "s1" });
 *   const recall = mem.recall("用户在用什么语言？");
 */
export class LayeredMemory {
  private recorder: ConversationRecorder;
  private extractor: AtomicMemoryExtractor;
  private aggregator: SceneBlockAggregator;
  private personaGen: PersonaProfileGenerator;
  private canvas: SymbolicMemoryCanvas;
  private cfg: Required<LayeredMemoryConfig>;

  // 新增子模块（借鉴 TencentDB-Agent-Memory）
  private dedupifier: L1Dedupifier;
  private taskBoundaryJudge: TaskBoundaryJudge;
  private l2Trigger: L2Trigger;
  private l2TriggerState: L2TriggerState;
  private bgTasks: BackgroundTaskRegistry;

  // L1 持久化文件路径
  private l1File: string;

  // 累积的 L1 记忆（用于 L2 聚合触发）
  private pendingL1Memories: AtomicMemory[] = [];
  // 已聚合到 L2 的全部 L1 记忆（用于 L3 画像刷新 + 召回）
  private allL1Memories: AtomicMemory[] = [];
  private turnCount = 0;
  // L1 去重累计跳过数（统计用）
  private dedupSkippedTotal = 0;

  constructor(private dataDir: string, config?: LayeredMemoryConfig) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    this.recorder = new ConversationRecorder(dataDir);
    this.extractor = new AtomicMemoryExtractor();
    this.aggregator = new SceneBlockAggregator(dataDir);
    this.personaGen = new PersonaProfileGenerator(dataDir);
    this.canvas = new SymbolicMemoryCanvas();

    // 初始化新模块
    this.dedupifier = new L1Dedupifier([], {}, this.cfg.embedFn);
    this.taskBoundaryJudge = new TaskBoundaryJudge();
    this.l2Trigger = new L2Trigger();
    this.l2TriggerState = this.l2Trigger.createInitialState();
    this.bgTasks = new BackgroundTaskRegistry({ drainTimeoutMs: 5000 });

    // L1 持久化文件
    const layeredDir = path.join(dataDir, "memory", "layered");
    if (!fs.existsSync(layeredDir)) {
      fs.mkdirSync(layeredDir, { recursive: true });
    }
    this.l1File = path.join(layeredDir, "l1.jsonl");

    // 启动时从磁盘加载已有 L1 记忆
    if (this.cfg.enableL1Persistence) {
      this.loadL1FromDisk();
    }
  }

  // ── 写链路 ──

  /**
   * 捕获一轮对话：写入 L0 → 提取 L1 → 周期聚合 L2/L3。
   *
   * 借鉴 TencentDB-Agent-Memory 的 TdaiCore.commit_turn 设计，加入：
   *   - L1 智能去重（store/update/merge/skip 4 种 action）
   *   - L1 持久化到 JSONL（崩溃恢复）
   *   - L1 LRU 上限淘汰（防止 Map 无限增长）
   *   - L2 独立触发（null 阈值 + 超时双触发，不再由 L1 直接驱动）
   */
  async captureTurn(turn: TurnInput): Promise<{
    l0Messages: ConversationMessage[];
    l1Memories: AtomicMemory[];
    l2Scenes?: SceneBlock[];
    l3Persona?: PersonaProfile;
  }> {
    const ts = turn.timestamp ?? Date.now();

    // 1. L0：记录原始对话
    const l0User = this.recorder.record({
      role: "user",
      content: turn.userText,
      sessionKey: turn.sessionKey,
      sessionId: turn.sessionId,
      timestamp: ts,
      metadata: turn.metadata,
    });
    const l0Assistant = this.recorder.record({
      role: "assistant",
      content: turn.assistantText,
      sessionKey: turn.sessionKey,
      sessionId: turn.sessionId,
      timestamp: ts + 1,
      metadata: turn.metadata,
    });

    // 2. L1：提取原子记忆（只从 user 消息提取）
    const rawL1 = this.extractor.extract([l0User]);

    // 2a. L1 智能去重（借鉴 TencentDB-Agent-Memory l1-dedup.ts）
    let l1Memories: AtomicMemory[] = rawL1;
    let dedupSkipped = 0;
    // 已知限制（Low）：以下 checkBatch 为 await，期间并发的 consolidate 可能读到
    // L1 的部分写入（push 发生在 await 之后）。captureTurn 与 consolidate 不应并发
    // 调用；若需严格串行，应在调用方加互斥。此处不重构以避免改变去重时序。
    if (this.cfg.enableL1Dedup && rawL1.length > 0 && this.allL1Memories.length > 0) {
      const decisions = await this.dedupifier.checkBatch(rawL1);
      const applied = applyDedupDecisions(this.allL1Memories, rawL1, decisions);
      this.allL1Memories = applied.merged;
      // 只把 store/update 的新记忆加入 pending（merge/skip 不算新）
      l1Memories = decisions
        .filter((d) => d.decision.action === "store" || d.decision.action === "update")
        .map((d) => d.memory);
      dedupSkipped = applied.stats.skipped;
      this.dedupSkippedTotal += dedupSkipped;
      // 更新去重器的已有记忆视图
      this.dedupifier.updateExisting(this.allL1Memories);
    } else {
      // 无去重或首次写入：直接追加
      this.allL1Memories.push(...rawL1);
      // 同步到去重器的已有记忆视图，确保后续 captureTurn 能正确去重
      this.dedupifier.updateExisting(this.allL1Memories);
    }

    this.pendingL1Memories.push(...l1Memories);

    // 2b. L1 持久化到 JSONL（借鉴 TencentDB-Agent-Memory StorageContext）
    if (this.cfg.enableL1Persistence && l1Memories.length > 0) {
      const persistFn = (async () => {
        for (const mem of l1Memories) {
          appendJsonlAtomic(this.l1File, mem);
        }
      })();
      this.bgTasks.register("persist L1 memories", persistFn);
    }

    // 2c. L1 LRU 上限淘汰（防止 Map 无限增长）
    if (this.allL1Memories.length > this.cfg.l1MaxMemories) {
      const overflow = this.allL1Memories.length - this.cfg.l1MaxMemories;
      // 淘汰优先级最低的最旧记忆（保持稳定性：稳定先入先出 + 优先级排序）
      this.allL1Memories.sort((a, b) => {
        // 优先级低的先淘汰；同优先级的先入先出
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.extractedAt - b.extractedAt;
      });
      this.allL1Memories = this.allL1Memories.slice(overflow);
      this.dedupifier.updateExisting(this.allL1Memories);
    }

    // 3. L2 独立触发（借鉴 TencentDB-Agent-Memory l2-mermaid 双触发）
    this.turnCount++;
    this.l2Trigger.incrementMessages(this.l2TriggerState);
    if (rawL1.length === 0) {
      // null entry：未提取到任何 L1 记忆
      this.l2Trigger.incrementNullEntries(this.l2TriggerState);
    }

    let l2Scenes: SceneBlock[] | undefined;
    const l2Decision = this.l2Trigger.evaluate(this.l2TriggerState);
    if (l2Decision.shouldTrigger && this.pendingL1Memories.length > 0) {
      l2Scenes = this.aggregator.aggregate(this.pendingL1Memories);
      this.aggregator.writeSceneFiles(l2Scenes);
      this.pendingL1Memories = [];
      this.l2Trigger.markTriggered(this.l2TriggerState);
    } else if (
      // 兜底：周期触发（保留原有 l2AggregateEveryNTurns 语义，便于测试兼容）
      this.turnCount % this.cfg.l2AggregateEveryNTurns === 0 &&
      this.pendingL1Memories.length > 0
    ) {
      l2Scenes = this.aggregator.aggregate(this.pendingL1Memories);
      this.aggregator.writeSceneFiles(l2Scenes);
      this.pendingL1Memories = [];
      this.l2Trigger.markTriggered(this.l2TriggerState);
    }

    // 4. L3：周期刷新画像
    let l3Persona: PersonaProfile | undefined;
    if (this.turnCount % this.cfg.l3RefreshEveryNTurns === 0 && this.allL1Memories.length > 0) {
      l3Persona = this.personaGen.refresh(this.allL1Memories);
    }

    return {
      l0Messages: [l0User, l0Assistant],
      l1Memories,
      l2Scenes,
      l3Persona,
    };
  }

  /**
   * 从磁盘加载已有 L1 记忆（构造时自动调用）。
   *
   * 借鉴 TencentDB-Agent-Memory 的 StorageContext 启动加载逻辑：
   * - 用 parseJsonlSafe 容忍解析损坏行
   * - 校验必填字段
   * - 加载后同步到 dedupifier 的已有记忆视图
   */
  private loadL1FromDisk(): void {
    if (!fs.existsSync(this.l1File)) return;
    let text: string;
    try {
      text = fs.readFileSync(this.l1File, "utf-8");
    } catch {
      return;
    }
    const result = parseJsonlSafe<AtomicMemory>(text, {
      requiredFields: ["id", "type", "content", "priority", "sessionKey", "extractedAt"],
    });
    if (result.entries.length > 0) {
      this.allL1Memories = result.entries;
      this.dedupifier.updateExisting(this.allL1Memories);
    }
  }

  // ── 读链路 ──

  /**
   * 召回：从 L1 + L2 + L3 检索相关记忆，返回可注入的上下文。
   *
   * 借鉴 TencentDB-Agent-Memory 的 auto-recall hook：
   *   1. L1 关键词检索（可选 hybrid search）
   *   2. L2 场景块搜索（若 enableL2Recall）
   *   3. L3 用户画像
   *   4. 任务画布注入（若存在活跃画布）
   *   5. 双重预算控制（maxCharsPerMemory + maxTotalRecallChars）
   *   6. <relevant-memories> 标签包裹（防止污染历史）
   *
   * @param query 用户当前消息（用于关键词匹配）
   */
  recall(query: string): LayeredRecallResult {
    // 0. 任务边界判定（L1.5）—— 用于决定是否注入画布
    const canvasSnapshot = this.canvas.getCanvas();
    const taskBoundary = this.taskBoundaryJudge.judge({
      userMessage: query,
      historyLength: this.turnCount * 2, // 粗略估算（user+assistant = 2 条/turn）
      hasActiveCanvas: canvasSnapshot !== null,
    });

    // 1. L1 关键词检索
    let l1Memories = this.searchL1(query, this.cfg.l1RecallLimit, this.cfg.l1MinPriority);

    // 2. L2 场景块搜索（借鉴 TencentDB-Agent-Memory 的 L2 召回）
    let l2Scenes: SceneBlock[] | undefined;
    if (this.cfg.enableL2Recall && query.trim()) {
      l2Scenes = this.aggregator.search(query, 3);
    }

    // 3. L3 画像
    const personaProfile = this.personaGen.getCurrent();

    // 4. 任务画布 Mermaid（若启用且活跃）
    let canvasMermaid: string | undefined;
    if (this.cfg.enableSymbolicCanvas && this.cfg.enableCanvasAutoStart && taskBoundary.shouldUseCanvas && canvasSnapshot) {
      canvasMermaid = this.canvas.render();
    }

    // 5. 双重预算控制（借鉴 TencentDB-Agent-Memory applyRecallBudget）
    let budgetUsed = 0;
    let budgetExhausted = false;
    if (this.cfg.enableRecallBudget) {
      const budget = applyRecallBudget(l1Memories, (m) => `[${m.type}] ${m.content}`, this.cfg.recallBudgetOptions);
      l1Memories = budget.items as AtomicMemory[];
      budgetUsed = budget.totalChars;
      budgetExhausted = budget.budgetExhausted;
    }

    // 6. 构造 prependContext（用 <relevant-memories> 标签包裹，防止污染历史）
    const memoryLines: string[] = [];
    if (l1Memories.length > 0) {
      memoryLines.push("[相关历史记忆]");
      l1Memories.forEach((m, i) => {
        // 优先使用预算截断后的文本，避免单条超长记忆撑爆 prompt
        const truncatedText = (m as AtomicMemory & { _truncatedText?: string })._truncatedText;
        const memoryText = truncatedText ?? `[${m.type}] ${m.content}`;
        memoryLines.push(`  ${i + 1}. ${memoryText} (优先级 ${m.priority})`);
      });
    }
    if (l2Scenes && l2Scenes.length > 0) {
      memoryLines.push("[相关场景块]");
      l2Scenes.forEach((s, i) => {
        memoryLines.push(`  ${i + 1}. ${s.sceneName} (${s.memories.length} 条记忆)`);
      });
    }

    let prependContext = "";
    if (memoryLines.length > 0) {
      const plainBody = memoryLines.join("\n");
      prependContext = `\n${wrapRelevantMemories([plainBody])}\n`;
    }

    // 7. 任务画布注入（用 <task-canvas> 标签包裹）
    if (canvasMermaid) {
      prependContext += `\n${wrapTaskCanvas(canvasMermaid)}\n`;
    }

    // 8. 构造 appendSystemContext（画像，稳定上下文）
    let appendSystemContext = "";
    if (personaProfile && personaProfile.entries.length > 0) {
      appendSystemContext = "\n[用户画像]\n" + this.personaGen.renderMarkdown();
    }

    const stats = {
      l1Hits: l1Memories.length,
      l2Hits: l2Scenes?.length ?? 0,
      l3Injected: !!personaProfile && personaProfile.entries.length > 0,
      canvasInjected: !!canvasMermaid,
      budgetUsed,
      budgetExhausted,
      dedupSkipped: this.dedupSkippedTotal,
    };

    const strategy = this.buildStrategyName(l1Memories.length, l2Scenes?.length ?? 0, !!canvasMermaid);

    return {
      prependContext,
      appendSystemContext,
      l1Memories,
      l2Scenes,
      personaProfile,
      canvasMermaid,
      taskBoundary,
      strategy,
      stats,
    };
  }

  /** 根据召回命中的层级生成策略名（便于观测）。 */
  private buildStrategyName(l1Hits: number, l2Hits: number, canvasHit: boolean): string {
    const parts: string[] = [];
    if (l1Hits > 0) parts.push("l1-keyword");
    if (l2Hits > 0) parts.push("l2-scene");
    parts.push("l3-persona");
    if (canvasHit) parts.push("canvas");
    return parts.join("+");
  }

  // ── 符号记忆画布 ──

  /** 获取符号记忆画布（每个会话独立）。 */
  getCanvas(): SymbolicMemoryCanvas {
    return this.canvas;
  }

  /** 启动新画布（清空旧画布）。 */
  startCanvas(sessionKey: string, userRequest: string): MemoryCanvas {
    this.canvas.start(sessionKey, userRequest);
    return this.canvas.getCanvas()!;
  }

  /**
   * 记录工具调用节点到符号画布（Agent 执行流程的 hook）。
   *
   * 这是 SymbolicMemoryCanvas 真正接入生产流程的入口：每次 Agent 执行工具
   * 时调用此方法，把工具调用压缩成 Mermaid 节点，形成可视化任务状态图。
   *
   * 借鉴 Infinite-Canvas 的 CanvasAgentOp 思路：Agent 操作 → 画布节点。
   *
   * @returns 新增的节点，或 null（画布未启动）
   */
  recordToolNode(params: {
    toolName: string;
    params?: Record<string, unknown>;
    success: boolean;
    error?: string;
    resultPreview?: string;
    sessionId: string;
  }): { nodeId: string; mermaid: string } | null {
    const canvas = this.canvas.getCanvas();
    if (!canvas) return null;

    const { toolName, success, error, resultPreview, sessionId } = params;
    const labelParts = [toolName];
    if (resultPreview) labelParts.push(`→ ${resultPreview.slice(0, 50)}`);
    if (error) labelParts.push(`❌ ${error.slice(0, 60)}`);
    const label = labelParts.join(" ");

    const nodeType = success ? "tool_call" : "error";
    const node = this.canvas.addNode(nodeType, label, {
      sourceMessageId: `tool_${toolName}_${Date.now()}`,
      toolName,
      sessionId,
      success,
    });

    // 连接到上一个节点（形成链式流程图）
    const nodes = canvas.nodes;
    if (nodes.length >= 2) {
      const prev = nodes[nodes.length - 2];
      this.canvas.connect(prev.id, node.id, success ? "成功" : "失败");
    }

    const mermaid = this.canvas.render();
    return { nodeId: node.id, mermaid };
  }

  /** 获取当前画布的 Mermaid 文本（用于前端渲染或注入 LLM 上下文）。 */
  getCanvasMermaid(): string {
    return this.canvas.render();
  }

  /** 获取当前画布的完整数据（用于前端节点图渲染）。 */
  getCanvasSnapshot(): { nodes: unknown[]; edges: unknown[]; sessionKey: string; createdAt: number } | null {
    const canvas = this.canvas.getCanvas();
    if (!canvas) return null;
    return {
      nodes: canvas.nodes,
      edges: canvas.edges,
      sessionKey: canvas.sessionKey,
      createdAt: canvas.createdAt,
    };
  }

  /**
   * 应用 CanvasAgentOp 数组到画布（借鉴 Infinite-Canvas 的 applyCanvasAgentOps）。
   *
   * 这是结构化操作画布的统一入口：所有 Agent 对画布的修改都通过 ops 数组
   * 而非直接调 addNode/connect，便于撤销/重做、批量化、跨进程同步。
   *
   * @returns 应用后的画布快照，或 null（画布未启动）
   */
  applyCanvasOps(ops: CanvasAgentOp[]): {
    nodes: import("./symbolic-memory-canvas").CanvasNode[];
    edges: import("./symbolic-memory-canvas").CanvasEdge[];
  } | null {
    const canvas = this.canvas.getCanvas();
    if (!canvas) return null;
    // 用纯函数 reducer 应用 ops
    const result = applyCanvasAgentOps(canvas, ops);
    // 把结果写回 canvas（直接操作内部 canvas 对象）
    canvas.nodes = result.nodes;
    canvas.edges = result.edges;
    // 触发重新渲染 Mermaid
    this.canvas.render();
    return { nodes: result.nodes, edges: result.edges };
  }

  // ── 子组件直接访问 ──

  getRecorder(): ConversationRecorder { return this.recorder; }
  getExtractor(): AtomicMemoryExtractor { return this.extractor; }
  getAggregator(): SceneBlockAggregator { return this.aggregator; }
  getPersonaGenerator(): PersonaProfileGenerator { return this.personaGen; }

  /** 获取所有累积的 L1 记忆（用于测试/调试）。 */
  getAllL1Memories(): AtomicMemory[] {
    return [...this.allL1Memories];
  }

  /** 获取 turn 计数（用于测试/调试）。 */
  getTurnCount(): number {
    return this.turnCount;
  }

  /** 清空所有层（主要用于测试）。 */
  clear(): void {
    this.recorder.clear();
    this.aggregator.clear();
    this.personaGen.clear();
    this.canvas.clear();
    this.pendingL1Memories = [];
    this.allL1Memories = [];
    this.turnCount = 0;
    // 同步清理新模块状态
    this.dedupifier.updateExisting([]);
    this.l2TriggerState = this.l2Trigger.createInitialState();
    this.dedupSkippedTotal = 0;
    // 清理 L1 持久化文件（测试隔离用）
    if (this.cfg.enableL1Persistence && fs.existsSync(this.l1File)) {
      try { fs.unlinkSync(this.l1File); } catch { /* ignore */ }
    }
  }

  /**
   * 等待所有后台任务完成（进程关闭前调用）。
   *
   * 借鉴 TencentDB-Agent-Memory 的 destroy() drain 模式：
   * - 5 秒超时保护
   * - 超时后强制返回，未完成任务继续在后台跑（不杀）
   *
   * @returns drain 统计信息
   */
  async drain(): Promise<{
    completed: number;
    timedOut: number;
    errors: Array<{ description: string; error: unknown }>;
  }> {
    return this.bgTasks.drain();
  }

  /** 获取累计去重跳过数（用于观测/调试）。 */
  getDedupSkippedTotal(): number {
    return this.dedupSkippedTotal;
  }

  /** 获取当前 L2 触发器状态快照（用于观测/调试）。 */
  getL2TriggerState(): L2TriggerState {
    return { ...this.l2TriggerState };
  }

  /**
   * 获取分层记忆完整统计快照（用于 WebUI / API 暴露）。
   *
   * 汇总 L0/L1/L2/L3 + Canvas + Config 各层指标，所有 IO 操作包裹在
   * try/catch 中，避免单层故障导致整个快照失败。
   */
  getStats(): {
    turnCount: number;
    l0: { sessionCount: number; totalMessages: number; sessions: Array<{ key: string; messageCount: number }> };
    l1: { totalMemories: number; pendingCount: number; dedupSkippedTotal: number; byType: Record<string, number>; byPriority: Record<string, number> };
    l2: { sceneCount: number; lastTrigger: L2TriggerState };
    l3: { personaEntries: number; lastUpdatedAt: number | null };
    canvas: { nodeCount: number; edgeCount: number; active: boolean; sessionKey: string | null };
    config: { enableL1Persistence: boolean; enableL1Dedup: boolean; enableL2Recall: boolean; enableRecallBudget: boolean; enableSymbolicCanvas: boolean; l1MaxMemories: number; l3RefreshEveryNTurns: number };
  } {
    // L0：遍历 recorder 的所有会话
    const l0Sessions: Array<{ key: string; messageCount: number }> = [];
    let l0TotalMessages = 0;
    try {
      const sessionKeys = this.recorder.listSessions();
      for (const key of sessionKeys) {
        const msgs = this.recorder.loadRecent(key, 100000);
        l0Sessions.push({ key, messageCount: msgs.length });
        l0TotalMessages += msgs.length;
      }
    } catch {
      // best-effort：失败时返回已收集的部分
    }

    // L1：按 type / priority 分桶
    const byType: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    for (const mem of this.allL1Memories) {
      byType[mem.type] = (byType[mem.type] ?? 0) + 1;
      // 优先级按 0-49 / 50-69 / 70-84 / 85-100 分桶，便于 WebUI 直观展示
      const bucket = mem.priority < 50
        ? "0-49"
        : mem.priority < 70
          ? "50-69"
          : mem.priority < 85
            ? "70-84"
            : "85-100";
      byPriority[bucket] = (byPriority[bucket] ?? 0) + 1;
    }

    // L2：sceneCount 从 scenesDir 文件数推断（aggregator 没有内置 stats）
    const scenesDir = path.join(this.dataDir, "memory", "layered", "scene_blocks");
    let sceneCount = 0;
    try {
      if (fs.existsSync(scenesDir)) {
        sceneCount = fs.readdirSync(scenesDir).filter((f) => f.endsWith(".json")).length;
      }
    } catch {
      // best-effort
    }

    // L3：从 personaGen 获取当前画像
    const persona = this.personaGen.getCurrent();
    const l3Entries = persona?.entries.length ?? 0;
    const l3UpdatedAt = persona?.updatedAt ?? null;

    // Canvas：从 canvas 快照拉取
    const canvasSnapshot = this.canvas.getCanvas();
    const canvasStats = {
      nodeCount: canvasSnapshot?.nodes.length ?? 0,
      edgeCount: canvasSnapshot?.edges.length ?? 0,
      active: canvasSnapshot !== null,
      sessionKey: canvasSnapshot?.sessionKey ?? null,
    };

    return {
      turnCount: this.turnCount,
      l0: {
        sessionCount: l0Sessions.length,
        totalMessages: l0TotalMessages,
        sessions: l0Sessions,
      },
      l1: {
        totalMemories: this.allL1Memories.length,
        pendingCount: this.pendingL1Memories.length,
        dedupSkippedTotal: this.dedupSkippedTotal,
        byType,
        byPriority,
      },
      l2: {
        sceneCount,
        lastTrigger: { ...this.l2TriggerState },
      },
      l3: {
        personaEntries: l3Entries,
        lastUpdatedAt: l3UpdatedAt,
      },
      canvas: canvasStats,
      config: {
        enableL1Persistence: this.cfg.enableL1Persistence,
        enableL1Dedup: this.cfg.enableL1Dedup,
        enableL2Recall: this.cfg.enableL2Recall,
        enableRecallBudget: this.cfg.enableRecallBudget,
        enableSymbolicCanvas: this.cfg.enableSymbolicCanvas,
        l1MaxMemories: this.cfg.l1MaxMemories,
        l3RefreshEveryNTurns: this.cfg.l3RefreshEveryNTurns,
      },
    };
  }

  // ── 私有辅助 ──

  /**
   * 关键词检索 L1 记忆。
   * 简单策略：关键词命中数 × 优先级 排序。
   */
  private searchL1(query: string, limit: number, minPriority: number): AtomicMemory[] {
    if (this.allL1Memories.length === 0 || !query.trim()) return [];

    const queryKeywords = this.extractKeywords(query);
    if (queryKeywords.size === 0) {
      // 退化：按优先级取 top-N
      return [...this.allL1Memories]
        .filter((m) => m.priority >= minPriority)
        .sort((a, b) => b.priority - a.priority)
        .slice(0, limit);
    }

    const scored = this.allL1Memories
      .filter((m) => m.priority >= minPriority)
      .map((m) => {
        const memKeywords = this.extractKeywords(m.content);
        let overlap = 0;
        for (const k of queryKeywords) {
          if (memKeywords.has(k)) overlap++;
        }
        return { mem: m, score: overlap * 10 + m.priority * 0.1 };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.mem);

    return scored;
  }

  private extractKeywords(text: string): Set<string> {
    const keywords = new Set<string>();
    const en = text.match(/\b[a-zA-Z][a-zA-Z0-9_-]{3,}\b/g);
    if (en) for (const w of en) {
      if (!/^(?:that|this|with|from|have|they|will|your|their|what|when|which|where|while)$/.test(w)) {
        keywords.add(w.toLowerCase());
      }
    }
    const cn = text.match(/[\u4e00-\u9fff]{2,4}/g);
    if (cn) for (const w of cn) keywords.add(w);
    return keywords;
  }
}
