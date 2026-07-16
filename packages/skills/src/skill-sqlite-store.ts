/**
 * Skill SQLite Store — 技能数据 SQLite 持久化。
 *
 * 对标 OpenClaw 的 database-first 技能存储设计（skill_usage / skill_lifecycle /
 * skill_curator_state 三表），以及 EvoClaw 现有的 long-term-memory.ts
 * SQLite 主写 + JSON 降级 + require 懒加载模式。
 *
 * 设计原则：
 *   - 技能内容（SKILL.md、_meta.json）保持文件型，数据库只存元数据/统计
 *   - SQLite 不可用时降级到 JSON（sqliteDegraded 标志）
 *   - 使用 prepared statements + upsert 模式避免 read-modify-write 竞态
 *   - STRICT 表类型强制类型安全（对标 OpenClaw schema）
 *
 * 表结构：
 *   - skill_usage: 使用统计（对标 OpenClaw skill_usage 表）
 *   - skill_evolution_events: 演化事件流水（EvoClaw 特有，对标 records 数组）
 *   - skill_lifecycle: 生命周期状态（对标 OpenClaw skill_lifecycle 表）
 *   - skill_curator_state: curator 单例行状态（对标 OpenClaw skill_curator_state）
 */
import * as fs from "fs";
import * as path from "path";
import { applyPragmas, DEFAULT_PRODUCTION_PRAGMAS } from "@evoclaw/infrastructure";
import type { SqliteDb, SqliteStatement } from "@evoclaw/infrastructure";
import type { SkillUsageStats, EvolutionRecord } from "./skill-curator.js";

// ─── 类型 ──────────────────────────────────────────────────────────────

/** 技能生命周期状态行 */
export interface SkillLifecycleRow {
  skill_name: string;
  state: "active" | "stale" | "archived";
  pinned: number; // 0 or 1
  state_changed_at_ms: number;
  created_at_ms: number;
  archived_reason: string | null;
}

/** Curator 单例行状态 */
export interface SkillCuratorStateRow {
  last_attempt_at_ms: number;
  last_success_at_ms: number | null;
  last_error: string | null;
  last_result_json: string;
}

// ─── 常量 ──────────────────────────────────────────────────────────────

/** 默认数据库路径 */
const DEFAULT_DB_DIR = path.resolve(process.cwd(), "data", "skill-curator");
const DEFAULT_DB_FILE = path.join(DEFAULT_DB_DIR, "skills.db");

/** 最大演化事件数（与 skill-curator.ts MAX_RECORDS 对齐） */
const MAX_EVOLUTION_EVENTS = 5000;

// ─── Schema DDL ────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS skill_usage (
  skill_name TEXT NOT NULL PRIMARY KEY,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
) STRICT;

