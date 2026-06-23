/** skills — Manage skills via server API */
import { Command } from "commander";
import { c, ICONS, section } from "../utils/colors";
import { apiRequest, checkServer, serverRequired } from "../utils/api";

interface Skill {
  id: string;
  name: string;
  version: string;
  description: string;
  category: string;
  lifecycle?: { status: string };
  stats?: { invocationCount: number; successCount: number; failureCount: number };
}

interface MarketplaceResult {
  slug?: string;
  name?: string;
  description?: string;
  category?: string;
  version?: string;
  downloads?: number;
  rating?: number;
}

export function register(program: Command, _shared: (cmd: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const skills = program
    .command("skills")
    .description("Search, install, and manage skills");

  // skills list — list installed skills from server
  skills
    .command("list")
    .description("List installed skills")
    .option("--category <cat>", "Filter by category")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const r = await apiRequest<Skill[]>("GET", "/api/skills");
        let list = r.data || [];
        if (opts.category) {
          list = list.filter(s => s.category === opts.category);
        }
        if (opts.json) { console.log(JSON.stringify(list, null, 2)); return; }
        console.log(section("Installed Skills"));
        if (list.length === 0) {
          console.log(c("gray", "  No skills installed. Try: EvoClaw skills search <query>"));
          return;
        }
        for (const s of list) {
          const status = s.lifecycle?.status || "unknown";
          const statusIcon = status === "active" ? ICONS.ok() : status === "failed" ? ICONS.error() : ICONS.bullet();
          const invocations = s.stats?.invocationCount || 0;
          console.log(`  ${statusIcon} ${c("cyan", s.name)} ${c("gray", `v${s.version}`)}  [${status}]  invocations: ${invocations}`);
          if (s.description) console.log(c("gray", `       ${s.description.slice(0, 80)}`));
        }
        console.log(c("gray", `\n  Total: ${list.length} skill(s)`));
        console.log();
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed to list skills: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // skills search — search marketplace via server API
  skills
    .command("search [query]")
    .description("Search the skill marketplace")
    .option("--limit <n>", "Maximum results", "20")
    .option("--json", "Output as JSON")
    .action(async (query: string | undefined, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const q = query || "";
        const limit = parseInt(String(opts.limit || 20), 10);
        const r = await apiRequest<MarketplaceResult[]>("GET", `/api/marketplace/search?q=${encodeURIComponent(q)}&limit=${limit}`);
        const results = r.data || [];
        if (opts.json) { console.log(JSON.stringify(results, null, 2)); return; }
        console.log(section(`Search: "${q}"`));
        if (results.length === 0) {
          console.log(c("gray", "  No results found."));
          return;
        }
        for (const s of results) {
          console.log(`  ${ICONS.bullet()} ${c("cyan", s.slug || s.name || "unknown")} ${s.version ? c("gray", `v${s.version}`) : ""}`);
          if (s.description) console.log(c("gray", `       ${s.description.slice(0, 80)}`));
          if (s.category) console.log(c("gray", `       category: ${s.category}`));
        }
        console.log(c("gray", `\n  ${results.length} result(s). Install with: EvoClaw skills install <slug>`));
        console.log();
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Search failed: ${err instanceof Error ? err.message : String(err)}`));
        console.log(c("gray", "  Make sure the server is running and marketplace is configured."));
      }
    });

  // skills install — install from marketplace via server API
  skills
    .command("install <slug>")
    .description("Install a skill from the marketplace")
    .option("--force", "Reinstall if already exists")
    .option("--json", "Output as JSON")
    .action(async (slug: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const body: Record<string, unknown> = { slug };
        if (opts.force) body.force = true;
        const r = await apiRequest<Skill>("POST", "/api/skills/install", body);
        if (opts.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
        console.log(c("green", `${ICONS.ok()} Skill "${c("cyan", slug)}" installed successfully`));
        if (r.data?.version) console.log(c("gray", `  Version: ${r.data.version}`));
        if (r.data?.description) console.log(c("gray", `  ${r.data.description.slice(0, 80)}`));
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Install failed: ${err instanceof Error ? err.message : String(err)}`));
        console.log(c("gray", `  Try: EvoClaw skills search ${slug}`));
      }
    });

  // skills uninstall — delete a skill via server API
  skills
    .command("uninstall <id>")
    .description("Uninstall a skill")
    .action(async (id: string) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        await apiRequest("DELETE", `/api/skills/${encodeURIComponent(id)}`);
        console.log(c("green", `${ICONS.ok()} Skill "${c("cyan", id)}" uninstalled`));
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Uninstall failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // skills info — show skill details from server
  skills
    .command("info <id>")
    .description("Show skill details")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const r = await apiRequest<Skill>("GET", `/api/skills/${encodeURIComponent(id)}`);
        if (opts.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
        const s = r.data;
        console.log(section(`Skill: ${s.name || id}`));
        console.log(`  ${ICONS.arrow()} ID:          ${s.id || id}`);
        console.log(`  ${ICONS.arrow()} Version:     ${s.version || "—"}`);
        console.log(`  ${ICONS.arrow()} Category:    ${s.category || "—"}`);
        console.log(`  ${ICONS.arrow()} Status:      ${s.lifecycle?.status || "—"}`);
        if (s.description) console.log(`  ${ICONS.arrow()} Description: ${s.description}`);
        if (s.stats) {
          console.log(`  ${ICONS.arrow()} Invocations: ${s.stats.invocationCount || 0}`);
          console.log(`  ${ICONS.arrow()} Success:     ${s.stats.successCount || 0}`);
          console.log(`  ${ICONS.arrow()} Failures:    ${s.stats.failureCount || 0}`);
        }
        console.log();
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Skill not found: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // skills upgrade — upgrade a skill
  skills
    .command("upgrade <id>")
    .description("Upgrade a skill to the latest version")
    .action(async (id: string) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        await apiRequest("POST", `/api/skills/${encodeURIComponent(id)}/upgrade`);
        console.log(c("green", `${ICONS.ok()} Skill "${c("cyan", id)}" upgraded`));
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Upgrade failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // skills upgrade-all — upgrade all skills
  skills
    .command("upgrade-all")
    .description("Upgrade all skills to their latest versions")
    .action(async () => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const r = await apiRequest<{ upgraded: number; failed: number }>("POST", "/api/skills/batch-upgrade");
        console.log(c("green", `${ICONS.ok()} Upgraded: ${r.data?.upgraded || 0}  Failed: ${r.data?.failed || 0}`));
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Batch upgrade failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // skills check-updates — check for available updates
  skills
    .command("check-updates")
    .description("Check for available skill updates")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const r = await apiRequest<unknown[]>("GET", "/api/skills/check-updates");
        if (opts.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
        const updates = r.data || [];
        console.log(section("Available Updates"));
        if (Array.isArray(updates) && updates.length > 0) {
          for (const u of updates) {
            const s = u as Record<string, unknown>;
            console.log(`  ${ICONS.warn()} ${c("cyan", String(s.id || s.name || "unknown"))}  ${c("gray", `v${s.currentVersion || "?"} → v${s.latestVersion || "?"}`)}`);
          }
          console.log(c("gray", `\n  ${updates.length} update(s) available. Run: EvoClaw skills upgrade-all`));
        } else {
          console.log(c("green", `  ${ICONS.ok()} All skills are up to date`));
        }
        console.log();
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Check failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // skills health — health check a skill
  skills
    .command("health <id>")
    .description("Run a health check on a skill")
    .action(async (id: string) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const r = await apiRequest<Record<string, unknown>>("POST", `/api/skills/${encodeURIComponent(id)}/health-check`);
        const healthy = r.data?.healthy;
        if (healthy) {
          console.log(c("green", `${ICONS.ok()} Skill "${c("cyan", id)}" is healthy`));
        } else {
          console.log(c("yellow", `${ICONS.warn()} Skill "${c("cyan", id)}" has issues: ${r.data?.error || "unknown"}`));
        }
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Health check failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // skills trending — show trending skills from marketplace
  skills
    .command("trending")
    .description("Show trending skills from the marketplace")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const alive = await checkServer();
      if (!alive) { serverRequired(); return; }
      try {
        const r = await apiRequest<MarketplaceResult[]>("GET", "/api/marketplace/trending");
        if (opts.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
        const results = r.data || [];
        console.log(section("Trending Skills"));
        if (results.length === 0) {
          console.log(c("gray", "  No trending skills available."));
          return;
        }
        for (const s of results) {
          console.log(`  ${ICONS.star()} ${c("cyan", s.slug || s.name || "unknown")} ${s.version ? c("gray", `v${s.version}`) : ""}`);
          if (s.description) console.log(c("gray", `       ${s.description.slice(0, 80)}`));
        }
        console.log();
      } catch (err) {
        console.log(c("red", `${ICONS.error()} Failed to fetch trending: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
}
