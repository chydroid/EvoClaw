/**
 * proxy — 运行调试代理并检查抓包流量
 *
 * 对齐 openclaw-main 的 src/cli/proxy-cli.ts
 * 子命令：start / run / validate / coverage / sessions / query / blob / purge
 *
 * 注：对应后端端点尚未实现，CLI 暂不可用。
 */
import { Command } from "commander";
import { c } from "../utils/colors";

const NOT_AVAILABLE = "⚠ Proxy management is not yet available via CLI.";

export function register(program: Command): void {
  const proxy = program
    .command("proxy")
    .description("Run the EvoClaw debug proxy and inspect captured traffic");

  proxy
    .command("start")
    .description("Start the local explicit debug proxy")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", "8888")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  proxy
    .command("run [cmd...]")
    .description("Run a child command with EvoClaw debug proxy capture enabled")
    .option("--host <host>", "Proxy host", "127.0.0.1")
    .option("--port <port>", "Proxy port", "8888")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  proxy
    .command("validate")
    .description("Validate the operator-managed network proxy")
    .option("--proxy-url <url>", "Proxy URL")
    .option("--proxy-ca-file <path>", "Proxy CA file path")
    .option("--allowed-url <url>", "URL expected to be reachable (can be repeated)", (v: string, acc: string[]) => [...(acc ?? []), v], [])
    .option("--denied-url <url>", "URL expected to be blocked (can be repeated)", (v: string, acc: string[]) => [...(acc ?? []), v], [])
    .option("--apns-reachable", "Test APNs reachability")
    .option("--apns-authority <host:port>", "Expected APNs authority")
    .option("--timeout-ms <ms>", "Per-request timeout", "10000")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  proxy
    .command("coverage")
    .description("Report current debug proxy transport coverage and remaining gaps")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  proxy
    .command("sessions")
    .description("List recent capture sessions")
    .option("--limit <n>", "Limit number of sessions", "20")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  proxy
    .command("query")
    .description("Run a built-in query preset against captured traffic")
    .requiredOption("--preset <name>", "Preset name (e.g. 'errors', 'slow', 'openai', 'anthropic')")
    .option("--session <id>", "Limit to specific session")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  proxy
    .command("blob")
    .description("Read a captured payload blob by id")
    .requiredOption("--id <blobId>", "Blob ID")
    .option("--json", "Output as JSON (otherwise raw)")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  proxy
    .command("purge")
    .description("Delete all captured traffic metadata and blobs")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });
}
