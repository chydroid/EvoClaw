/**
 * devices — 设备配对与授权 token 管理
 *
 * 对齐 openclaw-main 的 src/cli/devices-cli.ts
 * 子命令：list / remove / clear / approve / reject / rotate / revoke
 *
 * 注：与 `pairing` 命令分工不同：
 * - pairing：DM 配对请求审批（approve inbound）
 * - devices：已配对设备与 token 的全生命周期管理
 *
 * 对应后端端点尚未实现，CLI 暂不可用。
 */
import { Command } from "commander";
import { c } from "../utils/colors";

const NOT_AVAILABLE = "⚠ Device management is not yet available via CLI.";

export function register(program: Command): void {
  const devices = program
    .command("devices")
    .description("Device pairing and auth tokens")
    .option("--json", "Output as JSON");

  devices
    .command("list")
    .description("List paired devices")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  devices
    .command("remove <deviceId>")
    .description("Remove a paired device and revoke its token")
    .option("--yes", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  devices
    .command("clear")
    .description("Remove ALL paired devices (use with caution)")
    .option("--yes", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  devices
    .command("approve <requestId>")
    .description("Approve a pending device pairing request")
    .option("--label <name>", "Device label")
    .option("--scopes <list>", "Comma-separated scopes")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  devices
    .command("reject <requestId>")
    .description("Reject a pending device pairing request")
    .option("--reason <text>", "Rejection reason")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  devices
    .command("rotate <deviceId>")
    .description("Rotate the auth token for a paired device")
    .option("--yes", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  devices
    .command("revoke <deviceId>")
    .description("Revoke the auth token for a paired device (keeps the device entry)")
    .option("--yes", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });
}
