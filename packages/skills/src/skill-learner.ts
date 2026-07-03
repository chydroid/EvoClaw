/**
 * SkillLearner — 从目录/URL/最近工作流自动生成 SKILL.md。
 *
 * 对标 Hermes v0.18.0 "/learn 命令"：
 * - /learn ~/projects/deploy-scripts     → 把目录变成技能
 * - /learn https://github.com/example/wf → 把 URL 里的工作流变成技能
 * - /learn 刚才我配置 CI 的步骤          → 把刚走完的流程变成技能
 *
 * 执行后自动提炼成一个标准的 SKILL.md，放到 skills 目录。
 * 下次再用，直接加载即可。不用手动开编辑器写 frontmatter 了。
 *
 * 设计原则：
 * 1. 多源接入 —— 支持本地目录、URL、最近对话历史三种来源
 * 2. 自动提炼 —— 从原始素材中提取名称、描述、关键词、步骤
 * 3. 标准格式 —— 输出符合 EvoClaw SKILL.md frontmatter 规范
 * 4. 幂等安全 —— 同名技能不覆盖，追加版本号
 *
 * 用法：
 * ```ts
 * const learner = new SkillLearner(skillsDir);
 * await learner.learnFromDirectory("~/projects/deploy-scripts", "deploy-scripts");
 * await learner.learnFromUrl("https://github.com/example/workflow", "github-workflow");
 * await learner.learnFromConversation(history, "ci-config");
 * ```
 */

import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { exec as execCallback } from "child_process";

const execAsync = promisify(execCallback);

// ── Types ─────────────────────────────────────────────────

/** 学习来源类型 */
export type LearnSource = "directory" | "url" | "conversation";

/** 学习结果 */
export interface LearnResult {
  /** 技能名称 */
  skillName: string;
  /** SKILL.md 文件路径 */
  skillPath: string;
  /** 来源类型 */
  source: LearnSource;
  /** 来源描述 */
  sourceDescription: string;
  /** 生成的 SKILL.md 内容 */
  content: string;
  /** 是否成功 */
  success: boolean;
  /** 错误信息（失败时） */
  error?: string;
}

/** 对话历史条目（用于从工作流学习） */
export interface ConversationEntry {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
}

/** Skill 元数据 */
export interface SkillMetadata {
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  category: string;
  keywords: string[];
}

// ── SkillLearner ──────────────────────────────────────────

/**
 * SkillLearner —— 自动技能生成器。
 *
 * 从目录、URL 或对话历史中提炼工作流，生成标准 SKILL.md。
 */
