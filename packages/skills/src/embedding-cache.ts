/**
 * EmbeddingCache — 内容寻址 embedding 缓存
 *
 * 借鉴 OpenSpace skill_engine/skill_ranker.py：
 *   - key 为 base64(skill_id):sha256(text)[:16]（任何文本变更自动失效）
 *   - 主动清理同 skill_id 的旧 key 防膨胀
 *   - 缓存版本 + 模型双重 pinning（换 embedding 模型自动失效）
 *   - 原子缓存写盘（NamedTemporaryFile + os.replace 思路）
 *
 * EvoClaw 落地点：
 *   - skill-index.ts 的 embedding 计算缓存
 *   - tfidf-matcher.ts 的向量缓存
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ── 类型 ──────────────────────────────────────────────────────

export interface CacheEntry {
  /** skill_id 关联 */
  skillId: string;
  /** 原始文本的 sha256（16 字符） */
  textHash: string;
  /** embedding 向量 */
  embedding: number[];
  /** embedding 模型名 */
  model: string;
  /** 缓存版本号 */
  cacheVersion: number;
  /** 创建时间 */
  createdAt: number;
}

export interface EmbeddingCacheOptions {
  /** 缓存目录 */
  cacheDir: string;
  /** embedding 模型名 */
  model: string;
  /** 缓存版本号（schema 变更时递增） */
  cacheVersion?: number;
  /** 同 skill_id 最多保留多少条历史 entry（防膨胀） */
  maxEntriesPerSkill?: number;
}

const DEFAULT_OPTIONS = {
  cacheVersion: 1,
  maxEntriesPerSkill: 5,
};

// ── 工具函数 ──────────────────────────────────────────────────

/**
 * 计算文本的 sha256（取前 16 字符）。
 */
export function textHash(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16);
}

/**
 * 构造内容寻址 key。
 *
 * 格式：`{base64(skill_id)}:{sha256(text)[:16]}`
 * 任何文本变更 → textHash 变化 → 新 key → 自动失效旧 entry
 */
export function buildCacheKey(skillId: string, text: string): string {
  const skillB64 = Buffer.from(skillId, "utf-8").toString("base64").replace(/=/g, "");
  return `${skillB64}:${textHash(text)}`;
}

// ── 主类 ──────────────────────────────────────────────────────

export class EmbeddingCache {
  private options: Required<EmbeddingCacheOptions>;
  private cacheFile: string;
  private cache = new Map<string, CacheEntry>();
  private dirty = false;
  private loaded = false;

  constructor(options: EmbeddingCacheOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.cacheFile = path.join(this.options.cacheDir, "skill_embeddings.json");
  }

  // ── 加载/保存 ────────────────────────────────────────────

