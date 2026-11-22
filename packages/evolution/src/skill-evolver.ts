/**
 * SkillEvolver — FIX / DERIVED / CAPTURED 直接技能演化
 *
 * 借鉴 OpenSpace skill_engine/evolver.py + patch.py + prompts：
 *   - FIX       原地修复（Patch 优先；父版本失活）
 *   - DERIVED   派生增强版本（父版本保留，可多父合并）
 *   - CAPTURED  从无到有捕获新技能（无父）
 *
 * 关键工程细节（与 OpenSpace 对齐）：
 *   - 单次演化最多 3 次应用重试，失败时把错误 + 磁盘当前内容回灌给 LLM
 *   - 用 <EVOLUTION_COMPLETE> / <EVOLUTION_FAILED> 自评令牌
 *   - 补丁应用走「全部校验 → 全部写盘」，路径逃逸拒绝，永不删除文件
 *   - 写入前备份原 SKILL.md；校验失败自动还原
 *   - 记录 .skill_id + LineageStore 血缘；FIX 使父版本失活
 *   - 安装/刷新 SkillManager，并发布 skill.installed 让 SkillIndex 重索引
 */

import fs from "node:fs";
import path from "node:path";
import { EventBus, SystemEvents, atomicWriteFileSync } from "@evoclaw/core";
import {
  LineageStore,
  ensureSkillIdSidecar,
  writeSkillIdSidecar,
  generateSkillId,
  validateSkillDir,
  checkSafety,
  type EvolutionSuggestion,
  type ExecutionAnalysis,
} from "@evoclaw/skills";
import { parseV4APatch, applyHunks } from "@evoclaw/agent";
import type { AnalyzerCompleteFn } from "./execution-analyzer";

// ── 类型 ──────────────────────────────────────────────────────

export interface EvolverSkill {
  id: string;
  name: string;
  description?: string;
  installPath: string;
}

/** 最小 SkillManager 契约（避免与具体实现耦合）。 */
export interface EvolverSkillManager {
  listSkills(): Promise<EvolverSkill[]>;
  installSkill(skillPath: string, force?: boolean): Promise<unknown>;
  getSkill?(id: string): Promise<EvolverSkill | undefined>;
  reloadSkillFromDisk?(idOrPath: string): Promise<unknown>;
}

export interface SkillEvolverOptions {
  /** 技能根目录（新技能写入 <skillsRoot>/evolved） */
  skillsRoot: string;
  /** 数据目录（备份/侧车血缘） */
  dataDir: string;
  /** LLM 单次调用 */
  complete: AnalyzerCompleteFn;
  lineageStore?: LineageStore;
  skillManager?: EvolverSkillManager;
  eventBus?: EventBus;
  /** 单次演化最多应用尝试（默认 3） */
  maxAttempts?: number;
  /** LLM 超时（默认 120s） */
  timeoutMs?: number;
  /** 时钟注入（测试） */
  now?: () => number;
}

export interface EvolveContext {
  /** 触发本次演化的分析（用于失败上下文/指标） */
  analysis?: ExecutionAnalysis;
  /** 质量计数快照 */
  quality?: {
    selections: number;
    applied: number;
    completions: number;
    fallbacks: number;
  };
  /** 任务原始描述（CAPTURED 亮点上下文） */
  taskDescription?: string;
}

export interface EvolvedSkill {
  skillId: string;
  name: string;
  /** SKILL.md 绝对路径 */
  path: string;
  skillDir: string;
  evolutionType: "fix" | "derived" | "captured";
  parentIds: string[];
  changeSummary: string;
}

const COMPLETE_TOKEN = "<EVOLUTION_COMPLETE>";
const FAILED_TOKEN = "<EVOLUTION_FAILED>";
const MAX_SKILL_CHARS = 60_000;
const MAX_AUX_FILE_CHARS = 20_000;
const MAX_AUX_FILES = 8;

// ── 主类 ──────────────────────────────────────────────────────

