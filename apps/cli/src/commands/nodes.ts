/**
 * nodes — 管理 gateway 名下 node（配对、状态、调用、媒体）
 *
 * 对齐 openclaw-main 的 src/cli/nodes-cli/register.ts
 * 子命令：status / list / describe / pending / approve / reject / remove / rename / invoke / notify / push
 *        camera list|snap|clip / screen record / location get
 *
 * 注：对应后端端点尚未实现，CLI 暂不可用。
 */
import { Command } from "commander";
import { c } from "../utils/colors";

const NOT_AVAILABLE = "⚠ Gateway nodes management is not yet available via CLI.";

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
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  nodes
    .command("list")
    .description("List pending and paired nodes")
    .option("--connected", "Show only connected nodes")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  nodes
    .command("describe")
    .description("Describe a node (capabilities + supported invoke commands)")
    .requiredOption("--node <id>", "Node ID")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  nodes
    .command("pending")
    .description("List pending pairing requests")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  for (const decision of ["approve", "reject"] as const) {
    nodes
      .command(`${decision} <requestId>`)
      .description(`${decision[0]!.toUpperCase()}${decision.slice(1)} a pending pairing request`)
      .option("--json", "Output as JSON")
      .action(async () => {
        console.log(c("yellow", NOT_AVAILABLE));
      });
  }

  nodes
    .command("remove")
    .description("Remove a paired node entry")
    .requiredOption("--node <id>", "Node ID")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  nodes
    .command("rename")
    .description("Rename a paired node (display name override)")
    .requiredOption("--node <id>", "Node ID")
    .requiredOption("--name <name>", "New display name")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
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
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
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
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
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
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
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
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
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
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
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
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
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
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
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
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });
}
