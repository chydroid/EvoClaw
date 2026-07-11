/**
 * node — 运行与管理 headless node host 服务
 *
 * 对齐 openclaw-main 的 src/cli/node-cli/register.ts
 * 子命令：run / status / install / uninstall / stop / start / restart
 *
 * 注：对应后端端点尚未实现，CLI 暂不可用。
 */
import { Command } from "commander";
import { c } from "../utils/colors";

const NOT_AVAILABLE = "⚠ Node management is not yet available via CLI.";

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
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  node
    .command("status")
    .description("Show node host status")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
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
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  node
    .command("uninstall")
    .description("Uninstall the node host service")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  for (const sub of ["start", "stop", "restart"] as const) {
    node
      .command(sub)
      .description(`${sub[0]!.toUpperCase()}${sub.slice(1)} the node host service`)
      .option("--json", "Output as JSON")
      .action(async () => {
        console.log(c("yellow", NOT_AVAILABLE));
      });
  }
}
