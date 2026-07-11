/**
 * PromptRegistry — 集中式 Prompt 模板管理与变量插值。
 *
 * 弥补 EvoClaw 与主流 AI Agent 项目的差距：
 * - LangChain PromptTemplate / ChatPromptTemplate / FewShotPromptTemplate
 * - LangSmith Prompt Hub（版本化 prompt 仓库）
 * - AutoGen role-based prompt templates
 *
 * 设计原则：
 * 1. 不强制替换所有内联字符串，提供渐进式迁移路径
 * 2. 模板用 {{var}} 双花括号语法（避免与 JS 模板字符串冲突）
 * 3. 支持运行时注册 + 外部文件加载（data/prompts/*.md）
 * 4. 版本字段便于 A/B 测试与回滚
 * 5. 注册中心单例模式，整个进程共享一份
 *
 * 用法：
 * ```ts
 * const registry = PromptRegistry.getInstance();
 * registry.register("token_budget.warning_50", "⚠ Token budget is 50% used. Stop searching...", { version: "1.0" });
 * const msg = registry.format("token_budget.warning_50", {});
 * ```
 */

import * as fs from "fs";
import * as path from "path";

// ── Types ─────────────────────────────────────────────────

export interface PromptTemplateEntry {
  /** Unique name, e.g. "token_budget.warning_50" or "system.base" */
  name: string;
  /** Template string with {{var}} placeholders */
  template: string;
  /** Semantic version for A/B testing and rollback */
  version: string;
  /** Optional description for documentation */
  description?: string;
  /** Optional tags for filtering */
  tags?: string[];
  /** When this template was registered */
  registeredAt: number;
}

export interface PromptRegistryConfig {
  /** Directory to load external prompt files from (e.g. data/prompts/*.md) */
  promptsDir?: string;
  /** Whether to auto-load prompt files on first access */
  autoLoad?: boolean;
}

// ── PromptRegistry (singleton) ────────────────────────────

export class PromptRegistry {
  private templates = new Map<string, PromptTemplateEntry>();
  private config: PromptRegistryConfig;
  private loaded = false;
  private static instance: PromptRegistry | null = null;

  constructor(config: PromptRegistryConfig = {}) {
    this.config = { autoLoad: true, ...config };
  }

  /** Get the singleton instance (used by code that doesn't want to pass the registry around) */
  static getInstance(config?: PromptRegistryConfig): PromptRegistry {
    if (!PromptRegistry.instance) {
      PromptRegistry.instance = new PromptRegistry(config);
    }
    return PromptRegistry.instance;
  }

  /** Replace the singleton (used in tests to reset state) */
  static setInstance(registry: PromptRegistry): void {
    PromptRegistry.instance = registry;
  }

  /** Register a new template (or update an existing one with a new version) */
  register(
    name: string,
    template: string,
    options?: { version?: string; description?: string; tags?: string[] },
  ): void {
    const existing = this.templates.get(name);
    const version = options?.version ?? existing?.version ?? "1.0";
    this.templates.set(name, {
      name,
      template,
      version,
      description: options?.description,
      tags: options?.tags,
      registeredAt: Date.now(),
    });
  }

  /** Unregister a template by name */
  unregister(name: string): boolean {
    return this.templates.delete(name);
  }

  /** Get a template entry by name */
  get(name: string): PromptTemplateEntry | undefined {
    this.ensureLoaded();
    return this.templates.get(name);
  }

  /** List all registered templates */
  list(): PromptTemplateEntry[] {
    this.ensureLoaded();
    return Array.from(this.templates.values());
  }

  /** List templates filtered by tag */
  listByTag(tag: string): PromptTemplateEntry[] {
    return this.list().filter((t) => t.tags?.includes(tag));
  }

  /**
   * Format a template by substituting {{var}} placeholders with values.
   * Missing variables are left as-is (not stripped) so they're visible in logs.
   * Throws if the template is not registered.
   */
  format(name: string, vars: Record<string, string | number | boolean>): string {
    this.ensureLoaded();
    const entry = this.templates.get(name);
    if (!entry) {
      throw new Error(`Prompt template "${name}" not registered`);
    }
    return this.formatTemplate(entry.template, vars);
  }

