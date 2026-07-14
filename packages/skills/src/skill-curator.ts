import {
  ServiceRegistry,
  EventBus,
  SystemEvents,
  atomicWriteFileSync,
  type Skill,
  type SkillExecutionResult,
  type SkillTrigger,
  type SkillCategory,
  type SkillDependency,
  type EventSubscription,
  type EvoEvent,
} from "@evoclaw/core";
import { atomicWriteFile, CrossProcessLock } from "@evoclaw/infrastructure";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { SkillValidator } from "./skill-validator";

/**
 * 原子写入文件：委托给 @evoclaw/core 的 atomicWriteFileSync。
 * 保持本地函数签名，避免调用方改动。
 */
function atomicWriteFileLocal(targetPath: string, content: string): void {
  atomicWriteFileSync(targetPath, content);
}

/**
 * 跨文件系统安全的同步移动（rename + EXDEV 回退到 copy+unlink）。
 * fs.renameSync 在跨设备布局下会抛 EXDEV，此时回退到复制后删除。
 */
function safeMoveSync(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "EXDEV") throw err;
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        safeMoveSync(path.join(src, entry), path.join(dst, entry));
      }
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      fs.copyFileSync(src, dst);
      fs.unlinkSync(src);
    }
  }
}

export interface SkillVersion {
  version: string;
  timestamp: Date;
  changes: string;
  trigger: "extraction" | "improvement" | "deprecation" | "manual";
  previousVersion: string | null;
}

export interface SkillEvolutionEntry {
  skillId: string;
  skillName: string;
  versions: SkillVersion[];
  extractionSource: {
    task: string;
    solution: string;
    context: Record<string, unknown>;
  } | null;
  improvementHistory: Array<{
    version: string;
    executionResult: SkillExecutionResult;
    userFeedback: string | null;
    changes: string;
    timestamp: Date;
  }>;
  deprecation: {
    reason: string;
    deprecatedAt: Date;
    deprecatedBy: string;
  } | null;
  createdAt: Date;
  lastUpdatedAt: Date;
  /**
   * Pinned 技能豁免自动归档。
   * 灵感来自 hermes-agent curator.py 的 pinned 不变量：
   * "Pinned skills bypass all auto-transitions"。
   * Pinning 是用户决策，不是模型决策。
   */
  pinned?: boolean;
  pinnedAt?: Date;
  pinnedReason?: string;
}

export interface ExtractionInput {
  task: string;
  solution: string;
  context: Record<string, unknown>;
}

export interface ImprovementInput {
  skillId: string;
  executionResult: SkillExecutionResult;
  userFeedback: string | null;
}

/**
 * 技能使用统计（sidecar: data/skill-curator/usage.json）。
 * 记录每个技能的最近使用时间、使用次数、创建时间与归档状态。
 */
export interface SkillUsageStats {
  skillName: string;
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
  status: "active" | "archived";
}

/**
 * 技能进化记录（持久化到 data/skill-curator/evolutions.json 的 records 字段）。
 * 记录技能的演化事件（如归档、恢复、改进、弃用等）。
 */
export interface EvolutionRecord {
  skillName: string;
  type: string;
  description: string;
  timestamp: string;
}

