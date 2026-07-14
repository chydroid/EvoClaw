/**
 * WorkflowEngine — DAG 工作流引擎
 *
 * 对标 Devin 长程任务执行：节点 = 工具调用，边 = 依赖关系。
 *
 * 能力：
 *  - 条件分支（condition）
 *  - 并行节点（同层并行，受 maxConcurrency 限制）
 *  - 循环检测（DFS 三色标记）
 *  - 状态持久化（atomicWriteFile: temp + fsync + rename）
 *  - resume：从 checkpoint 跳过已成功节点，重试 failed / pending
 *
 * 设计：
 *  - 异常时返回 partial 状态，不让 execute 整体抛错
 *  - 失败节点的下游全部跳过（status=skipped），不阻塞同层其他节点
 *  - params 可以是函数：执行时传入 inputs（含上游节点输出 + workflow 级 inputs）
 */

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFile } from "@evoclaw/infrastructure";

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface WorkflowNode {
  /** 节点 ID，全局唯一 */
  id: string;
  /** 工具名（由 executorFn 解释） */
  toolName: string;
  /** 静态参数，或基于上游 inputs 动态生成参数的函数 */
  params:
    | Record<string, unknown>
    | ((inputs: Record<string, unknown>) => Record<string, unknown>);
  /** 依赖节点 ID 列表 */
  dependsOn: string[];
  /** 条件：返回 false 则跳过本节点 */
  condition?: (inputs: Record<string, unknown>) => boolean;
  /** 节点超时（毫秒） */
  timeoutMs?: number;
  /** 失败重试次数 */
  retries?: number;
}

export interface WorkflowEdge {
  from: string;
  to: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  /** workflow 级输入，会合并到每个节点的 inputs */
  inputs?: Record<string, unknown>;
}

export interface WorkflowNodeResult {
  nodeId: string;
  status: "pending" | "running" | "skipped" | "succeeded" | "failed";
  output?: unknown;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface WorkflowExecutionResult {
  workflowId: string;
  status: "running" | "succeeded" | "failed" | "partial";
  nodeResults: Map<string, WorkflowNodeResult>;
  totalDurationMs: number;
  /** workflow 级 + 运行时 inputs 合并结果，用于 checkpoint 持久化与 resume 回放 */
  inputs?: Record<string, unknown>;
}

export type WorkflowExecutorFn = (
  toolName: string,
  params: Record<string, unknown>,
  /**
   * 可选的取消信号。executeWithTimeout 超时后会 abort 此信号，
   * 让支持 AbortSignal 的执行器（如 fetch）能够真正取消底层操作。
   * 不支持信号的执行器可忽略此参数。Bug 9.1 修复。
   */
  signal?: AbortSignal,
) => Promise<unknown>;

export interface WorkflowEngineConfig {
  /** 同层最大并发数 */
  maxConcurrency?: number;
  /** 默认节点超时（毫秒） */
  defaultTimeoutMs?: number;
  /** 默认失败重试次数 */
  defaultRetries?: number;
  /** 持久化路径（execute 期间每完成一个节点都会更新此文件） */
  persistPath?: string;
}

// ── 内部工具 ────────────────────────────────────────────────────────────────

interface ResolvedConfig {
  maxConcurrency: number;
  defaultTimeoutMs: number;
  defaultRetries: number;
  persistPath?: string;
}

const DEFAULT_CONFIG: ResolvedConfig = {
  maxConcurrency: 4,
  defaultTimeoutMs: 30_000,
  defaultRetries: 0,
};

/** 休眠工具 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
  });
}

// ── 主类 ────────────────────────────────────────────────────────────────────

export class WorkflowEngine {
  private readonly executorFn: WorkflowExecutorFn;
  private readonly config: ResolvedConfig;

  constructor(executorFn: WorkflowExecutorFn, config?: WorkflowEngineConfig) {
    this.executorFn = executorFn;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      maxConcurrency: Math.max(1, config?.maxConcurrency ?? DEFAULT_CONFIG.maxConcurrency),
    };
  }

  // ── 校验 ──────────────────────────────────────────────────────────────────

  /**
   * 校验工作流定义：
   *  1. 节点 ID 唯一
   *  2. 依赖节点存在
   *  3. 无循环依赖（DFS 三色标记）
   */
  validate(workflow: WorkflowDefinition): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // 1. ID 唯一
    const ids = new Set<string>();
    for (const node of workflow.nodes) {
      if (ids.has(node.id)) {
        errors.push(`节点 ID 重复: ${node.id}`);
      }
      ids.add(node.id);
    }

