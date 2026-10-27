/**
 * EvolutionApplier — 进化产物落地器
 *
 * 修复进化闭环的"应用层断裂"：
 *   - HotReloadManager.publish() 此前只往 EventBus 发 `evolution.hotreload`
 *     事件，全仓库无消费者，进化代码从未被应用。
 *   - 本类作为该事件（及 EVOLUTION_PUBLISHED）的真实消费者，
 *     把通过评估 + 沙箱验证的候选真正落地：
 *
 *       new_skill     → 生成 SKILL.md 并 installSkill 注册
 *       skill_update  → 追加 Evolution Patch 段落到目标技能 SKILL.md（原子写）
 *       code_patch    → 有目标技能时同上；无目标时归档产物 + manifest 待审查
 *       config_change → 写入 config-pending 目录，人工审查后才可应用
 *
 *   - 应用前自动备份原 SKILL.md（backups/<skillId>/），支持 rollback 恢复。
 *   - 遵循 AGENTS.md：永不删除，只追加/归档。
 */

import {
  ServiceRegistry,
  EventBus,
  atomicWriteFileSync,
  type EvolutionCandidate,
  type EvolutionCycle,
  type HotReloadEvent,
  type Skill,
} from "@evoclaw/core";
import * as fs from "fs";
import * as path from "path";
import { SkillAutoGenerator } from "./skill-auto-generator";

export interface ApplyResult {
  applied: boolean;
  mode: "installed" | "skill_updated" | "archived" | "config_pending" | "rollback" | "skipped" | "failed";
  target: string | null;
  detail: string;
}

