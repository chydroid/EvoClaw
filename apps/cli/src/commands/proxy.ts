/**
 * proxy — 运行调试代理并检查抓包流量
 *
 * 对齐 openclaw-main 的 src/cli/proxy-cli.ts
 * 子命令：start / run / validate / coverage / sessions / query / blob / purge
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
  formatTimestamp,
} from "../utils/shared";

interface CaptureSession {
  id: string;
  startedAt: string;
  endedAt?: string;
  requestCount: number;
  byteCount: number;
  cmd?: string;
}

interface CoverageReport {
  totalTransports: number;
  coveredTransports: number;
  uncoveredTransports: string[];
  coveragePercent: number;
}

export function register(program: Command): void {
  const proxy = program
    .command("proxy")
    .description("Run the EvoClaw debug proxy and inspect captured traffic");

  proxy
    .command("start")
    .description("Start the local explicit debug proxy")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", "8888")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean; url: string; pid: number }>("POST", "/api/proxy/start", {
          host: opts.host,
          port: parseInt(String(opts.port ?? "8888"), 10),
        });
        if (r.data?.ok || r.status === 200) {
          printSuccess(`Debug proxy started at ${r.data?.url ?? "(unknown)"}`);
          console.log(c("gray", `  PID: ${r.data?.pid ?? "—"}`));
          console.log(c("gray", `  Configure HTTP_PROXY=http://${opts.host}:${opts.port} to capture traffic`));
        } else printWarn("Proxy may not have started.");
      } catch (err) {
        printError("Failed to start proxy", err instanceof Error ? err.message : String(err));
      }
    });

  proxy
    .command("run [cmd...]")
    .description("Run a child command with EvoClaw debug proxy capture enabled")
    .option("--host <host>", "Proxy host", "127.0.0.1")
    .option("--port <port>", "Proxy port", "8888")
    .action(async (cmd: string[] | undefined, opts: Record<string, unknown>) => {
      if (!cmd || cmd.length === 0) {
        printError("No command specified", "Usage: EvoClaw proxy run -- <cmd> [args...]");
        process.exitCode = 1;
        return;
      }
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean; sessionId: string; exitCode: number }>("POST", "/api/proxy/run", {
          cmd,
          host: opts.host,
          port: parseInt(String(opts.port ?? "8888"), 10),
        });
        if (r.data?.ok || r.status === 200) {
          printSuccess(`Command completed (session ${r.data?.sessionId ?? "—"}, exit code ${r.data?.exitCode ?? 0})`);
        } else {
          printWarn("Command may not have completed successfully.");
          process.exitCode = r.data?.exitCode ?? 1;
        }
      } catch (err) {
        printError("Proxy run failed", err instanceof Error ? err.message : String(err));
      }
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
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean; passed: boolean; checks: Array<{ name: string; status: "pass" | "fail"; detail?: string }> }>("POST", "/api/proxy/validate", {
          proxyUrl: opts.proxyUrl,
          proxyCaFile: opts.proxyCaFile,
          allowedUrls: opts.allowedUrl ?? [],
          deniedUrls: opts.deniedUrl ?? [],
          apnsReachable: !!opts.apnsReachable,
          apnsAuthority: opts.apnsAuthority,
          timeoutMs: parseInt(String(opts.timeoutMs), 10),
        });
        if (opts.json) {
          printJson(r.data);
          return;
        }
        const data = r.data;
        console.log();
        console.log(c("bold", `${ICONS.rock}  Proxy Validation`));
        console.log(divider());
        console.log(`  Overall: ${data.passed ? c("green", "PASS") : c("red", "FAIL")}`);
        console.log();
        for (const chk of data.checks) {
          const sym = chk.status === "pass" ? c("green", "✓") : c("red", "✗");
          console.log(`  ${sym} ${chk.name}`);
          if (chk.detail) console.log(c("gray", `      ${chk.detail}`));
        }
        console.log();
      } catch (err) {
        printError("Proxy validation failed", err instanceof Error ? err.message : String(err));
      }
    });

  proxy
    .command("coverage")
    .description("Report current debug proxy transport coverage and remaining gaps")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<CoverageReport>("GET", "/api/proxy/coverage");
        if (opts.json) {
          printJson(r.data);
          return;
        }
        const d = r.data;
        console.log();
        console.log(c("bold", `${ICONS.rock}  Debug Proxy Coverage`));
        console.log(divider());
        console.log(`  Transports covered:   ${d.coveredTransports}/${d.totalTransports} (${d.coveragePercent.toFixed(1)}%)`);
        if (d.uncoveredTransports.length > 0) {
          console.log(c("yellow", "  Uncovered:"));
          for (const t of d.uncoveredTransports) console.log(c("yellow", `    ⚠  ${t}`));
        }
        console.log();
      } catch (err) {
        printError("Failed to fetch coverage", err instanceof Error ? err.message : String(err));
      }
    });

  proxy
    .command("sessions")
    .description("List recent capture sessions")
    .option("--limit <n>", "Limit number of sessions", "20")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ sessions: CaptureSession[] }>("GET", "/api/proxy/sessions");
        if (opts.json) {
          printJson(r.data);
          return;
        }
        const list = (r.data?.sessions ?? []).slice(0, parseInt(String(opts.limit ?? "20"), 10));
        console.log();
        console.log(c("bold", `${ICONS.rock}  Capture Sessions (${list.length})`));
        console.log(divider());
        if (list.length === 0) console.log(c("gray", "  No sessions."));
        else {
          printTable(
            [
              { header: "Session ID", width: 18 },
              { header: "Started At", width: 22 },
              { header: "Ended At", width: 22 },
              { header: "Reqs", align: "right", width: 8 },
              { header: "Bytes", align: "right", width: 12 },
              { header: "Cmd" },
            ],
            list.map((s) => [
              c("cyan", s.id),
              formatTimestamp(s.startedAt),
              formatTimestamp(s.endedAt),
              String(s.requestCount),
              String(s.byteCount),
              s.cmd ?? "—",
            ]),
          );
        }
        console.log();
      } catch (err) {
        printError("Failed to list sessions", err instanceof Error ? err.message : String(err));
      }
    });

  proxy
    .command("query")
    .description("Run a built-in query preset against captured traffic")
    .requiredOption("--preset <name>", "Preset name (e.g. 'errors', 'slow', 'openai', 'anthropic')")
    .option("--session <id>", "Limit to specific session")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean; results: Array<Record<string, unknown>> }>("POST", "/api/proxy/query", {
          preset: opts.preset,
          sessionId: opts.session,
        });
        if (opts.json) {
          printJson(r.data);
          return;
        }
        const results = r.data?.results ?? [];
        console.log();
        console.log(c("bold", `${ICONS.rock}  Query: ${opts.preset} (${results.length} matches)`));
        console.log(divider());
        for (const res of results) {
          console.log(JSON.stringify(res, null, 2));
        }
        console.log();
      } catch (err) {
        printError("Query failed", err instanceof Error ? err.message : String(err));
      }
    });

  proxy
    .command("blob")
    .description("Read a captured payload blob by id")
    .requiredOption("--id <blobId>", "Blob ID")
    .option("--json", "Output as JSON (otherwise raw)")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean; blob?: string; contentType?: string; bytes?: number }>("GET", `/api/proxy/blob/${opts.id}`);
        if (opts.json) {
          printJson(r.data);
          return;
        }
        if (r.data?.blob) process.stdout.write(r.data.blob);
        else printWarn("Blob not found.");
      } catch (err) {
        printError("Blob fetch failed", err instanceof Error ? err.message : String(err));
      }
    });

  proxy
    .command("purge")
    .description("Delete all captured traffic metadata and blobs")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ ok: boolean; deleted: number }>("POST", "/api/proxy/purge");
        if (opts.json) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) printSuccess(`Purged ${r.data?.deleted ?? 0} entries`);
        else printWarn("Purge may not have completed.");
      } catch (err) {
        printError("Purge failed", err instanceof Error ? err.message : String(err));
      }
    });
}
