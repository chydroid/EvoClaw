/** secrets — Manage secret keys */
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { c } from "../utils/colors";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  const secrets = program
    .command("secrets")
    .description("Manage security secrets");

  secrets
    .command("list")
    .description("List configured secrets (values hidden)")
    .action(() => {
      const keys = Object.keys(process.env).filter(k =>
        k.startsWith("EvoClaw_") || k.includes("SECRET") || k.includes("KEY") || k.includes("TOKEN")
      );
      if (keys.length === 0) {
        console.log(c("gray", "No secrets configured. Use Web UI → LLM tab to add API keys."));
      } else {
        for (const k of keys) console.log(`  ${k}=${c("gray", "***")}`);
      }
    });

  secrets
    .command("set <key> <value>")
    .description("Set a secret value (appended to .env)")
    .action((key: string, value: string) => {
      fs.appendFileSync(path.join(process.cwd(), ".env"), `\n${key}=${value}\n`);
      console.log(c("green", `✅ Set ${key} (value hidden)`));
      console.log(c("gray", "  Written to .env"));
    });
}