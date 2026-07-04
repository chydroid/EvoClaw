/**
 * Skill installation and file download logic, extracted from AgentModelExecutor.
 *
 * All methods are standalone exported functions that receive a `SkillInstallerDeps`
 * object instead of accessing class members via `this`.
 */

import type { ServiceRegistry } from "@evoclaw/core";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";

// ─── Result types ─────────────────────────────────────────────────────────────

export interface SkillInstallResult {
  reply: string;
  tokensUsed: number;
  duration: number;
  permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>;
  toolsExecuted: boolean;
}

export interface ApiKeyConfigResult {
  skillId: string;
  configured: boolean;
  message: string;
}

export interface DownloadAndExtractResult {
  skillPath: string | null;
  error?: string;
}

// ─── Dependencies interface ────────────────────────────────────────────────────

export interface SkillInstallerDeps {
  registry: ServiceRegistry;
  workspacePath: string;
}

// ─── Skill install entry point ────────────────────────────────────────────────

export async function handleSkillInstall(
  deps: SkillInstallerDeps,
  message: string,
  skillManager: { searchLocalSkills(query: Record<string, unknown>): Promise<unknown>; listSkills(): unknown[]; installSkill?(path: string): Promise<unknown> } | undefined,
  startTime: number,
  _sessionId: string
): Promise<SkillInstallResult | null> {
  try {
    // Get currently installed skills
    const installedSkills = await skillManager?.listSkills() || [];
    const installedNames = new Set(
      (installedSkills as Array<Record<string, unknown>>)
        .map((s) => (s.name as string) || "")
        .filter(Boolean)
    );

    // ── Detect if user wants to install specific skills ──
    // Match: "安装 weather, translator" or "安装 skill1 skill2"
    const specificSkillMatch = message.match(/(?:安装|下载|添加)\s*(?:技能)?\s*[:：]?\s*(.+)/i);
    const selectedSkills = extractSkillNames(message, specificSkillMatch);

    // ── Extract API key from user message ──
    const extractedApiKey = extractApiKey(message);

    // ── "查找并安装"复合请求：用户描述任务需求，由系统搜索并安装 ──
    // 匹配 "查找可以查询股市行情的技能并安装"、"找一个能翻译的技能装上" 等模式。
    // 必须在 batch install 之前处理，否则 "查找可以..." 会被识别为技能名（实际会被过滤）。
    const findAndInstallMatch = message.match(
      /(?:帮\s*我\s*)?(?:查找?|找一下|搜索|查一下|看看|有没有|需要|想要).{0,20}?(?:能够?|可以|能|会)?(.+?)(?:的|之)?(?:技能|skill).{0,10}?(?:并\s*)?(?:安装|下载|添加|装(?:上|一下)?)/i
    );
    if (findAndInstallMatch && findAndInstallMatch[1]) {
      const taskDescription = findAndInstallMatch[1].trim();
      if (taskDescription.length >= 2) {
        const result = await handleFindAndInstall(deps, taskDescription, installedNames, startTime, extractedApiKey);
        if (result) return result;
        // 若搜索未找到匹配，继续走 browse 模式让用户手动选
      }
    }

    // ── Batch install mode ──
    if (selectedSkills.length > 0) {
      return await handleBatchSkillInstall(deps, selectedSkills, installedNames, startTime, extractedApiKey);
    }

    // ── If message contains URLs but we couldn't extract them, fall through to LLM ──
    // Regex-based parsing is fragile for natural language; the LLM can understand
    // complex intent and use skill_search/skill_install tools to handle it properly.
    if (/https?:\/\//i.test(message)) {
      process.stdout.write(`[AgentModelExecutor] Skill install request contains URLs but extraction failed, falling through to LLM\n`);
      return null;
    }

    // ── 本地 ZIP 扫描模式：用户放入 ZIP 到 data/skills/ 后说"安装技能" ──
    // 扫描 data/skills/*.zip，解压并安装。安装成功后删除 ZIP 文件避免重复扫描。
    // 仅在用户明确说"安装技能"且未指定具体技能名/URL 时触发。
    const localZipResult = await scanAndInstallLocalZips(deps, startTime);
    if (localZipResult) {
      return localZipResult;
    }

    // ── Browse mode: show available skills ──
    // Use SkillDispatcher for comprehensive skill discovery
    const skillDispatcher = deps.registry?.resolveService<{
      getSkillSummary(): Promise<{
        local: Array<{ name: string; description: string; version: string }>;
        remote: Array<{ name: string; description: string; rating: number; downloads: number }>;
        installed: Array<{ name: string; id: string }>;
      }>;
      searchForTask(task: string, max?: number): Promise<Array<{ skillName: string; description?: string; relevance: number; source: string }>>;
    }>("skillDispatcher");

    let localSkills: Array<{ name: string; path?: string; description: string; version: string }> = [];
    let remoteSkills: Array<{ name: string; description: string; rating: number; downloads: number }> = [];

    if (skillDispatcher) {
      try {
        const summary = await skillDispatcher.getSkillSummary();
        const installedFromSummary = new Set(summary.installed.map(s => s.name));
        // Merge installedNames
        for (const s of summary.installed) { installedNames.add(s.name); }
        localSkills = summary.local.filter(s => !installedFromSummary.has(s.name));
        remoteSkills = summary.remote.filter(s => !installedFromSummary.has(s.name) && !localSkills.some(l => l.name === s.name));
      } catch (err) {
        process.stderr.write(`[AgentModelExecutor] SkillDispatcher summary failed: ${err}\n`);
      }
    }

    // Fallback: use registry directly
    if (remoteSkills.length === 0) {
      try {
        const skillRegistry = deps.registry?.resolveService<{
          searchRemote(query: Record<string, unknown>): Promise<{ entries: Array<{ name: string; description: string; version: string; rating: number; downloads: number; category: string }> }>;
        }>("skillRegistry");

        if (skillRegistry) {
          const result = await skillRegistry.searchRemote({ keyword: "", limit: 30, sortBy: "downloads" });
          if (result?.entries) {
            remoteSkills = result.entries
              .filter((s: { name: string }) => !installedNames.has(s.name))
              .map((s: { name: string; description: string; rating: number; downloads: number }) => ({
                name: s.name,
                description: s.description,
                rating: s.rating,
                downloads: s.downloads,
              }));
          }
        }
      } catch (err) {
        process.stderr.write(`[AgentModelExecutor] Remote skill search failed: ${err}\n`);
      }
    }

    // Fallback: use AutoSkillManager for local discoverable skills
    if (localSkills.length === 0) {
      const autoSkillManager = deps.registry?.resolveService<{
        listDiscoverableSkills(): Array<{ name: string; path: string; description: string; version: string }>;
      }>("autoSkillManager");
      if (autoSkillManager) {
        localSkills = autoSkillManager.listDiscoverableSkills()
          .filter(s => !installedNames.has(s.name));
      }
    }

    // Merge remote into unified list (remote not in local)
    const seenNames = new Set(localSkills.map(s => s.name));
    const allAvailable = [
      ...localSkills.map(s => ({ name: s.name, description: s.description, version: s.version, rating: 0, downloads: 0, source: "本地" as const })),
      ...remoteSkills.filter(s => !seenNames.has(s.name)).map(s => ({ name: s.name, description: s.description, version: "0.1.0", rating: s.rating, downloads: s.downloads, source: "远端" as const })),
    ];

    // Sort: local first, then by downloads
    allAvailable.sort((a, b) => {
      if (a.source !== b.source) return a.source === "本地" ? -1 : 1;
      return b.downloads - a.downloads;
    });

    const notInstalled = allAvailable.filter(s => !installedNames.has(s.name));

    if (notInstalled.length === 0) {
      return {
        reply: "✅ 所有可发现的技能已经安装完成！\n\n当前已安装: " +
               Array.from(installedNames).map(n => `\`${n}\``).join(", ") +
               "\n\n需要特定技能请告诉我名称，或描述任务我会自动匹配合适的技能。",
        tokensUsed: 0,
        duration: Date.now() - startTime,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }

    // Build response with rich formatting
    let reply = "📦 **技能安装助手**\n\n";
    reply += `发现 **${notInstalled.length}** 个可安装技能：\n\n`;

    // Group: local first, then remote
    const localAvailable = notInstalled.filter(s => s.source === "本地");
    const remoteAvailable = notInstalled.filter(s => s.source === "远端");

    if (localAvailable.length > 0) {
      reply += "📁 **本地可用技能**\n";
      localAvailable.forEach((skill, i) => {
        reply += `${i + 1}. **\`${skill.name}\`** - ${skill.description || "无描述"}\n`;
      });
      reply += "\n";
    }

    if (remoteAvailable.length > 0) {
      reply += "🌐 **远端注册表技能**\n";
      remoteAvailable.forEach((skill, i) => {
        const stars = "★".repeat(Math.min(5, Math.floor(skill.rating))) + "☆".repeat(Math.max(0, 5 - Math.floor(skill.rating)));
        const label = skill.downloads > 20000 ? "🔥" : skill.downloads > 10000 ? "⭐" : "📌";
        reply += `${i + 1}. **\`${skill.name}\`** ${label} ${stars} (${(skill.downloads/1000).toFixed(0)}k) - ${skill.description || "无描述"}\n`;
      });
      reply += "\n";
    }

    reply += "---\n";
    reply += "💡 **安装方式**:\n";
    reply += "• 回复技能名安装: `安装 weather`\n";
    reply += "• 批量安装: `安装 weather, translator, news-search`\n";
    reply += "• 全部安装: `全部安装` 或 `install all`\n\n";
    reply += "已安装: " + (installedNames.size > 0 ? Array.from(installedNames).map(n => `\`${n}\``).join(", ") : "无") + "\n";

    return {
      reply,
      tokensUsed: 0,
      duration: Date.now() - startTime,
      permissionRequests: [],
      toolsExecuted: false,
    };
  } catch (err) {
    return {
      reply: `❌ 获取技能列表时出错: ${err instanceof Error ? err.message : String(err)}`,
      tokensUsed: 0,
      duration: Date.now() - startTime,
      permissionRequests: [],
      toolsExecuted: false,
    };
  }
}

// ─── Extract skill names / URLs ───────────────────────────────────────────────

/**
 * Extract skill names or URLs from user message for batch install.
 * Supports: skill names, URLs ending in .zip, backtick-wrapped URLs.
 */
export function extractSkillNames(message: string, regexMatch: RegExpMatchArray | null): string[] {
  const names: string[] = [];

  // "全部安装" or "install all" → return empty (caller handles)
  if (/全部安装|install\s+all|安装所有/i.test(message)) {
    return ["__ALL__"];
  }

  // ── Phase 1: Extract URLs from message ──
  // Match URLs ending in .zip (with optional parenthesized label after)
  // e.g. https://example.com/skill.zip(行情数据) or https://example.com/skill.zip
  const urlPattern = /https?:\/\/[^\s`<>]+\.(?:zip|tar\.gz|tgz)(?:\([^)]*\))?/g;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlPattern.exec(message)) !== null) {
    const rawUrl = urlMatch[0];
    // Strip trailing parenthesized label like (行情数据)
    const cleanUrl = rawUrl.replace(/\([^)]*\)$/, "");
    names.push(cleanUrl);
  }

  // If URLs were found, return them directly (URL-based install mode)
  if (names.length > 0) {
    return names;
  }

  // ── Phase 2: Extract skill names from text ──
  if (regexMatch && regexMatch[1]) {
    // Strip trailing punctuation and noise
    let raw = regexMatch[1].trim();
    // Remove trailing sentence-ending punctuation
    raw = raw.replace(/[。.!！?？]+$/, "").trim();
    // Remove trailing ", etc" or similar
    raw = raw.replace(/[,，]\s*(etc|等等|之类的)\s*$/i, "").trim();

    // Split by Chinese/English commas, Chinese enumeration markers, or whitespace
    const parts = raw.split(/[,，、，\s]+/).filter(Boolean);
    for (const part of parts) {
      const clean = part.trim();
      if (clean.length < 2) continue;
      // Expanded noise word filter — includes demonstratives, quantifiers, and common phrases
      if (/^(技能|skill|skills?|一个|几个|这些|那些|这个|哪个|帮我|给我|请|需要|以下|下面|这些|那|的|和|与|及|等|还有|并且|同时|相同|跟|有关|使用|配置|设置)$/i.test(clean)) continue;
      // Filter out pure Chinese phrases that are unlikely to be skill names
      // (skill names in this ecosystem use ASCII alphanumeric identifiers)
      if (/^[\u4e00-\u9fff]{2,}$/.test(clean)) continue;
      // Filter out phrases that look like natural language (contain Chinese + other chars mixed in non-identifier ways)
      if (/^[\u4e00-\u9fff]/.test(clean) && !/^[a-zA-Z0-9_\-]+$/.test(clean)) continue;
      names.push(clean);
    }
  }

  // Also try to extract skill names from pattern like "安装 skill1 skill2"
  const altMatch = message.match(/安装\s+([\w-]+(?:\s+[\w-]+)*)/i);
  if (altMatch && names.length === 0) {
    const parts = altMatch[1].split(/\s+/).filter(s => s.length >= 2 && s !== "技能" && s !== "skill");
    names.push(...parts);
  }

  return names;
}

// ─── Extract API key ──────────────────────────────────────────────────────────

/**
 * Extract API key from user message.
 * Matches patterns like "API key为xxx", "API key: xxx", "apikey=xxx", "密钥是xxx", etc.
 */
export function extractApiKey(message: string): string | null {
  // Pattern 1: "API key为/是/=: value" (Chinese-style)
  const cnMatch = message.match(/(?:API\s*key|api\s*key|密钥|apikey|api_key)\s*(?:为|是|=|[:：])\s*([A-Za-z0-9+/=._\-]{16,})/i);
  if (cnMatch) return cnMatch[1];

  // Pattern 2: "key为/是/=: value" (short form)
  const shortMatch = message.match(/(?:key|KEY)\s*(?:为|是|=|[:：])\s*([A-Za-z0-9+/=._\-]{16,})/i);
  if (shortMatch) return shortMatch[1];

  // Pattern 3: Standalone long base64-like string after "key" keyword
  const base64Match = message.match(/(?:API\s*key|api\s*key|密钥|apikey|api_key)\s*(?:为|是|=|[:：])\s*([A-Za-z0-9+/]{20,}={0,3})/i);
  if (base64Match) return base64Match[1];

  return null;
}

// ─── Configure skill API key ──────────────────────────────────────────────────

/**
 * Configure API key for installed skills.
 * Writes to skill's _config.json and/or external config files declared in SKILL.md.
 */
export async function configureSkillApiKey(deps: SkillInstallerDeps, skillIds: string[], apiKey: string): Promise<ApiKeyConfigResult[]> {
  const results: ApiKeyConfigResult[] = [];

  for (const skillId of skillIds) {
    try {
      const skillManager = deps.registry?.resolveService<{
        getSkill(id: string): Promise<{ id: string; name: string; installPath: string; config: Record<string, unknown>; openclawMeta?: { requires?: { env?: string[] }; primaryEnv?: string } } | undefined>;
        saveSkillConfig(id: string, config: Record<string, unknown>): boolean;
      }>("skillManager");

      if (!skillManager) {
        results.push({ skillId, configured: false, message: "技能管理器未就绪" });
        continue;
      }

      const skill = await skillManager.getSkill(skillId);
      if (!skill) {
        results.push({ skillId, configured: false, message: "技能未找到" });
        continue;
      }

      // 1. Write to skill's _config.json (for skills that declare env vars in openclawMeta)
      const envVars = skill.openclawMeta?.requires?.env || [];
      const primaryEnv = skill.openclawMeta?.primaryEnv;
      const configUpdate: Record<string, unknown> = { ...skill.config };

      // Set the API key for all declared env vars that look like API key fields
      for (const envVar of envVars) {
        if (/API.?KEY|SECRET|TOKEN|CREDENTIAL/i.test(envVar) || envVar === primaryEnv) {
          configUpdate[envVar] = apiKey;
        }
      }

      // If no specific env vars, try common patterns
      if (envVars.length === 0) {
        // Look for existing config keys that look like API key fields
        for (const key of Object.keys(configUpdate)) {
          if (/API.?KEY|SECRET|TOKEN|CREDENTIAL/i.test(key)) {
            configUpdate[key] = apiKey;
          }
        }
      }

      skillManager.saveSkillConfig(skillId, configUpdate);

      // 2. Write to external config files declared in SKILL.md
      // Parse SKILL.md for credential file paths and field names
      const skillDir = path.dirname(skill.installPath);
      const skillMdPath = path.join(skillDir, "SKILL.md");
      if (fs.existsSync(skillMdPath)) {
        const skillMd = fs.readFileSync(skillMdPath, "utf-8");

        // Match patterns like:
        //   凭证文件: ~/.config/ciccwm/config.json
        //   凭证字段: CICCWM_API_KEY
        const configFileMatch = skillMd.match(/凭证文件\s*[:：]\s*(.+)/);
        const configFieldMatch = skillMd.match(/凭证字段\s*[:：]\s*(\w+)/);

        if (configFileMatch && configFieldMatch) {
          let configPath = configFileMatch[1].trim();
          const fieldName = configFieldMatch[1].trim();

          // Expand ~ to home directory
          if (configPath.startsWith("~")) {
            configPath = path.join(process.env.HOME || process.env.USERPROFILE || "", configPath.slice(1));
          }

          // Ensure directory exists
          const configDir = path.dirname(configPath);
          if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
          }

          // Read existing config or create new one
          let existingConfig: Record<string, unknown> = {};
          if (fs.existsSync(configPath)) {
            try {
              existingConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            } catch { /* ignore parse errors */ }
          }

          existingConfig[fieldName] = apiKey;
          fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 2), "utf-8");

          results.push({ skillId, configured: true, message: `已配置 ${fieldName} 到 ${configPath}` });
        } else {
          results.push({ skillId, configured: true, message: "已保存到技能配置" });
        }
      } else {
        results.push({ skillId, configured: true, message: "已保存到技能配置" });
      }
    } catch (err) {
      results.push({ skillId, configured: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return results;
}

// ─── Batch skill install ──────────────────────────────────────────────────────

/**
 * Handle "find and install" compound requests.
 * User describes a task (e.g. "查询股市行情"), system searches ClawHub marketplace
 * for matching skills, lists candidates, and auto-installs if only one match found.
 *
 * Returns null if no match found (caller should fall through to browse mode).
 */
export async function handleFindAndInstall(
  deps: SkillInstallerDeps,
  taskDescription: string,
  installedNames: Set<string>,
  startTime: number,
  _apiKey?: string | null
): Promise<SkillInstallResult | null> {
  process.stdout.write(`[SkillInstaller] findAndInstall: taskDescription="${taskDescription}"\n`);

  // 通过 SkillMarketplace.searchRemote 搜索 ClawHub
  type MarketplaceLike = {
    searchRemote(query: string, limit?: number): Promise<Array<{
      slug: string;
      displayName: string;
      summary?: string;
    }>>;
    install(name: string): Promise<{ success: boolean; error?: string; installedPath?: string }>;
  };
  const skillManager = deps.registry?.resolveService<{
    getMarketplace(): MarketplaceLike;
  }>("skillManager");

  if (!skillManager) {
    return null;
  }

  let marketplace: MarketplaceLike | null = null;
  try {
    marketplace = skillManager.getMarketplace();
  } catch {
    marketplace = null;
  }
  if (!marketplace) return null;

  // 搜索 ClawHub（用任务描述作为关键词）
  let results: Array<{ slug: string; displayName: string; summary?: string }> = [];
  try {
    results = await marketplace.searchRemote(taskDescription, 10);
  } catch (err) {
    process.stderr.write(`[SkillInstaller] findAndInstall search failed: ${err}\n`);
    return null;
  }

  // 过滤已安装的
  const candidates = results.filter(r => !installedNames.has(r.slug));
  if (candidates.length === 0) {
    return null;
  }

  // 如果只有一个匹配，直接安装
  if (candidates.length === 1) {
    const skill = candidates[0];
    process.stdout.write(`[SkillInstaller] findAndInstall: single match "${skill.slug}", installing...\n`);
    try {
      const installResult = await marketplace.install(skill.slug);
      if (installResult.success) {
        return {
          reply: `🔍 根据您的需求「${taskDescription}」找到技能：\n\n**\`${skill.slug}\`** — ${skill.summary || skill.displayName || "无描述"}\n\n✅ 已自动安装成功\n\n您现在可以使用该技能处理相关任务了。`,
          tokensUsed: 0,
          duration: Date.now() - startTime,
          permissionRequests: [],
          toolsExecuted: false,
        };
      } else {
        return {
          reply: `🔍 根据您的需求「${taskDescription}」找到技能：**\`${skill.slug}\`**\n\n❌ 安装失败：${installResult.error || "未知错误"}\n\n请稍后重试，或在技能管理页面手动安装。`,
          tokensUsed: 0,
          duration: Date.now() - startTime,
          permissionRequests: [],
          toolsExecuted: false,
        };
      }
    } catch (err) {
      return {
        reply: `🔍 根据您的需求「${taskDescription}」找到技能：**\`${skill.slug}\`**\n\n❌ 安装出错：${err instanceof Error ? err.message : String(err)}`,
        tokensUsed: 0,
        duration: Date.now() - startTime,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }
  }

  // 多个匹配：列出让用户选择
  let reply = `🔍 根据您的需求「${taskDescription}」找到 **${candidates.length}** 个相关技能：\n\n`;
  candidates.forEach((skill, i) => {
    reply += `${i + 1}. **\`${skill.slug}\`** — ${skill.summary || skill.displayName || "无描述"}\n`;
  });
  reply += `\n💡 回复 \`安装 <技能名>\` 选择安装，例如：\`安装 ${candidates[0].slug}\`\n`;
  const batchExample = candidates.slice(0, 3).map(s => s.slug).join(", ");
  reply += `或批量安装：\`安装 ${batchExample}\``;
  return {
    reply,
    tokensUsed: 0,
    duration: Date.now() - startTime,
    permissionRequests: [],
    toolsExecuted: false,
  };
}