    // 2. 依赖存在
    for (const node of workflow.nodes) {
      for (const dep of node.dependsOn) {
        if (!ids.has(dep)) {
          errors.push(`节点 ${node.id} 依赖不存在的节点: ${dep}`);
        }
      }
    }

    // 3. 循环检测（DFS 三色：0=white, 1=gray, 2=black）
    const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n]));
    const color = new Map<string, number>();
    for (const node of workflow.nodes) color.set(node.id, 0);
    let cycleFound = false;

    const dfs = (id: string, stack: string[]): void => {
      color.set(id, 1);
      stack.push(id);
      const node = nodeMap.get(id);
      if (node) {
        for (const dep of node.dependsOn) {
          if (!nodeMap.has(dep)) continue;
          const c = color.get(dep);
          if (c === 1) {
            // 发现环
            const startIdx = stack.indexOf(dep);
            const cycle = stack.slice(startIdx).concat(dep).join(" -> ");
            errors.push(`检测到循环依赖: ${cycle}`);
            cycleFound = true;
            return;
          }
          if (c === 0) {
            dfs(dep, stack);
            if (cycleFound) return;
          }
        }
      }
      stack.pop();
      color.set(id, 2);
    };

    for (const node of workflow.nodes) {
      if (color.get(node.id) === 0) {
        dfs(node.id, []);
        if (cycleFound) break;
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // ── 执行 ──────────────────────────────────────────────────────────────────

  /**
   * 执行工作流。
   *  - 拓扑排序后按层级执行
   *  - 同层节点并行（受 maxConcurrency 限制）
   *  - 失败节点的下游全部跳过
   *  - 配置了 persistPath 时每完成一个节点更新 checkpoint
   *  - 任何异常都返回 partial 状态，不抛错
   */
  async execute(
    workflow: WorkflowDefinition,
    inputs?: Record<string, unknown>,
  ): Promise<WorkflowExecutionResult> {
    const start = Date.now();
    const nodeResults = this.initNodeResults(workflow);
    const mergedInputs = { ...workflow.inputs, ...inputs };

    try {
      const validation = this.validate(workflow);
      if (!validation.valid) {
        // 校验失败：所有节点保持 pending，直接返回 partial
        for (const r of nodeResults.values()) {
          r.status = "failed";
          r.error = "工作流校验失败";
        }
        return this.buildResult(workflow, nodeResults, "partial", start, mergedInputs);
      }

      const levels = this.computeLevels(workflow);

      for (const level of levels) {
        await this.runLevel(workflow, level, nodeResults, mergedInputs);
      }

      const finalStatus = this.computeFinalStatus(nodeResults);
      const result = this.buildResult(workflow, nodeResults, finalStatus, start, mergedInputs);
      if (this.config.persistPath) {
        try {
          await this.saveCheckpoint(workflow, result, this.config.persistPath);
        } catch (err) {
          // 记录 checkpoint 写入错误，防止运维盲区（resume 时使用过期 checkpoint）
          process.stderr.write(`[WorkflowEngine] Failed to save checkpoint: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      return result;
    } catch (err) {
      // 兜底：异常时返回 partial
      const message = err instanceof Error ? err.message : String(err);
      for (const r of nodeResults.values()) {
        if (r.status === "running" || r.status === "pending") {
          r.status = "failed";
          r.error = r.error ?? message;
          if (!r.endedAt) r.endedAt = Date.now();
        }
      }
      return this.buildResult(workflow, nodeResults, "partial", start, mergedInputs);
    }
  }

  // ── Resume ────────────────────────────────────────────────────────────────

  /**
   * 从 checkpoint 恢复执行：
   *  - 加载已保存的 nodeResults
   *  - 跳过已 succeeded 的节点
   *  - 重新执行 failed 和 pending 的节点
   */
  async resume(
    workflow: WorkflowDefinition,
    checkpointPath: string,
  ): Promise<WorkflowExecutionResult> {
    const start = Date.now();
    const nodeResults = this.initNodeResults(workflow);
    // 默认使用 workflow.inputs；读到 checkpoint 后用 parsed.inputs 覆盖
    let resumeInputs: Record<string, unknown> = { ...workflow.inputs };

    try {
      // 校验：脏 workflow 定义（增删节点、引入环）需早失败
      const validation = this.validate(workflow);
      if (!validation.valid) {
        for (const r of nodeResults.values()) {
          r.status = "failed";
          r.error = "工作流校验失败";
        }
        return this.buildResult(workflow, nodeResults, "partial", start, resumeInputs);
      }

      // 加载 checkpoint
      const data = await fs.promises.readFile(checkpointPath, "utf-8");
      const parsed = JSON.parse(data) as {
        nodeResults?: Array<[string, WorkflowNodeResult]>;
        inputs?: Record<string, unknown>;
      };

      // 回放运行时 inputs：checkpoint 优先，workflow.inputs 兜底
      resumeInputs = { ...workflow.inputs, ...parsed.inputs };

      if (parsed.nodeResults && Array.isArray(parsed.nodeResults)) {
        for (const [id, r] of parsed.nodeResults) {
          // 已 succeeded 的节点保留状态，其余重置为 pending
          if (r && r.status === "succeeded") {
            nodeResults.set(id, r);
          } else {
            nodeResults.set(id, {
              nodeId: id,
              status: "pending",
            });
          }
        }
      }

      const levels = this.computeLevels(workflow);

      for (const level of levels) {
        // 跳过本层中已 succeeded 的节点
        const todo = level.filter((n) => nodeResults.get(n.id)?.status !== "succeeded");
        if (todo.length === 0) continue;
        await this.runLevel(workflow, todo, nodeResults, resumeInputs, true);
      }

      const finalStatus = this.computeFinalStatus(nodeResults);
      const result = this.buildResult(workflow, nodeResults, finalStatus, start, resumeInputs);
      if (this.config.persistPath) {
        try {
          await this.saveCheckpoint(workflow, result, this.config.persistPath);
        } catch { /* ignore */ }
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const r of nodeResults.values()) {
        if (r.status === "running" || r.status === "pending") {
          r.status = "failed";
          r.error = r.error ?? message;
          if (!r.endedAt) r.endedAt = Date.now();
        }
      }
      return this.buildResult(workflow, nodeResults, "partial", start, resumeInputs);
    }
  }

  // ── Checkpoint 持久化 ─────────────────────────────────────────────────────

  /**
   * 保存 checkpoint 到指定路径。
   * Map 序列化为 [key, value] 元组数组，便于 JSON 表示。
   */
  async saveCheckpoint(
    workflow: WorkflowDefinition,
    result: WorkflowExecutionResult,
    checkpointPath: string,
  ): Promise<void> {
    const payload = {
      workflowId: result.workflowId,
      workflowName: workflow.name,
      status: result.status,
      nodeResults: Array.from(result.nodeResults.entries()),
      totalDurationMs: result.totalDurationMs,
      inputs: result.inputs ?? {},
      savedAt: Date.now(),
    };
    const content = JSON.stringify(payload, null, 2);
    await atomicWriteFile(checkpointPath, content);
  }

  // ── 私有：执行细节 ────────────────────────────────────────────────────────

  /** 初始化所有节点为 pending */
  private initNodeResults(workflow: WorkflowDefinition): Map<string, WorkflowNodeResult> {
    const map = new Map<string, WorkflowNodeResult>();
    for (const node of workflow.nodes) {
      map.set(node.id, { nodeId: node.id, status: "pending" });
    }
    return map;
  }

  /**
   * 拓扑排序：按依赖层级分组。
   * 同层节点互不依赖，可以并行执行。
   */
  private computeLevels(workflow: WorkflowDefinition): WorkflowNode[][] {
    const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n]));
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const node of workflow.nodes) {
      // 过滤掉不存在于 workflow.nodes 中的依赖项，避免 inDegree 永远无法递减到 0 导致节点被静默跳过
      // （参照 dag-executor.ts 的 computeLevels 实现）
      const validDeps = node.dependsOn.filter((dep) => nodeMap.has(dep));
      inDegree.set(node.id, validDeps.length);
      for (const dep of validDeps) {
        if (!dependents.has(dep)) dependents.set(dep, []);
        dependents.get(dep)!.push(node.id);
      }
    }

    const levels: WorkflowNode[][] = [];
    // 初始层：使用过滤后的 inDegree 判断（依赖项全部不存在的节点 inDegree 为 0，应进入初始层）
    let current = workflow.nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);

    while (current.length > 0) {
      levels.push(current);
      const next: WorkflowNode[] = [];
      for (const node of current) {
        for (const dependent of dependents.get(node.id) ?? []) {
          const newDeg = (inDegree.get(dependent) ?? 0) - 1;
          inDegree.set(dependent, newDeg);
          if (newDeg === 0) next.push(nodeMap.get(dependent)!);
        }
      }
      current = next;
    }

    return levels;
  }

  /**
   * 执行一层节点：
   *  - 检查上游是否失败/跳过 → 跳过本节点
   *  - 调用 condition → false 则跳过
   *  - 受 maxConcurrency 限制并行执行
   */
  private async runLevel(
    workflow: WorkflowDefinition,
    level: WorkflowNode[],
    nodeResults: Map<string, WorkflowNodeResult>,
    workflowInputs: Record<string, unknown>,
    skipSucceeded = false,
  ): Promise<void> {
    type Task = { node: WorkflowNode; inputs: Record<string, unknown> };
    const tasks: Task[] = [];

    for (const node of level) {
      if (skipSucceeded && nodeResults.get(node.id)?.status === "succeeded") continue;

      // 上游失败/跳过 → 本节点跳过
      const upstreamBad = node.dependsOn.some((dep) => {
        const r = nodeResults.get(dep);
        return r?.status === "failed" || r?.status === "skipped";
      });
      if (upstreamBad) {
        const r = nodeResults.get(node.id)!;
        r.status = "skipped";
        continue;
      }

      // 收集 inputs
      const inputs = this.gatherInputs(workflow, node, nodeResults, workflowInputs);

      // condition 检查：用户函数抛错时仅跳过本节点，不影响其他节点
      let condOk = true;
      if (node.condition) {
        try {
          condOk = node.condition(inputs);
        } catch (err) {
          const r = nodeResults.get(node.id)!;
          r.status = "skipped";
          r.error = `condition threw: ${err instanceof Error ? err.message : String(err)}`;
          r.endedAt = Date.now();
          continue;
        }
      }
      if (!condOk) {
        const r = nodeResults.get(node.id)!;
        r.status = "skipped";
        continue;
      }

      tasks.push({ node, inputs });
    }

    // 并发执行
    await this.runWithConcurrency(workflow, tasks, nodeResults, workflowInputs);
  }

  /** 汇总节点 inputs：workflow 级 inputs + 上游 succeeded 节点的 output */
  private gatherInputs(
    workflow: WorkflowDefinition,
    node: WorkflowNode,
    nodeResults: Map<string, WorkflowNodeResult>,
    workflowInputs: Record<string, unknown>,
  ): Record<string, unknown> {
    const inputs: Record<string, unknown> = { ...workflowInputs };
    for (const dep of node.dependsOn) {
      const r = nodeResults.get(dep);
      if (r?.status === "succeeded" && r.output !== undefined) {
        inputs[dep] = r.output;
      }
    }
    return inputs;
  }

  /** 受 maxConcurrency 限制的并发执行器 */
  private async runWithConcurrency(
    workflow: WorkflowDefinition,
    tasks: Array<{ node: WorkflowNode; inputs: Record<string, unknown> }>,
    nodeResults: Map<string, WorkflowNodeResult>,
    workflowInputs: Record<string, unknown>,
  ): Promise<void> {
    if (tasks.length === 0) return;
    const concurrency = Math.min(this.config.maxConcurrency, tasks.length);
    const queue = [...tasks];

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const task = queue.shift();
        if (!task) break;
        await this.runNode(workflow, task.node, task.inputs, nodeResults, workflowInputs);
      }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
  }

  /** 执行单个节点：处理 timeout、retries、状态更新、checkpoint 持久化 */
  private async runNode(
    workflow: WorkflowDefinition,
    node: WorkflowNode,
    inputs: Record<string, unknown>,
    nodeResults: Map<string, WorkflowNodeResult>,
    workflowInputs: Record<string, unknown>,
  ): Promise<void> {
    const result = nodeResults.get(node.id)!;
    result.status = "running";
    result.startedAt = Date.now();
    result.error = undefined;

    try {
      // 解析 params（可能是函数）
      const params =
        typeof node.params === "function"
          ? node.params(inputs)
          : node.params;

      const output = await this.executeWithTimeoutAndRetries(
        node.toolName,
        params,
        node.timeoutMs ?? this.config.defaultTimeoutMs,
        node.retries ?? this.config.defaultRetries,
      );

      result.status = "succeeded";
      result.output = output;
    } catch (err) {
      result.status = "failed";
      result.error = err instanceof Error ? err.message : String(err);
    } finally {
      result.endedAt = Date.now();
      // 每完成一个节点更新 checkpoint
      if (this.config.persistPath) {
        try {
          const snapshot = this.buildResult(
            workflow,
            nodeResults,
            "running",
            0,
            workflowInputs,
          );
          await this.saveCheckpoint(workflow, snapshot, this.config.persistPath);
        } catch { /* ignore checkpoint errors */ }
      }
    }
  }

  /** 带 timeout 和 retries 的执行 */
  private async executeWithTimeoutAndRetries(
    toolName: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    retries: number,
  ): Promise<unknown> {
    let lastErr: unknown;
    const maxAttempts = Math.max(1, retries + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.executeWithTimeout(toolName, params, timeoutMs);
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts - 1) {
          // 简单线性退避（10ms * attempt），不引入复杂 backoff
          await sleep(10 * (attempt + 1));
        }
      }
    }
    throw lastErr;
  }

  /** 带超时的单次执行 */
  private async executeWithTimeout(
    toolName: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    // Bug 9.1 修复：原实现仅 race 超时，超时后底层操作仍在后台执行
    // （execPromise.catch 静默吞掉错误）。改为创建 AbortController，
    // 超时后调用 abort 让支持 AbortSignal 的执行器能真正取消底层操作。
    // 不支持信号的执行器会忽略此参数，行为与原实现一致。
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          timedOut = true;
          // abort 底层操作（若执行器支持）
          try { controller.abort(); } catch { /* ignore */ }
          reject(new Error(`节点执行超时 (${timeoutMs}ms)`));
        },
        timeoutMs,
      );
      if (timer.unref) timer.unref();
    });
    const execPromise = this.executorFn(toolName, params, controller.signal);
    execPromise.catch(() => {}); // 防止超时后 unhandledRejection
    try {
      return await Promise.race([
        execPromise,
        timeoutPromise,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      // 若执行器先完成（非超时），也 abort 信号以释放底层资源
      // （如 fetch AbortController 会清理连接）
      if (!timedOut) {
        try { controller.abort(); } catch { /* ignore */ }
      }
    }
  }

  /** 根据 nodeResults 计算最终状态 */
  private computeFinalStatus(
    nodeResults: Map<string, WorkflowNodeResult>,
  ): "succeeded" | "failed" | "partial" {
    let failed = 0;
    let succeeded = 0;
    for (const r of nodeResults.values()) {
      if (r.status === "failed") failed++;
      else if (r.status === "succeeded") succeeded++;
    }
    if (failed === 0) return "succeeded";
    if (succeeded === 0) return "failed";
    return "partial";
  }

  /** 构造 WorkflowExecutionResult */
  private buildResult(
    workflow: WorkflowDefinition,
    nodeResults: Map<string, WorkflowNodeResult>,
    status: WorkflowExecutionResult["status"],
    start: number,
    inputs?: Record<string, unknown>,
  ): WorkflowExecutionResult {
    return {
      workflowId: workflow.id,
      status,
      nodeResults,
      totalDurationMs: start === 0 ? 0 : Date.now() - start,
      inputs,
    };
  }
}
