import {
  ServiceRegistry,
  EventBus,
  SystemEvents,
  type Skill,
  type SkillExecutionResult,
} from "@evoclaw/core";
import { v4 as uuid } from "uuid";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { SKILLmdParser } from "./skill-md-parser";
import { SkillSandbox } from "./skill-sandbox";
import { SkillLifecycleManager } from "./skill-lifecycle";
import { SkillRegistry, type RegistrySearchQuery, type RegistrySearchResult, type RemoteRegistryConfig } from "./skill-registry";
import { SkillResolver } from "./skill-resolver";

export class SkillManager {
  private skills = new Map<string, Skill>();
  private parser: SKILLmdParser;
  private sandbox: SkillSandbox;
  private lifecycle: SkillLifecycleManager;
  private registry: SkillRegistry;
  private resolver: SkillResolver;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private processedItems = new Map<string, number>();

  constructor(
    private svcRegistry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.parser = new SKILLmdParser();
    this.sandbox = new SkillSandbox(svcRegistry, eventBus);
    this.lifecycle = new SkillLifecycleManager(svcRegistry, eventBus);
    this.registry = new SkillRegistry(svcRegistry, eventBus);
    this.resolver = new SkillResolver(
      svcRegistry,
      eventBus,
      this.registry,
      (id) => this.skills.get(id)
    );

    svcRegistry.registerService("skillManager", this);
  }

  async installSkill(skillPath: string): Promise<Skill> {
    const parsed = await this.parser.parseFromFile(skillPath);

    const warnings: string[] = [];

    if (parsed.meta.os && parsed.meta.os.length > 0) {
      const currentOS = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
      if (!parsed.meta.os.includes(currentOS)) {
        warnings.push(
          `Skill "${parsed.meta.name}" was designed for [${parsed.meta.os.join(", ")}] — may not work correctly on "${currentOS}"`
        );
      }
    }

    const ocMeta = parsed.meta.metadata?.openclaw;
    if (ocMeta?.requires?.env) {
      for (const envVar of ocMeta.requires.env) {
        if (!process.env[envVar]) {
          warnings.push(
            `Missing required environment variable: ${envVar} — skill "${parsed.meta.name}" may not function correctly`
          );
        }
      }
    }

    if (ocMeta?.requires?.bins) {
      for (const bin of ocMeta.requires.bins) {
        warnings.push(
          `Missing optional binary: "${bin}" — some features of "${parsed.meta.name}" may be unavailable`
        );
      }
    }

    if (ocMeta?.primaryEnv && !process.env[ocMeta.primaryEnv]) {
      warnings.push(
        `Primary environment variable "${ocMeta.primaryEnv}" is not set — skill "${parsed.meta.name}" requires configuration`
      );
    }

    if (warnings.length > 0) {
      for (const w of warnings) {
        console.warn(`[SkillManager] ⚠ ${w}`);
      }
    }

    const triggers = parsed.meta.triggers || [];
    const keywords = triggers
      .filter((t) => t.type === "keyword")
      .map((t) => t.pattern.replace(/\/|\^|\$/g, ""))
      .slice(0, 10);

    const skill: Skill = {
      id: uuid(),
      name: parsed.meta.name,
      version: parsed.meta.version,
      description: parsed.meta.description,
      author: parsed.meta.author,
      license: "MIT",
      homepage: parsed.meta.homepage || ocMeta?.homepage,
      keywords,
      category: "custom",
      entryPoint: skillPath,
      sandboxPolicy: {
        allowNetwork: false,
        allowFileSystem: true,
        allowSubprocess: false,
        maxExecutionTime: 30000,
        maxMemoryMB: 128,
        allowedHosts: [],
        allowedPaths: [],
      },
      installPath: skillPath,
      lifecycle: this.lifecycle.createLifecycle(parsed.meta.version),
      config: parsed.meta.config || {},
      requires: parsed.meta.requires || [],
      provides: [],
      triggers,
      body: {
        instructions: parsed.instructions,
        scripts: parsed.scripts,
        examples: parsed.examples,
        hooks: parsed.hooks,
      },
      stats: {
        invocationCount: 0,
        successCount: 0,
        failureCount: 0,
        averageDuration: 0,
        lastInvocation: null,
        userRating: 0,
      },
    };

    this.skills.set(skill.id, skill);
    this.registry.registerSkill(skill);
    this.lifecycle.activate(skill);

    const agentExecutor = this.svcRegistry?.resolveService<{
      registerTool(name: string, definition: { name: string; description: string; parameters: Record<string, unknown> }, handler: (params: Record<string, unknown>) => Promise<unknown>): void;
    }>("agentModelExecutor");

    if (agentExecutor) {
      const handler = async (params: Record<string, unknown>) => {
        return await this.executeSkill(skill.id, params);
      };

      agentExecutor.registerTool(
        skill.name,
        {
          name: skill.name,
          description: skill.description || `Execute the ${skill.name} skill`,
          parameters: {
            prompt: { type: "string", description: "User prompt for skill execution" },
            query: { type: "string", description: "Query to pass to the skill" },
          },
        },
        handler
      );
    }

    await this.eventBus.publish(SystemEvents.SKILL_INSTALLED, skill, "skill-manager");

    return skill;
  }

