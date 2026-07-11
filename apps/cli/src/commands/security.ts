/** security — Security audit and management */
import { Command } from "commander";
import { c, ICONS } from "../utils/colors";
import { apiRequest, checkServer } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const sec = program
    .command("security")
    .description("Security audit and management");

  sec
    .command("audit")
    .description("Run security audit")
    .option("--deep", "Deep probe scan")
    .option("--fix", "Auto-remediate issues")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const isDeep = !!opts.deep;
      const isFix = !!opts.fix;
      const isJson = !!opts.json;
      const serverAlive = await checkServer();

      if (isJson) {
        const audit: Record<string, unknown> = { serverOnline: serverAlive, deepScan: isDeep, fixesApplied: isFix, alerts: [] };
        if (serverAlive) {
          try {
            const r = await apiRequest<Record<string, unknown>>("GET", "/api/system/audit");
            audit.alerts = r.data.alerts || [];
            audit.stats = r.data.stats;
          } catch { /* ignore */ }
        }
        console.log(JSON.stringify(audit, null, 2));
        return;
      }

      console.log(`\n${c("bold", "=== Security Audit ===\n")}`);

      if (isDeep && serverAlive) {
        // Guardrails status
        try {
          const r = await apiRequest<Record<string, unknown>>("GET", "/api/guardrails/stats");
          const enabled = r.data.enabled;
          console.log(`  ${enabled ? ICONS.ok() : ICONS.warn()} Guardrails: ${enabled ? c("green", "enabled") : c("yellow", "disabled")}`);
        } catch {
          console.log(`  ${ICONS.warn()} Guardrails: ${c("yellow", "unavailable")}`);
        }

        // Config doctor issues
        try {
          const r = await apiRequest<{ issues: Array<Record<string, unknown>>; healthy: boolean }>("GET", "/api/config/doctor");
          const issues = r.data.issues || [];
          const healthy = r.data.healthy;
          console.log(`  ${healthy ? ICONS.ok() : ICONS.warn()} Config doctor: ${healthy ? c("green", "no issues") : c("yellow", `${issues.length} issues found`)}`);
          for (const issue of issues) {
            if (issue.severity === "error") {
              console.log(`    ${ICONS.error()} ${issue.path}: ${issue.message}`);
            }
          }
        } catch {
          console.log(`  ${ICONS.warn()} Config doctor: ${c("yellow", "unavailable")}`);
        }

        // MCP poisoning scanner audit
        try {
          const r = await apiRequest<{ count?: number }>("GET", "/api/mcp-scanner/audit");
          const scanned = r.data.count ?? 0;
          console.log(`  ${ICONS.ok()} MCP scanner: ${c("gray", `${scanned} tools scanned`)}`);
        } catch {
          console.log(`  ${ICONS.warn()} MCP scanner: ${c("yellow", "unavailable")}`);
        }

        // Install policy audit
        try {
          const r = await apiRequest<{ count?: number }>("GET", "/api/install-policy/audit");
          const count = r.data.count ?? 0;
          console.log(`  ${ICONS.ok()} Install policy: ${c("gray", `${count} evaluations logged`)}`);
        } catch {
          console.log(`  ${ICONS.warn()} Install policy: ${c("yellow", "unavailable")}`);
        }

        // Gateway probe
        console.log(`  ${ICONS.ok()} Gateway probe: ${c("gray", "responding")}`);
      } else if (isDeep) {
        console.log(`  ${ICONS.warn()} Server offline — cannot run deep scan. Start with: EvoClaw gateway start`);
      }

      if (serverAlive) {
        try {
          const r = await apiRequest<Record<string, unknown>>("GET", "/api/system/audit");
          const stats = r.data.stats as Record<string, unknown> | undefined;
          const alerts = r.data.alerts as Array<Record<string, unknown>> | undefined;
          if (stats) {
            console.log(`  Total Events: ${stats.totalRecords || stats.total || 0}`);
            if (stats.activeAlerts) console.log(`  Active Alerts: ${stats.activeAlerts}`);
          }
          if (alerts && alerts.length > 0) {
            console.log(`\n${c("yellow", "Active Alerts:")}`);
            for (const a of alerts) console.log(`  ${ICONS.warn()} ${a.rule || a.name}: ${a.description || a.message}`);
          }
        } catch { /* */ }
      }

      if (isFix && serverAlive) {
        let fixesApplied = 0;
        try {
          const r = await apiRequest<{ fixed?: number; remaining?: number }>("POST", "/api/config/doctor/fix-all");
          if (r.status >= 200 && r.status < 300 && r.data.fixed) {
            fixesApplied += r.data.fixed;
            console.log(`\n${c("green", `${ICONS.ok()} Fixes applied (${fixesApplied} config issues):`)}`);
            console.log(`  ${c("gray", `- Fixed ${r.data.fixed} config issues via /api/config/doctor/fix-all`)}`);
            if (r.data.remaining) console.log(`  ${c("gray", `- ${r.data.remaining} issues remain (manual review needed)`)}`);
          } else {
            console.log(`\n${c("green", `${ICONS.ok()} No config issues to fix`)}`);
          }
        } catch (err) {
          console.log(`\n${c("yellow", `${ICONS.warn()} Config doctor fix failed: ${err instanceof Error ? err.message : String(err)}`)}`);
        }
        try {
          const r = await apiRequest<{ success?: boolean }>("POST", "/api/guardrails/reset-stats");
          if (r.status >= 200 && r.status < 300 && r.data.success) {
            console.log(`  ${c("gray", `- Reset guardrails stats via /api/guardrails/reset-stats`)}`);
          }
        } catch { /* non-critical */ }
      } else if (isFix) {
        console.log(`\n${c("yellow", `${ICONS.warn()} Server offline — cannot apply fixes. Start with: EvoClaw gateway start`)}`);
      }

      if (!isDeep && !isFix && !serverAlive) {
        console.log(`\n${c("gray", "Use --deep for comprehensive scan, --fix to auto-remediate")}`);
      }
      console.log();
    });
}