/**
 * L3 PersonaProfile — 跨会话用户画像生成器。
 *
 * 借鉴 TencentDB-Agent-Memory L3 设计：把分散在 L1/L2 的"用户稳定属性"
 * 蒸馏成一个单一 Markdown 文件，作为系统提示的稳定上下文。
 *
 * 蒸馏策略（启发式，不依赖 LLM）：
 * - 从所有 L1 persona 记忆中按 priority 倒序取 top-N
 * - 按主题分组（技术栈/身份/偏好/习惯）
 * - 去重（语义相似的关键词相同则合并）
 * - 输出成 Markdown 文件
 *
 * 文件布局：
 *   ${DATA_DIR}/memory/layered/persona.md
 *
 * Markdown 结构：
 *   ---
 *   persona_version: 3
 *   updated_at: 2026-07-04T12:00:00Z
 *   source_memory_count: 12
 *   ---
 *   # 用户画像
 *   ## 技术栈
 *   - 用户偏好使用 TypeScript
 *   ## 身份
 *   - 用户是后端工程师
 *   ## 偏好
 *   - 用户喜欢简洁代码
 *   ## 长期指令
 *   - 用户要求所有 PR 通过 typecheck
 */

import * as fs from "fs";
import * as path from "path";
import type { AtomicMemory } from "./atomic-memory-extractor";
import { atomicWriteFileSync } from "./atomic-write";

/** L3 用户画像主题分组。 */
export type PersonaTopic = "tech_stack" | "identity" | "preference" | "instruction";

/** L3 画像条目。 */
export interface PersonaEntry {
  /** 主题分组。 */
  topic: PersonaTopic;
  /** 画像陈述（独立完整）。 */
  content: string;
  /** 来源 L1 记忆 ID 列表（用于溯源）。 */
  sourceMemoryIds: string[];
  /** 最高优先级。 */
  priority: number;
}

/** L3 画像文件结构。 */
export interface PersonaProfile {
  /** 画像版本（每次刷新递增）。 */
  version: number;
  /** 最后更新时间（epoch ms）。 */
  updatedAt: number;
  /** 来源 L1 记忆数量。 */
  sourceMemoryCount: number;
  /** 画像条目列表。 */
  entries: PersonaEntry[];
  /** Markdown 文件路径。 */
  filePath?: string;
}

/** L3 配置。 */
export interface PersonaProfileOptions {
  /** 最多保留多少条画像条目。默认 30。 */
  maxEntries?: number;
  /** 每个主题最多保留多少条。默认 10。 */
  maxPerTopic?: number;
  /** 最低优先级阈值。默认 50。 */
  minPriority?: number;
}

const DEFAULT_OPTIONS: Required<PersonaProfileOptions> = {
  maxEntries: 30,
  maxPerTopic: 10,
  minPriority: 50,
};

/** 主题中文显示名。 */
const TOPIC_LABEL: Record<PersonaTopic, string> = {
  tech_stack: "技术栈",
  identity: "身份",
  preference: "偏好",
  instruction: "长期指令",
};

/**
 * L3 用户画像生成器。
 */
export class PersonaProfileGenerator {
  private readonly personaFile: string;
  private current: PersonaProfile | null = null;

  constructor(private dataDir: string) {
    const dir = path.join(dataDir, "memory", "layered");
    this.ensureDir(dir);
    this.personaFile = path.join(dir, "persona.md");
    // 启动时加载已有画像
    this.current = this.loadFromDisk();
  }

  /**
   * 用一批 L1 记忆刷新画像。
   * - persona 类型 → 进入画像
   * - instruction 类型 → 进入"长期指令"分组
   * - episodic 类型 → 跳过（事件型不进画像）
   * @returns 新画像
   */
  refresh(l1Memories: AtomicMemory[], options?: PersonaProfileOptions): PersonaProfile {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    // 过滤 + 分类
    const candidates: PersonaEntry[] = [];
    for (const mem of l1Memories) {
      if (mem.priority < opts.minPriority) continue;

      if (mem.type === "persona") {
        const topic = this.classifyPersona(mem.content);
        candidates.push({
          topic,
          content: mem.content,
          sourceMemoryIds: [mem.id],
          priority: mem.priority,
        });
      } else if (mem.type === "instruction") {
        candidates.push({
          topic: "instruction",
          content: mem.content,
          sourceMemoryIds: [mem.id],
          priority: mem.priority,
        });
      }
    }

    // 按主题分组 + 去重
    const grouped: Record<PersonaTopic, PersonaEntry[]> = {
      tech_stack: [],
      identity: [],
      preference: [],
      instruction: [],
    };
    for (const c of candidates) {
      const group = grouped[c.topic];
      // 去重：相同关键词的合并
      const dupIdx = group.findIndex((e) => this.isSimilar(e.content, c.content));
      if (dupIdx >= 0) {
        // 合并：保留更高优先级
        const existing = group[dupIdx];
        if (c.priority > existing.priority) {
          existing.priority = c.priority;
          existing.content = c.content;
        }
        existing.sourceMemoryIds.push(...c.sourceMemoryIds);
      } else {
        group.push(c);
      }
    }

    // 每组按优先级倒序 + 取 top-N
    for (const topic of Object.keys(grouped) as PersonaTopic[]) {
      grouped[topic].sort((a, b) => b.priority - a.priority);
      grouped[topic] = grouped[topic].slice(0, opts.maxPerTopic);
    }

    // 汇总 + 全局 top-N
    const allEntries = [
      ...grouped.identity,
      ...grouped.tech_stack,
      ...grouped.preference,
      ...grouped.instruction,
    ].slice(0, opts.maxEntries);

    const newVersion = (this.current?.version ?? 0) + 1;
    this.current = {
      version: newVersion,
      updatedAt: Date.now(),
      sourceMemoryCount: l1Memories.length,
      entries: allEntries,
    };

    this.writeToDisk();
    return this.current;
  }

