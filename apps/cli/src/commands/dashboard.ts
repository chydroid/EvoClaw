import { Command } from "commander";
import * as child_process from "child_process";
import { c, ICONS } from "../utils/colors";
import { DEFAULT_PORT, checkServer } from "../utils/api";

function openBrowser(url: string): void {
  const platform = process.platform;
  let command: string;
  if (platform === "win32") {
    command = `start "" "${url}"`;
  } else if (platform === "darwin") {
    command = `open "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }
  try {
    child_process.exec(command, (err) => {
      if (err) {
        console.log(c("yellow", `${ICONS.warn()} Could not open browser automatically`));
        console.log(c("gray", `  Open this URL manually: ${url}`));
      }
    });
  } catch {
    console.log(c("yellow", `${ICONS.warn()} Could not open browser`));
    console.log(c("gray", `  Open this URL manually: ${url}`));
  }
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("dashboard")
    .description("Open the EvoClaw Web Dashboard")
    .option("-p, --port <number>", "Override default port", String(DEFAULT_PORT))
    .option("--no-open", "Print URL without opening browser")
    .action(async (opts: Record<string, unknown>) => {
      const port = opts.port || DEFAULT_PORT;
      const url = `http://localhost:${port}`;

      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Gateway is not running on port ${port}`));
        console.log(c("gray", "  Start it with: EvoClaw gateway start"));
        console.log();
        console.log(c("gray", `  Dashboard URL (when running): ${url}`));
        return;
      }

      console.log(c("green", `${ICONS.ok()} Dashboard: ${url}`));

      if (opts.open !== false) {
        openBrowser(url);
        console.log(c("gray", "  Opening browser..."));
      } else {
        console.log(c("gray", `  Open ${url} in your browser to access the Web UI.`));
      }
    });
}
