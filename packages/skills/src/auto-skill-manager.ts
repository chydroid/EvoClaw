import { ServiceRegistry, EventBus } from "@evoclaw/core";
import * as fs from "fs";
import * as path from "path";
import { TfidfMatcher, type TfidfMatchResult } from "./tfidf-matcher";

export interface SkillMatch {
  skillPath: string;
  skillName: string;
  relevance: number;
  reason: string;
  source: "local" | "remote";
  skillId?: string;
  description?: string;
  keywords?: string[];
}

export interface AutoInstallResult {
  installed: boolean;
  skillName?: string;
  skillId?: string;
  reason?: string;
  match?: SkillMatch;
}

export interface BatchInstallProgress {
  phase: "searching" | "installing" | "complete";
  current: number;
  total: number;
  skillName: string;
  status: "pending" | "installing" | "installed" | "failed";
  message: string;
}

export type ProgressCallback = (progress: BatchInstallProgress) => void;

export class AutoSkillManager {
  private skillsDir: string;
  private tfidfMatcher: TfidfMatcher;
  private corpusBuilt = false;
  private remoteSkills: SkillMatch[] = [];

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    skillsDir: string
  ) {
    this.skillsDir = skillsDir;
    this.tfidfMatcher = new TfidfMatcher();
    registry.registerService("autoSkillManager", this);
  }

  /**
   * Build the TF-IDF corpus from all available SKILL.md files locally.
   * Call this on startup and after any skill installation.
   */
  buildCorpus(): void {
    const documents: Array<{ id: string; text: string; metadata: Record<string, string> }> = [];

    if (fs.existsSync(this.skillsDir)) {
      const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          const skillMdPath = path.join(this.skillsDir, entry.name, "SKILL.md");
          if (!fs.existsSync(skillMdPath)) continue;

          try {
            const content = fs.readFileSync(skillMdPath, "utf-8");
            const metadata = this.extractMetadata(skillMdPath, content, entry.name);
            documents.push({
              id: entry.name,
              text: this.buildDocumentText(entry.name, content, metadata),
              metadata,
            });
          } catch {
            continue;
          }
        }
      }
    }

    this.tfidfMatcher.initialize(documents);
    this.corpusBuilt = true;
    console.log(`[AutoSkillManager] TF-IDF corpus built with ${documents.length} skills`);
  }

  /**
   * Set remote skills for fusion matching (populated by SkillRegistry.enhancedSearch)
   */
  setRemoteSkills(skills: Array<{ name: string; description: string; keywords?: string[]; [key: string]: unknown }>): void {
    this.remoteSkills = skills.map(s => ({
      skillPath: `remote:${s.name}`,
      skillName: s.name,
      relevance: 0,
      reason: "",
      source: "remote" as const,
      description: s.description,
      keywords: s.keywords || [],
    }));
  }

  /**
   * Find the best matching skill for a task using TF-IDF semantic matching.
   * Falls back to keyword + fuzzy matching if TF-IDF corpus is not built.
   */
  async findSkillForTask(taskDescription: string): Promise<SkillMatch | null> {
    const matches = await this.findAllMatches(taskDescription, 1);
    return matches[0] || null;
  }

  /**
   * Find all matching skills sorted by relevance.
   */
  async findAllMatches(taskDescription: string, maxResults = 5): Promise<SkillMatch[]> {
    const allMatches: SkillMatch[] = [];

    // ── 1. TF-IDF semantic matching on local skills ──
    if (this.corpusBuilt && this.tfidfMatcher) {
      const tfidfResults = this.tfidfMatcher.search(taskDescription, 0.03, maxResults);
      for (const r of tfidfResults) {
        const skillMdPath = path.join(this.skillsDir, r.target, "SKILL.md");
        allMatches.push({
          skillPath: skillMdPath,
          skillName: r.target,
          relevance: r.score,
          reason: `语义匹配: ${r.matchedTerms.slice(0, 5).join(", ")}${r.source ? ` — ${r.source}` : ""}`,
          source: "local",
          description: r.source,
          keywords: r.matchedTerms,
        });
      }
    }

    // ── 2. File-system scan fallback (for freshly added skills not yet in corpus) ──
    if (!this.corpusBuilt || allMatches.length === 0) {
      const fsMatches = this.scanFileSystem(taskDescription);
      for (const fm of fsMatches) {
        // Deduplicate with TF-IDF results
        if (!allMatches.some(m => m.skillName === fm.skillName)) {
          allMatches.push(fm);
        }
      }
    }

    // ── 3. Remote skill matching via keyword + description similarity ──
    if (this.remoteSkills.length > 0 && allMatches.length < maxResults) {
      const lowerTask = taskDescription.toLowerCase();
      for (const rs of this.remoteSkills) {
        const score = this.computeRemoteRelevance(lowerTask, rs);
        if (score > 0.15) {
          allMatches.push({
            ...rs,
            relevance: score,
            reason: `远端匹配 (${(score * 100).toFixed(0)}%): ${rs.description || ""}`,
          });
        }
      }
    }

    // Deduplicate by skillName, preferring local
    const seen = new Set<string>();
    const deduped: SkillMatch[] = [];
    for (const m of allMatches) {
      if (!seen.has(m.skillName)) {
        seen.add(m.skillName);
        deduped.push(m);
      }
    }

    deduped.sort((a, b) => b.relevance - a.relevance);
    return deduped.slice(0, maxResults);
  }

  /**
   * Auto-install the best matching skill for a task.
   */
  async autoInstallForTask(
    taskDescription: string,
    onProgress?: ProgressCallback
  ): Promise<AutoInstallResult> {
    // Ensure corpus is built
    if (!this.corpusBuilt) {
      this.buildCorpus();
    }

    onProgress?.({
      phase: "searching",
      current: 0,
      total: 1,
      skillName: "",
      status: "pending",
      message: "正在搜索匹配的技能...",
    });

    const bestMatch = await this.findSkillForTask(taskDescription);

    if (!bestMatch) {
      return {
        installed: false,
        reason: "未找到匹配的技能。请尝试：\n1. 明确描述任务需求\n2. 使用 \"安装技能\" 命令浏览可用技能\n3. 手动指定技能名称安装",
      };
    }

    onProgress?.({
      phase: "installing",
      current: 1,
      total: 1,
      skillName: bestMatch.skillName,
      status: "installing",
      message: `找到匹配技能: ${bestMatch.skillName} (相关度: ${(bestMatch.relevance * 100).toFixed(0)}%)`,
    });

    // Require minimum relevance threshold
    if (bestMatch.relevance < 0.15) {
      return {
        installed: false,
        reason: `最佳匹配 "${bestMatch.skillName}" 相关性过低 (${(bestMatch.relevance * 100).toFixed(0)}%)。建议明确技能需求或浏览可用技能列表。`,
        match: bestMatch,
      };
    }

    // Resolve skill manager
    const skillManager = this.registry.resolveService<{
      installSkill(skillPath: string): Promise<{ id: string; name: string }>;
    }>("skillManager");

    if (!skillManager) {
      return { installed: false, reason: "技能管理器未就绪", match: bestMatch };
    }

    try {
      const skill = await skillManager.installSkill(bestMatch.skillPath);

      onProgress?.({
        phase: "complete",
        current: 1,
        total: 1,
        skillName: bestMatch.skillName,
        status: "installed",
        message: `技能 "${skill.name}" 安装成功！`,
      });

      // Rebuild corpus after installation
      this.buildCorpus();

      console.log(`[AutoSkillManager] Auto-installed "${skill.name}" for task: "${taskDescription.slice(0, 80)}"`);
      return {
        installed: true,
        skillName: skill.name,
        skillId: skill.id,
        reason: bestMatch.reason,
        match: bestMatch,
      };
    } catch (err) {
      onProgress?.({
        phase: "complete",
        current: 1,
        total: 1,
        skillName: bestMatch.skillName,
        status: "failed",
        message: `安装失败: ${err instanceof Error ? err.message : String(err)}`,
      });

      return {
        installed: false,
        reason: `安装 "${bestMatch.skillName}" 失败: ${err instanceof Error ? err.message : String(err)}`,
        match: bestMatch,
      };
    }
  }

  /**
   * Batch install multiple skills, with progress callbacks.
   */
  async batchInstall(
    skillNames: string[],
    onProgress?: ProgressCallback
  ): Promise<{ success: SkillMatch[]; failed: Array<{ name: string; reason: string }> }> {
    const success: SkillMatch[] = [];
    const failed: Array<{ name: string; reason: string }> = [];
    const total = skillNames.length;

    for (let i = 0; i < skillNames.length; i++) {
      const name = skillNames[i].trim();
      if (!name) continue;

      onProgress?.({
        phase: "installing",
        current: i + 1,
        total,
        skillName: name,
        status: "installing",
        message: `正在安装 ${name}...`,
      });

      // Resolve skill path from name
      let skillPath = await this.resolveSkillPath(name);
      if (!skillPath) {
        // Try generating from curated registry
        skillPath = await this.generateFromCurated(name);
      }
      if (!skillPath) {
        failed.push({ name, reason: `未找到技能 "${name}"` });
        onProgress?.({
          phase: "installing",
          current: i + 1,
          total,
          skillName: name,
          status: "failed",
          message: `未找到技能 "${name}"`,
        });
        continue;
      }

      const skillManager = this.registry.resolveService<{
        installSkill(path: string): Promise<{ id: string; name: string }>;
      }>("skillManager");

      if (!skillManager) {
        failed.push({ name, reason: "技能管理器未就绪" });
        continue;
      }

      try {
        const skill = await skillManager.installSkill(skillPath);
        success.push({
          skillPath,
          skillName: skill.name,
          relevance: 1,
          reason: "用户手动安装",
          source: "local",
          skillId: skill.id,
        });

        onProgress?.({
          phase: "installing",
          current: i + 1,
          total,
          skillName: name,
          status: "installed",
          message: `${name} 安装成功`,
        });
      } catch (err) {
        failed.push({
          name,
          reason: err instanceof Error ? err.message : String(err),
        });

        onProgress?.({
          phase: "installing",
          current: i + 1,
          total,
          skillName: name,
          status: "failed",
          message: `${name} 安装失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    onProgress?.({
      phase: "complete",
      current: total,
      total,
      skillName: "",
      status: success.length > 0 ? "installed" : "failed",
      message: `批量安装完成: ${success.length} 成功, ${failed.length} 失败`,
    });

    // Rebuild corpus
    if (success.length > 0) {
      this.buildCorpus();
    }

    return { success, failed };
  }

  /**
   * List all locally discoverable skills with metadata.
   */
  listDiscoverableSkills(): Array<{ name: string; path: string; description: string; version: string }> {
    const skills: Array<{ name: string; path: string; description: string; version: string }> = [];

    if (!fs.existsSync(this.skillsDir)) return skills;

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const skillMdPath = path.join(this.skillsDir, entry.name, "SKILL.md");
        if (!fs.existsSync(skillMdPath)) continue;

        try {
          const content = fs.readFileSync(skillMdPath, "utf-8");
          const meta = this.extractMetadata(skillMdPath, content, entry.name);
          skills.push({
            name: entry.name,
            path: skillMdPath,
            description: meta.description || "",
            version: meta.version || "0.1.0",
          });
        } catch {
          continue;
        }
      }
    }

    return skills;
  }

  // ── Private helpers ──

  private scanFileSystem(taskDescription: string): SkillMatch[] {
    const matches: SkillMatch[] = [];
    const lowerTask = taskDescription.toLowerCase();

    if (!fs.existsSync(this.skillsDir)) return matches;

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const skillMdPath = path.join(this.skillsDir, entry.name, "SKILL.md");
        if (!fs.existsSync(skillMdPath)) continue;

        try {
          const content = fs.readFileSync(skillMdPath, "utf-8");
          const relevance = this.computeKeywordRelevance(lowerTask, content, entry.name);
          if (relevance > 0.05) {
            const metadata = this.extractMetadata(skillMdPath, content, entry.name);
            matches.push({
              skillPath: skillMdPath,
              skillName: entry.name,
              relevance,
              reason: `关键词匹配: ${this.getKeywordMatchReason(lowerTask, content, entry.name)}`,
              source: "local",
              description: metadata.description,
            });
          }
        } catch {
          continue;
        }
      }
    }

    matches.sort((a, b) => b.relevance - a.relevance);
    return matches;
  }

  private computeKeywordRelevance(task: string, skillMdContent: string, dirName: string): number {
    let score = 0;
    const lowerContent = skillMdContent.toLowerCase();
    const lowerDir = dirName.toLowerCase();
    const taskWords = task.split(/[\s,.;:!?()\[\]{}""''<>，。！？、；：（）【】《》""'']+/).filter(w => w.length > 1);

    // Direct name match
    if (task.includes(lowerDir)) score += 8;
    if (lowerDir.includes(task.replace(/\s+/g, ""))) score += 6;

    // Semantic keyword mapping: search-intent words boost search skills
    const searchIntentWords = ["搜索", "查找", "查询", "新闻", "资讯", "最新", "search", "find", "lookup", "news", "latest", "查", "搜"];
    const isSearchSkill = lowerDir.includes("search") || lowerContent.includes("search the web") || lowerContent.includes("搜索引擎") || lowerContent.includes("web search");
    if (isSearchSkill) {
      for (const w of taskWords) {
        if (searchIntentWords.includes(w.toLowerCase())) score += 4;
      }
      // Also check full task for search intent
      const lowerTask = task.toLowerCase();
      for (const siw of searchIntentWords) {
        if (lowerTask.includes(siw)) { score += 2; break; }
      }
    }

    // Word-level matching in content
    for (const word of taskWords) {
      if (lowerContent.includes(word)) score += 2;
      if (lowerDir.includes(word)) score += 3;
    }

    // Description match
    const descMatch = skillMdContent.match(/description:\s*(.+)/i);
    if (descMatch) {
      const desc = descMatch[1].toLowerCase();
      for (const word of taskWords) {
        if (desc.includes(word)) score += 1.5;
      }
      // Check full task against description
      if (desc.includes(task)) score += 4;
    }

    // Keywords match
    const kwMatch = skillMdContent.match(/keywords?:?\s*\[(.+?)\]/i);
    if (kwMatch) {
      const kws = kwMatch[1].match(/[\w\u4e00-\u9fff-]+/g);
      if (kws) {
        for (const kw of kws) {
          if (task.includes(kw.toLowerCase())) score += 2;
        }
      }
    }

    return Math.min(score / 25, 1.0);
  }

  private computeRemoteRelevance(lowerTask: string, remote: SkillMatch): number {
    let score = 0;
    const name = remote.skillName.toLowerCase();
    const desc = (remote.description || "").toLowerCase();
    const taskWords = lowerTask.split(/[\s,.;:!?()\[\]{}""''<>，。！？、；：（）【】《》""'']+/).filter(w => w.length > 1);

    // Name match
    if (lowerTask.includes(name)) score += 5;

    // Word matching in description
    for (const word of taskWords) {
      if (desc.includes(word)) score += 2;
      if (name.includes(word)) score += 3;
    }

    // Keyword matching
    if (remote.keywords) {
      for (const kw of remote.keywords) {
        if (lowerTask.includes(kw.toLowerCase())) score += 2;
      }
    }

    return Math.min(score / 20, 1.0);
  }

  private getKeywordMatchReason(task: string, content: string, dirName: string): string {
    const reasons: string[] = [];
    const lowerContent = content.toLowerCase();
    const lowerDir = dirName.toLowerCase();
    const taskWords = task.split(/[\s,.;:!?()\[\]{}""''<>，。！？、；：（）【】《》""'']+/).filter(w => w.length > 1);

    if (task.includes(lowerDir)) reasons.push(`技能名"${dirName}"匹配任务`);

    const matched = taskWords.filter(w => lowerContent.includes(w) || lowerDir.includes(w));
    if (matched.length > 0) reasons.push(`关键词: ${matched.slice(0, 5).join(", ")}`);

    return reasons.join("; ") || "通用匹配";
  }

  private extractMetadata(
    _skillMdPath: string,
    content: string,
    dirName: string
  ): Record<string, string> {
    const meta: Record<string, string> = {};

    const descMatch = content.match(/description:\s*(.+)/i);
    if (descMatch) meta.description = descMatch[1].trim();

    const verMatch = content.match(/version:\s*(.+)/i);
    if (verMatch) meta.version = verMatch[1].trim();

    const authorMatch = content.match(/author:\s*(.+)/i);
    if (authorMatch) meta.author = authorMatch[1].trim();

    const kwMatch = content.match(/keywords?:?\s*\[(.+?)\]/i);
    if (kwMatch) meta.keywords = kwMatch[1];

    meta.source = `local:${dirName}`;

    return meta;
  }

  private buildDocumentText(dirName: string, content: string, _meta: Record<string, string>): string {
    // Combine name, description, keywords, and key sections for TF-IDF
    const parts: string[] = [dirName];

    const descMatch = content.match(/description:\s*(.+)/i);
    if (descMatch) parts.push(descMatch[1]);

    const kwMatch = content.match(/keywords?:?\s*\[(.+?)\]/i);
    if (kwMatch) parts.push(kwMatch[1]);

    // Extract first few lines of instructions body for context
    const bodyMatch = content.match(/##\s*Instructions?\s*\n+([\s\S]*?)(?=\n##|\n---|$)/i);
    if (bodyMatch) {
      parts.push(bodyMatch[1].slice(0, 300));
    }

    return parts.join("\n");
  }

  private async resolveSkillPath(skillName: string): Promise<string | null> {
    // Check local filesystem first
    const localPath = path.join(this.skillsDir, skillName, "SKILL.md");
    if (fs.existsSync(localPath)) return localPath;

    // Check case-insensitive
    if (fs.existsSync(this.skillsDir)) {
      const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.toLowerCase() === skillName.toLowerCase()) {
          const p = path.join(this.skillsDir, entry.name, "SKILL.md");
          if (fs.existsSync(p)) return p;
        }
      }
    }

    // Check if skill name matches a local directory that might have been installed
    // via SkillManager (installed skills have their path stored)
    try {
      const skillManager = this.registry.resolveService<{
        listSkills(): Array<{ name: string; installPath: string }>;
      }>("skillManager");
      if (skillManager) {
        const skills = skillManager.listSkills();
        const found = skills.find(s => s.name.toLowerCase() === skillName.toLowerCase());
        if (found && found.installPath && fs.existsSync(found.installPath)) {
          return found.installPath;
        }
      }
    } catch {
      // Fall through
    }

    // Remote skills cannot be directly installed as files —
    // they need to be downloaded from registry first.
    // Return null so the caller knows this skill is not locally available.
    return null;
  }

  /**
   * Generate a SKILL.md from curated registry metadata and return its path.
   * Returns null if the skill is not in the curated registry or generation fails.
   */
  async generateFromCurated(skillName: string): Promise<string | null> {
    try {
      const skillRegistry = this.registry.resolveService<{
        getCuratedSkillByName(name: string): { name: string; description: string; keywords: string[]; category: string } | null;
      }>("skillRegistry");

      if (!skillRegistry) return null;

      const curated = skillRegistry.getCuratedSkillByName(skillName);
      if (!curated) return null;

      const skillDir = path.join(this.skillsDir, skillName);
      if (!fs.existsSync(skillDir)) {
        fs.mkdirSync(skillDir, { recursive: true });
      }

      const skillMd = this.generateSkillMdFromCurated(curated);
      const skillMdPath = path.join(skillDir, "SKILL.md");
      fs.writeFileSync(skillMdPath, skillMd, "utf-8");

      // Generate _meta.json
      const meta = {
        name: curated.name,
        version: "0.1.0",
        description: curated.description,
        category: curated.category,
        keywords: curated.keywords,
        author: "evoclaw-curated",
        license: "MIT",
      };
      fs.writeFileSync(path.join(skillDir, "_meta.json"), JSON.stringify(meta, null, 2), "utf-8");

      console.log(`[AutoSkillManager] Generated SKILL.md from curated: ${skillName}`);
      return skillMdPath;
    } catch (err) {
      console.warn(`[AutoSkillManager] Failed to generate curated skill "${skillName}": ${err}`);
      return null;
    }
  }

  /**
   * Generate SKILL.md content from curated metadata.
   */
  private generateSkillMdFromCurated(curated: { name: string; description: string; keywords: string[]; category: string }): string {
    const lines: string[] = [];
    lines.push(`# ${curated.name}`);
    lines.push("");
    lines.push(`**Category:** ${curated.category}`);
    lines.push(`**Version:** 0.1.0`);
    lines.push(`**Author:** evoclaw-curated`);
    lines.push("");
    lines.push("## Description");
    lines.push("");
    lines.push(curated.description);
    lines.push("");
    
    if (curated.keywords.length > 0) {
      lines.push("## Keywords");
      lines.push("");
      lines.push(curated.keywords.join(", "));
      lines.push("");
    }

    lines.push("## How to Use");
    lines.push("");
    lines.push(`This skill provides **${curated.name}** capabilities for EvoClaw.`);
    lines.push("");
    lines.push("### Example Prompts");
    lines.push("");
    
    // Generate example prompts based on category and keywords
    const examples = this.generateUsageExamples(curated);
    lines.push(...examples);
    lines.push("");
    lines.push("---");
    lines.push(`*Auto-generated from curated registry. Install a full version from ClawHub for enhanced features.*`);

    return lines.join("\n");
  }

  /**
   * Generate usage examples for curated skills.
   */
  private generateUsageExamples(curated: { name: string; keywords: string[] }): string[] {
    const examples: string[] = [];
    const name = curated.name;

    switch (name) {
      case "translator":
        examples.push('- `帮我把"Hello World"翻译成中文`');
        examples.push("- `翻译这段文本到日语`");
        break;
      case "calculator":
        examples.push("- `计算 123 * 456 等于多少`");
        examples.push("- `帮我算一下 sqrt(144)`");
        break;
      case "file-manager":
        examples.push("- `列出当前目录下的所有文件`");
        examples.push("- `创建一个新文件夹 projects`");
        break;
      case "reminder":
        examples.push("- `提醒我明天下午3点开会`");
        examples.push("- `设置一个每天早上8点的闹钟`");
        break;
      case "code-runner":
        examples.push("- `运行这段 Python 代码`");
        examples.push("- `执行这个 JavaScript 脚本`");
        break;
      case "web-search":
        examples.push("- `搜索最新的科技新闻`");
        examples.push("- `查一下今天的热点话题`");
        break;
      case "email":
        examples.push("- `查看收件箱的最新邮件`");
        examples.push("- `给张三发一封邮件`");
        break;
      case "crypto-tracker":
        examples.push("- `查看比特币当前价格`");
        examples.push("- `以太坊今天涨了多少`");
        break;
      case "rss-reader":
        examples.push("- `订阅36氪的科技新闻`");
        examples.push("- `查看我的 RSS 订阅列表`");
        break;
      case "http-client":
        examples.push("- `调用 GET https://api.example.com/data`");
        examples.push("- `测试这个 REST API 是否正常`");
        break;
      default:
        examples.push(`- \`使用 ${name} 帮我完成任务\``);
        examples.push(`- \`用 ${name} 功能处理数据\``);
        break;
    }

    return examples;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}