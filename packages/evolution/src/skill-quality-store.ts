/**
 * SkillQualityStore — 技能质量四计数器持久化
 *
 * 借鉴 OpenSpace skill_engine/store.py `record_analysis()` 的原子计数语义：
 *   total_selections += 1               （每次被注入/选中）
 *   total_applied    += 1               （分析判定技能确实被使用）
 *   total_completions += 1              （applied 且任务完成）
 *   total_fallbacks  += 1               （未 applied 且任务未完成）
 *
 * EvoClaw 现状（接线前）：计数器类型 SkillMetricsRecord 已存在，但无持久化；
 * 技能选择/任务成功没有关联，metric-monitor 只能读易失的内存 stats。
 * 本类把「技能 × 任务结果」的观测落到 data/skill-curator/quality.json，
 * 供质量过滤、metric-monitor 与演化后效果追踪使用。
 *
 * 约束：
 *   - 原子写（atomicWriteFileSync），进程内串行化写入
 *   - 永不删除技能条目；低质量只影响选择排序/过滤
 *   - 读取失败视为空状态，不阻塞主流程
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "@evoclaw/core";
import {
  SkillMetricsRecord,
  type ExecutionAnalysis,
  type SkillJudgment,
} from "@evoclaw/skills";
import type { SkillMetrics } from "./evolution-triggers";

// ── 类型 ──────────────────────────────────────────────────────

/** 最近一次技能判定（滚动窗口，避免文件无界增长）。 */
export interface SkillJudgmentRecord {
  taskId: string;
  /** 是否被实际使用 */
  applied: boolean;
  /** 本任务是否完成（仅在 applied 时有意义） */
  completed: boolean;
  note: string;
  at: number;
}

/** 持久化的技能质量条目。 */
export interface SkillQualityEntry {
  /** 规范化键：优先 .skill_id，缺失时用技能名 */
  key: string;
  skillId: string;
  name: string;
  totalSelections: number;
  totalApplied: number;
  totalCompleted: number;
  totalFallbacks: number;
  totalFailures: number;
  lastUpdated: number;
  lastEvolvedAt?: number;
  recentJudgments: SkillJudgmentRecord[];
}

export interface SkillQualityStoreOptions {
  /** 数据根目录（默认 <cwd>/data） */
  dataDir?: string;
  /** 时钟注入（测试） */
  now?: () => number;
}

export interface SkillQualityStoreStats {
  skills: number;
  totalSelections: number;
  totalApplied: number;
  totalCompleted: number;
  totalFallbacks: number;
  /** 质量可用（applied ≥ 3）的技能数 */
  measuredSkills: number;
  lowQualitySkills: number;
  path: string;
}

const MAX_RECENT_JUDGMENTS = 50;
const FILE_VERSION = 1;

// ── 主类 ──────────────────────────────────────────────────────

