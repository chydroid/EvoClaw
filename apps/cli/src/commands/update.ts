import { Command } from "commander";
import * as child_process from "child_process";
import * as path from "path";
import * as fs from "fs";
import { c, ICONS, section } from "../utils/colors";
import { VERSION, checkServer, apiRequest, DEFAULT_PORT } from "../utils/api";

function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, "..", "..", "..", "..");
}

function execGit(args: string[], cwd: string): { stdout: string; stderr: string; code: number } {
  try {
    const result = child_process.spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 30000 });
    return { stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim(), code: result.status || 0 };
  } catch (err) {
    return { stdout: "", stderr: err instanceof Error ? err.message : String(err), code: 1 };
  }
}

const CHANNEL_BRANCHES: Record<string, string> = {
  stable: "main",
  beta: "beta",
  dev: "dev",
};

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("update [action]")
    .description("Check for and apply updates")
    .option("--check", "Only check for updates, do not apply")
    .option("--channel <name>", "Update channel (stable, beta, dev)", "stable")
    .option("--force", "Force update even if up to date")
    .option("--yes", "Skip confirmation prompts")
    .action(async (action: string | undefined, opts: Record<string, unknown>) => {
      const channel = String(opts.channel || "stable");
      const rootDir = findProjectRoot();

      if (action === "status") {
        console.log(section("Update Status"));
        console.log(`  ${ICONS.arrow()} Channel:       ${c("cyan", channel)}`);
        console.log(`  ${ICONS.arrow()} Current:       v${VERSION}`);
        const branch = CHANNEL_BRANCHES[channel] || "main";
        const fetchResult = execGit(["fetch", "origin", branch], rootDir);
        if (fetchResult.code !== 0) {
          console.log(`  ${ICONS.warn()} Could not fetch remote: ${fetchResult.stderr}`);
          return;
        }
        const localResult = execGit(["rev-parse", "HEAD"], rootDir);
        const remoteResult = execGit(["rev-parse", `origin/${branch}`], rootDir);
        if (localResult.code !== 0 || remoteResult.code !== 0) {
          console.log(`  ${ICONS.warn()} Could not determine commit hashes`);
          return;
        }
        const localHash = localResult.stdout;
        const remoteHash = remoteResult.stdout;
        if (localHash === remoteHash) {
          console.log(`  ${ICONS.ok()} Status:        ${c("green", "up to date")}`);
        } else {
          console.log(`  ${ICONS.warn()} Status:        ${c("yellow", "update available")}`);
          console.log(`  ${ICONS.arrow()} Local:         ${localHash.slice(0, 8)}`);
          console.log(`  ${ICONS.arrow()} Remote:        ${remoteHash.slice(0, 8)}`);
          const logResult = execGit(["log", "--oneline", `${localHash}..${remoteHash}`, "--max-count=10"], rootDir);
          if (logResult.stdout) {
            console.log(`  ${ICONS.arrow()} New commits:`);
            for (const line of logResult.stdout.split("\n")) {
              if (line) console.log(c("gray", `    ${line}`));
            }
          }
        }
        return;
      }

      if (action === "wizard") {
        console.log(section("Update Wizard"));
        console.log(`  Current version: v${VERSION}`);
        console.log(`  Channel: ${channel}`);
        const branch = CHANNEL_BRANCHES[channel] || "main";
        const fetchResult = execGit(["fetch", "origin", branch], rootDir);
        if (fetchResult.code !== 0) {
          console.log(c("red", `  ${ICONS.error()} Failed to fetch: ${fetchResult.stderr}`));
          return;
        }
        const localResult = execGit(["rev-parse", "HEAD"], rootDir);
        const remoteResult = execGit(["rev-parse", `origin/${branch}`], rootDir);
        if (localResult.code === 0 && remoteResult.code === 0) {
          if (localResult.stdout === remoteResult.stdout) {
            console.log(c("green", `  ${ICONS.ok()} Already up to date`));
          } else {
            console.log(c("yellow", `  ${ICONS.warn()} Update available: ${localResult.stdout.slice(0, 8)} → ${remoteResult.stdout.slice(0, 8)}`));
          }
        }
        return;
      }

      console.log(section("EvoClaw Update"));
      const branch = CHANNEL_BRANCHES[channel] || "main";
      console.log(`  Channel: ${c("cyan", channel)} (branch: ${branch})`);
      console.log(`  Current: v${VERSION}`);

      const isGitRepo = fs.existsSync(path.join(rootDir, ".git"));
      if (!isGitRepo) {
        console.log(c("yellow", `  ${ICONS.warn()} Not a git repository. Cannot check for updates automatically.`));
        console.log(c("gray", "  Download updates from: https://github.com/chydroid/EvoClaw"));
        return;
      }

      console.log(c("cyan", "  Fetching remote..."));
      const fetchResult = execGit(["fetch", "origin", branch], rootDir);
      if (fetchResult.code !== 0) {
        console.log(c("red", `  ${ICONS.error()} Fetch failed: ${fetchResult.stderr}`));
        return;
      }

      const localResult = execGit(["rev-parse", "HEAD"], rootDir);
      const remoteResult = execGit(["rev-parse", `origin/${branch}`], rootDir);
      if (localResult.code !== 0 || remoteResult.code !== 0) {
        console.log(c("red", `  ${ICONS.error()} Could not resolve commits`));
        return;
      }

      const localHash = localResult.stdout;
      const remoteHash = remoteResult.stdout;

      if (localHash === remoteHash && !opts.force) {
        console.log(c("green", `  ${ICONS.ok()} Already up to date (v${VERSION})`));
        return;
      }

      if (localHash !== remoteHash) {
        const logResult = execGit(["log", "--oneline", `${localHash}..${remoteHash}`, "--max-count=10"], rootDir);
        const commitCount = logResult.stdout ? logResult.stdout.split("\n").filter(Boolean).length : 0;
        console.log(c("yellow", `  ${ICONS.warn()} ${commitCount} new commit(s) available`));
        if (logResult.stdout) {
          for (const line of logResult.stdout.split("\n")) {
            if (line) console.log(c("gray", `    ${line}`));
          }
        }
      }

      if (opts.check) {
        console.log(c("cyan", "  Check only — not applying update"));
        return;
      }

      if (!opts.yes && !opts.force) {
        console.log(c("yellow", "  Use --yes to apply the update, or --check to preview only"));
        return;
      }

      console.log(c("cyan", "  Applying update..."));
      const pullResult = execGit(["pull", "origin", branch], rootDir);
      if (pullResult.code !== 0) {
        console.log(c("red", `  ${ICONS.error()} Pull failed: ${pullResult.stderr}`));
        return;
      }
      console.log(c("green", `  ${ICONS.ok()} Updated successfully`));

      const rebuildResult = execGit(["submodule", "update", "--init", "--recursive"], rootDir);
      if (rebuildResult.code !== 0) {
        console.log(c("yellow", `  ${ICONS.warn()} Submodule update had issues (non-critical)`));
      }

      const serverAlive = await checkServer();
      if (serverAlive) {
        console.log(c("cyan", "  Gateway is running — consider restarting: EvoClaw gateway restart"));
      }
    });
}
