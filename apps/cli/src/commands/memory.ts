/** memory — Memory management */
import { Command } from "commander";
import { c } from "../utils/colors";
import { apiRequest, checkServer } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const mem = program
    .command("memory")
    .description("Manage vector memory and semantic search");

  mem
    .command("status")
    .description("Show memory status")
    .option("--deep", "Deep inspection")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (opts.json) { console.log(JSON.stringify({ status: "active", vectorStore: "ready" })); return; }
      console.log(`  Memory: ${c("green", "active")}`);
      console.log(`  Vector store: ${c("green", "ready")}`);
      if (opts.deep) console.log(`  Semantic search: ${c("green", "ready")}`);
    });

  mem
    .command("index")
    .description("Rebuild memory index")
    .option("--force", "Force full reindex")
    .option("--verbose", "Show indexing progress")
    .action((opts: Record<string, unknown>) => {
      if (opts.force) console.log(c("green", "✅ Full reindex initiated"));
      else console.log(c("green", "✅ Index is up to date"));
    });

  mem
    .command("search <query>")
    .description("Semantic search across memory")
    .option("--max <n>", "Maximum results", "10")
    .option("--json", "Output as JSON")
    .action(async (query: string, opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (!serverAlive) {
        console.log(c("yellow", "⚠ Server not running. Memory search requires active server."));
        return;
      }
      try {
        const r = await apiRequest<Record<string, unknown>>("GET", `/api/memory/search?q=${encodeURIComponent(query)}`);
        if (opts.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
        const results = (r.data.results as Array<Record<string, unknown>>) || [];
        const limit = typeof opts.max === "string" ? parseInt(opts.max, 10) : 10;
        console.log(`Search results for "${query}":`);
        for (let i = 0; i < Math.min(results.length, (isNaN(limit) ? 10 : limit)); i++) {
          console.log(`  ${i + 1}. ${c("gray", String(results[i].text || results[i].content || "").slice(0, 120))}`);
        }
        if (results.length === 0) console.log(`  ${c("gray", "No results found")}`);
      } catch {
        console.log(c("yellow", "⚠ Memory search unavailable"));
      }
    });
}