/** health — Quick health check */
import { Command } from "commander";
import { c, ICONS, divider } from "../utils/colors";
import { apiRequest, checkServer, VERSION } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("health")
    .description("Quick health check of the Gateway service")
    .option("--json", "Output as JSON")
    .option("--verbose", "Verbose output")
    .action(async (opts: Record<string, unknown>) => {
      const isJson = !!opts.json;
      const serverOk = await checkServer();

      if (!serverOk) {
        if (isJson) console.log(JSON.stringify({ status: "offline", timestamp: new Date().toISOString() }));
        else console.log(c("red", "❌ Gateway not reachable. Start with: EvoClaw gateway start"));
        return;
      }

      try {
        const r = await apiRequest<Record<string, unknown>>("GET", "/health");
        const d = r.data;
        if (isJson) {
          console.log(JSON.stringify({ status: "ok", ...d }, null, 2));
          return;
        }
        console.log();
        console.log(`${c("bold", "=== EvoClaw Health ===\n")}`);
        console.log(`  ${c("green", "●")} Status:   ${c("green", "online")}`);
        console.log(`  ${c("gray", "—")} Version:  ${c("gray", String(d.version || VERSION))}`);
        console.log(`  ${c("gray", "—")} Uptime:   ${c("gray", `${d.uptime || 0}s`)}`);
        if (opts.verbose) {
          console.log(`  ${c("gray", "—")} Service:  ${c("gray", "registered")}`);
        }
        console.log();
      } catch (err) {
        console.log(c("red", `❌ Health check failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
}