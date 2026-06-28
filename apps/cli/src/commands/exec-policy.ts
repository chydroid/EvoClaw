/**
 * exec-policy — 显示或同步请求的执行策略与 host 审批
 *
 * 对齐 openclaw-main 的 src/cli/exec-policy-cli.ts
 * 子命令：show / preset <name> / set
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
} from "../utils/shared";

interface ExecPolicyEntry {
  source: string;
  rule: string;
  decision?: "allow" | "deny" | "prompt";
  scope?: string;
  reason?: string;
}

interface ExecPolicyShow {
  requested: ExecPolicyEntry[];
  hostApprovals: ExecPolicyEntry[];
  effective: ExecPolicyEntry[];
  preset?: string;
  host: string;
  security: string;
  ask: string;
  askFallback: string;
}

const PRESETS: Record<string, { host: string; security: string; ask: string; askFallback: string; description: string }> = {
  yolo: {
    host: "local",
    security: "off",
    ask: "off",
    askFallback: "off",
    description: "全部放行，不询问，不审批（仅用于本地开发）",
  },
  cautious: {
    host: "local+gateway",
    security: "default",
    ask: "default",
    askFallback: "deny",
    description: "默认审批 + 写操作询问 + 兜底拒绝",
  },
  "deny-all": {
    host: "off",
    security: "deny",
    ask: "deny",
    askFallback: "deny",
    description: "全部拒绝，安全默认",
  },
};

export function register(program: Command): void {
  const execPolicy = program
    .command("exec-policy")
    .description("Show or synchronize requested exec policy with host approvals")
    .option("--json", "Output as JSON");

  execPolicy
    .command("show")
    .description("Show the local config policy, host approvals, and effective merge")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<ExecPolicyShow>("GET", "/api/exec-policy/show");
        if (opts.json || (execPolicy.opts() as { json?: boolean }).json) {
          printJson(r.data);
          return;
        }
        const data = r.data;
        console.log();
        console.log(c("bold", `${ICONS.rock}  Exec Policy`));
        console.log(divider());
        console.log(`  Preset:        ${data.preset ?? c("gray", "(custom)")}`);
        console.log(`  Host:          ${c("cyan", data.host)}`);
        console.log(`  Security:      ${c("cyan", data.security)}`);
        console.log(`  Ask:           ${c("cyan", data.ask)}`);
        console.log(`  Ask fallback:  ${c("cyan", data.askFallback)}`);
        console.log();
        console.log(c("bold", "Requested policy:"));
        if (data.requested.length === 0) console.log(c("gray", "  (none)"));
        else printExecPolicyTable(data.requested);
        console.log();
        console.log(c("bold", "Host approvals:"));
        if (data.hostApprovals.length === 0) console.log(c("gray", "  (none)"));
        else printExecPolicyTable(data.hostApprovals);
        console.log();
        console.log(c("bold", "Effective merge:"));
        if (data.effective.length === 0) console.log(c("gray", "  (none)"));
        else printExecPolicyTable(data.effective);
        console.log();
      } catch (err) {
        printError("Failed to fetch exec policy", err instanceof Error ? err.message : String(err));
      }
    });

  execPolicy
    .command("preset <name>")
    .description('Apply a synchronized preset: "yolo", "cautious", or "deny-all"')
    .option("--json", "Output as JSON")
    .action(async (name: string, opts: Record<string, unknown>) => {
      const preset = PRESETS[name];
      if (!preset) {
        printError(`Unknown preset: ${name}`, `Available: ${Object.keys(PRESETS).join(", ")}`);
        process.exitCode = 1;
        return;
      }
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean; preset: string }>("POST", "/api/exec-policy/preset", { name, ...preset });
        if (opts.json || (execPolicy.opts() as { json?: boolean }).json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) {
          printSuccess(`Applied preset "${name}"`);
          console.log(c("gray", `  ${preset.description}`));
        } else {
          printWarn(`Preset "${name}" may not have been fully applied`);
        }
      } catch (err) {
        printError("Failed to apply preset", err instanceof Error ? err.message : String(err));
      }
    });

  execPolicy
    .command("set")
    .description("Synchronize local config and host approvals using explicit values")
    .option("--host <host>", 'Host scope: "local" | "local+gateway" | "off"')
    .option("--security <mode>", 'Security mode: "off" | "default" | "deny"')
    .option("--ask <mode>", 'Ask mode: "off" | "default" | "deny"')
    .option("--ask-fallback <mode>", 'Fallback when ask times out: "off" | "default" | "deny"')
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const payload: Record<string, string> = {};
      for (const k of ["host", "security", "ask", "askFallback"]) {
        const v = opts[k];
        if (typeof v === "string") payload[k] = v;
      }
      if (Object.keys(payload).length === 0) {
        printError("At least one of --host/--security/--ask/--ask-fallback must be provided");
        process.exitCode = 1;
        return;
      }
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean }>("POST", "/api/exec-policy/set", payload);
        if (opts.json || (execPolicy.opts() as { json?: boolean }).json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) printSuccess("Exec policy updated");
        else printWarn("Policy may not have been fully updated");
      } catch (err) {
        printError("Failed to update exec policy", err instanceof Error ? err.message : String(err));
      }
    });
}

function printExecPolicyTable(entries: ExecPolicyEntry[]): void {
  const rows = entries.map((e) => [e.source, e.rule, e.decision ?? "—", e.scope ?? "—", e.reason ?? ""]);
  printTable(
    [
      { header: "Source" },
      { header: "Rule" },
      { header: "Decision", width: 10 },
      { header: "Scope", width: 16 },
      { header: "Reason" },
    ],
    rows,
  );
}