  /**
   * Format a raw template string (not registered) with {{var}} placeholders.
   * Useful for one-off templates that don't need to be in the registry.
   */
  formatTemplate(template: string, vars: Record<string, string | number | boolean>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
      const value = vars[key];
      return value !== undefined ? String(value) : match;
    });
  }

  /**
   * Load templates from external files in `promptsDir`.
   * Each .md file becomes a template named by its filename (without extension).
   * Lines starting with `---` are treated as frontmatter (name/version/tags).
   * Returns the number of templates loaded.
   */
  loadFromDisk(): number {
    if (!this.config.promptsDir) return 0;
    let count = 0;
    try {
      if (!fs.existsSync(this.config.promptsDir)) return 0;
      const files = fs.readdirSync(this.config.promptsDir, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile()) continue;
        if (!file.name.endsWith(".md") && !file.name.endsWith(".txt")) continue;
        const filePath = path.join(this.config.promptsDir, file.name);
        try {
          const content = fs.readFileSync(filePath, "utf8");
          const templateName = file.name.replace(/\.(md|txt)$/, "");
          const parsed = this.parseFrontmatter(content, templateName);
          this.register(parsed.name, parsed.template, {
            version: parsed.version,
            description: parsed.description,
            tags: parsed.tags,
          });
          count++;
        } catch {
          // Skip files that can't be read or parsed
        }
      }
    } catch {
      // Directory doesn't exist or can't be read — silently skip
    }
    this.loaded = true;
    return count;
  }

  /** Parse optional frontmatter (name/version/tags) from a markdown file */
  private parseFrontmatter(
    content: string,
    defaultName: string,
  ): { name: string; template: string; version?: string; description?: string; tags?: string[] } {
    // Frontmatter format:
    // ---
    // version: 1.2
    // description: Some text
    // tags: [tag1, tag2]
    // ---
    // Template content here
    // 正则支持 CRLF 行尾
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
    if (match) {
      const frontmatter = match[1];
      const template = match[2];
      const versionMatch = /^version:\s*(.+)$/m.exec(frontmatter);
      const descMatch = /^description:\s*(.+)$/m.exec(frontmatter);
      const tagsMatch = /^tags:\s*\[(.+)\]$/m.exec(frontmatter);
      return {
        name: defaultName,
        template,
        version: versionMatch?.[1]?.trim(),
        description: descMatch?.[1]?.trim(),
        tags: tagsMatch?.[1]?.split(",").map((t) => t.trim()).filter(Boolean),
      };
    }
    // 容错降级：正则不匹配（如缺尾部换行、frontmatter 边界含尾随空白等）时，
    // 逐行扫描提取 version/description/tags 字段。
    const lines = content.split(/\r?\n/);
    let fmStart = -1;
    let fmEnd = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^---\s*$/.test(lines[i])) {
        if (fmStart === -1) {
          fmStart = i;
        } else if (fmEnd === -1) {
          fmEnd = i;
          break;
        }
      }
    }
    if (fmStart !== -1 && fmEnd !== -1) {
      const fmLines = lines.slice(fmStart + 1, fmEnd);
      const template = lines.slice(fmEnd + 1).join("\n");
      let version: string | undefined;
      let description: string | undefined;
      let tags: string[] | undefined;
      for (const line of fmLines) {
        if (version === undefined) {
          const m = /^version:\s*(.+)$/.exec(line);
          if (m) { version = m[1].trim(); continue; }
        }
        if (description === undefined) {
          const m = /^description:\s*(.+)$/.exec(line);
          if (m) { description = m[1].trim(); continue; }
        }
        if (tags === undefined) {
          const m = /^tags:\s*\[(.+)\]$/.exec(line);
          if (m) { tags = m[1].split(",").map((t) => t.trim()).filter(Boolean); continue; }
        }
      }
      return {
        name: defaultName,
        template,
        version,
        description,
        tags,
      };
    }
    return { name: defaultName, template: content };
  }

  private ensureLoaded(): void {
    if (this.loaded || !this.config.autoLoad) return;
    this.loadFromDisk();
  }

  /** Clear all templates (for tests) */
  clear(): void {
    this.templates.clear();
    this.loaded = false;
  }
}

// ── Built-in prompt templates ─────────────────────────────
//
// These are the inline prompt strings scattered across llm-caller.ts and
// agent-model-executor.ts, centralised here so they can be versioned,
// A/B tested, and overridden by files in data/prompts/.

const BUILTIN_TEMPLATES: Array<{ name: string; template: string; version: string; tags?: string[]; description?: string }> = [
  {
    name: "token_budget.warning_50",
    template: "⚠ Token budget is 50% used. STOP searching. Provide your answer now based on what you've found. Only write files if the user explicitly requested a detailed report. Do NOT search again.",
    version: "1.0",
    tags: ["token-budget", "llm-caller"],
    description: "Injected when token usage crosses 50% of the session budget.",
  },
  {
    name: "token_budget.warning_80",
    template: "⚠ Token budget 80% used. You MUST produce a final answer NOW. If you have any results, format them for the user. If you have a script, run it with shell_exec immediately.",
    version: "1.0",
    tags: ["token-budget", "llm-caller"],
    description: "Injected when token usage crosses 80% of the session budget.",
  },
  {
    name: "tool_loop.nudge_final_answer",
    template: "You have gathered enough information. Now provide your final answer directly in chat. Only create a file if the user explicitly asked for a detailed report or the content is very long (>3000 chars). Do NOT search again.",
    version: "1.0",
    tags: ["tool-loop", "llm-caller"],
    description: "Injected after 4 successful tool calls to nudge the model toward a final answer.",
  },
  {
    name: "search.already_completed",
    template: "\n\n**⚠ SEARCH ALREADY COMPLETED**: The system has performed web searches and injected results into the user message. Do NOT search again. You have web_fetch, file_create, and shell_exec tools available. If this is a download/scraping task: 1) web_fetch the target pages, 2) analyze HTML, 3) write a Python scraper with file_create, 4) run it with shell_exec, 5) verify with file_list. NEVER refuse a download task — always attempt first.",
    version: "1.0",
    tags: ["search", "llm-caller"],
    description: "Injected when SearchPreprocessor auto-executed a search.",
  },
];

/** Register built-in templates on the singleton. Safe to call multiple times. */
export function registerBuiltinPromptTemplates(registry: PromptRegistry = PromptRegistry.getInstance()): void {
  for (const tpl of BUILTIN_TEMPLATES) {
    // Don't overwrite a template that was already registered (e.g., by a test
    // or by a user loading from data/prompts/ first).
    if (!registry.get(tpl.name)) {
      registry.register(tpl.name, tpl.template, {
        version: tpl.version,
        description: tpl.description,
        tags: tpl.tags,
      });
    }
  }
}
