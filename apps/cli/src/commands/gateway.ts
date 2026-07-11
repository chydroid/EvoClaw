/** gateway — Real Gateway process management */
import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import * as child_process from "child_process";
import { c, ICONS } from "../utils/colors";
import { checkServer, DEFAULT_PORT, apiRequest, VERSION, getPort, setPort, detectPort } from "../utils/api";

const SERVER_SCRIPT = path.resolve(__dirname, "..", "..", "..", "..", "apps", "server", "dist", "index.js");

// 探测端口是否仍有进程监听（用于 restart 时等待旧进程退出）
function probePort(targetPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(`http://localhost:${targetPort}/health`, { method: "GET", timeout: 2000 }, (res) => {
      resolve(res.statusCode !== undefined);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}

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
    // Write PID and port so restart can use the same port (atomic: temp + rename)
    const tmp = `${PID_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ pid, port: usedPort }));
    fs.renameSync(tmp, PID_FILE);
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
      stopGateway(opts);
      // 等待旧进程释放端口（最多 10 秒），避免 startGateway 时端口仍被占用
      const targetPort = opts.port ? parseInt(String(opts.port), 10) : getPort();
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const stillUp = await probePort(targetPort);
        if (!stillUp) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      startGateway(opts);
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
      const serverScript = path.resolve(__dirname, "..", "..", "..", "..", "apps", "server", "dist", "index.js");
      console.log(c("cyan", `${ICONS.info()} Service configuration reference (NOT registered automatically).`));
      console.log(c("gray", `  This command only prints a config template. You must install it manually.\n`));
      if (platform === "linux") {
        console.log(c("bold", "systemd unit file (save as /etc/systemd/system/evoclaw-gateway.service):"));
        console.log(c("gray", `[Unit]
Description=EvoClaw Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_ROOT}
ExecStart=node ${serverScript}
Restart=on-failure
Environment=EvoClaw_PORT=${getPort()}

[Install]
WantedBy=multi-user.target`));
        console.log(c("gray", `\n  Then: sudo systemctl enable --now evoclaw-gateway`));
      } else if (platform === "darwin") {
        console.log(c("bold", "launchd plist (save as ~/Library/LaunchAgents/com.evoclaw.gateway.plist):"));
        console.log(c("gray", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.evoclaw.gateway</string>
  <key>WorkingDirectory</key><string>${PROJECT_ROOT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>node</string>
    <string>${serverScript}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EvoClaw_PORT</key><string>${String(getPort())}</string>
  </dict>
</dict>
</plist>`));
        console.log(c("gray", `\n  Then: launchctl load ~/Library/LaunchAgents/com.evoclaw.gateway.plist`));
      } else if (platform === "win32") {
        console.log(c("bold", "Windows service registration options:"));
        console.log(c("gray", `  1. Use nssm (recommended):`));
        console.log(c("gray", `     nssm install evoclaw-gateway node "${serverScript}"`));
        console.log(c("gray", `     nssm set evoclaw-gateway AppDirectory "${PROJECT_ROOT}"`));
        console.log(c("gray", `     nssm set evoclaw-gateway AppEnvironmentExtra EvoClaw_PORT=${getPort()}`));
        console.log(c("gray", `  2. Or use Task Scheduler to run at logon.`));
      }
    });

  gw
    .command("uninstall")
    .description("Remove Gateway system service registration")
    .action(() => {
      const platform = process.platform;
      console.log(c("cyan", `${ICONS.info()} Service removal reference (NOT unregistered automatically).`));
      console.log(c("gray", `  This command only clears the local PID file. Remove the system service manually.\n`));
      if (platform === "linux") {
        console.log(c("gray", `  sudo systemctl stop evoclaw-gateway && sudo systemctl disable evoclaw-gateway`));
        console.log(c("gray", `  sudo rm /etc/systemd/system/evoclaw-gateway.service`));
      } else if (platform === "darwin") {
        console.log(c("gray", `  launchctl unload ~/Library/LaunchAgents/com.evoclaw.gateway.plist`));
        console.log(c("gray", `  rm ~/Library/LaunchAgents/com.evoclaw.gateway.plist`));
      } else if (platform === "win32") {
        console.log(c("gray", `  nssm remove evoclaw-gateway confirm`));
      }
      clearPid();
      console.log(c("green", `${ICONS.ok()} Local PID file cleared`));
    });

  // ── gateway call ─────────────────────────────────────────────────
  // 直接调用 Gateway RPC 方法（openclaw 兼容：通用 RPC 入口）
  // 注：POST/GET /api/rpc/<method> 尚未实现
  gw
    .command("call <method>")
    .description("Invoke a Gateway RPC method (POST /api/rpc/<method>)")
    .option("--params <json>", "JSON-encoded params", "{}")
    .option("--get", "Use GET instead of POST (read-only methods)")
    .option("--json", "Output raw JSON response")
    .action(async () => {
      console.log(c("yellow", "⚠ Gateway RPC invocation is not yet available via CLI."));
    });

  // ── gateway usage-cost ──────────────────────────────────────────
  // 显示 token 用量与成本统计（openclaw 兼容）
  // 注：GET /api/usage/cost 尚未实现
  gw
    .command("usage-cost")
    .description("Show token usage and cost summary")
    .option("--since <dur>", "Window start (e.g. 24h, 7d)", "24h")
    .option("--by-model", "Group by model")
    .option("--by-agent", "Group by agent")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", "⚠ Usage and cost reporting is not yet available via CLI."));
    });

  // ── gateway stability ───────────────────────────────────────────
  // 显示 Gateway 稳定性指标（错误率、P99 延迟、最近重启）
  // 注：GET /api/stability 尚未实现
  gw
    .command("stability")
    .description("Show Gateway stability metrics (error rate, p99 latency, restarts)")
    .option("--window <dur>", "Time window (e.g. 1h, 24h)", "1h")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", "⚠ Stability metrics are not yet available via CLI."));
    });

  // ── gateway diagnostics ────────────────────────────────────────
  // diagnostics export：导出诊断 bundle（含日志摘要、配置、health 快照）
  const diagnostics = gw
    .command("diagnostics")
    .description("Gateway diagnostics utilities");

  diagnostics
    .command("export")
    .description("Export a diagnostics bundle (logs/config/health snapshot)")
    .option("--output <file>", "Write to file (default: stdout)")
    .option("--include-logs", "Include recent log lines")
    .option("--include-config", "Include sanitized config dump")
    .option("--log-lines <n>", "Max log lines to include", "200")
    .action(async () => {
      // POST /api/diagnostics/export 尚未实现
      console.log(c("yellow", "⚠ Diagnostics export is not yet available via CLI."));
    });

  diagnostics
    .command("health")
    .description("Show diagnostics health snapshot (alias for gateway health)")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) {
        process.stderr.write(c("red", "❌ Gateway not reachable\n"));
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("GET", "/health");
        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
          return;
        }
        console.log(c("green", `✓ Gateway health: ok`));
        console.log(`  Version: ${r.data.version || VERSION}`);
        console.log(`  Uptime:   ${r.data.uptime || 0}s`);
        console.log();
      } catch (err) {
        process.stderr.write(c("red", `❌ Health check failed: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exitCode = 1;
      }
    });

  // ── gateway probe ───────────────────────────────────────────────
  // 探测特定 endpoint 并测量响应时间
  gw
    .command("probe <endpoint>")
    .description("Probe a Gateway endpoint and measure response time")
    .option("--method <method>", "HTTP method", "GET")
    .option("--body <json>", "JSON body for POST/PUT", "{}")
    .option("--json", "Output as JSON")
    .action(async (endpoint: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) {
        process.stderr.write(c("red", "❌ Gateway not reachable\n"));
        return;
      }
      const method = String(opts.method || "GET").toUpperCase();
      let body: unknown = undefined;
      if (method !== "GET" && method !== "HEAD") {
        try {
          body = JSON.parse(String(opts.body || "{}"));
        } catch {
          process.stderr.write(c("red", "❌ Invalid --body JSON\n"));
          process.exitCode = 1;
          return;
        }
      }
      const t0 = Date.now();
      try {
        const r = await apiRequest<unknown>(method, endpoint, body);
        const elapsed = Date.now() - t0;
        if (opts.json) {
          console.log(JSON.stringify({ status: r.status, elapsedMs: elapsed, data: r.data }, null, 2));
          return;
        }
        const statusIcon = r.status >= 200 && r.status < 300 ? c("green", "✓") : r.status >= 400 ? c("red", "✗") : c("yellow", "⚠");
        console.log(`  ${statusIcon} ${method} ${endpoint}`);
        console.log(`    Status:   ${r.status}`);
        console.log(`    Latency:  ${c("cyan", `${elapsed}ms`)}`);
        const preview = JSON.stringify(r.data).slice(0, 200);
        console.log(`    Body:     ${c("gray", preview)}${preview.length >= 200 ? "..." : ""}`);
        console.log();
      } catch (err) {
        const elapsed = Date.now() - t0;
        process.stderr.write(c("red", `❌ Probe failed after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exitCode = 1;
      }
    });

  // ── gateway discover ────────────────────────────────────────────
  // 发现 Gateway 上注册的所有服务与工具
  // 注：GET /api/discover 尚未实现
  gw
    .command("discover")
    .description("Discover services and tools registered on the Gateway")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", "⚠ Service discovery is not yet available via CLI."));
    });
}