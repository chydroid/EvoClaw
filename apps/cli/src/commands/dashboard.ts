/** dashboard — Open web dashboard */
import { Command } from "commander";
import { c } from "../utils/colors";
import { DEFAULT_PORT } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("dashboard")
    .description("Open the EvoClaw Web Dashboard")
    .option("-p, --port <number>", "Override default port", String(DEFAULT_PORT))
    .action((opts: Record<string, unknown>) => {
      const port = opts.port || DEFAULT_PORT;
      const url = `http://localhost:${port}`;
      console.log(c("green", `✅ Dashboard: ${url}`));
      console.log(c("gray", `  Open ${url} in your browser to access the Web UI.`));
    });
}