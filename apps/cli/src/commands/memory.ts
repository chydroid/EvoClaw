import { Command } from "commander";
import { c, ICONS } from "../utils/colors";
import { apiRequest, checkServer } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const mem = program
    .command("memory")
    .description("Manage vector memory and semantic search");

  mem
    .command("status")
    .description("Show memory / learning status")
    .option("--deep", "Deep inspection")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("GET", "/api/evolution/learning/stats");
        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
          return;
        }
        const data = r.data;
        const status = data.status || data.state || "unknown";
        const isOk = status === "active" || status === "ready" || status === "ok" || status === "healthy";
        console.log(`  Memory: ${isOk ? c("green", String(status)) : c("yellow", String(status))}`);
        if (data.vectorStore || data.vector_store) {
          const vs = data.vectorStore || data.vector_store;
          const vsOk = vs === "ready" || vs === "active" || vs === "ok" || vs === true;
          console.log(`  Vector store: ${vsOk ? c("green", String(vs)) : c("yellow", String(vs))}`);
        }
        if (data.totalEntries !== undefined || data.total_entries !== undefined) {
          console.log(`  Total entries: ${data.totalEntries ?? data.total_entries}`);
        }
        if (data.totalSessions !== undefined || data.total_sessions !== undefined) {
          console.log(`  Total sessions: ${data.totalSessions ?? data.total_sessions}`);
        }
        if (opts.deep) {
          if (data.semanticSearch || data.semantic_search) {
            const ss = data.semanticSearch || data.semantic_search;
            const ssOk = ss === "ready" || ss === "active" || ss === true;
            console.log(`  Semantic search: ${ssOk ? c("green", String(ss)) : c("yellow", String(ss))}`);
          }
          if (data.lastUpdated || data.last_updated) {
            console.log(`  Last updated: ${data.lastUpdated || data.last_updated}`);
          }
        }
      } catch (err) {
        console.log(c("yellow", `${ICONS.warn()} Could not fetch memory status: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  mem
    .command("index")
    .description("Show memory index entries")
    .option("--json", "Output as JSON")
    .option("--limit <n>", "Maximum entries to display", "50")
    .action(async (opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const limit = typeof opts.limit === "string" ? parseInt(opts.limit, 10) : 50;
        const r = await apiRequest<Record<string, unknown>>("GET", `/api/evolution/learning/entries?limit=${limit}`);
        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
          return;
        }
        const entries = (r.data.entries || r.data.items || (Array.isArray(r.data) ? r.data : [])) as Array<Record<string, unknown>>;
        const total = (r.data.total ?? r.data.count ?? entries.length) as number;
        console.log(`\n${c("bold", "Memory Index")}`);
        console.log(`  ${c("gray", `${total} entries indexed`)}\n`);
        if (entries.length === 0) {
          console.log(`  ${c("gray", "No entries found")}`);
        } else {
          for (let i = 0; i < Math.min(entries.length, isNaN(limit) ? 50 : limit); i++) {
            const e = entries[i];
            const id = e.id || e.key || i;
            const text = String(e.text || e.content || e.summary || e.name || "").slice(0, 100);
            const ts = e.createdAt || e.created_at || e.timestamp || "";
            console.log(`  ${ICONS.bullet()} ${c("cyan", String(id))} ${c("gray", text)}${ts ? ` ${c("gray", String(ts))}` : ""}`);
          }
        }
        console.log();
      } catch (err) {
        console.log(c("yellow", `${ICONS.warn()} Could not fetch memory index: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  mem
    .command("search <query>")
    .description("Semantic search across memory")
    .option("--max <n>", "Maximum results", "10")
    .option("--json", "Output as JSON")
    .action(async (query: string, opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Memory search requires active server.`));
        return;
      }
      try {
        const limit = typeof opts.max === "string" ? parseInt(opts.max, 10) : 10;
        const r = await apiRequest<Record<string, unknown>>("GET", `/api/evolution/learning/entries?search=${encodeURIComponent(query)}&limit=${isNaN(limit) ? 10 : limit}`);
        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
          return;
        }
        const results = (r.data.entries || r.data.items || r.data.results || (Array.isArray(r.data) ? r.data : [])) as Array<Record<string, unknown>>;
        console.log(`\nSearch results for "${query}":\n`);
        if (results.length === 0) {
          console.log(`  ${c("gray", "No results found")}`);
        } else {
          for (let i = 0; i < results.length; i++) {
            const text = String(results[i].text || results[i].content || results[i].summary || "").slice(0, 120);
            const score = results[i].score || results[i].relevance;
            const scoreStr = score ? ` ${c("gray", `(${Number(score).toFixed(2)})`)}` : "";
            console.log(`  ${i + 1}. ${text}${scoreStr}`);
          }
        }
        console.log();
      } catch (err) {
        console.log(c("yellow", `${ICONS.warn()} Memory search unavailable: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  mem
    .command("sessions")
    .description("Show learning sessions")
    .option("--json", "Output as JSON")
    .option("--limit <n>", "Maximum sessions to display", "20")
    .action(async (opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const limit = typeof opts.limit === "string" ? parseInt(opts.limit, 10) : 20;
        const r = await apiRequest<Record<string, unknown>>("GET", `/api/evolution/learning/sessions?limit=${limit}`);
        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
          return;
        }
        const sessions = (r.data.sessions || r.data.items || (Array.isArray(r.data) ? r.data : [])) as Array<Record<string, unknown>>;
        console.log(`\n${c("bold", "Learning Sessions")}\n`);
        if (sessions.length === 0) {
          console.log(`  ${c("gray", "No learning sessions found")}`);
        } else {
          for (const s of sessions) {
            const id = s.id || s.sessionId || "unknown";
            const status = s.status || s.state || "";
            const statusStr = status === "completed" || status === "done"
              ? c("green", String(status))
              : status === "active" || status === "running"
                ? c("cyan", String(status))
                : status ? c("yellow", String(status)) : "";
            const entries = s.entryCount || s.entries;
            const ts = s.createdAt || s.created_at || s.startedAt || "";
            console.log(`  ${ICONS.bullet()} ${c("cyan", String(id))}${statusStr ? ` [${statusStr}]` : ""}${entries ? ` ${c("gray", `${entries} entries`)}` : ""}${ts ? ` ${c("gray", String(ts))}` : ""}`);
          }
        }
        console.log();
      } catch (err) {
        console.log(c("yellow", `${ICONS.warn()} Could not fetch sessions: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  mem
    .command("stats")
    .description("Show evolution statistics")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", `${ICONS.warn()} Server not running. Start with: EvoClaw gateway start`));
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("GET", "/api/evolution/stats");
        if (opts.json) {
          console.log(JSON.stringify(r.data, null, 2));
          return;
        }
        const data = r.data;
        console.log(`\n${c("bold", "=== Evolution Statistics ===\n")}`);
        const fields = [
          ["Generation", data.generation || data.gen],
          ["Total learnings", data.totalLearnings || data.total_learnings],
          ["Total sessions", data.totalSessions || data.total_sessions],
          ["Skills evolved", data.skillsEvolved || data.skills_evolved],
          ["Last evolution", data.lastEvolution || data.last_evolution],
          ["Uptime", data.uptime],
        ];
        for (const [label, value] of fields) {
          if (value !== undefined && value !== null) {
            console.log(`  ${label}: ${c("cyan", String(value))}`);
          }
        }
        if (data.phases && Array.isArray(data.phases)) {
          console.log(`\n  Phases:`);
          for (const phase of data.phases) {
            const p = phase as Record<string, unknown>;
            console.log(`    ${ICONS.bullet()} ${p.name || p.phase} ${c("gray", `→ ${p.status || "unknown"}`)}`);
          }
        }
        console.log();
      } catch (err) {
        console.log(c("yellow", `${ICONS.warn()} Could not fetch evolution stats: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
}
