/**
 * cron-suggestions — 建议式定时任务系统（对标 hermes-agent cron/suggestions.py + suggestion_catalog.py）
 *
 * 核心理念：consent-first（同意优先）—— 系统建议自动化任务，但绝不自动创建。
 * 用户必须主动接受（accept）后才会真正注册为 cron job。
 *
 * 四大来源（VALID_SOURCES）：
 *   1. catalog   — 内置精选模板（每日简报、邮件监控、每周回顾、站会提醒）
 *   2. blueprint — 技能/插件携带的参数化自动化模板
 *   3. usage     — 后台自改进审查（预留，尚未接入生产）
 *   4. integration — 已连接账户的集成建议（预留）
 *
 * 关键工程细节（对标 hermes）：
 *   - MAX_PENDING = 5：避免建议墙（nag wall）
 *   - dedup_key：同一建议不会重复出现（dismissed/accepted/pending 均不重复）
 *   - 原子写入（tmp + rename）
 *   - accept 时调用 ScheduleManager.createTask，不引入第二套 job engine
 */

import * as fs from "fs";
import * as path from "path";
import type { ScheduleManager } from "./schedule-manager";
import type { EventBus } from "@evoclaw/core";

// ── 类型 ──────────────────────────────────────────────

export type SuggestionSource = "catalog" | "blueprint" | "usage" | "integration";
export type SuggestionStatus = "pending" | "accepted" | "dismissed";

export interface CronSuggestion {
  id: string;
  title: string;
  description: string;
  source: SuggestionSource;
  status: SuggestionStatus;
  /** 去重键——同一 key 的建议不会重复出现 */
  dedupKey: string;
  /** 接受后创建的任务配置 */
  jobSpec: {
    name: string;
    cronExpression: string;
    description?: string;
    handlerType: "email_check" | "report_generate" | "browser_action" | "system_cleanup" | "custom" | "shell";
    handlerConfig?: Record<string, unknown>;
  };
  createdAt: string;
  resolvedAt?: string;
}

export interface CronSuggestionConfig {
  /** 建议存储目录 */
  dataDir?: string;
  /** 最大 pending 数量（默认 5，对标 hermes MAX_PENDING） */
  maxPending?: number;
}

// ── 常量 ──────────────────────────────────────────────

const VALID_SOURCES: SuggestionSource[] = ["catalog", "blueprint", "usage", "integration"];
const DEFAULT_MAX_PENDING = 5;
const SUGGESTIONS_FILE = "suggestions.json";

// ── 内置建议目录（对标 hermes suggestion_catalog.py 的 4 个 starter） ──

interface CatalogEntry {
  key: string;
  title: string;
  description: string;
  jobSpec: CronSuggestion["jobSpec"];
}

const BUILTIN_CATALOG: CatalogEntry[] = [
  {
    key: "catalog:daily-briefing",
    title: "每日简报",
    description: "每天早上自动汇总昨日重要动态，生成简报发送给你",
    jobSpec: {
      name: "每日简报",
      cronExpression: "0 9 * * *",
      description: "每日早上 9 点生成昨日动态简报",
      handlerType: "custom",
      handlerConfig: {
        prompt: "汇总昨日的重要动态、新闻和待办事项，生成简洁的简报。",
      },
    },
  },
  {
    key: "catalog:important-mail-monitor",
    title: "重要邮件监控",
    description: "定期检查邮箱中的紧急邮件，及时提醒",
    jobSpec: {
      name: "重要邮件监控",
      cronExpression: "*/30 * * * *",
      description: "每 30 分钟检查一次重要邮件",
      handlerType: "custom",
      handlerConfig: {
        prompt: "检查邮箱中是否有紧急或重要邮件，如有则提醒用户。",
      },
    },
  },
  {
    key: "catalog:weekly-review",
    title: "每周回顾",
    description: "每周日自动回顾本周完成的工作，生成周报",
    jobSpec: {
      name: "每周回顾",
      cronExpression: "0 18 * * 0",
      description: "每周日晚上 6 点生成本周工作回顾",
      handlerType: "custom",
      handlerConfig: {
        prompt: "回顾本周完成的工作、未完成的任务和重要决策，生成周报。",
      },
    },
  },
  {
    key: "catalog:standup-reminder",
    title: "站会提醒",
    description: "每日早上提醒你准备站会内容",
    jobSpec: {
      name: "站会提醒",
      cronExpression: "0 8 * * 1-5",
      description: "工作日早上 8 点提醒准备站会",
      handlerType: "custom",
      handlerConfig: {
        prompt: "提醒用户准备今日站会内容：昨日完成、今日计划、阻塞项。",
      },
    },
  },
];

// ── CronSuggestionManager ─────────────────────────────

export class CronSuggestionManager {
  private suggestions = new Map<string, CronSuggestion>();
  private dataDir: string;
  private maxPending: number;
  private scheduleManager?: ScheduleManager;
  private eventBus?: EventBus;

  constructor(config: CronSuggestionConfig = {}) {
    this.dataDir = config.dataDir || path.join(process.cwd(), "data", "scheduler");
    this.maxPending = config.maxPending ?? DEFAULT_MAX_PENDING;
  }

  /** 绑定 ScheduleManager（接受建议时用其创建任务） */
  bindScheduleManager(sm: ScheduleManager, eventBus: EventBus): void {
    this.scheduleManager = sm;
    this.eventBus = eventBus;
  }

