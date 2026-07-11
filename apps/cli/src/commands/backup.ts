/** backup — Create and verify backups */
import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import { c, ICONS } from "../utils/colors";
import { VERSION } from "../utils/api";

interface ManifestEntry {
  relPath: string;
  size: number;
}

interface BackupManifest {
  version: string;
  timestamp: string;
  items: ManifestEntry[];
}

/** Recursively copy a directory tree from src to dst, returning relative paths copied.
 *  使用 lstat 检测符号链接并跳过，避免跟随符号链接导致越权访问或循环复制。 */
function copyDir(src: string, dst: string, base: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  if (!fs.existsSync(src)) return entries;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const dstPath = path.join(dst, entry);
    // lstat 不跟随符号链接；symlinks 跳过以保证备份只包含真实文件
    const stat = fs.lstatSync(srcPath);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      entries.push(...copyDir(srcPath, dstPath, base));
    } else {
      fs.copyFileSync(srcPath, dstPath);
      entries.push({ relPath: path.relative(base, dstPath), size: stat.size });
    }
  }
  return entries;
}

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("backup")
    .description("Create and verify backups")
    .option("--create", "Create a new backup")
    .option("--verify", "Verify latest backup")
    .action((opts: Record<string, unknown>) => {
      const projectRoot = process.cwd();
      const bakDir = path.join(projectRoot, "backups");

      if (opts.create) {
        if (!fs.existsSync(bakDir)) fs.mkdirSync(bakDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const backupRoot = path.join(bakDir, `evoclaw-backup-${ts}`);
        fs.mkdirSync(backupRoot, { recursive: true });

        const items: ManifestEntry[] = [];

        // 1. Back up .env (if present)
        const envPath = path.join(projectRoot, ".env");
        if (fs.existsSync(envPath)) {
          const dstEnv = path.join(backupRoot, ".env");
          fs.copyFileSync(envPath, dstEnv);
          items.push({ relPath: ".env", size: fs.statSync(envPath).size });
        }

        // 2. Back up config.json (if present)
        const configPath = path.join(projectRoot, "config.json");
        if (fs.existsSync(configPath)) {
          fs.copyFileSync(configPath, path.join(backupRoot, "config.json"));
          items.push({ relPath: "config.json", size: fs.statSync(configPath).size });
        }

        // 3. Back up key data/ subdirectories
        const dataDir = path.join(projectRoot, "data");
        const dataSubdirs = ["skills", "sessions", "scheduler", "prompts"];
        for (const sub of dataSubdirs) {
          const src = path.join(dataDir, sub);
          if (fs.existsSync(src)) {
            const dst = path.join(backupRoot, "data", sub);
            items.push(...copyDir(src, dst, backupRoot));
          }
        }

        // 4. Back up small top-level data files (skip large binary/db files)
        const dataFiles = ["skill-index.json", "commitments.json", "memory-host.json", "pairing-store.json"];
        for (const fname of dataFiles) {
          const src = path.join(dataDir, fname);
          if (fs.existsSync(src)) {
            const dstDir = path.join(backupRoot, "data");
            if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
            const dst = path.join(dstDir, fname);
            fs.copyFileSync(src, dst);
            items.push({ relPath: path.relative(backupRoot, dst), size: fs.statSync(src).size });
          }
        }

        const manifest: BackupManifest = {
          version: VERSION,
          timestamp: new Date().toISOString(),
          items,
        };
        const manifestPath = path.join(backupRoot, "manifest.json");
        const tmp = `${manifestPath}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
        fs.renameSync(tmp, manifestPath);

        console.log(c("green", `${ICONS.ok()} Backup created: ${backupRoot}`));
        console.log(c("gray", `  ${items.length} files copied`));
      } else if (opts.verify) {
        if (!fs.existsSync(bakDir)) {
          console.log(c("red", `${ICONS.error()} No backups found in ${bakDir}`));
          process.exitCode = 1;
          return;
        }
        const backups = fs.readdirSync(bakDir)
          .filter((d) => d.startsWith("evoclaw-backup-"))
          .sort()
          .reverse();
        if (backups.length === 0) {
          console.log(c("red", `${ICONS.error()} No backups found in ${bakDir}`));
          process.exitCode = 1;
          return;
        }
        const latest = path.join(bakDir, backups[0]);
        const manifestPath = path.join(latest, "manifest.json");
        if (!fs.existsSync(manifestPath)) {
          console.log(c("red", `${ICONS.error()} Backup manifest missing: ${manifestPath}`));
          process.exitCode = 1;
          return;
        }
        let manifest: BackupManifest;
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        } catch (err) {
          console.log(c("red", `${ICONS.error()} Corrupt manifest: ${err instanceof Error ? err.message : String(err)}`));
          process.exitCode = 1;
          return;
        }
        let missing = 0;
        let sizeMismatch = 0;
        for (const entry of manifest.items) {
          const filePath = path.join(latest, entry.relPath);
          if (!fs.existsSync(filePath)) {
            console.log(c("red", `  ${ICONS.error()} Missing: ${entry.relPath}`));
            missing++;
          } else {
            const actualSize = fs.statSync(filePath).size;
            if (actualSize !== entry.size) {
              console.log(c("yellow", `  ${ICONS.warn()} Size mismatch: ${entry.relPath} (expected ${entry.size}, got ${actualSize})`));
              sizeMismatch++;
            }
          }
        }
        if (missing === 0 && sizeMismatch === 0) {
          console.log(c("green", `${ICONS.ok()} Backup verified: ${latest}`));
          console.log(c("gray", `  ${manifest.items.length} files OK, created ${manifest.timestamp}`));
        } else {
          console.log(c("red", `${ICONS.error()} Backup verification failed: ${missing} missing, ${sizeMismatch} size mismatches`));
          process.exitCode = 1;
        }
      } else {
        console.log(c("yellow", "Usage: EvoClaw backup --create  or  EvoClaw backup --verify"));
        console.log(c("gray", "  Example: EvoClaw backup --create"));
      }
    });
}
