import {
  ServiceRegistry,
  EventBus,
  SystemEvents,
  type Skill,
  type SkillCategory,
  type SkillI18n,
  type SkillExecutionResult,
} from "@evoclaw/core";
import { v4 as uuid } from "uuid";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { SKILLmdParser } from "./skill-md-parser";
import { SkillSandbox } from "./skill-sandbox";
import { SkillLifecycleManager } from "./skill-lifecycle";
import { SkillRegistry, type RegistrySearchQuery, type RegistrySearchResult, type RemoteRegistryConfig } from "./skill-registry";
import { SkillResolver } from "./skill-resolver";
import { LocalizationService } from "./localization-service";

export class SkillManager {
  private skills = new Map<string, Skill>();
  private parser: SKILLmdParser;
  private sandbox: SkillSandbox;
  private lifecycle: SkillLifecycleManager;
  private registry: SkillRegistry;
  private resolver: SkillResolver;
  private localization: LocalizationService;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private processedItems = new Map<string, number>();
  private isScanning = false;

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
    this.localization = new LocalizationService(svcRegistry);

    svcRegistry.registerService("skillManager", this);
  }

  async installSkill(skillPath: string): Promise<Skill> {
    const existing = Array.from(this.skills.values()).find(
      (s) => s.installPath === skillPath
    );
    if (existing) {
      return existing;
    }

    const parsed = await this.parser.parseFromFile(skillPath);

    // 读取 _meta.json 补充元数据
    const skillDir = path.dirname(skillPath);
    const metaJsonPath = path.join(skillDir, "_meta.json");
    let metaJson: Record<string, unknown> | null = null;
    try {
      if (fs.existsSync(metaJsonPath)) {
        metaJson = JSON.parse(fs.readFileSync(metaJsonPath, "utf-8"));
      }
    } catch { /* ignore */ }

    // 用 _meta.json 补充 SKILL.md 中缺失的字段
    if (metaJson) {
      if (!parsed.meta.description && metaJson.description) {
        parsed.meta.description = String(metaJson.description);
      }
      if (!parsed.meta.author || parsed.meta.author === "unknown") {
        parsed.meta.author = String(metaJson.author || metaJson.ownerId || metaJson.owner || "unknown");
      }
      if (!parsed.meta.category && metaJson.category) {
        const cat = String(metaJson.category);
        if (["automation", "integration", "analysis", "generation", "utility", "custom"].includes(cat)) {
          parsed.meta.category = cat as SkillCategory;
        }
      }
      if (!parsed.meta.keywords || parsed.meta.keywords.length === 0) {
        if (Array.isArray(metaJson.keywords)) {
          parsed.meta.keywords = metaJson.keywords.map(String);
        }
      }
      if (!parsed.meta.license && metaJson.license) {
        parsed.meta.license = String(metaJson.license);
      }
      if (!parsed.meta.homepage && metaJson.homepage) {
        parsed.meta.homepage = String(metaJson.homepage);
      }
      // 远程技能的 displayName 作为 name 备选
      if (parsed.meta.name === "unnamed-skill" && metaJson.displayName) {
        parsed.meta.name = String(metaJson.displayName);
      }
      // 远程技能的 slug 作为 name 备选
      if (parsed.meta.name === "unnamed-skill" && metaJson.slug) {
        parsed.meta.name = String(metaJson.slug);
      }
    }

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
    // 优先使用 SKILL.md frontmatter 中的 keywords，否则从 triggers 提取
    const keywords = parsed.meta.keywords && parsed.meta.keywords.length > 0
      ? parsed.meta.keywords
      : triggers
          .filter((t) => t.type === "keyword")
          .map((t) => t.pattern.replace(/\/|\^|\$/g, ""))
          .slice(0, 10);

    // Determine sandbox policy based on skill requirements
    const needsNetwork = parsed.meta.requires?.some(r => r.name === "python3" || r.name === "python") ||
      (parsed.meta.metadata?.openclaw?.requires?.env?.length ?? 0) > 0 ||
      parsed.meta.description?.toLowerCase().includes("search") ||
      parsed.meta.description?.toLowerCase().includes("web") ||
      parsed.meta.description?.toLowerCase().includes("api");
    const needsSubprocess = parsed.meta.requires?.some(r => r.name === "python3" || r.name === "python" || r.name === "node") ||
      (parsed.meta.metadata?.openclaw?.requires?.bins?.length ?? 0) > 0;
    const hasScripts = parsed.scripts && Object.keys(parsed.scripts).length > 0;

    const skill: Skill = {
      id: uuid(),
      name: parsed.meta.name,
      version: parsed.meta.version,
      description: parsed.meta.description,
      author: parsed.meta.author,
      license: parsed.meta.license || "MIT",
      homepage: parsed.meta.homepage || ocMeta?.homepage,
      keywords,
      category: parsed.meta.category || "custom",
      entryPoint: skillPath,
      sandboxPolicy: {
        allowNetwork: needsNetwork || needsSubprocess,
        allowFileSystem: true,
        allowSubprocess: needsSubprocess || hasScripts,
        maxExecutionTime: 60000,
        maxMemoryMB: 256,
        allowedHosts: needsNetwork ? ["*"] : [],
        allowedPaths: [],
      },
      installPath: skillPath,
      lifecycle: this.lifecycle.createLifecycle(parsed.meta.version),
      config: this.buildSkillConfig(parsed.meta.config || {}, ocMeta),
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

    const existingI18n = this.localization.loadI18nFile(skillDir);
    if (existingI18n) {
      skill.i18n = existingI18n as SkillI18n;
    }

    this.localization.enqueueTranslation(async () => {
      try {
        const i18n = await this.localization.checkAndTranslateSkill(skill);
        if (i18n) {
          skill.i18n = i18n;
        }
      } catch { /* non-critical */ }
    });

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

      // Unregister agent tool
      const agentExecutor = this.svcRegistry?.resolveService<{
        unregisterTool(name: string): void;
      }>("agentModelExecutor");

      if (agentExecutor) {
        try {
          agentExecutor.unregisterTool(skill.name);
        } catch {
          // Tool may not have been registered or unregister not supported
        }
      }

      this.registry.unregisterSkill(skillId);
      this.skills.delete(skillId);

      // Clean up processedItems cache
      for (const [key] of this.processedItems) {
        if (key.includes(skill.name) || key.includes(skillId)) {
          this.processedItems.delete(key);
        }
      }

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
    // Prevent processedItems from growing indefinitely
    if (this.processedItems.size > 1000) {
      this.processedItems.clear();
    }

    if (this.isScanning) {
      return { installed: [], skipped: ["Scan already in progress"] };
    }
    this.isScanning = true;

    try {
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
              const generated = await this.tryGenerateCuratedSkill(entry.name, fullPath);
              if (!generated) {
                continue;
              }
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
    } finally {
      this.isScanning = false;
    }
  }

  private async tryGenerateCuratedSkill(dirName: string, dirPath: string): Promise<boolean> {
    try {
      const autoSkillManager = this.svcRegistry.resolveService<{
        generateFromCurated(skillName: string): Promise<string | null>;
      }>("autoSkillManager");

      if (!autoSkillManager) return false;

      const result = await autoSkillManager.generateFromCurated(dirName);
      if (result && fs.existsSync(path.join(dirPath, "SKILL.md"))) {
        console.log(`[SkillManager] Auto-generated SKILL.md for curated skill: ${dirName}`);
        return true;
      }
    } catch {
      // Not a curated skill or generation failed
    }
    return false;
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
        execFileSync("powershell", ["-Command", "Expand-Archive", "-Path", zipPath, "-DestinationPath", destDir, "-Force"], { stdio: "pipe" });
      } else {
        execFileSync("unzip", ["-o", zipPath, "-d", destDir], { stdio: "pipe" });
      }
    } catch (err) {
      throw new Error(`ZIP extraction failed: ${err}`);
    }
  }

  /** Merge OpenClaw metadata required env vars into skill config */
  private buildSkillConfig(
    baseConfig: Record<string, unknown>,
    ocMeta: import("@evoclaw/core").OpenClawSkillMeta | null | undefined
  ): Record<string, unknown> {
    const config: Record<string, unknown> = { ...baseConfig };

    if (ocMeta?.requires?.env) {
      for (const envVar of ocMeta.requires.env) {
        // Use existing env value if set, otherwise empty placeholder
        if (!(envVar in config)) {
          config[envVar] = process.env[envVar] || "";
        }
      }
    }

    if (ocMeta?.requires?.bins) {
      // Store required binaries for display purposes
      config._requiredBins = ocMeta.requires.bins;
    }

    if (ocMeta?.primaryEnv) {
      config._primaryEnv = ocMeta.primaryEnv;
    }

    return config;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async checkAndTranslateInstalledSkills(): Promise<{ checked: number; translated: number }> {
    let checked = 0;
    let translated = 0;
    const allSkills = Array.from(this.skills.values());

    for (const skill of allSkills) {
      checked++;
      try {
        const i18n = await this.localization.checkAndTranslateSkill(skill);
        if (i18n && (i18n.description_zh || i18n.instructions_zh)) {
          skill.i18n = i18n;
          translated++;
        }
      } catch { /* non-critical */ }
    }

    if (translated > 0) {
      console.log(`[SkillManager] Localization check: ${checked} skills checked, ${translated} translated`);
    }
    return { checked, translated };
  }

  getLocalizationService(): LocalizationService {
    return this.localization;
  }
}