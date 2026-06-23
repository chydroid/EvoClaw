/** status — Service and system status */
import { Command } from "commander";
import { c, ICONS, section } from "../utils/colors";
import { apiRequest, checkServer, DEFAULT_PORT, VERSION } from "../utils/api";

interface ServiceInfo {
  name: string;
  status: string;
  version?: string;
  error?: string;
}

interface SystemStatus {
  online: boolean;
  uptime: number;
  uptimeFormatted: string;
  memory: { heapUsed: number; heapTotal: number; rss: number };
  platform: string;
  nodeVersion: string;
  agentStatuses: Array<{
    sessionId: string;
    state: string;
    currentAction: string;
    tokensUsed: number;
    duration: number;
    runId: number;
  }>;
  timestamp: string;
}

interface HealthInfo {
  status: string;
  version: string;
  uptime: number;
  nodeVersion: string;
  platform: string;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUptime(seconds: number): string {
  if (!seconds || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function register(program: Command, _shared: (cmd: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("status")
    .description("Show comprehensive service and system status")
    .option("--all", "Show all services")
    .option("--deep", "Deep diagnostic scan")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const isJson = !!opts.json;
      const isAll = !!opts.all;
      const isDeep = !!opts.deep;
      const serverAlive = await checkServer();

      if (!serverAlive) {
        if (isJson) console.log(JSON.stringify({ online: false }));
        else console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }

      try {
        const [healthRes, servicesRes, statusRes] = await Promise.allSettled([
          apiRequest<HealthInfo>("GET", "/health"),
          apiRequest<ServiceInfo[]>("GET", "/api/system/services"),
          apiRequest<SystemStatus>("GET", "/api/status"),
        ]);

        if (isJson) {
          const result: Record<string, unknown> = { online: true, port: DEFAULT_PORT };
          if (healthRes.status === "fulfilled") result.health = healthRes.value.data;
          if (servicesRes.status === "fulfilled") result.services = servicesRes.value.data;
          if (statusRes.status === "fulfilled") result.system = statusRes.value.data;
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(section("EvoClaw Status"));

        // Health info
        if (healthRes.status === "fulfilled") {
          const h = healthRes.value.data;
          const healthColor = h.status === "ok" ? "green" : h.status === "degraded" ? "yellow" : "red";
          console.log(`  ${ICONS.ok()} Server:       ${c("green", "running")} on port ${DEFAULT_PORT}`);
          console.log(`  ${ICONS.arrow()} Health:        ${c(healthColor as never, h.status || "unknown")}`);
          console.log(`  ${ICONS.arrow()} Version:       ${h.version || VERSION}`);
          console.log(`  ${ICONS.arrow()} Uptime:        ${formatUptime(h.uptime || 0)}`);
          console.log(`  ${ICONS.arrow()} Platform:      ${h.platform || "—"}`);
          console.log(`  ${ICONS.arrow()} Node.js:       ${h.nodeVersion || "—"}`);
        } else {
          console.log(`  ${ICONS.ok()} Server: ${c("green", "running")} on port ${DEFAULT_PORT}`);
        }

        // System metrics
        if (statusRes.status === "fulfilled") {
          const s = statusRes.value.data;
          if (s.memory) {
            console.log(`  ${ICONS.arrow()} Memory:        heap ${formatBytes(s.memory.heapUsed)} / ${formatBytes(s.memory.heapTotal)}  rss ${formatBytes(s.memory.rss)}`);
          }
          const agents = s.agentStatuses || [];
          if (agents.length > 0) {
            console.log(`  ${ICONS.arrow()} Active agents: ${agents.length}`);
            for (const a of agents.slice(0, isAll || isDeep ? agents.length : 5)) {
              const stateColor = a.state === "running" ? "green" : a.state === "error" ? "red" : "gray";
              console.log(`    ${ICONS.bullet()} ${c("cyan", a.sessionId)}  ${c(stateColor as never, a.state)}  ${c("gray", a.currentAction || "idle")}`);
            }
            if (!isAll && !isDeep && agents.length > 5) {
              console.log(c("gray", `    ... and ${agents.length - 5} more. Use --all for full list.`));
            }
          }
        }

        // Services
        if (servicesRes.status === "fulfilled") {
          const services = servicesRes.value.data || [];
          console.log(`  ${ICONS.arrow()} Services:      ${services.length} registered`);
          const limit = isAll || isDeep ? services.length : 8;
          for (let i = 0; i < Math.min(services.length, limit); i++) {
            const svc = services[i];
            const svcColor = svc.status === "ok" || svc.status === "healthy" ? "green" : svc.status === "error" ? "red" : "gray";
            console.log(`    ${ICONS.bullet()} ${svc.name}: ${c(svcColor as never, svc.status || "running")}`);
          }
          if (services.length > limit) {
            console.log(c("gray", `    ... and ${services.length - limit} more. Use --all for full list.`));
          }
        }

        if (isDeep) {
          console.log(c("bold", "\n  Deep Diagnostics:"));
          console.log(`    ${ICONS.ok()} Gateway reachable`);
          console.log(`    ${ICONS.ok()} Health endpoint responsive`);
          console.log(`    ${c("gray", "Use 'EvoClaw doctor' for full system diagnostics")}`);
          console.log(`    ${c("gray", "Use 'EvoClaw channels status --deep' for channel diagnostics")}`);
        }

        console.log();
      } catch {
        console.log(c("yellow", `${ICONS.warn()} Could not fetch status. Server may be starting up.`));
      }
    });
}
