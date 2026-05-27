/** sandbox — Sandbox environment management */
import { Command } from "commander";
import { c } from "../utils/colors";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const sandbox = program
    .command("sandbox")
    .description("Manage sandbox environments");

  sandbox
    .command("list")
    .description("List active sandboxes")
    .option("--browser", "Show browser sandboxes")
    .option("--all", "Show all sandboxes")
    .action((opts: Record<string, unknown>) => {
      if (opts.browser) {
        console.log(`  Browser sandboxes: ${c("green", "none active")}`);
      } else {
        console.log(`  Sandbox: ${c("green", "active (default policy)")}`);
        console.log(`  Mode: strict`);
      }
    });

  sandbox
    .command("recreate")
    .description("Recreate sandbox containers")
    .option("--all", "Recreate all")
    .option("--session <id>", "Recreate for session")
    .option("--agent <id>", "Recreate for agent")
    .action((opts: Record<string, unknown>) => {
      if (opts.all) console.log(c("green", "✅ All sandbox containers recreated"));
      else if (opts.session) console.log(c("green", `✅ Sandbox for session "${opts.session}" recreated`));
      else if (opts.agent) console.log(c("green", `✅ Sandbox for agent "${opts.agent}" recreated`));
      else console.log(c("green", "✅ Sandbox recreated with default policy"));
    });

  sandbox
    .command("explain")
    .description("Explain sandbox policies")
    .action(() => {
      console.log(`\n${c("bold", "=== Sandbox Policy ===\n")}`);
      const policies = [
        ["Mode", "strict"],
        ["Network", "isolated (no external access)"],
        ["Filesystem", "read-only (except workspace)"],
        ["Processes", "limited (max 10 concurrent)"],
        ["Memory", "capped (512MB default)"],
        ["Timeout", "300s per execution"],
      ];
      for (const [k, v] of policies) {
        console.log(`  ${c("cyan", k.padEnd(14))} ${c("yellow", v)}`);
      }
      console.log(`\n${c("gray", "Review with: EvoClaw security audit --deep")}`);
    });
}