  /** 懒加载：首次访问时从磁盘加载 */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    try {
      if (!fs.existsSync(this.cacheFile)) return;
      const content = fs.readFileSync(this.cacheFile, "utf-8");
      const data = JSON.parse(content);

      if (!Array.isArray(data)) {
        process.stderr.write(`[EmbeddingCache] cache file corrupted: expected array\n`);
        return;
      }

      for (const entry of data) {
        // 运行时校验：避免损坏数据导致后续 Buffer.from(undefined) 崩溃
        if (
          !entry ||
          typeof entry.skillId !== "string" ||
          typeof entry.textHash !== "string" ||
          typeof entry.cacheVersion !== "number" ||
          typeof entry.model !== "string"
        ) {
          continue;
        }
        // 缓存版本 + 模型双重 pinning：不匹配则跳过（自动失效）
        if (
          entry.cacheVersion === this.options.cacheVersion &&
          entry.model === this.options.model
        ) {
          const key = `${Buffer.from(entry.skillId, "utf-8").toString("base64").replace(/=/g, "")}:${entry.textHash}`;
          this.cache.set(key, entry);
        }
      }
    } catch (err) {
      // 缓存损坏：记录原因后忽略，重新计算
      process.stderr.write(`[EmbeddingCache] load failed: ${err}\n`);
    }
  }

  /** 原子写盘（借鉴 OpenSpace skill_ranker.py NamedTemporaryFile + os.replace） */
  async save(): Promise<void> {
    if (!this.dirty) return;

    this.ensureLoaded();
    const data = Array.from(this.cache.values());

    // 使用进程 ID + 时间戳避免多进程并发时 tmp 文件互相覆盖
    const tmpPath = `${this.cacheFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      // 确保目录存在
      const dir = path.dirname(this.cacheFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // 写到临时文件 + 原子替换
      const content = JSON.stringify(data);
      const fd = fs.openSync(tmpPath, "w");
      try {
        fs.writeFileSync(fd, content, { encoding: "utf-8" });
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, this.cacheFile);
      this.dirty = false;
    } catch (err) {
      // 清理残留 tmp
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  // ── 查询 ────────────────────────────────────────────────

  /**
   * 查询缓存的 embedding。
   *
   * @returns 命中则返回向量，未命中返回 null
   */
  get(skillId: string, text: string): number[] | null {
    this.ensureLoaded();
    const key = buildCacheKey(skillId, text);
    const entry = this.cache.get(key);
    return entry?.embedding ?? null;
  }

  /**
   * 写入 embedding。
   *
   * 副作用：主动清理同 skill_id 的旧 key 防膨胀（借鉴 OpenSpace _drop_stale_entries_locked）。
   */
  set(skillId: string, text: string, embedding: number[]): void {
    this.ensureLoaded();
    const hash = textHash(text);
    const key = buildCacheKey(skillId, text);

    // 主动清理同 skill_id 的旧 entry（防膨胀）
    this.dropStaleEntriesForSkill(skillId);

    const entry: CacheEntry = {
      skillId,
      textHash: hash,
      embedding,
      model: this.options.model,
      cacheVersion: this.options.cacheVersion,
      createdAt: Date.now(),
    };

    this.cache.set(key, entry);
    this.dirty = true;
  }

  /**
   * 清理同 skill_id 的旧 entry（保留最近 maxEntriesPerSkill 条）。
   */
  private dropStaleEntriesForSkill(skillId: string): void {
    const skillB64 = Buffer.from(skillId, "utf-8").toString("base64").replace(/=/g, "");
    const prefix = `${skillB64}:`;

    const sameSkillEntries: Array<{ key: string; createdAt: number }> = [];
    for (const [key, entry] of this.cache) {
      if (key.startsWith(prefix)) {
        sameSkillEntries.push({ key, createdAt: entry.createdAt });
      }
    }

    if (sameSkillEntries.length < this.options.maxEntriesPerSkill) {
      return;
    }

    // 按 createdAt 升序，删除最旧的
    sameSkillEntries.sort((a, b) => a.createdAt - b.createdAt);
    const toRemove = sameSkillEntries.slice(0, sameSkillEntries.length - this.options.maxEntriesPerSkill + 1);
    for (const { key } of toRemove) {
      this.cache.delete(key);
      this.dirty = true;
    }
  }

  // ── 维护 ────────────────────────────────────────────────

  /** 清空全部缓存 */
  clear(): void {
    this.cache.clear();
    this.dirty = true;
  }

  /** 删除某 skill 的所有 entry */
  removeSkill(skillId: string): void {
    this.ensureLoaded();
    const skillB64 = Buffer.from(skillId, "utf-8").toString("base64").replace(/=/g, "");
    const prefix = `${skillB64}:`;

    let removed = 0;
    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        removed++;
      }
    }

    if (removed > 0) this.dirty = true;
  }

  /** 获取统计 */
  getStats(): {
    totalEntries: number;
    uniqueSkills: number;
    cacheVersion: number;
    model: string;
  } {
    this.ensureLoaded();
    const skills = new Set<string>();
    for (const entry of this.cache.values()) {
      skills.add(entry.skillId);
    }
    return {
      totalEntries: this.cache.size,
      uniqueSkills: skills.size,
      cacheVersion: this.options.cacheVersion,
      model: this.options.model,
    };
  }
}
