/**
 * migrate — 从其他 agent 系统迁移状态
 *
 * 对齐 openclaw-main 的 src/cli/program/register.migrate.ts
 * 子命令：list / plan <provider> / apply <provider>
 *
 * 注：对应后端端点尚未实现，CLI 暂不可用。
 */
import { Command } from "commander";
import { c } from "../utils/colors";

const NOT_AVAILABLE = "⚠ Data migration is not yet available via CLI.";

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
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
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
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
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
    .action(async () => {
      console.log(c("yellow", NOT_AVAILABLE));
    });

  // Default action: list if no subcommand
  migrate.action(async () => {
    console.log(c("yellow", NOT_AVAILABLE));
  });
}