export class SkillLearner {
  constructor(
    private skillsDir: string,
    private options?: {
      /** 默认作者名 */
      defaultAuthor?: string;
      /** 默认许可证 */
      defaultLicense?: string;
      /** URL 抓取超时（ms） */
      urlFetchTimeoutMs?: number;
    },
  ) {
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }
  }

  /**
   * 从本地目录学习 —— 扫描目录中的关键文件，提炼为技能。
   *
   * 会读取：README.md / *.sh / *.py / *.js / *.ts / Makefile / docker-compose.yml / package.json
   */
  async learnFromDirectory(dirPath: string, skillName?: string): Promise<LearnResult> {
    const resolvedPath = path.resolve(dirPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || "~"));
    if (!fs.existsSync(resolvedPath)) {
      return {
        skillName: skillName ?? path.basename(resolvedPath),
        skillPath: "",
        source: "directory",
        sourceDescription: resolvedPath,
        content: "",
        success: false,
        error: `Directory not found: ${resolvedPath}`,
      };
    }

    const name = skillName ?? path.basename(resolvedPath);
    const files = this.scanDirectory(resolvedPath);
    const fileContents = files.slice(0, 20).map((f) => {
      try {
        const content = fs.readFileSync(f, "utf-8");
        return { path: path.relative(resolvedPath, f), content: content.slice(0, 5000) };
      } catch {
        return null;
      }
    }).filter((f): f is { path: string; content: string } => f !== null);

    const description = this.extractDescriptionFromFiles(fileContents, name);
    const keywords = this.extractKeywordsFromFiles(fileContents);
    const steps = this.extractStepsFromFiles(fileContents);

    const content = this.generateSkillMd({
      name,
      version: "0.1.0",
      description,
      author: this.options?.defaultAuthor ?? "evoclaw-learn",
      license: this.options?.defaultLicense ?? "MIT",
      category: "learned",
      keywords,
    }, steps, fileContents);

    return await this.saveSkill(name, content, "directory", resolvedPath);
  }

  /**
   * 从 URL 学习 —— 抓取 URL 内容（GitHub README / 文档页面），提炼为技能。
   */
  async learnFromUrl(url: string, skillName?: string): Promise<LearnResult> {
    const timeoutMs = this.options?.urlFetchTimeoutMs ?? 30000;
    const name = skillName ?? this.extractNameFromUrl(url);

    let urlContent = "";
    try {
      // GitHub URL 特殊处理：raw README
      const rawUrl = this.githubToRawUrl(url);
      const response = await fetch(rawUrl, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": "EvoClaw-SkillLearner/1.0" },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      urlContent = await response.text();
    } catch (err) {
      return {
        skillName: name,
        skillPath: "",
        source: "url",
        sourceDescription: url,
        content: "",
        success: false,
        error: `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const description = this.extractDescriptionFromText(urlContent, name);
    const keywords = this.extractKeywordsFromText(urlContent);
    const steps = this.extractStepsFromText(urlContent);

    const content = this.generateSkillMd({
      name,
      version: "0.1.0",
      description,
      author: this.options?.defaultAuthor ?? "evoclaw-learn",
      license: this.options?.defaultLicense ?? "MIT",
      category: "learned",
      keywords,
    }, steps, [{ path: "source.md", content: urlContent.slice(0, 10000) }]);

    return await this.saveSkill(name, content, "url", url);
  }

  /**
   * 从对话历史学习 —— 把刚走完的工作流提炼为技能。
   */
  async learnFromConversation(
    history: ConversationEntry[],
    skillName: string,
  ): Promise<LearnResult> {
    if (history.length === 0) {
      return {
        skillName,
        skillPath: "",
        source: "conversation",
        sourceDescription: "empty conversation",
        content: "",
        success: false,
        error: "Conversation history is empty",
      };
    }

    // 提取用户请求和工具调用
    const userMessages = history
      .filter((h) => h.role === "user")
      .map((h) => h.content)
      .join("\n");
    const toolCalls = history
      .filter((h) => h.role === "tool" && h.toolName)
      .map((h) => `[${h.toolName}] ${h.content.slice(0, 500)}`);

    const description = this.extractDescriptionFromText(userMessages, skillName);
    const keywords = this.extractKeywordsFromText(userMessages + " " + toolCalls.join(" "));
    const steps = this.extractStepsFromConversation(history);

    const content = this.generateSkillMd({
      name: skillName,
      version: "0.1.0",
      description,
      author: this.options?.defaultAuthor ?? "evoclaw-learn",
      license: this.options?.defaultLicense ?? "MIT",
      category: "learned",
      keywords,
    }, steps, [{ path: "conversation.md", content: `# User Request\n${userMessages}\n\n# Tool Calls\n${toolCalls.join("\n\n")}`.slice(0, 10000) }]);

    return await this.saveSkill(skillName, content, "conversation", `${history.length} messages`);
  }

  // ── Internal: 文件扫描 ─────────────────────────────────

  /** 扫描目录，返回关键文件路径列表 */
  private scanDirectory(dirPath: string): string[] {
    const keyFiles: string[] = [];
    const keyExtensions = [".md", ".sh", ".py", ".js", ".ts", ".yml", ".yaml", ".json"];
    const keyFilenames = ["README", "Makefile", "Dockerfile", "docker-compose", "package.json", ".env.example"];

    const walk = (dir: string, depth: number) => {
      if (depth > 3) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const basename = path.basename(entry.name, ext);
          if (keyExtensions.includes(ext) || keyFilenames.some((k) => entry.name.toLowerCase().includes(k.toLowerCase()))) {
            keyFiles.push(fullPath);
          }
        }
      }
    };

    walk(dirPath, 0);
    return keyFiles.sort((a, b) => {
      // README 优先
      const aName = path.basename(a).toLowerCase();
      const bName = path.basename(b).toLowerCase();
      if (aName.includes("readme") && !bName.includes("readme")) return -1;
      if (!aName.includes("readme") && bName.includes("readme")) return 1;
      return a.localeCompare(b);
    });
  }

  // ── Internal: 内容提炼 ─────────────────────────────────

  /** 从文件列表中提取描述 */
  private extractDescriptionFromFiles(
    files: Array<{ path: string; content: string }>,
    fallbackName: string,
  ): string {
    // 优先从 README 提取第一段
    const readme = files.find((f) => f.path.toLowerCase().includes("readme"));
    if (readme) {
      const firstPara = readme.content
        .split(/\n\s*\n/)[0]
        ?.replace(/^#+\s*/, "")
        .trim();
      if (firstPara && firstPara.length > 10) {
        return firstPara.slice(0, 300);
      }
    }
    // 其次从 package.json 提取
    const pkg = files.find((f) => f.path.includes("package.json"));
    if (pkg) {
      try {
        const parsed = JSON.parse(pkg.content);
        if (parsed.description) return String(parsed.description).slice(0, 300);
      } catch { /* ignore */ }
    }
    return `Auto-learned skill from ${fallbackName}`;
  }

  /** 从文本中提取描述 */
  private extractDescriptionFromText(text: string, fallbackName: string): string {
    const firstPara = text
      .split(/\n\s*\n/)[0]
      ?.replace(/^#+\s*/, "")
      .replace(/```[\s\S]*?```/g, "")
      .trim();
    if (firstPara && firstPara.length > 10) {
      return firstPara.slice(0, 300);
    }
    return `Auto-learned skill from ${fallbackName}`;
  }

  /** 从文件列表中提取关键词 */
  private extractKeywordsFromFiles(files: Array<{ path: string; content: string }>): string[] {
    const text = files.map((f) => f.content).join(" ");
    return this.extractKeywordsFromText(text);
  }

  /** 从文本中提取关键词（简单 TF 提取） */
  private extractKeywordsFromText(text: string): string[] {
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "must", "can", "this", "that", "these",
      "those", "i", "you", "he", "she", "it", "we", "they", "and", "or",
      "but", "in", "on", "at", "to", "for", "of", "with", "by", "from",
      "as", "into", "through", "during", "before", "after", "above",
      "below", "up", "down", "out", "off", "over", "under", "again",
      "then", "once", "here", "there", "when", "where", "why", "how",
      "all", "each", "every", "both", "few", "more", "most", "other",
      "some", "such", "no", "nor", "not", "only", "own", "same", "so",
      "than", "too", "very", "s", "t", "just", "don", "now", "if",
      "about", "what", "which", "who", "whom", "them", "his", "her",
      "its", "their", "our", "your", "my", "me", "him", "us",
      "et", "al", "fig", "ref", "etc", "via", "per", "using", "use",
      "used", "using", "one", "two", "also", "get", "set", "new",
    ]);

    const wordFreq = new Map<string, number>();
    const words = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,30}/g) ?? [];
    for (const word of words) {
      if (stopWords.has(word) || word.length < 3) continue;
      wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
    }

    return Array.from(wordFreq.entries())
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }

  /** 从文件列表中提取步骤 */
  private extractStepsFromFiles(files: Array<{ path: string; content: string }>): string[] {
    const steps: string[] = [];
    for (const file of files) {
      // 从 shell 脚本提取命令
      if (file.path.endsWith(".sh")) {
        const commands = file.content
          .split("\n")
          .filter((line) => line.trim() && !line.trim().startsWith("#"))
          .map((line) => line.trim())
          .slice(0, 10);
        steps.push(...commands.map((cmd) => `Run: \`${cmd}\``));
      }
      // 从 Makefile 提取目标
      if (file.path.toLowerCase().includes("makefile")) {
        const targets = file.content
          .split("\n")
          .filter((line) => /^[a-zA-Z_-]+:/.test(line))
          .map((line) => line.split(":")[0].trim())
          .slice(0, 10);
        steps.push(...targets.map((t) => `Run: \`make ${t}\``));
      }
    }
    return steps.slice(0, 15);
  }

  /** 从文本中提取步骤 */
  private extractStepsFromText(text: string): string[] {
    const steps: string[] = [];
    // 匹配 numbered list (1. xxx) 或 - xxx 或 * xxx
    const stepPatterns = [
      /^\d+\.\s+(.+)$/gm,
      /^[-*]\s+(.+)$/gm,
    ];
    for (const pattern of stepPatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        if (match[1] && match[1].length > 5 && match[1].length < 200) {
          steps.push(match[1].trim());
        }
      }
    }
    return steps.slice(0, 15);
  }

  /** 从对话历史中提取步骤 */
  private extractStepsFromConversation(history: ConversationEntry[]): string[] {
    const steps: string[] = [];
    for (const entry of history) {
      if (entry.role === "tool" && entry.toolName) {
        const summary = entry.content.slice(0, 200).replace(/\n/g, " ").trim();
        steps.push(`Tool \`${entry.toolName}\`: ${summary}`);
      }
    }
    return steps.slice(0, 15);
  }

  // ── Internal: SKILL.md 生成 ────────────────────────────

  /** 生成标准 SKILL.md 内容 */
  private generateSkillMd(
    meta: SkillMetadata,
    steps: string[],
    sourceFiles: Array<{ path: string; content: string }>,
  ): string {
    const lines: string[] = [];
    // Frontmatter
    lines.push("---");
    lines.push(`name: ${meta.name}`);
    lines.push(`version: ${meta.version}`);
    lines.push(`description: ${meta.description}`);
    lines.push(`author: ${meta.author}`);
    lines.push(`license: ${meta.license}`);
    lines.push(`category: ${meta.category}`);
    if (meta.keywords.length > 0) {
      lines.push("keywords:");
      for (const kw of meta.keywords) {
        lines.push(`  - ${kw}`);
      }
    }
    lines.push("---");
    lines.push("");

    // Title
    lines.push(`# ${meta.name}`);
    lines.push("");
    lines.push("## Description");
    lines.push("");
    lines.push(meta.description);
    lines.push("");

    // Instructions / Steps
    lines.push("## Instructions");
    lines.push("");
    if (steps.length > 0) {
      for (let i = 0; i < steps.length; i++) {
        lines.push(`${i + 1}. ${steps[i]}`);
      }
    } else {
      lines.push("Follow the examples below to complete the task.");
    }
    lines.push("");

    // Examples (source content excerpts)
    lines.push("## Examples");
    lines.push("");
    for (const file of sourceFiles.slice(0, 3)) {
      lines.push(`### ${file.path}`);
      lines.push("```");
      lines.push(file.content.slice(0, 2000));
      lines.push("```");
      lines.push("");
    }

    return lines.join("\n");
  }

  // ── Internal: 辅助方法 ─────────────────────────────────

  /** 保存技能到文件系统 */
  private async saveSkill(
    name: string,
    content: string,
    source: LearnSource,
    sourceDescription: string,
  ): Promise<LearnResult> {
    try {
      const skillDir = path.join(this.skillsDir, name);
      // 幂等：如果已存在，追加版本号
      let finalDir = skillDir;
      let counter = 2;
      while (fs.existsSync(finalDir)) {
        finalDir = `${skillDir}-v${counter}`;
        counter++;
      }
      fs.mkdirSync(finalDir, { recursive: true });
      const skillPath = path.join(finalDir, "SKILL.md");
      fs.writeFileSync(skillPath, content, "utf-8");

      // 生成 _meta.json
      const meta = {
        name,
        version: "0.1.0",
        description: content.match(/description:\s*(.+)/)?.[1] ?? "",
        category: "learned",
        keywords: [],
        author: this.options?.defaultAuthor ?? "evoclaw-learn",
        license: this.options?.defaultLicense ?? "MIT",
        source,
        sourceDescription,
        learnedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(finalDir, "_meta.json"), JSON.stringify(meta, null, 2), "utf-8");

      return {
        skillName: name,
        skillPath,
        source,
        sourceDescription,
        content,
        success: true,
      };
    } catch (err) {
      return {
        skillName: name,
        skillPath: "",
        source,
        sourceDescription,
        content,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 从 URL 中提取技能名称 */
  private extractNameFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length >= 2) {
        // GitHub: /owner/repo → repo name
        return segments[segments.length - 1].replace(/\.git$/, "");
      }
      return parsed.hostname.replace(/^www\./, "");
    } catch {
      return "learned-skill";
    }
  }

  /** GitHub URL 转 raw URL */
  private githubToRawUrl(url: string): string {
    // https://github.com/owner/repo → https://raw.githubusercontent.com/owner/repo/main/README.md
    const githubMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/);
    if (githubMatch) {
      return `https://raw.githubusercontent.com/${githubMatch[1]}/${githubMatch[2]}/main/README.md`;
    }
    // https://github.com/owner/repo/blob/branch/path → https://raw.githubusercontent.com/owner/repo/branch/path
    const blobMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (blobMatch) {
      return `https://raw.githubusercontent.com/${blobMatch[1]}/${blobMatch[2]}/${blobMatch[3]}`;
    }
    return url;
  }
}
