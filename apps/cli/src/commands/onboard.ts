/** onboard — Guided onboarding flow */
import { Command } from "commander";
import { c } from "../utils/colors";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("onboard")
    .description("Run guided onboarding to get started")
    .action(() => {
      console.log();
      console.log(c("bold", "=== EvoClaw Onboarding ===\n"));

      const steps = [
        { n: 1, title: "Start the server", cmd: "EvoClaw gateway start" },
        { n: 2, title: "Open the dashboard", cmd: "EvoClaw dashboard" },
        { n: 3, title: "Configure an LLM provider", cmd: "Open Web UI → LLM tab → add API key" },
        { n: 4, title: "Install a skill", cmd: "EvoClaw skills install <slug>" },
        { n: 5, title: "Configure channels (optional)", cmd: "Web UI → Channels tab" },
      ];

      for (const s of steps) {
        console.log(`  ${c("cyan", `${s.n}.`)} ${s.title}`);
        console.log(`     ${c("gray", s.cmd)}`);
      }

      console.log(`\n${c("green", "✅ Ready!")} Follow the steps above to start using EvoClaw.`);
      console.log(c("gray", "  For detailed documentation, visit: https://github.com/chydroid/EvoClaw\n"));
    });
}