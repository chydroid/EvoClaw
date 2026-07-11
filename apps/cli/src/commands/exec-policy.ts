/**
 * exec-policy — 显示或同步请求的执行策略与 host 审批
 *
 * 对齐 openclaw-main 的 src/cli/exec-policy-cli.ts
 * 子命令：show / preset <name> / set
 *
 * 注：对应后端端点尚未实现，CLI 暂不可用，请使用 WebUI → Security 标签页。
 */
import { Command } from "commander";
import { c } from "../utils/colors";

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

const NOT_AVAILABLE = "⚠ Execution policy management is not yet available via CLI. Use WebUI → Security tab.";

export function register(program: Command): void {
  const execPolicy = program
    .command("exec-policy")
    .description("Show or synchronize requested exec policy with host approvals")
    .option("--json", "Output as JSON");

  execPolicy
    .command("show")
    .description("Show the local config policy, host approvals, and effective merge")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  execPolicy
    .command("preset <name>")
    .description('Apply a synchronized preset: "yolo", "cautious", or "deny-all"')
    .option("--json", "Output as JSON")
    .action(async (name: string) => {
      const preset = PRESETS[name];
      if (!preset) {
        console.log(c("red", `Unknown preset: ${name}. Available: ${Object.keys(PRESETS).join(", ")}`));
        process.exitCode = 1;
        return;
      }
      console.log(c("yellow", NOT_AVAILABLE));
    });

  execPolicy
    .command("set")
    .description("Synchronize local config and host approvals using explicit values")
    .option("--host <host>", 'Host scope: "local" | "local+gateway" | "off"')
    .option("--security <mode>", 'Security mode: "off" | "default" | "deny"')
    .option("--ask <mode>", 'Ask mode: "off" | "default" | "deny"')
    .option("--ask-fallback <mode>", 'Fallback when ask times out: "off" | "default" | "deny"')
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });
}