  /** 从磁盘加载已有建议 */
  load(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    const filePath = path.join(this.dataDir, SUGGESTIONS_FILE);
    if (!fs.existsSync(filePath)) return;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const data = JSON.parse(raw) as CronSuggestion[];
      for (const s of data) {
        this.suggestions.set(s.id, s);
      }
    } catch {
      // 文件损坏——忽略，使用空建议集
    }
  }

  /** 原子写入建议到磁盘 */
  private save(): void {
    const filePath = path.join(this.dataDir, SUGGESTIONS_FILE);
    const tmpPath = path.join(this.dataDir, `.${SUGGESTIONS_FILE}.tmp`);
    const data = Array.from(this.suggestions.values());
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  }

  /** 检查 dedupKey 是否已存在（任何状态都不重复） */
  private isDuplicate(dedupKey: string): boolean {
    for (const s of this.suggestions.values()) {
      if (s.dedupKey === dedupKey) return true;
    }
    return false;
  }

  /** 获取当前 pending 数量 */
  getPendingCount(): number {
    let count = 0;
    for (const s of this.suggestions.values()) {
      if (s.status === "pending") count++;
    }
    return count;
  }

  /**
   * 添加建议。
   * 如果 dedupKey 已存在或 pending 已达上限，则跳过。
   */
  addSuggestion(input: {
    title: string;
    description: string;
    source: SuggestionSource;
    dedupKey: string;
    jobSpec: CronSuggestion["jobSpec"];
  }): CronSuggestion | null {
    if (!VALID_SOURCES.includes(input.source)) {
      throw new Error(`Invalid suggestion source: ${input.source}`);
    }
    if (this.isDuplicate(input.dedupKey)) return null;
    if (this.getPendingCount() >= this.maxPending) return null;

    const suggestion: CronSuggestion = {
      id: `sugg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: input.title,
      description: input.description,
      source: input.source,
      status: "pending",
      dedupKey: input.dedupKey,
      jobSpec: input.jobSpec,
      createdAt: new Date().toISOString(),
    };

    this.suggestions.set(suggestion.id, suggestion);
    this.save();
    this.eventBus?.publish(
      "cron.suggestion_added",
      { suggestionId: suggestion.id, title: suggestion.title, source: suggestion.source },
      "cron-suggestions",
    );
    return suggestion;
  }

  /** 列出 pending 建议 */
  listPending(): CronSuggestion[] {
    const pending: CronSuggestion[] = [];
    for (const s of this.suggestions.values()) {
      if (s.status === "pending") pending.push(s);
    }
    // 按创建时间排序（先到先展示）
    pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return pending;
  }

  /** 列出所有建议 */
  listAll(): CronSuggestion[] {
    return Array.from(this.suggestions.values());
  }

  /** 按 id 获取建议 */
  getSuggestion(id: string): CronSuggestion | undefined {
    return this.suggestions.get(id);
  }

  /**
   * 接受建议——创建对应的 cron job。
   * 这是 consent-first 的核心：用户主动接受后才会真正创建任务。
   */
  acceptSuggestion(id: string): { success: boolean; taskId?: string; error?: string } {
    const suggestion = this.suggestions.get(id);
    if (!suggestion) return { success: false, error: "建议不存在" };
    if (suggestion.status !== "pending") return { success: false, error: `建议状态为 ${suggestion.status}，不可接受` };
    if (!this.scheduleManager) return { success: false, error: "ScheduleManager 未绑定" };

    try {
      const task = this.scheduleManager.createTask({
        name: suggestion.jobSpec.name,
        cronExpression: suggestion.jobSpec.cronExpression,
        description: suggestion.jobSpec.description,
        handlerType: suggestion.jobSpec.handlerType,
        handlerConfig: suggestion.jobSpec.handlerConfig,
      });

      suggestion.status = "accepted";
      suggestion.resolvedAt = new Date().toISOString();
      this.save();

      this.eventBus?.publish(
        "cron.suggestion_accepted",
        { suggestionId: id, taskId: task.id, title: suggestion.title },
        "cron-suggestions",
      );

      return { success: true, taskId: task.id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 拒绝建议 */
  dismissSuggestion(id: string): boolean {
    const suggestion = this.suggestions.get(id);
    if (!suggestion || suggestion.status !== "pending") return false;

    suggestion.status = "dismissed";
    suggestion.resolvedAt = new Date().toISOString();
    this.save();

    this.eventBus?.publish(
      "cron.suggestion_dismissed",
      { suggestionId: id, title: suggestion.title },
      "cron-suggestions",
    );
    return true;
  }

  /** 清除已解决（accepted/dismissed）的建议 */
  clearResolved(): number {
    let count = 0;
    for (const [id, s] of this.suggestions) {
      if (s.status !== "pending") {
        this.suggestions.delete(id);
        count++;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  /** 种子内置建议（幂等——已存在的 dedupKey 不会重复添加） */
  seedCatalogSuggestions(): void {
    for (const entry of BUILTIN_CATALOG) {
      this.addSuggestion({
        title: entry.title,
        description: entry.description,
        source: "catalog",
        dedupKey: entry.key,
        jobSpec: entry.jobSpec,
      });
    }
  }

  /** 获取内置建议目录（供 UI 展示） */
  getCatalog(): CatalogEntry[] {
    return [...BUILTIN_CATALOG];
  }
}
