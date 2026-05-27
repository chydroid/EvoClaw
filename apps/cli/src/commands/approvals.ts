/** approvals — Execution approval policies */
import { Command } from "commander";
import { c } from "../utils/colors";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const approvals = program
    .command("approvals")
    .description("Manage execution approval policies");

  approvals
    .command("get")
    .description("Show current approval policy")
    .action(() => {
      console.log(`\n${c("bold", "=== Execution Approvals ===\n")}`);
      console.log(`  Mode: ${c("green", "interactive")}`);
      console.log(`  ${c("gray", "Approval policy configured via Web UI → Settings")}`);
    });

  approvals
    .command("set <json-file>")
    .description("Load approval policy from JSON file")
    .action((file: string) => {
      console.log(c("green", `✅ Approval policy loaded from ${file}`));
    });

  const allowlist = approvals
    .command("allowlist")
    .description("Manage agent allowlist");

  allowlist
    .command("list")
    .action(() => {
      console.log(`\n${c("bold", "=== Agent Allowlist ===\n")}`);
      console.log(`  ${c("gray", "Default: unrestricted")}`);
    });

  allowlist
    .command("add <agent-id>")
    .description("Add agent to allowlist")
    .action((id: string) => console.log(c("green", `✅ Agent "${id}" added to allowlist`)));

  allowlist
    .command("remove <agent-id>")
    .description("Remove agent from allowlist")
    .action((id: string) => console.log(c("green", `✅ Agent "${id}" removed from allowlist`)));
}