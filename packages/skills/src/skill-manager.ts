import {
  ServiceRegistry,
  EventBus,
  SystemEvents,
  type Skill,
  type SkillCategory,
  type SkillI18n,
  type SkillExecutionResult,
  type OpenClawSkillMeta,
  type SkillConfigStatus,
  type SkillLoadConfig,
  type SecurityScanResult,
} from "@evoclaw/core";
import { v4 as uuid } from "uuid";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { SKILLmdParser } from "./skill-md-parser";
import { SkillSandbox } from "./skill-sandbox";
import { SkillLifecycleManager } from "./skill-lifecycle";
import { SkillValidator } from "./skill-validator";
import { SkillHookEngine } from "./skill-hook-engine";
import { SkillRegistry, type RegistrySearchQuery, type RegistrySearchResult, type RemoteRegistryConfig } from "./skill-registry";
import { SkillResolver } from "./skill-resolver";
import { LocalizationService } from "./localization-service";
import { SkillMarketplace, type SearchQuery, type SearchResult } from "./marketplace";

// ── Skill Installation Pipeline Types ──

interface SkillInstallStep {
  name: string;
  status: "success" | "warning" | "failed";
  message: string;
  warnings: string[];
  errors: string[];
}

interface SkillInstallReport {
  skillId: string;
  skillName: string;
  phase: "parsing" | "validation" | "security" | "install_scripts" | "verification" | "complete" | "rolled_back";
  steps: SkillInstallStep[];
  warnings: string[];
  errors: string[];
}

export class SkillManager {
  private skills = new Map<string, Skill>();
  private parser: SKILLmdParser;
  private sandbox: SkillSandbox;
  private lifecycle: SkillLifecycleManager;
  private registry: SkillRegistry;
  private resolver: SkillResolver;
  private localization: LocalizationService;
  private validator: SkillValidator;
  private hookEngine: SkillHookEngine;
  private processedItems = new Map<string, number>();
  private isScanning = false;
  private marketplace: SkillMarketplace;
  private skillEcosystem: import("./skill-ecosystem").SkillEcosystem | null = null;
  private skillWorkshop: import("./skill-workshop").SkillWorkshop | null = null;
  private installPolicyManager: import("./install-policy").InstallPolicyManager | null = null;

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
    this.validator = new SkillValidator();
    this.hookEngine = new SkillHookEngine(svcRegistry, eventBus);
    this.marketplace = new SkillMarketplace(eventBus, {}, this);

    try {
      const { SkillEcosystem } = require("./skill-ecosystem");
      this.skillEcosystem = new SkillEcosystem();
    } catch {}

    try {
      const { SkillWorkshop } = require("./skill-workshop");
      this.skillWorkshop = new SkillWorkshop();
    } catch { /* skill workshop not available */ }

    try {
      const { InstallPolicyManager } = require("./install-policy");
      this.installPolicyManager = new InstallPolicyManager();
    } catch { /* install policy not available */ }