/**
 * Scan local skills/ directory for ZIP files and install them.
 * Triggered when user explicitly says "安装技能" without specifying names or URLs.
 * Scans data/skills/*.zip for valid SKILL.md archives and installs them in one pass.
 *
 * Returns null if no ZIP files found (caller should continue to other install modes).
 */
export async function scanAndInstallLocalZips(
  deps: SkillInstallerDeps,
  startTime: number
): Promise<SkillInstallResult | null> {
  const skillsDir = path.resolve(deps.workspacePath, "data", "skills");
  if (!fs.existsSync(skillsDir)) return null;

  let zipFiles: string[] = [];
  try {
    zipFiles = fs.readdirSync(skillsDir)
      .filter(f => f.toLowerCase().endsWith(".zip"))
      .map(f => path.join(skillsDir, f));
  } catch {
    return null;
  }

  if (zipFiles.length === 0) return null;

  process.stdout.write(`[SkillInstaller] Found ${zipFiles.length} ZIP file(s) in skills/, installing...\n`);

  const skillManager = deps.registry?.resolveService<{
    installSkill(path: string): Promise<{ name: string }>;
  }>("skillManager");

  if (!skillManager) {
    return null;
  }

  const successList: string[] = [];
  const failList: Array<{ name: string; reason: string }> = [];
  const progressLines: string[] = [];
  const total = zipFiles.length;

  for (let i = 0; i < zipFiles.length; i++) {
    const zipPath = zipFiles[i];
    const idx = i + 1;
    const displayName = path.basename(zipPath, ".zip");

    progressLines.push(`⏳ [${idx}/${total}] 正在解压 ${displayName}...`);

    try {
      // 直接解压本地 ZIP 文件到临时目录，查找 SKILL.md
      const extractDir = path.resolve(deps.workspacePath, "..", "skills", `_zip_${displayName}_${Date.now()}`);
      if (!fs.existsSync(extractDir)) {
        fs.mkdirSync(extractDir, { recursive: true });
      }

      await extractZip(zipPath, extractDir);

      const skillMdPath = findSkillMd(extractDir, displayName);
      if (!skillMdPath) {
        // 清理临时目录
        try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
        failList.push({ name: displayName, reason: "ZIP 中未找到 SKILL.md" });
        progressLines.push(`❌ [${idx}/${total}] ${displayName}: ZIP 中未找到 SKILL.md`);
        continue;
      }

      const installed = await skillManager.installSkill(skillMdPath);
      successList.push(installed.name);
      progressLines.push(`✅ [${idx}/${total}] ${installed.name} 安装成功`);

      // 安装成功后删除 ZIP 文件（避免重复扫描）
      try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failList.push({ name: displayName, reason });
      progressLines.push(`❌ [${idx}/${total}] ${displayName}: ${reason}`);
    }
  }

  // 如果全部失败，返回失败汇总
  if (successList.length === 0) {
    return {
      reply: `📦 扫描 \`data/skills/\` 目录发现 ${zipFiles.length} 个 ZIP 文件，但全部安装失败：\n\n` +
             progressLines.join("\n") +
             `\n\n❌ 失败原因：` + failList.map(f => `${f.name}: ${f.reason}`).join("; "),
      tokensUsed: 0,
      duration: Date.now() - startTime,
      permissionRequests: [],
      toolsExecuted: false,
    };
  }

  let reply = `📦 已扫描 \`data/skills/\` 目录并安装 ${successList.length}/${total} 个技能：\n\n`;
  reply += progressLines.join("\n");
  if (failList.length > 0) {
    reply += `\n\n⚠️ ${failList.length} 个失败：` + failList.map(f => `${f.name} (${f.reason})`).join(", ");
  }
  return {
    reply,
    tokensUsed: 0,
    duration: Date.now() - startTime,
    permissionRequests: [],
    toolsExecuted: true,
  };
}

