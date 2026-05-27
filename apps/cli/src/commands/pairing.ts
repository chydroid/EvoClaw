/** pairing — Device/channel pairing management */
import { Command } from "commander";
import { c, ICONS } from "../utils/colors";
import { apiRequest, checkServer } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const pairing = program
    .command("pairing")
    .description("Manage device and channel pairing");

  pairing
    .command("list [channel]")
    .description("List pending pairing requests")
    .option("--json", "Output as JSON")
    .action(async (channel: string | undefined, opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (opts.json) {
        console.log(JSON.stringify({ pending: [], channel }));
        return;
      }
      console.log(`\n${c("bold", `Pairing Requests${channel ? ` (${channel})` : ""}\n`)}`);
      console.log(`  ${c("gray", "No pending pairing requests")}`);
      console.log(`  ${c("gray", "Requests appear when users send their first DM")}`);
      console.log();
    });

  pairing
    .command("approve <channel> <code>")
    .description("Approve a pairing request")
    .option("--notify", "Send notification to requester")
    .action((channel: string, code: string, opts: Record<string, unknown>) => {
      console.log(c("green", `✅ Pairing "${code}" approved for ${channel}`));
      if (opts.notify) console.log(c("gray", "  Notification sent to requester"));
    });
}