export class EvolutionApplier {
  private archiveDir: string;
  private backupDir: string;
  private configPendingDir: string;
  private autoGenerator: SkillAutoGenerator;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    storeDir: string,
    autoGenerator?: SkillAutoGenerator
  ) {
    this.archiveDir = path.join(storeDir, "applied");
    this.backupDir = path.join(storeDir, "backups");
    this.configPendingDir = path.join(storeDir, "config-pending");
    // 默认输出到 data/skills/auto-generated（与技能目录布局一致）；测试可注入临时目录
    this.autoGenerator = autoGenerator ?? new SkillAutoGenerator();
  }

  /**
   * 落地一个通过评估 + 沙箱验证的进化候选。
   * 由 EvolutionEngine 在 EVOLUTION_PUBLISHED 订阅中调用。
   */
  async applyCandidate(cycle: EvolutionCycle, candidate: EvolutionCandidate): Promise<ApplyResult> {
    try {
      switch (candidate.type) {
        case "new_skill":
          return await this.applyNewSkill(cycle, candidate);
        case "skill_update":
        case "code_patch": {
          const skillId = this.resolveTargetSkillId(cycle);
          if (skillId) {
            return await this.applyToSkill(cycle, candidate, skillId);
          }
          // 无目标技能的代码补丁不自动改仓库源码（filePath 是生成器虚构的路径），
          // 归档产物 + manifest 供人工审查。
          return this.archiveArtifact(cycle, candidate);
        }
        case "config_change":
          return this.pendingConfigChange(cycle, candidate);
        default:
          return { applied: false, mode: "skipped", target: null, detail: `未知候选类型: ${String(candidate.type)}` };
      }
    } catch (err) {
      return {
        applied: false,
        mode: "failed",
        target: null,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 消费 `evolution.hotreload` 事件（install/update/remove/rollback）。
   * 由 EvolutionEngine 订阅转发。
   */
  async handleHotReload(event: HotReloadEvent): Promise<void> {
    try {
      switch (event.action) {
        case "install": {
          const skillManager = this.resolveSkillManager();
          if (!skillManager) return;
          // ★ 契约错配修复：HotReloadManager.publish() 传的是 candidate.id（UUID），
          // 不是文件路径，`fs.existsSync(uuid)` 恒为 false → 生产里每次 new_skill
          // 都打一条假报错。真正的安装已在 applyNewSkill 中完成（installSkill
          // 生成物），此处只做「已安装」确认。兼容旧语义：传的是真实路径则安装。
          if (fs.existsSync(event.skillId)) {
            await skillManager.installSkill(event.skillId);
            break;
          }
          const installed = await skillManager.getSkill(event.skillId);
          if (installed) {
            process.stdout.write(
              `[EvolutionApplier] hotreload install skill "${event.skillId}" already installed (${installed.installPath})\n`
            );
            break;
          }
          process.stderr.write(`[EvolutionApplier] hotreload install: skill not found: ${event.skillId}\n`);
          break;
        }
        case "update":
          // SKILL.md 已在 applyToSkill 中原子更新；此处仅确认日志
          process.stdout.write(`[EvolutionApplier] hotreload update skill "${event.skillId}" confirmed\n`);
          break;
        case "remove":
          // AGENTS.md 原则：永不删除，只归档。自动进化路径不做删除。
          process.stderr.write(`[EvolutionApplier] hotreload remove ignored (never delete; archive only): ${event.skillId}\n`);
          break;
        case "rollback":
          await this.rollbackSkill(event.skillId);
          break;
      }
    } catch (err) {
      process.stderr.write(
        `[EvolutionApplier] hotreload failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
    } finally {
      this.eventBus.publish(
        "evolution.reload_completed",
        { skillId: event.skillId, action: event.action, strategy: event.strategy },
        "evolution-applier"
      ).catch(() => {});
    }
  }

  // ── new_skill：生成 + 安装 ─────────────────────────────────────

  private async applyNewSkill(cycle: EvolutionCycle, candidate: EvolutionCandidate): Promise<ApplyResult> {
    const generated = await this.autoGenerator.generateFromEvolution({
      trigger: cycle.input?.triggerEvent || candidate.type,
      solution: candidate.proposedChanges?.description || "",
      beforeCode: "",
      afterCode: candidate.codeArtifacts.map((a) => a.source).join("\n"),
    });

    if (!generated?.skillPath) {
      return { applied: false, mode: "skipped", target: null, detail: "自动生成器判定不适合生成技能" };
    }

    const skillManager = this.resolveSkillManager();
    if (skillManager) {
      try {
        await skillManager.installSkill(generated.skillPath);
      } catch (err) {
        return {
          applied: false,
          mode: "failed",
          target: generated.skillPath,
          detail: `installSkill 失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    this.emitApplied(cycle, candidate, "installed", generated.skillPath, `技能已安装: ${generated.skillName}`);
    return { applied: true, mode: "installed", target: generated.skillPath, detail: `技能已安装: ${generated.skillName}` };
  }

  // ── skill_update / code_patch：追加补丁到目标技能 ───────────────

  private async applyToSkill(
    cycle: EvolutionCycle,
    candidate: EvolutionCandidate,
    skillId: string
  ): Promise<ApplyResult> {
    const skillManager = this.resolveSkillManager();
    let skill: Skill | null = null;
    if (skillManager) {
      skill = (await skillManager.getSkill(skillId)) || null;
    }

    const skillMd = skill?.installPath || null;
    if (!skillMd || !fs.existsSync(skillMd)) {
      // 目标技能无法解析 → 归档而非盲写
      return this.archiveArtifact(cycle, candidate);
    }

    const marker = `evolution-patch:${candidate.id}`;
    const current = fs.readFileSync(skillMd, "utf-8");
    if (current.includes(marker)) {
      return { applied: false, mode: "skipped", target: skillMd, detail: "重复补丁，跳过" };
    }

    // 应用前备份（供 rollback 恢复）
    const backupDir = path.join(this.backupDir, skillId);
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `${Date.now()}.md`);
    fs.writeFileSync(backupPath, current, "utf-8");

    const section = this.buildPatchSection(cycle, candidate, marker);
    atomicWriteFileSync(skillMd, `${current.replace(/\s*$/, "\n")}\n${section}`);

    // 版本递增 + 持久化（frontmatter 与 _meta.json，与 SkillCurator.persistSkillUpdate 同款）
    const currentVersion = skill?.version || "1.0.0";
    const newVersion = this.bumpVersion(currentVersion);
    if (skill) {
      skill.version = newVersion;
      skill.lifecycle.lastUpdated = new Date();
    }
    const updatedContent = fs.readFileSync(skillMd, "utf-8");
    atomicWriteFileSync(
      skillMd,
      updatedContent.replace(
        /^(---[\s\S]*?version:\s*).+/m,
        (_m, p1: string) => `${p1}${newVersion}`
      )
    );
    const metaPath = path.join(path.dirname(skillMd), "_meta.json");
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        meta.version = newVersion;
        atomicWriteFileSync(metaPath, JSON.stringify(meta, null, 2));
      } catch { /* ignore */ }
    }

    this.emitApplied(cycle, candidate, "skill_updated", skillMd, `技能 ${skillId} 已应用补丁（v${currentVersion} → v${newVersion}）`);
    return {
      applied: true,
      mode: "skill_updated",
      target: skillMd,
      detail: `技能 ${skillId} 已应用补丁（v${currentVersion} → v${newVersion}）`,
    };
  }

  private buildPatchSection(cycle: EvolutionCycle, candidate: EvolutionCandidate, marker: string): string {
    const code = candidate.codeArtifacts.map((a) => a.source).join("\n\n").trim();
    return [
      // 注意：首行留空再放 `---`。若 `---` 紧跟上一行正文，Markdown 会把
      // 上一行渲染成 setext 二级标题（`文本\n---` = H2），补丁标题反而降级。
      "",
      "---",
      `## 🧬 Evolution Patch — ${candidate.id.slice(0, 8)}`,
      "",
      `> 触发: ${cycle.source} | 风险: ${candidate.risk?.level || "unknown"} | 来源: evolution-engine`,
      `> 理由: ${(candidate.proposedChanges?.description || "").slice(0, 200)}`,
      `> ${marker}`,
      "",
      code || (candidate.proposedChanges?.description || "（无代码产物，仅描述性补丁）"),
      "",
    ].join("\n");
  }

  // ── 归档：无目标技能的 code_patch ──────────────────────────────

  private archiveArtifact(cycle: EvolutionCycle, candidate: EvolutionCandidate): ApplyResult {
    const dir = path.join(this.archiveDir, cycle.id);
    fs.mkdirSync(dir, { recursive: true });

    const source = candidate.codeArtifacts.map((a) => a.source).join("\n\n").trim();
    const sourcePath = path.join(dir, `${candidate.id}.ts`);
    if (source) {
      atomicWriteFileSync(sourcePath, source);
    }

    const manifestPath = path.join(dir, `${candidate.id}.manifest.json`);
    const manifest = {
      candidateId: candidate.id,
      cycleId: cycle.id,
      type: candidate.type,
      source: cycle.source,
      description: candidate.proposedChanges?.description || "",
      risk: candidate.risk?.level || "unknown",
      evaluationScore: cycle.evaluation?.score ?? null,
      codeChanges: candidate.proposedChanges?.codeChanges || [],
      archivedAt: new Date().toISOString(),
    };
    atomicWriteFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    this.emitApplied(cycle, candidate, "archived", manifestPath, "无目标技能，产物已归档待人工审查");
    return {
      applied: true,
      mode: "archived",
      target: manifestPath,
      detail: "无目标技能，产物已归档待人工审查",
    };
  }

  // ── config_change：待人工审查 ───────────────────────────────────

  private pendingConfigChange(cycle: EvolutionCycle, candidate: EvolutionCandidate): ApplyResult {
    fs.mkdirSync(this.configPendingDir, { recursive: true });
    const pendingPath = path.join(this.configPendingDir, `${candidate.id}.json`);
    atomicWriteFileSync(
      pendingPath,
      JSON.stringify({
        candidateId: candidate.id,
        cycleId: cycle.id,
        description: candidate.proposedChanges?.description || "",
        suggestedConfig: candidate.proposedChanges?.configChanges || {},
        reasoning: candidate.proposedChanges?.codeChanges?.[0]?.reasoning || "",
        pendingAt: new Date().toISOString(),
      }, null, 2)
    );

    this.emitApplied(cycle, candidate, "config_pending", pendingPath, "配置变更需人工审查，未自动应用");
    return {
      applied: false,
      mode: "config_pending",
      target: pendingPath,
      detail: "配置变更需人工审查，未自动应用",
    };
  }

  // ── rollback：从备份恢复 ──────────────────────────────────────

  private async rollbackSkill(skillId: string): Promise<boolean> {
    const skillManager = this.resolveSkillManager();
    if (!skillManager) return false;

    const skill = (await skillManager.getSkill(skillId)) || null;
    const skillMd = skill?.installPath;
    if (!skillMd || !fs.existsSync(skillMd)) {
      process.stderr.write(`[EvolutionApplier] rollback: skill not found: ${skillId}\n`);
      return false;
    }

    const backupDir = path.join(this.backupDir, skillId);
    if (!fs.existsSync(backupDir)) {
      process.stderr.write(`[EvolutionApplier] rollback: no backups for ${skillId}\n`);
      return false;
    }

    const backups = fs.readdirSync(backupDir).filter((f) => f.endsWith(".md")).sort();
    const latest = backups[backups.length - 1];
    if (!latest) return false;

    atomicWriteFileSync(skillMd, fs.readFileSync(path.join(backupDir, latest), "utf-8"));
    process.stdout.write(`[EvolutionApplier] rollback skill "${skillId}" → restored ${latest}\n`);

    this.eventBus.publish(
      "evolution.applied",
      { cycleId: "rollback", candidateId: skillId, mode: "rollback", target: skillMd },
      "evolution-applier"
    ).catch(() => {});
    return true;
  }

  // ── 工具 ───────────────────────────────────────────────────────

  private resolveTargetSkillId(cycle: EvolutionCycle): string | null {
    const fromContext = (cycle.input?.context as Record<string, unknown> | undefined)?.targetSkill;
    const candidates = [cycle.targetSkill, cycle.input?.relatedSkills?.[0], fromContext];
    for (const c of candidates) {
      if (typeof c === "string" && c.length > 0 && !c.includes("/") && !c.includes("..")) {
        return c;
      }
    }
    return null;
  }

  private resolveSkillManager(): {
    getSkill(id: string): Promise<Skill | undefined>;
    installSkill(skillPath: string, force?: boolean): Promise<Skill>;
  } | null {
    return this.registry.resolveService<{
      getSkill(id: string): Promise<Skill | undefined>;
      installSkill(skillPath: string, force?: boolean): Promise<Skill>;
    }>("skillManager") || null;
  }

  private bumpVersion(version: string): string {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!m) return version;
    return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
  }

  private emitApplied(
    cycle: EvolutionCycle,
    candidate: EvolutionCandidate,
    mode: ApplyResult["mode"],
    target: string | null,
    detail: string
  ): void {
    this.eventBus.publish(
      "evolution.applied",
      { cycleId: cycle.id, candidateId: candidate.id, mode, target, detail },
      "evolution-applier"
    ).catch(() => {});
  }
}
