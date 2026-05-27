/** docs — Documentation search */
import { Command } from "commander";
import { c } from "../utils/colors";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("docs [query]")
    .description("Search documentation")
    .action((query: string) => {
      if (query) {
        console.log(`📚 Searching docs: ${c("bold", query)}`);
        console.log(c("gray", `  https://github.com/chydroid/EvoClaw`));
      } else {
        console.log(c("green", "📚 EvoClaw Documentation:"));
        console.log(c("gray", "  CLI Reference:     EvoClaw --help"));
        console.log(c("gray", "  GitHub:            https://github.com/chydroid/EvoClaw"));
        console.log(c("gray", "  Skill Hub:         https://clawhub.ai"));
      }
    });
}