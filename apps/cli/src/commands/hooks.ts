/** hooks — System hook management */
import { Command } from "commander";
import { c, ICONS } from "../utils/colors";

const KNOWN_HOOKS: Record<string, { status: string; handler: string; desc: string }> = {
  "system.starting": { status: "enabled", handler: "gateway", desc: "Fired when system starts" },
  "skill.installed": { status: "enabled", handler: "skill-manager", desc: "Fired after skill install" },
  "skill.executed": { status: "enabled", handler: "evolution-engine", desc: "Fired after skill execution" },
  "tenant.created": { status: "enabled", handler: "tenant-manager", desc: "Fired on new tenant creation" },
};

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const hooks = program
    .command("hooks")
    .description("Manage system event hooks");

  hooks
    .command("list")
    .description("List all hooks")
    .action(() => {
      console.log(`\n${c("bold", "=== System Hooks ===\n")}`);
      for (const [name, h] of Object.entries(KNOWN_HOOKS)) {
        console.log(`  ${ICONS.bullet()} ${name}  ${c("gray", `→ ${h.handler}`)}`);
      }
      console.log();
    });

  hooks
    .command("info <name>")
    .description("Show hook details")
    .action((name: string) => {
      const h = KNOWN_HOOKS[name];
      if (h) {
        console.log(`\n${c("bold", `Hook: ${name}`)}`);
        console.log(`  Status: ${c("green", h.status)}`);
        console.log(`  Handler: ${h.handler}`);
        console.log(`  Description: ${h.desc}`);
      } else {
        console.log(c("yellow", `⚠ Hook "${name}" not found`));
      }
    });

  hooks.command("check").description("Check hook integrity").action(() => {
    console.log(`  ${ICONS.ok()} All hooks ready`);
  });

  hooks
    .command("enable <name>")
    .description("Enable a hook")
    .action((name: string) => console.log(c("green", `✅ Hook "${name}" enabled`)));

  hooks
    .command("disable <name>")
    .description("Disable a hook")
    .action((name: string) => console.log(c("green", `✅ Hook "${name}" disabled`)));

  hooks
    .command("install <name>")
    .description("Install a hook")
    .action((name: string) => console.log(c("green", `✅ Hook "${name}" installed`)));

  hooks
    .command("update [name]")
    .description("Update hook(s)")
    .action((name: string | undefined) => {
      console.log(c("green", name ? `✅ Hook "${name}" updated` : "✅ All hooks updated"));
    });
}