/**
 * Handle batch installation of specific skills.
 * Supports both skill names and URLs (http/https ending in .zip).
 */
export async function handleBatchSkillInstall(
  deps: SkillInstallerDeps,
  selectedSkills: string[],
  installedNames: Set<string>,
  startTime: number,
  apiKey?: string | null
): Promise<SkillInstallResult> {
  // "全部安装" special case
  if (selectedSkills.length === 1 && selectedSkills[0] === "__ALL__") {
    const autoSkillManager = deps.registry?.resolveService<{
      listDiscoverableSkills(): Array<{ name: string }>;
    }>("autoSkillManager");

    if (autoSkillManager) {
      const all = autoSkillManager.listDiscoverableSkills()
        .map(s => s.name)
        .filter(n => !installedNames.has(n));
      selectedSkills = all;
    } else {
      // Fallback: try skillManager's list
      const sm = deps.registry?.resolveService<{
        listSkills(): Array<{ name: string }>;
      }>("skillManager");
      if (sm) {
        selectedSkills = sm.listSkills().map(s => s.name).filter(n => !installedNames.has(n));
      }
    }

    if (selectedSkills.length === 0) {
      return {
        reply: "❌ 没有找到可安装的技能。请先确保 `skills/` 目录下有 SKILL.md 文件。",
        tokensUsed: 0,
        duration: Date.now() - startTime,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }
  }

  // Separate URL-based skills from name-based skills
  const urlSkills = selectedSkills.filter(s => /^https?:\/\//i.test(s));
  const nameSkills = selectedSkills.filter(s => !/^https?:\/\//i.test(s));

  const successList: string[] = [];
  const failList: Array<{ name: string; reason: string }> = [];
  const progressLines: string[] = [];
  const total = selectedSkills.length;

  // ── Install URL-based skills (download zip, extract, install) ──
  for (let i = 0; i < urlSkills.length; i++) {
    const url = urlSkills[i];
    const idx = i + 1;
    // Extract skill name from URL for display
    const urlBasename = path.basename(new URL(url).pathname, ".zip");
    const displayName = urlBasename || url;

    progressLines.push(`⏳ [${idx}/${total}] 正在下载 ${displayName}...`);

    try {
      const result = await downloadAndExtractSkill(deps, url);
      if (!result.skillPath) {
        const reason = result.error || "未知错误";
        failList.push({ name: displayName, reason });
        progressLines.push(`❌ [${idx}/${total}] ${displayName}: ${reason}`);
        continue;
      }

      // Install from extracted path
      const skillManager = deps.registry?.resolveService<{
        installSkill(path: string): Promise<{ name: string }>;
      }>("skillManager");

      if (!skillManager) {
        failList.push({ name: displayName, reason: "技能管理器未就绪" });
        progressLines.push(`❌ [${idx}/${total}] ${displayName}: 技能管理器未就绪`);
        continue;
      }

      const installed = await skillManager.installSkill(result.skillPath);
      successList.push(installed.name);
      progressLines.push(`✅ [${idx}/${total}] ${installed.name} 安装成功`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failList.push({ name: displayName, reason });
      progressLines.push(`❌ [${idx}/${total}] ${displayName} ${reason}`);
    }
  }

  // ── Install name-based skills ──
  const toInstall = nameSkills.filter(s => !installedNames.has(s));

  if (toInstall.length > 0) {
    // Use AutoSkillManager for batch install of name-based skills
    const autoSkillManager = deps.registry?.resolveService<{
      batchInstall(names: string[], onProgress?: (p: { phase: string; current: number; total: number; skillName: string; status: string; message: string }) => void): Promise<{
        success: Array<{ skillName: string }>;
        failed: Array<{ name: string; reason: string }>;
      }>;
    }>("autoSkillManager");

    if (autoSkillManager) {
      const nameOffset = urlSkills.length;
      const result = await autoSkillManager.batchInstall(toInstall, (progress) => {
        const icon = progress.status === "installed" ? "✅" : progress.status === "failed" ? "❌" : progress.status === "installing" ? "⏳" : "📌";
        const globalIdx = nameOffset + progress.current;
        progressLines.push(`${icon} [${globalIdx}/${total}] ${progress.message}`);
      });

      result.success.forEach(s => successList.push(s.skillName));
      failList.push(...result.failed);
    } else {
      // Fallback: try installing one by one via skillManager
      const sm = deps.registry?.resolveService<{
        installSkill(path: string): Promise<{ name: string }>;
      }>("skillManager");

      const nameOffset = urlSkills.length;
      for (let i = 0; i < toInstall.length; i++) {
        const name = toInstall[i];
        const globalIdx = nameOffset + i + 1;
        progressLines.push(`⏳ [${globalIdx}/${total}] 正在安装 ${name}...`);

        try {
          let skillPath: string | null = null;
          const autoSm = deps.registry?.resolveService<{
            listDiscoverableSkills(): Array<{ name: string; path: string }>;
          }>("autoSkillManager");

          if (autoSm) {
            const found = autoSm.listDiscoverableSkills().find(s => s.name === name);
            if (found) skillPath = found.path;
          }

          if (!skillPath) {
            failList.push({ name, reason: "未找到技能文件" });
            progressLines.push(`❌ [${globalIdx}/${total}] 未找到技能 "${name}"`);
            continue;
          }

          if (sm) {
            const installed = await sm.installSkill(skillPath);
            successList.push(installed.name);
            progressLines.push(`✅ [${globalIdx}/${total}] ${installed.name} 安装成功`);
          } else {
            failList.push({ name, reason: "技能管理器未就绪" });
            progressLines.push(`❌ [${globalIdx}/${total}] 技能管理器未就绪`);
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          failList.push({ name, reason });
          progressLines.push(`❌ [${globalIdx}/${total}] ${name}: ${reason}`);
        }
      }
    }
  }

  // ── Configure API key if provided ──
  const apiKeyConfigLines: string[] = [];
  if (apiKey && successList.length > 0) {
    try {
      const skillManager = deps.registry?.resolveService<{
        listSkills(): Promise<Array<{ id: string; name: string }>>;
      }>("skillManager");

      if (skillManager) {
        const allSkills = await skillManager.listSkills();
        // Find skill IDs for successfully installed skills
        const installedSkillIds = allSkills
          .filter(s => successList.includes(s.name))
          .map(s => s.id);

        if (installedSkillIds.length > 0) {
          const configResults = await configureSkillApiKey(deps, installedSkillIds, apiKey);
          for (const r of configResults) {
            if (r.configured) {
              apiKeyConfigLines.push(`  🔑 ${r.message}`);
            } else {
              apiKeyConfigLines.push(`  ⚠️ API Key 配置失败: ${r.message}`);
            }
          }
        }
      }
    } catch (err) {
      apiKeyConfigLines.push(`  ⚠️ API Key 配置异常: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (!apiKey && successList.length > 0) {
    // Check if any installed skills require API keys
    try {
      const skillManager = deps.registry?.resolveService<{
        listSkills(): Promise<Array<{ id: string; name: string; configStatus: string; openclawMeta?: { requires?: { env?: string[] } } }>>;
      }>("skillManager");

      if (skillManager) {
        const allSkills = await skillManager.listSkills();
        const needsKey = allSkills.filter(s =>
          successList.includes(s.name) &&
          (s.configStatus === "unconfigured" || s.configStatus === "partial")
        );
        if (needsKey.length > 0) {
          apiKeyConfigLines.push(`  💡 提示: ${needsKey.length} 个技能需要配置 API Key。请在技能管理页面配置，或发送 "安装技能 ... API key为xxx"`);
        }
      }
    } catch { /* ignore */ }
  }

  // Build result reply
  let reply = `📦 **批量安装结果**\n\n`;

  if (successList.length > 0) {
    reply += `✅ 成功安装 **${successList.length}** 个技能:\n`;
    successList.forEach(s => {
      reply += `  • \`${s}\`\n`;
    });
  }

  if (failList.length > 0) {
    reply += `\n❌ **${failList.length}** 个失败:\n`;
    failList.forEach(f => {
      reply += `  • \`${f.name}\`: ${f.reason}\n`;
    });
  }

  if (apiKeyConfigLines.length > 0) {
    reply += `\n🔑 **API Key 配置**:\n`;
    apiKeyConfigLines.forEach(l => { reply += `${l}\n`; });
  }

  reply += `\n---\n<details><summary>📋 安装进度</summary>\n\n${progressLines.join("\n")}\n</details>`;

  return {
    reply,
    tokensUsed: 0,
    duration: Date.now() - startTime,
    permissionRequests: [],
    toolsExecuted: true,
  };
}

// ─── Download and extract skill ZIP ───────────────────────────────────────────

/**
 * Download a skill zip from URL, extract it to the skills directory,
 * and return the path to the SKILL.md file with detailed error info.
 */
export async function downloadAndExtractSkill(deps: SkillInstallerDeps, url: string): Promise<DownloadAndExtractResult> {
  // Determine skills directory (workspacePath is typically data/workspace, skills live under data/skills)
  const workspaceDir = deps.workspacePath;
  const skillsDir = path.resolve(workspaceDir, "..", "skills");
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Extract skill name from URL
  const urlPath = new URL(url).pathname;
  const zipBasename = path.basename(urlPath, ".zip") || `skill-${Date.now()}`;
  const zipPath = path.join(skillsDir, `${zipBasename}.zip`);

  // ── Step 1: Download ──
  process.stdout.write(`[AgentModelExecutor] Downloading skill from: ${url}\n`);
  try {
    await downloadFile(url, zipPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { skillPath: null, error: `下载失败: ${msg}。请检查URL是否正确及网络是否可达` };
  }

  // Verify download succeeded
  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
    return { skillPath: null, error: `下载失败: 文件为空或未保存到 ${zipPath}` };
  }
  const fileSize = fs.statSync(zipPath).size;
  process.stdout.write(`[AgentModelExecutor] Downloaded ${fileSize} bytes to ${zipPath}\n`);

  // ── Step 2: Extract ──
  process.stdout.write(`[AgentModelExecutor] Extracting skill to: ${skillsDir}\n`);
  try {
    await extractZip(zipPath, skillsDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Clean up the zip file on extraction failure
    try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
    return { skillPath: null, error: `解压失败: ${msg}。已下载 ${fileSize} 字节但无法解压` };
  }

  // Clean up the zip file
  try { fs.unlinkSync(zipPath); } catch { /* ignore */ }

  // ── Step 3: Find SKILL.md ──
  const skillMdPath = findSkillMd(skillsDir, zipBasename);
  if (!skillMdPath) {
    return { skillPath: null, error: `安装包中未找到 SKILL.md 文件。ZIP已解压到 ${skillsDir}，但目录结构不符合技能规范` };
  }

  process.stdout.write(`[AgentModelExecutor] Found SKILL.md at: ${skillMdPath}\n`);
  return { skillPath: skillMdPath };
}

// ─── HTTP/HTTPS file download ─────────────────────────────────────────────────

/**
 * Download a file from URL to a local path.
 */
export function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let settled = false;
    const cleanup = (err?: Error) => {
      if (settled) return;
      settled = true;
      try { file.destroy(); } catch { /* ignore */ }
      try { fs.unlinkSync(destPath); } catch { /* ignore */ }
      if (err) reject(err);
    };
    let redirectCount = 0;
    const request = (urlStr: string) => {
      if (redirectCount > 5) {
        cleanup(new Error(`重定向次数过多 (>${redirectCount})`));
        return;
      }
      const mod = urlStr.startsWith("https") ? https : require("http");
      const req = mod.get(urlStr, { timeout: 30000 }, (res: any) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          redirectCount++;
          res.destroy();
          request(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          res.destroy();
          cleanup(new Error(`服务器返回 HTTP ${res.statusCode}（期望 200）`));
          return;
        }
        res.on("error", (err: Error) => cleanup(new Error(`响应流错误: ${err.message}`)));
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          settled = true;
          resolve();
        });
        file.on("error", (err: Error) => cleanup(new Error(`文件写入错误: ${err.message}`)));
      }).on("error", (err: Error) => {
        cleanup(new Error(`网络错误: ${err.message}`));
      }).on("timeout", () => {
        req.destroy();
        cleanup(new Error("连接超时（30秒）"));
      });
    };
    request(url);
  });
}

