/**
 * DurableTaskRunner — 可持久化、可恢复的超长任务引擎。
 *
 * 设计目标（对标用户诉求）：
 *   1. 任务「超时」不再是失败 —— 超时只意味着「先存个检查点，转入后台继续」。
 *   2. 任务可以跨进程重启 / 跨天继续：所有状态落盘到 data/durable-tasks/。
 *   3. 后台续跑由 resume driver 驱动（默认接入 AgentModelExecutor.chat 续跑模式），
 *      续跑时不再受软超时约束，只有在 maxIterations / 动态工具轮次耗尽或显式取消时才停止。
 *
 * 与既有设施的分工：
 *   - FileSystemCheckpointManager：文件级影子 git 快照（用于回滚），本模块不重复造轮子。
 *   - session-persistence：对话历史按轮增量落盘，本模块的「续跑」正是基于它重新加载历史。
 *   - QueueManager / TaskOrchestrator：通用任务队列，本模块聚焦「单会话超长 Agent 任务」的断点续跑。
 *
 * 关键约束：
 *   - 所有写盘使用「临时文件 + fsync + rename」原子写入，避免半截文件损坏。
 *   - 单进程内对同一任务只允许一个续跑在飞（activeResume 去重），防止并发续跑互相踩踏。
 *   - 永不抛出：所有内部错误降级为日志，保证主流程不被打断。
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export type DurableTaskStatus =
  | "running" // 续跑进行中
  | "paused" // 已存检查点、等待续跑（前台超时 / 浏览器关闭 / 迭代预算耗尽都会进入此态）
  | "completed" // 已给出最终结论
  | "failed" // 续跑抛错
  | "cancelled"; // 用户显式取消

export interface DurableTask {
  id: string;
  sessionId: string;
  channel: string;
  /** 用户原始请求（续跑时作为上下文注入，确保不偏离最初目标） */
  userRequest: string;
  status: DurableTaskStatus;
  createdAt: number;
  updatedAt: number;
  /** 上次检查点（暂停）时间 */
  checkpointAt?: number;
  completedAt?: number;
  /** 进度日志（续跑过程中逐步追加，供 /tasks 与前端展示） */
  progress: string[];
  /** 完成时的最终回复 */
  finalReply?: string;
  error?: string;
  /** 已续跑次数 */
  resumeCount: number;
}

/** 续跑驱动：接收任务，返回最终/阶段性回复。由调用方（AgentModelExecutor）注入。 */
export type ResumeDriver = (task: DurableTask) => Promise<string>;

/** 交付回调：把后台任务进展/完成事件发给会话（如 WebSocket broadcast）。 */
export type DeliverFn = (sessionId: string, event: string, payload: Record<string, unknown>) => void;

const TASKS_FILE = "index.json";

export class DurableTaskRunner {
  private tasks = new Map<string, DurableTask>();
  private storeFile: string;
  private resumeDriver?: ResumeDriver;
  private deliverFn?: DeliverFn;
  /** 正在续跑中的任务 id，去重防止并发续跑 */
  private activeResume = new Set<string>();
  private loaded = false;

  constructor(dataDir?: string) {
    const root = dataDir ?? path.resolve(process.cwd(), "data", "durable-tasks");
    this.storeFile = path.join(root, TASKS_FILE);
  }

  /** 注入续跑驱动（AgentModelExecutor 在 server wiring 时设置） */
  setResumeDriver(fn: ResumeDriver): void {
    this.resumeDriver = fn;
  }

  /** 注入交付回调（gateway 在 server wiring 时设置） */
  setDeliver(fn: DeliverFn): void {
    this.deliverFn = fn;
  }

