/**
 * migrate — 从其他 agent 系统迁移状态
 *
 * 对齐 openclaw-main 的 src/cli/program/register.migrate.ts
 * 子命令：list / plan <provider> / apply <provider>
 */
import { Command } from "commander";
import { apiRequest } from "../utils/api";
import { c, ICONS, divider } from "../utils/colors";
import {
  ensureServer,
  printJson,
  printError,
  printSuccess,
  printWarn,
  printTable,
  confirmPrompt,
} from "../utils/shared";

interface MigrationProvider {
  id: string;
  label: string;
  description?: string;
  sourcePath?: string;
  capabilities?: string[];
}

interface MigrationPlan {
  provider: string;
  source: string;
  items: Array<{
    kind: string;
    name: string;
    action: "import" | "skip" | "overwrite" | "merge";
    target?: string;
    note?: string;
  }>;
  warnings: string[];
  summary: {
    total: number;
    import: number;
    skip: number;
    overwrite: number;
    merge: number;
  };
}

const PROVIDER_ALIASES: Record<string, string> = {
  hermes: "hermes",
  openclaw: "openclaw",
  claude: "claude-code",
  "claude-code": "claude-code",
  cursor: "cursor",
  cline: "cline",
  evoclaw: "evoclaw",
};

export function register(program: Command): void {
  const migrate = program
    .command("migrate [provider]")
    .description("Import state from another agent system")
    .option("--from <path>", "Source path (e.g. ~/.hermes, ~/.openclaw)")
    .option("--include-secrets", "Include auth credentials and tokens in migration")
    .option("--no-auth-credentials", "Exclude auth credentials (default)")
    .option("--overwrite", "Overwrite existing entries")
    .option("--dry-run", "Plan only, do not apply changes")
    .option("--yes", "Skip confirmation prompts")
    .option("--skill <name>", "Migrate specific skill only (can be repeated)", (v: string, acc: string[]) => [...(acc ?? []), v], [])
    .option("--plugin <name>", "Migrate specific plugin only (can be repeated)", (v: string, acc: string[]) => [...(acc ?? []), v], [])
    .option("--backup-output <path>", "Write backup archive to this path before applying")
    .option("--no-backup", "Skip backup creation before migration")
    .option("--force", "Force apply even if warnings")
    .option("--verify-plugin-apps", "Verify plugin apps before applying")
    .option("--json", "Output as JSON");

  migrate
    .command("list")
    .description("List migration providers")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<{ providers: MigrationProvider[] }>("GET", "/api/migrate/providers");
        const providers = r.data?.providers ?? [];
        if (opts.json || (migrate.opts() as { json?: boolean }).json) {
          printJson({ providers });
          return;
        }
        console.log();
        console.log(c("bold", `${ICONS.rock}  Migration Providers`));
        console.log(divider());
        if (providers.length === 0) {
          console.log(c("gray", "  No providers available."));
        } else {
          printTable(
            [
              { header: "ID", width: 18 },
              { header: "Label", width: 22 },
              { header: "Source Path", width: 32 },
              { header: "Capabilities" },
            ],
            providers.map((p) => [
              c("cyan", p.id),
              p.label,
              p.sourcePath ?? "—",
              (p.capabilities ?? []).join(", "),
            ]),
          );
        }
        console.log();
      } catch (err) {
        printError("Failed to list providers", err instanceof Error ? err.message : String(err));
      }
    });

  migrate
    .command("plan <provider>")
    .description("Preview a migration without changing EvoClaw state")
    .option("--from <path>", "Source path")
    .option("--include-secrets", "Include secrets")
    .option("--overwrite", "Overwrite existing entries")
    .option("--skill <name>", "Migrate specific skill only", (v: string, acc: string[]) => [...(acc ?? []), v], [])
    .option("--plugin <name>", "Migrate specific plugin only", (v: string, acc: string[]) => [...(acc ?? []), v], [])
    .option("--verify-plugin-apps", "Verify plugin apps")
    .option("--json", "Output as JSON")
    .action(async (providerArg: string, opts: Record<string, unknown>) => {
      const provider = PROVIDER_ALIASES[providerArg.toLowerCase()] ?? providerArg;
      if (!(await ensureServer())) return;
      try {
        const r = await apiRequest<MigrationPlan>("POST", "/api/migrate/plan", {
          provider,
          from: opts.from,
          includeSecrets: !!opts.includeSecrets,
          overwrite: !!opts.overwrite,
          skills: opts.skill ?? [],
          plugins: opts.plugin ?? [],
          verifyPluginApps: !!opts.verifyPluginApps,
        });
        if (opts.json || (migrate.opts() as { json?: boolean }).json) {
          printJson(r.data);
          return;
        }
        const plan = r.data;
        console.log();
        console.log(c("bold", `${ICONS.rock}  Migration Plan: ${c("cyan", provider)}`));
        console.log(divider());
        console.log(`  Source:        ${c("gray", plan.source)}`);
        console.log(`  Total items:   ${plan.summary.total}`);
        console.log(`  Import:        ${c("green", String(plan.summary.import))}`);
        console.log(`  Skip:          ${c("gray", String(plan.summary.skip))}`);
        console.log(`  Overwrite:     ${c("yellow", String(plan.summary.overwrite))}`);
        console.log(`  Merge:         ${c("cyan", String(plan.summary.merge))}`);
        console.log();
        if (plan.warnings.length > 0) {
          console.log(c("yellow", "  Warnings:"));
          for (const w of plan.warnings) console.log(c("yellow", `    ⚠  ${w}`));
          console.log();
        }
        if (plan.items.length > 0) {
          printTable(
            [
              { header: "Kind", width: 12 },
              { header: "Name", width: 24 },
              { header: "Action", width: 12 },
              { header: "Target", width: 24 },
              { header: "Note" },
            ],
            plan.items.map((it) => [
              c("cyan", it.kind),
              it.name,
              formatAction(it.action),
              it.target ?? "—",
              it.note ?? "",
            ]),
          );
        }
        console.log();
      } catch (err) {
        printError("Failed to plan migration", err instanceof Error ? err.message : String(err));
      }
    });

  migrate
    .command("apply <provider>")
    .description("Apply a migration after a verified backup")
    .option("--from <path>", "Source path")
    .option("--include-secrets", "Include secrets")
    .option("--overwrite", "Overwrite existing entries")
    .option("--yes", "Skip confirmation")
    .option("--backup-output <path>", "Backup archive path")
    .option("--no-backup", "Skip backup")
    .option("--force", "Force apply even with warnings")
    .option("--skill <name>", "Migrate specific skill only", (v: string, acc: string[]) => [...(acc ?? []), v], [])
    .option("--plugin <name>", "Migrate specific plugin only", (v: string, acc: string[]) => [...(acc ?? []), v], [])
    .option("--verify-plugin-apps", "Verify plugin apps")
    .option("--json", "Output as JSON")
    .action(async (providerArg: string, opts: Record<string, unknown>) => {
      const provider = PROVIDER_ALIASES[providerArg.toLowerCase()] ?? providerArg;
      if (!(await ensureServer())) return;
      const wantJson = opts.json || (migrate.opts() as { json?: boolean }).json;
      // Step 1: plan first
      let plan: MigrationPlan;
      try {
        const r = await apiRequest<MigrationPlan>("POST", "/api/migrate/plan", {
          provider,
          from: opts.from,
          includeSecrets: !!opts.includeSecrets,
          overwrite: !!opts.overwrite,
          skills: opts.skill ?? [],
          plugins: opts.plugin ?? [],
          verifyPluginApps: !!opts.verifyPluginApps,
        });
        plan = r.data;
      } catch (err) {
        printError("Migration plan failed", err instanceof Error ? err.message : String(err));
        return;
      }
      // Step 2: warnings check
      if (plan.warnings.length > 0 && !opts.force) {
        if (!wantJson) {
          console.log(c("yellow", "  Warnings detected:"));
          for (const w of plan.warnings) console.log(c("yellow", `    ⚠  ${w}`));
          console.log();
        }
        const confirmed = await confirmPrompt(`Continue applying migration from ${provider} with ${plan.warnings.length} warning(s)?`, false);
        if (!confirmed) {
          if (!wantJson) console.log(c("gray", "  Migration cancelled."));
          return;
        }
      }
      // Step 3: backup if not skipped
      let backupPath: string | undefined;
      if (opts.backup !== false) {
        try {
          const r = await apiRequest<{ ok: boolean; backupPath: string }>("POST", "/api/migrate/backup", {
            provider,
            outputPath: opts.backupOutput,
          });
          backupPath = r.data?.backupPath;
          if (!wantJson && backupPath) console.log(c("gray", `  Backup written to ${backupPath}`));
        } catch (err) {
          printError("Backup failed, aborting migration", err instanceof Error ? err.message : String(err));
          return;
        }
      }
      // Step 4: apply
      try {
        const r = await apiRequest<{ ok: boolean; applied: number; skipped: number; errors: string[] }>("POST", "/api/migrate/apply", {
          provider,
          from: opts.from,
          includeSecrets: !!opts.includeSecrets,
          overwrite: !!opts.overwrite,
          skills: opts.skill ?? [],
          plugins: opts.plugin ?? [],
          verifyPluginApps: !!opts.verifyPluginApps,
          force: !!opts.force,
          backupPath,
        });
        if (wantJson) {
          printJson(r.data);
          return;
        }
        if (r.data?.ok || r.status === 200) {
          printSuccess(`Migration applied: ${r.data?.applied ?? 0} items imported, ${r.data?.skipped ?? 0} skipped`);
          if (r.data?.errors && r.data.errors.length > 0) {
            printWarn(`${r.data.errors.length} error(s) during migration`);
            for (const e of r.data.errors) console.log(c("red", `    ✗ ${e}`));
          }
        } else {
          printWarn("Migration may not have been fully applied");
        }
      } catch (err) {
        printError("Migration apply failed", err instanceof Error ? err.message : String(err));
      }
    });

  // Default action: list if no subcommand
  migrate.action(async () => {
    if (!(await ensureServer())) return;
    try {
      const r = await apiRequest<{ providers: MigrationProvider[] }>("GET", "/api/migrate/providers");
      const providers = r.data?.providers ?? [];
      console.log();
      console.log(c("bold", `${ICONS.rock}  Migration Providers`));
      console.log(divider());
      if (providers.length === 0) {
        console.log(c("gray", "  No providers available."));
      } else {
        for (const p of providers) {
          console.log(`  ${ICONS.bullet()} ${c("cyan", p.id)}  ${p.label}`);
          if (p.description) console.log(c("gray", `    ${p.description}`));
        }
      }
      console.log();
      console.log(c("gray", "  Use 'EvoClaw migrate plan <provider>' to preview, 'EvoClaw migrate apply <provider>' to apply."));
      console.log();
    } catch (err) {
      printError("Failed to list providers", err instanceof Error ? err.message : String(err));
    }
  });
}

function formatAction(action: string): string {
  const map: Record<string, string> = {
    import: c("green", "import"),
    skip: c("gray", "skip"),
    overwrite: c("yellow", "overwrite"),
    merge: c("cyan", "merge"),
  };
  return map[action] ?? action;
}