export class SkillQualityStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private entries = new Map<string, SkillQualityEntry>();
  private nameIndex = new Map<string, string>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: SkillQualityStoreOptions = {}) {
    const dataDir = options.dataDir ?? path.join(process.cwd(), "data");
    this.filePath = path.join(dataDir, "skill-curator", "quality.json");
    this.now = options.now ?? (() => Date.now());
  }

  // ── 读取 ────────────────────────────────────────────────

  /** 记录一次执行分析：原子累加四计数器 + 最近判定。 */
  recordAnalysis(analysis: ExecutionAnalysis): void {
    this.ensureLoaded();
    const judgments: SkillJudgment[] = Array.isArray(analysis.skillJudgments)
      ? analysis.skillJudgments
      : [];
    if (judgments.length === 0) return;

    const taskCompleted = analysis.taskCompleted === true;
    const at = this.now();

    for (const judgment of judgments) {
      const name = String(judgment.skillName || judgment.skillId || "").trim();
      if (!name) continue;
      const skillId = String(judgment.skillId || "").trim();
      // OpenSpace 语义：skill_id 缺失时以 name 作稳定键；有 id 时 id 优先
      const key = skillId || name;
      const entry = this.getOrCreate(key, name, skillId || key);
      if (judgment.skillId) this.nameIndex.set(name, key);

      entry.totalSelections += 1;
      if (judgment.skillApplied) {
        entry.totalApplied += 1;
        if (taskCompleted) entry.totalCompleted += 1;
        else entry.totalFailures += 1;
      } else if (!taskCompleted) {
        entry.totalFallbacks += 1;
      }
      entry.lastUpdated = at;
      entry.recentJudgments.push({
        taskId: analysis.taskId,
        applied: judgment.skillApplied === true,
        completed: judgment.skillApplied === true && taskCompleted,
        note: String(judgment.note || "").slice(0, 500),
        at,
      });
      if (entry.recentJudgments.length > MAX_RECENT_JUDGMENTS) {
        entry.recentJudgments.splice(0, entry.recentJudgments.length - MAX_RECENT_JUDGMENTS);
      }
    }

    void this.persist();
  }

  /** 兼容旧调用：仅记录被选中（无任务结果归因）。 */
  recordSelections(skillNames: string[], taskId: string): void {
    this.ensureLoaded();
    if (skillNames.length === 0) return;
    const at = this.now();
    for (const raw of skillNames) {
      const name = String(raw || "").trim();
      if (!name) continue;
      const key = this.nameIndex.get(name) ?? name;
      const entry = this.getOrCreate(key, name, key);
      entry.totalSelections += 1;
      entry.lastUpdated = at;
      entry.recentJudgments.push({ taskId, applied: false, completed: false, note: "selected", at });
      if (entry.recentJudgments.length > MAX_RECENT_JUDGMENTS) {
        entry.recentJudgments.splice(0, entry.recentJudgments.length - MAX_RECENT_JUDGMENTS);
      }
    }
    void this.persist();
  }

  /** 按 skill_id 或技能名查询。 */
  get(skillIdOrName: string): SkillQualityEntry | null {
    this.ensureLoaded();
    const key = this.resolveKey(skillIdOrName);
    return key ? this.entries.get(key) ?? null : null;
  }

  /** 全部条目（防御性拷贝）。 */
  getAll(): SkillQualityEntry[] {
    this.ensureLoaded();
    return Array.from(this.entries.values()).map((e) => ({
      ...e,
      recentJudgments: [...e.recentJudgments],
    }));
  }

  /** 完成率 = completed / applied；无样本返回 1（不惩罚新技能）。 */
  completionRate(skillIdOrName: string): number {
    const entry = this.get(skillIdOrName);
    if (!entry || entry.totalApplied === 0) return 1;
    return entry.totalCompleted / entry.totalApplied;
  }

  /** 有效率 = completed / selections；无样本返回 0。 */
  effectiveRate(skillIdOrName: string): number {
    const entry = this.get(skillIdOrName);
    if (!entry || entry.totalSelections === 0) return 0;
    return entry.totalCompleted / entry.totalSelections;
  }

  /** 回退率 = fallbacks / applied；无 applied 返回 0。 */
  fallbackRate(skillIdOrName: string): number {
    const entry = this.get(skillIdOrName);
    if (!entry || entry.totalApplied === 0) return 0;
    return entry.totalFallbacks / entry.totalApplied;
  }

  /**
   * 低质量判定（对齐 OpenSpace registry.py 质量过滤）：
   *   - 选中 ≥2 且 0 次完成（应用率/完成率为 0）
   *   - 应用 ≥2 且回退率 > 0.5
   * 无样本或样本不足 → 不判定低质（避免冷启动误杀）。
   */
  isLowQuality(skillIdOrName: string): boolean {
    const entry = this.get(skillIdOrName);
    if (!entry) return false;
    if (entry.totalSelections >= 2 && entry.totalCompleted === 0) return true;
    if (entry.totalApplied >= 2 && entry.totalFallbacks / entry.totalApplied > 0.5) return true;
    return false;
  }

  /** 供 metric-monitor 使用的指标快照。 */
  toTriggerMetrics(): SkillMetrics[] {
    this.ensureLoaded();
    return Array.from(this.entries.values()).map((entry) => ({
      skillId: entry.skillId || entry.name,
      skillName: entry.name,
      selections: entry.totalSelections,
      applied: entry.totalApplied,
      completions: entry.totalCompleted,
      fallbacks: entry.totalFallbacks,
    }));
  }

  /** 记录一次成功演化（用于效果追踪/UI）。 */
  markEvolved(skillIdOrName: string): void {
    this.ensureLoaded();
    const key = this.resolveKey(skillIdOrName);
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.lastEvolvedAt = this.now();
    void this.persist();
  }

  getStats(): SkillQualityStoreStats {
    this.ensureLoaded();
    const all = Array.from(this.entries.values());
    let measured = 0;
    let low = 0;
    for (const entry of all) {
      if (entry.totalApplied >= 3) measured++;
      if (this.isLowQuality(entry.key)) low++;
    }
    return {
      skills: all.length,
      totalSelections: all.reduce((s, e) => s + e.totalSelections, 0),
      totalApplied: all.reduce((s, e) => s + e.totalApplied, 0),
      totalCompleted: all.reduce((s, e) => s + e.totalCompleted, 0),
      totalFallbacks: all.reduce((s, e) => s + e.totalFallbacks, 0),
      measuredSkills: measured,
      lowQualitySkills: low,
      path: this.filePath,
    };
  }

  /** 等待待写队列落盘（测试/关闭时使用）。 */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  // ── 内部 ────────────────────────────────────────────────

  private getOrCreate(key: string, name: string, skillId: string): SkillQualityEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        skillId,
        name,
        totalSelections: 0,
        totalApplied: 0,
        totalCompleted: 0,
        totalFallbacks: 0,
        totalFailures: 0,
        lastUpdated: 0,
        recentJudgments: [],
      };
      this.entries.set(key, entry);
    } else if (name && entry.name !== name) {
      // 技能改名：保留计数，更新展示名
      entry.name = name;
    }
    return entry;
  }

  private resolveKey(skillIdOrName: string): string | null {
    const value = String(skillIdOrName || "").trim();
    if (!value) return null;
    if (this.entries.has(value)) return value;
    const byName = this.nameIndex.get(value);
    if (byName) return byName;
    // 侧表未命中时线性匹配（技能数量有限，且仅管理面调用）
    for (const entry of this.entries.values()) {
      if (entry.name === value || entry.skillId === value) return entry.key;
    }
    return null;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as { version?: number; skills?: SkillQualityEntry[] };
      if (!Array.isArray(data?.skills)) return;
      for (const item of data.skills) {
        if (!item || typeof item.key !== "string") continue;
        const metrics = SkillMetricsRecord.fromJSON(item as unknown as Record<string, unknown>);
        const entry: SkillQualityEntry = {
          key: item.key,
          skillId: typeof item.skillId === "string" ? item.skillId : item.key,
          name: typeof item.name === "string" ? item.name : item.key,
          totalSelections: metrics.totalSelections,
          totalApplied: metrics.totalApplied,
          totalCompleted: metrics.totalCompleted,
          totalFallbacks: metrics.totalFallbacks,
          totalFailures: metrics.totalFailures,
          lastUpdated: metrics.lastUpdated,
          lastEvolvedAt: typeof item.lastEvolvedAt === "number" ? item.lastEvolvedAt : undefined,
          recentJudgments: Array.isArray(item.recentJudgments)
            ? item.recentJudgments
                .filter((j) => j && typeof j.taskId === "string")
                .slice(-MAX_RECENT_JUDGMENTS)
                .map((j) => ({
                  taskId: String(j.taskId),
                  applied: j.applied === true,
                  completed: j.completed === true,
                  note: typeof j.note === "string" ? j.note : "",
                  at: Number(j.at) || 0,
                }))
            : [],
        };
        this.entries.set(entry.key, entry);
        if (entry.name) this.nameIndex.set(entry.name, entry.key);
      }
    } catch {
      // 文件不存在/损坏：空状态启动（不阻塞）
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(
      {
        version: FILE_VERSION,
        savedAt: new Date().toISOString(),
        skills: Array.from(this.entries.values()).map((entry) => {
          const metrics = new SkillMetricsRecord();
          metrics.totalSelections = entry.totalSelections;
          metrics.totalApplied = entry.totalApplied;
          metrics.totalCompleted = entry.totalCompleted;
          metrics.totalFallbacks = entry.totalFallbacks;
          metrics.totalFailures = entry.totalFailures;
          metrics.lastUpdated = entry.lastUpdated;
          return { ...entry, ...metrics.toJSON() };
        }),
      },
      null,
      2,
    );

    this.writeChain = this.writeChain
      .then(() => {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        atomicWriteFileSync(this.filePath, snapshot);
      })
      .catch((err: unknown) => {
        process.stderr.write(
          `[SkillQualityStore] persist failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
    return this.writeChain;
  }
}
