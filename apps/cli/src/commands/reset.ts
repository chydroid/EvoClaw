/** reset — Reset all data */
import { Command } from "commander";
import { c } from "../utils/colors";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("reset")
    .description("Reset all local data")
    .option("--confirm", "Confirm reset (required)")
    .action((opts: Record<string, unknown>) => {
      if (!opts.confirm) {
        console.log(c("yellow", "⚠ This will delete all local data (skills, .env, sessions, etc.)"));
        console.log(c("gray", "  Use --confirm to proceed. This operation cannot be undone."));
        return;
      }
      console.log(c("red", "⛔ Reset would delete all local data."));
      console.log(c("gray", "  For safety, manually remove: skills/ .env data/"));
    });
}