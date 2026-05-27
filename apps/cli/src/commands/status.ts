/** status — Service and system status */
import { Command } from "commander";
import { c, ICONS } from "../utils/colors";
import { apiRequest, checkServer, DEFAULT_PORT } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("status")
    .description("Show service and system status")
    .option("--all", "Show all services")
    .option("--deep", "Deep diagnostic scan")
    .option("--usage", "Show usage summary")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const isJson = !!opts.json;
      const isAll = !!opts.all;
      const isDeep = !!opts.deep;
      const isUsage = !!opts.usage;
      const serverAlive = await checkServer();

      if (!serverAlive) {
        if (isJson) console.log(JSON.stringify({ online: false }));
        else console.log(c("yellow", "⚠ Server not running. Start with: EvoClaw gateway start"));
        return;
      }

      try {
        const r = await apiRequest<unknown[]>("GET", "/api/system/services");
        const services = r.data || [];

        if (isJson) {
          console.log(JSON.stringify({ online: true, port: DEFAULT_PORT, services }, null, 2));
          return;
        }

        if (!isAll && !isDeep) {
          console.log();
          console.log(`${c("bold", "=== EvoClaw Status ===\n")}`);
        }

        console.log(`  Server: ${c("green", "running")} on port ${DEFAULT_PORT}`);
        console.log(`  Services: ${services.length}`);

        const limit = isAll || isDeep ? services.length : 10;
        for (let i = 0; i < Math.min(services.length, limit); i++) {
          const s = services[i] as Record<string, unknown>;
          console.log(`    ${ICONS.bullet()} ${s.name}: ${c("gray", String(s.status || "running"))}`);
        }
        if (services.length > limit) {
          console.log(`    ${c("gray", `... and ${services.length - limit} more. Use --all for full list.`)}`);
        }

        if (isDeep) {
          console.log(`\n  ${c("bold", "Deep Probe:")}`);
          console.log(`    ${ICONS.ok()} Gateway reachable`);
          console.log(`    ${c("gray", "Use EvoClaw channels status --deep for channel diagnostics")}`);
        }

        if (isUsage) {
          console.log(`\n  ${c("bold", "Usage Summary:")}`);
          console.log(`    ${c("gray", "Usage tracking requires provider credentials.")}`);
          console.log(`    ${c("gray", "Configure via Web UI → LLM tab.")}`);
        }
        console.log();
      } catch {
        console.log(c("yellow", "⚠ Could not fetch status. Server may be starting up."));
      }
    });
}