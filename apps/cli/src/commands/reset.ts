import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import { c, ICONS, section } from "../utils/colors";
import { apiRequest, checkServer, serverRequired } from "../utils/api";

function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, ".env"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, "..", "..", "..", "..");
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("reset")
    .description("Reset all local data")
    .option("--confirm", "Confirm reset (required)")
    .option("--sessions-only", "Only reset sessions")
    .option("--keep-env", "Keep .env configuration file")
    .action(async (opts: Record<string, unknown>) => {
      const rootDir = findProjectRoot();
      const dataDir = path.join(rootDir, "data");
      const envPath = path.join(rootDir, ".env");
      const skillsDir = path.join(rootDir, "skills");

      const itemsToDelete: string[] = [];
      if (fs.existsSync(dataDir)) itemsToDelete.push(`data/ (sessions, workspace, logs, memory, ledger, scheduler, plugins)`);
      if (fs.existsSync(skillsDir)) itemsToDelete.push("skills/");
      if (fs.existsSync(envPath) && !opts.keepEnv) itemsToDelete.push(".env");

      if (opts.sessionsOnly) {
        itemsToDelete.length = 0;
        const sessionsDir = path.join(dataDir, "sessions");
        if (fs.existsSync(sessionsDir)) itemsToDelete.push("data/sessions/");
      }

      if (!opts.confirm) {
        console.log(c("yellow", `${ICONS.warn()} This will delete the following:`));
        if (itemsToDelete.length === 0) {
          console.log(c("gray", "  Nothing to delete (no data found)"));
        } else {
          for (const item of itemsToDelete) {
            console.log(c("red", `  - ${item}`));
          }
        }
        console.log();
        console.log(c("gray", "  Use --confirm to proceed. This operation cannot be undone."));
        console.log(c("gray", "  Use --sessions-only to only reset sessions."));
        console.log(c("gray", "  Use --keep-env to preserve .env configuration."));
        return;
      }

      console.log(section("EvoClaw Reset"));

      const serverAlive = await checkServer();
      if (serverAlive && !opts.sessionsOnly) {
        try {
          const sessionRes = await apiRequest<Record<string, unknown>>("GET", "/api/sessions");
          const sessions = ((sessionRes.data as Record<string, unknown>)?.sessions || []) as Array<Record<string, unknown>>;
          let deleted = 0;
          for (const s of sessions) {
            try {
              await apiRequest("DELETE", `/api/sessions/${s.agentId || "default"}/${s.sessionId}`);
              deleted++;
            } catch { /* skip */ }
          }
          if (deleted > 0) console.log(`  ${ICONS.ok()} Deleted ${deleted} session(s) via API`);
        } catch {
          console.log(`  ${ICONS.warn()} Could not delete sessions via API`);
        }
      }

      if (serverAlive && opts.sessionsOnly) {
        try {
          const sessionRes = await apiRequest<Record<string, unknown>>("GET", "/api/sessions");
          const sessions = ((sessionRes.data as Record<string, unknown>)?.sessions || []) as Array<Record<string, unknown>>;
          let deleted = 0;
          for (const s of sessions) {
            try {
              await apiRequest("DELETE", `/api/sessions/${s.agentId || "default"}/${s.sessionId}`);
              deleted++;
            } catch { /* skip */ }
          }
          console.log(`  ${ICONS.ok()} Deleted ${deleted} session(s)`);
        } catch {
          console.log(`  ${ICONS.error()} Failed to delete sessions via API`);
        }
        console.log(c("green", `${ICONS.ok()} Sessions reset complete`));
        return;
      }

      function removeDir(dirPath: string, label: string): void {
        if (!fs.existsSync(dirPath)) return;
        try {
          fs.rmSync(dirPath, { recursive: true, force: true });
          console.log(`  ${ICONS.ok()} Removed ${label}`);
        } catch (err) {
          console.log(c("red", `  ${ICONS.error()} Failed to remove ${label}: ${err instanceof Error ? err.message : String(err)}`));
        }
      }

      if (opts.sessionsOnly) {
        removeDir(path.join(dataDir, "sessions"), "data/sessions/");
      } else {
        removeDir(dataDir, "data/");

        if (fs.existsSync(skillsDir)) {
          removeDir(skillsDir, "skills/");
        }

        if (fs.existsSync(envPath) && !opts.keepEnv) {
          try {
            fs.unlinkSync(envPath);
            console.log(`  ${ICONS.ok()} Removed .env`);
          } catch (err) {
            console.log(c("red", `  ${ICONS.error()} Failed to remove .env: ${err instanceof Error ? err.message : String(err)}`));
          }
        }

        const pidFile = path.join(dataDir, "evoclaw-gateway.pid");
        if (fs.existsSync(pidFile)) {
          try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
        }
      }

      console.log();
      console.log(c("green", `${ICONS.ok()} Reset complete`));
      if (!opts.sessionsOnly) {
        console.log(c("gray", "  Run EvoClaw setup to recreate configuration"));
        console.log(c("gray", "  Run EvoClaw gateway start to restart the service"));
      }
    });
}