  /** 获取当前画像（不刷新）。 */
  getCurrent(): PersonaProfile | null {
    return this.current;
  }

  /** 把画像渲染成 Markdown（用于注入到系统提示）。 */
  renderMarkdown(): string {
    if (!this.current || this.current.entries.length === 0) return "";

    const lines: string[] = [];
    lines.push("# 用户画像");
    lines.push("");

    const grouped: Record<PersonaTopic, PersonaEntry[]> = {
      identity: [],
      tech_stack: [],
      preference: [],
      instruction: [],
    };
    for (const e of this.current.entries) {
      grouped[e.topic].push(e);
    }

    for (const topic of ["identity", "tech_stack", "preference", "instruction"] as PersonaTopic[]) {
      if (grouped[topic].length === 0) continue;
      lines.push(`## ${TOPIC_LABEL[topic]}`);
      for (const e of grouped[topic]) {
        lines.push(`- ${e.content}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /** 查找画像中是否包含某关键词（用于召回判断）。 */
  containsKeyword(keyword: string): boolean {
    if (!this.current) return false;
    const lower = keyword.toLowerCase();
    return this.current.entries.some((e) => e.content.toLowerCase().includes(lower));
  }

  /** 清空画像。 */
  clear(): void {
    this.current = null;
    try {
      if (fs.existsSync(this.personaFile)) fs.unlinkSync(this.personaFile);
    } catch { /* ignore */ }
  }

  // ── 私有辅助 ──

  private classifyPersona(content: string): PersonaTopic {
    const lower = content.toLowerCase();
    // 技术栈：包含编程语言/框架名
    if (/\b(?:typescript|python|javascript|rust|go|java|c\+\+|react|vue|angular|node|docker|kubernetes|k8s)\b/i.test(lower)) {
      return "tech_stack";
    }
    // 身份：包含职业/角色词
    if (/(?:工程师|开发者|程序员|设计师|产品经理|架构师|data\s*scientist|engineer|developer|programmer|designer|architect|manager)/i.test(lower)) {
      return "identity";
    }
    // 偏好（默认）
    return "preference";
  }

  private isSimilar(a: string, b: string): boolean {
    // 简单相似度：共享至少 2 个关键词（>=4 字符英文 / 2-4 字中文片段）
    const ka = this.extractKeywords(a);
    const kb = this.extractKeywords(b);
    let overlap = 0;
    for (const k of kb) {
      if (ka.has(k)) overlap++;
      if (overlap >= 2) return true;
    }
    return false;
  }

  private extractKeywords(text: string): Set<string> {
    const keywords = new Set<string>();
    const en = text.match(/\b[a-zA-Z][a-zA-Z0-9_-]{3,}\b/g);
    if (en) for (const w of en) keywords.add(w.toLowerCase());
    const cn = text.match(/[\u4e00-\u9fff]{2,4}/g);
    if (cn) for (const w of cn) keywords.add(w);
    return keywords;
  }

  private writeToDisk(): void {
    if (!this.current) return;
    const md = this.renderFile();
    // 使用原子写保证崩溃时不产生截断文件
    atomicWriteFileSync(this.personaFile, md);
    this.current.filePath = this.personaFile;
  }

  private loadFromDisk(): PersonaProfile | null {
    if (!fs.existsSync(this.personaFile)) return null;
    try {
      const md = fs.readFileSync(this.personaFile, "utf-8");
      return this.parseFile(md);
    } catch {
      return null;
    }
  }

  private renderFile(): string {
    const lines: string[] = [];
    lines.push("---");
    lines.push(`persona_version: ${this.current!.version}`);
    lines.push(`updated_at: ${new Date(this.current!.updatedAt).toISOString()}`);
    lines.push(`source_memory_count: ${this.current!.sourceMemoryCount}`);
    lines.push("---");
    lines.push("");
    lines.push(this.renderMarkdown());
    return lines.join("\n");
  }

  private parseFile(md: string): PersonaProfile | null {
    const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const fm = fmMatch[1];
    const version = parseInt(fm.match(/persona_version:\s*(\d+)/)?.[1] ?? "1", 10);
    const updatedAt = Date.parse(fm.match(/updated_at:\s*(\S+)/)?.[1] ?? "") || Date.now();
    const sourceMemoryCount = parseInt(fm.match(/source_memory_count:\s*(\d+)/)?.[1] ?? "0", 10);

    const entries: PersonaEntry[] = [];
    let currentTopic: PersonaTopic | null = null;
    for (const line of md.split("\n")) {
      const topicMatch = line.match(/^## (身份|技术栈|偏好|长期指令)$/);
      if (topicMatch) {
        const label = topicMatch[1];
        currentTopic = (
          label === "身份" ? "identity" :
          label === "技术栈" ? "tech_stack" :
          label === "偏好" ? "preference" : "instruction"
        ) as PersonaTopic;
        continue;
      }
      const itemMatch = line.match(/^-\s+(.+)$/);
      if (itemMatch && currentTopic) {
        entries.push({
          topic: currentTopic,
          content: itemMatch[1].trim(),
          sourceMemoryIds: [],
          priority: 50,
        });
      }
    }

    return {
      version,
      updatedAt,
      sourceMemoryCount,
      entries,
      filePath: this.personaFile,
    };
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
