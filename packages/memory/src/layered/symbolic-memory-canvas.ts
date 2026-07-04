/**
 * SymbolicMemoryCanvas — Mermaid 符号记忆画布。
 *
 * 借鉴 TencentDB-Agent-Memory 的"符号记忆"思想：长任务中，工具调用日志
 * 动辄数万 token。我们把任务状态转换压缩成 Mermaid 流程图，只保留关键
 * 节点 + node_id（可溯源到 L0 原始日志）。
 *
 * 节点类型：
 *   - user_request：用户请求
 *   - tool_call：工具调用
 *   - decision：决策分支
 *   - result：结果
 *   - error：错误
 *
 * 输出格式（Mermaid graph）：
 *   graph LR
 *     n1["用户请求<br/>安装技能"] --> n2["调用 marketplace.install"]
 *     n2 --> n3{"成功?"}
 *     n3 -->|是| n4["✅ 完成"]
 *     n3 -->|否| n5["❌ 失败:网络"]
 *     %% refs: n2 = L0/l0_xxx
 *
 * 注入策略：把整张 Mermaid 图作为一个 user 消息插入，附带 refs 元数据，
 * 让 LLM 通过 node_id 反查 L0 原始日志。
 */

/** 画布节点类型。 */
export type CanvasNodeType = "user_request" | "tool_call" | "decision" | "result" | "error";

/** 画布节点。 */
export interface CanvasNode {
  /** 节点 ID（n1, n2, ...）。 */
  id: string;
  /** 节点类型。 */
  type: CanvasNodeType;
  /** 节点标签（显示文本，已压缩到 80 字符以内）。 */
  label: string;
  /** 来源 L0 消息 ID（用于溯源）。 */
  sourceMessageId?: string;
  /** 附加元数据（工具名、耗时等）。 */
  metadata?: Record<string, unknown>;
}

/** 画布边。 */
export interface CanvasEdge {
  /** 起点节点 ID。 */
  from: string;
  /** 终点节点 ID。 */
  to: string;
  /** 边标签（可选，如 "是"、"否"、"成功"）。 */
  label?: string;
}

/** 完整画布。 */
export interface MemoryCanvas {
  /** 会话键。 */
  sessionKey: string;
  /** 节点列表（按时间顺序）。 */
  nodes: CanvasNode[];
  /** 边列表。 */
  edges: CanvasEdge[];
  /** 创建时间。 */
  createdAt: number;
  /** 渲染后的 Mermaid 文本。 */
  mermaidText?: string;
}

/** 画布配置。 */
export interface CanvasOptions {
  /** 节点标签最大字符数。默认 80。 */
  maxLabelLength?: number;
  /** 单张画布最多节点数。默认 50。 */
  maxNodes?: number;
}

const DEFAULT_OPTIONS: Required<CanvasOptions> = {
  maxLabelLength: 80,
  maxNodes: 50,
};

/** 节点类型对应的 Mermaid 形状。 */
const NODE_SHAPE: Record<CanvasNodeType, (id: string, label: string) => string> = {
  user_request: (id, label) => `${id}(["${label}"])`,
  tool_call: (id, label) => `${id}["${label}"]`,
  decision: (id, label) => `${id}{"${label}"}`,
  result: (id, label) => `${id}(("${label}"))`,
  error: (id, label) => `${id}(("${label}"))`,
};

/**
 * 符号记忆画布构建器。
 *
 * 使用方式：
 *   const canvas = new SymbolicMemoryCanvas();
 *   canvas.start("session-1", "用户请求：安装技能");
 *   canvas.addNode("tool_call", "marketplace.install", { sourceMessageId: "l0_xxx" });
 *   canvas.connect("n1", "n2");
 *   const mermaid = canvas.render();
 */
export class SymbolicMemoryCanvas {
  private canvas: MemoryCanvas | null = null;
  private nodeCounter = 0;
  private options: Required<CanvasOptions>;

