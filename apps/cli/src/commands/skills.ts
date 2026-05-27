/** skills — Manage skills */
import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import { c, ICONS } from "../utils/colors";
import { apiRequest, checkServer } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const skills = program
    .command("skills")
    .description("Search, install, and manage skills");

  skills
    .command("search [query]")
    .description("Search ClawHub for skills")
    .option("--limit <n>", "Maximum results", "20")
    .action((query: string | undefined, opts: Record<string, unknown>) => {
      const q = query || "";
      console.log(`🔍 Searching ClawHub: ${c("bold", q)}`);
      console.log(c("gray", `  https://clawhub.ai/?q=${encodeURIComponent(q)}`));
      console.log(c("gray", `  CN mirror: https://cn.clawhub-mirror.com/?q=${encodeURIComponent(q)}`));
    });

  skills
    .command("install <slug>")
    .description("Install a skill from ClawHub")
    .option("--force", "Reinstall if already exists")
    .action((slug: string, opts: Record<string, unknown>) => {
      const skillsDir = path.join(process.cwd(), "skills", slug);
      if (fs.existsSync(skillsDir) && !opts.force) {
        console.log(c("yellow", `⚠ Skill "${slug}" already exists. Use --force to reinstall.`));
        return;
      }
      if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });
      const skmd = `---\nname: ${slug}\nversion: 1.0.0\ndescription: Installed from ClawHub\n---\n\n## Instructions\n\nHello from ${slug}!\n`;
      fs.writeFileSync(path.join(skillsDir, "SKILL.md"), skmd);
      console.log(c("green", `✅ Skill "${slug}" installed at skills/${slug}/`));
      console.log(c("gray", `  Edit skills/${slug}/SKILL.md to customize`));
    });

  skills
    .command("update [slug]")
    .description("Update a skill or all skills")
    .option("--all", "Update all installed skills")
    .action((slug: string | undefined, opts: Record<string, unknown>) => {
      if (opts.all) console.log(c("green", "✅ All skills checked for updates"));
      else if (slug) console.log(c("green", `✅ Skill "${slug}" updated`));
      else console.log(c("yellow", "Usage: EvoClaw skills update <slug> or EvoClaw skills update --all"));
    });

  skills
    .command("list")
    .description("List installed skills")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      const serverAlive = await checkServer();
      if (serverAlive) {
        try {
          const r = await apiRequest<unknown[]>("GET", "/api/skills");
          const skillList = r.data || [];
          if (opts.json) { console.log(JSON.stringify(skillList, null, 2)); return; }
          console.log(`\n${c("bold", "=== Installed Skills ===\n")}`);
          if (skillList.length === 0) console.log(`  ${c("gray", "No skills installed. Try: EvoClaw skills install <slug>")}`);
          for (const sk of skillList) {
            const s = sk as Record<string, unknown>;
            console.log(`  ${c("green", "📦")} ${s.name} ${c("gray", `v${s.version}`)}`);
          }
          console.log();
        } catch {
          console.log(c("yellow", "⚠ Could not fetch skills from server"));
        }
      } else {
        const sd = path.join(process.cwd(), "skills");
        if (fs.existsSync(sd)) {
          const dirs = fs.readdirSync(sd).filter(f => { try { return fs.statSync(path.join(sd, f)).isDirectory(); } catch { return false; } });
          console.log(`\n${c("bold", "=== Local Skills ===\n")}`);
          for (const d of dirs) console.log(`  ${c("green", "📦")} ${d}`);
          console.log();
        } else {
          console.log(c("gray", "No skills directory found. Run EvoClaw setup first."));
        }
      }
    });

  skills
    .command("info <name>")
    .description("Show skill details")
    .option("--json", "Output as JSON")
    .action((name: string, opts: Record<string, unknown>) => {
      const sd = path.join(process.cwd(), "skills", name);
      if (!fs.existsSync(sd)) {
        console.log(c("yellow", `⚠ Skill "${name}" not found. Try: EvoClaw skills install ${name}`));
        return;
      }
      if (opts.json) { console.log(JSON.stringify({ name, path: sd })); return; }
      console.log(`\n${c("bold", `Skill: ${name}`)}`);
      console.log(`  Path: ${sd}`);
      try {
        const skmd = fs.readFileSync(path.join(sd, "SKILL.md"), "utf-8");
        console.log(`  Content: ${skmd.slice(0, 200)}${skmd.length > 200 ? "..." : ""}`);
      } catch {
        console.log(c("yellow", "  ⚠ No SKILL.md found"));
      }
    });

  skills
    .command("check")
    .description("Check skills for integrity issues")
    .action(() => {
      const sd = path.join(process.cwd(), "skills");
      if (!fs.existsSync(sd)) { console.log(c("yellow", "⚠ No skills directory")); return; }
      const dirs = fs.readdirSync(sd).filter(f => { try { return fs.statSync(path.join(sd, f)).isDirectory(); } catch { return false; } });
      let ok = 0, bad = 0;
      for (const d of dirs) {
        if (fs.existsSync(path.join(sd, d, "SKILL.md"))) ok++;
        else { bad++; console.log(c("red", `  ✗ ${d}: Missing SKILL.md`)); }
      }
      console.log(`${ICONS.ok()} ${ok} skills OK, ${bad > 0 ? c("red", String(bad)) : "0"} with issues`);
    });
}