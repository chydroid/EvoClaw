import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { atomicWriteFileSync } from "@evoclaw/core";

export interface SkillIndexEntry {
  id: string;
  name: string;
  level0: string;
  level1: string;
  level2: string;
  category: string;
  keywords: string[];
  lastUsedAt: number | null;
  useCount: number;
  successRate: number;
  lastValidatedAt: number | null;
  apiVersion: string | null;
}

export interface SkillSearchResult {
  entry: SkillIndexEntry;
  relevanceScore: number;
  matchedLevel: 0 | 1 | 2;
}

/** 持久化文件格式版本，用于兼容性检查 */
const SKILL_INDEX_FILE_VERSION = 1;
/** 持久化文件最大尺寸（4MB），超出则视为损坏并丢弃 */
const SKILL_INDEX_MAX_FILE_SIZE = 4 * 1024 * 1024;

interface SkillIndexFileData {
  version: number;
  savedAt: number;
  entries: SkillIndexEntry[];
}

export class SkillIndex {
  private entries = new Map<string, SkillIndexEntry>();
  private dirty = false;
  /** 当前已加载的持久化文件路径（用于自动 flushIfNeeded） */
  private currentFilePath: string | null = null;
  /** 自动持久化的最小间隔（ms），避免高频写入 */
  private static readonly AUTO_FLUSH_MIN_INTERVAL_MS = 5000;
  private lastFlushAt = 0;

  indexSkill(skill: {
    id: string;
    name: string;
    description: string;
    body: { instructions: string };
    category: string;
    keywords: string[];
    stats: { invocationCount: number; successCount: number; failureCount: number; lastInvocation: Date | null };
  }): void {
    const desc = skill.description || "";
    const instr = skill.body?.instructions || "";

    const level0 = `${skill.name}: ${Array.from(desc).slice(0, 80).join("")}`.trim();
    const level1 = `${desc}\n\n${instr.slice(0, 500)}`.trim();
    const level2 = instr;

    const totalInvocations = skill.stats.invocationCount;
    const successRate = totalInvocations > 0
      ? skill.stats.successCount / totalInvocations
      : 0;

    const existing = this.entries.get(skill.id);
    const entry: SkillIndexEntry = {
      id: skill.id,
      name: skill.name,
      level0,
      level1,
      level2,
      category: skill.category,
      keywords: skill.keywords || [],
      lastUsedAt: skill.stats.lastInvocation ? skill.stats.lastInvocation.getTime() : (existing?.lastUsedAt ?? null),
      useCount: totalInvocations,
      successRate,
      lastValidatedAt: existing?.lastValidatedAt ?? null,
      apiVersion: existing?.apiVersion ?? null,
    };

    this.entries.set(skill.id, entry);
    this.dirty = true;
  }

  getLevel0Index(): string {
    const lines: string[] = [];
    for (const entry of this.entries.values()) {
      lines.push(`• ${entry.name}: ${entry.level0.replace(new RegExp(`^${escapeRegExp(entry.name)}:\\s*`), "")}`);
    }
    return lines.join("\n");
  }

  getSkillLevel(skillId: string, level: 0 | 1 | 2): string | null {
    const entry = this.entries.get(skillId);
    if (!entry) return null;

    if (level === 0) return entry.level0;
    if (level === 1) return entry.level1;
    return entry.level2;
  }

  search(query: string, limit = 10): SkillSearchResult[] {
    const terms = query
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff\s-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);

    if (terms.length === 0) return [];

    const results: SkillSearchResult[] = [];