  /** 确保在调用查询/写入前已加载持久化数据 */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.load();
    this.loaded = true;
  }

  /** 创建一个新的待续跑任务（paused 态） */
  create(userRequest: string, sessionId: string, channel: string): DurableTask {
    this.ensureLoaded();
    const now = Date.now();
    const task: DurableTask = {
      id: `dt-${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
      sessionId,
      channel,
      userRequest,
      status: "paused",
      createdAt: now,
      updatedAt: now,
      checkpointAt: now,
      progress: [],
      resumeCount: 0,
    };
    this.tasks.set(task.id, task);
    this.persist();
    return task;
  }

  get(id: string): DurableTask | undefined {
    this.ensureLoaded();
    return this.tasks.get(id);
  }

  list(sessionId?: string): DurableTask[] {
    this.ensureLoaded();
    const all = Array.from(this.tasks.values());
    const filtered = sessionId ? all.filter((t) => t.sessionId === sessionId) : all;
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 追加一条进度日志 */
  appendProgress(id: string, line: string): void {
    this.ensureLoaded();
    const task = this.tasks.get(id);
    if (!task) return;
    task.progress.push(`[${new Date().toISOString()}] ${line}`);
    // 限制进度条长度，避免无限增长
    if (task.progress.length > 200) {
      task.progress = task.progress.slice(-200);
    }
    task.updatedAt = Date.now();
    this.persist();
  }

  /** 标记为 running（续跑开始时） */
  markRunning(id: string): void {
    this.ensureLoaded();
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = "running";
    task.updatedAt = Date.now();
    this.persist();
  }

  /** 标记暂停并写入检查点时间 */
  pause(id: string): void {
    this.ensureLoaded();
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.status === "completed" || task.status === "cancelled") return;
    task.status = "paused";
    task.checkpointAt = Date.now();
    task.updatedAt = Date.now();
    this.persist();
  }

  /** 标记完成，并交付最终结果 */
  complete(id: string, reply: string): void {
    this.ensureLoaded();
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.status === "cancelled") return;
    task.status = "completed";
    task.finalReply = reply;
    task.completedAt = Date.now();
    task.updatedAt = Date.now();
    this.persist();
    this.deliverFn?.(task.sessionId, "durable_task_completed", {
      taskId: task.id,
      sessionId: task.sessionId,
      status: "completed",
      reply,
    });
  }

  /** 标记失败，并交付错误 */
  fail(id: string, error: string): void {
    this.ensureLoaded();
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.status === "cancelled" || task.status === "completed") return;
    task.status = "failed";
    task.error = error;
    task.updatedAt = Date.now();
    this.persist();
    this.deliverFn?.(task.sessionId, "durable_task_failed", {
      taskId: task.id,
      sessionId: task.sessionId,
      status: "failed",
      error,
    });
  }

  /** 用户显式取消 */
  cancel(id: string): boolean {
    this.ensureLoaded();
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status === "completed") return false;
    task.status = "cancelled";
    task.updatedAt = Date.now();
    this.persist();
    this.deliverFn?.(task.sessionId, "durable_task_cancelled", {
      taskId: task.id,
      sessionId: task.sessionId,
      status: "cancelled",
    });
    return true;
  }

  /**
   * 续跑一个任务（fire-and-forget 安全封装）。
   * 若已在续跑中则跳过；若无续跑驱动则直接 parked。
   */
  async resume(id: string): Promise<void> {
    this.ensureLoaded();
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.status === "completed" || task.status === "cancelled") return;
    if (!this.resumeDriver) {
      process.stderr.write(`[DurableTaskRunner] No resume driver set; task ${id} stays parked\n`);
      return;
    }
    if (this.activeResume.has(id)) {
      process.stdout.write(`[DurableTaskRunner] Task ${id} already resuming; skip\n`);
      return;
    }
    this.activeResume.add(id);
    this.markRunning(id);
    try {
      const reply = await this.resumeDriver(task);
      this.complete(id, reply);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[DurableTaskRunner] Resume of ${id} failed: ${msg}\n`);
      this.fail(id, msg);
    } finally {
      this.activeResume.delete(id);
    }
  }

  /**
   * 服务启动时调用：把所有 paused/running（含重启前在飞的）任务重新续跑。
   * 已终态（completed/failed/cancelled）的不动。
   */
  resumeAll(): void {
    this.ensureLoaded();
    const pending = this.list().filter(
      (t) => t.status === "paused" || t.status === "running",
    );
    if (pending.length === 0) return;
    process.stdout.write(`[DurableTaskRunner] Resuming ${pending.length} durable task(s) on startup\n`);
    for (const task of pending) {
      // running 态在重启后必然已中断，归位为 paused 再续跑
      if (task.status === "running") this.pause(task.id);
      void this.resume(task.id);
    }
  }

  /** 进程退出前等待在飞续跑完成（best-effort） */
  async drain(): Promise<void> {
    // 续跑是异步的，这里简单等待一段时间让其收尾；真正关键路径不依赖此。
    for (let i = 0; i < 50 && this.activeResume.size > 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // ── 持久化 ──────────────────────────────────────────────

  private load(): void {
    try {
      if (!fs.existsSync(this.storeFile)) return;
      const raw = fs.readFileSync(this.storeFile, "utf-8");
      const parsed = JSON.parse(raw) as DurableTask[];
      if (!Array.isArray(parsed)) return;
      for (const t of parsed) {
        // 重启后任何 running 视为已中断，交由 resumeAll 重新处理
        if (t.status === "running") t.status = "paused";
        this.tasks.set(t.id, t);
      }
      process.stdout.write(`[DurableTaskRunner] Loaded ${this.tasks.size} durable task(s)\n`);
    } catch (err) {
      process.stderr.write(`[DurableTaskRunner] Failed to load tasks: ${err}\n`);
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.storeFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.storeFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      const fd = fs.openSync(tmp, "w");
      try {
        fs.writeFileSync(fd, JSON.stringify(Array.from(this.tasks.values()), null, 2), "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.storeFile);
    } catch (err) {
      process.stderr.write(`[DurableTaskRunner] Failed to persist tasks: ${err}\n`);
    }
  }
}

// ── 单例（供 server wiring 与 executor 共享） ──

let singleton: DurableTaskRunner | null = null;

export function getDurableTaskRunner(dataDir?: string): DurableTaskRunner {
  if (!singleton) singleton = new DurableTaskRunner(dataDir);
  return singleton;
}

export function resetDurableTaskRunner(): void {
  singleton = null;
}