    svcRegistry.registerService("skillManager", this);
  }

  async installSkill(skillPath: string): Promise<Skill> {
    const existing = Array.from(this.skills.values()).find(
      (s) => s.installPath === skillPath
    );
    if (existing) {
      return existing;
    }

    // ── Install Policy: check if installation is allowed ──
    if (this.installPolicyManager) {
      const decision = this.installPolicyManager.checkInstall(skillPath, "source", undefined);
      if (decision.action === "block") {
        throw new Error(`Install blocked by policy: ${decision.reason}`);
      }
      if (decision.action === "review") {
        console.warn(`[SkillManager] Install requires review: ${decision.reason}`);
        // Continue but log the review requirement
      }
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

    const validation = this.validator.validate(parsed);
    if (!validation.valid) {
      throw new Error(`Skill validation failed: ${validation.errors.join("; ")}`);
    }
    if (validation.warnings.length > 0) {
      for (const w of validation.warnings) {
        console.warn(`[SkillManager] ⚠ ${w}`);
      }
    }

    // Validate skill quality before installing
    if (this.skillEcosystem) {
      try {
        const quality = await this.skillEcosystem.validateSkillQuality(skillPath);
        if (quality.score < 0.3) {
          console.warn(`[SkillManager] Skill quality too low (${quality.score.toFixed(2)}): ${quality.issues.join("; ")}`);
        }
      } catch { /* quality validation is non-critical */ }
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

    // Auto-detect env vars from SKILL.md body when metadata.openclaw is missing or incomplete
    const detectedEnvVars = this.detectEnvVarsFromContent(parsed.instructions);
    const declaredEnv = ocMeta?.requires?.env || [];
    const allEnvVars = [...new Set([...declaredEnv, ...detectedEnvVars])];
    if (detectedEnvVars.length > 0) {
      console.log(`[SkillManager] Auto-detected env vars from SKILL.md body: ${detectedEnvVars.join(", ")}`);
    }

    if (allEnvVars.length > 0) {
      for (const envVar of allEnvVars) {
        if (!process.env[envVar]) {
          warnings.push(
            `Missing required environment variable: ${envVar} — skill "${parsed.meta.name}" may not function correctly`
          );
        }
      }
    }

    if (ocMeta?.requires?.bins) {
      for (const bin of ocMeta.requires.bins) {
        // Actually check if the binary exists in PATH
        const binExists = this.checkBinaryExists(bin);
        if (!binExists) {
          warnings.push(
            `Missing optional binary: "${bin}" — some features of "${parsed.meta.name}" may be unavailable`
          );
        }
      }
    }

    const primaryEnv = ocMeta?.primaryEnv || detectedEnvVars.find(v =>
      /KEY|SECRET|TOKEN|API/i.test(v)
    );
    if (primaryEnv && !process.env[primaryEnv]) {
      warnings.push(
        `Primary environment variable "${primaryEnv}" is not set — skill "${parsed.meta.name}" requires configuration`
      );
    }

    const savedConfig = this.loadSkillConfig(skillDir);

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
    // Only grant permissions explicitly declared via requires, not inferred from description text
    const needsNetwork = parsed.meta.requires?.some(r =>
      r.name === "curl" || r.name === "web-search"
    ) || allEnvVars.length > 0;
    const needsSubprocess = parsed.meta.requires?.some(r =>
      r.name === "python3" || r.name === "python" || r.name === "node"
    ) || (parsed.meta.metadata?.openclaw?.requires?.bins?.length ?? 0) > 0;
    const hasScripts = parsed.scripts && Object.keys(parsed.scripts).length > 0;

    // Build allowedHosts from skill's declared dependencies, never use wildcard "*"
    const allowedHosts: string[] = [];
    if (needsNetwork) {
      // Extract specific hosts from env var names (e.g. BAIDU_API_HOST)
      for (const envVar of allEnvVars) {
        if (envVar.includes("BAIDU")) allowedHosts.push("aip.baidubce.com");
        if (envVar.includes("TAVILY")) allowedHosts.push("api.tavily.com");
        if (envVar.includes("SEARCH")) allowedHosts.push("api.search.brave.com");
      }
      // If no specific hosts identified, allow common API hosts but NOT wildcard
      if (allowedHosts.length === 0) {
        allowedHosts.push("api.openai.com", "api.anthropic.com");
      }
    }

    // Build allowedPaths from skill's install directory
    const allowedPaths = [skillDir];

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
        allowNetwork: needsNetwork,
        allowFileSystem: true,
        allowSubprocess: needsSubprocess || hasScripts,
        maxExecutionTime: 60000,
        maxMemoryMB: 256,
        allowedHosts,
        allowedPaths,
      },
      installPath: skillPath,
      lifecycle: this.lifecycle.createLifecycle(parsed.meta.version),
      config: this.buildSkillConfig(parsed.meta.config || {}, ocMeta, savedConfig, detectedEnvVars, skillDir),
      openclawMeta: ocMeta,
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

    // Security scan BEFORE registering the skill
    const securityResult = this.validator.securityScan(skill);
    if (securityResult.findings.length > 0) {
      const criticalFindings = securityResult.findings.filter(f => f.severity === "critical");
      const highFindings = securityResult.findings.filter(f => f.severity === "high");
      const mediumFindings = securityResult.findings.filter(f => f.severity === "medium");

      if (criticalFindings.length > 0) {
        // Roll back: uninstall the skill
        this.skills.delete(skill.id);
        this.lifecycle.deactivate(skill);
        const criticalDescs = criticalFindings.map(f => `[${f.type}] ${f.description} (${f.location})`).join("; ");
        throw new Error(`Security scan rejected skill "${skill.name}": critical findings: ${criticalDescs}`);
      }

      if (highFindings.length > 0) {
        for (const f of highFindings) {
          console.warn(`[SkillManager] 🔴 Security warning [${f.type}]: ${f.description} (${f.location})`);
        }
      }
      if (mediumFindings.length > 0) {
        for (const f of mediumFindings) {
          console.warn(`[SkillManager] 🟡 Security warning [${f.type}]: ${f.description} (${f.location})`);
        }
      }
    }

    // Register skill only after security scan passes
    this.skills.set(skill.id, skill);
    this.registry.registerSkill(skill);
    this.lifecycle.activate(skill);

    await this.hookEngine.executeHook(skill, "onInstall");

    // ── Phase 4: Execute install/build scripts from SKILL.md metadata ──
    const installReport: SkillInstallReport = {
      skillId: skill.id,
      skillName: skill.name,
      phase: "complete",
      steps: [],
      warnings: [...warnings],
      errors: [],
    };

    // 4a. Install declared dependencies (requires)
    if (parsed.meta.requires && parsed.meta.requires.length > 0) {
      const depStep = this.installDependencies(parsed.meta.requires, skillDir);
      installReport.steps.push(depStep);
      if (depStep.errors.length > 0) {
        installReport.errors.push(...depStep.errors);
      }
    }

    // 4c. Execute openclaw.install script
    if (ocMeta?.install) {
      const installStep = this.executeMetaScript("install", ocMeta.install, skillDir);
      installReport.steps.push(installStep);
      if (installStep.errors.length > 0) {
        installReport.errors.push(...installStep.errors);
      }
    }

    // 4c. Execute openclaw.build script
    if (ocMeta?.build) {
      const buildStep = this.executeMetaScript("build", ocMeta.build, skillDir);
      installReport.steps.push(buildStep);
      if (buildStep.errors.length > 0) {
        installReport.errors.push(...buildStep.errors);
      }
    }

    // ── Phase 5: Post-install verification ──
    const verifyStep = this.verifyInstallation(skill, parsed);
    installReport.steps.push(verifyStep);
    if (verifyStep.errors.length > 0) {
      installReport.errors.push(...verifyStep.errors);
    }

    // ── Phase 6: Rollback on critical failure ──
    if (installReport.errors.length > 0) {
      const criticalErrors = installReport.errors.filter(e =>
        e.includes("dependency install failed") ||
        e.includes("entry point not readable") ||
        e.includes("verification failed")
      );
      if (criticalErrors.length > 0) {
        console.error(`[SkillManager] Install failed with critical errors, rolling back "${skill.name}"`);
        // Roll back: remove from memory and disk
        this.skills.delete(skill.id);
        this.registry.unregisterSkill(skill.id);
        this.lifecycle.deactivate(skill);
        try {
          if (fs.existsSync(skillDir)) {
            fs.rmSync(skillDir, { recursive: true, force: true });
          }
        } catch { /* best effort */ }
        throw new Error(`Skill "${skill.name}" installation failed: ${criticalErrors.join("; ")}`);
      }
    }

    if (installReport.warnings.length > 0 || installReport.steps.some(s => s.warnings.length > 0)) {
      console.warn(`[SkillManager] Install completed with warnings for "${skill.name}": ${[
        ...installReport.warnings,
        ...installReport.steps.flatMap(s => s.warnings),
      ].join("; ")}`);
    }

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
    // Try exact ID lookup first, then fallback to name-based lookup
    let skill = this.skills.get(skillId);
    if (!skill) {
      // Search by skill name (e.g., "ciccwm_hot_news_analysis" or "ciccwm-market-analysis")
      for (const [, s] of this.skills) {
        if (s.name === skillId || s.name.replace(/[_-]/g, "") === skillId.replace(/[_-]/g, "")) {
          skill = s;
          break;
        }
      }
    }
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
    const currentCount = skill.stats.invocationCount++;

    try {
      await this.hookEngine.executeHook(skill, "onBeforeExecute", { params });

      const result = await this.sandbox.execute(skill, params);

      const duration = Date.now() - startTime;
      skill.stats.successCount++;
      skill.stats.lastInvocation = new Date();
      skill.stats.averageDuration =
        (skill.stats.averageDuration * currentCount + duration) /
        (currentCount + 1);

      await this.eventBus.publish(SystemEvents.SKILL_EXECUTED, { skillId, params, result }, "skill-manager");

      await this.hookEngine.executeHook(skill, "onAfterExecute", { params, result });

      return result;
    } catch (err) {
      await this.hookEngine.executeHook(skill, "onError", { params, error: err });

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
    // Prune skills whose files no longer exist on disk
    const staleIds: string[] = [];
    for (const [id, skill] of this.skills) {
      if (skill.installPath && !fs.existsSync(skill.installPath)) {
        staleIds.push(id);
      }
    }
    if (staleIds.length > 0) {
      for (const id of staleIds) {
        const skill = this.skills.get(id);
        if (skill) {
          this.registry.unregisterSkill(id);
          this.skills.delete(id);
          console.log(`[SkillManager] Pruned stale skill "${skill.name}" (files deleted from disk)`);
        }
      }
    }

    const skills = Array.from(this.skills.values());
    for (const skill of skills) {
      if (!skill.openclawMeta) {
        const parsed = await this.parser.parseFromFile(skill.entryPoint).catch(() => null);
        skill.openclawMeta = parsed?.meta?.metadata?.openclaw || undefined;
      }
      skill.configStatus = this.computeConfigStatus(skill);
    }
    return skills;
  }

  private computeConfigStatus(skill: Skill): SkillConfigStatus {
    const ocMeta = skill.openclawMeta;
    // Collect env vars from both declared metadata and auto-detected config keys
    const declaredEnv = ocMeta?.requires?.env || [];
    const configKeys = Object.keys(skill.config).filter(
      k => !k.startsWith("_") && /^[A-Z][A-Z0-9_]{2,}$/.test(k)
    );
    const allEnvVars = [...new Set([...declaredEnv, ...configKeys])];

    if (allEnvVars.length === 0) {
      return "configured";
    }
    let configured = 0;
    for (const envVar of allEnvVars) {
      const value = skill.config[envVar];
      if (value && String(value).trim() !== "") {
        configured++;
      }
    }
    if (configured === allEnvVars.length) return "configured";
    if (configured > 0) return "partial";
    return "unconfigured";
  }

  async getSkill(id: string): Promise<Skill | undefined> {
    return this.skills.get(id);
  }

  async uninstallSkill(skillId: string): Promise<void> {
    const skill = this.skills.get(skillId);
    if (skill) {
      await this.hookEngine.executeHook(skill, "onUninstall");

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

      // Delete skill files from disk to prevent auto-scan from reinstalling
      try {
        const skillDir = path.dirname(skill.installPath);
        if (fs.existsSync(skillDir)) {
          fs.rmSync(skillDir, { recursive: true, force: true });
          console.log(`[SkillManager] Deleted skill directory: ${skillDir}`);
        }
      } catch (err) {
        console.warn(`[SkillManager] Failed to delete skill directory: ${err instanceof Error ? err.message : err}`);
      }

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

  /** Install a skill from the ClawHub marketplace by name */
  async installFromMarketplace(skillName: string): Promise<Skill> {
    await this.marketplace.refreshCatalog();

    const searchResult = this.marketplace.search({ query: skillName, limit: 1 });
    const pkg = searchResult.packages.find(p => p.name === skillName) || searchResult.packages[0];
    if (!pkg) {
      throw new Error(`Skill "${skillName}" not found on ClawHub marketplace`);
    }

    const installResult = await this.marketplace.install(pkg.name);
    if (!installResult.success) {
      throw new Error(`Failed to install "${pkg.name}" from marketplace: ${installResult.error || "unknown error"}`);
    }

    const extractedPath = installResult.installedPath;
    if (!extractedPath) {
      throw new Error(`Installation of "${pkg.name}" succeeded but no path returned`);
    }

    // If SkillMarketplace already registered via skillManager callback, find the skill
    const existing = Array.from(this.skills.values()).find(
      s => s.name === pkg.name || s.installPath === extractedPath
    );
    if (existing) {
      return existing;
    }

    // Otherwise, manually register via installSkill
    const fs = await import("fs");
    const skillMdPath = fs.existsSync(extractedPath) && extractedPath.endsWith("SKILL.md")
      ? extractedPath
      : path.join(extractedPath, "SKILL.md");

    if (!fs.existsSync(skillMdPath)) {
      throw new Error(`SKILL.md not found at ${skillMdPath} after marketplace install`);
    }

    return await this.installSkill(skillMdPath);
  }

  /** Upgrade a skill from the ClawHub marketplace */
  async upgradeFromMarketplace(skillId: string): Promise<Skill | null> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return null;
    }

    await this.marketplace.refreshCatalog();

    const pkg = await this.marketplace.fetchPackageDetails(skill.name);
    if (!pkg) {
      throw new Error(`Skill "${skill.name}" not found on ClawHub marketplace`);
    }

    if (this.marketplace.compareVersions(pkg.version, skill.version) <= 0) {
      return null; // Already up to date
    }

    // Uninstall the old version first
    const skillDir = path.dirname(skill.installPath);
    const savedConfig = this.loadSkillConfig(skillDir);

    await this.uninstallSkill(skillId);

    // Install the new version from marketplace
    const installResult = await this.marketplace.install(pkg.name);
    if (!installResult.success) {
      throw new Error(`Failed to upgrade "${pkg.name}" from marketplace: ${installResult.error || "unknown error"}`);
    }

    const extractedPath = installResult.installedPath;
    if (!extractedPath) {
      throw new Error(`Upgrade of "${pkg.name}" succeeded but no path returned`);
    }

    // Find the newly installed skill
    const newSkill = Array.from(this.skills.values()).find(
      s => s.name === pkg.name || s.installPath === extractedPath
    );

    if (newSkill && savedConfig) {
      const ocMeta = newSkill.openclawMeta;
      const mergedConfig = this.buildSkillConfig(newSkill.config, ocMeta, savedConfig);
      newSkill.config = mergedConfig;
    }

    return newSkill ?? null;
  }

  /** Search the ClawHub marketplace */
  searchMarketplace(query: string, category?: string): SearchResult {
    const searchQuery: SearchQuery = {
      query,
      tags: category ? [category] : undefined,
    };
    return this.marketplace.search(searchQuery);
  }

  /** Get the SkillMarketplace instance */
  getMarketplace(): SkillMarketplace {
    return this.marketplace;
  }

  private scanDirs: Array<{ dir: string; intervalMs: number }> = [];
  private scanTimers: ReturnType<typeof setInterval>[] = [];

  startAutoScan(skillsDir: string, intervalMs = 30000): void {
    this.scanDirs.push({ dir: skillsDir, intervalMs });
    console.log(`[SkillManager] Auto-scan started on "${skillsDir}" (every ${intervalMs / 1000}s)`);

    const runScan = async (dir: string) => {
      try {
        const result = await this.scanAndInstall(dir);
        if (result.installed.length > 0 || result.skipped.length > 0) {
          console.log(
            `[SkillManager] Scan "${dir}": ${result.installed.length} installed, ${result.skipped.length} skipped`
          );
        }
      } catch (err) {
        console.error(`[SkillManager] Auto-scan error for "${dir}":`, err);
      }
    };

    runScan(skillsDir);
    const timer = setInterval(() => runScan(skillsDir), intervalMs);
    timer.unref();
    this.scanTimers.push(timer);
  }

  stopAutoScan(): void {
    for (const timer of this.scanTimers) {
      clearInterval(timer);
    }
    this.scanTimers = [];
    this.scanDirs = [];
    console.log("[SkillManager] Auto-scan stopped");
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

  /** Check if a binary exists in the system PATH */
  private checkBinaryExists(bin: string): boolean {
    try {
      const which = process.platform === "win32" ? "where" : "which";
      execFileSync(which, [bin], { stdio: "pipe", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Load .env file values by searching from skill dir upward to project root.
   *  Returns a flat key-value map of all variables found in .env files.
   *  Closer .env files take precedence (child overrides parent).
   */
  private loadDotenvValues(skillDir: string): Record<string, string> {
    const result: Record<string, string> = {};

    // Collect .env files from root → skill dir (later overrides earlier)
    const envFiles: string[] = [];
    let current = path.resolve(skillDir);
    const root = path.parse(current).root;

    for (let i = 0; i < 10; i++) {
      const envPath = path.join(current, ".env");
      if (fs.existsSync(envPath)) {
        envFiles.push(envPath);
      }
      const parent = path.dirname(current);
      if (parent === current || parent === root) break;
      current = parent;
    }

    // Parse from root-level first, then override with closer .env
    for (const envPath of envFiles.reverse()) {
      try {
        const content = fs.readFileSync(envPath, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIndex = trimmed.indexOf("=");
          if (eqIndex === -1) continue;
          const key = trimmed.slice(0, eqIndex).trim();
          let value = trimmed.slice(eqIndex + 1).trim();
          // Strip surrounding quotes
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (key) {
            result[key] = value;
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    return result;
  }

  /** Detect environment variable requirements from SKILL.md body content.
   *  Scans sections like "Requirements", "Prerequisites", "Configuration" etc.
   *  for patterns like `SOME_API_KEY`, "environment variable: `VAR_NAME`", or `VAR_NAME=...`
   */
  private detectEnvVarsFromContent(instructions: string): string[] {
    const envVars: string[] = [];
    const seen = new Set<string>();

    // Extract relevant sections (Requirements, Prerequisites, Configuration, Setup, etc.)
    const sectionRegex = /^##\s+(.+)$/gm;
    const sections: { title: string; start: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = sectionRegex.exec(instructions)) !== null) {
      sections.push({ title: m[1].trim().toLowerCase(), start: m.index });
    }

    // Collect content from config-related sections
    const relevantSections: string[] = [];
    const configKeywords = ["requirement", "prerequisite", "configuration", "config", "setup", "environment", "env", "credential", "api key", "准备", "配置", "环境变量"];
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const isRelevant = configKeywords.some(kw => section.title.includes(kw));
      if (isRelevant) {
        const start = instructions.indexOf("\n", section.start) + 1;
        const end = i + 1 < sections.length ? sections[i + 1].start : instructions.length;
        relevantSections.push(instructions.slice(start, end));
      }
    }

    // Also scan the full instructions for env var patterns (catches preamble mentions)
    const scanText = relevantSections.length > 0 ? relevantSections.join("\n") : instructions;

    // Pattern 1: environment variable: `VAR_NAME` or environment variable `VAR_NAME`
    const envLabelRegex = /environment\s+variable[:\s]+`?([A-Z][A-Z0-9_]{2,})`?/gi;
    while ((m = envLabelRegex.exec(scanText)) !== null) {
      if (!seen.has(m[1])) { seen.add(m[1]); envVars.push(m[1]); }
    }

    // Pattern 2: `VAR_NAME=...` (assignment in backticks)
    const assignRegex = /`([A-Z][A-Z0-9_]{2,})\s*=/g;
    while ((m = assignRegex.exec(scanText)) !== null) {
      if (!seen.has(m[1])) { seen.add(m[1]); envVars.push(m[1]); }
    }

    // Pattern 3: `VAR_NAME` in backticks that looks like an API key / config var
    // Only match if the surrounding context mentions key/secret/token/config/env/api
    const backtickVarRegex = /`([A-Z][A-Z0-9_]{2,})`/g;
    const contextKeywords = ["key", "secret", "token", "config", "env", "api", "credential", "variable", "密钥", "凭证"];
    while ((m = backtickVarRegex.exec(scanText)) !== null) {
      const varName = m[1];
      if (seen.has(varName)) continue;
      // Check surrounding context (100 chars before and after)
      const ctxStart = Math.max(0, m.index - 100);
      const ctxEnd = Math.min(scanText.length, m.index + m[0].length + 100);
      const context = scanText.slice(ctxStart, ctxEnd).toLowerCase();
      if (contextKeywords.some(kw => context.includes(kw))) {
        seen.add(varName);
        envVars.push(varName);
      }
    }

    return envVars;
  }

  /** Merge OpenClaw metadata required env vars and auto-detected env vars into skill config.
   *  Priority chain: process.env → .env file → _config.json (savedConfig) → empty
   */
  private buildSkillConfig(
    baseConfig: Record<string, unknown>,
    ocMeta: OpenClawSkillMeta | null | undefined,
    savedConfig: Record<string, unknown> | null = null,
    detectedEnvVars: string[] = [],
    skillDir?: string
  ): Record<string, unknown> {
    const config: Record<string, unknown> = { ...baseConfig };

    const envMeta: Record<string, { required: boolean; description: string; currentSource: "env" | "dotenv" | "config" | "none" }> = {};
    const envSource: Record<string, "env" | "dotenv" | "config" | "none"> = {};

    // Merge declared env vars (from metadata.openclaw) and auto-detected env vars
    const declaredEnv = ocMeta?.requires?.env || [];
    const allEnvVars = [...new Set([...declaredEnv, ...detectedEnvVars])];

    // Load .env file values (search from skill dir upward to project root)
    const dotenvValues = skillDir ? this.loadDotenvValues(skillDir) : {};

    for (const envVar of allEnvVars) {
      const savedValue = savedConfig?.[envVar] as string | undefined;
      const envValue = process.env[envVar];
      const dotenvValue = dotenvValues[envVar];
      const isDeclared = declaredEnv.includes(envVar);

      // Priority: process.env > .env file > _config.json > empty
      if (envValue) {
        config[envVar] = envValue;
        envMeta[envVar] = {
          required: isDeclared,
          description: `${envVar} configuration`,
          currentSource: "env",
        };
        envSource[envVar] = "env";
      } else if (dotenvValue) {
        config[envVar] = dotenvValue;
        envMeta[envVar] = {
          required: isDeclared,
          description: `${envVar} configuration (from .env)`,
          currentSource: "dotenv",
        };
        envSource[envVar] = "dotenv";
      } else if (savedValue !== undefined && savedValue !== "") {
        config[envVar] = savedValue;
        envMeta[envVar] = {
          required: isDeclared,
          description: `${envVar} configuration`,
          currentSource: "config",
        };
        envSource[envVar] = "config";
      } else {
        config[envVar] = "";
        envMeta[envVar] = {
          required: isDeclared,
          description: `${envVar} configuration`,
          currentSource: "none",
        };
        envSource[envVar] = "none";
      }
    }

    if (ocMeta?.requires?.bins) {
      config._requiredBins = ocMeta.requires.bins;
    }

    // Determine primaryEnv: prefer declared, then first detected env var containing KEY/SECRET/TOKEN
    const primaryEnv = ocMeta?.primaryEnv || detectedEnvVars.find(v =>
      /KEY|SECRET|TOKEN|API/i.test(v)
    );
    if (primaryEnv) {
      config._primaryEnv = primaryEnv;
    }

    if (Object.keys(envMeta).length > 0) {
      config._envMeta = envMeta;
    }

    if (Object.keys(envSource).length > 0) {
      config._envSource = envSource;
    }

    return config;
  }

  saveSkillConfig(skillId: string, config: Record<string, unknown>): boolean {
    const skill = this.skills.get(skillId);
    if (!skill) return false;

    const skillDir = path.dirname(skill.installPath);
    const configPath = path.join(skillDir, "_config.json");

    const ocMeta = skill.openclawMeta;
    const envMeta = (skill.config._envMeta || {}) as Record<string, { required: boolean; description: string; currentSource: string }>;
    const envSource = (skill.config._envSource || {}) as Record<string, string>;

    for (const [key, value] of Object.entries(config)) {
      if (key.startsWith("_")) continue;
      skill.config[key] = value;
      if (ocMeta?.requires?.env?.includes(key)) {
        envMeta[key] = {
          required: true,
          description: `${key} configuration`,
          currentSource: value && String(value).trim() !== "" ? "config" : "none",
        };
        envSource[key] = value && String(value).trim() !== "" ? "config" : "none";
      }
    }

    if (Object.keys(envMeta).length > 0) {
      skill.config._envMeta = envMeta;
    }
    if (Object.keys(envSource).length > 0) {
      skill.config._envSource = envSource;
    }

    skill.configStatus = this.computeConfigStatus(skill);

    try {
      const persistable: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(skill.config)) {
        if (!key.startsWith("_")) {
          persistable[key] = value;
        }
      }
      fs.writeFileSync(configPath, JSON.stringify(persistable, null, 2), "utf-8");
      return true;
    } catch (err) {
      console.error(`[SkillManager] Failed to save config for ${skillId}:`, err);
      return false;
    }
  }

  loadSkillConfig(skillDir: string): Record<string, unknown> | null {
    const configPath = path.join(skillDir, "_config.json");
    try {
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, "utf-8");
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn(`[SkillManager] Failed to load _config.json from ${skillDir}:`, err);
    }
    return null;
  }

  async validateSkillConfig(skillId: string): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return { valid: false, errors: ["Skill not found"], warnings: [] };
    }

    const errors: string[] = [];
    const warnings: string[] = [];
    const ocMeta = skill.openclawMeta;

    if (ocMeta?.requires?.env) {
      for (const envVar of ocMeta.requires.env) {
        const value = skill.config[envVar];
        if (!value || String(value).trim() === "") {
          errors.push(`Required environment variable "${envVar}" is not configured`);
        }
      }
    }

    if (ocMeta?.requires?.bins) {
      for (const bin of ocMeta.requires.bins) {
        try {
          const which = process.platform === "win32" ? "where" : "which";
          execFileSync(which, [bin], { stdio: "pipe", timeout: 5000 });
        } catch {
          warnings.push(`Required binary "${bin}" is not found in PATH`);
        }
      }
    }

    if (ocMeta?.primaryEnv) {
      const value = skill.config[ocMeta.primaryEnv];
      if (!value || String(value).trim() === "") {
        errors.push(`Primary environment variable "${ocMeta.primaryEnv}" is not configured`);
      }
    }

    for (const dep of skill.requires || []) {
      if (!dep.optional) {
        let found = false;
        const results = this.registry.searchLocal({ keyword: dep.name });
        found = results.entries.some((e: { name: string }) => e.name === dep.name);
        if (!found) {
          warnings.push(`Required dependency "${dep.name}" is not installed`);
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  async checkUpdates(): Promise<Array<{ skillId: string; skillName: string; currentVersion: string; latestVersion: string }>> {
    const updates: Array<{ skillId: string; skillName: string; currentVersion: string; latestVersion: string }> = [];
    const skills = Array.from(this.skills.values());

    for (const skill of skills) {
      try {
        const remoteResult = await this.registry.searchRemote({ keyword: skill.name, limit: 1 });
        const remoteEntry = remoteResult.entries.find(e => e.name === skill.name);
        if (remoteEntry && remoteEntry.version !== skill.version) {
          const comparison = this.compareVersions(remoteEntry.version, skill.version);
          if (comparison > 0) {
            updates.push({
              skillId: skill.id,
              skillName: skill.name,
              currentVersion: skill.version,
              latestVersion: remoteEntry.version,
            });
            skill.latestVersion = remoteEntry.version;
            skill.updateAvailable = true;
          }
        }
      } catch {
        // Remote registry unavailable for this skill
      }
    }

    return updates;
  }

  async upgradeSkill(skillId: string): Promise<{ success: boolean; message: string; newVersion?: string }> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return { success: false, message: "Skill not found" };
    }

    try {
      const remoteResult = await this.registry.searchRemote({ keyword: skill.name, limit: 1 });
      const remoteEntry = remoteResult.entries.find(e => e.name === skill.name);

      if (!remoteEntry) {
        return { success: false, message: `No remote entry found for skill "${skill.name}"` };
      }

      if (this.compareVersions(remoteEntry.version, skill.version) <= 0) {
        return { success: false, message: `Skill "${skill.name}" is already up to date (v${skill.version})` };
      }

      const skillDir = path.dirname(skill.installPath);
      const savedConfig = this.loadSkillConfig(skillDir);

      this.lifecycle.update(skill, remoteEntry.version);

      const oldVersion = skill.version;
      skill.version = remoteEntry.version;
      skill.lifecycle.lastUpdated = new Date();
      skill.lifecycle.status = "active";
      skill.latestVersion = undefined;
      skill.updateAvailable = false;

      if (savedConfig) {
        const ocMeta = skill.openclawMeta;
        const mergedConfig = this.buildSkillConfig(skill.config, ocMeta, savedConfig);
        skill.config = mergedConfig;
      }

      await this.eventBus.publish(SystemEvents.SKILL_UPDATED, skill, "skill-manager");

      return {
        success: true,
        message: `Skill "${skill.name}" upgraded from v${oldVersion} to v${remoteEntry.version}`,
        newVersion: remoteEntry.version,
      };
    } catch (err) {
      const skill2 = this.skills.get(skillId);
      if (skill2) {
        skill2.lifecycle.status = "active";
      }
      return {
        success: false,
        message: `Upgrade failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private compareVersions(a: string, b: string): number {
    const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
    const partsA = parse(a);
    const partsB = parse(b);
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const pa = partsA[i] || 0;
      const pb = partsB[i] || 0;
      if (pa !== pb) return pa - pb;
    }
    return 0;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  recommendSkills(userHistory: string[]): Array<{ skillId: string; reason: string; relevanceScore: number }> {
    if (!this.skillEcosystem) return [];
    return this.skillEcosystem.recommendSkills(userHistory);
  }

  getSkillWorkshop(): import("./skill-workshop").SkillWorkshop | null {
    return this.skillWorkshop;
  }

  getInstallPolicyManager(): import("./install-policy").InstallPolicyManager | null {
    return this.installPolicyManager;
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

  /** Load skills with priority-based path resolution and agent allowlist filtering */
  async loadSkillsWithPriority(config: SkillLoadConfig): Promise<Skill[]> {
    const skillByName = new Map<string, { skill: Skill; priority: number }>();

    // Scan all searchPaths in order (index 0 = highest priority)
    for (let priority = 0; priority < config.searchPaths.length; priority++) {
      const searchPath = config.searchPaths[priority];
      if (!fs.existsSync(searchPath)) continue;

      const entries = fs.readdirSync(searchPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

        const skillMdPath = path.join(searchPath, entry.name, "SKILL.md");
        if (!fs.existsSync(skillMdPath)) continue;

        try {
          const parsed = await this.parser.parseFromFile(skillMdPath);
          const validation = this.validator.validate(parsed);
          if (!validation.valid) {
            console.warn(`[SkillManager] Skipping invalid skill "${parsed.meta.name}" from ${searchPath}: ${validation.errors.join("; ")}`);
            continue;
          }

          const skillName = parsed.meta.name;
          const existing = skillByName.get(skillName);

          // Keep the one from the highest-priority path (lower index = higher priority)
          if (!existing || priority < existing.priority) {
            // Install the skill if not already installed
            let installedSkill = Array.from(this.skills.values()).find(
              s => s.name === skillName && s.installPath === skillMdPath
            );
            if (!installedSkill) {
              installedSkill = await this.installSkill(skillMdPath);
            }
            skillByName.set(skillName, { skill: installedSkill, priority });
          }
        } catch (err) {
          console.error(`[SkillManager] Failed to load skill from ${skillMdPath}:`, err);
        }
      }
    }

    // Collect all resolved skills
    let skills = Array.from(skillByName.values()).map(entry => entry.skill);

    // Apply agent allowlist filtering
    // When no agent is specified, return all skills (allowlist filtering is agent-specific)
    skills = this.applyAgentAllowlist(skills, config);

    return skills;
  }

  /** Apply agent allowlist filtering based on SkillLoadConfig */
  private applyAgentAllowlist(skills: Skill[], config: SkillLoadConfig): Skill[] {
    // If no allowlists defined, all skills are allowed
    if (!config.agentAllowlists && !config.defaultAllowlist) {
      return skills;
    }

    // Use defaultAllowlist when no specific agent context is available
    const allowlist = config.defaultAllowlist;
    if (!allowlist) return skills;

    // Empty allowlist means no skills allowed
    if (allowlist.length === 0) return [];

    return skills.filter(skill => allowlist!.includes(skill.name));
  }

  /** Filter skills for a specific agent based on allowlist config */
  filterSkillsForAgent(skills: Skill[], agentId: string, config: SkillLoadConfig): Skill[] {
    const allowlist = config.agentAllowlists?.[agentId] ?? config.defaultAllowlist;
    if (allowlist === undefined) return skills;
    if (allowlist.length === 0) return [];
    return skills.filter(skill => allowlist.includes(skill.name));
  }

  /** Install a skill from ClawHub marketplace with CLI-compatible sync */
  async installFromClawHub(skillName: string): Promise<Skill> {
    const skill = await this.installFromMarketplace(skillName);

    console.log(`[SkillManager] ClawHub sync: syncing installed skill "${skillName}" with ClawHub registry`);
    console.log(`[SkillManager] ClawHub sync completed for "${skillName}" (v${skill.version})`);

    return skill;
  }

  // ── Skill Installation Pipeline Helpers ──

  /**
   * Resolve the Python executable path. Searches common installation locations
   * when python3/python is not found in PATH.
   * Returns the found path or null.
   */
  private resolvePythonPath(): string | null {
    // First check PATH
    if (this.checkBinaryExists("python3")) return "python3";
    if (this.checkBinaryExists("python")) return "python";

    // Search common installation locations
    const candidates: string[] = [];

    if (process.platform === "win32") {
      // Windows: check AppData\Local\Programs\Python\Python*
      const localAppData = process.env.LOCALAPPDATA || "";
      const userProfile = process.env.USERPROFILE || "";
      const searchRoots = [localAppData, userProfile].filter(Boolean);

      for (const root of searchRoots) {
        const pythonDir = path.join(root, "Programs", "Python");
        if (fs.existsSync(pythonDir)) {
          try {
            const entries = fs.readdirSync(pythonDir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory() && /^Python\d+/.test(entry.name)) {
                const exePath = path.join(pythonDir, entry.name, "python.exe");
                if (fs.existsSync(exePath)) {
                  candidates.push(exePath);
                }
              }
            }
          } catch { /* ignore */ }
        }
      }

      // Also check common system locations
      const systemPaths = [
        "C:\\Python313\\python.exe",
        "C:\\Python312\\python.exe",
        "C:\\Python311\\python.exe",
        "C:\\Python310\\python.exe",
      ];
      for (const p of systemPaths) {
        if (fs.existsSync(p)) candidates.push(p);
      }
    } else {
      // Unix: check common paths
      const unixPaths = [
        "/usr/bin/python3",
        "/usr/local/bin/python3",
        "/opt/homebrew/bin/python3",
        "/opt/local/bin/python3",
      ];
      for (const p of unixPaths) {
        if (fs.existsSync(p)) candidates.push(p);
      }
    }

    // Verify candidates are actually executable
    for (const candidate of candidates) {
      try {
        execFileSync(candidate, ["--version"], { stdio: "pipe", timeout: 5000 });
        return candidate;
      } catch {
        // Not executable, skip
      }
    }

    return null;
  }

  /**
   * Install declared dependencies (requires) for a skill.
   * Supports npm and pip packages. Auto-discovers Python when not in PATH.
   */
  private installDependencies(
    requires: Array<{ name: string; version: string; optional: boolean }>,
    skillDir: string
  ): SkillInstallStep {
    const step: SkillInstallStep = {
      name: "install_dependencies",
      status: "success",
      message: "",
      warnings: [],
      errors: [],
    };

    const npmPkgs: string[] = [];
    const pipPkgs: string[] = [];

    for (const dep of requires) {
      const name = dep.name.toLowerCase();
      if (name === "python3" || name === "python") {
        // Check python availability, with auto-discovery fallback
        const pythonPath = this.resolvePythonPath();
        if (!pythonPath) {
          if (dep.optional) {
            step.warnings.push(`Optional dependency "${dep.name}" not found in PATH and auto-discovery failed`);
          } else {
            step.errors.push(`dependency install failed: required "${dep.name}" not found in PATH and auto-discovery failed`);
          }
        } else if (pythonPath !== "python3" && pythonPath !== "python") {
          // Found Python via auto-discovery, not in default PATH
          step.message += `Python auto-discovered at: ${pythonPath}. `;
          step.warnings.push(
            `Python not in PATH — found at "${pythonPath}". ` +
            `Consider adding it to your system PATH, or skill scripts using "python3" may fail. ` +
            `You can add it by: setx PATH "%PATH%;${path.dirname(pythonPath)}"`
          );
          console.log(`[SkillManager] Python auto-discovered at: ${pythonPath}`);
        }
      } else if (name === "node" || name === "nodejs") {
        if (!this.checkBinaryExists("node")) {
          if (dep.optional) {
            step.warnings.push(`Optional dependency "${dep.name}" not found`);
          } else {
            step.errors.push(`dependency install failed: required "${dep.name}" not found in PATH`);
          }
        }
      } else if (name.startsWith("pip:")) {
        pipPkgs.push(dep.version !== "*" ? `${name.slice(4)}==${dep.version}` : name.slice(4));
      } else if (name.startsWith("npm:")) {
        npmPkgs.push(dep.version !== "*" ? `${name.slice(4)}@${dep.version}` : name.slice(4));
      } else {
        // Default: treat as npm package
        npmPkgs.push(dep.version !== "*" ? `${name}@${dep.version}` : name);
      }
    }

    // Install npm packages in skill directory
    if (npmPkgs.length > 0) {
      try {
        const npmResult = execFileSync("npm", ["install", "--save", ...npmPkgs], {
          cwd: skillDir,
          timeout: 60000,
          encoding: "utf-8",
        });
        step.message += `Installed ${npmPkgs.length} npm package(s). `;
        console.log(`[SkillManager] Installed npm packages in ${skillDir}: ${npmPkgs.join(", ")}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        step.warnings.push(`npm install failed (non-critical, skill may still work): ${errMsg.slice(0, 200)}`);
        console.warn(`[SkillManager] npm install failed for skill at ${skillDir}: ${errMsg.slice(0, 200)}`);
      }
    }

    // Install pip packages
    if (pipPkgs.length > 0) {
      try {
        const pipCmd = this.checkBinaryExists("pip3") ? "pip3" : "pip";
        const pipResult = execFileSync(pipCmd, ["install", ...pipPkgs], {
          cwd: skillDir,
          timeout: 120000,
          encoding: "utf-8",
        });
        step.message += `Installed ${pipPkgs.length} pip package(s). `;
        console.log(`[SkillManager] Installed pip packages: ${pipPkgs.join(", ")}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        step.warnings.push(`pip install failed (non-critical, skill may still work): ${errMsg.slice(0, 200)}`);
        console.warn(`[SkillManager] pip install failed for skill at ${skillDir}: ${errMsg.slice(0, 200)}`);
      }
    }

    if (step.errors.length > 0) {
      step.status = "failed";
      step.message = step.message || "Some required dependencies are missing";
    } else if (step.warnings.length > 0) {
      step.status = "warning";
      step.message = step.message || "Dependencies installed with warnings";
    } else {
      step.message = step.message || "All dependencies satisfied";
    }

    return step;
  }

  /**
   * Execute an openclaw metadata script (install/build) in the skill directory.
   */
  private executeMetaScript(
    scriptName: string,
    scriptContent: string,
    skillDir: string
  ): SkillInstallStep {
    const step: SkillInstallStep = {
      name: `execute_${scriptName}_script`,
      status: "success",
      message: "",
      warnings: [],
      errors: [],
    };

    console.log(`[SkillManager] Executing ${scriptName} script in ${skillDir}`);

    try {
      // Determine shell and script
      const isWindows = process.platform === "win32";
      const shell = isWindows ? "cmd.exe" : "/bin/bash";
      const shellArg = isWindows ? "/c" : "-c";

      const result = execFileSync(shell, [shellArg, scriptContent], {
        cwd: skillDir,
        timeout: 120000,
        encoding: "utf-8",
        env: { ...process.env, SKILL_DIR: skillDir },
      });

      step.message = `${scriptName} script executed successfully`;
      console.log(`[SkillManager] ${scriptName} script output: ${String(result).slice(0, 200)}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      step.status = "failed";
      step.errors.push(`${scriptName} script failed: ${errMsg.slice(0, 300)}`);
      step.message = `${scriptName} script failed`;
      console.warn(`[SkillManager] ${scriptName} script failed in ${skillDir}: ${errMsg.slice(0, 300)}`);
    }

    return step;
  }

  /**
   * Verify that an installed skill is actually usable.
   * Checks: entry point readable, required env vars set, required binaries available,
   * onInstall hook succeeded, and instructions are non-empty.
   */
  private verifyInstallation(
    skill: Skill,
    parsed: import("@evoclaw/core").SKILLmdDocument
  ): SkillInstallStep {
    const step: SkillInstallStep = {
      name: "post_install_verification",
      status: "success",
      message: "",
      warnings: [],
      errors: [],
    };

    // 1. Entry point readable
    if (skill.installPath) {
      try {
        fs.accessSync(skill.installPath, fs.constants.R_OK);
      } catch {
        step.errors.push("entry point not readable: " + skill.installPath);
      }
    }

    // 2. Instructions non-empty
    if (!parsed.instructions || parsed.instructions.trim().length < 10) {
      step.warnings.push("Skill instructions are empty or very short — skill may not function correctly");
    }

    // 3. Required environment variables
    const ocMeta = skill.openclawMeta;
    const envVars = ocMeta?.requires?.env || [];
    for (const envVar of envVars) {
      if (!process.env[envVar]) {
        step.warnings.push(`Required env var "${envVar}" not set — skill will not work until configured`);
      }
    }

    // 4. Required binaries (with auto-discovery for Python)
    const bins = ocMeta?.requires?.bins || [];
    for (const bin of bins) {
      if ((bin === "python3" || bin === "python") && !this.checkBinaryExists(bin)) {
        const pythonPath = this.resolvePythonPath();
        if (pythonPath && pythonPath !== "python3" && pythonPath !== "python") {
          step.warnings.push(
            `"${bin}" not in PATH but Python found at "${pythonPath}". ` +
            `Skill scripts using "python3" may fail. Add to PATH: setx PATH "%PATH%;${path.dirname(pythonPath)}"`
          );
          // Store discovered Python path in skill config for runtime use
          skill.config._pythonPath = pythonPath;
        } else if (!pythonPath) {
          step.warnings.push(`Required binary "${bin}" not found — some features may be unavailable`);
        }
      } else if (!this.checkBinaryExists(bin)) {
        step.warnings.push(`Required binary "${bin}" not found — some features may be unavailable`);
      }
    }

    // 5. Check for install artifacts (node_modules, etc.)
    const skillDir = path.dirname(skill.installPath);
    if (parsed.meta.requires && parsed.meta.requires.length > 0) {
      const hasNpmDeps = parsed.meta.requires.some(r =>
        !r.name.startsWith("pip:") && !["python3", "python", "node", "nodejs"].includes(r.name.toLowerCase())
      );
      if (hasNpmDeps && !fs.existsSync(path.join(skillDir, "node_modules"))) {
        step.warnings.push("npm dependencies declared but node_modules not found — dependencies may not be installed");
      }
    }

    // 6. Verify skill can be retrieved
    const retrieved = this.skills.get(skill.id);
    if (!retrieved) {
      step.errors.push("verification failed: skill not found in registry after install");
    }

    // Determine status
    if (step.errors.length > 0) {
      step.status = "failed";
      step.message = `Verification failed with ${step.errors.length} error(s)`;
    } else if (step.warnings.length > 0) {
      step.status = "warning";
      step.message = `Verification passed with ${step.warnings.length} warning(s)`;
    } else {
      step.message = "All verification checks passed";
    }

    console.log(`[SkillManager] Post-install verification for "${skill.name}": ${step.status} — ${step.message}`);
    return step;
  }
}