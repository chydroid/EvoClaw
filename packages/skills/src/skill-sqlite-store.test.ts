/**
 * SkillSqliteStore 测试 — SQLite 技能数据存储。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SkillSqliteStore } from "./skill-sqlite-store";
import type { SkillUsageStats, EvolutionRecord } from "./skill-curator";

// ─── 测试辅助 ──────────────────────────────────────────────────────────

function createTempDb(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sqlite-test-"));
  return path.join(tmpDir, "test-skills.db");
}

function createTestUsageStats(): SkillUsageStats[] {
  return [
    { skillName: "skill-a", lastUsedAt: "2026-01-01T00:00:00Z", useCount: 5, createdAt: "2026-01-01T00:00:00Z", status: "active" },
    { skillName: "skill-b", lastUsedAt: "2026-02-01T00:00:00Z", useCount: 10, createdAt: "2026-01-15T00:00:00Z", status: "active" },
    { skillName: "skill-c", lastUsedAt: null, useCount: 0, createdAt: "2026-01-10T00:00:00Z", status: "archived" },
  ];
}

function createTestEvents(): EvolutionRecord[] {
  return [
    { skillName: "skill-a", type: "install", description: "installed", timestamp: "2026-01-01T00:00:00Z" },
    { skillName: "skill-a", type: "improve", description: "improved", timestamp: "2026-01-02T00:00:00Z" },
    { skillName: "skill-b", type: "archive", description: "archived", timestamp: "2026-02-01T00:00:00Z" },
  ];
}

// ─── 测试 ──────────────────────────────────────────────────────────────

describe("SkillSqliteStore", () => {
  let dbPath: string;
  let store: SkillSqliteStore;

  beforeEach(() => {
    dbPath = createTempDb();
    store = new SkillSqliteStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    const dir = path.dirname(dbPath);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ─── 初始化 ──────────────────────────────────────────────────────────

  it("初始化后 isAvailable=true", () => {
    expect(store.isAvailable).toBe(true);
    expect(store.isDegraded).toBe(false);
  });

  it("数据库文件存在", () => {
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  // ─── 使用统计 ────────────────────────────────────────────────────────

  it("recordUsage 首次记录", () => {
    store.recordUsage("skill-a", "2026-01-01T00:00:00Z");
    const usage = store.getUsage("skill-a");
    expect(usage).toBeDefined();
    expect(usage!.skillName).toBe("skill-a");
    expect(usage!.useCount).toBe(1);
    expect(usage!.lastUsedAt).toBe("2026-01-01T00:00:00Z");
    expect(usage!.status).toBe("active");
  });

  it("recordUsage 多次记录递增 useCount", () => {
    store.recordUsage("skill-a", "2026-01-01T00:00:00Z");
    store.recordUsage("skill-a", "2026-01-02T00:00:00Z");
    store.recordUsage("skill-a", "2026-01-03T00:00:00Z");
    const usage = store.getUsage("skill-a");
    expect(usage!.useCount).toBe(3);
    expect(usage!.lastUsedAt).toBe("2026-01-03T00:00:00Z");
  });

  it("getUsage 不存在时返回 undefined", () => {
    expect(store.getUsage("nonexistent")).toBeUndefined();
  });

  it("getAllUsage 返回所有使用统计", () => {
    store.recordUsage("skill-a", "2026-01-01T00:00:00Z");
    store.recordUsage("skill-b", "2026-02-01T00:00:00Z");
    const all = store.getAllUsage();
    expect(all).toHaveLength(2);
  });

  it("migrateUsageFromJson 从 JSON 导入", () => {
    const stats = createTestUsageStats();
    const count = store.migrateUsageFromJson(stats);
    expect(count).toBe(3);
    const all = store.getAllUsage();
    expect(all).toHaveLength(3);
    const skillA = all.find((u) => u.skillName === "skill-a");
    expect(skillA!.useCount).toBe(5);
    expect(skillA!.status).toBe("active");
  });

  it("migrateUsageFromJson 重复导入时 upsert", () => {
    const stats = createTestUsageStats();
    store.migrateUsageFromJson(stats);
    // 再次导入更新值
    const updated: SkillUsageStats[] = [
      { skillName: "skill-a", lastUsedAt: "2026-03-01T00:00:00Z", useCount: 20, createdAt: "2026-01-01T00:00:00Z", status: "archived" },
    ];
    store.migrateUsageFromJson(updated);
    const usage = store.getUsage("skill-a");
    expect(usage!.useCount).toBe(20);
    expect(usage!.status).toBe("archived");
  });

  // ─── 演化事件 ────────────────────────────────────────────────────────

  it("appendEvent 追加单条事件", () => {
    store.appendEvent(createTestEvents()[0]);
    const events = store.getEventsBySkill("skill-a");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("install");
  });

  it("appendEvents 批量追加", () => {
    store.appendEvents(createTestEvents());
    const allEvents = store.getRecentEvents(10);
    expect(allEvents).toHaveLength(3);
  });

  it("getEventsBySkill 按技能过滤", () => {
    store.appendEvents(createTestEvents());
    const skillAEvents = store.getEventsBySkill("skill-a");
    expect(skillAEvents).toHaveLength(2);
    const skillBEvents = store.getEventsBySkill("skill-b");
    expect(skillBEvents).toHaveLength(1);
  });

  it("getEventsBySkill 按 timestamp DESC 排序", () => {
    store.appendEvents(createTestEvents());
    const events = store.getEventsBySkill("skill-a");
    expect(events[0].timestamp > events[1].timestamp).toBe(true);
  });

  it("getRecentEvents 限制返回数量", () => {
    store.appendEvents(createTestEvents());
    const events = store.getRecentEvents(2);
    expect(events).toHaveLength(2);
  });

  it("migrateEventsFromJson 从 JSON 导入", () => {
    const records = createTestEvents();
    const count = store.migrateEventsFromJson(records);
    expect(count).toBe(3);
    const all = store.getRecentEvents(10);
    expect(all).toHaveLength(3);
  });

  // ─── 生命周期状态 ────────────────────────────────────────────────────

  it("setLifecycle 设置状态", () => {
    store.setLifecycle("skill-a", "active");
    const lifecycle = store.getLifecycle("skill-a");
    expect(lifecycle).toBeDefined();
    expect(lifecycle!.state).toBe("active");
    expect(lifecycle!.pinned).toBe(0);
  });

  it("setLifecycle 带 pinned", () => {
    store.setLifecycle("skill-a", "active", { pinned: true });
    const lifecycle = store.getLifecycle("skill-a");
    expect(lifecycle!.pinned).toBe(1);
  });

  it("setLifecycle 带 archivedReason", () => {
    store.setLifecycle("skill-a", "archived", { archivedReason: "stale" });
    const lifecycle = store.getLifecycle("skill-a");
    expect(lifecycle!.state).toBe("archived");
    expect(lifecycle!.archived_reason).toBe("stale");
  });

  it("setLifecycle upsert 更新", () => {
    store.setLifecycle("skill-a", "active");
    store.setLifecycle("skill-a", "archived", { archivedReason: "too old" });
    const lifecycle = store.getLifecycle("skill-a");
    expect(lifecycle!.state).toBe("archived");
    expect(lifecycle!.archived_reason).toBe("too old");
  });

  it("getLifecycle 不存在时返回 undefined", () => {
    expect(store.getLifecycle("nonexistent")).toBeUndefined();
  });

  // ─── Curator 状态 ────────────────────────────────────────────────────

  it("setCuratorState 设置状态", () => {
    store.setCuratorState({
      attemptAt: Date.now(),
      successAt: Date.now(),
      error: null,
      resultJson: "{}",
    });
    const state = store.getCuratorState();
    expect(state).toBeDefined();
    expect(state!.last_result_json).toBe("{}");
    expect(state!.last_error).toBeNull();
  });

  it("setCuratorState upsert 更新", () => {
    store.setCuratorState({
      attemptAt: 1000,
      successAt: 1000,
      error: null,
      resultJson: "{}",
    });
    store.setCuratorState({
      attemptAt: 2000,
      successAt: 2000,
      error: "some error",
      resultJson: '{"updated":true}',
    });
    const state = store.getCuratorState();
    expect(state!.last_attempt_at_ms).toBe(2000);
    expect(state!.last_error).toBe("some error");
    expect(state!.last_result_json).toBe('{"updated":true}');
  });

  it("getCuratorState 未设置时返回 undefined", () => {
    expect(store.getCuratorState()).toBeUndefined();
  });

  // ─── 关闭 ────────────────────────────────────────────────────────────

  it("close 后 isAvailable=false", () => {
    store.close();
    expect(store.isAvailable).toBe(false);
  });
});
