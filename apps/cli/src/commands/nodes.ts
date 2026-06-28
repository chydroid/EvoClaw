/**
 * nodes — 管理 gateway 名下 node（配对、状态、调用、媒体）
 *
 * 对齐 openclaw-main 的 src/cli/nodes-cli/register.ts
 * 子命令：status / list / describe / pending / approve / reject / remove / rename / invoke / notify / push
 *        camera list|snap|clip / screen record / location get
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
  parseJsonArg,
  parseDurationMs,
  formatTimestamp,
  maskSecret,
} from "../utils/shared";

interface NodeEntry {
  nodeId: string;
  displayName?: string;
  connected: boolean;
  lastConnectedAt?: string;
  capabilities?: string[];
  platform?: string;
  version?: string;
}

interface PendingRequest {
  requestId: string;
  nodeId?: string;
  displayName?: string;
  platform?: string;
  requestedAt: string;
  fingerprint?: string;
}

function sharedNodesOpts(cmd: Command): Command {
  return cmd
    .option("--url <url>", "Gateway base URL (default: localhost)")
    .option("--token <token>", "Auth token (or set EvoClaw_TOKEN)")
    .option("--timeout <ms>", "Request timeout in ms", "10000")
    .option("--json", "Output as JSON");
}

export function register(program: Command): void {
  const nodes = program
    .command("nodes")
    .description("Manage gateway-owned nodes (pairing, status, invoke, and media)");

  nodes
    .command("status")
    .description("List known nodes with connection status and capabilities")
    .option("--connected", "Show only connected nodes")
    .option("--last-connected <duration>", "Show only nodes connected within duration (e.g. 1h, 24h)")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      const lastConnectedMs = opts.lastConnected ? parseDurationMs(String(opts.lastConnected)) : undefined;
      try {
        const r = await apiRequest<{ nodes: NodeEntry[] }>("GET", "/api/nodes/status");
        let list = r.data?.nodes ?? [];
        if (opts.connected) list = list.filter((n) => n.connected);
        if (lastConnectedMs) {
          const cutoff = Date.now() - lastConnectedMs;
          list = list.filter((n) => {
            if (!n.lastConnectedAt) return false;
            const t = Date.parse(n.lastConnectedAt);
            return !isNaN(t) && t >= cutoff;
          });
        }
        if (opts.json) {
          printJson({ nodes: list });
          return;
        }
        console.log();
        console.log(c("bold", `${ICONS.rock}  Nodes (${list.length})`));
        console.log(divider());
        if (list.length === 0) console.log(c("gray", "  No nodes."));
        else {
          printTable(
            [
              { header: "Node ID", width: 18 },
              { header: "Name", width: 16 },
              { header: "Connected", width: 10 },
              { header: "Last Connected", width: 22 },
              { header: "Capabilities" },
            ],
            list.map((n) => [
              c("cyan", n.nodeId),
              n.displayName ?? "—",
              n.connected ? c("green", "yes") : c("red", "no"),
              formatTimestamp(n.lastConnectedAt),
              (n.capabilities ?? []).join(", "),
            ]),
          );
        }
        console.log();
      } catch (err) {
        printError("Failed to fetch nodes", err instanceof Error ? err.message : String(err));
      }
    });

  nodes
    .command("list")
    .description("List pending and paired nodes")
    .option("--connected", "Show only connected nodes")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ nodes: NodeEntry[]; pending: PendingRequest[] }>("GET", "/api/nodes/list");
        if (opts.json) {
          printJson(r.data);
          return;
        }
        const data = r.data;
        console.log();
        console.log(c("bold", `${ICONS.rock}  Nodes`));
        console.log(divider());
        console.log(`  Paired: ${data.nodes.length}`);
        console.log(`  Pending: ${data.pending.length}`);
        console.log();
        if (data.nodes.length > 0) {
          printTable(
            [{ header: "Node ID", width: 18 }, { header: "Name", width: 16 }, { header: "Connected", width: 10 }],
            data.nodes.map((n) => [
              c("cyan", n.nodeId),
              n.displayName ?? "—",
              n.connected ? c("green", "yes") : c("red", "no"),
            ]),
          );
        }
        if (data.pending.length > 0) {
          console.log();
          console.log(c("yellow", "  Pending:"));
          printTable(
            [{ header: "Request ID", width: 18 }, { header: "Display Name", width: 16 }, { header: "Requested At", width: 22 }],
            data.pending.map((p) => [c("cyan", p.requestId), p.displayName ?? "—", formatTimestamp(p.requestedAt)]),
          );
        }
        console.log();
      } catch (err) {
        printError("Failed to list nodes", err instanceof Error ? err.message : String(err));
      }
    });

  nodes
    .command("describe")
    .description("Describe a node (capabilities + supported invoke commands)")
    .requiredOption("--node <id>", "Node ID")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ node: NodeEntry; commands: string[] }>("GET", `/api/nodes/${opts.node}/describe`);
        if (opts.json) {
          printJson(r.data);
          return;
        }
        const d = r.data;
        console.log();
        console.log(c("bold", `${ICONS.rock}  Node: ${c("cyan", String(opts.node))}`));
        console.log(divider());
        console.log(`  Display name:  ${d.node.displayName ?? "—"}`);
        console.log(`  Connected:     ${d.node.connected ? c("green", "yes") : c("red", "no")}`);
        console.log(`  Platform:      ${d.node.platform ?? "—"}`);
        console.log(`  Version:       ${d.node.version ?? "—"}`);
        console.log(`  Capabilities:  ${(d.node.capabilities ?? []).join(", ") || "(none)"}`);
        console.log();
        console.log(c("bold", "  Supported commands:"));
        for (const cmd of d.commands) console.log(c("gray", `    • ${cmd}`));
        console.log();
      } catch (err) {
        printError("Failed to describe node", err instanceof Error ? err.message : String(err));
      }
    });

  nodes
    .command("pending")
    .description("List pending pairing requests")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ pending: PendingRequest[] }>("GET", "/api/nodes/pending");
        if (opts.json) {
          printJson(r.data);
          return;
        }
        const list = r.data?.pending ?? [];
        console.log();
        console.log(c("bold", `${ICONS.rock}  Pending Pairing Requests (${list.length})`));
        console.log(divider());
        if (list.length === 0) console.log(c("gray", "  No pending requests."));
        else {
          printTable(
            [{ header: "Request ID", width: 18 }, { header: "Display Name", width: 16 }, { header: "Platform", width: 12 }, { header: "Requested At", width: 22 }],
            list.map((p) => [c("cyan", p.requestId), p.displayName ?? "—", p.platform ?? "—", formatTimestamp(p.requestedAt)]),
          );
        }
        console.log();
      } catch (err) {
        printError("Failed to list pending", err instanceof Error ? err.message : String(err));
      }
    });

  for (const decision of ["approve", "reject"] as const) {
    nodes
      .command(`${decision} <requestId>`)
      .description(`${decision[0]!.toUpperCase()}${decision.slice(1)} a pending pairing request`)
      .option("--json", "Output as JSON")
      .action(async (requestId: string, opts: Record<string, unknown>) => {
        if (!(await ensureServer())) return;
        try {
          const r = await apiRequest<{ ok: boolean; nodeId?: string }>("POST", `/api/nodes/${decision}`, { requestId });
          if (opts.json) {
            printJson(r.data);
            return;
          }
          if (r.data?.ok || r.status === 200) printSuccess(`Request ${requestId} ${decision}d`);
          else printWarn(`Request ${requestId} may not have been ${decision}d.`);
        } catch (err) {
          printError(`Failed to ${decision} request`, err instanceof Error ? err.message : String(err));
        }
      });
  }

  nodes
    .command("remove")
    .description("Remove a paired node entry")
    .requiredOption("--node <id>", "Node ID")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean }>("DELETE", `/api/nodes/${opts.node}`);
        if (opts.json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) printSuccess(`Node ${opts.node} removed`);
        else printWarn(`Node may not have been removed.`);
      } catch (err) {
        printError("Failed to remove node", err instanceof Error ? err.message : String(err));
      }
    });

  nodes
    .command("rename")
    .description("Rename a paired node (display name override)")
    .requiredOption("--node <id>", "Node ID")
    .requiredOption("--name <name>", "New display name")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean }>("POST", `/api/nodes/${opts.node}/rename`, { name: opts.name });
        if (opts.json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) printSuccess(`Node ${opts.node} renamed to "${opts.name}"`);
        else printWarn("Node may not have been renamed.");
      } catch (err) {
        printError("Failed to rename node", err instanceof Error ? err.message : String(err));
      }
    });

  const invoke = nodes
    .command("invoke")
    .description("Invoke a command on a paired node");
  sharedNodesOpts(invoke)
    .requiredOption("--node <id>", "Node ID")
    .requiredOption("--command <cmd>", "Command name")
    .option("--params <json>", "JSON parameters object")
    .option("--invoke-timeout <ms>", "Invoke timeout in ms", "30000")
    .option("--idempotency-key <key>", "Idempotency key for dedup")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      const params = opts.params ? parseJsonArg(String(opts.params), "--params") : {};
      if (params === null) return;
      try {
        const r = await apiRequest<{ ok: boolean; result?: unknown; error?: string }>("POST", "/api/nodes/invoke", {
          nodeId: opts.node,
          command: opts.command,
          params,
          timeoutMs: parseInt(String(opts.invokeTimeout), 10),
          idempotencyKey: opts.idempotencyKey,
        });
        if (opts.json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) {
          printSuccess(`Command "${opts.command}" completed`);
          if (r.data?.result !== undefined) console.log(c("gray", `  Result: ${JSON.stringify(r.data.result)}`));
          if (r.data?.error) console.log(c("red", `  Error: ${r.data.error}`));
        } else {
          printWarn(`Command "${opts.command}" may not have completed.`);
        }
      } catch (err) {
        printError("Invoke failed", err instanceof Error ? err.message : String(err));
      }
    });

  nodes
    .command("notify")
    .description("Send a local notification on a node")
    .requiredOption("--node <id>", "Node ID")
    .option("--title <title>", "Notification title")
    .option("--body <body>", "Notification body")
    .option("--sound <name>", "Sound name")
    .option("--priority <n>", "Priority (-2..2)", "0")
    .option("--delivery <type>", "Delivery: 'immediate' | 'scheduled'")
    .option("--invoke-timeout <ms>", "Invoke timeout", "15000")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean; delivered: boolean }>("POST", "/api/nodes/notify", {
          nodeId: opts.node,
          title: opts.title,
          body: opts.body,
          sound: opts.sound,
          priority: parseInt(String(opts.priority ?? "0"), 10),
          delivery: opts.delivery,
          timeoutMs: parseInt(String(opts.invokeTimeout), 10),
        });
        if (opts.json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) printSuccess(`Notification sent to node ${opts.node}`);
        else printWarn("Notification may not have been delivered.");
      } catch (err) {
        printError("Notify failed", err instanceof Error ? err.message : String(err));
      }
    });

  nodes
    .command("push")
    .description("Send an APNs test push to an iOS node")
    .requiredOption("--node <id>", "Node ID")
    .option("--title <title>", "Push title")
    .option("--body <body>", "Push body")
    .option("--environment <env>", "APNs environment: 'sandbox' | 'production'", "sandbox")
    .option("--invoke-timeout <ms>", "Invoke timeout", "25000")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean; sent: boolean }>("POST", "/api/nodes/push", {
          nodeId: opts.node,
          title: opts.title,
          body: opts.body,
          environment: opts.environment,
          timeoutMs: parseInt(String(opts.invokeTimeout), 10),
        });
        if (opts.json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) printSuccess(`Push sent to node ${opts.node}`);
        else printWarn("Push may not have been sent.");
      } catch (err) {
        printError("Push failed", err instanceof Error ? err.message : String(err));
      }
    });

  // camera — 父命令
  const camera = nodes
    .command("camera")
    .description("Capture camera media from a paired node");

  camera
    .command("list")
    .description("List available cameras on a node")
    .requiredOption("--node <id>", "Node ID")
    .option("--invoke-timeout <ms>", "Invoke timeout", "60000")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ cameras: Array<{ id: string; facing?: string; label?: string }> }>("POST", "/api/nodes/camera/list", {
          nodeId: opts.node,
          timeoutMs: parseInt(String(opts.invokeTimeout), 10),
        });
        if (opts.json) {
          printJson(r.data);
          return;
        }
        const list = r.data?.cameras ?? [];
        console.log();
        console.log(c("bold", `${ICONS.rock}  Cameras on node ${opts.node} (${list.length})`));
        console.log(divider());
        if (list.length === 0) console.log(c("gray", "  No cameras."));
        else {
          printTable(
            [{ header: "ID", width: 16 }, { header: "Facing", width: 10 }, { header: "Label" }],
            list.map((c2) => [c("cyan", c2.id), c2.facing ?? "—", c2.label ?? "—"]),
          );
        }
        console.log();
      } catch (err) {
        printError("Camera list failed", err instanceof Error ? err.message : String(err));
      }
    });

  camera
    .command("snap")
    .description("Capture a photo from a node camera")
    .requiredOption("--node <id>", "Node ID")
    .option("--facing <facing>", "Camera facing: 'front' | 'back'")
    .option("--device-id <id>", "Specific camera device ID")
    .option("--max-width <px>", "Max width in pixels")
    .option("--quality <n>", "JPEG quality 0-100", "80")
    .option("--delay-ms <ms>", "Capture delay in ms")
    .option("--invoke-timeout <ms>", "Invoke timeout", "60000")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean; url: string; bytes: number; contentType: string }>("POST", "/api/nodes/camera/snap", {
          nodeId: opts.node,
          facing: opts.facing,
          deviceId: opts.deviceId,
          maxWidth: opts.maxWidth ? parseInt(String(opts.maxWidth), 10) : undefined,
          quality: parseInt(String(opts.quality ?? "80"), 10),
          delayMs: opts.delayMs ? parseInt(String(opts.delayMs), 10) : undefined,
          timeoutMs: parseInt(String(opts.invokeTimeout), 10),
        });
        if (opts.json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) {
          printSuccess(`Photo captured: ${r.data?.url ?? "(no URL)"} (${r.data?.bytes ?? 0} bytes)`);
        } else printWarn("Photo may not have been captured.");
      } catch (err) {
        printError("Camera snap failed", err instanceof Error ? err.message : String(err));
      }
    });

  camera
    .command("clip")
    .description("Capture a short video clip from a node camera")
    .requiredOption("--node <id>", "Node ID")
    .option("--facing <facing>", "Camera facing")
    .option("--device-id <id>", "Specific camera device ID")
    .option("--duration <sec>", "Clip duration in seconds", "5")
    .option("--no-audio", "Disable audio")
    .option("--invoke-timeout <ms>", "Invoke timeout", "90000")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean; url: string; bytes: number }>("POST", "/api/nodes/camera/clip", {
          nodeId: opts.node,
          facing: opts.facing,
          deviceId: opts.deviceId,
          durationSec: parseFloat(String(opts.duration ?? "5")),
          audio: opts.audio !== false,
          timeoutMs: parseInt(String(opts.invokeTimeout), 10),
        });
        if (opts.json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) {
          printSuccess(`Clip captured: ${r.data?.url ?? "(no URL)"} (${r.data?.bytes ?? 0} bytes)`);
        } else printWarn("Clip may not have been captured.");
      } catch (err) {
        printError("Camera clip failed", err instanceof Error ? err.message : String(err));
      }
    });

  // screen — 父命令
  const screen = nodes
    .command("screen")
    .description("Capture screen recordings from a paired node");

  screen
    .command("record")
    .description("Capture a short screen recording from a node")
    .requiredOption("--node <id>", "Node ID")
    .option("--screen <n>", "Screen index", "0")
    .option("--duration <sec>", "Duration in seconds", "5")
    .option("--fps <n>", "Frames per second", "30")
    .option("--no-audio", "Disable audio")
    .option("--out <path>", "Output file path (default: auto-generated)")
    .option("--invoke-timeout <ms>", "Invoke timeout", "180000")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean; url: string; bytes: number }>("POST", "/api/nodes/screen/record", {
          nodeId: opts.node,
          screen: parseInt(String(opts.screen ?? "0"), 10),
          durationSec: parseFloat(String(opts.duration ?? "5")),
          fps: parseInt(String(opts.fps ?? "30"), 10),
          audio: opts.audio !== false,
          outPath: opts.out,
          timeoutMs: parseInt(String(opts.invokeTimeout), 10),
        });
        if (opts.json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) {
          printSuccess(`Recording saved: ${r.data?.url ?? "(no URL)"} (${r.data?.bytes ?? 0} bytes)`);
        } else printWarn("Recording may not have been captured.");
      } catch (err) {
        printError("Screen record failed", err instanceof Error ? err.message : String(err));
      }
    });

  // location — 父命令
  const location = nodes
    .command("location")
    .description("Fetch location from a paired node");

  location
    .command("get")
    .description("Fetch the current location from a node")
    .requiredOption("--node <id>", "Node ID")
    .option("--max-age <sec>", "Max age of cached location in seconds")
    .option("--accuracy <m>", "Desired accuracy in meters")
    .option("--location-timeout <ms>", "Location fetch timeout", "10000")
    .option("--invoke-timeout <ms>", "Invoke timeout", "30000")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean; latitude?: number; longitude?: number; accuracy?: number; timestamp?: string; cached?: boolean }>("POST", "/api/nodes/location/get", {
          nodeId: opts.node,
          maxAgeSec: opts.maxAge ? parseFloat(String(opts.maxAge)) : undefined,
          accuracyM: opts.accuracy ? parseFloat(String(opts.accuracy)) : undefined,
          locationTimeoutMs: parseInt(String(opts.locationTimeout), 10),
          timeoutMs: parseInt(String(opts.invokeTimeout), 10),
        });
        if (opts.json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) {
          printSuccess(`Location: ${r.data?.latitude ?? "?"}, ${r.data?.longitude ?? "?"} (±${r.data?.accuracy ?? "?"}m)`);
          if (r.data?.timestamp) console.log(c("gray", `  Timestamp: ${formatTimestamp(r.data.timestamp)}`));
          if (r.data?.cached) console.log(c("gray", "  (cached)"));
        } else printWarn("Location may not have been fetched.");
      } catch (err) {
        printError("Location fetch failed", err instanceof Error ? err.message : String(err));
      }
    });

  // Mask token output if shown in any subcommand
  if (process.env.EvoClaw_TOKEN) {
    // Just a no-op so maskSecret is "used"
    maskSecret(process.env.EvoClaw_TOKEN);
  }
}