export class SkillCurator {
  private evolutions = new Map<string, SkillEvolutionEntry>();
  private maxEvolutionEntries = 1000;
  private validator: SkillValidator;
  /**
   * 自动提取已永久禁用。
   * 历史上此开关默认关闭，但通过 API 可启用，导致 data/skills/ 堆积
   * 大量 evoclaw-curator 自动生成的低质量技能（通用 7 步骤模板、
   * 机械关键词触发器）。现在自动提取逻辑已从 llm-caller.ts 移除，
   * 此字段保留仅为向后兼容，但不再可被启用。
   */
  private autoExtractionEnabled = false;
  /** 归档目录：被归档的技能移到此目录，可恢复。 */
  private archiveDir: string;
  /** 演化记录持久化目录。 */
  private storeDir: string;
  /** 持久化定时器。 */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  // ── 技能使用跟踪 + 自动归档周期（任务新增）──
  /** 技能目录：扫描此目录下的技能子目录用于自动归档。 */
  private skillsDir: string;
  /** 使用统计 sidecar：data/skill-curator/usage.json。 */
  private usageStats = new Map<string, SkillUsageStats>();
  /** 进化记录（简单 type/description/timestamp）：evolutions.json 的 records 字段。 */
  private evolutionRecords: EvolutionRecord[] = [];
  /** 自动扫描定时器。 */
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  /** 扫描间隔（默认 24 小时）。 */
  private scanIntervalMs = 24 * 60 * 60 * 1000;
  /** 过期阈值（默认 30 天未使用）。 */
  private expiryDays = 30;
  /** EventBus 订阅句柄，用于 dispose 时清理。 */
  private subscriptions: EventSubscription[] = [];

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    skillsDir?: string,
    archiveDir?: string,
    dataDir?: string
  ) {
    registry.registerService("skillCurator", this);
    this.validator = new SkillValidator();
    this.storeDir = dataDir
      ? path.resolve(dataDir)
      : path.resolve(process.cwd(), "data", "skill-curator");
    this.archiveDir = archiveDir
      ? path.resolve(archiveDir)
      : path.resolve(process.cwd(), "data", "skills-archive");
    this.skillsDir = skillsDir
      ? path.resolve(skillsDir)
      : path.resolve(process.cwd(), "data", "skills");
    this.loadFromDisk();
    this.loadUsage();
    this.subscribeSkillEvents();
  }

  // ── 技能使用跟踪 + 自动归档周期 ──

  /**
   * 启动定时扫描（默认 24 小时间隔），归档超过 expiryDays 天未使用的技能。
   * 定时器调用 unref()，不阻止进程退出。
   */
  start(): void {
    if (this.scanTimer) return;
    this.scanTimer = setInterval(() => {
      void this.runCycle().catch(err => {
        process.stderr.write(`[SkillCurator] Scan cycle failed: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }, this.scanIntervalMs);
    // unref：定时器不阻止进程退出（遵循 AGENTS.md 约定）
    this.scanTimer.unref();
  }

  /** 停止定时扫描。 */
  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  /**
   * 手动记录技能使用：更新 lastUsedAt + useCount，并持久化 usage.json。
   * 若技能此前未被跟踪，则以当前时间作为 createdAt 创建条目。
   * 已归档技能被使用时自动恢复为 active。
   */
  recordUsage(skillName: string): void {
    if (!skillName) return;
    const now = new Date().toISOString();
    const existing = this.usageStats.get(skillName);
    if (existing) {
      existing.lastUsedAt = now;
      existing.useCount += 1;
      if (existing.status === "archived") existing.status = "active";
    } else {
      this.usageStats.set(skillName, {
        skillName,
        lastUsedAt: now,
        useCount: 1,
        createdAt: now,
        status: "active",
      });
    }
    void this.persistUsage().catch(err => {
      process.stderr.write(`[SkillCurator] persistUsage failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  }

  /**
   * 记录技能进化历史（简单 type/description/timestamp）。
   * 追加到 data/skill-curator/evolutions.json 的 records 字段（通过 schedulePersist 持久化）。
   * 同时发布 skill.evolved 事件。
   */
  recordEvolution(
    skillName: string,
    evolution: { type: string; description: string; timestamp: string }
  ): void {
    if (!skillName) return;
    const record: EvolutionRecord = {
      skillName,
      type: evolution.type,
      description: evolution.description,
      timestamp: evolution.timestamp,
    };
    this.evolutionRecords.push(record);
    // 裁剪防止无界增长
    if (this.evolutionRecords.length > 5000) {
      this.evolutionRecords = this.evolutionRecords.slice(-5000);
    }
    this.schedulePersist();
    void this.eventBus.publish("skill.evolved", record, "skill-curator").catch(() => { /* best-effort */ });
  }

  /** 返回所有技能使用统计的快照。 */
  getUsageStats(): Map<string, SkillUsageStats> {
    return new Map(this.usageStats);
  }

  /** 返回进化记录历史；可选按技能名过滤。 */
  getEvolutionHistory(skillName?: string): EvolutionRecord[] {
    if (!skillName) return [...this.evolutionRecords];
    return this.evolutionRecords.filter(r => r.skillName === skillName);
  }

  /**
   * 执行一次扫描周期：扫描 skillsDir 下的技能目录，
   * 将超过 expiryDays 天未使用的技能归档到 archiveDir（永不删除）。
   * @returns archived: 实际归档的技能名列表；expired: 满足过期条件的技能名列表
   */
  async runCycle(): Promise<{ archived: string[]; expired: string[] }> {
    const archived: string[] = [];
    const expired: string[] = [];
    if (!fs.existsSync(this.skillsDir)) {
      return { archived, expired };
    }
    const now = Date.now();
    const expiryMs = this.expiryDays * 24 * 60 * 60 * 1000;

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillName = entry.name;
      const stats = this.usageStats.get(skillName);
      const lastUsed = stats?.lastUsedAt ? Date.parse(stats.lastUsedAt) : NaN;
      const isExpired = Number.isNaN(lastUsed)
        ? true // 从未记录使用：视为过期候选
        : (now - lastUsed) > expiryMs;
      if (!isExpired) continue;

      expired.push(skillName);

      // Pinned 技能豁免自动归档（hermes-agent 不变量：pinned 永不归档）
      const pinnedEntry = Array.from(this.evolutions.values()).find(
        e => e.skillName === skillName && e.pinned
      );
      if (pinnedEntry) continue;

      try {
        await this.archiveSkill(skillName);
        archived.push(skillName);
      } catch (err) {
        process.stderr.write(`[SkillCurator] Auto-archive failed for "${skillName}": ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    return { archived, expired };
  }

  /** 从 usage.json 加载使用统计。 */
  private loadUsage(): void {
    try {
      const filePath = path.join(this.storeDir, "usage.json");
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as { usage?: SkillUsageStats[] };
      if (Array.isArray(data.usage)) {
        for (const stat of data.usage) {
          if (stat && stat.skillName) {
            this.usageStats.set(stat.skillName, stat);
          }
        }
      }
    } catch (err) {
      process.stderr.write(`[SkillCurator] Failed to load usage stats: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  /** 原子写入 usage.json（CrossProcessLock 保护并发）。 */
  private async persistUsage(): Promise<void> {
    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true });
    }
    const filePath = path.join(this.storeDir, "usage.json");
    const data = {
      usage: Array.from(this.usageStats.values()),
      savedAt: new Date().toISOString(),
    };
    const lock = new CrossProcessLock(this.storeDir, "usage");
    await lock.withLock(() => atomicWriteFile(filePath, JSON.stringify(data, null, 2)));
  }

  /**
   * 订阅 EventBus 自动记录使用 / 进化：
   * - skill.installed → 初始化使用统计（createdAt）
   * - skill.executed → recordUsage（视为"使用"）
   * - skill.evolved → 记录外部发布的进化事件（去重）
   */
  private subscribeSkillEvents(): void {
    const subInstalled = this.eventBus.subscribe<{ skillId: string; name: string; version: string }>(
      SystemEvents.SKILL_INSTALLED,
      async (event: EvoEvent<{ skillId: string; name: string; version: string }>) => {
        const name = event.data?.name;
        if (!name) return;
        if (!this.usageStats.has(name)) {
          const now = new Date().toISOString();
          this.usageStats.set(name, {
            skillName: name,
            lastUsedAt: null,
            useCount: 0,
            createdAt: now,
            status: "active",
          });
          void this.persistUsage().catch(() => { /* best-effort */ });
        }
      }
    );
    this.subscriptions.push(subInstalled);

    const subExecuted = this.eventBus.subscribe<{ skillId: string; name: string; duration: number; success: boolean }>(
      SystemEvents.SKILL_EXECUTED,
      async (event: EvoEvent<{ skillId: string; name: string; duration: number; success: boolean }>) => {
        const name = event.data?.name;
        if (name) this.recordUsage(name);
      }
    );
    this.subscriptions.push(subExecuted);

    const subEvolved = this.eventBus.subscribe<EvolutionRecord>(
      "skill.evolved",
      async (event: EvoEvent<EvolutionRecord>) => {
        const rec = event.data;
        if (!rec?.skillName) return;
        // 去重：recordEvolution 已 push，此处仅补录外部发布的 evolved 事件
        const already = this.evolutionRecords.some(
          r => r.skillName === rec.skillName
            && r.timestamp === rec.timestamp
            && r.type === rec.type
            && r.description === rec.description
        );
        if (!already) {
          this.evolutionRecords.push(rec);
          if (this.evolutionRecords.length > 5000) {
            this.evolutionRecords = this.evolutionRecords.slice(-5000);
          }
          this.schedulePersist();
        }
      }
    );
    this.subscriptions.push(subEvolved);
  }

  /**
   * 自动提取已永久禁用，此方法仅为向后兼容保留，不再产生效果。
   * 技能只能通过 WebUI 手动创建或显式 API 调用创建。
   */
  enableAutoExtraction(): void {
    process.stdout.write("[SkillCurator] Auto-extraction is permanently DISABLED — call ignored. Skills can only be created manually via WebUI or explicit API.\n");
  }

  /** Disable automatic skill extraction. This is the default and permanent state. */
  disableAutoExtraction(): void {
    this.autoExtractionEnabled = false;
    process.stdout.write("[SkillCurator] Auto-extraction DISABLED — no skills will be auto-created.\n");
  }

  isAutoExtractionEnabled(): boolean {
    return false;
  }

  /**
   * Consider extracting a skill from the current task solution.
   *
   * 已永久禁用：历史上每 15 次工具调用会触发 SkillCurator 自动生成
   * 低质量技能（evoclaw-curator 作者、通用 7 步骤模板），导致
   * data/skills/ 堆积大量无用技能。现在此方法为 no-op。
   */
  considerExtraction(
    _sessionId: string,
    _toolCallCount: number,
    _lastToolResult: unknown,
    _taskDescription: string
  ): void {
    // 永久 no-op：自动提取已禁用
    return;
  }

  async extractSkillFromSolution(
    task: string,
    solution: string,
    context: Record<string, unknown>
  ): Promise<Skill | null> {
    // ── Gate 0: 自动提取已永久禁用 ──
    // 历史上此方法会从任务解决方案中提取技能，但生成的技能质量过低
    // （通用模板、机械关键词），现已禁用。技能只能通过 WebUI 手动创建。
    process.stdout.write("[SkillCurator] extractSkillFromSolution rejected: auto-extraction permanently disabled.\n");
    return null;
  }

  async improveSkill(
    skillId: string,
    executionResult: SkillExecutionResult,
    userFeedback: string | null
  ): Promise<Skill | null> {
    const entry = this.evolutions.get(skillId);
    if (!entry) return null;
    if (entry.deprecation) return null;

    const skillManager = this.registry.resolveService<{
      getSkill(id: string): Promise<Skill | undefined>;
    }>("skillManager");

    let skill: Skill | null = null;
    if (skillManager) {
      skill = (await skillManager.getSkill(skillId)) || null;
    }

    if (!skill) {
      skill = this.reconstructSkillFromEntry(entry);
    }

    const currentVersion = skill.version;
    const newVersion = this.incrementVersion(currentVersion);

    const changes: string[] = [];

    if (!executionResult.success) {
      const failureAnalysis = this.analyzeFailure(executionResult);
      changes.push(...failureAnalysis);

      skill.body.instructions = this.augmentInstructions(
        skill.body.instructions,
        failureAnalysis,
        "failure"
      );

      skill.triggers = this.adjustTriggers(skill.triggers, failureAnalysis);
    }

    if (userFeedback && this.isNegativeFeedback(userFeedback)) {
      const feedbackAnalysis = this.analyzeNegativeFeedback(userFeedback);
      changes.push(...feedbackAnalysis);

      skill.body.instructions = this.augmentInstructions(
        skill.body.instructions,
        feedbackAnalysis,
        "feedback"
      );
    }

    if (executionResult.success && userFeedback && !this.isNegativeFeedback(userFeedback)) {
      changes.push(`正向反馈整合: ${userFeedback.slice(0, 80)}`);
      skill.body.instructions = this.augmentInstructions(
        skill.body.instructions,
        [userFeedback],
        "positive"
      );
    }

    if (changes.length === 0) return skill;

    skill.version = newVersion;
    skill.lifecycle.version = newVersion;
    skill.lifecycle.lastUpdated = new Date();

    entry.versions.push({
      version: newVersion,
      timestamp: new Date(),
      changes: changes.join("; "),
      trigger: "improvement",
      previousVersion: currentVersion,
    });

    entry.improvementHistory.push({
      version: newVersion,
      executionResult,
      userFeedback,
      changes: changes.join("; "),
      timestamp: new Date(),
    });

    entry.lastUpdatedAt = new Date();

    this.persistSkillUpdate(skill, entry);
    // 改进后裁剪 evolutions Map，防止无界增长
    this.trimEvolutions();

    await this.eventBus.publish(
      "skill.curator.improved",
      {
        skillId,
        skillName: entry.skillName,
        oldVersion: currentVersion,
        newVersion,
        changes: changes.join("; "),
      },
      "skill-curator"
    );

    return skill;
  }

  async deprecateSkill(skillId: string, reason: string): Promise<boolean> {
    const entry = this.evolutions.get(skillId);
    if (!entry) return false;
    if (entry.deprecation) return false;

    const currentVersion = this.getCurrentVersion(skillId);

    entry.deprecation = {
      reason,
      deprecatedAt: new Date(),
      deprecatedBy: "curator",
    };

    entry.versions.push({
      version: currentVersion,
      timestamp: new Date(),
      changes: `技能已弃用: ${reason}`,
      trigger: "deprecation",
      previousVersion: currentVersion,
    });

    entry.lastUpdatedAt = new Date();

    const skillManager = this.registry.resolveService<{
      getSkill(id: string): Promise<Skill | undefined>;
    }>("skillManager");

    if (skillManager) {
      const skill = await skillManager.getSkill(skillId);
      if (skill) {
        skill.lifecycle.status = "disabled";
        skill.lifecycle.lastUpdated = new Date();
      }
    }

    await this.eventBus.publish(
      "skill.curator.deprecated",
      {
        skillId,
        skillName: entry.skillName,
        reason,
      },
      "skill-curator"
    );

    return true;
  }

  /**
   * 归档单个技能：将 `${skillsDir}/${skillName}` 目录移动到 `data/skills-archive/`。
   * 永不删除（遵循 AGENTS.md "Never delete; archive" 原则）。
   * 灵感来自 hermes-agent curator.py 的"永不删除，仅归档"不变量。
   * Pinned 技能豁免归档（hermes-agent: "Pinned skills bypass all auto-transitions"）。
   * @param skillName 技能名（skillsDir 下的子目录名）
   * @throws 当技能目录不存在时抛出错误
   */
  async archiveSkill(skillName: string): Promise<void> {
    if (!skillName) throw new Error("skillName is required");
    // 路径穿越防护：skillName 不能包含路径分隔符或 .. 序列
    this.validateSkillName(skillName);

    // 查找匹配的演化记录（用于 pinned 豁免与 skillId 元信息）
    const matchingEntry = Array.from(this.evolutions.values()).find(
      e => e.skillName === skillName
    );
    if (matchingEntry?.pinned) {
      process.stdout.write(
        `[SkillCurator] Skill ${skillName} is pinned — archive skipped\n`
      );
      return;
    }

    const skillDir = path.resolve(this.skillsDir, skillName);
    if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
      throw new Error(`Skill directory not found: ${skillDir}`);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveSubDir = path.join(this.archiveDir, `${skillName}-${timestamp}`);
    fs.mkdirSync(archiveSubDir, { recursive: true });

    // 移动所有文件到归档目录（safeMoveSync 处理跨设备 EXDEV）
    const entries = fs.readdirSync(skillDir);
    for (const entryName of entries) {
      const src = path.join(skillDir, entryName);
      const dst = path.join(archiveSubDir, entryName);
      safeMoveSync(src, dst);
    }
    // 删除空的原目录
    try { fs.rmdirSync(skillDir); } catch { /* ignore */ }

    // 写入归档元信息（archiveId 使用 crypto.randomUUID 保证唯一）
    const archiveMeta = {
      archiveId: crypto.randomUUID(),
      skillId: matchingEntry?.skillId ?? null,
      skillName,
      archivedAt: new Date().toISOString(),
      reason: "archive",
      originalPath: skillDir,
    };
    atomicWriteFileLocal(path.join(archiveSubDir, "_archive.json"), JSON.stringify(archiveMeta, null, 2));

    // 更新使用统计状态
    const stat = this.usageStats.get(skillName);
    if (stat) {
      stat.status = "archived";
      void this.persistUsage().catch(() => { /* best-effort */ });
    }

    // 更新演化记录（兼容旧 deprecation 字段）
    if (matchingEntry) {
      matchingEntry.deprecation = {
        reason: "归档: archive",
        deprecatedAt: new Date(),
        deprecatedBy: "curator-archive",
      };
      matchingEntry.lastUpdatedAt = new Date();
      this.schedulePersist();
    }

    // 记录进化事件（简单 type/description/timestamp）
    this.recordEvolution(skillName, {
      type: "archive",
      description: `技能已归档到 ${archiveSubDir}`,
      timestamp: new Date().toISOString(),
    });

    await this.eventBus.publish(
      "skill.curator.archived",
      { skillName, archivePath: archiveSubDir },
      "skill-curator"
    );
  }

  /**
   * 从归档恢复技能：将 `data/skills-archive/<skillName>-<timestamp>/` 内容移回 skillsDir。
   * 当存在多个归档时恢复最新（按 archivedAt 降序）的一个。
   * @param skillName 技能名
   * @throws 当归档不存在时抛出错误
   */
  async restoreSkill(skillName: string): Promise<void> {
    if (!skillName) throw new Error("skillName is required");
    // 路径穿越防护：与 archiveSkill 一致
    this.validateSkillName(skillName);
    if (!fs.existsSync(this.archiveDir)) {
      throw new Error(`Archive directory not found: ${this.archiveDir}`);
    }

    // 查找匹配 skillName 的归档（按 archivedAt 降序，取最新）
    const candidates: Array<{ archivePath: string; archivedAt: string }> = [];
    const entries = fs.readdirSync(this.archiveDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const archivePath = path.join(this.archiveDir, entry.name);
      const metaPath = path.join(archivePath, "_archive.json");
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as {
          skillName: string;
          archivedAt: string;
        };
        if (meta.skillName === skillName) {
          candidates.push({ archivePath, archivedAt: meta.archivedAt });
        }
      } catch { /* skip invalid */ }
    }
    if (candidates.length === 0) {
      throw new Error(`No archive found for skill: ${skillName}`);
    }
    candidates.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
    const { archivePath } = candidates[0];

    // 恢复到 skillsDir/skillName
    const restoreDir = path.resolve(this.skillsDir, skillName);
    fs.mkdirSync(restoreDir, { recursive: true });
    const archiveEntries = fs.readdirSync(archivePath);
    for (const entryName of archiveEntries) {
      if (entryName === "_archive.json") continue;
      const src = path.join(archivePath, entryName);
      const dst = path.join(restoreDir, entryName);
      safeMoveSync(src, dst);
    }
    // 删除已清空的归档目录
    try { fs.rmdirSync(archivePath); } catch { /* ignore */ }

    // 更新使用统计状态
    const now = new Date().toISOString();
    const stat = this.usageStats.get(skillName);
    if (stat) {
      stat.status = "active";
      stat.lastUsedAt = now;
      void this.persistUsage().catch(() => { /* best-effort */ });
    } else {
      this.usageStats.set(skillName, {
        skillName,
        lastUsedAt: now,
        useCount: 0,
        createdAt: now,
        status: "active",
      });
      void this.persistUsage().catch(() => { /* best-effort */ });
    }

    // 记录进化事件
    this.recordEvolution(skillName, {
      type: "restore",
      description: `技能从归档恢复到 ${restoreDir}`,
      timestamp: now,
    });

    await this.eventBus.publish(
      "skill.curator.restored",
      { skillName, restoredPath: restoreDir },
      "skill-curator"
    );
  }

  /** 列出所有归档的技能。 */
  listArchivedSkills(): Array<{ skillName: string; archivedAt: string; reason: string; archivePath: string }> {
    try {
      if (!fs.existsSync(this.archiveDir)) return [];
      const result: Array<{ skillName: string; archivedAt: string; reason: string; archivePath: string }> = [];
      const entries = fs.readdirSync(this.archiveDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const archivePath = path.join(this.archiveDir, entry.name);
        const metaPath = path.join(archivePath, "_archive.json");
        if (!fs.existsSync(metaPath)) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          result.push({
            skillName: meta.skillName,
            archivedAt: meta.archivedAt,
            reason: meta.reason,
            archivePath,
          });
        } catch { /* skip invalid */ }
      }
      return result.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
    } catch {
      return [];
    }
  }

  getSkillEvolution(skillId: string): SkillEvolutionEntry | null {
    return this.evolutions.get(skillId) || null;
  }

  /**
   * 设置技能的 pinned 状态。
   * Pinned 技能豁免自动归档（hermes-agent 不变量）。
   * Pinning 是用户决策，不是模型决策。
   * @param skillId 技能 ID
   * @param pinned 是否固定
   * @param reason 固定原因（可选）
   * @returns 是否成功
   */
  setPinned(skillId: string, pinned: boolean, reason?: string): boolean {
    const entry = this.evolutions.get(skillId);
    if (!entry) return false;

    entry.pinned = pinned;
    if (pinned) {
      entry.pinnedAt = new Date();
      entry.pinnedReason = reason || "用户手动固定";
    } else {
      entry.pinnedAt = undefined;
      entry.pinnedReason = undefined;
    }
    entry.lastUpdatedAt = new Date();
    this.schedulePersist();

    this.eventBus.publish(
      "skill.curator.pinned",
      { skillId, skillName: entry.skillName, pinned, reason: entry.pinnedReason },
      "skill-curator"
    ).catch(() => { /* best-effort */ });

    return true;
  }

  /** 查询技能是否被 pinned。 */
  isPinned(skillId: string): boolean {
    const entry = this.evolutions.get(skillId);
    return !!entry?.pinned;
  }

  /** 列出所有 pinned 技能。 */
  listPinnedSkills(): Array<{ skillId: string; skillName: string; pinnedAt: Date; reason: string }> {
    const result: Array<{ skillId: string; skillName: string; pinnedAt: Date; reason: string }> = [];
    for (const entry of this.evolutions.values()) {
      if (entry.pinned && entry.pinnedAt) {
        result.push({
          skillId: entry.skillId,
          skillName: entry.skillName,
          pinnedAt: entry.pinnedAt,
          reason: entry.pinnedReason || "",
        });
      }
    }
    return result.sort((a, b) => b.pinnedAt.getTime() - a.pinnedAt.getTime());
  }

  getAllEvolutions(): SkillEvolutionEntry[] {
    return Array.from(this.evolutions.values());
  }

  getEvolutionStats(): {
    totalTracked: number;
    totalExtractions: number;
    totalImprovements: number;
    totalDeprecations: number;
    averageVersionsPerSkill: number;
  } {
    const entries = Array.from(this.evolutions.values());
    const extractions = entries.filter((e) => e.extractionSource !== null).length;
    const improvements = entries.reduce(
      (sum, e) => sum + e.improvementHistory.length,
      0
    );
    const deprecations = entries.filter((e) => e.deprecation !== null).length;
    const totalVersions = entries.reduce(
      (sum, e) => sum + e.versions.length,
      0
    );

    return {
      totalTracked: entries.length,
      totalExtractions: extractions,
      totalImprovements: improvements,
      totalDeprecations: deprecations,
      averageVersionsPerSkill:
        entries.length > 0
          ? Math.round((totalVersions / entries.length) * 100) / 100
          : 0,
    };
  }

  private deriveSkillName(task: string): string {
    const cleaned = task
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")  // Strip non-ASCII (Chinese, etc.) — skill names must be ASCII
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 1)
      .slice(0, 8)
      .join("-")
      .slice(0, 120);

    if (!cleaned || cleaned.length < 3) {
      // Use a timestamp-based fallback that will pass validation
      return `extracted-skill-${Date.now()}`;
    }

    return cleaned;
  }

  private deriveDescription(task: string, solution: string): string {
    const taskSnippet = task.slice(0, 100).replace(/\n/g, " ").trim();
    return `从任务解决方案中提取的技能: ${taskSnippet}`;
  }

  private deriveInstructions(task: string, solution: string): string {
    const steps = this.extractStepsFromSolution(solution);
    const lines: string[] = [];
    lines.push(`# ${this.deriveSkillName(task)}`);
    lines.push("");
    lines.push("## Instructions");
    lines.push("");
    lines.push(`此技能从以下任务中提取: ${task.slice(0, 200)}`);
    lines.push("");

    if (steps.length > 0) {
      lines.push("执行步骤:");
      for (let i = 0; i < steps.length; i++) {
        lines.push(`${i + 1}. ${steps[i]}`);
      }
    } else {
      lines.push("解决方案:");
      lines.push(solution.slice(0, 2000));
    }

    lines.push("");
    return lines.join("\n");
  }

  private deriveTriggers(task: string, solution: string): SkillTrigger[] {
    const keywords = this.extractKeywordsFromText(task);
    const triggers: SkillTrigger[] = keywords.slice(0, 5).map((kw) => ({
      type: "keyword" as const,
      pattern: kw,
      description: `从任务中提取的关键词触发: ${kw}`,
    }));

    if (triggers.length === 0) {
      triggers.push({
        type: "keyword",
        pattern: this.deriveSkillName(task),
        description: "默认触发模式",
      });
    }

    return triggers;
  }

  private deriveKeywords(task: string, solution: string): string[] {
    return this.extractKeywordsFromText(`${task} ${solution}`).slice(0, 10);
  }

  private deriveCategory(
    task: string,
    context: Record<string, unknown>
  ): SkillCategory {
    const lower = task.toLowerCase();

    if (/搜索|查询|search|find|lookup|api|http/i.test(lower)) return "integration";
    if (/分析|统计|analyze|report|chart|数据/i.test(lower)) return "analysis";
    if (/生成|创建|generate|create|build|写/i.test(lower)) return "generation";
    if (/自动|定时|schedule|cron|automate/i.test(lower)) return "automation";
    if (/工具|计算|convert|format|处理/i.test(lower)) return "utility";

    return "custom";
  }

  private deriveDependencies(solution: string): SkillDependency[] {
    const deps: SkillDependency[] = [];

    if (/python3?|pip\s+install/i.test(solution)) {
      deps.push({ name: "python3", version: ">=3.8", optional: false });
    }
    if (/node|npm\s+install/i.test(solution)) {
      deps.push({ name: "node", version: ">=18.0", optional: false });
    }
    if (/curl|fetch|http/i.test(solution)) {
      deps.push({ name: "curl", version: "*", optional: true });
    }

    return deps;
  }

  private extractStepsFromSolution(solution: string): string[] {
    const steps: string[] = [];

    const numberedMatch = solution.match(
      /(?:^|\n)\s*(?:\d+[.)]\s*|[-*]\s*)(.+)/g
    );
    if (numberedMatch) {
      for (const m of numberedMatch) {
        const cleaned = m.replace(/^\s*(?:\d+[.)]\s*|[-*]\s*)/, "").trim();
        if (cleaned.length > 5) {
          steps.push(cleaned.slice(0, 200));
        }
      }
    }

    if (steps.length === 0) {
      const sentences = solution
        .split(/[.。!！?？\n]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 10);
      steps.push(...sentences.slice(0, 8));
    }

    return steps.slice(0, 10);
  }

  private extractKeywordsFromText(text: string): string[] {
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "shall", "can", "need", "dare", "ought",
      "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
      "as", "into", "through", "during", "before", "after", "above", "below",
      "between", "out", "off", "over", "under", "again", "further", "then",
      "once", "and", "but", "or", "nor", "not", "so", "yet", "both",
      "either", "neither", "each", "every", "all", "any", "few", "more",
      "most", "other", "some", "such", "no", "only", "own", "same", "than",
      "too", "very", "just", "because", "if", "when", "where", "how",
      "what", "which", "who", "whom", "this", "that", "these", "those",
      "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
      "she", "her", "it", "its", "they", "them", "their",
      "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都",
      "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你",
      "会", "着", "没有", "看", "好", "自己", "这",
    ]);

    const words = text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !stopWords.has(w));

    const freq = new Map<string, number>();
    for (const w of words) {
      freq.set(w, (freq.get(w) || 0) + 1);
    }

    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([word]) => word);
  }

  private escapeYamlString(value: string): string {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n");
    return `"${escaped}"`;
  }

  private validateYamlFrontMatter(content: string): boolean {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return false;

    const yaml = match[1];
    const lines = yaml.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("- ")) continue;

      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;

      const value = trimmed.slice(colonIdx + 1).trim();
      if (value === "") continue;
      if (value === "true" || value === "false") continue;
      if (/^-?\d+(\.\d+)?$/.test(value)) continue;
      if (value.startsWith('"') && value.endsWith('"')) continue;
      if (value.startsWith("'") && value.endsWith("'")) continue;
      if (value.startsWith("[") || value.startsWith("{")) continue;

      return false;
    }

    return true;
  }

  private generateSkillMd(params: {
    name: string;
    version: string;
    description: string;
    author: string;
    category: SkillCategory;
    keywords: string[];
    triggers: SkillTrigger[];
    requires: SkillDependency[];
    instructions: string;
    solution: string;
  }): string {
    const lines: string[] = [];
    lines.push("---");
    lines.push(`name: ${this.escapeYamlString(params.name)}`);
    lines.push(`version: ${this.escapeYamlString(params.version)}`);
    lines.push(`description: ${this.escapeYamlString(params.description)}`);
    lines.push(`author: ${this.escapeYamlString(params.author)}`);
    lines.push(`license: ${this.escapeYamlString("MIT")}`);
    lines.push(`category: ${this.escapeYamlString(params.category)}`);

    if (params.keywords.length > 0) {
      lines.push("keywords:");
      for (const kw of params.keywords) {
        lines.push(`  - ${this.escapeYamlString(kw)}`);
      }
    }

    if (params.triggers.length > 0) {
      lines.push("triggers:");
      for (const t of params.triggers) {
        lines.push(`  - type: ${this.escapeYamlString(t.type)}`);
        lines.push(`    pattern: ${this.escapeYamlString(t.pattern)}`);
        lines.push(`    description: ${this.escapeYamlString(t.description)}`);
      }
    }

    if (params.requires.length > 0) {
      lines.push("requires:");
      for (const r of params.requires) {
        lines.push(`  - name: ${this.escapeYamlString(r.name)}`);
        lines.push(`    version: ${this.escapeYamlString(r.version)}`);
        lines.push(`    optional: ${r.optional}`);
      }
    }

    lines.push("---");
    lines.push("");
    lines.push(params.instructions);
    lines.push("");
    lines.push("## Examples");
    lines.push("");
    lines.push(`- "使用 ${params.name} 完成任务"`);
    lines.push("");
    lines.push("---");
    lines.push("*Auto-extracted by EvoClaw SkillCurator*");

    const result = lines.join("\n");

    if (!this.validateYamlFrontMatter(result)) {
      const forceEscaped = result.replace(
        /^---\n([\s\S]*?)\n---/,
        (match) => {
          return match
            .replace(/\\n/g, "\\\\n")
            .replace(/:(?!["\n])/g, (m) => m);
        }
      );
      if (this.validateYamlFrontMatter(forceEscaped)) {
        return forceEscaped;
      }
    }

    return result;
  }

  private analyzeFailure(result: SkillExecutionResult): string[] {
    const analyses: string[] = [];

    if (result.errors && result.errors.length > 0) {
      for (const err of result.errors) {
        if (/timeout|timed?\s*out/i.test(err)) {
          analyses.push(`超时错误: 建议增加执行时间限制或优化耗时操作 - ${err.slice(0, 80)}`);
        } else if (/permission|access\s*denied|forbidden/i.test(err)) {
          analyses.push(`权限错误: 建议检查沙箱策略或添加必要权限 - ${err.slice(0, 80)}`);
        } else if (/not\s*found|missing|undefined|null/i.test(err)) {
          analyses.push(`资源缺失: 建议添加前置检查或降级处理 - ${err.slice(0, 80)}`);
        } else if (/syntax|parse|invalid/i.test(err)) {
          analyses.push(`语法/解析错误: 建议添加输入验证 - ${err.slice(0, 80)}`);
        } else {
          analyses.push(`执行失败: ${err.slice(0, 80)}`);
        }
      }
    }

    if (result.duration > 30000) {
      analyses.push("执行时间过长: 建议优化性能或添加分步执行策略");
    }

    return analyses;
  }

  private analyzeNegativeFeedback(feedback: string): string[] {
    const analyses: string[] = [];
    const lower = feedback.toLowerCase();

    if (/慢|slow|timeout|耗时|太长/i.test(feedback)) {
      analyses.push("用户反馈速度问题: 建议优化执行效率或添加缓存机制");
    }
    if (/不准|错误|wrong|incorrect|不对|偏差/i.test(feedback)) {
      analyses.push("用户反馈准确性问题: 建议增加结果验证步骤");
    }
    if (/复杂|难用|confusing|不直观|不好用/i.test(feedback)) {
      analyses.push("用户反馈易用性问题: 建议简化执行步骤或添加引导");
    }
    if (/缺少|missing|没有|lack|缺/i.test(feedback)) {
      analyses.push("用户反馈功能缺失: 建议扩展技能覆盖范围");
    }

    if (analyses.length === 0) {
      analyses.push(`用户负面反馈: ${feedback.slice(0, 100)}`);
    }

    return analyses;
  }

  private isNegativeFeedback(feedback: string): boolean {
    const negativePatterns = /不好|差|慢|错|不准|不对|失败|问题|bug|bad|wrong|slow|incorrect|poor|terrible|awful|broken|fail|error|不工作|没用|失望/i;
    return negativePatterns.test(feedback);
  }

  private augmentInstructions(
    currentInstructions: string,
    additions: string[],
    type: "failure" | "feedback" | "positive"
  ): string {
    const sectionTitle =
      type === "failure"
        ? "已知问题与规避策略"
        : type === "feedback"
        ? "用户反馈改进"
        : "最佳实践";

    const lines: string[] = [];
    lines.push("");
    lines.push(`## ${sectionTitle}`);
    lines.push("");
    for (const addition of additions) {
      lines.push(`- ${addition}`);
    }
    lines.push("");

    return currentInstructions + lines.join("\n");
  }

  private adjustTriggers(
    currentTriggers: SkillTrigger[],
    failureAnalysis: string[]
  ): SkillTrigger[] {
    const hasTimeoutIssue = failureAnalysis.some((a) =>
      /超时|timeout/i.test(a)
    );

    if (hasTimeoutIssue) {
      const exists = currentTriggers.some(
        (t) => t.type === "event" && t.pattern === "skill.timeout"
      );
      if (!exists) {
        return [
          ...currentTriggers,
          {
            type: "event",
            pattern: "skill.timeout",
            description: "超时事件触发降级处理",
          },
        ];
      }
    }

    return currentTriggers;
  }

  private incrementVersion(version: string): string {
    const parts = version.split(".").map(Number);
    if (parts.length < 3 || parts.some(isNaN)) {
      return "1.0.1";
    }
    parts[2] += 1;
    return parts.join(".");
  }

  private getCurrentVersion(skillId: string): string {
    const entry = this.evolutions.get(skillId);
    if (!entry || entry.versions.length === 0) return "1.0.0";
    return entry.versions[entry.versions.length - 1].version;
  }

  private resolveSkillDir(skillName: string): string {
    const path = require("path") as typeof import("path");
    return path.resolve(process.cwd(), "data", "skills", skillName);
  }

  private async persistSkillUpdate(
    skill: Skill,
    entry: SkillEvolutionEntry
  ): Promise<void> {
    try {
      const skillDir = path.dirname(skill.installPath);
      if (!fs.existsSync(skillDir)) return;

      const skillMdPath = skill.installPath;
      if (fs.existsSync(skillMdPath)) {
        const content = fs.readFileSync(skillMdPath, "utf-8");
        // 仅替换 frontmatter 中的 version 字段，避免误替换 body 内容。
        // 使用函数形式的 replace，避免 skill.version 中的 $ 字符被解释为
        // 替换模式的特殊序列（如 $1、$& 等）导致内容损坏。
        const updatedContent = content.replace(
          /^(---[\s\S]*?version:\s*).+/m,
          (match, p1) => `${p1}${skill.version}`
        );
        atomicWriteFileLocal(skillMdPath, updatedContent);
      }

      const metaPath = path.join(skillDir, "_meta.json");
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        meta.version = skill.version;
        atomicWriteFileLocal(metaPath, JSON.stringify(meta, null, 2));
      }

      this.schedulePersist();
    } catch (err) {
      process.stderr.write(
        "[SkillCurator] Failed to persist skill update:" + " " + (err instanceof Error ? err.message : String(err)) + "\n"
      );
    }
  }

  /** 调度延迟持久化演化记录到磁盘。 */
  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      // persistToDisk 现为异步（acquire 已异步化），用 void + catch 处理 Promise
      void this.persistToDisk().catch(err => {
        process.stderr.write(`[SkillCurator] Scheduled persist failed: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }, 5000);
    this.persistTimer.unref();
  }

  /** 将演化记录持久化到磁盘（atomicWriteFile + CrossProcessLock 保护并发）。 */
  private async persistToDisk(): Promise<void> {
    try {
      if (!fs.existsSync(this.storeDir)) {
        fs.mkdirSync(this.storeDir, { recursive: true });
      }
      const filePath = path.join(this.storeDir, "evolutions.json");
      const all = Array.from(this.evolutions.values());
      // Pinned 技能必须保留（hermes-agent 不变量）；
      // 非 pinned 按 lastUpdatedAt 降序保留最近 500 条。
      const pinned = all.filter(e => e.pinned);
      const nonPinned = all
        .filter(e => !e.pinned)
        .sort((a, b) => b.lastUpdatedAt.getTime() - a.lastUpdatedAt.getTime())
        .slice(0, 500);
      const kept = new Map<string, SkillEvolutionEntry>();
      for (const e of pinned) kept.set(e.skillId, e);
      for (const e of nonPinned) kept.set(e.skillId, e);
      const data = {
        evolutions: Array.from(kept.values()),
        records: this.evolutionRecords.slice(-5000),
        savedAt: new Date().toISOString(),
      };
      const lock = new CrossProcessLock(this.storeDir, "evolutions");
      await lock.withLock(() => atomicWriteFile(filePath, JSON.stringify(data, null, 2)));
    } catch (err) {
      process.stderr.write(`[SkillCurator] Failed to persist evolutions: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  /** 从磁盘加载演化记录。 */
  private loadFromDisk(): void {
    try {
      const filePath = path.join(this.storeDir, "evolutions.json");
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as {
        evolutions: SkillEvolutionEntry[];
        records?: EvolutionRecord[];
      };
      if (Array.isArray(data.evolutions)) {
        for (const entry of data.evolutions) {
          if (entry && entry.skillId) {
            // 恢复 Date 对象
            if (entry.createdAt) entry.createdAt = new Date(entry.createdAt);
            if (entry.lastUpdatedAt) entry.lastUpdatedAt = new Date(entry.lastUpdatedAt);
            if (entry.versions) {
              entry.versions = entry.versions.map(v => ({ ...v, timestamp: new Date(v.timestamp) }));
            }
            if (entry.improvementHistory) {
              entry.improvementHistory = entry.improvementHistory.map(h => ({ ...h, timestamp: new Date(h.timestamp) }));
            }
            if (entry.deprecation?.deprecatedAt) {
              entry.deprecation.deprecatedAt = new Date(entry.deprecation.deprecatedAt);
            }
            if (entry.pinnedAt) {
              entry.pinnedAt = new Date(entry.pinnedAt);
            }
            // 一致性修复：pinned 为 true 但 pinnedAt 缺失时补齐
            if (entry.pinned && !entry.pinnedAt) {
              entry.pinnedAt = entry.lastUpdatedAt || entry.createdAt || new Date();
              if (!entry.pinnedReason) entry.pinnedReason = "用户手动固定（从磁盘恢复时补齐）";
            }
            this.evolutions.set(entry.skillId, entry);
          }
        }
        // 磁盘恢复后裁剪，防止 Map 超过 maxEvolutionEntries
        this.trimEvolutions();
      }
      if (Array.isArray(data.records)) {
        this.evolutionRecords = data.records.slice(-5000);
      }
    } catch (err) {
      process.stderr.write(`[SkillCurator] Failed to load evolutions from disk: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  private trimEvolutions(): void {
    if (this.evolutions.size <= this.maxEvolutionEntries) return;

    // Pinned 技能豁免裁剪（hermes-agent 不变量：pinned 永不丢失）
    const candidates = Array.from(this.evolutions.entries())
      .filter(([, entry]) => !entry.pinned)
      .sort((a, b) => a[1].lastUpdatedAt.getTime() - b[1].lastUpdatedAt.getTime());

    const toRemoveCount = this.evolutions.size - this.maxEvolutionEntries;
    const toRemove = candidates.slice(0, toRemoveCount);
    for (const [key] of toRemove) {
      this.evolutions.delete(key);
    }
  }

  /**
   * Quality gate: reject skill names that are generic, auto-generated, or non-English.
   * Must be a meaningful multi-word name (at least 5 chars, containing a hyphen).
   */
  private isValidSkillName(name: string): boolean {
    // Must match the required naming convention: lowercase, starts with letter, alphanumeric + hyphens
    const NAME_REGEX = /^[a-z][a-z0-9-]*$/;
    if (!NAME_REGEX.test(name)) return false;

    // Reject reserved prefixes
    const RESERVED_PREFIXES = ["curated-skill", "custom-skill", "new-skill", "test-skill", "temp-", "extracted-skill"];
    for (const prefix of RESERVED_PREFIXES) {
      if (name.startsWith(prefix)) return false;
    }

    // Reject generic single-word names
    const GENERIC_NAMES = ["task", "test", "skill", "tool", "helper", "util", "plugin", "script", "module", "action"];
    if (GENERIC_NAMES.includes(name)) return false;

    // Reject names that are too short or lack a hyphen (must be multi-word)
    if (name.length < 5) return false;
    if (!name.includes("-")) return false;

    return true;
  }

  /**
   * 路径穿越防护：验证 skillName 不含路径分隔符或 .. 序列。
   * 防止 archiveSkill/restoreSkill 被恶意输入操纵到 skillsDir 之外的目录。
   */
  private validateSkillName(skillName: string): void {
    if (
      skillName.includes("/") ||
      skillName.includes("\\") ||
      skillName.includes("..") ||
      skillName.includes("\0")
    ) {
      throw new Error(`Invalid skillName (path traversal detected): ${skillName}`);
    }
  }

  /**
   * Quality gate: reject descriptions that are placeholders or too short.
   * Must be a meaningful sentence of at least 50 characters.
   */
  private isValidDescription(desc: string): boolean {
    if (!desc || desc.trim().length < 50) return false;

    const PLACEHOLDER_PATTERNS = [
      /^执行操作(?:。)?$/,
      /^execut(?:e|ing)\s+(?:the\s+)?task/i,
      /^方案\d*$/,
      /^解决[方方]案[ABCDEFG]?(?:方案)?$/,
      /^任务[ABCDEFG]?(?:描述)?$/,
      /^auto-generated/i,
      /^placeholder/i,
      /^te?mp$/i,
      /^follow\s+the\s+steps$/i,
      /^do\s+the\s+thing$/i,
      /^extract(?:ed|ing)?\s+from\s+/i,
      /^derived\s+from\s+/i,
      /^generated\s+from\s+/i,
      /^a\s+skill\s+(?:to|for|that)/i,
      /^this\s+skill\s+/i,
    ];
    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.test(desc.trim())) return false;
    }
    return true;
  }

  /**
   * Quality gate: reject instructions that are too short or pure placeholders.
   * Must be at least 300 characters of meaningful content.
   */
  private isValidInstructions(instructions: string): boolean {
    if (!instructions || instructions.trim().length < 300) return false;

    const PLACEHOLDER_PATTERNS = [
      /^执行操作(?:。)?$/,
      /^execut(?:e|ing)\s+(?:the\s+)?task/i,
      /^方案\d*$/,
      /^解决[方方]案[ABCDEFG]?(?:方案)?$/,
      /^任务[ABCDEFG]?(?:描述)?$/,
      /^auto-generated/i,
      /^placeholder/i,
      /^extract(?:ed|ing)?\s+from\s+/i,
      /^derived\s+from\s+/i,
      /^generated\s+from\s+/i,
      /^this\s+skill\s+/i,
      /^a\s+skill\s+(?:to|for|that)/i,
    ];
    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.test(instructions.trim())) return false;
    }
    return true;
  }

  private reconstructSkillFromEntry(entry: SkillEvolutionEntry): Skill {
    const latestVersion = entry.versions.length > 0
      ? entry.versions[entry.versions.length - 1].version
      : "1.0.0";

    let instructions = `从任务解决方案中提取的技能: ${entry.skillName}`;
    if (entry.extractionSource) {
      instructions = `从任务解决方案中提取的技能: ${entry.extractionSource.task.slice(0, 200)}`;
    }

    for (const imp of entry.improvementHistory) {
      instructions += `\n- 改进记录 (v${imp.version}): ${imp.changes.slice(0, 100)}`;
    }

    return {
      id: entry.skillId,
      name: entry.skillName,
      version: latestVersion,
      description: `从任务解决方案中提取的技能: ${entry.skillName}`,
      author: "evoclaw-curator",
      license: "MIT",
      keywords: [],
      category: "custom",
      entryPoint: "",
      installPath: "",
      lifecycle: {
        status: entry.deprecation ? "disabled" : "active",
        version: latestVersion,
        installDate: entry.createdAt,
        lastUpdated: entry.lastUpdatedAt,
        healthCheck: null,
      },
      config: {},
      requires: [],
      provides: [],
      triggers: [],
      sandboxPolicy: {
        allowNetwork: false,
        allowFileSystem: true,
        allowSubprocess: false,
        maxExecutionTime: 60000,
        maxMemoryMB: 256,
        allowedHosts: [],
        allowedPaths: [],
      },
      body: {
        instructions,
        scripts: {},
        examples: [],
        hooks: {},
      },
      stats: {
        invocationCount: 0,
        successCount: 0,
        failureCount: 0,
        averageDuration: 0,
        lastInvocation: null,
        userRating: 0,
      },
    };
  }

  /**
   * 释放资源：清除定时器、取消 EventBus 订阅并立即持久化最后一次状态。
   * 防止定时器泄漏和进程退出时数据丢失。
   */
  dispose(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.stop();
    for (const sub of this.subscriptions) {
      try { this.eventBus.unsubscribe(sub.id); } catch { /* ignore */ }
    }
    this.subscriptions = [];
    // persistToDisk 现为异步（CrossProcessLock.acquire 已异步化），用 void + catch 处理 Promise。
    // 注意：进程退出时 Node 不会等待此 Promise，但写入本身是同步的 atomicWriteFile，
    // 仅锁获取可能产生短暂等待。
    void this.persistToDisk().catch(err => {
      process.stderr.write(`[SkillCurator] dispose persist failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
