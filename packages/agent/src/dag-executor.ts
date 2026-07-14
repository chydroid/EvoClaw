import { ServiceRegistry, EventBus, type Task, type DAGNode, type ExecutionStep } from "@evoclaw/core";
import type { ExecutionPlan } from "./planning-engine";

interface DAGResult {
  output: Record<string, unknown>;
  steps: ExecutionStep[];
}

/** Default values for optional DAGNode fields */
const DEFAULT_RETRY_COUNT = 0;
const DEFAULT_RETRY_DELAY = 1000;
const DEFAULT_TIMEOUT_MS = 60000;

export class DAGExecutor {
  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {}

  /**
   * Convert an ExecutionPlan (from PlanningEngine) into a DAG-compatible Task.
   * Each PlanStep becomes a DAGNode; dependsOn maps to dependencies.
   */
  fromExecutionPlan(plan: ExecutionPlan, context?: Partial<Task>): Task {
    const dagNodes: DAGNode[] = plan.steps.map((step) => ({
      id: step.id,
      action: step.description,
      skill: step.toolHint,
      dependencies: step.dependsOn ?? [],
      params: {},
      timeout: DEFAULT_TIMEOUT_MS,
    }));

    const defaultContext: Task["context"] = {
      sessionId: "plan-session",
      userId: "",
      workspace: "",
      variables: {},
      tags: [],
      traceId: "",
    };

    return {
      id: plan.id,
      type: "automation",
      priority: "normal",
      status: "pending",
      input: {},
      output: null,
      context: context?.context ?? defaultContext,
      dag: dagNodes,
      executionPlan: [],
      createdAt: new Date(plan.createdAt),
      updatedAt: new Date(),
      completedAt: null,
      retryCount: 0,
      maxRetries: 0,
    };
  }

  async executeDAG(task: Task): Promise<DAGResult> {
    const completed = new Map<string, ExecutionStep>();
    const nodeMap = new Map<string, DAGNode>();

    for (const node of task.dag) {
      nodeMap.set(node.id, node);
    }

    // Compute levels for parallel execution
    const levels = this.computeLevels(task.dag);

    for (const level of levels) {
      // Execute all nodes in the same level concurrently
      const promises = level.map((node) => this.processNode(node, task, completed));
      await Promise.allSettled(promises);
    }

    return {
      output: { dagCompleted: true, nodeCount: task.dag.length },
      steps: Array.from(completed.values()),
    };
  }

