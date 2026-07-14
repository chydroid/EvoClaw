import { ServiceRegistry, EventBus, atomicWriteFileSync as coreAtomicWriteFileSync } from "@evoclaw/core";
import * as fs from "fs";
import * as path from "path";
import { TfidfMatcher, type TfidfMatchResult } from "./tfidf-matcher";

export interface SkillMatch {
  skillPath: string;
  skillName: string;
  relevance: number;
  reason: string;
  source: "local" | "remote" | "optional";
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
  private fileContentCache = new Map<string, { content: string; mtime: number }>();
  /**
   * 跟踪每个技能的路径与来源类型（local / optional）。
   * buildCorpus 扫描 bundled + optional + data/skills 三个目录时填充，
   * findAllMatches / scanFileSystem 用它恢复技能的真实路径与来源。
   */
  private skillSourceMap = new Map<string, { path: string; source: "local" | "optional" }>();

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
   * 解析 bundled 技能目录路径（官方内置技能）。
   * 生产环境（dist）：packages/skills/dist → ../bundled = packages/skills/bundled
   * 测试环境（src）：packages/skills/src → ../bundled = packages/skills/bundled
   */
  private resolveBundledDir(): string {
    return path.resolve(__dirname, "..", "bundled");
  }

  /**
   * 解析 optional 技能目录路径（不默认启用的较重/小众技能）。
   * 生产环境（dist）：packages/skills/dist → ../optional = packages/skills/optional
   * 测试环境（src）：packages/skills/src → ../optional = packages/skills/optional
   */
  private resolveOptionalDir(): string {
    return path.resolve(__dirname, "..", "optional");
  }

  /**
   * Build the TF-IDF corpus from all available SKILL.md files locally.
   * Call this on startup and after any skill installation.
   *
   * 扫描三个目录（优先级从高到低）：
   * 1. data/skills（用户安装的技能）— source: "local"
   * 2. packages/skills/bundled（官方内置技能）— source: "local"
   * 3. packages/skills/optional（不默认启用的较重/小众技能）— source: "optional"
   *
   * 同名技能以高优先级目录为准（先扫到者胜），避免重复入语料库。
   */
  buildCorpus(): void {
    const documents: Array<{ id: string; text: string; metadata: Record<string, string> }> = [];
    this.skillSourceMap.clear();
    const seen = new Set<string>();

    // 1. data/skills（用户安装的技能）— 最高优先级
    this.scanDirForCorpus(this.skillsDir, "local", documents, seen);
    // 2. bundled skills（官方内置）
    this.scanDirForCorpus(this.resolveBundledDir(), "local", documents, seen);
    // 3. optional skills（较重/小众，不默认启用）
    this.scanDirForCorpus(this.resolveOptionalDir(), "optional", documents, seen);

    this.tfidfMatcher.initialize(documents);
    this.corpusBuilt = true;
    const optionalCount = Array.from(this.skillSourceMap.values()).filter(v => v.source === "optional").length;
    process.stdout.write(
      `[AutoSkillManager] TF-IDF corpus built with ${documents.length} skills (optional: ${optionalCount})\n`
    );
  }

  /**
   * 扫描单个目录的技能，加入 TF-IDF 文档集合与 skillSourceMap。
   * 同名技能以先扫到者为准（seen 去重）。
   */
  private scanDirForCorpus(
    dir: string,
    source: "local" | "optional",
    documents: Array<{ id: string; text: string; metadata: Record<string, string> }>,
    seen: Set<string>
  ): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (seen.has(entry.name)) continue;

