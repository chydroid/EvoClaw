import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import * as child_process from "child_process";
import { c, ICONS } from "../utils/colors";
import { apiRequest, checkServer } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const mcp = program
    .command("mcp")
    .description("Manage MCP (Model Context Protocol) servers");

  mcp
    .command("list")
    .description("List MCP servers")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<unknown[]>("GET", "/api/skills");
        const allSkills = r.data || [];
        const mcpSkills = allSkills.filter((sk: unknown) => {
          const s = sk as Record<string, unknown>;
          return s.type === "mcp" || s.type === "mcp-server" || (s.tags && Array.isArray(s.tags) && s.tags.includes("mcp"));
        });
        if (opts.json) {
          console.log(JSON.stringify(mcpSkills, null, 2));
          return;
        }
        console.log(`\n${c("bold", "=== MCP Servers ===\n")}`);
        if (mcpSkills.length === 0) {
          console.log(`  ${c("gray", "No MCP servers configured yet")}`);
          console.log(`\n  ${c("gray", "Configure: EvoClaw mcp set <name> <json-config>")}`);
        } else {
          for (const sk of mcpSkills) {
            const s = sk as Record<string, unknown>;
            const name = String(s.name || s.id || "unknown");
            const version = s.version ? ` ${c("gray", `v${s.version}`)}` : "";
            const status = s.status || s.enabled;
            const statusStr = status === false || status === "disabled"
              ? c("yellow", "disabled")
              : c("green", "enabled");
            console.log(`  ${ICONS.bullet()} ${name}${version}  [${statusStr}]`);
          }
        }
        console.log();
      } catch (err) {
        console.log(c("yellow", `${ICONS.warn()} Could not fetch MCP servers: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  mcp
    .command("show <name>")
    .description("Show MCP server config")
    .option("--json", "Output as JSON")
    .action(async (name: string, opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("GET", `/api/skills/${encodeURIComponent(name)}`);
        if (r.status === 404) {
          console.log(c("yellow", `${ICONS.warn()} MCP server "${name}" not found`));
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
          return;
        }
        const data = r.data;
        console.log(`\n${c("bold", `MCP Server: ${name}`)}`);
        if (data.id) console.log(`  ID: ${data.id}`);
        if (data.type) console.log(`  Type: ${data.type}`);
        const status = data.status || data.enabled;
        console.log(`  Status: ${status === false || status === "disabled" ? c("yellow", "disabled") : c("green", "enabled")}`);
        if (data.version) console.log(`  Version: ${data.version}`);
        if (data.description) console.log(`  Description: ${data.description}`);
        if (data.config) {
          console.log(`  Config:`);
          console.log(`    ${c("gray", JSON.stringify(data.config, null, 2).split("\n").join("\n    "))}`);
        }
        if (data.endpoint || data.url) console.log(`  Endpoint: ${data.endpoint || data.url}`);
        console.log();
      } catch (err) {
        if (err instanceof Error && err.message.includes("404")) {
          console.log(c("yellow", `${ICONS.warn()} MCP server "${name}" not found`));
        } else {
          console.log(c("yellow", `${ICONS.warn()} Could not fetch MCP server: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
    });

  mcp
    .command("set <name> [config-json]")
    .description("Configure an MCP server")
    .action(async (name: string, configJson: string | undefined) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      if (!configJson) {
        console.log(c("yellow", `${ICONS.warn()} Usage: EvoClaw mcp set <name> '<json-config>'`));
        console.log(c("gray", `  Example: EvoClaw mcp set my-server '{"command":"node","args":["server.js"]}'`));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(configJson);
      } catch {
        console.log(c("red", `${ICONS.error()} Invalid JSON config string`));
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("PUT", `/api/skills/${encodeURIComponent(name)}/config`, { config: parsed });
        if (r.status >= 200 && r.status < 300) {
          console.log(c("green", `${ICONS.ok()} MCP server "${name}" configured`));
        } else {
          const msg = r.data?.error || r.data?.message || `HTTP ${r.status}`;
          console.log(c("red", `${ICONS.error()} Configuration failed: ${msg}`));
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Configuration failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  mcp
    .command("unset <name>")
    .description("Remove an MCP server (uninstalls the underlying skill)")
    .action(async (name: string) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("DELETE", `/api/skills/${encodeURIComponent(name)}`);
        if (r.status >= 200 && r.status < 300) {
          console.log(c("green", `${ICONS.ok()} MCP server "${name}" removed`));
        } else if (r.status === 404) {
          console.log(c("yellow", `${ICONS.warn()} MCP server "${name}" not found`));
        } else {
          console.log(c("yellow", `${ICONS.warn()} Could not remove via API. Use the Web UI → Settings → MCP to remove "${name}".`));
        }
      } catch {
        console.log(c("yellow", `${ICONS.warn()} Could not remove via API. Use the Web UI → Settings → MCP to remove "${name}".`));
      }
    });

  // ── External MCP server management ───────────────────────────
  // 管理 EvoClaw 消费的外部 MCP server（如 firecrawl、github 等）

  mcp
    .command("external list")
    .description("List external MCP servers consumed by EvoClaw")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<{ servers: Array<{ name: string; type: string; connected: boolean; toolCount: number; tools: string[]; lastError?: string }>; configPath: string }>("GET", "/api/mcp-external/list");
        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
          return;
        }
        console.log(`\n${c("bold", "=== External MCP Servers ===\n")}`);
        if (!r.data.servers || r.data.servers.length === 0) {
          console.log(`  ${c("gray", "No external MCP servers configured")}`);
          console.log(`\n  ${c("gray", "Add one with: evoclaw mcp external add <name> '<json-config>'")}`);
          console.log(`  ${c("gray", "Example config: config/mcp-servers.example.json")}`);
          if (r.data.configPath) {
            console.log(`  ${c("gray", `Config file: ${r.data.configPath}`)}`);
          }
        } else {
          for (const s of r.data.servers) {
            const status = s.connected ? c("green", "connected") : c("red", "disconnected");
            console.log(`  ${ICONS.bullet()} ${s.name} [${s.type}] [${status}] — ${s.toolCount} tool(s)`);
            if (s.tools.length > 0 && s.tools.length <= 10) {
              console.log(`    ${c("gray", s.tools.join(", "))}`);
            } else if (s.tools.length > 10) {
              console.log(`    ${c("gray", s.tools.slice(0, 10).join(", ") + ` ... (+${s.tools.length - 10} more)`)}`);
            }
            if (s.lastError) {
              console.log(`    ${c("red", `Error: ${s.lastError}`)}`);
            }
          }
        }
        console.log();
      } catch (err) {
        console.log(c("yellow", `${ICONS.warn()} Could not fetch external MCP servers: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  mcp
    .command("external add <name> [config-json]")
    .description("Add and connect an external MCP server")
    .action(async (name: string, configJson: string | undefined) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      if (!configJson) {
        console.log(c("yellow", `${ICONS.warn()} Usage: evoclaw mcp external add <name> '<json-config>'`));
        console.log(c("gray", `  Example: evoclaw mcp external add firecrawl '{"type":"stdio","command":"npx","args":["-y","firecrawl-mcp"],"env":{"FIRECRAWL_API_KEY":"fc-xxx"}}'`));
        return;
      }
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(configJson);
      } catch {
        console.log(c("red", `${ICONS.error()} Invalid JSON config string`));
        return;
      }
      try {
        const r = await apiRequest<{ success: boolean; name: string; connected: boolean; toolCount: number; tools: string[]; error?: string }>("POST", "/api/mcp-external/add", { name, config });
        if (r.data.success) {
          console.log(c("green", `${ICONS.ok()} MCP server "${r.data.name}" connected with ${r.data.toolCount} tool(s)`));
          if (r.data.tools.length > 0) {
            console.log(c("gray", `  Tools: ${r.data.tools.join(", ")}`));
          }
        } else {
          console.log(c("red", `${ICONS.error()} Failed: ${r.data.error || "unknown error"}`));
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  mcp
    .command("external remove <name>")
    .description("Remove an external MCP server")
    .action(async (name: string) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<{ success: boolean }>("DELETE", `/api/mcp-external/${encodeURIComponent(name)}`);
        if (r.data.success) {
          console.log(c("green", `${ICONS.ok()} MCP server "${name}" removed`));
        } else {
          console.log(c("yellow", `${ICONS.warn()} MCP server "${name}" not found`));
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  mcp
    .command("external reconnect <name>")
    .description("Reconnect an external MCP server")
    .action(async (name: string) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<{ success: boolean; name: string; toolCount: number; tools: string[]; error?: string }>("POST", `/api/mcp-external/${encodeURIComponent(name)}/reconnect`);
        if (r.data.success) {
          console.log(c("green", `${ICONS.ok()} MCP server "${r.data.name}" reconnected with ${r.data.toolCount} tool(s)`));
        } else {
          console.log(c("red", `${ICONS.error()} Failed: ${r.data.error || "unknown error"}`));
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  mcp
    .command("serve")
    .description("Start MCP stdio server (bridges IDE ↔ EvoClaw Gateway)")
    .action(() => {
      const mcpScript = path.resolve(__dirname, "..", "..", "..", "..", "apps", "mcp-server", "dist", "index.js");
      if (!fs.existsSync(mcpScript)) {
        console.log(c("red", `${ICONS.error()} MCP server not built. Build it first: pnpm --filter @evoclaw/mcp-server build`));
        console.log(c("gray", `  Expected at: ${mcpScript}`));
        process.exitCode = 1;
        return;
      }
      const env: Record<string, string | undefined> = { ...process.env };
      if (!env.EVOCLAW_GATEWAY_URL) {
        env.EVOCLAW_GATEWAY_URL = `http://localhost:${process.env.EvoClaw_PORT || "27788"}`;
      }
      const child = child_process.spawn("node", [mcpScript], {
        stdio: "inherit",
        env: env as Record<string, string>,
      });
      child.on("exit", (code) => { process.exitCode = code || 0; });
      child.on("error", (err) => {
        process.stderr.write(`${ICONS.error()} Failed to start MCP server: ${err.message}\n`);
        process.exitCode = 1;
      });
    });
}