  /**
   * Process a single node: check deps, evaluate condition, execute with retry/timeout.
   */
  private async processNode(
    node: DAGNode,
    task: Task,
    completed: Map<string, ExecutionStep>
  ): Promise<void> {
    // Check dependencies
    for (const depId of node.dependencies) {
      const depStep = completed.get(depId);
      if (!depStep || depStep.status !== "completed") {
        const step: ExecutionStep = {
          nodeId: node.id,
          status: "waiting_dependency",
          attempt: 1,
          result: null,
          error: `Dependency "${depId}" not completed`,
        };
        completed.set(node.id, step);
        return;
      }
    }

    // Evaluate condition
    if (node.condition != null) {
      const condResult = this.evaluateCondition(node.condition, task.context);
      if (!condResult) {
        const step: ExecutionStep = {
          nodeId: node.id,
          status: "skipped",
          startedAt: new Date(),
          completedAt: new Date(),
          attempt: 1,
          result: null,
          error: `Condition "${node.condition}" evaluated to false`,
        };
        completed.set(node.id, step);
        return;
      }
    }

    // Execute with retry and timeout
    const maxRetries = node.retryCount ?? DEFAULT_RETRY_COUNT;
    const retryDelay = node.retryDelay ?? DEFAULT_RETRY_DELAY;
    const timeoutMs = node.timeoutMs ?? node.timeout ?? DEFAULT_TIMEOUT_MS;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const result = await this.executeWithTimeout(node, task.context, timeoutMs);
        const step: ExecutionStep = {
          nodeId: node.id,
          status: "completed",
          startedAt: new Date(),
          completedAt: new Date(),
          attempt,
          result: {
            success: true,
            data: result,
            artifacts: [],
            metrics: {
              startTime: new Date(),
              endTime: new Date(),
              durationMs: 0,
              cpuUsage: 0,
              memoryUsageMB: 0,
            },
          },
        };
        completed.set(node.id, step);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt <= maxRetries) {
          await this.delay(retryDelay);
        }
      }
    }

    // All attempts exhausted
    const step: ExecutionStep = {
      nodeId: node.id,
      status: "failed",
      attempt: maxRetries + 1,
      result: null,
      error: lastError,
    };
    completed.set(node.id, step);
  }

  /**
   * Execute a node with a timeout using Promise.race + AbortSignal.
   * 超时后通过 AbortController 标记取消，executeNode 中的后续操作可检测信号
   * 提前终止，避免 timed-out 执行在后台继续消耗资源。
   */
  private async executeWithTimeout(
    node: DAGNode,
    context: Task["context"],
    timeoutMs: number
  ): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error(`Node "${node.id}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Keep the timer from keeping the process alive
      if (timer.unref) timer.unref();
    });
    const nodePromise = this.executeNode(node, context, controller.signal);
    // 超时后仍捕获 rejection 防止 unhandledRejection；同时记录最终结果用于诊断
    nodePromise
      .then(() => {
        if (timedOut) {
          process.stderr.write(`[DAGExecutor] Node "${node.id}" completed after timeout (result discarded)\n`);
        }
      })
      .catch(() => {});
    return Promise.race([nodePromise, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /**
   * 受限条件表达式求值器（替代 new Function / eval，防止代码注入）。
   *
   * 支持的语法子集：
   * - context 字段直接访问：sessionId / userId / workspace / variables / tags / traceId
   *   及嵌套属性：variables.foo / tags.length
   * - 字面量：true / false / null / undefined / 数字 / 单/双引号字符串
   * - 比较：=== / !== / == / != / >= / <= / > / <
   * - 逻辑：&& / || / ! 以及括号分组
   *
   * 不支持：函数调用、new、赋值、require、process 等。
   * 解析失败或包含不支持的语法时返回 false（fail-closed）。
   */
  private evaluateCondition(condition: string, context: Task["context"]): boolean {
    try {
      const trimmed = condition.trim();
      if (trimmed.length === 0) return true;
      // 安全：拒绝任何危险关键字
      if (/\b(require|process|global|globalThis|eval|Function|constructor|prototype|__proto__|window|document|import|export|new\s+|this\b)\b/.test(trimmed)) {
        process.stderr.write(`[DAGExecutor] Condition blocked: contains forbidden keyword\n`);
        return false;
      }
      return this.evalOrExpr(trimmed, context);
    } catch {
      // 解析失败视为 false，保证 fail-closed
      return false;
    }
  }

  private evalOrExpr(expr: string, context: Task["context"]): boolean {
    const parts = this.splitTopLevel(expr, "||");
    if (parts.length > 1) {
      return parts.some((p) => this.evalAndExpr(p.trim(), context));
    }
    return this.evalAndExpr(expr, context);
  }

  private evalAndExpr(expr: string, context: Task["context"]): boolean {
    const parts = this.splitTopLevel(expr, "&&");
    if (parts.length > 1) {
      return parts.every((p) => this.evalNotExpr(p.trim(), context));
    }
    return this.evalNotExpr(expr, context);
  }

  private evalNotExpr(expr: string, context: Task["context"]): boolean {
    const trimmed = expr.trim();
    if (trimmed.startsWith("!")) {
      return !this.evalNotExpr(trimmed.slice(1), context);
    }
    return this.evalComparison(trimmed, context);
  }

  private evalComparison(expr: string, context: Task["context"]): boolean {
    const trimmed = expr.trim();
    // 括号包裹
    if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
      return this.evalOrExpr(trimmed.slice(1, -1), context);
    }
    // 比较操作符（注意顺序：长操作符优先）
    const ops = ["===", "!==", "==", "!=", ">=", "<=", ">", "<"];
    for (const op of ops) {
      const idx = this.findTopLevelOp(trimmed, op);
      if (idx !== -1) {
        const left = this.evalValue(trimmed.slice(0, idx).trim(), context);
        const right = this.evalValue(trimmed.slice(idx + op.length).trim(), context);
        switch (op) {
          case "===": return left === right;
          case "!==": return left !== right;
          case "==": return left == right; // eslint-disable-line eqeqeq
          case "!=": return left != right; // eslint-disable-line eqeqeq
          case ">=": return (left as number) >= (right as number);
          case "<=": return (left as number) <= (right as number);
          case ">": return (left as number) > (right as number);
          case "<": return (left as number) < (right as number);
        }
      }
    }
    // 无操作符：取真值
    const val = this.evalValue(trimmed, context);
    return !!val;
  }

  /** 求值单个值：字面量或 context 字段路径访问 */
  private evalValue(expr: string, context: Task["context"]): unknown {
    const trimmed = expr.trim();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed === "null") return null;
    if (trimmed === "undefined") return undefined;
    // 数字字面量
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    // 字符串字面量（单引号或双引号）
    if (/^['"].*['"]$/.test(trimmed) && trimmed.length >= 2) {
      return trimmed.slice(1, -1);
    }
    // 标识符或属性路径：sessionId / userId / variables.foo / tags.length 等
    if (/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(trimmed)) {
      const path = trimmed.split(".");
      const root = path[0];
      // 仅允许 context 已知字段作为根标识符
      const allowedRoots = new Set(["sessionId", "userId", "workspace", "variables", "tags", "traceId"]);
      if (!allowedRoots.has(root)) {
        throw new Error(`Unknown identifier: ${root}`);
      }
      let current: unknown = (context as unknown as Record<string, unknown>)[root];
      for (let i = 1; i < path.length; i++) {
        if (current == null || typeof current !== "object") return undefined;
        current = (current as Record<string, unknown>)[path[i]];
      }
      return current;
    }
    throw new Error(`Unsupported value expression: ${expr}`);
  }

  /** 在顶层（不在括号或引号内）查找操作符位置 */
  private findTopLevelOp(expr: string, op: string): number {
    let depth = 0;
    let inStr: string | null = null;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (inStr) {
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === "'" || ch === '"') { inStr = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 0 && expr.substring(i, i + op.length) === op) {
        // 避免 == 匹配到 === 的前缀
        if ((op === "==" || op === "!=") && expr[i + 2] === "=") continue;
        return i;
      }
    }
    return -1;
  }

  /** 在顶层（不在括号或引号内）按分隔符拆分 */
  private splitTopLevel(expr: string, sep: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let inStr: string | null = null;
    let start = 0;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (inStr) {
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === "'" || ch === '"') { inStr = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 0 && expr.substring(i, i + sep.length) === sep) {
        parts.push(expr.slice(start, i));
        start = i + sep.length;
      }
    }
    parts.push(expr.slice(start));
    return parts;
  }

  private async executeNode(node: DAGNode, _context: Task["context"], abortSignal?: AbortSignal): Promise<unknown> {
    // 超时后提前终止，避免后台执行继续消耗资源
    if (abortSignal?.aborted) {
      throw new Error(`Node "${node.id}" execution aborted before start`);
    }
    if (node.skill) {
      const skillManager = this.registry.resolveService<{
        executeSkill(name: string, params: Record<string, unknown>): Promise<unknown>;
      }>("skillManager");

      if (skillManager) {
        const resultPromise = skillManager.executeSkill(node.skill, node.params);
        // 如果支持 abort 信号，在超时时将 promise 标记为已取消
        if (abortSignal) {
          const abortPromise = new Promise<never>((_resolve, reject) => {
            abortSignal.addEventListener("abort", () => {
              reject(new Error(`Node "${node.id}" aborted during skill execution`));
            }, { once: true });
          });
          return Promise.race([resultPromise, abortPromise]);
        }
        return resultPromise;
      }
    }

    return { executed: node.action, params: node.params };
  }

  /**
   * Compute execution levels for parallel execution.
   * Level 0 = nodes with no dependencies, Level 1 = nodes depending on level 0, etc.
   */
  private computeLevels(nodes: DAGNode[]): DAGNode[][] {
    const nodeMap = new Map<string, DAGNode>();
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const node of nodes) {
      nodeMap.set(node.id, node);
      if (!inDegree.has(node.id)) inDegree.set(node.id, 0);
      if (!adjacency.has(node.id)) adjacency.set(node.id, []);
    }

    for (const node of nodes) {
      for (const depId of node.dependencies) {
        // Skip dependencies that don't exist in the node list — they will be
        // handled as "waiting_dependency" during processNode execution.
        if (!nodeMap.has(depId)) continue;
        inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1);
        adjacency.get(depId)?.push(node.id);
      }
    }

    const levels: DAGNode[][] = [];
    let currentLevel: string[] = [];

    for (const [nodeId, degree] of inDegree) {
      if (degree === 0) currentLevel.push(nodeId);
    }

    const visitedCount = { value: 0 };

    while (currentLevel.length > 0) {
      levels.push(currentLevel.map((id) => nodeMap.get(id)!));
      visitedCount.value += currentLevel.length;

      const nextLevel: string[] = [];
      for (const nodeId of currentLevel) {
        for (const neighbor of adjacency.get(nodeId) || []) {
          const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
          inDegree.set(neighbor, newDegree);
          if (newDegree === 0) nextLevel.push(neighbor);
        }
      }
      currentLevel = nextLevel;
    }

    if (visitedCount.value !== nodes.length) {
      throw new Error("DAG contains a cycle, cannot execute");
    }

    return levels;
  }

  /**
   * Topological sort — kept for backward compatibility.
   */
  private topologicalSort(nodes: DAGNode[]): DAGNode[] {
    const levels = this.computeLevels(nodes);
    return levels.flat();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }
}
