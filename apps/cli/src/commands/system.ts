/** system — System events, heartbeat, presence (OpenClaw-compatible) */
import { Command } from "commander";
import { c, ICONS, section } from "../utils/colors";
import { apiRequest } from "../utils/api";
import {
  ensureServer,
  printError,
  printJson,
  printTable,
  formatTimestamp,
  parseDurationMs,
} from "../utils/shared";

interface AuditEntry {
  timestamp?: string | number;
  level?: string;
  category?: string;
  action?: string;
  message?: string;
  [key: string]: unknown;
}

export function register(program: Command, _shared: (cmd: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const sys = program
    .command("system")
    .description("System events, heartbeat, and presence");

  // ── system events / event ─────────────────────────────────────
  // "event" 作为 "events" 的别名（openclaw 同时支持两者）
  sys
    .command("events")
    .description("Show recent system events / audit log")
    .option("--limit <n>", "Max entries to show", "50")
    .option("--level <level>", "Filter by level (info|warn|error)")
    .option("--category <cat>", "Filter by category")
    .option("--since <dur>", "Only show entries since duration (e.g. 1h, 30m)")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<AuditEntry[] | { events?: AuditEntry[]; entries?: AuditEntry[] }>(
          "GET",
          "/api/system/audit",
        );
        let entries: AuditEntry[] = [];
        if (Array.isArray(r.data)) entries = r.data;
        else entries = r.data?.events || r.data?.entries || [];

        // 客户端过滤
        if (opts.level) entries = entries.filter((e) => e.level === opts.level);
        if (opts.category) entries = entries.filter((e) => e.category === opts.category);
        if (opts.since) {
          const ms = parseDurationMs(String(opts.since));
          if (ms !== null) {
            const cutoff = Date.now() - ms;
            entries = entries.filter((e) => {
              const ts = e.timestamp;
              if (!ts) return false;
              const n = typeof ts === "number" ? ts : Date.parse(String(ts));
              return n >= cutoff;
            });
          }
        }
        const limit = parseInt(String(opts.limit || "50"), 10);
        entries = entries.slice(0, isNaN(limit) ? 50 : limit);

        if (opts.json) {
          printJson({ count: entries.length, events: entries });
          return;
        }
        console.log(section("System Events"));
        if (entries.length === 0) {
          console.log(c("gray", "  No events recorded."));
          return;
        }
        const rows: string[][] = entries.map((e) => [
          formatTimestamp(e.timestamp),
          (e.level || "info").padEnd(7).slice(0, 7),
          (e.category || "—").slice(0, 18),
          (e.action || e.message || "—").slice(0, 60),
        ]);
        printTable(
          [
            { header: "Timestamp", width: 22 },
            { header: "Level", width: 7 },
            { header: "Category", width: 18 },
            { header: "Action / Message", width: 60 },
          ],
          rows,
        );
        console.log();
      } catch (err) {
        printError("Failed to fetch events", err instanceof Error ? err.message : String(err));
      }
    });

  // ── system heartbeat (sub-subcommands) ────────────────────────
  // 注：/api/system/heartbeat 端点尚未实现
  const heartbeat = sys
    .command("heartbeat")
    .description("Manage system heartbeat (last | enable | disable | status)");

  heartbeat
    .command("last")
    .description("Show the last heartbeat timestamp")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", "⚠ Heartbeat management is not yet available via CLI."));
    });

  heartbeat
    .command("enable")
    .description("Enable system heartbeat")
    .option("--interval <ms>", "Heartbeat interval in ms", "30000")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", "⚠ Heartbeat management is not yet available via CLI."));
    });

  heartbeat
    .command("disable")
    .description("Disable system heartbeat")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", "⚠ Heartbeat management is not yet available via CLI."));
    });

  heartbeat
    .command("status")
    .description("Show heartbeat status (alias for `last`)")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", "⚠ Heartbeat management is not yet available via CLI."));
    });

  // ── system presence ───────────────────────────────────────────
  // 注：/api/system/presence 端点尚未实现
  sys
    .command("presence")
    .description("Show system presence (active agents / sessions)")
    .option("--json", "Output as JSON")
    .action(async () => {
      console.log(c("yellow", "⚠ System presence is not yet available via CLI."));
    });
}