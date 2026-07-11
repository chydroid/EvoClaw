import { Command } from "commander";
import { c, ICONS, divider } from "../utils/colors";
import { apiRequest, checkServer } from "../utils/api";

interface AuditEntry {
  timestamp: string;
  type: string;
  action: string;
  details: string;
  source: string;
}

interface AuditResponse {
  stats?: any;
  alerts?: any[];
}

function formatLevel(type: string): string {
  const t = (type || "").toLowerCase();
  if (t.includes("error") || t.includes("err")) return c("red", type);
  if (t.includes("warn")) return c("yellow", type);
  return c("green", type);
}

function filterEntries(entries: AuditEntry[], level?: string, source?: string): AuditEntry[] {
  let filtered = entries;
  if (level) {
    const lv = level.toLowerCase();
    filtered = filtered.filter((e) => (e.type || "").toLowerCase().includes(lv));
  }
  if (source) {
    filtered = filtered.filter((e) => (e.source || "").toLowerCase() === source.toLowerCase());
  }
  return filtered;
}

async function fetchAndDisplay(opts: Record<string, unknown>): Promise<void> {
  const isJson = !!opts.json;
  const level = opts.level as string | undefined;
  const source = opts.source as string | undefined;
  const limit = parseInt(String(opts.limit ?? 20), 10);

  const serverAlive = await checkServer();
  if (!serverAlive) {
    if (isJson) console.log(JSON.stringify({ error: "server_offline" }));
    else console.log(c("red", "❌ Gateway not reachable. Start with: EvoClaw gateway start"));
    return;
  }

  try {
    const r = await apiRequest<AuditResponse>("GET", "/api/system/audit");
    let entries = r.data?.alerts || [];
    entries = filterEntries(entries, level, source);
    entries = entries.slice(-limit);

    if (isJson) {
      console.log(JSON.stringify({ entries }, null, 2));
      return;
    }

    console.log();
    console.log(c("bold", "=== EvoClaw Logs ===\n"));

    if (entries.length === 0) {
      console.log(c("gray", "  No log entries found."));
      if (r.data?.stats) {
        console.log(c("gray", `  Stats available: ${JSON.stringify(r.data.stats)}`));
      }
      console.log();
      return;
    }

    for (const entry of entries) {
      const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "—";
      const lvl = formatLevel(entry.type || "info");
      const src = entry.source ? c("cyan", entry.source) : "";
      const act = entry.action || "";
      const det = entry.details ? c("gray", entry.details) : "";
      console.log(`  ${c("gray", ts)}  ${lvl}  ${src}  ${act}  ${det}`);
    }

    console.log();
    console.log(c("gray", `  Showing ${entries.length} entries. Use --limit to adjust.`));
    console.log();
  } catch (err) {
    if (isJson) console.log(JSON.stringify({ error: String(err) }));
    else console.log(c("red", `❌ Failed to fetch logs: ${err instanceof Error ? err.message : String(err)}`));
  }
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("logs")
    .description("View Gateway logs")
    .option("-f, --follow", "Follow log output (polling)")
    .option("--level <level>", "Filter by level (info/warn/error)")
    .option("--source <source>", "Filter by source")
    .option("--limit <n>", "Limit number of entries", "20")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (opts.follow) {
        console.log(c("green", "Following logs (Ctrl+C to stop)..."));
        let lastTs: string | undefined;
        const poll = async () => {
          try {
            const r = await apiRequest<AuditResponse>("GET", "/api/system/audit");
            let entries = r.data?.alerts || [];
            entries = filterEntries(entries, opts.level as string | undefined, opts.source as string | undefined);
            const cutoff = lastTs;
            if (cutoff != null) {
              entries = entries.filter((e) => e.timestamp > cutoff);
            }
            for (const entry of entries) {
              const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "—";
              const lvl = formatLevel(entry.type || "info");
              const src = entry.source ? c("cyan", entry.source) : "";
              const act = entry.action || "";
              const det = entry.details ? c("gray", entry.details) : "";
              console.log(`  ${c("gray", ts)}  ${lvl}  ${src}  ${act}  ${det}`);
            }
            if (entries.length > 0) {
              lastTs = entries[entries.length - 1].timestamp;
            }
          } catch {
            console.log(c("yellow", "⚠ Poll failed, retrying..."));
          }
        };
        await poll();
        const interval = setInterval(poll, 3000);
        interval.unref?.();
        // stdin 保持进程存活，允许 timer.unref() 后仍持续轮询（与 sessions tail 一致）
        process.stdin.resume();
        process.on("SIGINT", () => {
          clearInterval(interval);
          process.stdin.pause();
          console.log(c("gray", "\nStopped following logs."));
          process.exit(0);
        });
        return;
      }
      await fetchAndDisplay(opts);
    });
}
