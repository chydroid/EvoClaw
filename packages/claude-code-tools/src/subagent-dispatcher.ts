/**
 * Sub-Agent Dispatcher — 分层任务委派
 *
 * 借鉴 Claude SDK 的子代理机制：
 *   - Fork 模式: 子代理继承父代理的完整上下文 + 共享缓存（适合研究/分析任务）
 *   - Fresh 模式: 子代理零上下文启动 + 独立缓存（适合独立审查/验证任务）
 *   - Aggregate: 收集多个子代理的结果并合并
 *
 * 参考: https://code.claude.com/docs/en/agent-sdk/subagents
 */

// ── Types ──

export enum DispatchMode {
  /** Fork: inherit parent context (for research/analysis) */
  Fork = "fork",
  /** Fresh: zero context, independent (for review/audit) */
  Fresh = "fresh",
}

export interface SubAgentTask {
  /** Task identifier */
  id: string;
  /** Human-readable task description */
  description: string;
  /** The prompt to send to the sub-agent */
  prompt: string;
  /** Dispatch mode */
  mode: DispatchMode;
  /** Sub-agent type/role hint (e.g. "code-reviewer", "bug-hunter") */
  agentType?: string;
  /** Allowed tools for this sub-agent */
  allowedTools?: string[];
  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Priority (lower = higher priority) */
  priority?: number;
  /** Extra context to inject (Fresh mode only) */
  injectedContext?: string;
}

export interface SubAgentResult {
  /** Task ID */
  taskId: string;
  /** Whether the task succeeded */
  success: boolean;
  /** Result content */
  output: string;
  /** Error message if failed */
  error?: string;
  /** Tokens consumed */
  tokensUsed: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Structured findings (optional) */
  findings?: Record<string, unknown>;
}

/** A callback that executes a sub-agent task */
export type SubAgentExecutor = (task: SubAgentTask) => Promise<SubAgentResult>;

// ── Dispatcher ──

export class SubAgentDispatcher {
  private executor: SubAgentExecutor;
  private activeTasks = new Map<string, AbortController>();

  constructor(executor: SubAgentExecutor) {
    this.executor = executor;
  }

  /**
   * Dispatch a single sub-agent task.
   */
  async dispatch(task: SubAgentTask): Promise<SubAgentResult> {
    const controller = new AbortController();
    this.activeTasks.set(task.id, controller);

    const startTime = Date.now();
    const timeout = task.timeoutMs ?? 30000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const result = await this.executor(task);
      return result;
    } catch (err) {
      return {
        taskId: task.id,
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
        tokensUsed: 0,
        durationMs: Date.now() - startTime,
      };
    } finally {
      clearTimeout(timer);
      this.activeTasks.delete(task.id);
    }
  }

  /**
   * Dispatch multiple sub-agent tasks in parallel, respecting priority order.
   * Results are aggregated and returned in FIFO order.
   */
  async dispatchAll(tasks: SubAgentTask[]): Promise<SubAgentResult[]> {
    // Sort by priority (lower = higher)
    const sorted = [...tasks].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

    const results = await Promise.allSettled(
      sorted.map((task) => this.dispatch(task)),
    );

    return results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return {
        taskId: sorted[i].id,
        success: false,
        output: "",
        error: "Sub-agent dispatch rejected",
        tokensUsed: 0,
        durationMs: 0,
      };
    });
  }

  /**
   * Dispatch sub-agents sequentially — each one sees the accumulated results.
   * Useful for tasks where later sub-agents depend on earlier findings.
   */
  async dispatchSequential(tasks: SubAgentTask[]): Promise<SubAgentResult[]> {
    const results: SubAgentResult[] = [];
    for (const task of tasks) {
      // Inject prior results into Fresh-mode tasks
      if (task.mode === DispatchMode.Fresh && results.length > 0) {
        const priorSummary = results
          .filter((r) => r.success)
          .map((r) => `[${r.taskId}]: ${r.output.substring(0, 200)}`)
          .join("\n");
        if (priorSummary) {
          task.injectedContext = (task.injectedContext ?? "") + `\n[Prior results]\n${priorSummary}`;
        }
      }
      const result = await this.dispatch(task);
      results.push(result);
    }
    return results;
  }

  /**
   * Cancel a running sub-agent task.
   */
  cancel(taskId: string): boolean {
    const controller = this.activeTasks.get(taskId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  /**
   * Cancel all running sub-agent tasks.
   */
  cancelAll(): void {
    for (const [, controller] of this.activeTasks) {
      controller.abort();
    }
    this.activeTasks.clear();
  }

  /**
   * Aggregate results: produce a summary and detect consensus/conflicts.
   * (Claude SDK pattern: collect sub-agent outputs and merge)
   */
  aggregate(results: SubAgentResult[]): {
    summary: string;
    successCount: number;
    failureCount: number;
    conflicts: string[];
    consensus: string[];
  } {
    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.length - successCount;
    const conflicts: string[] = [];
    const consensus: string[] = [];

    // Detect conflicting findings
    const findings: Map<string, string[]> = new Map();
    for (const r of results) {
      if (r.findings) {
        for (const [key, value] of Object.entries(r.findings)) {
          const existing = findings.get(key);
          if (existing) {
            existing.push(String(value));
          } else {
            findings.set(key, [String(value)]);
          }
        }
      }
    }
    for (const [key, values] of findings) {
      const unique = new Set(values);
      if (unique.size === 1) {
        consensus.push(`${key}: ${values[0]}`);
      } else {
        conflicts.push(`${key}: [${Array.from(unique).join(" vs ")}]`);
      }
    }

    const summary = [
      `${successCount}/${results.length} tasks succeeded`,
      consensus.length > 0 ? `Consensus: ${consensus.join("; ")}` : "",
      conflicts.length > 0 ? `⚠ Conflicts: ${conflicts.join("; ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return { summary, successCount, failureCount, conflicts, consensus };
  }
}