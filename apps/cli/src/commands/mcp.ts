import { Command } from "commander";
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
        const r = await apiRequest<Record<string, unknown>>("PUT", `/api/skills/${encodeURIComponent(name)}/config`, parsed);
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
    .description("Remove an MCP server")
    .action(async (name: string) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("DELETE", `/api/plugins/${encodeURIComponent(name)}`);
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

  mcp
    .command("serve")
    .description("Start MCP stdio server")
    .action(() => {
      console.log(c("cyan", `${ICONS.info()} MCP servers are managed automatically by the EvoClaw gateway.`));
      console.log(c("gray", `  The gateway exposes MCP endpoints when MCP-type skills are configured.`));
      console.log(c("gray", `  No manual serve action is needed.`));
      console.log(c("gray", `  To add an MCP server: EvoClaw mcp set <name> '<json-config>'`));
    });
}
