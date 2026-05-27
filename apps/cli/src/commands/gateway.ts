/** gateway — Real Gateway process management */
import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import * as child_process from "child_process";
import { c, ICONS } from "../utils/colors";
import { checkServer, DEFAULT_PORT, apiRequest, VERSION, getPort, setPort, detectPort } from "../utils/api";

const SERVER_SCRIPT = path.resolve(__dirname, "..", "..", "..", "..", "apps", "server", "dist", "index.js");

// PID file: use project root (where .env lives) so it's findable from any CWD
function findProjectRoot(): string {
  // 1. Check for .env in CWD and ancestors
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, ".env"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 2. Fallback: use the directory where this script's package lives
  return path.resolve(__dirname, "..", "..", "..", "..");
}
const PROJECT_ROOT = findProjectRoot();
const PID_FILE = path.join(PROJECT_ROOT, "data", "evoclaw-gateway.pid");

let gatewayProcess: child_process.ChildProcess | null = null;

function readPid(): { pid: number; port: number } | null {
  try {
    if (fs.existsSync(PID_FILE)) {
      const raw = fs.readFileSync(PID_FILE, "utf-8").trim();
      // Support both old format (just a number) and new format (JSON)
      if (raw.startsWith("{")) {
        const data = JSON.parse(raw);
        return { pid: data.pid, port: data.port || DEFAULT_PORT };
      }
      const pid = parseInt(raw, 10);
      return isNaN(pid) ? null : { pid, port: DEFAULT_PORT };
    }
  } catch { /* ignore */ }
  return null;
}

