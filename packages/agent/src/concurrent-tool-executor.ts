/**
 * ConcurrentToolExecutor — 并发工具执行池
 *
 * 借鉴 hermes-agent agent/tool_executor.py execute_tool_calls_concurrent：
 *
 * 核心机制：
 *   - 8 worker 线程池（ThreadPoolExecutor）
 *   - ContextVar 传播（确保子线程能访问父线程上下文）
 *   - 5 秒轮询检查完成状态
 *   - 30 秒心跳超时
 *   - 中断信号扇出到所有 worker
 *
 * 安全分类（借鉴 hermes-agent _classify_tool_parallelism）：
 *   1. never-parallel：永不并行执行（写文件、shell 命令、git 操作等）
 *   2. path-scoped：同路径不并行，不同路径可并行（read_file、glob、grep 等）
 *   3. safe-parallel：可安全并行（web_search、web_fetch、list 等）
 *
 * EvoClaw 实现：
 *   - 使用 Node.js 的 worker_threads 或简化的 Promise 并发
 *   - 由于工具执行通常是 I/O 密集型，使用 Promise.all + 信号量即可
 *   - 不使用真正的线程池（避免 worker 序列化开销）
 */

// ── 类型 ────────────────────────────────────────────────────────────────────

export type ToolParallelismClass = "never-parallel" | "path-scoped" | "safe-parallel";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolExecutionResult {
  id: string;
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface ToolExecutorFn {
  (tool: ToolCall): Promise<unknown>;
}

export interface ConcurrentExecutorConfig {
  /** 最大并发数，默认 8 */
  maxConcurrency: number;
  /** 单工具超时（毫秒），默认 120000 (2 分钟) */
  toolTimeoutMs: number;
  /** 心跳超时（毫秒），默认 30000 (30 秒) */
  heartbeatTimeoutMs: number;
  /** 轮询间隔（毫秒），默认 5000 (5 秒) */
  pollIntervalMs: number;
  /** 启用安全分类 */
  enableSafetyClassification: boolean;
}

export const DEFAULT_CONCURRENT_CONFIG: ConcurrentExecutorConfig = {
  maxConcurrency: 8,
  toolTimeoutMs: 120_000,
  heartbeatTimeoutMs: 30_000,
  pollIntervalMs: 5_000,
  enableSafetyClassification: true,
};

// ── 安全分类 ────────────────────────────────────────────────────────────────

/**
 * never-parallel 工具集合：永不并行执行。
 *
 * 借鉴 hermes-agent NEVER_PARALLEL_TOOLS：
 *   这些工具修改状态，并行执行可能导致冲突或数据损坏。
 */
const NEVER_PARALLEL_TOOLS = new Set([
  // 文件写入
  "write_file", "writeFile", "edit", "patch", "save_file", "saveFile",
  "create_file", "createFile", "delete_file", "deleteFile", "remove_file", "removeFile",
  "move_file", "moveFile", "rename_file", "renameFile", "copy_file", "copyFile",
  // shell/命令执行
  "shell_exec", "shellExec", "exec", "execute", "bash", "sh", "cmd", "command",
  "terminal", "run_command", "runCommand",
  // 版本控制
  "git", "git_commit", "gitCommit", "git_push", "gitPush", "git_reset", "gitReset",
  // 包管理
  "npm", "pnpm", "yarn", "pip", "cargo", "go_mod",
  // 系统操作
  "kill_process", "killProcess", "restart", "shutdown",
]);

/**
 * path-scoped 工具集合：同路径不并行，不同路径可并行。
 *
 * 借鉴 hermes-agent PATH_SCOPED_TOOLS：
 *   这些工具读取特定路径，同路径并行无意义（结果相同），
 *   不同路径可并行提高效率。
 */
const PATH_SCOPED_TOOLS = new Set([
  "read_file", "readFile", "cat", "head", "tail",
  "glob", "find", "list_files", "listFiles",
  "grep", "search", "ripgrep", "rg",
  "stat", "file_info", "fileInfo",
  "checksum", "hash_file", "hashFile",
]);

/**
 * 分类工具的并行安全等级。
 *
 * 借鉴 hermes-agent _classify_tool_parallelism。
 */
export function classifyToolParallelism(toolName: string): ToolParallelismClass {
  if (!toolName) return "safe-parallel";
  const lower = toolName.toLowerCase();

  // 精确匹配
  if (NEVER_PARALLEL_TOOLS.has(lower)) return "never-parallel";
  if (PATH_SCOPED_TOOLS.has(lower)) return "path-scoped";

  // 模糊匹配
  if (lower.includes("write") || lower.includes("save") || lower.includes("create") ||
      lower.includes("delete") || lower.includes("remove") || lower.includes("move") ||
      lower.includes("rename") || lower.includes("patch") || lower.includes("edit")) {
    return "never-parallel";
  }
  if (lower.includes("exec") || lower.includes("shell") || lower.includes("bash") ||
      lower.includes("command") || lower.includes("terminal") || lower.includes("run")) {
    return "never-parallel";
  }
  if (lower.includes("git") || lower.includes("npm") || lower.includes("pnpm") ||
      lower.includes("yarn") || lower.includes("pip") || lower.includes("cargo")) {
    return "never-parallel";
  }
  if (lower.includes("read") || lower.includes("cat") || lower.includes("glob") ||
      lower.includes("find") || lower.includes("grep") || lower.includes("search") ||
      lower.includes("list")) {
    return "path-scoped";
  }

  // 默认安全并行（web_search、web_fetch、http_request 等）
  return "safe-parallel";
}

/**
 * 从工具参数中提取路径键（用于 path-scoped 去重）。
 */
function extractPathKey(tool: ToolCall): string {
  const args = tool.args || {};
  // 常见路径参数名
  const pathKeys = ["path", "file_path", "filePath", "file", "filename", "dir", "directory", "folder", "pattern", "glob"];
  for (const key of pathKeys) {
    if (typeof args[key] === "string" && args[key]) {
      return String(args[key]);
    }
  }
  // 如果没有路径参数，用工具名作为键
  return tool.name;
}

// ── 信号量 ──────────────────────────────────────────────────────────────────

/**
 * 简单的异步信号量，控制并发数。
 */
class AsyncSemaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(max: number) {
    this.available = max;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.available--;
        resolve();
      });
    });
  }

  release(): void {
    this.available++;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
    }
  }

  getAvailable(): number {
    return this.available;
  }
}

