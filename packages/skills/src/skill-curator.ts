import {
  ServiceRegistry,
  EventBus,
  type Skill,
  type SkillExecutionResult,
  type SkillTrigger,
  type SkillCategory,
  type SkillDependency,
} from "@evoclaw/core";
import { v4 as uuid } from "uuid";
import * as fs from "fs";
import * as path from "path";
import { SkillValidator } from "./skill-validator";

/**
 * 原子写入文件（temp + fsync + rename）。
 * 防止崩溃时产生截断的 SKILL.md / _meta.json。
 */
function atomicWriteFileLocal(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, content, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (fs.existsSync(targetPath)) {
      const st = fs.statSync(targetPath);
      fs.chmodSync(tmpPath, st.mode);
    }
  } catch {
    // 权限复制失败不阻断
  }
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EXDEV" || code === "EBUSY") {
      const c = fs.readFileSync(tmpPath, "utf-8");
      const fd2 = fs.openSync(targetPath, "w");
      try {
        fs.writeFileSync(fd2, c, "utf-8");
        fs.fsyncSync(fd2);
      } finally {
        fs.closeSync(fd2);
      }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    } else {
      throw err;
    }
  }
}

/**
 * 简单跨进程文件锁（flag:wx + PID + stale 检测）。
 * 用于保护演化记录持久化的读-改-写。
 */
class LocalFileLock {
  constructor(private readonly lockPath: string) {
    const dir = path.dirname(this.lockPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private isProcessAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  acquire(timeoutMs = 30_000): void {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        fs.writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
        return;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EEXIST") throw err;
        try {
          const raw = fs.readFileSync(this.lockPath, "utf-8");
          const data = JSON.parse(raw) as { pid: number };
          if (!this.isProcessAlive(data.pid)) {
            fs.unlinkSync(this.lockPath);
            continue;
          }
        } catch {
          try { fs.unlinkSync(this.lockPath); } catch { /* ignore */ }
          continue;
        }
        const sleepMs = 100;
        const start = Date.now();
        while (Date.now() - start < sleepMs) { /* busy wait */ }
      }
    }
    throw new Error(`Lock timed out: ${this.lockPath}`);
  }

