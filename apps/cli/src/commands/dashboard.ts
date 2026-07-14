import { Command } from "commander";
import * as child_process from "child_process";
import { c, ICONS } from "../utils/colors";
import { DEFAULT_PORT, checkServer } from "../utils/api";

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "win32") {
    cmd = "cmd.exe";
    args = ["/c", "start", "", url];
  } else if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    // 安全：使用 spawn(shell:false) 避免 URL 进入 shell 造成命令注入
    const child = child_process.spawn(cmd, args, { shell: false, detached: true, stdio: "ignore" });
    child.on("error", () => {
      console.log(c("yellow", `${ICONS.warn()} Could not open browser automatically`));
      console.log(c("gray", `  Open this URL manually: ${url}`));
    });
    child.unref();
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
      const portNum = parseInt(String(opts.port || DEFAULT_PORT), 10);
      if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        console.log(c("red", `${ICONS.error()} Invalid port: ${opts.port}. Must be an integer between 1 and 65535.`));
        process.exitCode = 1;
        return;
      }
      const url = encodeURI(`http://localhost:${portNum}`);

      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Gateway is not running on port ${portNum}`));
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