    for (const entry of this.entries.values()) {
      let score = 0;
      let matchedLevel: 0 | 1 | 2 = 0;

      const nameLower = entry.name.toLowerCase();
      const kwLower = entry.keywords.map((k) => k.toLowerCase());
      const descLower = entry.level0.toLowerCase();
      const instrLower = entry.level1.toLowerCase();

      for (const term of terms) {
        if (nameLower.includes(term)) {
          score += 10;
          matchedLevel = Math.max(matchedLevel, 0) as 0 | 1 | 2;
        }

        for (const kw of kwLower) {
          if (kw === term) {
            score += 8;
            matchedLevel = Math.max(matchedLevel, 0) as 0 | 1 | 2;
          } else if (kw.includes(term)) {
            score += 4;
            matchedLevel = Math.max(matchedLevel, 0) as 0 | 1 | 2;
          }
        }

        if (descLower.includes(term)) {
          const count = countOccurrences(descLower, term);
          score += 3 * count;
          matchedLevel = Math.max(matchedLevel, 1) as 0 | 1 | 2;
        }

        if (instrLower.includes(term)) {
          const count = countOccurrences(instrLower, term);
          score += 1 * count;
          matchedLevel = Math.max(matchedLevel, 2) as 0 | 1 | 2;
        }
      }

      if (score > 0) {
        // useCount 使用对数缩放，防止高使用次数的旧技能主导排序
        score += Math.log(1 + entry.useCount) * 0.5;
        score += entry.successRate * 2;

        results.push({ entry, relevanceScore: score, matchedLevel });
      }
    }

    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return results.slice(0, limit);
  }

  updateStats(skillId: string, success: boolean): void {
    const entry = this.entries.get(skillId);
    if (!entry) return;

    entry.useCount++;
    entry.lastUsedAt = Date.now();

    const totalSuccesses = Math.round(entry.successRate * (entry.useCount - 1)) + (success ? 1 : 0);
    entry.successRate = totalSuccesses / entry.useCount;

    this.dirty = true;
  }

  markValidated(skillId: string, apiVersion?: string): void {
    const entry = this.entries.get(skillId);
    if (!entry) return;

    entry.lastValidatedAt = Date.now();
    if (apiVersion) {
      entry.apiVersion = apiVersion;
    }
    this.dirty = true;
  }

  getStaleSkills(maxAgeDays: number): SkillIndexEntry[] {
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

    const result: SkillIndexEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.lastValidatedAt === null) {
        result.push(entry);
      } else if (now - entry.lastValidatedAt > maxAgeMs) {
        result.push(entry);
      }
    }
    return result;
  }

  removeSkill(skillId: string): boolean {
    const deleted = this.entries.delete(skillId);
    if (deleted) {
      this.dirty = true;
    }
    return deleted;
  }

  getAll(): SkillIndexEntry[] {
    return Array.from(this.entries.values());
  }

  getSize(): number {
    return this.entries.size;
  }

  // ──────────────────────────────────────────────────────────
  //  持久化：将索引写入磁盘，重启后可加载以加速冷启动
  //  规则遵循项目 atomicWriteFile 约定：temp + fsync + rename
  // ──────────────────────────────────────────────────────────

  /**
   * 将索引持久化到指定文件。
   * 使用 temp + fsync + rename 原子写入，崩溃时不截断。
   * 持久化成功后清除 dirty 标志。
   */
  async persistTo(filePath: string): Promise<void> {
    const data: SkillIndexFileData = {
      version: SKILL_INDEX_FILE_VERSION,
      savedAt: Date.now(),
      entries: Array.from(this.entries.values()),
    };
    const json = JSON.stringify(data);
    atomicWriteFileSync(filePath, json, { encoding: "utf-8" });
    this.dirty = false;
    this.lastFlushAt = Date.now();
    this.currentFilePath = filePath;
  }

  /**
   * 从指定文件加载索引。
   * 文件不存在、损坏或版本不兼容时静默丢弃，返回 false。
   * 加载成功后清除 dirty 标志（避免立刻又触发写入）。
   */
  async loadFrom(filePath: string): Promise<boolean> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      // 文件不存在视为正常情况
      return false;
    }
    if (!stat.isFile() || stat.size === 0 || stat.size > SKILL_INDEX_MAX_FILE_SIZE) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      return false;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch {
      return false;
    }
    let parsed: SkillIndexFileData;
    try {
      parsed = JSON.parse(raw) as SkillIndexFileData;
    } catch {
      // JSON 损坏：删除文件以避免下次再读
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      return false;
    }
    if (!parsed || typeof parsed !== "object") return false;
    if (parsed.version !== SKILL_INDEX_FILE_VERSION) {
      // 版本不兼容：丢弃旧索引，由 indexSkill 重新构建
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      return false;
    }
    if (!Array.isArray(parsed.entries)) return false;
    this.entries.clear();
    let loaded = 0;
    for (const e of parsed.entries) {
      if (!e || typeof e.id !== "string") continue;
      // 浅校验关键字段，避免运行时崩溃
      const entry: SkillIndexEntry = {
        id: e.id,
        name: String(e.name ?? ""),
        level0: String(e.level0 ?? ""),
        level1: String(e.level1 ?? ""),
        level2: String(e.level2 ?? ""),
        category: String(e.category ?? "custom"),
        keywords: Array.isArray(e.keywords) ? e.keywords.map(String) : [],
        lastUsedAt: typeof e.lastUsedAt === "number" ? e.lastUsedAt : null,
        useCount: Number.isFinite(e.useCount) ? Number(e.useCount) : 0,
        successRate: Number.isFinite(e.successRate) ? Number(e.successRate) : 0,
        lastValidatedAt: typeof e.lastValidatedAt === "number" ? e.lastValidatedAt : null,
        apiVersion: typeof e.apiVersion === "string" ? e.apiVersion : null,
      };
      this.entries.set(entry.id, entry);
      loaded++;
    }
    this.dirty = false;
    this.currentFilePath = filePath;
    this.lastFlushAt = Date.now();
    if (loaded > 0) {
      process.stdout.write(
        `[SkillIndex] Loaded ${loaded} entries from ${path.basename(filePath)} (savedAt=${new Date(parsed.savedAt).toISOString()})\n`
      );
    }
    return loaded > 0;
  }

  /**
   * 当 dirty 且距离上次写入超过 AUTO_FLUSH_MIN_INTERVAL_MS 时，自动持久化。
   * 适用于在 SkillManager 的操作钩子中调用，避免每次小变更都触发磁盘 IO。
   */
  async flushIfNeeded(force = false): Promise<void> {
    if (!this.dirty) return;
    if (!this.currentFilePath) return;
    if (!force && Date.now() - this.lastFlushAt < SkillIndex.AUTO_FLUSH_MIN_INTERVAL_MS) {
      return;
    }
    try {
      await this.persistTo(this.currentFilePath);
    } catch (err) {
      process.stderr.write(
        `[SkillIndex] Auto-flush failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  isDirty(): boolean {
    return this.dirty;
  }
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(term, pos)) !== -1) {
    count++;
    pos += term.length;
  }
  return count;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