  release(): void {
    try {
      const raw = fs.readFileSync(this.lockPath, "utf-8");
      const data = JSON.parse(raw) as { pid: number };
      if (data.pid === process.pid) fs.unlinkSync(this.lockPath);
    } catch { /* ignore */ }
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

export class SkillCurator {
  private evolutions = new Map<string, SkillEvolutionEntry>();
  private maxEvolutionEntries = 1000;
  private validator: SkillValidator;
  /** Auto-extraction is OFF by default — must be explicitly enabled via API or config. */
  private autoExtractionEnabled = false;
  /** 归档目录：被归档的技能移到此目录，可恢复。 */
  private archiveDir: string;
  /** 演化记录持久化目录。 */
  private storeDir: string;
  /** 持久化定时器。 */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    registry.registerService("skillCurator", this);
    this.validator = new SkillValidator();
    this.storeDir = path.resolve(process.cwd(), "data", "skill-curator");
    this.archiveDir = path.resolve(process.cwd(), "data", "skills-archive");
    this.loadFromDisk();
  }

  /** Enable automatic skill extraction from task solutions. Use with caution. */
  enableAutoExtraction(): void {
    this.autoExtractionEnabled = true;
    process.stdout.write("[SkillCurator] Auto-extraction ENABLED — skills may be created from task solutions.");
  }

  /** Disable automatic skill extraction. This is the default. */
  disableAutoExtraction(): void {
    this.autoExtractionEnabled = false;
    process.stdout.write("[SkillCurator] Auto-extraction DISABLED — no skills will be auto-created.");
  }

  isAutoExtractionEnabled(): boolean {
    return this.autoExtractionEnabled;
  }

  /**
   * Consider extracting a skill from the current task solution.
   * Triggered periodically (every 15 tool calls) when auto-extraction is enabled,
   * inspired by Hermes's GEPA algorithm.
   */
  considerExtraction(
    sessionId: string,
    toolCallCount: number,
    lastToolResult: unknown,
    taskDescription: string
  ): void {
    if (!this.autoExtractionEnabled) {
      process.stdout.write(
        `[SkillCurator] Extraction considered but skipped: auto-extraction disabled (session=${sessionId}, toolCallCount=${toolCallCount})`
      );
      return;
    }

    if (toolCallCount % 15 !== 0) {
      process.stdout.write(
        `[SkillCurator] Extraction considered but not triggered: toolCallCount=${toolCallCount} is not a multiple of 15 (session=${sessionId})`
      );
      return;
    }

    process.stdout.write(
      `[SkillCurator] Auto-extraction triggered at toolCallCount=${toolCallCount} for session=${sessionId}`
    );

    const solution = typeof lastToolResult === "string"
      ? lastToolResult
      : JSON.stringify(lastToolResult);

    this.extractSkillFromSolution(taskDescription, solution, {
      sessionId,
      toolCallCount,
      trigger: "gepa_periodic",
    }).catch((err) => {
      process.stderr.write(
        `[SkillCurator] Periodic auto-extraction failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  async extractSkillFromSolution(
    task: string,
    solution: string,
    context: Record<string, unknown>
  ): Promise<Skill | null> {
    // ── Gate 0: auto-extraction must be explicitly enabled ──
    if (!this.autoExtractionEnabled) {
      return null;
    }

    const skillName = this.deriveSkillName(task);
    const skillDescription = this.deriveDescription(task, solution);
    const instructions = this.deriveInstructions(task, solution);

    // ── Quality gate: reject garbage/placeholder skills ──
    if (!this.isValidSkillName(skillName)) {
      process.stderr.write(`[SkillCurator] Rejected auto-extracted skill: invalid name "${skillName}"`);
      return null;
    }
    if (!this.isValidDescription(skillDescription)) {
      process.stderr.write(`[SkillCurator] Rejected auto-extracted skill: placeholder description for "${skillName}"`);
      return null;
    }
    if (!this.isValidInstructions(instructions)) {
      process.stderr.write(`[SkillCurator] Rejected auto-extracted skill: insufficient instructions for "${skillName}"`);
      return null;
    }

    const triggers = this.deriveTriggers(task, solution);
    const keywords = this.deriveKeywords(task, solution);
    const category = this.deriveCategory(task, context);
    const requires = this.deriveDependencies(solution);

    const version = "1.0.0";
    const skillId = uuid();

    const skillManager = this.registry.resolveService<{
      installSkill(path: string): Promise<Skill>;
    }>("skillManager");

    const skillMd = this.generateSkillMd({
      name: skillName,
      version,
      description: skillDescription,
      author: "evoclaw-curator",
      category,
      keywords,
      triggers,
      requires,
      instructions,
      solution,
    });

    const skillDir = this.resolveSkillDir(skillName);
    const fs = await import("fs");
    const path = await import("path");

    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
    }

    const skillMdPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(skillMdPath, skillMd, "utf-8");

    const meta = {
      name: skillName,
      version,
      description: skillDescription,
      category,
      keywords,
      author: "evoclaw-curator",
      license: "MIT",
    };
    fs.writeFileSync(
      path.join(skillDir, "_meta.json"),
      JSON.stringify(meta, null, 2),
      "utf-8"
    );

    let installedSkill: Skill | null = null;
    if (skillManager) {
      try {
        installedSkill = await skillManager.installSkill(skillMdPath);
      } catch (err) {
        process.stderr.write("[SkillCurator] Failed to auto-install extracted skill:" + " " + (err instanceof Error ? err.message : String(err)));
      }
    }

    if (!installedSkill) {
      installedSkill = {
        id: skillId,
        name: skillName,
        version,
        description: skillDescription,
        author: "evoclaw-curator",
        license: "MIT",
        keywords,
        category,
        entryPoint: skillMdPath,
        installPath: skillMdPath,
        lifecycle: {
          status: "active",
          version,
          installDate: new Date(),
          lastUpdated: new Date(),
          healthCheck: null,
        },
        config: {},
        requires,
        provides: [],
        triggers,
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

    const entry: SkillEvolutionEntry = {
      skillId: installedSkill.id,
      skillName,
      versions: [
        {
          version,
          timestamp: new Date(),
          changes: `从成功任务中提取: ${task.slice(0, 80)}`,
          trigger: "extraction",
          previousVersion: null,
        },
      ],
      extractionSource: { task, solution, context },
      improvementHistory: [],
      deprecation: null,
      createdAt: new Date(),
      lastUpdatedAt: new Date(),
    };

    this.evolutions.set(entry.skillId, entry);
    this.trimEvolutions();

    await this.eventBus.publish(
      "skill.curator.extracted",
      {
        skillId: entry.skillId,
        skillName,
        version,
        task: task.slice(0, 100),
      },
      "skill-curator"
    );

    return installedSkill;
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
   * 归档技能：将技能目录移动到归档目录，可恢复。
   * 灵感来自 hermes-agent curator.py 的"永不删除，仅归档"不变量。
   * @param skillId 技能 ID
   * @param reason 归档原因
   * @returns 归档路径，失败返回 null
   */
  async archiveSkill(skillId: string, reason: string): Promise<string | null> {
    const entry = this.evolutions.get(skillId);
    const skillManager = this.registry.resolveService<{
      getSkill(id: string): Promise<Skill | undefined>;
    }>("skillManager");

    if (!skillManager) return null;
    const skill = await skillManager.getSkill(skillId);
    if (!skill || !skill.installPath) return null;

    try {
      const skillDir = path.dirname(skill.installPath);
      if (!fs.existsSync(skillDir)) return null;

      // 创建归档目录：data/skills-archive/<skillName>-<timestamp>/
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const archiveSubDir = path.join(this.archiveDir, `${entry?.skillName || skill.name}-${timestamp}`);
      fs.mkdirSync(archiveSubDir, { recursive: true });

      // 移动所有文件到归档目录
      const entries = fs.readdirSync(skillDir);
      for (const entryName of entries) {
        const src = path.join(skillDir, entryName);
        const dst = path.join(archiveSubDir, entryName);
        fs.renameSync(src, dst);
      }
      // 删除空的原目录
      try { fs.rmdirSync(skillDir); } catch { /* ignore */ }

      // 写入归档元信息
      const archiveMeta = {
        skillId,
        skillName: entry?.skillName || skill.name,
        archivedAt: new Date().toISOString(),
        reason,
        originalPath: skillDir,
      };
      atomicWriteFileLocal(path.join(archiveSubDir, "_archive.json"), JSON.stringify(archiveMeta, null, 2));

      // 更新演化记录
      if (entry) {
        entry.deprecation = {
          reason: `归档: ${reason}`,
          deprecatedAt: new Date(),
          deprecatedBy: "curator-archive",
        };
        entry.lastUpdatedAt = new Date();
        this.schedulePersist();
      }

      await this.eventBus.publish(
        "skill.curator.archived",
        { skillId, skillName: entry?.skillName || skill.name, reason, archivePath: archiveSubDir },
        "skill-curator"
      );

      return archiveSubDir;
    } catch (err) {
      process.stderr.write(`[SkillCurator] Failed to archive skill ${skillId}: ${err instanceof Error ? err.message : String(err)}\n`);
      return null;
    }
  }

  /**
   * 恢复归档的技能。
   * @param archivePath 归档路径
   * @returns 恢复的技能目录路径，失败返回 null
   */
  async restoreSkill(archivePath: string): Promise<string | null> {
    try {
      if (!fs.existsSync(archivePath)) return null;
      const metaPath = path.join(archivePath, "_archive.json");
      if (!fs.existsSync(metaPath)) return null;
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as {
        skillId: string;
        skillName: string;
        originalPath: string;
      };

      // 恢复到原路径
      fs.mkdirSync(meta.originalPath, { recursive: true });
      const entries = fs.readdirSync(archivePath);
      for (const entryName of entries) {
        if (entryName === "_archive.json") continue;
        const src = path.join(archivePath, entryName);
        const dst = path.join(meta.originalPath, entryName);
        fs.renameSync(src, dst);
      }
      // 删除归档目录
      try { fs.rmdirSync(archivePath); } catch { /* ignore */ }

      await this.eventBus.publish(
        "skill.curator.restored",
        { skillId: meta.skillId, skillName: meta.skillName, restoredPath: meta.originalPath },
        "skill-curator"
      );

      return meta.originalPath;
    } catch (err) {
      process.stderr.write(`[SkillCurator] Failed to restore skill: ${err instanceof Error ? err.message : String(err)}\n`);
      return null;
    }
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
        // 仅替换 frontmatter 中的 version 字段，避免误替换 body 内容
        const updatedContent = content.replace(
          /^(---[\s\S]*?version:\s*).+/m,
          `$1${skill.version}`
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
    this.persistTimer = setTimeout(() => this.persistToDisk(), 5000);
  }

  /** 将演化记录持久化到磁盘。 */
  private persistToDisk(): void {
    try {
      if (!fs.existsSync(this.storeDir)) {
        fs.mkdirSync(this.storeDir, { recursive: true });
      }
      const filePath = path.join(this.storeDir, "evolutions.json");
      const data = {
        evolutions: Array.from(this.evolutions.values()).slice(-500),
        savedAt: new Date().toISOString(),
      };
      const lock = new LocalFileLock(path.join(this.storeDir, "evolutions.lock"));
      lock.acquire();
      try {
        atomicWriteFileLocal(filePath, JSON.stringify(data, null, 2));
      } finally {
        lock.release();
      }
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
      const data = JSON.parse(raw) as { evolutions: SkillEvolutionEntry[] };
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
            this.evolutions.set(entry.skillId, entry);
          }
        }
      }
    } catch (err) {
      process.stderr.write(`[SkillCurator] Failed to load evolutions from disk: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  private trimEvolutions(): void {
    if (this.evolutions.size <= this.maxEvolutionEntries) return;

    const entries = Array.from(this.evolutions.entries()).sort(
      (a, b) => a[1].lastUpdatedAt.getTime() - b[1].lastUpdatedAt.getTime()
    );

    const toRemove = entries.slice(
      0,
      this.evolutions.size - this.maxEvolutionEntries
    );
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

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
