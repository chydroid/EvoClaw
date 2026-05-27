/** directory — Contact directory management */
import { Command } from "commander";
import { c } from "../utils/colors";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const dir = program
    .command("directory")
    .description("Manage contact directory");

  dir
    .command("self")
    .description("Show current identity")
    .option("-c, --channel <name>", "Channel context")
    .action((opts: Record<string, unknown>) => {
      console.log(`\n${c("bold", "=== Current Identity ===\n")}`);
      console.log(`  Name: EvoClaw`);
      console.log(`  Channel: ${opts.channel || "web-ui"}`);
    });

  dir
    .command("peers [action]")
    .description("Manage peer contacts")
    .option("-c, --channel <name>", "Channel context")
    .option("--query <text>", "Search query")
    .action((action: string, opts: Record<string, unknown>) => {
      if (action === "list" || !action) {
        console.log(`\n${c("bold", `Contacts${opts.channel ? ` (${opts.channel})` : ""}`)}`);
        if (opts.query) console.log(`  Search: "${opts.query}"`);
        console.log(`  ${c("gray", "Contact management via Web UI → Channels tab")}`);
      }
    });

  dir
    .command("groups [action]")
    .description("Manage group contacts")
    .option("-c, --channel <name>", "Channel context")
    .option("--group-id <id>", "Group identifier")
    .action((action: string, opts: Record<string, unknown>) => {
      if (action === "list" || !action) {
        console.log(`\n${c("bold", `Groups${opts.channel ? ` (${opts.channel})` : ""}`)}`);
        console.log(`  ${c("gray", "Group management via Web UI → Channels tab")}`);
      } else if (action === "members") {
        console.log(`\n${c("bold", `Group Members${opts.groupId ? `: ${opts.groupId}` : ""}`)}`);
      }
    });
}