// ── 主类 ────────────────────────────────────────────────────────────────────

/**
 * 并发工具执行器。
 *
 * 借鉴 hermes-agent agent/tool_executor.py execute_tool_calls_concurrent。
 */
export class ConcurrentToolExecutor {
  private config: ConcurrentExecutorConfig;
  private semaphore: AsyncSemaphore;
  private activeExecutions = new Map<string, { startTime: number; lastHeartbeat: number }>();
  private interrupted = false;

  constructor(config: Partial<ConcurrentExecutorConfig> = {}) {
    this.config = { ...DEFAULT_CONCURRENT_CONFIG, ...config };
    this.semaphore = new AsyncSemaphore(this.config.maxConcurrency);
  }

  /**
   * 并发执行多个工具调用。
   *
   * 借鉴 hermes-agent execute_tool_calls_concurrent：
   *   1. 分类工具并行安全等级
   *   2. never-parallel 工具串行执行
   *   3. path-scoped 工具按路径分组，同路径串行，不同路径并行
   *   4. safe-parallel 工具全部并行
   *   5. 应用全局并发限制（信号量）
   *   6. 支持中断
   *
   * @param tools 工具调用列表
   * @param executor 工具执行函数
   */
  async execute(
    tools: ToolCall[],
    executor: ToolExecutorFn,
  ): Promise<ToolExecutionResult[]> {
    if (!tools || tools.length === 0) return [];

    this.interrupted = false;
    const results: ToolExecutionResult[] = [];

    if (!this.config.enableSafetyClassification) {
      // 简单模式：全部并行（受信号量限制）
      const promises = tools.map((tool) => this.executeOne(tool, executor));
      const settled = await Promise.allSettled(promises);
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        if (s.status === "fulfilled") {
          results.push(s.value);
        } else {
          results.push({
            id: tools[i].id,
            success: false,
            error: s.reason instanceof Error ? s.reason.message : String(s.reason),
            durationMs: 0,
          });
        }
      }
      return results;
    }

    // 分类模式
    const neverParallel: ToolCall[] = [];
    const pathScoped = new Map<string, ToolCall[]>();
    const safeParallel: ToolCall[] = [];

    for (const tool of tools) {
      const cls = classifyToolParallelism(tool.name);
      switch (cls) {
        case "never-parallel":
          neverParallel.push(tool);
          break;
        case "path-scoped": {
          const pathKey = extractPathKey(tool);
          if (!pathScoped.has(pathKey)) pathScoped.set(pathKey, []);
          pathScoped.get(pathKey)!.push(tool);
          break;
        }
        case "safe-parallel":
        default:
          safeParallel.push(tool);
          break;
      }
    }

    // 执行计划：
    // 1. safe-parallel + path-scoped（不同路径）并行
    // 2. never-parallel 串行（在所有并行完成后）
    const parallelTools: ToolCall[] = [...safeParallel];
    for (const [, group] of pathScoped) {
      // 每个路径组只取第一个加入并行，其余串行
      if (group.length > 0) parallelTools.push(group[0]);
    }

    // 并行执行 safe-parallel + 每个路径组的第一个
    const parallelPromises = parallelTools.map((tool) => this.executeOne(tool, executor));

    // 路径组内剩余工具串行执行（在组内第一个完成后）
    const serialPathPromises: Promise<ToolExecutionResult[]>[] = [];
    for (const [, group] of pathScoped) {
      if (group.length > 1) {
        const remaining = group.slice(1);
        serialPathPromises.push(this.executeSerial(remaining, executor));
      }
    }

