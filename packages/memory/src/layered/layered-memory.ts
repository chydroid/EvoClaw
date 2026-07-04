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

import * as path from "path";
import { ConversationRecorder, type ConversationMessage } from "./conversation-recorder";
import { AtomicMemoryExtractor, type AtomicMemory } from "./atomic-memory-extractor";
import { SceneBlockAggregator, type SceneBlock } from "./scene-block-aggregator";
import { PersonaProfileGenerator, type PersonaProfile } from "./persona-profile";
import { SymbolicMemoryCanvas, type MemoryCanvas } from "./symbolic-memory-canvas";
import { applyCanvasAgentOps, type CanvasAgentOp } from "./canvas-agent-ops";

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
  /** L3 画像（如有）。 */
  personaProfile: PersonaProfile | null;
  /** 召回策略名。 */
  strategy: string;
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
}

const DEFAULT_CONFIG: Required<LayeredMemoryConfig> = {
  l2AggregateEveryNTurns: 5,
  l3RefreshEveryNTurns: 5,
  l1RecallLimit: 5,
  l1MinPriority: 50,
  enableSymbolicCanvas: true,
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

  // 累积的 L1 记忆（用于 L2 聚合触发）
  private pendingL1Memories: AtomicMemory[] = [];
  // 已聚合到 L2 的全部 L1 记忆（用于 L3 画像刷新）
  private allL1Memories: AtomicMemory[] = [];
  private turnCount = 0;

  constructor(private dataDir: string, config?: LayeredMemoryConfig) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    this.recorder = new ConversationRecorder(dataDir);
    this.extractor = new AtomicMemoryExtractor();
    this.aggregator = new SceneBlockAggregator(dataDir);
    this.personaGen = new PersonaProfileGenerator(dataDir);
    this.canvas = new SymbolicMemoryCanvas();
  }

  // ── 写链路 ──

  /**
   * 捕获一轮对话：写入 L0 → 提取 L1 → 周期聚合 L2/L3。
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
    const l1Memories = this.extractor.extract([l0User]);
    this.pendingL1Memories.push(...l1Memories);
    this.allL1Memories.push(...l1Memories);

    // 3. L2：周期聚合
    this.turnCount++;
    let l2Scenes: SceneBlock[] | undefined;
    if (this.turnCount % this.cfg.l2AggregateEveryNTurns === 0 && this.pendingL1Memories.length > 0) {
      l2Scenes = this.aggregator.aggregate(this.pendingL1Memories);
      this.aggregator.writeSceneFiles(l2Scenes);
      this.pendingL1Memories = [];
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

  // ── 读链路 ──

  /**
   * 召回：从 L1 + L3 检索相关记忆，返回可注入的上下文。
   * @param query 用户当前消息（用于关键词匹配）
   */
  recall(query: string): LayeredRecallResult {
    // 1. L1 关键词检索
    const l1Memories = this.searchL1(query, this.cfg.l1RecallLimit, this.cfg.l1MinPriority);

    // 2. L3 画像
    const personaProfile = this.personaGen.getCurrent();

    // 3. 构造 prependContext
    let prependContext = "";
    if (l1Memories.length > 0) {
      const lines = l1Memories.map((m, i) => `  ${i + 1}. [${m.type}] ${m.content} (优先级 ${m.priority})`);
      prependContext = `\n[相关历史记忆]\n${lines.join("\n")}\n`;
    }

    // 4. 构造 appendSystemContext（画像）
    let appendSystemContext = "";
    if (personaProfile && personaProfile.entries.length > 0) {
      appendSystemContext = "\n[用户画像]\n" + this.personaGen.renderMarkdown();
    }

    return {
      prependContext,
      appendSystemContext,
      l1Memories,
      personaProfile,
      strategy: l1Memories.length > 0 ? "l1-keyword+l3-persona" : "l3-persona-only",
    };
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
