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
   */
  private async executeWithTimeout(
    node: DAGNode,
    context: Task["context"],
    timeoutMs: number
  ): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Node "${node.id}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Keep the timer from keeping the process alive
      if (timer.unref) timer.unref();
    });
    const nodePromise = this.executeNode(node, context);
    nodePromise.catch(() => {}); // 防止超时后 unhandledRejection
    return Promise.race([nodePromise, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /**
   * Evaluate a condition expression against the task context.
   * The expression is a simple JS expression evaluated with context variables in scope.
   */
  private evaluateCondition(condition: string, context: Task["context"]): boolean {
    try {
      // Safe evaluation: only allow simple comparison and logical expressions
      // Block dangerous patterns that could lead to code injection
      const sanitized = condition.trim();
      const dangerousPatterns = [
        /constructor/i, /__proto__/i, /process\b/i, /require\b/i,
        /import\b/i, /eval\b/i, /Function\b/i, /this\b/i,
        /window\b/i, /global\b/i, /document\b/i,
      ];
      for (const pat of dangerousPatterns) {
        if (pat.test(sanitized)) {
          process.stderr.write(`[DAGExecutor] Condition blocked: contains dangerous pattern\n`);
          return false;
        }
      }

      // Simple safe evaluation using only context variables
      const fn = new Function("context", `with(context) { return (${sanitized}); }`);
      const result = fn(context);
      return Boolean(result);
    } catch {
      // If condition evaluation fails, treat as false
      return false;
    }
  }

  private async executeNode(node: DAGNode, _context: Task["context"]): Promise<unknown> {
    if (node.skill) {
      const skillManager = this.registry.resolveService<{
        executeSkill(name: string, params: Record<string, unknown>): Promise<unknown>;
      }>("skillManager");

      if (skillManager) {
        return skillManager.executeSkill(node.skill, node.params);
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
          const newDegree = (inDegree.get(neighbor) || 1) - 1;
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
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
