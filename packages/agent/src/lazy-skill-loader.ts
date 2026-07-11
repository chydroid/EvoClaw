// ── Lazy Skill Loader ──
// OpenClaw 6.6 引入: 懒加载slash command, 减少首屏加载时间
// 启动时只注册metadata, 实际使用时才加载完整实现

import type { CommandResult, CommandContext } from "./chat-commands";

/** 懒加载的skill定义 */
export interface LazySkill {
  name: string;
  description: string;
  category: "navigation" | "session" | "agent" | "config" | "utility" | "experimental";
  /** 加载器 - 返回完整的LazySkillHandler */
  loader: () => Promise<LazySkillHandler> | LazySkillHandler;
  /** 优先级 - 高优先级在idle时预加载 */
  priority?: "high" | "medium" | "low";
  /** 预加载条件 */
  preloadCondition?: () => boolean;
}

/** 懒加载的skill handler - 与chat-commands兼容 */
export interface LazySkillHandler {
  name: string;
  description: string;
  execute: (args: string, context: CommandContext) => Promise<CommandResult> | CommandResult;
}

/** 加载状态 */
export type LoadStatus = "unloaded" | "loading" | "loaded" | "error";

export interface LazySkillEntry {
  skill: LazySkill;
  status: LoadStatus;
  loadedAt?: number;
  error?: string;
  loadCount: number;
}

export interface LazyLoaderConfig {
  /** idle时预加载的最大数量 */
  maxPreload?: number;
  /** 预加载触发时间(ms) */
  preloadDelayMs?: number;
  /** 缓存LRU上限 */
  maxCached?: number;
}

/**
 * LazySkillLoader
 * 注册: 只保存元数据, 不执行loader
 * 首次访问: 触发loader, 加载并缓存
 * 再次访问: 直接返回缓存
 * LRU淘汰: 超过maxCached时清理最少使用的
 */
export class LazySkillLoader {
  private entries = new Map<string, LazySkillEntry>();
  private config: Required<LazyLoaderConfig>;
  private preloadScheduled = false;
  private stats = {
    registrations: 0,
    loads: 0,
    cacheHits: 0,
    evictions: 0,
    preloadCount: 0,
    errors: 0,
  };

  constructor(config: Partial<LazyLoaderConfig> = {}) {
    this.config = {
      maxPreload: config.maxPreload ?? 5,
      preloadDelayMs: config.preloadDelayMs ?? 2000,
      maxCached: config.maxCached ?? 50,
    };
  }

  /** 注册一个懒加载skill */
  register(skill: LazySkill): void {
    this.entries.set(skill.name, {
      skill,
      status: "unloaded",
      loadCount: 0,
    });
    this.stats.registrations++;
  }

  /** 批量注册 */
  registerBatch(skills: LazySkill[]): void {
    for (const s of skills) this.register(s);
  }

  /** 获取skill (触发懒加载) */
  async get(name: string): Promise<LazySkillHandler | undefined> {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    if (entry.status === "loaded") {
      entry.loadCount++;
      this.stats.cacheHits++;
      return (entry.skill as any)._loadedCommand;
    }
    if (entry.status === "loading") {
      // 等待其他加载完成
      return this.waitForLoad(name);
    }
    return this.loadEntry(name, entry);
  }

  /** 同步获取 - 仅在已加载时返回 */
  getSync(name: string): LazySkillHandler | undefined {
    const entry = this.entries.get(name);
    if (!entry || entry.status !== "loaded") return undefined;
    entry.loadCount++;
    this.stats.cacheHits++;
    return (entry.skill as any)._loadedCommand;
  }

  /** 检查是否已加载 */
  isLoaded(name: string): boolean {
    return this.entries.get(name)?.status === "loaded";
  }

  /** 获取所有skill元数据(用于UI展示) */
  listMetadata(): Array<{
    name: string;
    description: string;
    category: string;
    status: LoadStatus;
    loadCount: number;
  }> {
    return Array.from(this.entries.values()).map((e) => ({
      name: e.skill.name,
      description: e.skill.description,
      category: e.skill.category,
      status: e.status,
      loadCount: e.loadCount,
    }));
  }

