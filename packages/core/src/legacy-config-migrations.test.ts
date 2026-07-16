/**
 * Legacy Config Migrations 测试。
 *
 * 覆盖：
 *   - 内置迁移规范（gateway.rate-limit / evolution.autoEvolve / agent.scaleThresholdMs）
 *   - applyLegacyDoctorMigrations 运行器（顺序、幂等、容错）
 *   - migrateLegacyConfig 顶层入口
 *   - archiveLegacyStateSource 文件归档（首次/已存在相同/已存在不同）
 *   - persistMigratedConfig 持久化助手
 *   - 辅助函数（getRecord/ensureRecord/mergeMissing/getPathValue/setPathValue/deletePathValue）
 *   - defineLegacyConfigMigration 工厂
 *   - LEGACY_CONFIG_MIGRATIONS / LEGACY_CONFIG_MIGRATION_RULES 聚合
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defineLegacyConfigMigration,
  applyLegacyDoctorMigrations,
  migrateLegacyConfig,
  archiveLegacyStateSource,
  persistMigratedConfig,
  LEGACY_CONFIG_MIGRATIONS,
  LEGACY_CONFIG_MIGRATION_RULES,
  getRecord,
  ensureRecord,
  mergeMissing,
  getPathValue,
  setPathValue,
  deletePathValue,
} from "./legacy-config-migrations";

// ─── 辅助函数测试 ────────────────────────────────────────────────────

describe("legacy-config-migrations 辅助函数", () => {
  it("getRecord 对象返回原值，非对象返回 null", () => {
    expect(getRecord({ a: 1 })).toEqual({ a: 1 });
    expect(getRecord(null)).toBeNull();
    expect(getRecord("str")).toBeNull();
    expect(getRecord([1, 2])).toBeNull();
    expect(getRecord(42)).toBeNull();
  });

  it("ensureRecord 存在时返回原对象", () => {
    const root: Record<string, unknown> = { existing: { x: 1 } };
    const result = ensureRecord(root, "existing");
    expect(result).toEqual({ x: 1 });
    expect(result).toBe(root.existing); // 同一引用
  });

  it("ensureRecord 不存在时创建空对象", () => {
    const root: Record<string, unknown> = {};
    const result = ensureRecord(root, "newKey");
    expect(result).toEqual({});
    expect(root.newKey).toEqual({});
  });

  it("ensureRecord 非对象值时覆盖为空对象", () => {
    const root: Record<string, unknown> = { bad: "string" };
    const result = ensureRecord(root, "bad");
    expect(result).toEqual({});
    expect(root.bad).toEqual({});
  });

  it("mergeMissing 浅合并缺失的键", () => {
    const target = { a: 1, b: { x: 1 } };
    const source = { b: { y: 2 }, c: 3 };
    mergeMissing(target, source);
    expect(target).toEqual({ a: 1, b: { x: 1, y: 2 }, c: 3 });
  });

  it("mergeMissing 不覆盖已存在的标量值", () => {
    const target = { a: 1 };
    const source = { a: 999, b: 2 };
    mergeMissing(target, source);
    expect(target).toEqual({ a: 1, b: 2 });
  });

  it("mergeMissing 跳过 undefined 值", () => {
    const target: Record<string, unknown> = {};
    const source = { a: undefined, b: 2 };
    mergeMissing(target, source);
    expect(target).toEqual({ b: 2 });
  });

  it("getPathValue 沿路径取值", () => {
    const root = { a: { b: { c: 42 } } };
    expect(getPathValue(root, ["a", "b", "c"])).toBe(42);
  });

  it("getPathValue 中间非对象返回 undefined", () => {
    const root = { a: "string" };
    expect(getPathValue(root, ["a", "b"])).toBeUndefined();
  });

  it("getPathValue 空路径返回 root 本身", () => {
    const root = { a: 1 };
    expect(getPathValue(root, [])).toBe(root);
  });

  it("setPathValue 沿路径设置值，创建中间对象", () => {
    const root: Record<string, unknown> = {};
    setPathValue(root, ["a", "b", "c"], 42);
    expect(root).toEqual({ a: { b: { c: 42 } } });
  });

  it("setPathValue 覆盖中间非对象值", () => {
    const root: Record<string, unknown> = { a: "string" };
    setPathValue(root, ["a", "b"], 42);
    expect(root).toEqual({ a: { b: 42 } });
  });

  it("setPathValue 空路径无操作", () => {
    const root: Record<string, unknown> = {};
    setPathValue(root, [], 42);
    expect(root).toEqual({});
  });

  it("deletePathValue 删除存在的键", () => {
    const root = { a: { b: 1 } };
    expect(deletePathValue(root, ["a", "b"])).toBe(true);
    expect(root).toEqual({ a: {} });
  });

  it("deletePathValue 删除不存在的键返回 false", () => {
    const root = { a: { b: 1 } };
    expect(deletePathValue(root, ["a", "c"])).toBe(false);
    expect(root).toEqual({ a: { b: 1 } });
  });

  it("deletePathValue 中间非对象返回 false", () => {
    const root = { a: "string" };
    expect(deletePathValue(root, ["a", "b"])).toBe(false);
  });
});

// ─── 工厂与注册表 ────────────────────────────────────────────────────

describe("defineLegacyConfigMigration 工厂", () => {
  it("返回原迁移规范对象", () => {
    const spec = {
      id: "test",
      describe: "test migration",
      apply: () => {},
    };
    expect(defineLegacyConfigMigration(spec)).toBe(spec);
  });
});

describe("LEGACY_CONFIG_MIGRATIONS 注册表", () => {
  it("包含内置迁移", () => {
    expect(LEGACY_CONFIG_MIGRATIONS.length).toBeGreaterThanOrEqual(3);
    const ids = LEGACY_CONFIG_MIGRATIONS.map((m) => m.id);
    expect(ids).toContain("gateway.rate-limit-restructure");
    expect(ids).toContain("evolution.auto-evolve-rename");
    expect(ids).toContain("agent.scale-threshold-rename");
  });

  it("LEGACY_CONFIG_MIGRATION_RULES 聚合所有 legacyRules", () => {
    expect(LEGACY_CONFIG_MIGRATION_RULES.length).toBeGreaterThanOrEqual(3);
    const paths = LEGACY_CONFIG_MIGRATION_RULES.map((r) => r.path.join("."));
    expect(paths).toContain("gateway.rateLimitWindow");
    expect(paths).toContain("evolution.autoEvolution");
    expect(paths).toContain("agent.scaleThreshold");
  });
});

// ─── 内置迁移测试 ────────────────────────────────────────────────────

describe("内置迁移: gateway.rate-limit-restructure", () => {
  it("将 rateLimitWindow/rateLimitMax 迁移到 rateLimit.{window,max}", () => {
    const raw = {
      gateway: {
        rateLimitWindow: 60000,
        rateLimitMax: 100,
      },
    };
    const { next, changes } = applyLegacyDoctorMigrations(raw);
    expect(next).not.toBeNull();
    expect(next!.gateway).toEqual({
      rateLimit: { window: 60000, max: 100 },
    });
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.some((c) => c.includes("rateLimit"))).toBe(true);
  });

  it("仅 rateLimitWindow 存在时只迁移该字段", () => {
    const raw = { gateway: { rateLimitWindow: 30000 } };
    const { next } = applyLegacyDoctorMigrations(raw);
    expect(next!.gateway).toEqual({ rateLimit: { window: 30000 } });
  });

  it("已规范化的配置不产生变更", () => {
    const raw = { gateway: { rateLimit: { window: 60000, max: 100 } } };
    const { next, changes } = applyLegacyDoctorMigrations(raw);
    // 其他迁移可能仍然无操作，但整体无变更返回 null
    expect(changes).toEqual([]);
    expect(next).toBeNull();
  });
});

describe("内置迁移: evolution.auto-evolve-rename", () => {
  it("将 autoEvolution 重命名为 autoEvolve", () => {
    const raw = { evolution: { autoEvolution: true } };
    const { next } = applyLegacyDoctorMigrations(raw);
    expect(next!.evolution).toEqual({ autoEvolve: true });
  });
});

describe("内置迁移: agent.scale-threshold-rename", () => {
  it("将 scaleThreshold 重命名为 scaleThresholdMs", () => {
    const raw = { agent: { scaleThreshold: 1000 } };
    const { next } = applyLegacyDoctorMigrations(raw);
    expect(next!.agent).toEqual({ scaleThresholdMs: 1000 });
  });
});

// ─── 运行器测试 ────────────────────────────────────────────────────

describe("applyLegacyDoctorMigrations 运行器", () => {
  it("非对象输入返回 null", () => {
    expect(applyLegacyDoctorMigrations(null)).toEqual({ next: null, changes: [] });
    expect(applyLegacyDoctorMigrations("string")).toEqual({ next: null, changes: [] });
    expect(applyLegacyDoctorMigrations(42)).toEqual({ next: null, changes: [] });
  });

  it("无遗留字段的配置返回 null", () => {
    const raw = { server: { port: 3000 } };
    const { next, changes } = applyLegacyDoctorMigrations(raw);
    expect(next).toBeNull();
    expect(changes).toEqual([]);
  });

  it("深拷贝输入，不污染原对象", () => {
    const raw = { evolution: { autoEvolution: true } };
    applyLegacyDoctorMigrations(raw);
    expect(raw.evolution).toEqual({ autoEvolution: true });
  });

  it("单个迁移异常不中断后续迁移", () => {
    const failingMigration = defineLegacyConfigMigration({
      id: "failing",
      describe: "always throws",
      apply: () => {
        throw new Error("boom");
      },
    });
    const raw = { evolution: { autoEvolution: true } };
    const { next, changes } = applyLegacyDoctorMigrations(raw, [failingMigration]);
    expect(next).not.toBeNull();
    expect(next!.evolution).toEqual({ autoEvolve: true });
    expect(changes.some((c) => c.includes("[SKIP]") && c.includes("failing"))).toBe(true);
  });

  it("支持外部迁移追加", () => {
    const customMigration = defineLegacyConfigMigration({
      id: "custom.rename",
      describe: "custom field rename",
      apply: (raw, changes) => {
        if (raw.custom && typeof raw.custom === "object") {
          const c = raw.custom as Record<string, unknown>;
          if ("oldName" in c) {
            c.newName = c.oldName;
            delete c.oldName;
            changes.push("Renamed custom.oldName → custom.newName");
          }
        }
      },
    });
    const raw = { custom: { oldName: "value" } };
    const { next, changes } = applyLegacyDoctorMigrations(raw, [customMigration]);
    expect(next!.custom).toEqual({ newName: "value" });
    expect(changes).toContain("Renamed custom.oldName → custom.newName");
  });

  it("幂等：再次应用不产生额外变更", () => {
    const raw = { evolution: { autoEvolution: true } };
    const first = applyLegacyDoctorMigrations(raw);
    const second = applyLegacyDoctorMigrations(first.next);
    // 第二次应用时已无遗留字段，不应产生变更
    expect(second.changes).toEqual([]);
    expect(second.next).toBeNull();
  });
});

describe("migrateLegacyConfig 顶层入口", () => {
  it("应用迁移并返回配置", () => {
    const raw = { evolution: { autoEvolution: false } };
    const result = migrateLegacyConfig(raw);
    expect(result.config).not.toBeNull();
    expect(result.config!.evolution).toEqual({ autoEvolve: false });
    expect(result.changes.length).toBeGreaterThan(0);
  });

  it("无变更时返回 null 配置", () => {
    const raw = { server: { port: 3000 } };
    const result = migrateLegacyConfig(raw);
    expect(result.config).toBeNull();
    expect(result.changes).toEqual([]);
  });
});

// ─── 文件归档测试 ────────────────────────────────────────────────────

describe("archiveLegacyStateSource 文件归档", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-archive-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("首次归档：重命名为 .migrated", async () => {
    const filePath = path.join(tmpDir, "config.json");
    fs.writeFileSync(filePath, '{"old":true}');

    const changes: string[] = [];
    const warnings: string[] = [];
    await archiveLegacyStateSource({ filePath, label: "config", changes, warnings });

    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
    expect(warnings).toEqual([]);
    expect(changes.length).toBe(1);
    expect(changes[0]).toContain("Archived config legacy source");
  });

  it("已存在相同归档：删除源文件", async () => {
    const filePath = path.join(tmpDir, "config.json");
    const content = '{"old":true}';
    fs.writeFileSync(filePath, content);
    fs.writeFileSync(`${filePath}.migrated`, content);

    const changes: string[] = [];
    const warnings: string[] = [];
    await archiveLegacyStateSource({ filePath, label: "config", changes, warnings });

    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
    expect(changes.some((c) => c.includes("already-archived"))).toBe(true);
  });

  it("已存在不同归档：归档到 .migrated.N", async () => {
    const filePath = path.join(tmpDir, "config.json");
    fs.writeFileSync(filePath, '{"new":true}');
    fs.writeFileSync(`${filePath}.migrated`, '{"old":true}');

    const changes: string[] = [];
    const warnings: string[] = [];
    await archiveLegacyStateSource({ filePath, label: "config", changes, warnings });

    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
    expect(fs.existsSync(`${filePath}.migrated.2`)).toBe(true);
    expect(changes.some((c) => c.includes(".migrated.2"))).toBe(true);
  });

  it("源文件不存在时记录 warning 不抛出", async () => {
    const filePath = path.join(tmpDir, "nonexistent.json");
    const changes: string[] = [];
    const warnings: string[] = [];
    await archiveLegacyStateSource({ filePath, label: "config", changes, warnings });

    expect(warnings.length).toBeGreaterThan(0);
    expect(changes).toEqual([]);
  });
});

// ─── persistMigratedConfig 测试 ──────────────────────────────────────

describe("persistMigratedConfig 持久化", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "persist-migrated-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("原文件存在时归档并写入新配置", async () => {
    const configPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(configPath, '{"old":true}');

    const changes: string[] = [];
    const warnings: string[] = [];
    await persistMigratedConfig({
      configPath,
      config: { new: true },
      changes,
      warnings,
    });

    expect(fs.existsSync(configPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, "utf-8"))).toEqual({ new: true });
    expect(fs.existsSync(`${configPath}.migrated`)).toBe(true);
    expect(changes.some((c) => c.includes("Wrote migrated config"))).toBe(true);
  });

  it("原文件不存在时直接写入新配置", async () => {
    const configPath = path.join(tmpDir, "new-config.json");
    const changes: string[] = [];
    const warnings: string[] = [];
    await persistMigratedConfig({
      configPath,
      config: { fresh: true },
      changes,
      warnings,
    });

    expect(fs.existsSync(configPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, "utf-8"))).toEqual({ fresh: true });
    expect(fs.existsSync(`${configPath}.migrated`)).toBe(false);
  });

  it("目录不存在时自动创建", async () => {
    const configPath = path.join(tmpDir, "subdir", "nested", "config.json");
    const changes: string[] = [];
    const warnings: string[] = [];
    await persistMigratedConfig({
      configPath,
      config: { nested: true },
      changes,
      warnings,
    });

    expect(fs.existsSync(configPath)).toBe(true);
  });
});
