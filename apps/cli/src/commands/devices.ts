/**
 * devices — 设备配对与授权 token 管理
 *
 * 对齐 openclaw-main 的 src/cli/devices-cli.ts
 * 子命令：list / remove / clear / approve / reject / rotate / revoke
 *
 * 注：与 `pairing` 命令分工不同：
 * - pairing：DM 配对请求审批（approve inbound）
 * - devices：已配对设备与 token 的全生命周期管理
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
  confirmPrompt,
  formatTimestamp,
  maskSecret,
} from "../utils/shared";

interface DeviceEntry {
  deviceId: string;
  label?: string;
  platform?: string;
  pairedAt?: string;
  lastSeenAt?: string;
  hasToken: boolean;
  tokenPreview?: string;
  status: "active" | "revoked" | "expired";
  scopes?: string[];
}

export function register(program: Command): void {
  const devices = program
    .command("devices")
    .description("Device pairing and auth tokens")
    .option("--json", "Output as JSON");

  devices
    .command("list")
    .description("List paired devices")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ devices: DeviceEntry[] }>("GET", "/api/devices/list");
        if (opts.json || (devices.opts() as { json?: boolean }).json) {
          printJson(r.data);
          return;
        }
        const list = r.data?.devices ?? [];
        console.log();
        console.log(c("bold", `${ICONS.rock}  Devices (${list.length})`));
        console.log(divider());
        if (list.length === 0) console.log(c("gray", "  No paired devices."));
        else {
          printTable(
            [
              { header: "Device ID", width: 20 },
              { header: "Label", width: 18 },
              { header: "Platform", width: 12 },
              { header: "Status", width: 10 },
              { header: "Paired At", width: 22 },
              { header: "Last Seen", width: 22 },
              { header: "Token" },
            ],
            list.map((d) => [
              c("cyan", d.deviceId),
              d.label ?? "—",
              d.platform ?? "—",
              formatStatus(d.status),
              formatTimestamp(d.pairedAt),
              formatTimestamp(d.lastSeenAt),
              d.hasToken ? (d.tokenPreview ? maskSecret(d.tokenPreview) : c("green", "yes")) : c("gray", "no"),
            ]),
          );
        }
        console.log();
      } catch (err) {
        printError("Failed to list devices", err instanceof Error ? err.message : String(err));
      }
    });

  devices
    .command("remove <deviceId>")
    .description("Remove a paired device and revoke its token")
    .option("--yes", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action(async (deviceId: string, opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      if (!opts.yes) {
        const ok = await confirmPrompt(`Remove device ${deviceId} and revoke its token?`, false);
        if (!ok) {
          console.log(c("gray", "  Cancelled."));
          return;
        }
      }
      try {
        const r = await apiRequest<{ ok: boolean }>("DELETE", `/api/devices/${deviceId}`);
        if (opts.json || (devices.opts() as { json?: boolean }).json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) printSuccess(`Device ${deviceId} removed`);
        else printWarn(`Device may not have been removed.`);
      } catch (err) {
        printError("Failed to remove device", err instanceof Error ? err.message : String(err));
      }
    });

  devices
    .command("clear")
    .description("Remove ALL paired devices (use with caution)")
    .option("--yes", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      if (!opts.yes) {
        const ok = await confirmPrompt(c("yellow", "Remove ALL paired devices? This cannot be undone."), false);
        if (!ok) {
          console.log(c("gray", "  Cancelled."));
          return;
        }
      }
      try {
        const r = await apiRequest<{ ok: boolean; removed: number }>("POST", "/api/devices/clear");
        if (opts.json || (devices.opts() as { json?: boolean }).json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) printSuccess(`Cleared ${r.data?.removed ?? 0} device(s)`);
        else printWarn("Clear may not have completed.");
      } catch (err) {
        printError("Failed to clear devices", err instanceof Error ? err.message : String(err));
      }
    });

  devices
    .command("approve <requestId>")
    .description("Approve a pending device pairing request")
    .option("--label <name>", "Device label")
    .option("--scopes <list>", "Comma-separated scopes")
    .option("--json", "Output as JSON")
    .action(async (requestId: string, opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean; deviceId: string; token: string }>("POST", "/api/devices/approve", {
          requestId,
          label: opts.label,
          scopes: opts.scopes ? String(opts.scopes).split(",").map((s) => s.trim()) : undefined,
        });
        if (opts.json || (devices.opts() as { json?: boolean }).json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) {
          printSuccess(`Device ${r.data?.deviceId} approved`);
          if (r.data?.token) {
            console.log(c("gray", `  Token: ${maskSecret(r.data.token)}`));
            console.log(c("yellow", "  ⚠  Save this token now — it will not be shown again."));
          }
        } else printWarn("Device may not have been approved.");
      } catch (err) {
        printError("Failed to approve device", err instanceof Error ? err.message : String(err));
      }
    });

  devices
    .command("reject <requestId>")
    .description("Reject a pending device pairing request")
    .option("--reason <text>", "Rejection reason")
    .option("--json", "Output as JSON")
    .action(async (requestId: string, opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean }>("POST", "/api/devices/reject", { requestId, reason: opts.reason });
        if (opts.json || (devices.opts() as { json?: boolean }).json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) printSuccess(`Request ${requestId} rejected`);
        else printWarn("Request may not have been rejected.");
      } catch (err) {
        printError("Failed to reject request", err instanceof Error ? err.message : String(err));
      }
    });

  devices
    .command("rotate <deviceId>")
    .description("Rotate the auth token for a paired device")
    .option("--yes", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action(async (deviceId: string, opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      if (!opts.yes) {
        const ok = await confirmPrompt(`Rotate token for device ${deviceId}? The old token will be invalidated.`, false);
        if (!ok) {
          console.log(c("gray", "  Cancelled."));
          return;
        }
      }
      try {
        const r = await apiRequest<{ ok: boolean; token: string }>("POST", `/api/devices/${deviceId}/rotate`);
        if (opts.json || (devices.opts() as { json?: boolean }).json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) {
          printSuccess(`Token rotated for device ${deviceId}`);
          if (r.data?.token) {
            console.log(c("gray", `  New token: ${maskSecret(r.data.token)}`));
            console.log(c("yellow", "  ⚠  Save this token now — it will not be shown again."));
          }
        } else printWarn("Token may not have been rotated.");
      } catch (err) {
        printError("Failed to rotate token", err instanceof Error ? err.message : String(err));
      }
    });

  devices
    .command("revoke <deviceId>")
    .description("Revoke the auth token for a paired device (keeps the device entry)")
    .option("--yes", "Skip confirmation")
    .option("--json", "Output as JSON")
    .action(async (deviceId: string, opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      if (!opts.yes) {
        const ok = await confirmPrompt(`Revoke token for device ${deviceId}? The device will lose access immediately.`, false);
        if (!ok) {
          console.log(c("gray", "  Cancelled."));
          return;
        }
      }
      try {
        const r = await apiRequest<{ ok: boolean }>("POST", `/api/devices/${deviceId}/revoke`);
        if (opts.json || (devices.opts() as { json?: boolean }).json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) printSuccess(`Token revoked for device ${deviceId}`);
        else printWarn("Token may not have been revoked.");
      } catch (err) {
        printError("Failed to revoke token", err instanceof Error ? err.message : String(err));
      }
    });
}

function formatStatus(status: string): string {
  const map: Record<string, string> = {
    active: c("green", "active"),
    revoked: c("red", "revoked"),
    expired: c("gray", "expired"),
  };
  return map[status] ?? status;
}
