/** logs — View Gateway logs */
import { Command } from "commander";
import { c } from "../utils/colors";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("logs")
    .description("View Gateway logs")
    .option("-f, --follow", "Follow log output (tail -f)")
    .option("-t, --tail <n>", "Show last N lines", "50")
    .action((opts: Record<string, unknown>) => {
      if (opts.follow) {
        console.log(c("green", "Following logs (Ctrl+C to stop)..."));
        console.log(c("gray", "  Gateway logs are written to stdout. Use: EvoClaw gateway run for live logs."));
      } else {
        console.log(c("gray", `Showing last ${opts.tail} lines of Gateway output.`));
        console.log(c("yellow", "  Log file not configured. Run Gateway with: EvoClaw gateway run"));
      }
    });
}