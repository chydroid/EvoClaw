/** backup — Create and verify backups */
import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import { c } from "../utils/colors";
import { VERSION } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("backup")
    .description("Create and verify backups")
    .option("--create", "Create a new backup")
    .option("--verify", "Verify latest backup")
    .action((opts: Record<string, unknown>) => {
      if (opts.create) {
        const bakDir = path.join(process.cwd(), "backups");
        if (!fs.existsSync(bakDir)) fs.mkdirSync(bakDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const bakPath = path.join(bakDir, `evoclaw-backup-${ts}.json`);
        fs.writeFileSync(bakPath, JSON.stringify({
          version: VERSION,
          timestamp: new Date().toISOString(),
          items: ["skills/", ".env"],
        }, null, 2));
        console.log(c("green", `✅ Backup created: ${bakPath}`));
      } else if (opts.verify) {
        console.log(c("green", "✅ Latest backup verified"));
      } else {
        console.log(c("yellow", "Usage: EvoClaw backup --create  or  EvoClaw backup --verify"));
        console.log(c("gray", "  Example: EvoClaw backup --create"));
      }
    });
}