export class SkillEvolver {
  private readonly skillsRoot: string;
  private readonly dataDir: string;
  private readonly complete: AnalyzerCompleteFn;
  private readonly lineageStore?: LineageStore;
  private skillManager?: EvolverSkillManager;
  private readonly eventBus?: EventBus;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: SkillEvolverOptions) {
    this.skillsRoot = options.skillsRoot;
    this.dataDir = options.dataDir;
    this.complete = options.complete;
    this.lineageStore = options.lineageStore;
    this.skillManager = options.skillManager;
    this.eventBus = options.eventBus;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.now = options.now ?? (() => Date.now());
  }

  setSkillManager(manager: EvolverSkillManager | undefined): void {
    this.skillManager = manager;
  }

  /**
   * 执行一条演化建议。失败返回 null（后台静默，不影响主流程）。
   */
  async evolve(
    suggestion: EvolutionSuggestion,
    context: EvolveContext = {},
  ): Promise<EvolvedSkill | null> {
    try {
      switch (suggestion.type) {
        case "fix":
          return await this.evolveFix(suggestion, context);
        case "derived":
          return await this.evolveNew(suggestion, context, "derived");
        case "captured":
          return await this.evolveNew(suggestion, context, "captured");
        default:
          return null;
      }
    } catch (err) {
      process.stderr.write(
        `[SkillEvolver] ${suggestion.type} failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return null;
    }
  }

  /** 批量执行（调用方负责确认与限流）。 */
  async evolveAll(
    suggestions: EvolutionSuggestion[],
    context: EvolveContext = {},
  ): Promise<EvolvedSkill[]> {
    const results: EvolvedSkill[] = [];
    for (const suggestion of suggestions) {
      const result = await this.evolve(suggestion, context);
      if (result) results.push(result);
    }
    return results;
  }

  // ── FIX ─────────────────────────────────────────────────

  private async evolveFix(
    suggestion: EvolutionSuggestion,
    context: EvolveContext,
  ): Promise<EvolvedSkill | null> {
    const targetId = suggestion.targetSkillIds[0];
    if (!targetId) return null;
    const skill = await this.resolveSkill(targetId);
    if (!skill) {
      process.stderr.write(`[SkillEvolver] fix target not found: ${targetId}\n`);
      return null;
    }

    const skillDir = path.dirname(skill.installPath);
    const skillMdPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) return null;

    const originalContent = fs.readFileSync(skillMdPath, "utf-8");
    const backupPath = this.backupSkill(skill, originalContent);
    const parentId = ensureSkillIdSidecar(skillDir);
    const childId = generateSkillId();
    const failures: string[] = [];

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const currentContent = fs.readFileSync(skillMdPath, "utf-8");
      const prompt = this.buildFixPrompt(suggestion, currentContent, context, failures);
      const output = await this.callLLM(prompt);
      if (!output || output.includes(FAILED_TOKEN)) {
        process.stderr.write(`[SkillEvolver] fix declined by LLM: ${skill.name}\n`);
        return null;
      }

      const summary = extractChangeSummary(output) || suggestion.reason.slice(0, 200);
      const body = stripSummaryLine(output).replace(COMPLETE_TOKEN, "").trim();
      try {
        this.applyFixFiles(skillDir, body);
        const nextContent = fs.readFileSync(skillMdPath, "utf-8");
        if (checkSafety(nextContent).level === "blocked") {
          throw new Error("safety check blocked the evolved SKILL.md");
        }
        const validation = validateSkillDir(skillDir);
        if (validation.errors.length > 0) {
          throw new Error(`validation failed: ${validation.errors.join("; ")}`);
        }
        this.bumpFrontmatterVersion(skillMdPath, skill);
        writeSkillIdSidecar(skillDir, childId);
        this.recordLineage({
          skillId: childId,
          parentIds: [parentId],
          evolutionType: "fix",
          contentSnapshot: nextContent,
          reason: `${suggestion.triggeredBy}: ${summary}`,
          skillName: skill.name,
        });
        await this.refreshSkill(skill);
        this.emitInstalled(skill);
        process.stdout.write(
          `[SkillEvolver] FIX ${skill.name} (attempt ${attempt}/${this.maxAttempts}): ${summary}\n`,
        );
        return {
          skillId: childId,
          name: skill.name,
          path: skillMdPath,
          skillDir,
          evolutionType: "fix",
          parentIds: [parentId],
          changeSummary: summary,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`Attempt ${attempt} failed: ${message}`);
        process.stderr.write(`[SkillEvolver] fix attempt ${attempt} failed for ${skill.name}: ${message}\n`);
        // 还原到本轮开始前内容，避免半改状态影响下一次尝试
        atomicWriteFileSync(skillMdPath, currentContent);
      }
    }

    // 全部失败：原文件保持（最后一次已还原），备份保留可人工回滚
    process.stderr.write(
      `[SkillEvolver] fix abandoned for ${skill.name}; backup at ${backupPath}\n`,
    );
    return null;
  }

  // ── DERIVED / CAPTURED ──────────────────────────────────

  private async evolveNew(
    suggestion: EvolutionSuggestion,
    context: EvolveContext,
    type: "derived" | "captured",
  ): Promise<EvolvedSkill | null> {
    const parents: EvolverSkill[] = [];
    for (const id of suggestion.targetSkillIds) {
      const skill = await this.resolveSkill(id);
      if (skill) parents.push(skill);
    }
    if (type === "derived" && parents.length === 0) return null;

    const parentContents = parents.map((skill) => {
      const md = this.readSkillFiles(path.dirname(skill.installPath));
      return `### Parent: ${skill.name} (${idForSkill(skill)})\n\n${md}`;
    });

    const prompt = this.buildNewPrompt(suggestion, context, type, parentContents);
    const failures: string[] = [];

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const output = await this.callLLM(
        failures.length > 0
          ? `${prompt}\n\n## Previous attempt failed\n${failures.join("\n")}\nFix the problem and output the complete files again.`
          : prompt,
      );
      if (!output || output.includes(FAILED_TOKEN)) return null;

      const summary = extractChangeSummary(output) || suggestion.reason.slice(0, 200);
      const body = stripSummaryLine(output).replace(COMPLETE_TOKEN, "").trim();
      const files = parseFilesBlock(body);
      const skillMd = files.get("SKILL.md") ?? (files.size === 0 ? body : "");
      if (!skillMd || !/^---\s*\n[\s\S]*?\n---/.test(skillMd.trim())) {
        failures.push(`Attempt ${attempt}: output has no valid SKILL.md with YAML frontmatter`);
        continue;
      }

      const name = extractFrontmatterName(skillMd) || slugify(suggestion.reason);
      const childId = generateSkillId();
      const dirName = `${slugify(name)}-${childId.slice(0, 8)}`;
      const skillDir = path.join(this.skillsRoot, "evolved", dirName);
      const skillMdPath = path.join(skillDir, "SKILL.md");

      try {
        fs.mkdirSync(skillDir, { recursive: true });
        atomicWriteFileSync(skillMdPath, ensureTrailingNewline(skillMd));
        for (const [relative, content] of files) {
          if (relative === "SKILL.md") continue;
          if (!isSafeRelative(relative)) throw new Error(`unsafe file path: ${relative}`);
          const full = path.resolve(skillDir, relative);
          if (!full.startsWith(path.resolve(skillDir) + path.sep)) {
            throw new Error(`path escape: ${relative}`);
          }
          fs.mkdirSync(path.dirname(full), { recursive: true });
          atomicWriteFileSync(full, ensureTrailingNewline(content));
        }

        const nextContent = fs.readFileSync(skillMdPath, "utf-8");
        if (checkSafety(nextContent).level === "blocked") {
          throw new Error("safety check blocked the generated SKILL.md");
        }
        const validation = validateSkillDir(skillDir);
        if (validation.errors.length > 0) {
          throw new Error(`validation failed: ${validation.errors.join("; ")}`);
        }

        writeSkillIdSidecar(skillDir, childId);
        const parentIds = parents.map((p) => ensureSkillIdSidecar(path.dirname(p.installPath)));
        this.recordLineage({
          skillId: childId,
          parentIds,
          evolutionType: type,
          contentSnapshot: nextContent,
          reason: `${suggestion.triggeredBy}: ${summary}`,
          skillName: name,
        });

        const installed = await this.skillManager?.installSkill(skillMdPath).catch((err: unknown) => {
          process.stderr.write(
            `[SkillEvolver] install failed for ${name}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          return undefined;
        });
        this.emitInstalled(
          (installed as EvolverSkill | undefined) ?? {
            id: childId,
            name,
            description: extractFrontmatterDescription(nextContent),
            installPath: skillMdPath,
          },
        );

        process.stdout.write(
          `[SkillEvolver] ${type.toUpperCase()} ${name} (attempt ${attempt}/${this.maxAttempts}): ${summary}\n`,
        );
        return {
          skillId: childId,
          name,
          path: skillMdPath,
          skillDir,
          evolutionType: type,
          parentIds,
          changeSummary: summary,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`Attempt ${attempt} failed: ${message}`);
        // 归档失败产物（永不删除），保留现场
        this.archiveFailedAttempt(skillDir, attempt);
      }
    }
    return null;
  }

  // ── Prompt ──────────────────────────────────────────────

  private buildFixPrompt(
    suggestion: EvolutionSuggestion,
    currentContent: string,
    context: EvolveContext,
    failures: string[],
  ): string {
    const failureContext = this.formatFailureContext(context);
    const retry = failures.length > 0
      ? `\n## Previous attempts failed (the file has been restored to the content below)\n${failures.join("\n")}\n`
      : "";
    return `You are a skill editor. Fix an existing skill that is broken, outdated, or incomplete.

A skill is a directory containing SKILL.md plus optional auxiliary files.

## Current SKILL.md
${clip(currentContent, MAX_SKILL_CHARS)}

## What needs fixing
${suggestion.reason || suggestion.proposedChange}

## Execution evidence
${failureContext}
${retry}
## Instructions
1. Identify the root cause in the instructions (wrong parameters, outdated API, missing error handling, etc.).
2. Be surgical. Preserve YAML frontmatter, name and description unless the skill's purpose changed.
3. Prefer a patch. Output format:

CHANGE_SUMMARY: <one sentence>

*** Begin Patch
*** Update File: SKILL.md
@@ -1 +1 @@
 <context line copied verbatim from the file>
-<old line>
+<new line>
*** End Patch

If most of the file changes, output:
CHANGE_SUMMARY: <one sentence>

*** Begin Files
*** File: SKILL.md
<complete content>
*** End Files

Do NOT wrap output in markdown fences. End with ${COMPLETE_TOKEN} on the last line when satisfied.
If no satisfactory fix is possible, output ONLY:
${FAILED_TOKEN}
Reason: <brief reason>`;
  }

  private buildNewPrompt(
    suggestion: EvolutionSuggestion,
    context: EvolveContext,
    type: "derived" | "captured",
    parentContents: string[],
  ): string {
    const category = suggestion.category || "workflow";
    const highlights = this.formatFailureContext(context);
    const parentSection = parentContents.length > 0
      ? `## Parent skill(s)\n\n${parentContents.join("\n\n---\n\n")}`
      : "";
    const namingRule = type === "derived"
      ? "The new skill MUST have a different, descriptive name (lowercase, hyphens, ≤50 chars). Do not append -enhanced/-merged."
      : "Choose a concise descriptive name (lowercase, hyphens, ≤50 chars).";
    return `You are a skill author. Create a ${type.toUpperCase()} skill.

A skill is a directory containing SKILL.md with YAML frontmatter (name, description) plus optional files.

## Enhancement direction
${suggestion.reason || suggestion.proposedChange}

## Category
${category}

## Execution evidence
${highlights}

${parentSection}

## Instructions
1. Write a reusable CLASS-LEVEL skill, not a one-off task narrative.
2. ${namingRule}
3. Include concrete steps, parameters, pitfalls, and verification guidance.
4. Output format:

CHANGE_SUMMARY: <one sentence>

*** Begin Files
*** File: SKILL.md
<complete SKILL.md content with --- frontmatter --->
*** File: references/example.md   (optional)
<content>
*** End Files

Do NOT wrap output in markdown fences. End with ${COMPLETE_TOKEN} on the last line when satisfied.
If no reusable skill is warranted, output ONLY:
${FAILED_TOKEN}
Reason: <brief reason>`;
  }

  private formatFailureContext(context: EvolveContext): string {
    const lines: string[] = [];
    const analysis = context.analysis;
    if (analysis) {
      if (analysis.executionNote) lines.push(`Execution note: ${analysis.executionNote}`);
      const judgments = analysis.skillJudgments ?? [];
      for (const j of judgments.slice(-6)) {
        lines.push(
          `- ${j.skillName || j.skillId}: applied=${j.skillApplied}${j.note ? ` — ${j.note}` : ""}`,
        );
      }
      for (const issue of analysis.toolIssues.slice(0, 6)) {
        lines.push(`- tool issue ${issue.toolKey}: ${issue.description}`);
      }
    }
    if (context.quality) {
      const q = context.quality;
      lines.push(
        `Health metrics: selections=${q.selections}, applied=${q.applied}, completions=${q.completions}, fallbacks=${q.fallbacks}`,
      );
    }
    if (context.taskDescription) {
      lines.push(`Observed task: ${context.taskDescription.slice(0, 800)}`);
    }
    return lines.length > 0 ? lines.join("\n") : "(no prior execution evidence)";
  }

  // ── 应用 ────────────────────────────────────────────────

  private applyFixFiles(skillDir: string, body: string): void {
    const patchText = extractPatchSection(body);
    if (patchText) {
      const parsed = parseV4APatch(patchText);
      if (!parsed.success) throw new Error(`patch parse failed: ${parsed.error}`);
      const planned = new Map<string, string>();
      for (const op of parsed.operations) {
        if (op.type === "delete" || op.type === "move") {
          throw new Error(`operation ${op.type} is not allowed in skill evolution`);
        }
        const relative = op.path || "";
        if (!isSafeRelative(relative)) throw new Error(`unsafe file path: ${relative}`);
        const full = path.resolve(skillDir, relative);
        if (!full.startsWith(path.resolve(skillDir) + path.sep)) {
          throw new Error(`path escape: ${relative}`);
        }
        if (op.type === "add") {
          planned.set(full, op.addContent ?? "");
          continue;
        }
        const current = planned.get(full) ?? fs.readFileSync(full, "utf-8");
        const next = applyHunks(current, op.hunks ?? []);
        if (next === current) throw new Error(`update ${relative} produced no change`);
        planned.set(full, next);
      }
      for (const [full, content] of planned) {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        atomicWriteFileSync(full, ensureTrailingNewline(content));
      }
      return;
    }

    const files = parseFilesBlock(body);
    if (files.size > 0) {
      for (const [relative, content] of files) {
        if (!isSafeRelative(relative)) throw new Error(`unsafe file path: ${relative}`);
        const full = path.resolve(skillDir, relative);
        if (!full.startsWith(path.resolve(skillDir) + path.sep)) {
          throw new Error(`path escape: ${relative}`);
        }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        atomicWriteFileSync(full, ensureTrailingNewline(content));
      }
      return;
    }

    // 无补丁/文件块 → 视为 SKILL.md 全量重写
    if (!/^---\s*\n[\s\S]*?\n---/.test(body.trim())) {
      throw new Error("LLM output contains neither a patch nor a valid SKILL.md");
    }
    atomicWriteFileSync(path.join(skillDir, "SKILL.md"), ensureTrailingNewline(body));
  }

  private readSkillFiles(skillDir: string): string {
    const parts: string[] = [];
    const skillMd = path.join(skillDir, "SKILL.md");
    if (fs.existsSync(skillMd)) {
      parts.push(clip(fs.readFileSync(skillMd, "utf-8"), MAX_SKILL_CHARS));
    }
    const aux: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (aux.length >= MAX_AUX_FILES) return;
        if (entry.name === "SKILL.md" || entry.name === ".skill_id" || entry.name === "_meta.json") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          walk(full);
        } else if (/\.(md|txt|json|ya?ml|sh|py|js|ts)$/i.test(entry.name)) {
          try {
            aux.push(`*** File: ${path.relative(skillDir, full)}\n${clip(fs.readFileSync(full, "utf-8"), MAX_AUX_FILE_CHARS)}`);
          } catch { /* ignore unreadable */ }
        }
      }
    };
    if (fs.existsSync(skillDir)) walk(skillDir);
    if (aux.length > 0) parts.push(aux.join("\n\n"));
    return parts.join("\n\n");
  }

  // ── 持久化/血缘 ─────────────────────────────────────────

  private backupSkill(skill: EvolverSkill, content: string): string {
    const dir = path.join(this.dataDir, "skill-curator", "evolver-backups", sanitize(skill.name));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${this.now()}-SKILL.md`);
    atomicWriteFileSync(file, content);
    return file;
  }

  private archiveFailedAttempt(skillDir: string, attempt: number): void {
    try {
      if (!fs.existsSync(skillDir)) return;
      const archive = path.join(
        this.dataDir,
        "skill-curator",
        "evolver-failed",
        `${path.basename(skillDir)}-${this.now()}-${attempt}`,
      );
      fs.cpSync(skillDir, archive, { recursive: true });
    } catch { /* best-effort */ }
  }

  private recordLineage(input: {
    skillId: string;
    parentIds: string[];
    evolutionType: "fix" | "derived" | "captured";
    contentSnapshot: string;
    reason: string;
    skillName: string;
  }): void {
    if (!this.lineageStore) return;
    try {
      if (this.lineageStore.getLineage(input.skillId)) return;
      this.lineageStore.addLineage(
        {
          skillId: input.skillId,
          parentIds: input.parentIds,
          evolutionType: input.evolutionType,
          contentSnapshot: input.contentSnapshot.slice(0, 200_000),
          evolvedAt: this.now(),
          reason: input.reason.slice(0, 500),
          isActive: true,
        },
        input.skillName,
      );
    } catch (err) {
      process.stderr.write(
        `[SkillEvolver] lineage record failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  private async refreshSkill(skill: EvolverSkill): Promise<void> {
    if (!this.skillManager?.reloadSkillFromDisk) return;
    try {
      await this.skillManager.reloadSkillFromDisk(skill.installPath);
    } catch { /* best-effort */ }
  }

  private emitInstalled(skill: EvolverSkill): void {
    if (!this.eventBus) return;
    void this.eventBus
      .publish(
        SystemEvents.SKILL_INSTALLED,
        {
          id: skill.id,
          name: skill.name,
          description: skill.description ?? "",
          installPath: skill.installPath,
        },
        "skill-evolver",
      )
      .catch(() => {});
  }

  private bumpFrontmatterVersion(skillMdPath: string, skill: EvolverSkill): void {
    try {
      let content = fs.readFileSync(skillMdPath, "utf-8");
      const match = /^---[\s\S]*?version:\s*([0-9]+\.[0-9]+\.[0-9]+)[\s\S]*?---/m.exec(content);
      if (!match) return;
      const [major, minor, patch] = match[1].split(".").map((n) => Number(n));
      const next = `${major}.${minor}.${patch + 1}`;
      content = content.replace(
        /^(---[\s\S]*?version:\s*).+$/m,
        (_m, p1: string) => `${p1}${next}`,
      );
      atomicWriteFileSync(skillMdPath, content);
      const metaPath = path.join(path.dirname(skillMdPath), "_meta.json");
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          meta.version = next;
          atomicWriteFileSync(metaPath, JSON.stringify(meta, null, 2));
        } catch { /* ignore */ }
      }
    } catch { /* version bump is best-effort */ }
  }

  private async resolveSkill(idOrName: string): Promise<EvolverSkill | null> {
    if (!this.skillManager) return null;
    try {
      const skills = await this.skillManager.listSkills();
      for (const skill of skills) {
        if (skill.id === idOrName || skill.name === idOrName) return skill;
      }
      for (const skill of skills) {
        const dir = path.dirname(skill.installPath);
        try {
          if (ensureSkillIdSidecar(dir) === idOrName) return skill;
        } catch { /* ignore */ }
      }
      return null;
    } catch {
      return null;
    }
  }

  // ── LLM ─────────────────────────────────────────────────

  private async callLLM(prompt: string): Promise<string | null> {
    try {
      return await withDeadline(
        this.complete({
          systemPrompt:
            "You are a meticulous skill editor. Follow the requested output format exactly. Never wrap output in markdown fences.",
          prompt,
          maxTokens: 4096,
          deadlineMs: this.timeoutMs,
        }),
        this.timeoutMs,
      );
    } catch (err) {
      process.stderr.write(
        `[SkillEvolver] LLM call failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return null;
    }
  }
}

// ── 解析工具 ──────────────────────────────────────────────────

export function extractChangeSummary(text: string): string | null {
  const match = /^\s*CHANGE_SUMMARY:\s*(.+)$/m.exec(text);
  if (!match) return null;
  return match[1].replace(/[*_]+$/g, "").trim().slice(0, 500);
}

function stripSummaryLine(text: string): string {
  return text.replace(/^\s*CHANGE_SUMMARY:.*$/m, "").trim();
}

export function parseFilesBlock(text: string): Map<string, string> {
  const files = new Map<string, string>();
  const start = text.indexOf("*** Begin Files");
  const end = text.indexOf("*** End Files", start >= 0 ? start : 0);
  if (start < 0 || end < 0) return files;
  const body = text.slice(start + "*** Begin Files".length, end);
  const lines = body.split("\n");
  let currentPath: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (currentPath) {
      files.set(
        currentPath,
        buffer.join("\n").replace(/^\n+/, "").replace(/\n+$/, ""),
      );
    }
    currentPath = null;
    buffer = [];
  };
  for (const line of lines) {
    const match = /^\*\*\* File:\s*(.+)$/.exec(line);
    if (match) {
      flush();
      currentPath = match[1].trim();
    } else if (currentPath) {
      buffer.push(line);
    }
  }
  flush();
  return files;
}

function extractPatchSection(text: string): string | null {
  const start = text.indexOf("*** Begin Patch");
  if (start < 0) return null;
  const end = text.indexOf("*** End Patch", start);
  if (end < 0) return null;
  return text.slice(start, end + "*** End Patch".length);
}

function extractFrontmatterName(content: string): string | null {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!match) return null;
  const name = /^\s*name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(match[1]);
  return name ? name[1].trim() : null;
}

function extractFrontmatterDescription(content: string): string {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!match) return "";
  const desc = /^\s*description:\s*["']?([^"'\n]+)["']?\s*$/m.exec(match[1]);
  return desc ? desc[1].trim() : "";
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return slug || "evolved-skill";
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "skill";
}

function idForSkill(skill: EvolverSkill): string {
  try {
    return ensureSkillIdSidecar(path.dirname(skill.installPath));
  } catch {
    return skill.name;
  }
}

function isSafeRelative(relative: string): boolean {
  if (!relative || relative === "." || relative === "..") return false;
  if (path.isAbsolute(relative)) return false;
  const normalized = path.normalize(relative);
  return !normalized.startsWith("..") && !normalized.includes(`..${path.sep}`);
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function clip(content: string, max: number): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max)}\n...(truncated)`;
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`evolution LLM timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
