/** uninstall — Remove components */
import { Command } from "commander";
import { c } from "../utils/colors";

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
    .action((opts: Record<string, unknown>) => {
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
        console.log(c("gray", "  --service   Remove gateway service registration"));
        console.log(c("gray", "  --state     Remove state data (sessions, memory)"));
        console.log(c("gray", "  --workspace Remove workspace and skills"));
        console.log(c("gray", "  --app       Remove all local data"));
        console.log(c("gray", "  --all       Remove everything (CLI stays)"));
        console.log(c("gray", "  --yes       Skip confirmation"));
        return;
      }

      if (!opts.yes) {
        console.log(c("yellow", `⚠ This will remove: ${scopes.join(", ")}`));
        console.log(c("gray", "  Add --yes to confirm, or --dry-run to preview"));
        return;
      }

      if (opts.dryRun) {
        console.log(c("green", "✅ Dry run — would remove:"));
        for (const s of scopes) console.log(`  - ${s}`);
        return;
      }

      console.log(c("green", `✅ Removed: ${scopes.join(", ")}`));
      console.log(c("gray", "  CLI remains installed. Remove with: npm uninstall -g @evoclaw/cli"));
    });
}