/**
 * Legacy Config Migrations — 对标 OpenClaw doctor 的 legacy 配置迁移框架。
 *
 * 设计参考 OpenClaw 的 `src/config/legacy.shared.ts` 和
 * `src/commands/doctor/shared/legacy-config-migrate.ts`：
 *
 *   - defineLegacyConfigMigration(): 声明式迁移工厂
 *   - LegacyConfigMigrationSpec: 迁移规范（id + describe + apply + legacyRules）
 *   - applyLegacyDoctorMigrations(): 迁移运行器（顺序应用所有迁移）
 *   - archiveLegacyStateSource(): 文件归档助手（对标 OpenClaw doctor-state-migration-fs.ts）
 *
 * 与 EvoClaw 现有的 config-migration.ts（基于 semver 的版本迁移）的区别：
 *   - config-migration.ts: 跨版本的 schemaVersion 迁移链（v1 → v2 → v3）
 *   - legacy-config-migrations.ts: 同版本内的遗留字段迁移（如重命名、结构调整）
 *
 * 安全原则（遵循 AGENTS.md）：
 *   - 永不删除：归档到 `<path>.migrated`，保留可恢复快照
 *   - 原子写入：使用 atomicWriteFile 避免竞态
 *   - 跨设备兼容：rename 失败回退到 copy+unlink
 *   - 迁移失败不抛出，记录到 warnings 列表，下次 doctor 可重试
 */

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync } from "./atomic-write.js";

// ─── 内联辅助：isRecord ────────────────────────────────────────────

/**
 * 判断值是否为普通对象（非 null、非数组）。
 * 对标 OpenClaw 的 isRecord 辅助函数。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

// ─── 类型定义 ──────────────────────────────────────────────────────

/**
 * Legacy 配置规则：用于检测遗留字段。
 * 对标 OpenClaw 的 LegacyConfigRule。
 */
export type LegacyConfigRule = {
  /** 配置路径分段（如 ["channels", "discord", "legacyToken"]） */
  path: string[];
  /** 用户可读的描述 */
  message: string;
  /** 可选的值匹配谓词 */
  match?: (value: unknown, root: Record<string, unknown>) => boolean;
};

/**
 * 单个 legacy 迁移规范。
 * 对标 OpenClaw 的 LegacyConfigMigrationSpec。
 */
export type LegacyConfigMigrationSpec = {
  /** 迁移唯一标识（如 "channels.discord.legacy-token → channels.discord.token"） */
  id: string;
  /** 人类可读描述 */
  describe: string;
  /**
   * 应用迁移：原地修改 raw 配置，向 changes 推送人类可读变更说明。
   * 实现应保持幂等：再次应用不应产生额外 changes。
   */
  apply: (raw: Record<string, unknown>, changes: string[]) => void;
  /** 可选的检测规则（用于 preview-only 警告，不参与 apply） */
  legacyRules?: LegacyConfigRule[];
};

// ─── 辅助函数 ──────────────────────────────────────────────────────

/** 安全获取对象类型的值，非对象返回 null。 */
export const getRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

/** 确保父对象下 key 为 Record 类型，不存在则创建。 */
export const ensureRecord = (
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const existing = root[key];
  if (isRecord(existing)) {
    return existing;
  }
  const next: Record<string, unknown> = {};
  root[key] = next;
  return next;
};

/** 浅合并 source 中 target 缺失的键。 */
export const mergeMissing = (
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void => {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const existing = target[key];
    if (existing === undefined) {
      target[key] = value;
      continue;
    }
    if (isRecord(existing) && isRecord(value)) {
      mergeMissing(existing, value);
    }
  }
};

