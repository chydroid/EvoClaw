/**
 * 扫描所有已安装技能，模拟 installSkill 收集所有警告
 * 用法: npx tsx scripts/scan-skill-warnings.ts
 */
import * as fs from "fs";
import * as path from "path";
import { SkillManager, SKILLmdParser } from "../packages/skills/src";
import { execFileSync } from "child_process";

const SKILLS_DIRS = [
  "data/skills",
  "packages/skills/bundled",
  "packages/skills/optional",
];

interface WarningEntry {
  skillName: string;
  skillDir: string;
  source: string;
  category: "validation" | "env" | "binary" | "os" | "primaryEnv";
  message: string;
}

const warnings: WarningEntry[] = [];
const parser = new SKILLmdParser();

// Access private methods via any-cast (script-only diagnostic)
const SmProto: any = SkillManager.prototype;
const detectEnvVarsFromContent: (instructions: string) => string[] = SmProto.detectEnvVarsFromContent;

function checkBinaryExists(bin: string): boolean {
  try {
    const [command, args] = process.platform === "win32"
      ? ["where", [bin]]
      : ["which", [bin]];
    execFileSync(command, args, { stdio: "ignore" });
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

async function main() {
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

      const validation = new (require("../packages/skills/src").SkillValidator)().validate(parsed);
      for (const w of validation.warnings) {
        warnings.push({
          skillName: parsed.meta.name,
          skillDir: path.join(fullDir, entry.name),
          source: "validation",
          category: "validation",
          message: w,
        });
      }

      // OS check (fixed)
      if (parsed.meta.os && parsed.meta.os.length > 0) {
        const currentOS = normalizeOS(process.platform);
        const supportedOS = parsed.meta.os.map(normalizeOS);
        if (!supportedOS.includes(currentOS)) {
          warnings.push({
            skillName: parsed.meta.name,
            skillDir: path.join(fullDir, entry.name),
            source: "os",
            category: "os",
            message: `Skill "${parsed.meta.name}" was designed for [${parsed.meta.os.join(", ")}] — may not work correctly on "${process.platform}"`,
          });
        }
      }

      // Env vars (fixed)
      const ocMeta = parsed.meta.metadata?.openclaw as any;
      const detectedEnvVars = detectEnvVarsFromContent.call(Object.create(SmProto), parsed.instructions);
      const declaredEnv = ocMeta?.requires?.env || [];
      const allEnvVars = [...new Set([...declaredEnv, ...detectedEnvVars])];
      for (const envVar of allEnvVars) {
        if (!process.env[envVar]) {
          warnings.push({
            skillName: parsed.meta.name,
            skillDir: path.join(fullDir, entry.name),
            source: "env",
            category: "env",
            message: `Missing required environment variable: ${envVar} — skill "${parsed.meta.name}" may not function correctly`,
          });
        }
      }

      // Bins
      if (ocMeta?.requires?.bins) {
        for (const bin of ocMeta.requires.bins) {
          if (!checkBinaryExists(bin)) {
            warnings.push({
              skillName: parsed.meta.name,
              skillDir: path.join(fullDir, entry.name),
              source: "binary",
              category: "binary",
              message: `Missing required binary "${bin}" — skill "${parsed.meta.name}" may not function correctly`,
            });
          }
        }
      }

      // Primary env
      const primaryEnv = ocMeta?.primaryEnv || detectedEnvVars.find(v => /KEY|SECRET|TOKEN|API/i.test(v));
      if (primaryEnv && !process.env[primaryEnv]) {
        warnings.push({
          skillName: parsed.meta.name,
          skillDir: path.join(fullDir, entry.name),
          source: "primaryEnv",
          category: "primaryEnv",
          message: `Primary environment variable "${primaryEnv}" is not set — skill "${parsed.meta.name}" requires configuration`,
        });
      }
    }
  }

  console.log(`\n=== SkillManager Warning Scan ===\n`);
  console.log(`Total warnings: ${warnings.length}\n`);

  const byCategory = new Map<string, WarningEntry[]>();
  for (const w of warnings) {
    if (!byCategory.has(w.category)) byCategory.set(w.category, []);
    byCategory.get(w.category)!.push(w);
  }

  for (const [cat, items] of byCategory) {
    console.log(`\n--- ${cat.toUpperCase()} (${items.length}) ---`);
    for (const w of items) {
      console.log(`  [${w.skillName}] ${w.message}`);
    }
  }

  console.log(`\n\n=== By Skill ===\n`);
  const bySkill = new Map<string, WarningEntry[]>();
  for (const w of warnings) {
    if (!bySkill.has(w.skillName)) bySkill.set(w.skillName, []);
    bySkill.get(w.skillName)!.push(w);
  }
  for (const [skill, items] of bySkill) {
    console.log(`\n${skill} (${items.length} warnings):`);
    for (const w of items) {
      console.log(`  [${w.category}] ${w.message}`);
    }
  }
}

main().catch(console.error);
