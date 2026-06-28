import {
  type SKILLmdDocument,
  type SKILLmdMeta,
  type OpenClawMetadata,
  type OpenClawSkillMeta,
  type SkillCategory,
  type SkillInstallSpec,
} from "@evoclaw/core";
import matter from "gray-matter";
import { readFile } from "fs/promises";

export class SKILLmdParser {
  async parse(content: string): Promise<SKILLmdDocument> {
    const { data, content: body } = matter(content);

    const openClawMeta = this.parseOpenClawMetadata(data);

    // Extract name: prefer YAML frontmatter name, then first # heading, then default
    let skillName = data.name as string | undefined;
    if (!skillName) {
      const headingMatch = body.match(/^#\s+(.+)$/m);
      skillName = headingMatch ? headingMatch[1].trim() : "unnamed-skill";
    }

    const meta: SKILLmdMeta = {
      name: skillName,
      version: data.version || "1.0.0",
      description: data.description || "",
      author: data.author || "unknown",
      category: data.category && ["automation", "integration", "analysis", "generation", "utility", "custom"].includes(String(data.category))
        ? String(data.category) as SkillCategory
        : undefined,
      keywords: Array.isArray(data.keywords) ? data.keywords.map(String) : undefined,
      license: data.license || undefined,
      triggers: this.parseTriggers(data.triggers),
      requires: this.parseDependencies(data.requires),
      config: data.config || {},
      homepage: openClawMeta?.homepage || data.homepage,
      emoji: openClawMeta?.emoji || data.emoji,
      os: openClawMeta?.os || data.os,
      // OpenClaw compatibility fields
      allowedTools: Array.isArray(data["allowed-tools"]) ? data["allowed-tools"] as string[] : undefined,
      disableModelInvocation: Boolean(data["disable-model-invocation"]),
      userInvocable: data["user-invocable"] !== undefined ? Boolean(data["user-invocable"]) : true,
      commandDispatch: typeof data["command-dispatch"] === "string" ? data["command-dispatch"] : undefined,
      commandTool: typeof data["command-tool"] === "string" ? data["command-tool"] : undefined,
      commandArgMode: typeof data["command-arg-mode"] === "string" ? data["command-arg-mode"] : undefined,
      metadata: openClawMeta
        ? {
            openclaw: openClawMeta,
          }
        : undefined,
    };

    const sections = this.parseSections(body);

    return {
      meta,
      instructions: sections.instructions || "",
      scripts: sections.scripts || {},
      examples: sections.examples || [],
      hooks: sections.hooks || {},
    };
  }

  async parseFromFile(filePath: string): Promise<SKILLmdDocument> {
    const content = await readFile(filePath, "utf-8");
    return this.parse(content);
  }

  private parseOpenClawMetadata(data: Record<string, unknown>): OpenClawSkillMeta | null {
    const metadata = data.metadata as Record<string, unknown> | undefined;
    if (!metadata || typeof metadata !== "object") return null;

    const ocMeta =
      (metadata.openclaw as Record<string, unknown> | undefined) ||
      (metadata.clawdbot as Record<string, unknown> | undefined) ||
      (metadata.clawdis as Record<string, unknown> | undefined);

    if (!ocMeta || typeof ocMeta !== "object") return null;

    const result: OpenClawSkillMeta = {};

    if (ocMeta.requires && typeof ocMeta.requires === "object") {
      const req = ocMeta.requires as Record<string, unknown>;
      if (Array.isArray(req.env)) {
        result.requires = { ...result.requires, env: req.env as string[] };
      }
      if (Array.isArray(req.bins)) {
        result.requires = { ...result.requires, bins: req.bins as string[] };
      }
      if (Array.isArray(req.anyBins)) {
        result.requires = { ...result.requires, anyBins: req.anyBins as string[] };
      }
    }

    if (typeof ocMeta.primaryEnv === "string") {
      result.primaryEnv = ocMeta.primaryEnv;
    }
    if (typeof ocMeta.emoji === "string") {
      result.emoji = ocMeta.emoji;
    }
    if (typeof ocMeta.homepage === "string") {
      result.homepage = ocMeta.homepage;
    }
    if (Array.isArray(ocMeta.os)) {
      result.os = ocMeta.os as string[];
    }
    if (typeof ocMeta.install === "string") {
      result.install = ocMeta.install;
    } else if (Array.isArray(ocMeta.install)) {
      // 解析 frontmatter 中的 `openclaw.install` 数组（对齐 openclaw-main 的
      // `skills/github/SKILL.md` 规范）。原始数据来自 gray-matter，类型未知，
      // 必须先用 `parseInstallSpecs` 缩窄为合法 `SkillInstallSpec[]`。
      const specs = this.parseInstallSpecs(ocMeta.install);
      if (specs.length > 0) {
        result.install = specs;
      }
    }
    if (typeof ocMeta.source === "string") {
      result.source = ocMeta.source;
    }
    if (typeof ocMeta.build === "string") {
      result.build = ocMeta.build;
    }
    if (typeof ocMeta.skillKey === "string") {
      result.skillKey = ocMeta.skillKey;
    }
    if (typeof ocMeta.always === "boolean") {
      result.always = ocMeta.always;
    }
    // Parse requires.config (OpenClaw compatibility)
    if (ocMeta.requires && typeof ocMeta.requires === "object") {
      const req = ocMeta.requires as Record<string, unknown>;
      if (Array.isArray(req.config)) {
        result.requires = { ...result.requires, config: req.config as string[] };
      }
    }

    return result;
  }

  /**
   * 将 frontmatter 中的 `openclaw.install` 原始数组缩窄为 `SkillInstallSpec[]`。
   * 严格拒绝未知字段类型，丢弃明显非法的元素；保留宽松字段以兼容 openclaw-main
   * 历史命名（如 `node`/`go`/`uv`/`download`）。
   */
  private parseInstallSpecs(raw: unknown): SkillInstallSpec[] {
    if (!Array.isArray(raw)) return [];
    const VALID_KINDS = new Set<SkillInstallSpec["kind"]>([
      "brew", "node", "go", "uv", "download", "apt", "pip", "npm", "cargo",
    ]);
    const out: SkillInstallSpec[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const id = typeof obj.id === "string" ? obj.id : undefined;
      const kind = typeof obj.kind === "string" ? obj.kind as SkillInstallSpec["kind"] : undefined;
      if (!id || !kind || !VALID_KINDS.has(kind)) continue;
      const spec: SkillInstallSpec = { id, kind };
      if (typeof obj.label === "string") spec.label = obj.label;
      if (typeof obj.formula === "string") spec.formula = obj.formula;
      if (typeof obj.package === "string") spec.package = obj.package;
      if (typeof obj.module === "string") spec.module = obj.module;
      if (typeof obj.url === "string") spec.url = obj.url;
      if (typeof obj.archive === "string") spec.archive = obj.archive;
      if (typeof obj.targetDir === "string") spec.targetDir = obj.targetDir;
      if (typeof obj.extract === "boolean") spec.extract = obj.extract;
      if (typeof obj.stripComponents === "number" && Number.isFinite(obj.stripComponents)) {
        spec.stripComponents = obj.stripComponents;
      }
      if (Array.isArray(obj.bins)) {
        const bins = obj.bins.filter((b): b is string => typeof b === "string");
        if (bins.length > 0) spec.bins = bins;
      }
      if (Array.isArray(obj.os)) {
        const oses = obj.os.filter((o): o is string => typeof o === "string");
        if (oses.length > 0) spec.os = oses;
      }
      out.push(spec);
    }
    return out;
  }

  private parseTriggers(
    triggers: unknown
  ): SKILLmdMeta["triggers"] {
    if (!Array.isArray(triggers)) return [];

    return triggers.map((t: Record<string, unknown>) => ({
      type: (t.type as "keyword" | "intent" | "schedule" | "event" | "webhook") || "keyword",
      pattern: String(t.pattern || ""),
      description: String(t.description || ""),
    }));
  }

  private parseDependencies(
    requires: unknown
  ): SKILLmdMeta["requires"] {
    if (!Array.isArray(requires)) return [];

    return requires.map((r: unknown) => {
      if (typeof r === "string") {
        return { name: r, version: "*", optional: false };
      }
      const obj = r as Record<string, unknown>;
      return {
        name: String(obj.name || obj.package || ""),
        version: String(obj.version || "*"),
        optional: Boolean(obj.optional),
      };
    });
  }

  private parseSections(body: string): {
    instructions?: string;
    scripts?: Record<string, string>;
    examples?: string[];
    hooks?: Record<string, string>;
  } {
    const result: Record<string, unknown> = {};
    const instructionParts: string[] = [];

    const preamble = this.extractPreamble(body);
    if (preamble.trim()) {
      instructionParts.push(preamble.trim());
    }

    const sectionRegex = /^##\s+(.+)$/gm;
    const sections: { title: string; startIndex: number }[] = [];
    let match: RegExpExecArray | null;

    while ((match = sectionRegex.exec(body)) !== null) {
      sections.push({ title: match[1].trim(), startIndex: match.index });
    }

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const startPos = body.indexOf("\n", section.startIndex) + 1;
      const endPos = i + 1 < sections.length ? sections[i + 1].startIndex : body.length;
      const content = body.slice(startPos, endPos).trim();
      const fullSection = `## ${section.title}\n\n${content}`;

      const key = section.title.toLowerCase();

      if (key.includes("script") || key.includes("code")) {
        result.scripts = result.scripts || {};
        const codeBlocks = this.extractCodeBlocks(content);
        for (const [lang, code] of codeBlocks) {
          (result.scripts as Record<string, string>)[lang || "default"] = code;
        }
        instructionParts.push(fullSection);
      } else if (key.includes("usage") || key.includes("run") || key.includes("execute") || key.includes("command")) {
        result.scripts = result.scripts || {};
        const codeBlocks = this.extractCodeBlocks(content);
        for (const [lang, code] of codeBlocks) {
          const scriptKey = lang || "default";
          if (!(result.scripts as Record<string, string>)[scriptKey]) {
            (result.scripts as Record<string, string>)[scriptKey] = code;
          }
        }
        const shellCommands = this.extractShellCommands(content);
        if (shellCommands.length > 0 && !(result.scripts as Record<string, string>)["default"]) {
          (result.scripts as Record<string, string>)["default"] = shellCommands.join("\n");
        }
        instructionParts.push(fullSection);
      } else if (key.includes("example")) {
        result.examples = result.examples || [];
        (result.examples as string[]).push(content);
        instructionParts.push(fullSection);
      } else if (key.includes("hook")) {
        result.hooks = result.hooks || {};
        const hookBlocks = this.extractCodeBlocks(content);
        for (const [_lang, hookCode] of hookBlocks) {
          (result.hooks as Record<string, string>)["section_" + key] = hookCode;
        }
        instructionParts.push(fullSection);
      } else {
        result[key] = content;
        instructionParts.push(fullSection);
      }
    }

    if (instructionParts.length > 0) {
      result.instructions = instructionParts.join("\n\n");
    }

    return result;
  }

  private extractPreamble(body: string): string {
    const firstSection = body.search(/^##\s+/m);
    if (firstSection === -1) return body;
    return body.slice(0, firstSection).trim();
  }

  private extractShellCommands(content: string): string[] {
    const commands: string[] = [];
    // Match commands like: python3 scripts/search.py '...' or node script.js
    const cmdRegex = /^[#$]\s*(python3?\s+.+|node\s+.+|bash\s+.+|curl\s+.+)/gm;
    let m: RegExpExecArray | null;
    while ((m = cmdRegex.exec(content)) !== null) {
      commands.push(m[1].trim());
    }
    // Also match commands without $ prefix in text
    if (commands.length === 0) {
      const plainCmdRegex = /^(python3?\s+.+|python\s+.+\.py\b)/gm;
      while ((m = plainCmdRegex.exec(content)) !== null) {
        commands.push(m[1].trim());
      }
    }
    return commands;
  }

  private extractCodeBlocks(content: string): [string, string][] {
    const results: [string, string][] = [];
    const regex = /```(\w*)\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;

    while ((m = regex.exec(content)) !== null) {
      results.push([m[1] || "", m[2].trim()]);
    }

    return results;
  }
}