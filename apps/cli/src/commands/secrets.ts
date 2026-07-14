/** secrets — Manage secret keys */
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync } from "@evoclaw/core";
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
      // 安全：校验 key 格式，防止 .env 注入（key 含 = 或换行符可注入任意环境变量）
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
        console.log(c("red", `❌ Invalid key: "${key}". Key must match /^[A-Z_][A-Z0-9_]*$/i`));
        return;
      }
      // 安全：拒绝 value 含换行符，防止注入新的环境变量行
      if (value.includes("\n") || value.includes("\r")) {
        console.log(c("red", `❌ Invalid value: value must not contain newlines`));
        return;
      }
      // 安全：读取→追加→原子写入，避免 appendFileSync 非原子导致的部分写入
      // 与服务器对齐：使用项目根目录的 .env（apps/cli/src/commands → 4 级向上）
      const envPath = path.join(__dirname, "..", "..", "..", "..", ".env");
      let existing = "";
      try { existing = fs.readFileSync(envPath, "utf-8"); } catch { /* file may not exist yet */ }
      atomicWriteFileSync(envPath, existing + `\n${key}=${value}\n`);
      console.log(c("green", `✅ Set ${key} (value hidden)`));
      console.log(c("gray", "  Written to .env"));
    });
}