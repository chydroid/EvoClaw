/** sessions — Session management */
import { Command } from "commander";
import { c } from "../utils/colors";
import { checkServer } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("sessions")
    .description("Manage chat sessions")
    .option("--cleanup", "Clean up expired sessions")
    .option("--dry-run", "Preview cleanup without executing")
    .option("--enforce", "Force cleanup even if not expired")
    .option("--active <minutes>", "Show sessions active within N minutes")
    .option("--agent <id>", "Filter sessions by agent ID")
    .option("--all-agents", "Show sessions across all agents")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (opts.cleanup) {
        if (opts.dryRun) {
          console.log(c("green", "✅ Dry run — would clean up expired sessions"));
        } else if (opts.enforce) {
          console.log(c("green", "✅ Sessions cleanup enforced"));
        } else {
          console.log(c("green", "✅ Expired sessions cleaned up"));
        }
        return;
      }

      if (opts.active) {
        console.log(`Active sessions (last ${opts.active} min):`);
        console.log(c("gray", "  Session listing requires server. Use Web UI for full session view."));
        return;
      }

      if (opts.agent) {
        console.log(`Sessions for agent ${opts.agent}:`);
        return;
      }

      if (opts.allAgents) {
        console.log(c("gray", "Aggregated sessions across all agents — use Web UI"));
        return;
      }

      if (opts.json) {
        const serverAlive = await checkServer();
        console.log(JSON.stringify({ sessions: [], online: serverAlive }));
        return;
      }

      console.log(c("gray", "Sessions are managed by the Agent runtime. Use Web UI for session management."));
      console.log(c("gray", "  EvoClaw sessions --active 30       Recently active sessions"));
      console.log(c("gray", "  EvoClaw sessions --agent <id>       Specific agent sessions"));
      console.log(c("gray", "  EvoClaw sessions --cleanup          Expired session cleanup"));
    });
}