CREATE TABLE IF NOT EXISTS skill_evolution_events (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  skill_name TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  timestamp TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_skill_evolution_skill_name
  ON skill_evolution_events(skill_name, timestamp);

CREATE TABLE IF NOT EXISTS skill_lifecycle (
  skill_name TEXT NOT NULL PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'stale', 'archived')),
  pinned INTEGER NOT NULL DEFAULT 0,
  state_changed_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  archived_reason TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS skill_curator_state (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  last_attempt_at_ms INTEGER NOT NULL,
  last_success_at_ms INTEGER,
  last_error TEXT,
  last_result_json TEXT NOT NULL
) STRICT;
`;

// ─── SkillSqliteStore ─────────────────────────────────────────────────

/**
 * 技能 SQLite 存储后端。
 *
 * 对标 OpenClaw 的 curator.ts SQLite 操作，提供：
 *   - 技能使用统计的 upsert 查询
 *   - 演化事件流水的追加与范围查询
 *   - 生命周期状态管理
 *   - curator 单例行状态
 *
 * 降级策略：better-sqlite3 不可用时，sqliteDegraded=true，
 * 所有操作降级为 no-op，调用方应回退到 JSON。
 */
export class SkillSqliteStore {
  private db: SqliteDb | null = null;
  private sqliteDegraded = false;

  // prepared statements 缓存
  private stmts: {
    upsertUsage?: SqliteStatement;
    getUsage?: SqliteStatement;
    getAllUsage?: SqliteStatement;
    insertEvent?: SqliteStatement;
    getEventsBySkill?: SqliteStatement;
    getRecentEvents?: SqliteStatement;
    deleteOldEvents?: SqliteStatement;
    upsertLifecycle?: SqliteStatement;
    getLifecycle?: SqliteStatement;
    upsertCuratorState?: SqliteStatement;
    getCuratorState?: SqliteStatement;
  } = {};

  constructor(private readonly dbFile: string = DEFAULT_DB_FILE) {
    this.init();
  }

  // ─── 初始化 ──────────────────────────────────────────────────────────

  private init(): void {
    let BetterSqlite3: new (file: string, opts?: Record<string, unknown>) => SqliteDb;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      BetterSqlite3 = require("better-sqlite3");
    } catch (err) {
      this.db = null;
      this.sqliteDegraded = true;
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[SkillSqliteStore] better-sqlite3 not available, SQLite backend disabled (${reason})\n`,
      );
      return;
    }

    try {
      const dir = path.dirname(this.dbFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new BetterSqlite3(this.dbFile) as SqliteDb;
      applyPragmas(this.db, DEFAULT_PRODUCTION_PRAGMAS);
      this.db.exec(SCHEMA_SQL);
      this.prepareStatements();
      process.stderr.write(`[SkillSqliteStore] SQLite opened at ${this.dbFile}\n`);
    } catch (err) {
      this.db = null;
      this.sqliteDegraded = true;
      const fullReason = err instanceof Error ? err.message : String(err);
      const reason = fullReason.startsWith("Could not locate the bindings file")
        ? "native bindings not compiled for this Node.js/ABI version"
        : fullReason.split("\n")[0];
      process.stderr.write(
        `[SkillSqliteStore] SQLite init failed, falling back to JSON (${reason})\n`,
      );
    }
  }

  private prepareStatements(): void {
    if (!this.db) return;

    this.stmts.upsertUsage = this.db.prepare(
      `INSERT INTO skill_usage (skill_name, last_used_at, use_count, created_at, status)
       VALUES (@skillName, @lastUsedAt, 1, @createdAt, 'active')
       ON CONFLICT(skill_name) DO UPDATE SET
         last_used_at = @lastUsedAt,
         use_count = use_count + 1`,
    );

    this.stmts.getUsage = this.db.prepare(
      `SELECT * FROM skill_usage WHERE skill_name = ?`,
    );

    this.stmts.getAllUsage = this.db.prepare(
      `SELECT * FROM skill_usage ORDER BY last_used_at DESC`,
    );

    this.stmts.insertEvent = this.db.prepare(
      `INSERT INTO skill_evolution_events (skill_name, type, description, timestamp)
       VALUES (@skillName, @type, @description, @timestamp)`,
    );

    this.stmts.getEventsBySkill = this.db.prepare(
      `SELECT * FROM skill_evolution_events WHERE skill_name = ? ORDER BY timestamp DESC LIMIT ?`,
    );

    this.stmts.getRecentEvents = this.db.prepare(
      `SELECT * FROM skill_evolution_events ORDER BY timestamp DESC LIMIT ?`,
    );

    this.stmts.deleteOldEvents = this.db.prepare(
      `DELETE FROM skill_evolution_events WHERE id NOT IN (
        SELECT id FROM skill_evolution_events ORDER BY id DESC LIMIT ?
      )`,
    );

    this.stmts.upsertLifecycle = this.db.prepare(
      `INSERT INTO skill_lifecycle (skill_name, state, pinned, state_changed_at_ms, created_at_ms, archived_reason)
       VALUES (@skillName, @state, @pinned, @changedAt, @createdAt, @archivedReason)
       ON CONFLICT(skill_name) DO UPDATE SET
         state = @state,
         pinned = @pinned,
         state_changed_at_ms = @changedAt,
         archived_reason = @archivedReason`,
    );

    this.stmts.getLifecycle = this.db.prepare(
      `SELECT * FROM skill_lifecycle WHERE skill_name = ?`,
    );

    this.stmts.upsertCuratorState = this.db.prepare(
      `INSERT INTO skill_curator_state (id, last_attempt_at_ms, last_success_at_ms, last_error, last_result_json)
       VALUES (1, @attemptAt, @successAt, @error, @resultJson)
       ON CONFLICT(id) DO UPDATE SET
         last_attempt_at_ms = @attemptAt,
         last_success_at_ms = @successAt,
         last_error = @error,
         last_result_json = @resultJson`,
    );

    this.stmts.getCuratorState = this.db.prepare(
      `SELECT * FROM skill_curator_state WHERE id = 1`,
    );
  }

  // ─── 公共 API ────────────────────────────────────────────────────────

  get isAvailable(): boolean {
    return this.db !== null && !this.sqliteDegraded;
  }

  get isDegraded(): boolean {
    return this.sqliteDegraded;
  }

  /** 关闭数据库连接 */
  close(): void {
    if (this.db?.close) {
      this.db.close();
    }
    this.db = null;
  }

  // ─── 使用统计 ────────────────────────────────────────────────────────

  /**
   * 记录技能使用（upsert，对标 OpenClaw recordSkillUsage）
   */
  recordUsage(skillName: string, timestamp: string): void {
    if (!this.db || !this.stmts.upsertUsage) return;
    this.stmts.upsertUsage.run({
      skillName,
      lastUsedAt: timestamp,
      createdAt: timestamp,
    });
  }

  /**
   * 获取单个技能的使用统计
   */
  getUsage(skillName: string): SkillUsageStats | undefined {
    if (!this.db || !this.stmts.getUsage) return undefined;
    const row = this.stmts.getUsage.get(skillName) as { skill_name: string; last_used_at: string | null; use_count: number; created_at: string; status: string } | undefined;
    if (!row) return undefined;
    return {
      skillName: row.skill_name,
      lastUsedAt: row.last_used_at,
      useCount: row.use_count,
      createdAt: row.created_at,
      status: row.status as "active" | "archived",
    };
  }

  /**
   * 获取所有技能的使用统计
   */
  getAllUsage(): SkillUsageStats[] {
    if (!this.db || !this.stmts.getAllUsage) return [];
    const rows = this.stmts.getAllUsage.all() as { skill_name: string; last_used_at: string | null; use_count: number; created_at: string; status: string }[];
    return rows.map((row) => ({
      skillName: row.skill_name,
      lastUsedAt: row.last_used_at,
      useCount: row.use_count,
      createdAt: row.created_at,
      status: row.status as "active" | "archived",
    }));
  }

  /**
   * 从 JSON 迁移使用统计到 SQLite（对标 OpenClaw doctor 迁移）
   */
  migrateUsageFromJson(usageStats: SkillUsageStats[]): number {
    if (!this.db) return 0;
    let migrated = 0;
    const db = this.db as any;
    const tx = db.transaction(() => {
      for (const stat of usageStats) {
        if (!this.db) return;
        this.db.prepare(
          `INSERT INTO skill_usage (skill_name, last_used_at, use_count, created_at, status)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(skill_name) DO UPDATE SET
             last_used_at = excluded.last_used_at,
             use_count = excluded.use_count,
             status = excluded.status`,
        ).run(stat.skillName, stat.lastUsedAt, stat.useCount, stat.createdAt, stat.status);
        migrated++;
      }
    });
    tx();
    return migrated;
  }

  // ─── 演化事件流水 ────────────────────────────────────────────────────

  /**
   * 追加演化事件（对标 OpenClaw evolution records）
   */
  appendEvent(record: EvolutionRecord): void {
    if (!this.db || !this.stmts.insertEvent) return;
    this.stmts.insertEvent.run({
      skillName: record.skillName,
      type: record.type,
      description: record.description,
      timestamp: record.timestamp,
    });
    // 清理超出上限的旧事件
    if (this.stmts.deleteOldEvents) {
      this.stmts.deleteOldEvents.run(MAX_EVOLUTION_EVENTS);
    }
  }

  /**
   * 批量追加演化事件
   */
  appendEvents(records: EvolutionRecord[]): void {
    if (!this.db || records.length === 0) return;
    // SqliteDb 接口未暴露 transaction()，使用 as any 绕过类型检查（运行时由 better-sqlite3 提供）
    const db = this.db as any;
    const tx = db.transaction(() => {
      for (const record of records) {
        if (!this.stmts.insertEvent) return;
        this.stmts.insertEvent.run({
          skillName: record.skillName,
          type: record.type,
          description: record.description,
          timestamp: record.timestamp,
        });
      }
      if (this.stmts.deleteOldEvents) {
        this.stmts.deleteOldEvents.run(MAX_EVOLUTION_EVENTS);
      }
    });
    tx();
  }

  /**
   * 获取技能的演化事件
   */
  getEventsBySkill(skillName: string, limit: number = 100): EvolutionRecord[] {
    if (!this.db || !this.stmts.getEventsBySkill) return [];
    const rows = this.stmts.getEventsBySkill.all(skillName, limit) as { skill_name: string; type: string; description: string; timestamp: string }[];
    return rows.map((row) => ({
      skillName: row.skill_name,
      type: row.type,
      description: row.description,
      timestamp: row.timestamp,
    }));
  }

  /**
   * 获取最近的演化事件
   */
  getRecentEvents(limit: number = 100): EvolutionRecord[] {
    if (!this.db || !this.stmts.getRecentEvents) return [];
    const rows = this.stmts.getRecentEvents.all(limit) as { skill_name: string; type: string; description: string; timestamp: string }[];
    return rows.map((row) => ({
      skillName: row.skill_name,
      type: row.type,
      description: row.description,
      timestamp: row.timestamp,
    }));
  }

  /**
   * 从 JSON 迁移演化事件到 SQLite
   */
  migrateEventsFromJson(records: EvolutionRecord[]): number {
    if (!this.db || records.length === 0) return 0;
    let migrated = 0;
    // SqliteDb 接口未暴露 transaction()，使用 as any 绕过类型检查
    const db = this.db as any;
    const tx = db.transaction(() => {
      for (const record of records) {
        if (!this.stmts.insertEvent) return;
        this.stmts.insertEvent.run({
          skillName: record.skillName,
          type: record.type,
          description: record.description,
          timestamp: record.timestamp,
        });
        migrated++;
      }
      if (this.stmts.deleteOldEvents) {
        this.stmts.deleteOldEvents.run(MAX_EVOLUTION_EVENTS);
      }
    });
    tx();
    return migrated;
  }

  // ─── 生命周期状态 ────────────────────────────────────────────────────

  /**
   * 设置技能生命周期状态（对标 OpenClaw skill_lifecycle upsert）
   */
  setLifecycle(
    skillName: string,
    state: "active" | "stale" | "archived",
    opts?: { pinned?: boolean; archivedReason?: string },
  ): void {
    if (!this.db || !this.stmts.upsertLifecycle) return;
    const now = Date.now();
    this.stmts.upsertLifecycle.run({
      skillName,
      state,
      pinned: opts?.pinned ? 1 : 0,
      changedAt: now,
      createdAt: now,
      archivedReason: opts?.archivedReason ?? null,
    });
  }

  /**
   * 获取技能生命周期状态
   */
  getLifecycle(skillName: string): SkillLifecycleRow | undefined {
    if (!this.db || !this.stmts.getLifecycle) return undefined;
    return this.stmts.getLifecycle.get(skillName) as SkillLifecycleRow | undefined;
  }

  // ─── Curator 状态 ────────────────────────────────────────────────────

  /**
   * 更新 curator 单例行状态
   */
  setCuratorState(opts: {
    attemptAt: number;
    successAt: number | null;
    error: string | null;
    resultJson: string;
  }): void {
    if (!this.db || !this.stmts.upsertCuratorState) return;
    this.stmts.upsertCuratorState.run({
      attemptAt: opts.attemptAt,
      successAt: opts.successAt,
      error: opts.error,
      resultJson: opts.resultJson,
    });
  }

  /**
   * 获取 curator 状态
   */
  getCuratorState(): SkillCuratorStateRow | undefined {
    if (!this.db || !this.stmts.getCuratorState) return undefined;
    return this.stmts.getCuratorState.get() as SkillCuratorStateRow | undefined;
  }
}
