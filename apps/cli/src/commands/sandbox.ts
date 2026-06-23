import { Command } from "commander";
import { c, ICONS, divider, section } from "../utils/colors";
import { apiRequest, checkServer } from "../utils/api";

interface ServiceInfo {
  name: string;
  status: string;
  type?: string;
  uptime?: number;
  details?: Record<string, unknown>;
}

interface HealthInfo {
  status: string;
  sandbox?: {
    running: boolean;
    mode?: string;
    containers?: number;
    memoryUsage?: string;
    uptime?: number;
  };
  policy?: {
    network: string;
    filesystem: string;
    processes: string;
    memory: string;
    timeout: string;
  };
  [key: string]: unknown;
}

async function ensureServer(): Promise<boolean> {
  const alive = await checkServer();
  if (!alive) {
    console.log(c("red", "❌ Gateway not reachable. Start with: EvoClaw gateway start"));
    return false;
  }
  return true;
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const sandbox = program
    .command("sandbox")
    .description("Manage sandbox environments");

  sandbox
    .command("list")
    .description("List sandbox-related services")
    .option("--all", "Show all services including non-sandbox")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<ServiceInfo[] | { services: ServiceInfo[] }>("GET", "/api/system/services");
        const allServices = Array.isArray(r.data) ? r.data : (r.data?.services || []);
        const services = opts.all
          ? allServices
          : allServices.filter((s) =>
              (s.name || "").toLowerCase().includes("sandbox") ||
              (s.type || "").toLowerCase().includes("sandbox") ||
              (s.name || "").toLowerCase().includes("crestodian")
            );

        if (opts.json) {
          console.log(JSON.stringify({ services }, null, 2));
          return;
        }

        console.log();
        console.log(c("bold", "=== Sandbox Services ===\n"));

        if (services.length === 0) {
          console.log(c("gray", "  No sandbox services found."));
          console.log();
          return;
        }

        for (const s of services) {
          const statusIcon = s.status === "running" || s.status === "active"
            ? ICONS.ok()
            : s.status === "stopped" || s.status === "inactive"
              ? ICONS.error()
              : ICONS.warn();
          console.log(`  ${statusIcon} ${c("cyan", s.name)}: ${s.status}`);
          if (s.uptime != null) {
            console.log(`    Uptime: ${c("gray", `${s.uptime}s`)}`);
          }
          if (s.details) {
            for (const [k, v] of Object.entries(s.details)) {
              console.log(`    ${c("gray", k)}: ${c("gray", String(v))}`);
            }
          }
        }
        console.log();
      } catch (err) {
        console.log(c("red", `❌ Failed to fetch services: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  sandbox
    .command("status")
    .description("Show sandbox runtime status")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<HealthInfo>("GET", "/api/crestodian/health");
        const data = r.data;

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        console.log();
        console.log(c("bold", "=== Sandbox Status ===\n"));

        const overallStatus = data.status || "unknown";
        const statusIcon = overallStatus === "ok" || overallStatus === "healthy"
          ? ICONS.ok()
          : overallStatus === "error" || overallStatus === "unhealthy"
            ? ICONS.error()
            : ICONS.warn();
        console.log(`  ${statusIcon} Overall: ${overallStatus}`);

        if (data.sandbox) {
          const sb = data.sandbox;
          const runIcon = sb.running ? ICONS.ok() : ICONS.error();
          console.log(`  ${runIcon} Running:  ${sb.running ? c("green", "yes") : c("red", "no")}`);
          if (sb.mode) console.log(`  ${ICONS.bullet()} Mode:     ${c("cyan", sb.mode)}`);
          if (sb.containers != null) console.log(`  ${ICONS.bullet()} Containers: ${sb.containers}`);
          if (sb.memoryUsage) console.log(`  ${ICONS.bullet()} Memory:   ${c("gray", sb.memoryUsage)}`);
          if (sb.uptime != null) console.log(`  ${ICONS.bullet()} Uptime:   ${c("gray", `${sb.uptime}s`)}`);
        } else {
          console.log(c("gray", "  No sandbox details available."));
        }

        console.log();
      } catch (err) {
        console.log(c("red", `❌ Failed to fetch sandbox status: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  sandbox
    .command("recreate")
    .description("Recreate sandbox containers via gateway restart")
    .option("--all", "Recreate all sandbox containers")
    .option("--session <id>", "Recreate for a specific session")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const body: Record<string, unknown> = { action: "recreate" };
        if (opts.all) body.scope = "all";
        if (opts.session) body.sessionId = opts.session;

        const r = await apiRequest<{ success: boolean; message?: string }>("POST", "/api/system/services", body);
        if (r.data?.success || r.status === 200) {
          const scope = opts.all ? "all containers" : opts.session ? `session "${opts.session}"` : "default sandbox";
          console.log(c("green", `✅ Sandbox recreated (${scope})`));
          if (r.data?.message) {
            console.log(c("gray", `  ${r.data.message}`));
          }
        } else {
          console.log(c("yellow", "⚠ Sandbox recreation may not have succeeded. Check gateway logs."));
        }
      } catch (err) {
        console.log(c("red", `❌ Failed to recreate sandbox: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  sandbox
    .command("explain")
    .description("Explain current sandbox security policy")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<HealthInfo>("GET", "/api/crestodian/health");
        const policy = r.data?.policy;

        if (opts.json) {
          console.log(JSON.stringify({ policy }, null, 2));
          return;
        }

        console.log();
        console.log(c("bold", "=== Sandbox Security Policy ===\n"));

        if (!policy) {
          console.log(c("gray", "  No policy information available from API."));
          console.log(c("gray", "  Ensure the Crestodian service is running."));
          console.log();
          return;
        }

        const rows: [string, string][] = [
          ["Network", policy.network || "—"],
          ["Filesystem", policy.filesystem || "—"],
          ["Processes", policy.processes || "—"],
          ["Memory", policy.memory || "—"],
          ["Timeout", policy.timeout || "—"],
        ];

        for (const [k, v] of rows) {
          console.log(`  ${c("cyan", k.padEnd(14))} ${c("yellow", v)}`);
        }

        console.log();
        console.log(c("gray", "  Use EvoClaw sandbox policy for full policy details."));
        console.log();
      } catch (err) {
        console.log(c("red", `❌ Failed to fetch policy: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  sandbox
    .command("policy")
    .description("Show detailed sandbox policy")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<HealthInfo>("GET", "/api/crestodian/health");
        const data = r.data;
        const policy = data?.policy;

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        console.log();
        console.log(c("bold", "=== Sandbox Policy Details ===\n"));

        console.log(`  ${ICONS.bullet()} Status: ${data.status || "unknown"}`);

        if (data.sandbox) {
          const sb = data.sandbox;
          console.log(`  ${ICONS.bullet()} Running: ${sb.running ? c("green", "yes") : c("red", "no")}`);
          if (sb.mode) console.log(`  ${ICONS.bullet()} Mode:    ${c("cyan", sb.mode)}`);
        }

        console.log();

        if (policy) {
          console.log(c("bold", "  Security Controls:"));
          const controls: [string, string][] = [
            ["Network", policy.network || "—"],
            ["Filesystem", policy.filesystem || "—"],
            ["Processes", policy.processes || "—"],
            ["Memory", policy.memory || "—"],
            ["Timeout", policy.timeout || "—"],
          ];
          for (const [k, v] of controls) {
            console.log(`    ${c("cyan", k.padEnd(14))} ${c("yellow", v)}`);
          }
        } else {
          console.log(c("gray", "  No policy details available."));
        }

        console.log();
      } catch (err) {
        console.log(c("red", `❌ Failed to fetch sandbox policy: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
}
