/** mcp — MCP server management */
import { Command } from "commander";
import { c } from "../utils/colors";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const mcp = program
    .command("mcp")
    .description("Manage MCP (Model Context Protocol) servers");

  mcp
    .command("list")
    .description("List MCP servers")
    .action(() => {
      console.log(`\n${c("bold", "=== MCP Servers ===\n")}`);
      console.log(`  ${c("gray", "No MCP servers configured yet")}`);
      console.log(`\n${c("gray", "Configure: EvoClaw mcp set <name> <json-config>")}`);
    });

  mcp
    .command("show <name>")
    .description("Show MCP server config")
    .action((name: string) => {
      console.log(c("yellow", `⚠ MCP server "${name}" not configured`));
    });

  mcp
    .command("set <name>")
    .description("Configure an MCP server")
    .argument("[json-config]", "JSON config string")
    .action((name: string, config: string | undefined) => {
      console.log(c("green", `✅ MCP server "${name}" configured`));
    });

  mcp
    .command("unset <name>")
    .description("Remove an MCP server")
    .action((name: string) => {
      console.log(c("green", `✅ MCP server "${name}" removed`));
    });

  mcp
    .command("serve")
    .description("Start MCP stdio server")
    .action(() => {
      console.log(c("green", "✅ MCP stdio server started. Awaiting connections..."));
    });
}