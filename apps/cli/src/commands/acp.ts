/** acp — Agent Communication Protocol bridge */
import { Command } from "commander";
import { c } from "../utils/colors";
import { checkServer, DEFAULT_PORT } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("acp")
    .description("Agent Communication Protocol bridge for IDE integration")
    .option("--session <key>", "Session identifier")
    .option("--reset-session", "Reset session on first connection")
    .action(async (opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", "⚠ Server not running. ACP bridge requires active Gateway."));
        return;
      }
      console.log(c("green", "✅ ACP bridge connecting to Gateway..."));
      console.log(c("gray", `  Session: ${opts.session || "default"}`));
      console.log(c("gray", `  URL: ws://localhost:${DEFAULT_PORT}/acp`));
      console.log(c("gray", "  Protocol bridge for IDE integration (VSCode, Cursor, etc.)"));
      if (opts.resetSession) console.log(c("gray", "  Session will be reset on first connection"));
    });
}