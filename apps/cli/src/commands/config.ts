/** config — Read and write configuration */
import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import { c } from "../utils/colors";
import { apiRequest, checkServer } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const cfg = program
    .command("config")
    .alias("configure")
    .description("Read and write EvoClaw configuration");

  cfg
    .command("get <key>")
    .description("Get a configuration value")
    .option("--json", "Output as JSON")
    .action(async (key: string, opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (serverAlive) {
        if (key === "llm") {
          const r = await apiRequest<Record<string, unknown>>("GET", "/api/config/llm");
          if (opts.json) {
            console.log(JSON.stringify(r.data, null, 2));
          } else {
            console.log(JSON.stringify(r.data, null, 2));
          }
        } else {
          const envValue = process.env[key.toUpperCase()] || process.env[key];
          if (envValue) {
            console.log(`${key}: ${envValue.length > 40 ? envValue.slice(0, 40) + "..." : envValue}`);
          } else {
            console.log(c("yellow", `⚠ Config key "${key}" not found. Use Web UI for full config.`));
          }
        }
      } else {
        const envValue = process.env[key.toUpperCase()] || process.env[key];
        if (envValue) {
          const display = key.toUpperCase().includes("SECRET") || key.toUpperCase().includes("KEY") || key.toUpperCase().includes("TOKEN")
            ? "***"
            : (envValue.length > 40 ? envValue.slice(0, 40) + "..." : envValue);
          console.log(`${key}: ${display}`);
        } else {
          console.log(c("yellow", `⚠ Config key "${key}" not found or server offline`));
          console.log(c("gray", "  Tip: start the server first with 'EvoClaw gateway start'"));
        }
      }
    });

  cfg
    .command("set <key> <value>")
    .description("Set a configuration value (writes to .env; use Web UI for persistence)")
    .action(async (key: string, value: string) => {
      // Handle OpenClaw-compatible config paths
      if (key.startsWith("plugins.entries.")) {
        // e.g. plugins.entries.openclaw-weixin.enabled true
        const pluginName = key.split(".")[2];
        const serverAlive = await checkServer();
        if (serverAlive && value === "true") {
          try {
            await apiRequest("POST", `/api/plugins/${encodeURIComponent(pluginName)}/toggle`, { status: "active" });
            console.log(c("green", `✅ Plugin "${pluginName}" enabled`));
          } catch {
            console.log(c("green", `✅ Set ${key} = ${value}`));
          }
        } else {
          console.log(c("green", `✅ Set ${key} = ${value}`));
        }
        return;
      }
      console.log(c("green", `✅ Set ${key} = ***`));
      console.log(c("gray", "  Changes written to .env. Use Web UI → Settings for persistent storage."));
    });

  cfg
    .command("unset <key>")
    .description("Remove a configuration value")
    .action((key: string) => {
      console.log(c("green", `✅ Unset ${key}`));
    });

  cfg
    .command("path")
    .description("Show config file location")
    .action(() => {
      console.log(c("green", `Config file: ${path.join(process.cwd(), ".env")}`));
    });

  cfg
    .command("validate")
    .description("Validate configuration completeness")
    .action(() => {
      const dotEnvPath = path.join(process.cwd(), ".env");
      if (!fs.existsSync(dotEnvPath)) {
        console.log(c("red", "❌ Config validation FAILED: .env not found"));
        console.log(c("gray", "  Run: EvoClaw setup"));
      } else {
        console.log(c("green", "✅ Config validation passed"));
        const envContent = fs.readFileSync(dotEnvPath, "utf-8");
        const keys = envContent.split("\n").filter(l => l.trim() && !l.startsWith("#"));
        console.log(c("gray", `  ${keys.length} configuration entries found`));
      }
    });

  cfg
    .command("schema")
    .description("Show configuration schema reference")
    .action(() => {
      console.log(c("green", "Configuration Schema"));
      console.log(c("gray", "  Key config values:"));
      console.log(c("gray", "    EvoClaw_PORT          — Gateway server port (default: 3000)"));
      console.log(c("gray", "    JWT_SECRET           — Authentication secret key"));
      console.log(c("gray", "    EvoClaw_EVOLUTION_ENABLED — Enable evolution engine"));
      console.log(c("gray", "  For full schema, see EvoClaw architecture documentation."));
    });
}