// ─── ZIP extraction ───────────────────────────────────────────────────────────

/**
 * Extract a zip file to a target directory.
 * Uses `tar` (available on Windows 10+ and all Unix) as primary method,
 * falls back to PowerShell Expand-Archive, then adm-zip.
 */
export async function extractZip(zipPath: string, targetDir: string): Promise<void> {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Method 1: tar (available on Windows 10+ via bsdtar, and all Unix)
  try {
    await execCommand("tar", ["-xf", zipPath, "-C", targetDir], 30000);
    return;
  } catch (err) {
    process.stderr.write(`[AgentModelExecutor] tar extraction failed: ${(err as Error).message}\n`);
  }

  // Method 2: PowerShell Expand-Archive (Windows only)
  if (process.platform === "win32") {
    try {
      await execCommand("powershell", ["-Command", `Expand-Archive -Path '${zipPath}' -DestinationPath '${targetDir}' -Force`], 30000);
      return;
    } catch (err) {
      process.stderr.write(`[AgentModelExecutor] PowerShell Expand-Archive failed: ${(err as Error).message}\n`);
    }
  }

  // Method 3: unzip (Unix)
  if (process.platform !== "win32") {
    try {
      await execCommand("unzip", ["-o", zipPath, "-d", targetDir], 30000);
      return;
    } catch (err) {
      process.stderr.write(`[AgentModelExecutor] unzip failed: ${(err as Error).message}\n`);
    }
  }

  // Method 4: adm-zip (Node.js package)
  try {
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(targetDir, true);
    return;
  } catch {
    process.stderr.write(`[AgentModelExecutor] adm-zip not available\n`);
  }

  throw new Error("无法解压 ZIP 文件：tar、Expand-Archive、unzip 和 adm-zip 均不可用。");
}