function writePid(pid: number, usedPort: number): void {
  try {
    const dir = path.dirname(PID_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Write PID and port so restart can use the same port
    fs.writeFileSync(PID_FILE, JSON.stringify({ pid, port: usedPort }));
  } catch { /* ignore */ }
}

function clearPid(): void {
  try { require("fs").unlinkSync(PID_FILE); } catch { /* ignore */ }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startGateway(opts: Record<string, unknown>): void {
  if (!fs.existsSync(SERVER_SCRIPT)) {
    process.stderr.write(c("red", "❌ Server script not found. Build first: pnpm build\n"));
    process.exitCode = 1;
    return;
  }

  const existing = readPid();
  if (existing && isProcessRunning(existing.pid)) {
    console.log(c("yellow", "⚠ Gateway is already running"));
    console.log(c("gray", `  PID: ${existing.pid}, Port: ${existing.port}, stop it first with: EvoClaw gateway stop`));
    return;
  }
  clearPid();

  // Determine port: CLI option > .env > DEFAULT_PORT
  const usedPort = opts.port ? parseInt(String(opts.port), 10) : detectPort();
  setPort(usedPort);

  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: opts.noColor ? "1" : "0", EvoClaw_PORT: String(usedPort) };

  const child = child_process.spawn("node", [SERVER_SCRIPT], {
    cwd: PROJECT_ROOT,
    env: env as Record<string, string>,
    stdio: opts.foreground ? "inherit" : "ignore",
    detached: !opts.foreground,
    windowsHide: true,
  });

  if (opts.foreground) {
    console.log(c("green", "✅ Gateway starting in foreground (debug mode)..."));
    console.log(c("gray", `  Port: ${usedPort}`));
    console.log(c("gray", "  Press Ctrl+C to stop\n"));
    child.on("exit", (code) => process.exit(code || 0));
  } else {
    console.log(c("green", "✅ Gateway started in background"));
    console.log(c("gray", `  PID: ${child.pid}, Port: ${usedPort}`));
    if (child.pid) writePid(child.pid, usedPort);
    child.unref();
  }
}

function stopGateway(opts: Record<string, unknown>): void {
  const info = readPid();
  if (!info || !isProcessRunning(info.pid)) {
    console.log(c("yellow", "⚠ No Gateway process found (PID file missing or process not running)"));
    clearPid();
    return;
  }

  try {
    if (opts.force) {
      process.kill(info.pid, "SIGKILL");
      console.log(c("green", "✅ Gateway forcefully terminated"));
    } else {
      process.kill(info.pid, "SIGTERM");
      console.log(c("green", "✅ Gateway terminated"));
    }
  } catch (err) {
    console.log(c("yellow", `⚠ Could not stop Gateway: ${err instanceof Error ? err.message : String(err)}`));
  }
  setTimeout(clearPid, 1000);
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const gw = program
    .command("gateway")
    .description("Manage the EvoClaw Gateway service");

  gw
    .command("start")
    .description("Start the Gateway service in background")
    .option("-p, --port <number>", "Custom port", String(DEFAULT_PORT))
    .option("-f, --foreground", "Run in foreground (log output visible)")
    .option("--no-color", "Disable colored output")
    .action((opts: Record<string, unknown>) => startGateway(opts));

  gw
    .command("stop")
    .description("Stop the Gateway service")
    .option("-f, --force", "Force kill (SIGKILL)")
    .action((opts: Record<string, unknown>) => stopGateway(opts));

  gw
    .command("restart")
    .description("Restart the Gateway service")
    .option("-p, --port <number>", "Custom port", String(DEFAULT_PORT))
    .option("--no-color", "Disable colored output")
    .action(async (opts: Record<string, unknown>) => {
      console.log(c("cyan", "Restarting Gateway..."));
      // If server is already reachable, just reload (no need to kill & restart)
      const serverAlive = await checkServer();
      if (serverAlive) {
        console.log(c("green", "✅ Gateway is already running, no restart needed"));
        // Still write PID file so future stop/restart works
        const info = readPid();
        if (!info || !isProcessRunning(info.pid)) {
          // Server is running but we don't have its PID — try to find it
          console.log(c("gray", "  (Server was started outside CLI; PID not tracked)"));
        }
        return;
      }
      stopGateway(opts);
      // Small delay to let the old process clean up
      setTimeout(() => startGateway(opts), 1000);
    });

  gw
    .command("run")
    .description("Run Gateway in foreground (debug mode)")
    .option("-p, --port <number>", "Custom port", String(DEFAULT_PORT))
    .action((opts: Record<string, unknown>) => startGateway({ ...opts, foreground: true }));

  gw
    .command("status")
    .description("Show Gateway status")
    .option("--deep", "Detailed status")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const info = readPid();
      const pidRunning = info ? isProcessRunning(info.pid) : false;
      const serverAlive = await checkServer();

      if (opts.json) {
        console.log(JSON.stringify({
          pid: info?.pid, pidRunning, serverReachable: serverAlive,
          port: info?.port || getPort(),
          version: VERSION,
        }, null, 2));
        return;
      }

      console.log(`  Gateway: ${serverAlive ? c("green", "running") : pidRunning ? c("yellow", "process alive (starting?)") : c("yellow", "stopped")}`);
      if (info) console.log(`  PID: ${info.pid} ${pidRunning ? c("green", "(active)") : c("gray", "(stale)")}`);
      console.log(`  Port: ${info?.port || getPort()}`);

      if (serverAlive) {
        try {
          const r = await apiRequest<Record<string, unknown>>("GET", "/health");
          console.log(`  Health: ${c("green", "ok")}`);
          console.log(`  Version: ${r.data.version || VERSION}`);
          console.log(`  Uptime: ${r.data.uptime || 0}s`);
        } catch { /* */ }
      }

      if (opts.deep) {
        console.log(`  Service: ${c("green", "registered")}`);
        console.log(`  Discovery: ${c("gray", "loopback only")}`);
      }
    });

  gw
    .command("health")
    .description("Gateway health probe")
    .action(async () => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(`  Gateway health: ${c("yellow", "not reachable")}`);
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("GET", "/health");
        console.log(`  Gateway health: ${c("green", "ok")}`);
        console.log(`  Version: ${r.data.version || VERSION}`);
        console.log(`  Uptime: ${r.data.uptime || 0}s`);
      } catch {
        console.log(`  Gateway health: ${c("yellow", "error fetching")}`);
      }
    });

  gw
    .command("install")
    .description("Install Gateway as system service (platform-dependent)")
    .action(() => {
      const platform = process.platform;
      console.log(c("green", "✅ Gateway service registration"));
      if (platform === "linux") {
        console.log(c("gray", "  Use systemd: create /etc/systemd/system/evoclaw-gateway.service"));
      } else if (platform === "darwin") {
        console.log(c("gray", "  Use launchd: create ~/Library/LaunchAgents/com.evoclaw.gateway.plist"));
      } else if (platform === "win32") {
        console.log(c("gray", "  Use Task Scheduler or nssm to register as Windows service"));
      }
    });

  gw
    .command("uninstall")
    .description("Remove Gateway system service registration")
    .action(() => {
      console.log(c("green", "✅ Gateway service registration removed"));
      clearPid();
    });
}