  async executeSkill(
    skillId: string,
    params: Record<string, unknown>
  ): Promise<SkillExecutionResult> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return {
        skillId,
        success: false,
        output: null,
        errors: ["Skill not found"],
        duration: 0,
        resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
      };
    }

    const startTime = Date.now();
    skill.stats.invocationCount++;

    try {
      const result = await this.sandbox.execute(skill, params);

      const duration = Date.now() - startTime;
      skill.stats.successCount++;
      skill.stats.lastInvocation = new Date();
      skill.stats.averageDuration =
        (skill.stats.averageDuration * (skill.stats.invocationCount - 1) + duration) /
        skill.stats.invocationCount;

      await this.eventBus.publish(SystemEvents.SKILL_EXECUTED, { skillId, params, result }, "skill-manager");

      return result;
    } catch (err) {
      const duration = Date.now() - startTime;
      skill.stats.failureCount++;

      const result: SkillExecutionResult = {
        skillId,
        success: false,
        output: null,
        errors: [err instanceof Error ? err.message : String(err)],
        duration,
        resourceUsage: { cpuTime: 0, peakMemoryMB: 0, networkBytes: 0 },
      };

      await this.eventBus.publish(
        SystemEvents.SKILL_FAILED,
        { skillId, params, error: result.errors[0] },
        "skill-manager"
      );

      return result;
    }
  }

  async searchSkills(query: RegistrySearchQuery): Promise<RegistrySearchResult> {
    return this.registry.searchBoth(query);
  }

  async searchLocalSkills(query: RegistrySearchQuery): Promise<RegistrySearchResult> {
    return this.registry.searchLocal(query);
  }

  async searchRemoteSkills(query: RegistrySearchQuery): Promise<RegistrySearchResult> {
    return this.registry.searchRemote(query);
  }

  async listSkills(): Promise<Skill[]> {
    return Array.from(this.skills.values());
  }

  async getSkill(id: string): Promise<Skill | undefined> {
    return this.skills.get(id);
  }

  async uninstallSkill(skillId: string): Promise<void> {
    const skill = this.skills.get(skillId);
    if (skill) {
      this.lifecycle.deactivate(skill);
      this.registry.unregisterSkill(skillId);
      this.skills.delete(skillId);
      await this.eventBus.publish(
        SystemEvents.SKILL_UNINSTALLED,
        skill,
        "skill-manager"
      );
    }
  }

  async checkSkillHealth(skillId: string) {
    const skill = this.skills.get(skillId);
    if (!skill) return null;
    return this.lifecycle.performHealthCheck(skill);
  }

  getSkillHealthReport(skillId: string) {
    const skill = this.skills.get(skillId);
    if (!skill) return null;
    return this.lifecycle.getHealthReport(skill);
  }

  getSkillRegistry(): SkillRegistry {
    return this.registry;
  }

  getSkillResolver(): SkillResolver {
    return this.resolver;
  }

  getLifecycleManager(): SkillLifecycleManager {
    return this.lifecycle;
  }

  addRemoteRegistry(config: RemoteRegistryConfig): void {
    this.registry.addRemoteRegistry(config);
  }

  startAutoScan(skillsDir: string, intervalMs = 30000): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
    }
    console.log(`[SkillManager] Auto-scan started on "${skillsDir}" (every ${intervalMs / 1000}s)`);

    const runScan = async () => {
      try {
        const result = await this.scanAndInstall(skillsDir);
        if (result.installed.length > 0 || result.skipped.length > 0) {
          console.log(
            `[SkillManager] Scan: ${result.installed.length} installed, ${result.skipped.length} skipped`
          );
        }
      } catch (err) {
        console.error("[SkillManager] Auto-scan error:", err);
      }
    };

    runScan();
    this.scanTimer = setInterval(runScan, intervalMs);
  }

  stopAutoScan(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
      console.log("[SkillManager] Auto-scan stopped");
    }
  }

  async scanAndInstall(skillsDir: string): Promise<{ installed: Skill[]; skipped: string[] }> {
    const installed: Skill[] = [];
    const skipped: string[] = [];

    if (!fs.existsSync(skillsDir)) {
      return { installed, skipped };
    }

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(skillsDir, entry.name);

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
        try {
          const stat = fs.statSync(fullPath);
          const prevMtime = this.processedItems.get(fullPath);

          if (prevMtime === stat.mtimeMs) {
            skipped.push(entry.name);
            continue;
          }

          const extractDir = path.join(
            skillsDir,
            entry.name.replace(/\.zip$/i, "")
          );

          if (fs.existsSync(extractDir)) {
            fs.rmSync(extractDir, { recursive: true, force: true });
          }

          this.extractZip(fullPath, skillsDir);

          const skill = await this.installFolderSkill(extractDir);
          if (skill) {
            this.processedItems.set(fullPath, stat.mtimeMs);
            installed.push(skill);
          }
        } catch (err) {
          console.error(
            `[SkillManager] Failed to process ZIP "${entry.name}":`,
            err
          );
        }
      } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
        try {
          const skillMdPath = path.join(fullPath, "SKILL.md");
          if (!fs.existsSync(skillMdPath)) {
            continue;
          }

          const stat = fs.statSync(skillMdPath);
          const prevMtime = this.processedItems.get(skillMdPath);

          if (prevMtime === stat.mtimeMs) {
            skipped.push(entry.name);
            continue;
          }

          const alreadyInstalled = Array.from(this.skills.values()).some(
            (s) => s.installPath === skillMdPath && s.lifecycle.status === "active"
          );

          if (alreadyInstalled) {
            this.processedItems.set(skillMdPath, stat.mtimeMs);
            skipped.push(entry.name);
            continue;
          }

          const skill = await this.installSkill(skillMdPath);
          if (skill) {
            this.processedItems.set(skillMdPath, stat.mtimeMs);
            installed.push(skill);
          }
        } catch (err) {
          console.error(
            `[SkillManager] Failed to register folder "${entry.name}":`,
            err
          );
        }
      }
    }

    return { installed, skipped };
  }

  private async installFolderSkill(folderPath: string): Promise<Skill | null> {
    const skillMdPath = path.join(folderPath, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) {
      return null;
    }
    return await this.installSkill(skillMdPath);
  }

  private extractZip(zipPath: string, destDir: string): void {
    try {
      if (process.platform === "win32") {
        execSync(
          `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`,
          { stdio: "pipe" }
        );
      } else {
        execSync(
          `unzip -o "${zipPath}" -d "${destDir}"`,
          { stdio: "pipe" }
        );
      }
    } catch (err) {
      throw new Error(`ZIP extraction failed: ${err}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}