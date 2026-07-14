/** doctor — System diagnostics and auto-repair */
import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import { atomicWriteFileSync } from "@evoclaw/core";
import { c, ICONS, divider, section } from "../utils/colors";
import { VERSION, DEFAULT_PORT, apiRequest, checkServer } from "../utils/api";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  severity?: "warning" | "error";
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("doctor")
    .description("Run system diagnostics and auto-repair")
    .option("--fix", "Apply automatic fixes")
    .option("--yes", "Auto-confirm all fixes (requires --fix)")
    .option("--deep", "Run deep diagnostic scan (slower, more thorough)")
    .option("--force", "Force-override custom configurations")
    .option("--non-interactive", "Non-interactive mode")
    .option("--json", "Output results as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const isDeep = !!opts.deep;
      const isFix = !!opts.fix;
      const isForce = !!opts.force;
      const isYes = !!opts.yes;
      const isNonInteractive = !!opts.nonInteractive;
      const isJson = !!opts.json;

      const checks: CheckResult[] = [];
      const fixesApplied: string[] = [];

      if (!isJson) console.log(section("EvoClaw System Diagnostics"));

      // 1. System environment
      if (!isJson) console.log(c("cyan", "1. System Environment"));

      const nodeVersion = process.version;
      const nodeMajor = parseInt(nodeVersion.slice(1).split(".")[0], 10);
      checks.push({
        name: "Node.js version",
        ok: nodeMajor >= 20,
        detail: nodeMajor >= 20 ? `${nodeVersion} ✓` : `${nodeVersion} (requires >= v20)`,
        fix: "Upgrade Node.js to v20 or later",
        severity: nodeMajor >= 20 ? undefined : "error",
      });

      checks.push({
        name: "Operating System",
        ok: true,
        detail: `${process.platform} ${process.arch}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 1024 / 1024)}MB RAM`,
      });

      const freeMemPct = ((os.freemem() / os.totalmem()) * 100).toFixed(1);
      checks.push({
        name: "Available Memory",
        ok: parseFloat(freeMemPct) > 10,
        detail: `${Math.round(os.freemem() / 1024 / 1024)}MB / ${Math.round(os.totalmem() / 1024 / 1024)}MB (${freeMemPct}%)`,
        fix: "Free up memory or increase system RAM",
        severity: parseFloat(freeMemPct) > 10 ? undefined : "warning",
      });

      // 2. Config files
      if (!isJson) console.log(c("cyan", "2. Configuration Files"));

      const dotEnvPath = path.join(process.cwd(), ".env");
      const dotEnvExists = fs.existsSync(dotEnvPath);
      checks.push({
        name: ".env config file",
        ok: dotEnvExists,
        detail: dotEnvExists ? "Present" : "Missing",
        fix: "Run: EvoClaw setup",
        severity: "error",
      });

      let envContent = "";
      if (dotEnvExists) {
        try { envContent = fs.readFileSync(dotEnvPath, "utf-8"); }
        catch { checks.push({ name: ".env readable", ok: false, detail: "Cannot read", fix: "Check file permissions", severity: "error" }); }
      }

      if (envContent) {
        const jwtOk = !!(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16);
        checks.push({
          name: "JWT_SECRET",
          ok: jwtOk,
          detail: process.env.JWT_SECRET ? `${process.env.JWT_SECRET.length} chars` : "Not set or too short (<16)",
          fix: "Run: EvoClaw setup",
          severity: "error",
        });

        const portOk = !!(process.env.EvoClaw_PORT && /^\d+$/.test(process.env.EvoClaw_PORT));
        checks.push({
          name: "EvoClaw_PORT",
          ok: portOk,
          detail: process.env.EvoClaw_PORT || "Not set",
          fix: "Set EvoClaw_PORT in .env (e.g. EvoClaw_PORT=3000)",
          severity: "warning",
        });

        const envVars = envContent.split("\n").filter(l => l.trim() && !l.startsWith("#"));
        checks.push({ name: "Config variables", ok: envVars.length >= 2, detail: `${envVars.length} entries` });
      }

      // 3. Directory structure
      if (!isJson) console.log(c("cyan", "3. Directory Structure"));
      for (const dir of ["skills", "data", "logs"]) {
        const dirPath = path.join(process.cwd(), dir);
        const exists = fs.existsSync(dirPath);
        checks.push({
          name: `${dir}/ directory`,
          ok: exists,
          detail: exists ? "Present" : "Missing",
          fix: `Create directory: mkdir ${dir}`,
          severity: exists ? undefined : "warning",
        });
      }

      const skillsDir = path.join(process.cwd(), "skills");
      const skillCount = fs.existsSync(skillsDir)
        ? fs.readdirSync(skillsDir).filter(f => { try { return fs.statSync(path.join(skillsDir, f)).isDirectory(); } catch { return false; } }).length
        : 0;
      checks.push({
        name: "Installed skills",
        ok: skillCount > 0,
        detail: `${skillCount} skills`,
        fix: "Install a skill: EvoClaw skills install <slug>",
      });

      // 4. Dependencies
      if (!isJson) console.log(c("cyan", "4. Dependencies & Modules"));
      const pkgJsonPath = path.join(process.cwd(), "package.json");
      checks.push({
        name: "package.json",
        ok: fs.existsSync(pkgJsonPath),
        detail: fs.existsSync(pkgJsonPath) ? "Present" : "Missing",
        fix: "Run: pnpm install from project root",
        severity: "error",
      });

      const nodeModulesExists = fs.existsSync(path.join(process.cwd(), "node_modules"));
      checks.push({
        name: "node_modules",
        ok: nodeModulesExists,
        detail: nodeModulesExists ? "Present" : "Missing",
        fix: "Run: pnpm install",
        severity: "error",
      });

      if (nodeModulesExists && fs.existsSync(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          checks.push({ name: "Dependencies", ok: Object.keys(deps).length > 0, detail: `${Object.keys(deps).length} packages` });
        } catch {
          checks.push({ name: "Dependency parse", ok: false, detail: "package.json parse error", severity: "warning" });
        }
      }

      // 5. Service health
      if (!isJson) console.log(c("cyan", "5. Service Health"));
      const serverOk = await checkServer();
      checks.push({
        name: "Gateway service",
        ok: serverOk,
        detail: serverOk ? `Running on port ${DEFAULT_PORT}` : "Not running",
        fix: "Start service: EvoClaw gateway start",
        severity: "warning",
      });

      if (serverOk) {
        try {
          const r = await apiRequest<Record<string, unknown>>("GET", "/health");
          checks.push({ name: "Service version", ok: true, detail: String(r.data.version || VERSION) });
          checks.push({ name: "Service uptime", ok: true, detail: `${Math.round((r.data.uptime as number) || 0)}s` });
        } catch {
          checks.push({ name: "Service status", ok: false, detail: "Failed to fetch", severity: "warning" });
        }
      }

      // 6. Security
      if (!isJson) console.log(c("cyan", "6. Security Audit"));
      if (envContent) {
        const hasSecret = envContent.includes("SECRET") || envContent.includes("KEY") || envContent.includes("TOKEN");
        checks.push({ name: "Sensitive config", ok: hasSecret, detail: hasSecret ? "Configured" : "Not configured", severity: "warning" });
      }
      if (dotEnvExists && process.platform !== "win32") {
        const stat = fs.statSync(dotEnvPath);
        const mode = stat.mode & 0o777;
        const isSecure = (mode & 0o077) === 0;
        checks.push({
          name: ".env permissions",
          ok: isSecure,
          detail: isSecure ? "Secure (600)" : `Insecure (${mode.toString(8)})`,
          fix: "Run: chmod 600 .env",
          severity: "warning",
        });
      }

      // 7. Network (deep only)
      if (isDeep && serverOk) {
        if (!isJson) console.log(c("cyan", "7. Network Connectivity"));
        for (const ep of ["/health", "/api/system/services"]) {
          try {
            const r = await apiRequest("GET", ep);
            checks.push({ name: `${ep} endpoint`, ok: r.status === 200, detail: "Reachable" });
          } catch {
            checks.push({ name: `${ep} endpoint`, ok: false, detail: "Unreachable", severity: "warning" });
          }
        }
      }

      // Output
      if (isJson) {
        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          version: VERSION,
          summary: {
            total: checks.length,
            passed: checks.filter(c => c.ok).length,
            errors: checks.filter(c => c.severity === "error" && !c.ok).length,
            warnings: checks.filter(c => c.severity === "warning" && !c.ok).length,
          },
          checks: checks.map(c => ({ name: c.name, ok: c.ok, detail: c.detail, severity: c.severity, fix: c.fix })),
        }, null, 2));
        return;
      }

      // Summary table
      console.log(section("Diagnostic Results"));
      console.log(divider());
      for (const check of checks) {
        const icon = check.ok ? ICONS.ok() : check.severity === "error" ? ICONS.error() : ICONS.warn();
        const color = check.severity === "error" ? "red" : check.severity === "warning" ? "yellow" : "gray";
        process.stdout.write(`  ${icon} ${check.name}: ${c(color, check.detail)}\n`);
        if (!check.ok && check.fix) {
          process.stdout.write(`    ${ICONS.tip()} ${c("gray", check.fix)}\n`);
        }
      }

      const errors = checks.filter(c => c.severity === "error" && !c.ok).length;
      const warnings = checks.filter(c => c.severity === "warning" && !c.ok).length;
      const allOk = errors === 0 && warnings === 0;

      console.log(divider());
      process.stdout.write(
        `  Errors: ${c("red", String(errors))}  ` +
        `Warnings: ${c("yellow", String(warnings))}  ` +
        `Passed: ${c("green", String(checks.filter(c => c.ok).length))}\n`
      );

      // Fix mode
      if (isFix && (errors > 0 || warnings > 0)) {
        if (!isYes && !isNonInteractive) {
          console.log(`\n${ICONS.warn()} Use --yes to apply fixes, or --force to override custom config`);
          console.log(c("gray", "  EvoClaw doctor --fix --yes"));
        } else {
          console.log(`\n${c("green", isForce ? "🔧 Applying fixes (--force mode)..." : "🔧 Applying safe fixes...")}\n`);
          if (!dotEnvExists) {
            const secret = crypto.randomBytes(32).toString("hex");
            atomicWriteFileSync(dotEnvPath, `EvoClaw_PORT=${DEFAULT_PORT}\nJWT_SECRET=${secret}\nEvoClaw_EVOLUTION_ENABLED=true\n`);
            fixesApplied.push("Created .env config file");
          }
          for (const dir of ["skills", "data", "logs"]) {
            const dirPath = path.join(process.cwd(), dir);
            if (!fs.existsSync(dirPath)) { fs.mkdirSync(dirPath, { recursive: true }); fixesApplied.push(`Created ${dir}/ directory`); }
          }
          if (!nodeModulesExists && fs.existsSync(pkgJsonPath)) {
            console.log(c("yellow", "⚠ Dependency installation requires manual action: pnpm install"));
          }
          if (fixesApplied.length > 0) {
            for (const fix of fixesApplied) console.log(`  ${ICONS.ok()} ${fix}`);
            console.log(`\n${c("green", "✅ All fixes applied!")}`);
            console.log(c("gray", "  Restart Gateway to apply changes: EvoClaw gateway restart"));
          } else {
            console.log(c("yellow", "⚠ No auto-fixable items found"));
          }
        }
      } else if (allOk) {
        console.log(`\n${c("green", "✅ All checks passed! System is healthy.")}`);
        console.log(c("gray", "  Tip: run EvoClaw doctor --deep for comprehensive diagnostics"));
      } else {
        console.log(`\n${ICONS.warn()} Some checks failed.`);
        console.log(c("gray", "  Fix automatically:  EvoClaw doctor --fix --yes"));
        console.log(c("gray", "  Full deep scan:     EvoClaw doctor --deep"));
      }
      console.log();
    });
}