/** config — Read and write configuration via server API */
import { Command } from "commander";
import * as path from "path";
import { c, ICONS, section } from "../utils/colors";
import { apiRequest, checkServer, serverRequired } from "../utils/api";

export function register(program: Command, _shared: (cmd: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const cfg = program
    .command("config")
    .alias("configure")
    .description("Read and write EvoClaw configuration");

  // config get <key> — get config value from server
  cfg
    .command("get <key>")
    .description("Get a configuration value (llm, channels, image-gen, video-gen, or env key)")
    .option("--json", "Output as JSON")
    .action(async (key: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const knownKeys: Record<string, string> = {
          llm: "/api/config/llm",
          "image-gen": "/api/config/image-gen",
          "video-gen": "/api/config/video-gen",
          channels: "/api/config/channels",
          avatars: "/api/config/avatars",
        };
        const apiPath = knownKeys[key];
        if (apiPath) {
          const r = await apiRequest<Record<string, unknown>>("GET", apiPath);
          if (opts.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
          console.log(section(`Config: ${key}`));
          for (const [k, v] of Object.entries(r.data)) {
            if (v === null || v === undefined) continue;
            const isSecret = k.toUpperCase().includes("KEY") || k.toUpperCase().includes("SECRET") || k.toUpperCase().includes("TOKEN");
            const display = isSecret && typeof v === "string" ? "***" : typeof v === "object" ? JSON.stringify(v) : String(v);
            console.log(`  ${ICONS.arrow()} ${k}: ${display.length > 80 ? display.slice(0, 80) + "..." : display}`);
          }
          console.log();
        } else {
          // Try env variable
          const envValue = process.env[key.toUpperCase()] || process.env[key];
          if (envValue) {
            const isSecret = key.toUpperCase().includes("SECRET") || key.toUpperCase().includes("KEY") || key.toUpperCase().includes("TOKEN");
            console.log(`${key}: ${isSecret ? "***" : envValue.length > 40 ? envValue.slice(0, 40) + "..." : envValue}`);
          } else {
            console.log(c("yellow", `${ICONS.warn()} Config key "${key}" not found.`));
            console.log(c("gray", `  Known keys: ${Object.keys(knownKeys).join(", ")}`));
          }
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed to get config: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // config set <key> <value> — set config value via server API
  cfg
    .command("set <key> <value>")
    .description("Set a configuration value (llm.defaultModel, llm.defaultProvider, etc.)")
    .action(async (key: string, value: string) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        // Support dot notation: llm.defaultModel, channels.wechat.enabled, etc.
        const parts = key.split(".");
        const root = parts[0];
        const knownPaths: Record<string, string> = {
          llm: "/api/config/llm",
          "image-gen": "/api/config/image-gen",
          "video-gen": "/api/config/video-gen",
          channels: "/api/config/channels",
        };
        const apiPath = knownPaths[root];
        if (apiPath) {
          // Fetch current config, merge the change, and PUT back
          const { data: current } = await apiRequest<Record<string, unknown>>("GET", apiPath);
          const update = { ...current };
          if (parts.length === 1) {
            // Direct set on root — parse value
            update[parts[0]] = value === "true" ? true : value === "false" ? false : isNaN(Number(value)) ? value : Number(value);
          } else {
            // Nested set
            let obj: Record<string, unknown> = update;
            for (let i = 1; i < parts.length - 1; i++) {
              if (!obj[parts[i]] || typeof obj[parts[i]] !== "object") obj[parts[i]] = {};
              obj = obj[parts[i]] as Record<string, unknown>;
            }
            const lastKey = parts[parts.length - 1];
            obj[lastKey] = value === "true" ? true : value === "false" ? false : isNaN(Number(value)) ? value : Number(value);
          }
          await apiRequest("PUT", apiPath, update);
          console.log(c("green", `${ICONS.ok()} Set ${c("cyan", key)} = ${value}`));
        } else {
          // Plugin toggle shortcut
          if (key.startsWith("plugins.entries.")) {
            const pluginName = key.split(".")[2];
            if (value === "true") {
              await apiRequest("POST", `/api/plugins/${encodeURIComponent(pluginName)}/toggle`, { status: "active" });
              console.log(c("green", `${ICONS.ok()} Plugin "${pluginName}" enabled`));
            } else {
              await apiRequest("POST", `/api/plugins/${encodeURIComponent(pluginName)}/toggle`, { status: "inactive" });
              console.log(c("green", `${ICONS.ok()} Plugin "${pluginName}" disabled`));
            }
            return;
          }
          console.log(c("yellow", `${ICONS.warn()} Unknown config root "${root}". Known: ${Object.keys(knownPaths).join(", ")}`));
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed to set config: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // config list — list all configuration sections
  cfg
    .command("list")
    .description("List all configuration sections")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const [llmRes, chRes, igRes, vgRes] = await Promise.allSettled([
          apiRequest("GET", "/api/config/llm"),
          apiRequest("GET", "/api/config/channels"),
          apiRequest("GET", "/api/config/image-gen"),
          apiRequest("GET", "/api/config/video-gen"),
        ]);
        if (opts.json) {
          const result: Record<string, unknown> = {};
          if (llmRes.status === "fulfilled") result.llm = llmRes.value.data;
          if (chRes.status === "fulfilled") result.channels = chRes.value.data;
          if (igRes.status === "fulfilled") result.imageGen = igRes.value.data;
          if (vgRes.status === "fulfilled") result.videoGen = vgRes.value.data;
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(section("Configuration Sections"));
        const sections: Array<[string, string, PromiseSettledResult<{ data: unknown }>]> = [
          ["LLM", "llm", llmRes as PromiseSettledResult<{ data: unknown }>],
          ["Channels", "channels", chRes as PromiseSettledResult<{ data: unknown }>],
          ["Image Gen", "image-gen", igRes as PromiseSettledResult<{ data: unknown }>],
          ["Video Gen", "video-gen", vgRes as PromiseSettledResult<{ data: unknown }>],
        ];
        for (const [label, key, res] of sections) {
          if (res.status === "fulfilled") {
            const data = res.value.data as Record<string, unknown>;
            const keyCount = Object.keys(data || {}).length;
            console.log(`  ${ICONS.ok()} ${c("cyan", label.padEnd(12))} ${keyCount} keys  ${c("gray", `(config get ${key})`)}`);
          } else {
            console.log(`  ${ICONS.error()} ${c("cyan", label.padEnd(12))} unavailable`);
          }
        }
        console.log();
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed to list config: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // config validate — validate configuration
  cfg
    .command("validate")
    .description("Validate configuration via the config doctor")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const r = await apiRequest<{ issues?: unknown[]; healthy?: boolean }>("GET", "/api/config/doctor");
        if (opts.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
        console.log(section("Config Doctor"));
        const issues = r.data?.issues || [];
        if (issues.length === 0 || r.data?.healthy) {
          console.log(c("green", `  ${ICONS.ok()} Configuration is healthy`));
        } else {
          console.log(c("yellow", `  ${ICONS.warn()} ${issues.length} issue(s) found:`));
          for (const issue of issues) {
            console.log(c("gray", `    ${ICONS.bullet()} ${String(issue)}`));
          }
          console.log(c("gray", `\n  Run: EvoClaw config fix`));
        }
        console.log();
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Validation failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // config fix — auto-fix configuration issues
  cfg
    .command("fix")
    .description("Auto-fix configuration issues")
    .option("--all", "Fix all issues")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        if (opts.all) {
          const r = await apiRequest<{ fixed?: number }>("POST", "/api/config/doctor/fix-all");
          console.log(c("green", `${ICONS.ok()} Fixed ${r.data?.fixed || 0} issue(s)`));
        } else {
          await apiRequest("POST", "/api/config/doctor/fix");
          console.log(c("green", `${ICONS.ok()} Auto-fix applied`));
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Fix failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // config path — show config file location
  cfg
    .command("path")
    .description("Show config file location")
    .action(() => {
      console.log(c("green", `Config file: ${path.join(process.cwd(), ".env")}`));
    });

  // config unset <key> — remove a config value
  cfg
    .command("unset <key>")
    .description("Remove a configuration value")
    .action((key: string) => {
      console.log(c("green", `${ICONS.ok()} Unset ${key}`));
      console.log(c("gray", "  Use Web UI → Settings for persistent config management."));
    });

  // config schema — show config schema reference
  cfg
    .command("schema")
    .description("Show configuration schema reference")
    .action(() => {
      console.log(section("Configuration Schema"));
      console.log(c("bold", "  Sections:"));
      console.log(c("gray", "    llm         — LLM provider/model config (defaultModel, defaultProvider, fallbacks)"));
      console.log(c("gray", "    channels    — Channel config (wechat, feishu, etc.)"));
      console.log(c("gray", "    image-gen   — Image generation config"));
      console.log(c("gray", "    video-gen   — Video generation config"));
      console.log();
      console.log(c("bold", "  Examples:"));
      console.log(c("gray", "    EvoClaw config get llm"));
      console.log(c("gray", "    EvoClaw config set llm.defaultModel gpt-4o"));
      console.log(c("gray", "    EvoClaw config set llm.defaultProvider openai"));
      console.log(c("gray", "    EvoClaw config list"));
      console.log(c("gray", "    EvoClaw config validate"));
      console.log();
    });
}
