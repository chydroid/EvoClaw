/**
 * KanbanBoard — 持久化 SQLite 多 Agent 工作队列看板
 *
 * 借鉴 hermes-agent Kanban 插件设计：
 *   - Board 是硬边界（任务严格归属单个 board）
 *   - Tenant 是软命名空间（可选过滤字段）
 *   - Dispatcher 长期循环回收 stale claims + 推进 ready 任务
 *
 * 状态机：
 *   pending → ready（依赖满足）→ claimed（被 Agent 领取）→ in_progress → review → done
 *            或 → blocked → pending
 *            或 → failed
 *
 * 实现要点：
 *   - better-sqlite3 同步 API，通过 createRequire 懒加载（agent 包不直接引入原生依赖）
 *   - 乐观锁领取（UPDATE ... WHERE status='ready' AND assigned_agent IS NULL）
 *   - crypto.randomUUID 生成任务 ID
 *   - Dispatcher 定时器 unref()，不阻止进程退出
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EventBus, ServiceRegistry } from "@evoclaw/core";

// ── SQLite 接口子集（与 better-sqlite3 兼容，避免编译期引入原生依赖） ──

interface KanbanStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid?: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface KanbanSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): KanbanStatement;
  pragma?(sql: string): unknown;
  close(): void;
}

// ── 类型定义 ────────────────────────────────────────────────

export type TaskStatus =
  | "pending"
  | "ready"
  | "claimed"
  | "in_progress"
  | "review"
  | "done"
  | "blocked"
  | "failed";

export type TaskPriority = "high" | "medium" | "low";

export interface Task {
  id: string;
  boardId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgent: string | null;
  dependencies: string[];
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  result: unknown;
  error: string | null;
  tenant: string | null;
}

export interface TaskInput {
  title: string;
  description: string;
  priority?: TaskPriority;
  dependencies?: string[];
  tenant?: string;
}

export interface BoardStats {
  total: number;
  byStatus: Record<TaskStatus, number>;
  byPriority: { high: number; medium: number; low: number };
}

export interface DispatchResult {
  reclaimed: string[];
  promoted: string[];
}

// ── 内部 Row schema ────────────────────────────────────────

interface TaskRow {
  id: string;
  board_id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assigned_agent: string | null;
  dependencies: string;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  result: string | null;
  error: string | null;
  tenant: string | null;
}

const ALL_STATUSES: TaskStatus[] = [
  "pending", "ready", "claimed", "in_progress", "review", "done", "blocked", "failed",
];

const SERVICE_NAME = "kanbanBoard";

function nowIso(): string {
  return new Date().toISOString();
}

// ── KanbanBoard ─────────────────────────────────────────────

export class KanbanBoard {
  private db: KanbanSqliteDb | null = null;
  private dispatcherTimer: ReturnType<typeof setInterval> | null = null;
  private eventSubIds: string[] = [];
  private registered = false;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    private dbPath: string,
  ) {}

  // ── 生命周期 ───────────────────────────────────────────

  async init(): Promise<void> {
    if (this.db) return;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    // 懒加载 better-sqlite3（项目根级可选依赖；agent 包不直接声明以避免原生依赖耦合）。
    // require 在 CommonJS 输出中是全局可用，返回 any 故需断言到 KanbanSqliteDb 构造器。
    const Database = require("better-sqlite3") as { new (path: string): KanbanSqliteDb };
    this.db = new Database(this.dbPath);
    this.db.pragma?.("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kanban_boards (
        board_id   TEXT PRIMARY KEY,
        tenant     TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kanban_tasks (
        id             TEXT PRIMARY KEY,
        board_id       TEXT NOT NULL,
        title          TEXT NOT NULL,
        description    TEXT NOT NULL DEFAULT '',
        status         TEXT NOT NULL,
        priority       TEXT NOT NULL,
        assigned_agent TEXT,
        dependencies   TEXT NOT NULL DEFAULT '[]',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        claimed_at     TEXT,
        completed_at   TEXT,
        result         TEXT,
        error          TEXT,
        tenant         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_kanban_tasks_board ON kanban_tasks(board_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_tasks_board_status ON kanban_tasks(board_id, status);
      CREATE INDEX IF NOT EXISTS idx_kanban_tasks_assigned ON kanban_tasks(assigned_agent);
      CREATE INDEX IF NOT EXISTS idx_kanban_tasks_status ON kanban_tasks(status);
    `);

    // 注册到 ServiceRegistry（幂等：已注册则跳过）
    if (!this.registry.hasService(SERVICE_NAME)) {
      this.registry.registerService(SERVICE_NAME, this);
      this.registered = true;
    }

    // 订阅 agent 生命周期事件做清理
    const stoppedSub = this.eventBus.subscribe("agent.stopped", async (event) => {
      const agentId = (event.data as { agentId?: string }).agentId;
      if (agentId) {
        try {
          await this.releaseAgentTasks(agentId);
        } catch {
          /* 事件处理失败不应影响发布方 */
        }
      }
    });
    this.eventSubIds.push(stoppedSub.id);

    const spawnedSub = this.eventBus.subscribe("agent.spawned", async () => {
      // 预留 hook：agent 上线时可触发一次 dispatch cycle
    });
    this.eventSubIds.push(spawnedSub.id);
  }

  close(): void {
    this.stopDispatcher();
    for (const id of this.eventSubIds) {
      try {
        this.eventBus.unsubscribe(id);
      } catch {
        /* ignore */
      }
    }
    this.eventSubIds = [];
    if (this.registered) {
      this.registry.unregisterService(SERVICE_NAME);
      this.registered = false;
    }
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      this.db = null;
    }
  }

  // ── Board 管理 ─────────────────────────────────────────

  async createBoard(boardId: string, options?: { tenant?: string }): Promise<void> {
    const db = this.requireDb();
    db.prepare(
      `INSERT OR IGNORE INTO kanban_boards (board_id, tenant, created_at) VALUES (?, ?, ?)`,
    ).run(boardId, options?.tenant ?? null, nowIso());
    await this.eventBus.publish("kanban.board_created", { boardId, tenant: options?.tenant ?? null }, "kanban");
  }

  async deleteBoard(boardId: string): Promise<void> {
    const db = this.requireDb();
    db.prepare(`DELETE FROM kanban_tasks WHERE board_id = ?`).run(boardId);
    db.prepare(`DELETE FROM kanban_boards WHERE board_id = ?`).run(boardId);
    await this.eventBus.publish("kanban.board_deleted", { boardId }, "kanban");
  }

  /** 列出所有看板（按创建时间升序） */
  listBoards(): Array<{ boardId: string; tenant: string | null; createdAt: string }> {
    const db = this.requireDb();
    const rows = db
      .prepare(`SELECT board_id, tenant, created_at FROM kanban_boards ORDER BY created_at ASC`)
      .all() as Array<{ board_id: string; tenant: string | null; created_at: string }>;
    return rows.map((r) => ({ boardId: r.board_id, tenant: r.tenant, createdAt: r.created_at }));
  }

  // ── 任务 CRUD ──────────────────────────────────────────

  async addTask(boardId: string, task: TaskInput): Promise<Task> {
    const db = this.requireDb();
    // Board 必须存在（硬边界）
    const board = db.prepare(`SELECT board_id FROM kanban_boards WHERE board_id = ?`).get(boardId);
    if (!board) {
      throw new Error(`Board "${boardId}" does not exist`);
    }
    const id = randomUUID();
    const deps = task.dependencies ?? [];
    const priority: TaskPriority = task.priority ?? "medium";
    const ts = nowIso();
    // 新任务始终从 pending 开始；dispatch cycle 负责推进到 ready
    db.prepare(
      `INSERT INTO kanban_tasks
        (id, board_id, title, description, status, priority, assigned_agent,
         dependencies, created_at, updated_at, claimed_at, completed_at, result, error, tenant)
       VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
    ).run(
      id,
      boardId,
      task.title,
      task.description ?? "",
      priority,
      JSON.stringify(deps),
      ts,
      ts,
      task.tenant ?? null,
    );
    const inserted = this.getTask(id);
    if (!inserted) {
      throw new Error(`Failed to insert task "${id}"`);
    }
    await this.eventBus.publish("kanban.task_added", { taskId: id, boardId, title: task.title }, "kanban");
    return inserted;
  }

  async updateTask(taskId: string, updates: Partial<Task>): Promise<Task> {
    const db = this.requireDb();
    const existing = this.getTask(taskId);
    if (!existing) {
      throw new Error(`Task "${taskId}" not found`);
    }
    const allowed: Array<keyof Task> = [
      "title", "description", "status", "priority", "assignedAgent", "dependencies", "tenant",
    ];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of allowed) {
      if (updates[key] === undefined) continue;
      const value = updates[key];
      switch (key) {
        case "title":
          sets.push("title = ?");
          params.push(String(value));
          break;
        case "description":
          sets.push("description = ?");
          params.push(String(value));
          break;
        case "status":
          sets.push("status = ?");
          params.push(String(value));
          break;
        case "priority":
          sets.push("priority = ?");
          params.push(String(value));
          break;
        case "assignedAgent":
          sets.push("assigned_agent = ?");
          params.push(value === null ? null : String(value));
          break;
        case "dependencies":
          sets.push("dependencies = ?");
          params.push(JSON.stringify(Array.isArray(value) ? value : []));
          break;
        case "tenant":
          sets.push("tenant = ?");
          params.push(value === null ? null : String(value));
          break;
        default:
          break;
      }
    }
    if (sets.length === 0) return existing;
    sets.push("updated_at = ?");
    params.push(nowIso());
    params.push(taskId);
    db.prepare(`UPDATE kanban_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    const updated = this.getTask(taskId);
    if (!updated) {
      throw new Error(`Task "${taskId}" disappeared after update`);
    }
    await this.eventBus.publish("kanban.task_updated", { taskId, boardId: updated.boardId }, "kanban");
    return updated;
  }

  // ── 领取 / 心跳 / 完成 / 失败 ─────────────────────────

  async claimTask(agentId: string, taskId: string): Promise<Task> {
    const db = this.requireDb();
    const ts = nowIso();
    // 乐观锁：仅当 status='ready' 且 assigned_agent IS NULL 时才能领取
    const result = db.prepare(
      `UPDATE kanban_tasks
       SET status = 'claimed', assigned_agent = ?, claimed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'ready' AND assigned_agent IS NULL`,
    ).run(agentId, ts, ts, taskId);
    if (result.changes === 0) {
      // 区分：任务不存在 vs 不在 ready 状态 vs 已被领取
      const row = this.getTask(taskId);
      if (!row) throw new Error(`Task "${taskId}" not found`);
      throw new Error(
        `Cannot claim task "${taskId}": current status="${row.status}", assignedAgent=${row.assignedAgent ?? "null"}`,
      );
    }
    const claimed = this.getTask(taskId);
    if (!claimed) throw new Error(`Task "${taskId}" disappeared after claim`);
    await this.eventBus.publish(
      "kanban.task_claimed",
      { taskId, agentId, boardId: claimed.boardId },
      "kanban",
    );
    return claimed;
  }

  async heartbeat(agentId: string, taskId: string): Promise<void> {
    const db = this.requireDb();
    const ts = nowIso();
    const result = db.prepare(
      `UPDATE kanban_tasks SET claimed_at = ?, updated_at = ?
       WHERE id = ? AND assigned_agent = ? AND status IN ('claimed', 'in_progress')`,
    ).run(ts, ts, taskId, agentId);
    if (result.changes === 0) {
      const row = this.getTask(taskId);
      if (!row) throw new Error(`Task "${taskId}" not found`);
      throw new Error(
        `Heartbeat rejected: task "${taskId}" not claimed by agent "${agentId}" (status=${row.status})`,
      );
    }
  }

  async completeTask(taskId: string, result: unknown): Promise<Task> {
    const db = this.requireDb();
    const ts = nowIso();
    const res = db.prepare(
      `UPDATE kanban_tasks
       SET status = 'done', result = ?, completed_at = ?, updated_at = ?, error = NULL
       WHERE id = ? AND status IN ('claimed', 'in_progress', 'review')`,
    ).run(JSON.stringify(result === undefined ? null : result), ts, ts, taskId);
    if (res.changes === 0) {
      const row = this.getTask(taskId);
      if (!row) throw new Error(`Task "${taskId}" not found`);
      throw new Error(`Cannot complete task "${taskId}" from status="${row.status}"`);
    }
    const completed = this.getTask(taskId);
    if (!completed) throw new Error(`Task "${taskId}" disappeared after completion`);
    // 推进依赖此任务的 pending 任务 → ready（依赖满足后自动 ready）
    await this.promoteDependents(completed.boardId, taskId);
    await this.eventBus.publish(
      "kanban.task_completed",
      { taskId, boardId: completed.boardId },
      "kanban",
    );
    return completed;
  }

  async failTask(taskId: string, error: string): Promise<Task> {
    const db = this.requireDb();
    const ts = nowIso();
    const res = db.prepare(
      `UPDATE kanban_tasks
       SET status = 'failed', error = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'ready', 'claimed', 'in_progress', 'review')`,
    ).run(error, ts, taskId);
    if (res.changes === 0) {
      const row = this.getTask(taskId);
      if (!row) throw new Error(`Task "${taskId}" not found`);
      throw new Error(`Cannot fail task "${taskId}" from status="${row.status}"`);
    }
    const failed = this.getTask(taskId);
    if (!failed) throw new Error(`Task "${taskId}" disappeared after failure`);
    await this.eventBus.publish(
      "kanban.task_failed",
      { taskId, boardId: failed.boardId, error },
      "kanban",
    );
    return failed;
  }

  // ── 查询 ───────────────────────────────────────────────

  getTask(taskId: string): Task | null {
    const db = this.requireDb();
    const row = db.prepare(`SELECT * FROM kanban_tasks WHERE id = ?`).get(taskId) as TaskRow | undefined;
    return row ? this.rowToTask(row) : null;
  }

  listTasks(boardId: string, status?: TaskStatus, tenant?: string | null): Task[] {
    const db = this.requireDb();
    let sql = `SELECT * FROM kanban_tasks WHERE board_id = ?`;
    const params: unknown[] = [boardId];
    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }
    if (tenant !== undefined) {
      // SQL 中 `tenant = NULL` 恒为 NULL（不匹配任何行），故 null 用 IS NULL
      if (tenant === null) {
        sql += ` AND tenant IS NULL`;
      } else {
        sql += ` AND tenant = ?`;
        params.push(tenant);
      }
    }
    // priority 用 CASE 排序：high(0) < medium(1) < low(2)，避免文本序错误
    sql += ` ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END, created_at ASC`;
    const rows = db.prepare(sql).all(...params) as TaskRow[];
    return rows.map((r) => this.rowToTask(r));
  }

  listReadyTasks(boardId: string): Task[] {
    const db = this.requireDb();
    const rows = db.prepare(
      `SELECT * FROM kanban_tasks
       WHERE board_id = ? AND status = 'ready' AND assigned_agent IS NULL
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END, created_at ASC`,
    ).all(boardId) as TaskRow[];
    return rows.map((r) => this.rowToTask(r));
  }

  getStats(boardId: string): BoardStats {
    const tasks = this.listTasks(boardId);
    const byStatus = {} as Record<TaskStatus, number>;
    for (const s of ALL_STATUSES) byStatus[s] = 0;
    const byPriority = { high: 0, medium: 0, low: 0 };
    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;
    }
    return { total: tasks.length, byStatus, byPriority };
  }

  // ── Dispatcher ────────────────────────────────────────

  async runDispatchCycle(options: { staleTimeoutMs: number }): Promise<DispatchResult> {
    const db = this.requireDb();
    const cutoff = new Date(Date.now() - options.staleTimeoutMs).toISOString();

    // 1. 回收 stale claims：claimed / in_progress 超过 staleTimeoutMs 未心跳 → 重置为 ready
    const staleRows = db.prepare(
      `SELECT id FROM kanban_tasks
       WHERE status IN ('claimed', 'in_progress') AND claimed_at IS NOT NULL AND claimed_at < ?`,
    ).all(cutoff) as { id: string }[];
    const reclaimed: string[] = staleRows.map((r) => r.id);
    if (reclaimed.length > 0) {
      const reclaimStmt = db.prepare(
        `UPDATE kanban_tasks
         SET status = 'ready', assigned_agent = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ?`,
      );
      for (const id of reclaimed) reclaimStmt.run(nowIso(), id);
    }

    // 2. 推进 pending → ready（依赖满足）
    const pendingRows = db.prepare(`SELECT * FROM kanban_tasks WHERE status = 'pending'`).all() as TaskRow[];
    const promoted: string[] = [];
    for (const row of pendingRows) {
      if (this.depsSatisfied(row)) {
        db.prepare(`UPDATE kanban_tasks SET status = 'ready', updated_at = ? WHERE id = ?`).run(nowIso(), row.id);
        promoted.push(row.id);
      }
    }

    if (reclaimed.length > 0 || promoted.length > 0) {
      await this.eventBus.publish(
        "kanban.dispatch_cycle",
        { reclaimed: reclaimed.length, promoted: promoted.length },
        "kanban",
      );
    }
    return { reclaimed, promoted };
  }

  startDispatcher(intervalMs: number, staleTimeoutMs: number): void {
    if (this.dispatcherTimer) return;
    const tick = (): void => {
      void this.runDispatchCycle({ staleTimeoutMs }).catch((err) => {
        process.stderr.write(`[KanbanBoard] dispatcher tick error: ${err}\n`);
      });
    };
    this.dispatcherTimer = setInterval(tick, intervalMs);
    // unref：定时器不应阻止进程退出
    this.dispatcherTimer.unref?.();
  }

  stopDispatcher(): void {
    if (this.dispatcherTimer) {
      clearInterval(this.dispatcherTimer);
      this.dispatcherTimer = null;
    }
  }

  // ── 内部辅助 ───────────────────────────────────────────

  private requireDb(): KanbanSqliteDb {
    if (!this.db) {
      throw new Error("KanbanBoard not initialized — call init() first");
    }
    return this.db;
  }

  /** 检查任务的依赖是否全部完成（done）。空依赖视为满足。 */
  private depsSatisfied(row: TaskRow): boolean {
    const deps = parseStringArray(row.dependencies);
    if (deps.length === 0) return true;
    const db = this.requireDb();
    const stmt = db.prepare(`SELECT status FROM kanban_tasks WHERE id = ?`);
    for (const depId of deps) {
      const r = stmt.get(depId) as { status: string } | undefined;
      if (!r || r.status !== "done") return false;
    }
    return true;
  }

  /** 推进依赖指定任务的 pending 任务到 ready（依赖满足后自动 ready）。 */
  private async promoteDependents(boardId: string, completedTaskId: string): Promise<void> {
    const db = this.requireDb();
    const candidates = db.prepare(
      `SELECT * FROM kanban_tasks WHERE board_id = ? AND status = 'pending'`,
    ).all(boardId) as TaskRow[];
    const promoted: string[] = [];
    for (const row of candidates) {
      const deps = parseStringArray(row.dependencies);
      if (deps.includes(completedTaskId) && this.depsSatisfied(row)) {
        db.prepare(`UPDATE kanban_tasks SET status = 'ready', updated_at = ? WHERE id = ?`).run(nowIso(), row.id);
        promoted.push(row.id);
      }
    }
    if (promoted.length > 0) {
      await this.eventBus.publish("kanban.tasks_promoted", { boardId, promoted }, "kanban");
    }
  }

  /** 释放某 agent 领取的全部任务（agent 停止时清理）。 */
  private async releaseAgentTasks(agentId: string): Promise<void> {
    const db = this.requireDb();
    const rows = db.prepare(
      `SELECT id, board_id FROM kanban_tasks
       WHERE assigned_agent = ? AND status IN ('claimed', 'in_progress')`,
    ).all(agentId) as { id: string; board_id: string }[];
    const released: string[] = rows.map((r) => r.id);
    if (released.length > 0) {
      db.prepare(
        `UPDATE kanban_tasks
         SET status = 'ready', assigned_agent = NULL, claimed_at = NULL, updated_at = ?
         WHERE assigned_agent = ? AND status IN ('claimed', 'in_progress')`,
      ).run(nowIso(), agentId);
      await this.eventBus.publish("kanban.tasks_released", { agentId, released }, "kanban");
    }
  }

  private rowToTask(row: TaskRow): Task {
    return {
      id: row.id,
      boardId: row.board_id,
      title: row.title,
      description: row.description,
      status: row.status as TaskStatus,
      priority: row.priority as TaskPriority,
      assignedAgent: row.assigned_agent,
      dependencies: parseStringArray(row.dependencies),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      claimedAt: row.claimed_at,
      completedAt: row.completed_at,
      result: parseJsonField(row.result),
      error: row.error,
      tenant: row.tenant,
    };
  }
}

// ── 解析辅助（容错） ──────────────────────────────────────

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    /* 损坏的 JSON 退化为空数组 */
  }
  return [];
}

function parseJsonField(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