  /** idle时预加载高优先级skills */
  schedulePreload(): void {
    if (this.preloadScheduled) return;
    this.preloadScheduled = true;
    const schedule = (): void => {
      const highPriority = Array.from(this.entries.values())
        .filter((e) => e.status === "unloaded" && (e.skill.priority === "high" || !e.skill.priority))
        .filter((e) => !e.skill.preloadCondition || e.skill.preloadCondition())
        .slice(0, this.config.maxPreload);
      for (const entry of highPriority) {
        // 仅在 loadEntry 成功后才递增 preloadCount，失败不应计入
        this.loadEntry(entry.skill.name, entry)
          .then((loaded) => {
            if (loaded !== undefined) this.stats.preloadCount++;
          })
          .catch(() => { /* 静默失败 */ });
      }
    };
    if (typeof setTimeout !== "undefined") {
      const h = setTimeout(schedule, this.config.preloadDelayMs);
      h.unref?.();
    }
  }

  /** 强制预加载指定skill */
  async preload(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (!entry || entry.status === "loaded") return entry?.status === "loaded";
    // 如果已在加载中，等待加载完成而非重复加载（防止 double-load 竞态）
    if (entry.status === "loading") {
      await this.waitForLoad(name);
      // 重新从 Map 读取以绕过 TS 控制流分析对 entry.status 的窄化（waitForLoad 可能已变更状态）
      const fresh = this.entries.get(name);
      return fresh?.status === "loaded";
    }
    try {
      await this.loadEntry(name, entry);
      return true;
    } catch {
      return false;
    }
  }

  /** 卸载一个skill */
  unload(name: string): void {
    const entry = this.entries.get(name);
    if (entry && entry.status === "loaded") {
      (entry.skill as any)._loadedCommand = undefined;
      entry.status = "unloaded";
      entry.loadedAt = undefined;
    }
  }

  /** 清理最少使用的缓存 */
  evictLRU(): void {
    if (this.entries.size <= this.config.maxCached) return;
    const loaded = Array.from(this.entries.values())
      .filter((e) => e.status === "loaded")
      .sort((a, b) => {
        // 优先淘汰loadCount低且loadedAt早的
        if (a.loadCount !== b.loadCount) return a.loadCount - b.loadCount;
        return (a.loadedAt ?? 0) - (b.loadedAt ?? 0);
      });
    while (loaded.length > this.config.maxCached) {
      const victim = loaded.shift();
      if (victim) {
        this.unload(victim.skill.name);
        this.stats.evictions++;
      }
    }
  }

  private async loadEntry(name: string, entry: LazySkillEntry): Promise<LazySkillHandler | undefined> {
    entry.status = "loading";
    try {
      const result = entry.skill.loader();
      const command = result instanceof Promise ? await result : result;
      (entry.skill as any)._loadedCommand = command;
      entry.status = "loaded";
      entry.loadedAt = Date.now();
      entry.loadCount++;
      this.stats.loads++;
      this.evictLRU();
      return command;
    } catch (err) {
      entry.status = "error";
      entry.error = err instanceof Error ? err.message : String(err);
      this.stats.errors++;
      return undefined;
    }
  }

  private waitForLoad(name: string, timeoutMs = 5000): Promise<LazySkillHandler | undefined> {
    return new Promise((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        const entry = this.entries.get(name);
        if (!entry || entry.status === "loaded" || entry.status === "error") {
          clearInterval(interval);
          resolve(entry?.status === "loaded" ? (entry.skill as any)._loadedCommand : undefined);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          resolve(undefined);
        }
      }, 50);
      // 避免定时器阻止进程退出
      interval.unref?.();
    });
  }

  getStats() {
    return {
      ...this.stats,
      totalEntries: this.entries.size,
      loadedCount: Array.from(this.entries.values()).filter((e) => e.status === "loaded").length,
      hitRate: this.stats.cacheHits + this.stats.loads > 0
        ? this.stats.cacheHits / (this.stats.cacheHits + this.stats.loads)
        : 0,
    };
  }
}