/** 沿 path 分段取值，任一段不存在或非对象则返回 undefined。 */
export function getPathValue(
  root: Record<string, unknown>,
  pathParts: string[],
): unknown {
  let current: unknown = root;
  for (const part of pathParts) {
    if (!isRecord(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** 沿 path 分段设置值，中间节点不存在则创建为对象。 */
export function setPathValue(
  root: Record<string, unknown>,
  pathParts: string[],
  value: unknown,
): void {
  if (pathParts.length === 0) return;
  let current: Record<string, unknown> = root;
  for (let i = 0; i < pathParts.length - 1; i++) {
    const part = pathParts[i];
    const next = current[part];
    if (!isRecord(next)) {
      const created: Record<string, unknown> = {};
      current[part] = created;
      current = created;
    } else {
      current = next as Record<string, unknown>;
    }
  }
  current[pathParts[pathParts.length - 1]] = value;
}

/** 沿 path 分段删除值，返回是否实际删除。 */
export function deletePathValue(
  root: Record<string, unknown>,
  pathParts: string[],
): boolean {
  if (pathParts.length === 0) return false;
  let current: unknown = root;
  for (let i = 0; i < pathParts.length - 1; i++) {
    if (!isRecord(current)) return false;
    current = (current as Record<string, unknown>)[pathParts[i]];
  }
  if (!isRecord(current)) return false;
  const key = pathParts[pathParts.length - 1];
  if (!(key in current)) return false;
  delete current[key];
  return true;
}

// ─── 迁移工厂 ──────────────────────────────────────────────────────

/**
 * 声明式 legacy 迁移工厂。
 * 对标 OpenClaw 的 defineLegacyConfigMigration。
 */
export const defineLegacyConfigMigration = (
  migration: LegacyConfigMigrationSpec,
): LegacyConfigMigrationSpec => migration;

// ─── 内置迁移规范 ──────────────────────────────────────────────────

/**
 * EvoClaw 内置的 legacy 配置迁移列表。
 *
 * 当前覆盖：
 *   - server.port → server.port（已是规范字段，无操作，占位示例）
 *   - gateway.rateLimitWindow/rateLimitMax → gateway.rateLimit.window/max（结构调整）
 *   - evolution.autoEvolution → evolution.autoEvolve（字段重命名）
 *
 * 后续版本可继续追加迁移，遵循 OpenClaw 的扩展模式。
 */
const INTERNAL_MIGRATIONS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "gateway.rate-limit-restructure",
    describe: "将 gateway.rateLimitWindow/rateLimitMax 迁移到 gateway.rateLimit.{window,max}",
    apply: (raw, changes) => {
      const gateway = getRecord(raw.gateway);
      if (!gateway) return;
      const hasLegacyWindow = "rateLimitWindow" in gateway;
      const hasLegacyMax = "rateLimitMax" in gateway;
      if (!hasLegacyWindow && !hasLegacyMax) return;

      const rateLimit = getRecord(gateway.rateLimit) ?? {};
      let changed = false;
      if (hasLegacyWindow) {
        rateLimit.window = gateway.rateLimitWindow;
        delete gateway.rateLimitWindow;
        changed = true;
      }
      if (hasLegacyMax) {
        rateLimit.max = gateway.rateLimitMax;
        delete gateway.rateLimitMax;
        changed = true;
      }
      if (changed) {
        gateway.rateLimit = rateLimit;
        changes.push(
          "Moved gateway.rateLimitWindow/rateLimitMax → gateway.rateLimit.{window,max}",
        );
      }
    },
    legacyRules: [
      {
        path: ["gateway", "rateLimitWindow"],
        message: "Use gateway.rateLimit.window instead",
      },
      {
        path: ["gateway", "rateLimitMax"],
        message: "Use gateway.rateLimit.max instead",
      },
    ],
  }),

  defineLegacyConfigMigration({
    id: "evolution.auto-evolve-rename",
    describe: "将 evolution.autoEvolution 重命名为 evolution.autoEvolve",
    apply: (raw, changes) => {
      const evolution = getRecord(raw.evolution);
      if (!evolution) return;
      if ("autoEvolution" in evolution) {
        evolution.autoEvolve = evolution.autoEvolution;
        delete evolution.autoEvolution;
        changes.push("Renamed evolution.autoEvolution → evolution.autoEvolve");
      }
    },
    legacyRules: [
      {
        path: ["evolution", "autoEvolution"],
        message: "Use evolution.autoEvolve instead",
      },
    ],
  }),

  defineLegacyConfigMigration({
    id: "agent.scale-threshold-rename",
    describe: "将 agent.scaleThreshold 重命名为 agent.scaleThresholdMs",
    apply: (raw, changes) => {
      const agent = getRecord(raw.agent);
      if (!agent) return;
      if ("scaleThreshold" in agent) {
        agent.scaleThresholdMs = agent.scaleThreshold;
        delete agent.scaleThreshold;
        changes.push("Renamed agent.scaleThreshold → agent.scaleThresholdMs");
      }
    },
    legacyRules: [
      {
        path: ["agent", "scaleThreshold"],
        message: "Use agent.scaleThresholdMs instead",
      },
    ],
  }),
];

/**
 * 完整迁移列表（内置 + 外部可追加）。
 * 对标 OpenClaw 的 LEGACY_CONFIG_MIGRATIONS。
 */
export const LEGACY_CONFIG_MIGRATIONS: LegacyConfigMigrationSpec[] = [
  ...INTERNAL_MIGRATIONS,
];

/**
 * 聚合的 legacy 检测规则（用于 preview-only 警告）。
 * 对标 OpenClaw 的 LEGACY_CONFIG_MIGRATION_RULES。
 */
export const LEGACY_CONFIG_MIGRATION_RULES: LegacyConfigRule[] =
  LEGACY_CONFIG_MIGRATIONS.flatMap((m) => m.legacyRules ?? []);

// ─── 迁移运行器 ────────────────────────────────────────────────────

export interface LegacyMigrationResult {
  /** 迁移后的配置（无变更时为 null） */
  next: Record<string, unknown> | null;
  /** 人类可读的变更说明 */
  changes: string[];
}

/**
 * 顺序应用所有 legacy 迁移。
 * 对标 OpenClaw 的 applyLegacyDoctorMigrations。
 *
 * 注意：
 *   - 深拷贝输入避免污染原对象
 *   - 每个迁移独立 apply，异常不中断后续迁移
 *   - 无变更时返回 { next: null, changes: [] }
 */
export function applyLegacyDoctorMigrations(
  raw: unknown,
  extraMigrations: LegacyConfigMigrationSpec[] = [],
): LegacyMigrationResult {
  if (!isRecord(raw)) {
    return { next: null, changes: [] };
  }
  const next: Record<string, unknown> = structuredClone(raw);
  const changes: string[] = [];
  const allMigrations = [...LEGACY_CONFIG_MIGRATIONS, ...extraMigrations];

  for (const migration of allMigrations) {
    try {
      migration.apply(next, changes);
    } catch (err) {
      // 单个迁移失败不中断后续，记录到 changes
      const reason = err instanceof Error ? err.message : String(err);
      changes.push(
        `[SKIP] Migration "${migration.id}" failed: ${reason} — manual review required`,
      );
    }
  }

  if (changes.length === 0) {
    return { next: null, changes: [] };
  }
  return { next, changes };
}

// ─── 文件归档助手 ──────────────────────────────────────────────────

/**
 * 归档已迁移的 legacy 源文件。
 * 对标 OpenClaw 的 archiveLegacyStateSource。
 *
 * 策略：
 *   1. 重命名为 `<path>.migrated`
 *   2. 已存在归档时：
 *      - 内容相同：删除源文件（已归档过）
 *      - 内容不同：归档到 `<path>.migrated.<N>` 寻找空闲后缀
 *   3. 失败不抛出，记录到 warnings
 *
 * 永不删除未归档的源数据（遵循 AGENTS.md "Never delete; archive"）。
 */
export async function archiveLegacyStateSource(params: {
  filePath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const { filePath, label, changes, warnings } = params;
  const archivedPath = `${filePath}.migrated`;

  try {
    if (fs.existsSync(archivedPath)) {
      // 已存在归档：检查内容是否相同
      const [sourceBytes, archiveBytes] = await Promise.all([
        fs.promises.readFile(filePath),
        fs.promises.readFile(archivedPath),
      ]);
      if (sourceBytes.equals(archiveBytes)) {
        // 内容相同：源文件可安全删除（归档已存在）
        await fs.promises.rm(filePath, { force: true });
        changes.push(
          `Removed already-archived ${label} legacy source ${filePath}`,
        );
        return;
      }
      // 内容不同：寻找空闲归档路径
      const nextArchivePath = await firstFreeArchivePath(filePath);
      await safeRename(filePath, nextArchivePath);
      changes.push(
        `Archived ${label} legacy source -> ${nextArchivePath}`,
      );
      return;
    }
    // 无归档：直接重命名为 .migrated
    await safeRename(filePath, archivedPath);
    changes.push(`Archived ${label} legacy source -> ${archivedPath}`);
  } catch (err) {
    warnings.push(
      `Failed archiving ${label} legacy source: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** 跨设备安全的 rename：EXDEV 回退到 copy+unlink。 */
async function safeRename(src: string, dst: string): Promise<void> {
  try {
    await fs.promises.rename(src, dst);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "EXDEV") throw err;
    await fs.promises.copyFile(src, dst);
    await fs.promises.unlink(src);
  }
}

async function firstFreeArchivePath(sourcePath: string): Promise<string> {
  for (let index = 2; ; index++) {
    const candidate = `${sourcePath}.migrated.${index}`;
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
}

// ─── 顶层入口：migrateLegacyConfig ─────────────────────────────────

export interface MigrateLegacyConfigResult {
  /** 迁移后的配置（若 validate 失败可能为部分有效） */
  config: Record<string, unknown> | null;
  /** 变更说明 */
  changes: string[];
  /** 配置是否部分有效（迁移成功但仍有校验问题） */
  partiallyValid?: boolean;
}

/**
 * 应用 legacy 迁移并返回结果。
 * 对标 OpenClaw 的 migrateLegacyConfig。
 *
 * 与 EvoClaw 的 ConfigMigrationManager（版本链迁移）正交：
 * 此函数只处理同版本内的遗留字段结构调整。
 */
export function migrateLegacyConfig(
  raw: unknown,
  extraMigrations?: LegacyConfigMigrationSpec[],
): MigrateLegacyConfigResult {
  const { next, changes } = applyLegacyDoctorMigrations(raw, extraMigrations);
  if (!next) {
    return { config: null, changes: [] };
  }
  // 这里不调用 ConfigValidator，因为：
  //   1. 迁移的目标就是让配置通过后续校验
  //   2. 校验由调用方（如 CLI doctor）在迁移后单独执行
  //   3. 避免 core 包对 config-validator 形成循环依赖
  return { config: next, changes };
}

// ─── 持久化助手 ────────────────────────────────────────────────────

/**
 * 将迁移后的配置原子写入文件，并归档原文件。
 * 对标 OpenClaw doctor --fix 的"写入+归档"流程。
 *
 * 流程：
 *   1. 若 configPath 存在：归档原文件到 `<path>.migrated`
 *   2. 原子写入新配置到 configPath
 *   3. 记录变更到 changes
 *
 * 注：使用同步 atomicWriteFileSync 遵循 AGENTS.md 原子写约定。
 * archiveLegacyStateSource 为异步（fs.promises），故整体异步。
 */
export async function persistMigratedConfig(params: {
  configPath: string;
  config: Record<string, unknown>;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const { configPath, config, changes, warnings } = params;

  // 归档原文件（若存在）
  if (fs.existsSync(configPath)) {
    await archiveLegacyStateSource({
      filePath: configPath,
      label: "config",
      changes,
      warnings,
    });
  }

  // 确保目录存在
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 原子写入新配置（同步 fsync + rename）
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2));
  changes.push(`Wrote migrated config to ${configPath}`);
}