  constructor(options?: CanvasOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 开始新画布（清空旧状态）。 */
  start(sessionKey: string, userRequest: string): CanvasNode {
    this.canvas = {
      sessionKey,
      nodes: [],
      edges: [],
      createdAt: Date.now(),
    };
    this.nodeCounter = 0;
    return this.addNode("user_request", userRequest);
  }

  /**
   * 添加节点。
   * @returns 新节点
   */
  addNode(
    type: CanvasNodeType,
    label: string,
    metadata?: { sourceMessageId?: string; [k: string]: unknown }
  ): CanvasNode {
    if (!this.canvas) {
      throw new Error("Canvas not started. Call start() first.");
    }
    if (this.canvas.nodes.length >= this.options.maxNodes) {
      // 满了：丢掉最早的 user_request 之后的中间节点（保留首尾）
      // 简单策略：丢弃中间节点的 1/3
      const trimCount = Math.floor(this.options.maxNodes / 3);
      this.canvas.nodes.splice(1, trimCount);
      // 同时清理孤儿边
      this.canvas.edges = this.canvas.edges.filter(
        (e) =>
          this.canvas!.nodes.some((n) => n.id === e.from) &&
          this.canvas!.nodes.some((n) => n.id === e.to)
      );
    }

    this.nodeCounter++;
    const id = `n${this.nodeCounter}`;
    const truncated = this.truncateLabel(label);
    const node: CanvasNode = {
      id,
      type,
      label: truncated,
      sourceMessageId: metadata?.sourceMessageId,
      metadata,
    };
    this.canvas.nodes.push(node);
    return node;
  }

  /** 连接两个节点。自动用最新节点的 ID 作为 `from`。 */
  connect(from: string, to: string, label?: string): CanvasEdge | null {
    if (!this.canvas) return null;
    const edge: CanvasEdge = { from, to, label };
    this.canvas.edges.push(edge);
    return edge;
  }

  /** 把上一个节点连接到新节点（便捷方法）。 */
  connectToLast(type: CanvasNodeType, label: string, edgeLabel?: string, metadata?: { sourceMessageId?: string; [k: string]: unknown }): CanvasNode | null {
    if (!this.canvas || this.canvas.nodes.length === 0) return null;
    const last = this.canvas.nodes[this.canvas.nodes.length - 1];
    const newNode = this.addNode(type, label, metadata);
    this.connect(last.id, newNode.id, edgeLabel);
    return newNode;
  }

  /** 渲染成 Mermaid 文本。 */
  render(): string {
    if (!this.canvas || this.canvas.nodes.length === 0) return "";
    const lines: string[] = ["graph LR"];
    // 节点
    for (const node of this.canvas.nodes) {
      const shape = NODE_SHAPE[node.type](node.id, this.escapeLabel(node.label));
      lines.push(`  ${shape}`);
    }
    // 边
    for (const edge of this.canvas.edges) {
      const labelPart = edge.label ? `|${this.escapeLabel(edge.label)}|` : "";
      lines.push(`  ${edge.from} -->${labelPart} ${edge.to}`);
    }
    // refs 注释（node_id → L0 消息 ID）
    const refNodes = this.canvas.nodes.filter((n) => n.sourceMessageId);
    if (refNodes.length > 0) {
      lines.push(`  %% refs:`);
      for (const n of refNodes) {
        lines.push(`  %% ${n.id} = L0/${n.sourceMessageId}`);
      }
    }
    this.canvas.mermaidText = lines.join("\n");
    return this.canvas.mermaidText;
  }

  /** 获取当前画布（含 mermaidText）。 */
  getCanvas(): MemoryCanvas | null {
    if (!this.canvas) return null;
    if (!this.canvas.mermaidText) this.render();
    return this.canvas;
  }

  /**
   * 把 Mermaid 画布注入到消息数组（作为 user 消息）。
   * @returns 注入的消息对象，或 null（画布为空）
   */
  injectIntoMessages(messages: unknown[], opts?: { maxTokens?: number }): unknown | null {
    const mermaid = this.render();
    if (!mermaid) return null;
    const maxTokens = opts?.maxTokens ?? 800;
    // 粗略 token 估算：4 字符 ≈ 1 token
    const tokenEstimate = Math.ceil(mermaid.length / 4);
    if (tokenEstimate > maxTokens) {
      // 画布太大，只保留前 N 个节点
      return this.injectTruncated(maxTokens, messages);
    }
    const injectMsg = {
      role: "user",
      content: [
        { type: "text", text: `[任务状态画布]\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n可通过 node_id (如 n1) 在 L0 记录中查原始日志。` },
      ],
      _mmdContextMessage: "active",
    };
    messages.push(injectMsg);
    return injectMsg;
  }

  /** 清空画布。 */
  clear(): void {
    this.canvas = null;
    this.nodeCounter = 0;
  }

  // ── 私有辅助 ──

  private truncateLabel(label: string): string {
    const max = this.options.maxLabelLength;
    if (label.length <= max) return label;
    return label.slice(0, max - 3) + "...";
  }

  private escapeLabel(label: string): string {
    // Mermaid 标签里的特殊字符需要转义
    return label.replace(/"/g, "'").replace(/\n/g, "<br/>");
  }

  private injectTruncated(maxTokens: number, messages: unknown[]): unknown | null {
    if (!this.canvas) return null;
    // 简化：只保留前 10 个节点
    const keep = this.canvas.nodes.slice(0, 10);
    const keepIds = new Set(keep.map((n) => n.id));
    const keepEdges = this.canvas.edges.filter(
      (e) => keepIds.has(e.from) && keepIds.has(e.to)
    );
    const lines: string[] = ["graph LR"];
    for (const node of keep) {
      const shape = NODE_SHAPE[node.type](node.id, this.escapeLabel(node.label));
      lines.push(`  ${shape}`);
    }
    for (const edge of keepEdges) {
      const labelPart = edge.label ? `|${this.escapeLabel(edge.label)}|` : "";
      lines.push(`  ${edge.from} -->${labelPart} ${edge.to}`);
    }
    lines.push(`  %% (truncated, ${this.canvas.nodes.length - keep.length} more nodes)`);
    const mermaid = lines.join("\n");
    const tokenEstimate = Math.ceil(mermaid.length / 4);
    if (tokenEstimate > maxTokens) return null; // 还是太大，放弃注入
    const injectMsg = {
      role: "user",
      content: [
        { type: "text", text: `[任务状态画布(精简)]\n\`\`\`mermaid\n${mermaid}\n\`\`\`` },
      ],
      _mmdContextMessage: "active",
    };
    messages.push(injectMsg);
    return injectMsg;
  }
}
