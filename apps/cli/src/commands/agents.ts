/** agents — List agents */
import { Command } from "commander";
import { c, ICONS } from "../utils/colors";
import { apiRequest, checkServer } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("agents")
    .description("List and manage agents")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", "⚠ Server not running"));
        return;
      }
      try {
        const r = await apiRequest<Array<Record<string, unknown>>>("GET", "/api/system/services");
        const services = r.data || [];
        const agents = services.filter(s => String(s.name || "").toLowerCase().includes("agent"));

        if (opts.json) {
          console.log(JSON.stringify(agents, null, 2));
        } else {
          console.log(`\n${c("bold", "=== Agents ===\n")}`);
          for (const a of agents) {
            console.log(`  ${ICONS.bullet()} ${a.name}: ${c("gray", String(a.status || "active"))}`);
          }
          if (agents.length === 0) console.log(`  ${c("gray", "No agents configured yet")}`);
          console.log();
        }
      } catch {
        console.log(c("yellow", "⚠ Could not fetch agents"));
      }
    });
}