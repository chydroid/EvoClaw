/**
 * node — 运行与管理 headless node host 服务
 *
 * 对齐 openclaw-main 的 src/cli/node-cli/register.ts
 * 子命令：run / status / install / uninstall / stop / start / restart
 */
import { Command } from "commander";
import { apiRequest } from "../utils/api";
import { c, ICONS, divider } from "../utils/colors";
import {
  ensureServer,
  printJson,
  printError,
  printSuccess,
  printWarn,
  printTable,
  formatTimestamp,
} from "../utils/shared";

interface NodeHostStatus {
  running: boolean;
  host: string;
  port: number;
  tls: boolean;
  tlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
  pid?: number;
  startedAt?: string;
  gatewayConnected: boolean;
  lastHeartbeat?: string;
  uptime?: string;
}

export function register(program: Command): void {
  const node = program
    .command("node")
    .description("Run and manage the headless node host service");

  node
    .command("run")
    .description("Run the headless node host (foreground)")
    .option("--host <host>", "Bind host", "0.0.0.0")
    .option("--port <port>", "Bind port", "27800")
    .option("--tls", "Enable TLS")
    .option("--tls-fingerprint <hex>", "Expected TLS certificate fingerprint")
    .option("--node-id <id>", "Node ID (auto-generated if omitted)")
    .option("--display-name <name>", "Display name shown in gateway")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean; nodeId: string; url: string }>("POST", "/api/node/run", {
          host: opts.host,
          port: parseInt(String(opts.port ?? "27800"), 10),
          tls: !!opts.tls,
          tlsFingerprint: opts.tlsFingerprint,
          nodeId: opts.nodeId,
          displayName: opts.displayName,
        });
        if (r.data?.ok || r.status === 200) {
          printSuccess(`Node host started: ${r.data?.url ?? "(unknown URL)"}`);
          console.log(c("gray", `  Node ID: ${r.data?.nodeId ?? "—"}`));
          console.log(c("gray", "  Press Ctrl+C to stop."));
        } else {
          printWarn("Node host may not have started.");
        }
      } catch (err) {
        printError("Failed to run node host", err instanceof Error ? err.message : String(err));
      }
    });

  node
    .command("status")
    .description("Show node host status")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<NodeHostStatus>("GET", "/api/node/status");
        if (opts.json) {
          printJson(r.data);
          return;
        }
        const s = r.data;
        console.log();
        console.log(c("bold", `${ICONS.rock}  Node Host Status`));
        console.log(divider());
        console.log(`  Running:            ${s.running ? c("green", "yes") : c("red", "no")}`);
        console.log(`  Host:               ${c("cyan", s.host)}:${s.port}`);
        console.log(`  TLS:                 ${s.tls ? c("green", "enabled") : c("gray", "disabled")}`);
        if (s.tlsFingerprint) console.log(`  TLS fingerprint:     ${c("gray", s.tlsFingerprint)}`);
        if (s.nodeId) console.log(`  Node ID:             ${c("cyan", s.nodeId)}`);
        if (s.displayName) console.log(`  Display name:        ${s.displayName}`);
        if (s.pid) console.log(`  PID:                 ${s.pid}`);
        if (s.startedAt) console.log(`  Started at:          ${formatTimestamp(s.startedAt)}`);
        if (s.uptime) console.log(`  Uptime:              ${c("gray", s.uptime)}`);
        console.log(`  Gateway connected:   ${s.gatewayConnected ? c("green", "yes") : c("red", "no")}`);
        if (s.lastHeartbeat) console.log(`  Last heartbeat:      ${formatTimestamp(s.lastHeartbeat)}`);
        console.log();
      } catch (err) {
        printError("Failed to fetch node status", err instanceof Error ? err.message : String(err));
      }
    });

  node
    .command("install")
    .description("Install the node host service (launchd/systemd/schtasks)")
    .option("--host <host>", "Bind host")
    .option("--port <port>", "Bind port")
    .option("--tls", "Enable TLS")
    .option("--tls-fingerprint <hex>", "Expected TLS fingerprint")
    .option("--node-id <id>", "Node ID")
    .option("--display-name <name>", "Display name")
    .option("--runtime <type>", "Runtime: 'systemd-user' | 'systemd-system' | 'launchd' | 'schtasks'")
    .option("--force", "Overwrite existing service")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean; runtime: string; installed: boolean }>("POST", "/api/node/install", {
          host: opts.host,
          port: opts.port ? parseInt(String(opts.port), 10) : undefined,
          tls: !!opts.tls,
          tlsFingerprint: opts.tlsFingerprint,
          nodeId: opts.nodeId,
          displayName: opts.displayName,
          runtime: opts.runtime,
          force: !!opts.force,
        });
        if (opts.json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) printSuccess(`Node host service installed (runtime: ${r.data?.runtime ?? "—"})`);
        else printWarn("Service may not have been installed.");
      } catch (err) {
        printError("Failed to install node service", err instanceof Error ? err.message : String(err));
      }
    });

  node
    .command("uninstall")
    .description("Uninstall the node host service")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean }>("POST", "/api/node/uninstall");
        if (opts.json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) printSuccess("Node host service uninstalled");
        else printWarn("Service may not have been uninstalled.");
      } catch (err) {
        printError("Failed to uninstall node service", err instanceof Error ? err.message : String(err));
      }
    });

  for (const sub of ["start", "stop", "restart"] as const) {
    node
      .command(sub)
      .description(`${sub[0]!.toUpperCase()}${sub.slice(1)} the node host service`)
      .option("--json", "Output as JSON")
      .action(async (opts: Record<string, unknown>) => {
        if (!(await ensureServer())) return;
        try {
          const r = await apiRequest<{ ok: boolean; running: boolean; pid?: number }>("POST", `/api/node/${sub}`);
          if (opts.json) {
            printJson(r.data);
            return;
          }
          if (r.data?.ok || r.status === 200) printSuccess(`Node host ${sub}ed`);
          else printWarn(`Node host may not have ${sub}ed.`);
        } catch (err) {
          printError(`Failed to ${sub} node service`, err instanceof Error ? err.message : String(err));
        }
      });
  }
}
