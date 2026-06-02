import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as child_process from "child_process";
import { c, ICONS, section } from "../utils/colors";
import { checkServer, apiRequest } from "../utils/api";

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

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(rootDir: string): { pid: number; port: number } | null {
  try {
    const pidFile = path.join(rootDir, "data", "evoclaw-gateway.pid");
    if (fs.existsSync(pidFile)) {
      const raw = fs.readFileSync(pidFile, "utf-8").trim();
      if (raw.startsWith("{")) {
        const data = JSON.parse(raw);
        return { pid: data.pid, port: data.port || 27788 };
      }
      const pid = parseInt(raw, 10);
      return isNaN(pid) ? null : { pid, port: 27788 };
    }
  } catch { /* ignore */ }
  return null;
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("uninstall")
    .description("Remove EvoClaw components")
    .option("--service", "Remove gateway service registration")
    .option("--state", "Remove state data (sessions, memory)")
    .option("--workspace", "Remove workspace and skills")
    .option("--app", "Remove all local data")
    .option("--all", "Remove everything (CLI remains)")
    .option("--yes", "Skip confirmation")
    .option("--dry-run", "Preview without executing")
    .action(async (opts: Record<string, unknown>) => {
      const rootDir = findProjectRoot();
      const dataDir = path.join(rootDir, "data");
      const envPath = path.join(rootDir, ".env");
      const skillsDir = path.join(rootDir, "skills");
      const openclawDir = path.join(os.homedir(), ".openclaw");

      const scopes: string[] = [];
      if (opts.all) scopes.push("service", "state", "workspace", "app");
      else {
        if (opts.service) scopes.push("service");
        if (opts.state) scopes.push("state");
        if (opts.workspace) scopes.push("workspace");
        if (opts.app) scopes.push("app");
      }

      if (scopes.length === 0) {
        console.log(c("yellow", "Usage: EvoClaw uninstall [--service] [--state] [--workspace] [--app] [--all]"));
        console.log(c("gray", "  --service   Stop gateway and remove service registration"));
        console.log(c("gray", "  --state     Remove state data (sessions, memory, ledger)"));
        console.log(c("gray", "  --workspace Remove workspace and skills"));
        console.log(c("gray", "  --app       Remove all local data (.env, data/, skills/)"));
        console.log(c("gray", "  --all       Remove everything (CLI stays)"));
        console.log(c("gray", "  --yes       Skip confirmation"));
        console.log(c("gray", "  --dry-run   Preview without executing"));
        return;
      }

      const itemsForScope: Record<string, string[]> = {
        service: ["Stop gateway process", "Remove PID file"],
        state: [
          path.join(dataDir, "sessions"),
          path.join(dataDir, "memory-host.json"),
          path.join(dataDir, "ledger"),
          path.join(dataDir, "commitments.json"),
          path.join(dataDir, "pairing-store.json"),
        ],
        workspace: [
          path.join(dataDir, "workspace"),
          skillsDir,
        ],
        app: [
          dataDir,
          skillsDir,
          envPath,
          openclawDir,
        ],
      };

      const allItems: string[] = [];
      for (const scope of scopes) {
        const items = itemsForScope[scope] || [];
        allItems.push(...items);
      }

      console.log(section("EvoClaw Uninstall"));
      console.log(c("yellow", `${ICONS.warn()} The following will be removed:`));
      for (const scope of scopes) {
        console.log(c("bold", `  [${scope}]`));
        for (const item of itemsForScope[scope] || []) {
          const exists = item.includes("Stop") || item.includes("Remove") || fs.existsSync(item);
          console.log(`    ${exists ? c("red", "✗") : c("gray", "○")} ${item}`);
        }
      }

      if (opts.dryRun) {
        console.log();
        console.log(c("cyan", "Dry run — no changes made"));
        return;
      }

      if (!opts.yes) {
        console.log();
        console.log(c("yellow", "Add --yes to confirm, or --dry-run to preview"));
        return;
      }

      for (const scope of scopes) {
        if (scope === "service") {
          const serverAlive = await checkServer();
          if (serverAlive) {
            console.log(c("cyan", "  Stopping gateway..."));
            try {
              const pidInfo = readPid(rootDir);
              if (pidInfo && isProcessRunning(pidInfo.pid)) {
                process.kill(pidInfo.pid, "SIGTERM");
                console.log(`  ${ICONS.ok()} Gateway process terminated (PID: ${pidInfo.pid})`);
              }
            } catch (err) {
              console.log(c("yellow", `  ${ICONS.warn()} Could not stop gateway: ${err instanceof Error ? err.message : String(err)}`));
            }
          } else {
            console.log(`  ${ICONS.ok()} Gateway not running`);
          }
          const pidFile = path.join(dataDir, "evoclaw-gateway.pid");
          if (fs.existsSync(pidFile)) {
            try { fs.unlinkSync(pidFile); console.log(`  ${ICONS.ok()} Removed PID file`); } catch { /* ignore */ }
          }
        }

        if (scope === "state") {
          const statePaths = [
            path.join(dataDir, "sessions"),
            path.join(dataDir, "memory-host.json"),
            path.join(dataDir, "ledger"),
            path.join(dataDir, "commitments.json"),
            path.join(dataDir, "pairing-store.json"),
          ];
          for (const p of statePaths) {
            if (fs.existsSync(p)) {
              try {
                fs.rmSync(p, { recursive: true, force: true });
                console.log(`  ${ICONS.ok()} Removed ${path.relative(rootDir, p) || p}`);
              } catch (err) {
                console.log(c("red", `  ${ICONS.error()} Failed: ${path.relative(rootDir, p)}: ${err instanceof Error ? err.message : String(err)}`));
              }
            }
          }
        }

        if (scope === "workspace") {
          const wsPaths = [path.join(dataDir, "workspace"), skillsDir];
          for (const p of wsPaths) {
            if (fs.existsSync(p)) {
              try {
                fs.rmSync(p, { recursive: true, force: true });
                console.log(`  ${ICONS.ok()} Removed ${path.relative(rootDir, p) || p}`);
              } catch (err) {
                console.log(c("red", `  ${ICONS.error()} Failed: ${path.relative(rootDir, p)}: ${err instanceof Error ? err.message : String(err)}`));
              }
            }
          }
        }

        if (scope === "app") {
          const appPaths = [dataDir, skillsDir, envPath, openclawDir];
          for (const p of appPaths) {
            if (fs.existsSync(p)) {
              try {
                if (fs.statSync(p).isDirectory()) {
                  fs.rmSync(p, { recursive: true, force: true });
                } else {
                  fs.unlinkSync(p);
                }
                console.log(`  ${ICONS.ok()} Removed ${path.relative(rootDir, p) || p}`);
              } catch (err) {
                console.log(c("red", `  ${ICONS.error()} Failed: ${path.relative(rootDir, p) || p}: ${err instanceof Error ? err.message : String(err)}`));
              }
            }
          }
        }
      }

      console.log();
      console.log(c("green", `${ICONS.ok()} Uninstall complete: ${scopes.join(", ")}`));
      console.log(c("gray", "  CLI remains installed. Remove with: npm uninstall -g @evoclaw/cli"));
    });
}