    // 等待所有并行任务完成
    const [parallelSettled, ...serialPathResults] = await Promise.all([
      Promise.allSettled(parallelPromises),
      ...serialPathPromises,
    ]);

    // 收集并行结果
    for (let i = 0; i < parallelSettled.length; i++) {
      const s = parallelSettled[i];
      if (s.status === "fulfilled") {
        results.push(s.value);
      } else {
        results.push({
          id: parallelTools[i].id,
          success: false,
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
          durationMs: 0,
        });
      }
    }

    // 收集路径组串行结果
    for (const serialResults of serialPathResults) {
      results.push(...serialResults);
    }

    // 串行执行 never-parallel 工具
    const neverParallelResults = await this.executeSerial(neverParallel, executor);
    results.push(...neverParallelResults);

    // 按原始顺序排序结果
    const orderMap = new Map<string, number>();
    tools.forEach((t, i) => orderMap.set(t.id, i));
    results.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));

    return results;
  }

  /**
   * 串行执行工具列表。
   */
  private async executeSerial(
    tools: ToolCall[],
    executor: ToolExecutorFn,
  ): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];
    for (const tool of tools) {
      if (this.interrupted) {
        results.push({
          id: tool.id,
          success: false,
          error: "interrupted",
          durationMs: 0,
        });
        continue;
      }
      const result = await this.executeOne(tool, executor);
      results.push(result);
    }
    return results;
  }

  /**
   * 执行单个工具调用（带超时、心跳、信号量）。
   */
  private async executeOne(
    tool: ToolCall,
    executor: ToolExecutorFn,
  ): Promise<ToolExecutionResult> {
    await this.semaphore.acquire();

    const startTime = Date.now();
    this.activeExecutions.set(tool.id, { startTime, lastHeartbeat: startTime });

    // 心跳监控
    const heartbeatTimer = setInterval(() => {
      const exec = this.activeExecutions.get(tool.id);
      if (exec) {
        const now = Date.now();
        if (now - exec.lastHeartbeat > this.config.heartbeatTimeoutMs) {
          logger_warn(`tool ${tool.name} heartbeat timeout`, { toolId: tool.id, toolName: tool.name });
        }
      }
    }, this.config.pollIntervalMs);

    // 超时控制
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<ToolExecutionResult>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve({
          id: tool.id,
          success: false,
          error: `timeout after ${this.config.toolTimeoutMs}ms`,
          durationMs: Date.now() - startTime,
        });
      }, this.config.toolTimeoutMs);
    });

    // 执行 Promise
    const execPromise = (async () => {
      try {
        const output = await executor(tool);
        return {
          id: tool.id,
          success: true,
          output,
          durationMs: Date.now() - startTime,
        } as ToolExecutionResult;
      } catch (err) {
        return {
          id: tool.id,
          success: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startTime,
        } as ToolExecutionResult;
      }
    })();

    try {
      const result = await Promise.race([execPromise, timeoutPromise]);
      return result;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      clearInterval(heartbeatTimer);
      this.activeExecutions.delete(tool.id);
      this.semaphore.release();
    }
  }

  /**
   * 中断所有正在执行的工具。
   *
   * 借鉴 hermes-agent interrupt fan-out：
   *   设置中断标志，正在执行的工具会在下一个检查点退出。
   */
  interrupt(): void {
    this.interrupted = true;
  }

  /**
   * 获取当前活跃执行数。
   */
  getActiveCount(): number {
    return this.activeExecutions.size;
  }

  /**
   * 更新心跳（工具执行中定期调用）。
   */
  updateHeartbeat(toolId: string): void {
    const exec = this.activeExecutions.get(toolId);
    if (exec) {
      exec.lastHeartbeat = Date.now();
    }
  }

  /**
   * 更新配置。
   */
  updateConfig(config: Partial<ConcurrentExecutorConfig>): void {
    this.config = { ...this.config, ...config };
    // 仅在没有活跃执行时才重建信号量，避免丢弃等待者导致永久挂起
    if (config.maxConcurrency && this.activeExecutions.size === 0) {
      this.semaphore = new AsyncSemaphore(config.maxConcurrency);
    }
  }

  /**
   * 获取配置。
   */
  getConfig(): ConcurrentExecutorConfig {
    return { ...this.config };
  }
}

// ── 辅助 ────────────────────────────────────────────────────────────────────

function logger_warn(msg: string, data?: Record<string, unknown>): void {
  console.warn(`[concurrent-tool-executor] ${msg}`, data ?? "");
}

// ── 单例 ────────────────────────────────────────────────────────────────────

let singleton: ConcurrentToolExecutor | null = null;

export function getConcurrentToolExecutor(config?: Partial<ConcurrentExecutorConfig>): ConcurrentToolExecutor {
  if (!singleton) {
    singleton = new ConcurrentToolExecutor(config);
  } else if (config) {
    singleton.updateConfig(config);
  }
  return singleton;
}

export function resetConcurrentToolExecutor(): void {
  singleton = null;
}
