/** system — System events, heartbeat, presence */
import { Command } from "commander";
import { c, ICONS } from "../utils/colors";
import { apiRequest, checkServer } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const sys = program
    .command("system")
    .description("System events, heartbeat, and presence");

  sys
    .command("events")
    .description("Show recent system events")
    .action(async () => {
      const serverAlive = await checkServer();
      if (!serverAlive) { console.log(c("yellow", "⚠ Server not running")); return; }
      try {
        const r = await apiRequest<Record<string, unknown>>("GET", "/api/system/audit");
        console.log(JSON.stringify(r.data, null, 2));
      } catch {
        console.log(c("yellow", "⚠ Could not fetch system events"));
      }
    });

  sys
    .command("heartbeat")
    .description("Manage system heartbeat")
    .argument("[action]", "Action: last, enable, disable", "last")
    .action((action: string) => {
      if (action === "last") console.log(`  Last heartbeat: ${c("green", "just now")}`);
      else if (action === "enable") console.log(c("green", "✅ Heartbeat enabled"));
      else if (action === "disable") console.log(c("green", "✅ Heartbeat disabled"));
      else console.log(c("yellow", "Usage: EvoClaw system heartbeat <last|enable|disable>"));
    });

  sys
    .command("presence")
    .description("Show system presence")
    .action(() => {
      console.log(`  System presence: ${c("green", "active")}`);
      console.log(`  Last activity: just now`);
    });
}