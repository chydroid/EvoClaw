/**
 * 一键修复 SkillManager 启动警告
 *
 * 用法:
 *   npx tsx scripts/fix-skill-warnings.ts            # 扫描并打印修复命令（dry-run）
 *   npx tsx scripts/fix-skill-warnings.ts --apply     # 扫描并执行修复
 *   npx tsx scripts/fix-skill-warnings.ts --env-only   # 只修复 .env
 *   npx tsx scripts/fix-skill-warnings.ts --bin-only    # 只安装缺失二进制
 *
 * 修复内容:
 *   1. 缺失二进制（jq, ffmpeg, fd, gh 等）→ 输出/执行平台安装命令
 *   2. 缺失环境变量（API Key 等）→ 追加到 .env 文件（占位符值，需用户手动填写）
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { SKILLmdParser, SkillValidator } from "../packages/skills/src";

// ── 知识库 ──

const ENV_VAR_DOCS: Map<string, { docLink: string; description: string }> = new Map([
  ["BAIDU_API_KEY", { docLink: "https://console.bce.baidu.com/", description: "Baidu Cloud API Key" }],
  ["NOTION_API_TOKEN", { docLink: "https://www.notion.so/my-integrations", description: "Notion Integration Token" }],
  ["ELEVENLABS_API_KEY", { docLink: "https://elevenlabs.io/app/settings/api-keys", description: "ElevenLabs API Key" }],
  ["SAG_API_KEY", { docLink: "", description: "SAG API Key" }],
  ["FIRECRAWL_API_KEY", { docLink: "https://www.firecrawl.dev/", description: "Firecrawl API Key" }],
  ["APIFY_API_TOKEN", { docLink: "https://console.apify.com/account/integrations", description: "Apify API Token" }],
  ["TAVILY_API_KEY", { docLink: "https://tavily.com/", description: "Tavily Search API Key" }],
  ["TRELLO_API_KEY", { docLink: "https://trello.com/power-ups/admin", description: "Trello API Key" }],
  ["TRELLO_TOKEN", { docLink: "https://trello.com/power-ups/admin", description: "Trello OAuth Token" }],
  ["OPENAI_API_KEY", { docLink: "https://platform.openai.com/api-keys", description: "OpenAI API Key" }],
  ["GIPHY_API_KEY", { docLink: "https://developers.giphy.com/dashboard/", description: "Giphy API Key" }],
  ["TENOR_API_KEY", { docLink: "https://developers.google.com/tenor/guides/quickstart", description: "Tenor API Key" }],
  ["IMGFLIP_USER", { docLink: "https://imgflip.com/", description: "Imgflip username" }],
  ["IMGFLIP_PASS", { docLink: "https://imgflip.com/", description: "Imgflip password" }],
]);

const BINARY_INSTALL: Map<string, {
  win32: string; darwin: string; linux: string; docLink?: string;
  requires?: string;
}> = new Map([
  ["jq", { win32: "winget install jqlang.jq", darwin: "brew install jq", linux: "sudo apt install jq", docLink: "https://stedolan.github.io/jq/download/" }],
  ["ffmpeg", { win32: "winget install Gyan.FFmpeg", darwin: "brew install ffmpeg", linux: "sudo apt install ffmpeg", docLink: "https://ffmpeg.org/download.html" }],
  ["fd", { win32: "winget install sharkdp.fd", darwin: "brew install fd", linux: "sudo apt install fd-find", docLink: "https://github.com/sharkdp/fd#installation" }],
  ["gh", { win32: "winget install GitHub.cli", darwin: "brew install gh", linux: "sudo apt install gh", docLink: "https://cli.github.com/" }],
  ["himalaya", { win32: "cargo install himalaya", darwin: "brew install himalaya", linux: "cargo install himalaya", docLink: "https://github.com/pimalaya/himalaya", requires: "cargo" }],
  ["whisper", { win32: "pip install openai-whisper", darwin: "pip install openai-whisper", linux: "pip install openai-whisper", docLink: "https://github.com/openai/whisper", requires: "pip" }],
  ["obsidian", { win32: "winget install Obsidian.Obsidian", darwin: "brew install --cask obsidian", linux: "# Download from https://obsidian.md/", docLink: "https://obsidian.md/" }],
  ["xurl", { win32: "npm install -g @xdevplatform/xurl", darwin: "brew install xdevplatform/tap/xurl", linux: "npm install -g @xdevplatform/xurl", docLink: "https://www.npmjs.com/package/@xdevplatform/xurl", requires: "npm" }],
  ["gifgrep", { win32: "go install github.com/steipete/gifgrep/cmd/gifgrep@latest", darwin: "brew install steipete/tap/gifgrep", linux: "go install github.com/steipete/gifgrep/cmd/gifgrep@latest", docLink: "https://gifgrep.com", requires: "go" }],
  ["oracle", { win32: "npm install -g @steipete/oracle", darwin: "npm install -g @steipete/oracle", linux: "npm install -g @steipete/oracle", docLink: "https://askoracle.dev", requires: "npm" }],
  ["nano-pdf", { win32: "pip install uv && uv tool install nano-pdf", darwin: "pip install uv && uv tool install nano-pdf", linux: "pip install uv && uv tool install nano-pdf", docLink: "https://pypi.org/project/nano-pdf/", requires: "pip" }],
  ["gog", { win32: "# brew only — not available on Windows. See https://gogcli.sh", darwin: "brew install steipete/tap/gogcli", linux: "# brew only — not available on Linux", docLink: "https://gogcli.sh" }],
  ["sag", { win32: "# brew only — not available on Windows. See https://sag.sh", darwin: "brew install steipete/tap/sag", linux: "# brew only — not available on Linux", docLink: "https://sag.sh" }],
  ["summarize", { win32: "# brew only — not available on Windows. See https://github.com/steipete/summarize", darwin: "brew install steipete/tap/summarize", linux: "# brew only — not available on Linux", docLink: "https://github.com/steipete/summarize" }],
  // Runtime prerequisites (used by `requires` field above)
  ["go", { win32: "winget install GoLang.Go", darwin: "brew install go", linux: "sudo apt install golang", docLink: "https://go.dev/dl/" }],
  ["cargo", { win32: "winget install Rustlang.Rustup", darwin: "brew install rustup", linux: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh", docLink: "https://rustup.rs/" }],
]);

// ── 扫描逻辑 ──

const SKILLS_DIRS = [
  "data/skills",
  "packages/skills/bundled",
  "packages/skills/optional",
];

interface CollectedWarning {
  skillName: string;
  category: "ENV" | "PRIMARYENV" | "BINARY" | "OS" | "VALIDATION";
  message: string;
  envVar?: string;
  binary?: string;
}

function checkBinaryExists(bin: string): boolean {
  try {
    const which = process.platform === "win32" ? "where" : "which";
    execFileSync(which, [bin], { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function normalizeOS(v: string): string {
  const lower = v.toLowerCase();
  if (lower === "win32" || lower === "windows" || lower === "win") return "win32";
  if (lower === "darwin" || lower === "macos" || lower === "mac") return "darwin";
  if (lower === "linux" || lower === "unix") return "linux";
  return lower;
}

async function scanSkills(): Promise<CollectedWarning[]> {
  const warnings: CollectedWarning[] = [];
  const parser = new SKILLmdParser();
  const validator = new SkillValidator();

  // Access private detectEnvVarsFromContent via prototype (script-only diagnostic)
  const SmProto: any = require("../packages/skills/src").SkillManager.prototype;
  const detectEnvVarsFromContent: (instructions: string) => string[] = SmProto.detectEnvVarsFromContent;

  for (const dir of SKILLS_DIRS) {
    const fullDir = path.resolve(dir);
    if (!fs.existsSync(fullDir)) continue;
    const entries = fs.readdirSync(fullDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillMdPath = path.join(fullDir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      const content = fs.readFileSync(skillMdPath, "utf-8");
      const parsed = await parser.parse(content);
      if (!parsed) continue;

      // Validation warnings
      const validation = validator.validate(parsed);
      for (const w of validation.warnings) {
        warnings.push({ skillName: parsed.meta.name, category: "VALIDATION", message: w });
      }

      // OS check
      if (parsed.meta.os && parsed.meta.os.length > 0) {
        const currentOS = normalizeOS(process.platform);
        const supportedOS = parsed.meta.os.map(normalizeOS);
        if (!supportedOS.includes(currentOS)) {
          warnings.push({
            skillName: parsed.meta.name,
            category: "OS",
            message: `Designed for [${parsed.meta.os.join(", ")}] — current OS is "${process.platform}"`,
          });
        }
      }

      const ocMeta = parsed.meta.metadata?.openclaw as any;
      const detectedEnvVars = detectEnvVarsFromContent.call(Object.create(SmProto), parsed.instructions);
      const declaredEnv = ocMeta?.requires?.env || [];
      const allEnvVars = [...new Set([...declaredEnv, ...detectedEnvVars])];

      // ENV warnings
      for (const envVar of allEnvVars) {
        if (!process.env[envVar]) {
          warnings.push({
            skillName: parsed.meta.name,
            category: "ENV",
            message: `Missing env var: ${envVar}`,
            envVar,
          });
        }
      }

      // BINARY warnings
      if (ocMeta?.requires?.bins) {
        for (const bin of ocMeta.requires.bins) {
          if (!checkBinaryExists(bin)) {
            warnings.push({
              skillName: parsed.meta.name,
              category: "BINARY",
              message: `Missing binary: ${bin}`,
              binary: bin,
            });
          }
        }
      }

      // PRIMARYENV warnings
      const primaryEnv = ocMeta?.primaryEnv || detectedEnvVars.find(v => /KEY|SECRET|TOKEN|API/i.test(v));
      if (primaryEnv && !process.env[primaryEnv]) {
        warnings.push({
          skillName: parsed.meta.name,
          category: "PRIMARYENV",
          message: `Primary env var not set: ${primaryEnv}`,
          envVar: primaryEnv,
        });
      }
    }
  }

  return warnings;
}

// ── 修复逻辑 ──

function generateEnvEntries(warnings: CollectedWarning[]): string[] {
  const envVars = [...new Set(
    warnings
      .filter(w => w.envVar)
      .map(w => w.envVar!)
  )].sort();
  return envVars.map(envVar => {
    const kb = ENV_VAR_DOCS.get(envVar);
    const desc = kb?.description || "";
    return `${envVar}=  # ${desc}${kb?.docLink ? ` — ${kb.docLink}` : ""}`;
  });
}

function generateBinaryCommands(warnings: CollectedWarning[]): string[] {
  const binaries = [...new Set(
    warnings
      .filter(w => w.binary)
      .map(w => w.binary!)
  )].sort();
  const plat = process.platform as "win32" | "darwin" | "linux";
  const result: string[] = [];
  const seenPrereqs = new Set<string>();

  for (const bin of binaries) {
    const kb = BINARY_INSTALL.get(bin);
    if (!kb) {
      result.push(`# ${bin} — install manually (no known package)`);
      continue;
    }
    const cmd = kb[plat] || kb.linux;

    // Check prerequisite runtime
    if (kb.requires) {
      const prereqOk = checkBinaryExists(kb.requires);
      if (!prereqOk) {
        // Add prereq install command first (only once)
        if (!seenPrereqs.has(kb.requires)) {
          seenPrereqs.add(kb.requires);
          const prereqKb = BINARY_INSTALL.get(kb.requires);
          if (prereqKb) {
            const prereqCmd = prereqKb[plat] || prereqKb.linux;
            if (!prereqCmd.startsWith("#")) {
              result.push(`${prereqCmd}  # ${kb.requires} (prerequisite for ${bin})`);
            }
          } else {
            result.push(`# Install ${kb.requires} first (required by ${bin}) — no known package`);
          }
        }
        result.push(`# ${bin} — requires ${kb.requires} (install above first, then re-run)`);
        continue;
      }
    }

    result.push(`${cmd}  # ${bin}`);
  }
  return result;
}

function applyEnvFixes(warnings: CollectedWarning[]): void {
  const entries = generateEnvEntries(warnings);
  if (entries.length === 0) {
    console.log("No env vars to fix.");
    return;
  }

  const envPath = path.resolve(".env");
  let existing = "";
  if (fs.existsSync(envPath)) {
    existing = fs.readFileSync(envPath, "utf-8");
  }

  // Find which env vars are already in .env
  const newEntries = entries.filter(entry => {
    const varName = entry.split("=")[0];
    return !existing.includes(`${varName}=`);
  });

  if (newEntries.length === 0) {
    console.log("All env vars already present in .env — just need to fill in values.");
    return;
  }

  const block = `\n# ── SkillManager auto-generated entries (fill in values) ──\n${newEntries.join("\n")}\n`;
  // Atomic write: temp + rename
  const tmpPath = `${envPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, existing + block, "utf-8");
  fs.renameSync(tmpPath, envPath);
  console.log(`Added ${newEntries.length} env var entries to .env (fill in values)`);
}

function applyBinaryFixes(warnings: CollectedWarning[]): void {
  const commands = generateBinaryCommands(warnings);
  if (commands.length === 0) {
    console.log("No binaries to install.");
    return;
  }

  const plat = process.platform as "win32" | "darwin" | "linux";
  for (const cmd of commands) {
    // Skip comment-only lines (brew-only, missing prereq, etc.)
    if (cmd.startsWith("#")) {
      console.log(`SKIP: ${cmd}`);
      continue;
    }
    // Extract the actual command (before the "  #" comment suffix)
    const actualCmd = cmd.split("  #")[0].trim();
    if (!actualCmd || actualCmd.startsWith("#")) {
      console.log(`SKIP: ${cmd}`);
      continue;
    }
    console.log(`Running: ${actualCmd}`);
    try {
      // Handle compound commands with && (e.g., "pip install uv && uv tool install nano-pdf")
      // On win32, use shell:true to let cmd.exe handle &&; on unix, split and run sequentially
      if (actualCmd.includes("&&")) {
        const parts = actualCmd.split("&&").map(p => p.trim());
        for (const part of parts) {
          const tokens = part.split(/\s+/);
          execFileSync(tokens[0], tokens.slice(1), {
            stdio: "inherit",
            timeout: 120000,
            shell: plat === "win32",
          });
        }
      } else {
        const tokens = actualCmd.split(/\s+/);
        execFileSync(tokens[0], tokens.slice(1), {
          stdio: "inherit",
          timeout: 120000, // 2 min timeout per install
          shell: plat === "win32",
        });
      }
      console.log("  OK");
    } catch (err) {
      console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
      console.error("  Install manually and re-run.");
    }
  }
}

// ── 主入口 ──

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const envOnly = args.includes("--env-only");
  const binOnly = args.includes("--bin-only");

  console.log("Scanning skills for warnings...");
  const warnings = await scanSkills();

  if (warnings.length === 0) {
    console.log("\n✓ No warnings found. All skills are properly configured.");
    return;
  }

  const byCat = new Map<string, number>();
  for (const w of warnings) {
    byCat.set(w.category, (byCat.get(w.category) || 0) + 1);
  }

  console.log(`\nFound ${warnings.length} warning(s):`);
  for (const [cat, count] of byCat) {
    console.log(`  ${cat}: ${count}`);
  }

  // Generate fix commands
  const envEntries = generateEnvEntries(warnings);
  const binCommands = generateBinaryCommands(warnings);

  if (!apply) {
    // Dry-run mode: print commands
    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  Fix Commands (dry-run — use --apply to execute)");
    console.log("═══════════════════════════════════════════════════════════════\n");

    if (binCommands.length > 0 && !envOnly) {
      console.log("── Install missing binaries ──");
      for (const cmd of binCommands) {
        console.log(`  ${cmd}`);
      }
      console.log("");
    }

    if (envEntries.length > 0 && !binOnly) {
      console.log("── Add to .env file ──");
      for (const entry of envEntries) {
        console.log(`  ${entry}`);
      }
      console.log("");
    }

    console.log("To apply fixes: npx tsx scripts/fix-skill-warnings.ts --apply");
    console.log("To apply only .env: npx tsx scripts/fix-skill-warnings.ts --apply --env-only");
    console.log("To apply only binaries: npx tsx scripts/fix-skill-warnings.ts --apply --bin-only");
    console.log("");
    return;
  }

  // Apply mode
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Applying fixes...");
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (!envOnly) {
    console.log("── Installing missing binaries ──");
    applyBinaryFixes(warnings);
    console.log("");
  }

  if (!binOnly) {
    console.log("── Updating .env file ──");
    applyEnvFixes(warnings);
    console.log("");
  }

  console.log("Done. Re-run scan to verify: npx tsx scripts/scan-skill-warnings.ts");
  console.log("");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
