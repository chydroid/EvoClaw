/** setup — Create base configuration and workspace */
import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { c, ICONS } from "../utils/colors";
import { VERSION, DEFAULT_PORT } from "../utils/api";

export function register(program: Command, _shared: (c: Command) => Command, _apply: (o: Record<string, unknown>) => void): void {
  program
    .command("setup")
    .description("Create base config (.env) and workspace directories")
    .action(() => {
      console.log(`${ICONS.rock}  EvoClaw v${VERSION} Setup`);
      console.log();

      // Create .env if missing
      const envPath = path.join(process.cwd(), ".env");
      if (!fs.existsSync(envPath)) {
        const secret = crypto.randomBytes(32).toString("hex");
        fs.writeFileSync(envPath, `EvoClaw_PORT=${DEFAULT_PORT}\nJWT_SECRET=${secret}\nEvoClaw_EVOLUTION_ENABLED=true\n`);
        console.log(c("green", `✅ Created .env with random JWT_SECRET (${secret.length} chars)`));
      } else {
        console.log(c("gray", "  .env already exists — skipped"));
      }

      // Create workspace directories
      for (const dir of ["skills", "data", "logs"]) {
        const dirPath = path.join(process.cwd(), dir);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
          console.log(c("green", `✅ Created ${dir}/ directory`));
        } else {
          console.log(c("gray", `  ${dir}/ already exists — skipped`));
        }
      }

      console.log();
      console.log(c("cyan", "📋 Next step:"));
      console.log(c("gray", "  EvoClaw onboard     — Complete guided onboarding"));
      console.log(c("gray", "  EvoClaw doctor      — Run system diagnostics"));
      console.log(c("gray", "  EvoClaw gateway start  — Start the gateway service"));
      console.log();
    });
}