      const skillMdPath = path.join(dir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      try {
        const content = fs.readFileSync(skillMdPath, "utf-8");
        const metadata = this.extractMetadata(skillMdPath, content, entry.name);
        // 标记来源：optional 技能单独标记，便于后续 installOptionalSkill 激活
        metadata.source = source === "optional" ? `optional:${entry.name}` : `local:${entry.name}`;
        documents.push({
          id: entry.name,
          text: this.buildDocumentText(entry.name, content, metadata),
          metadata,
        });
        this.skillSourceMap.set(entry.name, { path: skillMdPath, source });
        seen.add(entry.name);
      } catch {
        continue;
      }
    }
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
        // 从 skillSourceMap 恢复真实路径与来源（local / optional）
        const sourceInfo = this.skillSourceMap.get(r.target);
        const skillMdPath = sourceInfo?.path || path.join(this.skillsDir, r.target, "SKILL.md");
        const source: SkillMatch["source"] = sourceInfo?.source || "local";
        allMatches.push({
          skillPath: skillMdPath,
          skillName: r.target,
          relevance: r.score,
          reason: `语义匹配: ${r.matchedTerms.slice(0, 5).join(", ")}${r.source ? ` — ${r.source}` : ""}`,
          source,
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
      installOptionalSkill(skillName: string): Promise<{ id: string; name: string }>;
    }>("skillManager");

    if (!skillManager) {
      return { installed: false, reason: "技能管理器未就绪", match: bestMatch };
    }

    try {
      // optional 技能需先从 optional/ 复制到 data/skills/ 激活；
      // local 技能直接 installSkill 即可。
      const skill = bestMatch.source === "optional"
        ? await skillManager.installOptionalSkill(bestMatch.skillName)
        : await skillManager.installSkill(bestMatch.skillPath);

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

      process.stdout.write(`[AutoSkillManager] Auto-installed "${skill.name}" for task: "${taskDescription.slice(0, 80)}"\n`);
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
        installOptionalSkill(skillName: string): Promise<{ id: string; name: string }>;
      }>("skillManager");

      if (!skillManager) {
        failed.push({ name, reason: "技能管理器未就绪" });
        continue;
      }

      try {
        // 若技能位于 optional/ 目录，使用 installOptionalSkill 复制激活；
        // 否则直接 installSkill。
        const optionalDir = this.resolveOptionalDir();
        const isOptional = skillPath.startsWith(optionalDir + path.sep) || skillPath === optionalDir;
        const skill = isOptional
          ? await skillManager.installOptionalSkill(name)
          : await skillManager.installSkill(skillPath);
        success.push({
          skillPath,
          skillName: skill.name,
          relevance: 1,
          reason: "用户手动安装",
          source: isOptional ? "optional" : "local",
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
   * 包含 data/skills + bundled + optional 三个目录的技能（去重，高优先级目录优先）。
   */
  listDiscoverableSkills(): Array<{ name: string; path: string; description: string; version: string }> {
    const skills: Array<{ name: string; path: string; description: string; version: string }> = [];
    const seen = new Set<string>();

    const scanDirs = [
      this.skillsDir,
      this.resolveBundledDir(),
      this.resolveOptionalDir(),
    ];

    for (const dir of scanDirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          if (seen.has(entry.name)) continue;
          const skillMdPath = path.join(dir, entry.name, "SKILL.md");
          if (!fs.existsSync(skillMdPath)) continue;

          try {
            const content = fs.readFileSync(skillMdPath, "utf-8");
            const meta = this.extractMetadata(skillMdPath, content, entry.name);
            seen.add(entry.name);
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
    }

    return skills;
  }

  // ── Private helpers ──

  private scanFileSystem(taskDescription: string): SkillMatch[] {
    const matches: SkillMatch[] = [];
    const lowerTask = taskDescription.toLowerCase();

    // LRU 淘汰：超容量时删除最旧条目，而非全量清空（避免周期性性能抖动）
    if (this.fileContentCache.size > 200) {
      const oldestKey = this.fileContentCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.fileContentCache.delete(oldestKey);
      }
    }

    // 扫描三个目录：data/skills + bundled + optional
    // 同名技能以高优先级目录为准（先扫到者胜）
    const scanDirs: Array<{ dir: string; source: "local" | "optional" }> = [
      { dir: this.skillsDir, source: "local" },
      { dir: this.resolveBundledDir(), source: "local" },
      { dir: this.resolveOptionalDir(), source: "optional" },
    ];

    const seen = new Set<string>();
    for (const { dir, source } of scanDirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          if (seen.has(entry.name)) continue;
          const skillMdPath = path.join(dir, entry.name, "SKILL.md");
          if (!fs.existsSync(skillMdPath)) continue;

          let content: string;
          try {
            const stat = fs.statSync(skillMdPath);
            const cached = this.fileContentCache.get(skillMdPath);
            if (cached && cached.mtime === stat.mtimeMs) {
              content = cached.content;
            } else {
              content = fs.readFileSync(skillMdPath, "utf-8");
              this.fileContentCache.set(skillMdPath, { content, mtime: stat.mtimeMs });
            }
          } catch {
            continue;
          }

          const relevance = this.computeKeywordRelevance(lowerTask, content, entry.name);
          if (relevance > 0.05) {
            const metadata = this.extractMetadata(skillMdPath, content, entry.name);
            seen.add(entry.name);
            matches.push({
              skillPath: skillMdPath,
              skillName: entry.name,
              relevance,
              reason: `关键词匹配: ${this.getKeywordMatchReason(lowerTask, content, entry.name)}`,
              source,
              description: metadata.description,
            });
          }
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

    // Keywords match (supports inline array and YAML block list format)
    const kwInline = skillMdContent.match(/keywords?:?\s*\[(.+?)\]/i);
    let kwString = kwInline ? kwInline[1] : "";
    if (!kwString) {
      const kwBlock = skillMdContent.match(/keywords?:\s*\n((?:\s+-\s+.+\n?)+)/i);
      if (kwBlock) {
        kwString = kwBlock[1]
          .split("\n")
          .map((l) => l.replace(/^\s*-\s*/, "").trim())
          .filter(Boolean)
          .join(" ");
      }
    }
    if (kwString) {
      const kws = kwString.match(/[\w\u4e00-\u9fff-]+/g);
      if (kws) {
        for (const kw of kws) {
          if (task.includes(kw.toLowerCase())) score += 2;
        }
      }
    }

    // Normalize: base score of 5 for any match, scale by number of task words
    const taskWordCount = taskWords.length || 1;
    const maxPossible = 8 + 6 + (taskWordCount * 5.5) + taskWordCount + 4;
    return Math.min(score / Math.max(maxPossible * 0.3, 10), 1.0);
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

    const taskWordCount = taskWords.length || 1;
    const maxPossible = 5 + (taskWordCount * 5) + (remote.keywords?.length || 0) * 2;
    return Math.min(score / Math.max(maxPossible * 0.3, 8), 1.0);
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

    // Parse keywords: supports inline array [a, b] and YAML block list format
    const kwInline = content.match(/keywords?:?\s*\[(.+?)\]/i);
    if (kwInline) {
      meta.keywords = kwInline[1];
    } else {
      const kwBlock = content.match(/keywords?:\s*\n((?:\s+-\s+.+\n?)+)/i);
      if (kwBlock) {
        const items = kwBlock[1]
          .split("\n")
          .map((l) => l.replace(/^\s*-\s*/, "").trim())
          .filter(Boolean);
        meta.keywords = items.join(", ");
      }
    }

    meta.source = `local:${dirName}`;

    return meta;
  }

  private buildDocumentText(dirName: string, content: string, _meta: Record<string, string>): string {
    // Combine name, description, keywords, and key sections for TF-IDF
    const parts: string[] = [dirName];

    const descMatch = content.match(/description:\s*(.+)/i);
    if (descMatch) parts.push(descMatch[1]);

    // Parse keywords: supports inline array [a, b] and YAML block list format
    const kwInline = content.match(/keywords?:?\s*\[(.+?)\]/i);
    if (kwInline) {
      parts.push(kwInline[1]);
    } else {
      const kwBlock = content.match(/keywords?:\s*\n((?:\s+-\s+.+\n?)+)/i);
      if (kwBlock) {
        const items = kwBlock[1]
          .split("\n")
          .map((l) => l.replace(/^\s*-\s*/, "").trim())
          .filter(Boolean);
        parts.push(items.join(" "));
      }
    }

    // Extract first few lines of instructions body for context
    const bodyMatch = content.match(/##\s*Instructions?\s*\n+([\s\S]*?)(?=\n##|\n---|$)/i);
    if (bodyMatch) {
      parts.push(bodyMatch[1].slice(0, 300));
    }

    return parts.join("\n");
  }

  private async resolveSkillPath(skillName: string): Promise<string | null> {
    // Check local filesystem first (data/skills)
    const localPath = path.join(this.skillsDir, skillName, "SKILL.md");
    if (fs.existsSync(localPath)) return localPath;

    // Check bundled dir (官方内置技能)
    const bundledPath = path.join(this.resolveBundledDir(), skillName, "SKILL.md");
    if (fs.existsSync(bundledPath)) return bundledPath;

    // Check optional dir (不默认启用的较重/小众技能)
    const optionalPath = path.join(this.resolveOptionalDir(), skillName, "SKILL.md");
    if (fs.existsSync(optionalPath)) return optionalPath;

    // Check case-insensitive across all three dirs
    const searchDirs = [this.skillsDir, this.resolveBundledDir(), this.resolveOptionalDir()];
    for (const dir of searchDirs) {
      if (fs.existsSync(dir)) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.toLowerCase() === skillName.toLowerCase()) {
            const p = path.join(dir, entry.name, "SKILL.md");
            if (fs.existsSync(p)) return p;
          }
        }
      }
    }

    // Check if skill name matches a local directory that might have been installed
    // via SkillManager (installed skills have their path stored)
    try {
      const skillManager = this.registry.resolveService<{
        listSkills(): Promise<Array<{ name: string; installPath: string }>>;
      }>("skillManager");
      if (skillManager) {
        const skills = await skillManager.listSkills();
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
      this.atomicWriteFileSync(skillMdPath, skillMd);

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
      this.atomicWriteFileSync(path.join(skillDir, "_meta.json"), JSON.stringify(meta, null, 2));

      process.stdout.write(`[AutoSkillManager] Generated SKILL.md from curated: ${skillName}\n`);
      return skillMdPath;
    } catch (err) {
      process.stderr.write(`[AutoSkillManager] Failed to generate curated skill "${skillName}": ${err}\n`);
      return null;
    }
  }

  /**
   * 同步原子写入（temp + fsync + rename），避免进程崩溃时 SKILL.md / _meta.json 被截断损坏。
   * 项目硬约束：持久状态写入必须用原子写。
   */
  private atomicWriteFileSync(targetPath: string, content: string): void {
    coreAtomicWriteFileSync(targetPath, content, { encoding: "utf-8" });
  }

  /**
   * Generate SKILL.md content from curated metadata.
   */
  private generateSkillMdFromCurated(curated: { name: string; description: string; keywords: string[]; category: string }): string {
    const lines: string[] = [];
    lines.push("---");
    lines.push(`name: ${curated.name}`);
    lines.push(`version: 0.1.0`);
    lines.push(`description: ${curated.description}`);
    lines.push(`author: evoclaw-curated`);
    lines.push(`license: MIT`);
    lines.push(`category: ${curated.category}`);
    if (curated.keywords.length > 0) {
      lines.push(`keywords:`);
      for (const kw of curated.keywords) {
        lines.push(`  - ${kw}`);
      }
    }
    lines.push("---");
    lines.push("");
    lines.push(`# ${curated.name}`);
    lines.push("");
    lines.push("## Description");
    lines.push("");
    lines.push(curated.description);
    lines.push("");

    const instructions = this.generateInstructions(curated);
    lines.push("## Instructions");
    lines.push("");
    lines.push(instructions);
    lines.push("");

    const examples = this.generateUsageExamples(curated);
    lines.push("## Examples");
    lines.push("");
    lines.push(...examples);
    lines.push("");

    const scripts = this.generateScripts(curated);
    if (scripts.length > 0) {
      lines.push("## Scripts");
      lines.push("");
      lines.push(...scripts);
      lines.push("");
    }

    lines.push("---");
    lines.push(`*Auto-generated from curated registry. Install a full version from ClawHub for enhanced features.*`);

    return lines.join("\n");
  }

  private generateInstructions(curated: { name: string; description: string; keywords: string[]; category: string }): string {
    const name = curated.name;
    switch (name) {
      case "translator":
        return "将用户提供的文本从一种语言翻译成另一种语言。识别源语言和目标语言，保持原文语义和语气。支持中英日韩法德西等主流语言互译。";
      case "calculator":
        return "执行数学计算，包括基本运算（加减乘除）、幂运算、开方、三角函数、对数等。解析用户自然语言描述的数学表达式并返回精确结果。";
      case "file-manager":
        return "管理文件和目录，包括列出目录内容、创建文件/文件夹、读取文件内容、移动/重命名/删除文件。操作路径需在允许范围内。";
      case "reminder":
        return "设置提醒和闹钟。解析用户描述的时间和提醒内容，创建定时提醒任务。支持一次性提醒和重复提醒。";
      case "code-runner":
        return "执行代码片段，支持多种编程语言（Python、JavaScript、TypeScript等）。在安全沙箱中运行代码并返回执行结果。";
      case "web-search":
        return "搜索互联网获取实时信息。根据用户查询返回相关网页结果、摘要和链接。";
      case "email":
        return "发送和查看电子邮件。支持撰写邮件、查看收件箱、搜索邮件等操作。";
      case "crypto-tracker":
        return "追踪加密货币价格和市场数据。查询实时价格、涨跌幅、市值等信息。";
      case "rss-reader":
        return "订阅和管理RSS源，阅读最新文章。支持添加/删除订阅、获取更新。";
      case "http-client":
        return "发起HTTP请求和测试API。支持GET/POST/PUT/DELETE等方法，可设置请求头和请求体。";
      case "markdown-editor":
        return "编辑和预览Markdown文档。支持格式化、插入链接/图片/表格等操作。";
      default:
        return `${curated.description}。根据用户输入执行相应操作并返回结果。`;
    }
  }

  private generateScripts(curated: { name: string }): string[] {
    const name = curated.name;
    switch (name) {
      case "calculator":
        return [
          "```bash",
          "# Evaluate arithmetic expression safely",
          "# Only allows digits, +, -, *, /, (, ), ., and spaces",
          "expr='<EXPRESSION>'",
          "node -e \"const s=process.argv[1];if(!/^[0-9+\\-*/().\\s]+$/.test(s)){process.exit(1)}process.stdout.write(String(Function('return('+s+')')()))\" \"$expr\"",
          "```",
        ];
      case "http-client":
        return [
          "```bash",
          "# HTTP GET request",
          "curl -s '<URL>'",
          "```",
        ];
      default:
        return [];
    }
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