// ─── Execute child process command ────────────────────────────────────────────

/**
 * Execute a command and return a promise.
 */
export function execCommand(cmd: string, args: string[], timeout: number): Promise<void> {
  const { execFile } = require("child_process");
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err: any, _stdout: any, stderr: any) => {
      if (err) {
        reject(new Error(`${cmd} failed: ${err.message}${stderr ? ` - ${stderr}` : ""}`));
      } else {
        resolve();
      }
    });
  });
}

// ─── Find SKILL.md recursively ────────────────────────────────────────────────

/**
 * Recursively find SKILL.md in a directory.
 * If a hint is provided, checks hint/SKILL.md first for efficiency.
 */
export function findSkillMd(dir: string, hint?: string): string | null {
  // If we have a hint, check dir/hint/SKILL.md first
  if (hint) {
    const hintedPath = path.join(dir, hint, "SKILL.md");
    if (fs.existsSync(hintedPath)) return hintedPath;
  }

  // Check root level
  const rootSkillMd = path.join(dir, "SKILL.md");
  if (fs.existsSync(rootSkillMd)) return rootSkillMd;

  // Check one level deep (common pattern: zip contains a subfolder)
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subSkillMd = path.join(dir, entry.name, "SKILL.md");
        if (fs.existsSync(subSkillMd)) return subSkillMd;
      }
    }
  } catch { /* ignore */ }

  return null;
}
