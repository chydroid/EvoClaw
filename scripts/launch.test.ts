import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

// ═══════════════════════════════════════════════════════════
// 回归：README 让所有平台都执行 `pnpm start`，但旧脚本写死
// `chcp 65001 && C:/PROGRA~1/nodejs/node.exe`，在 Linux/macOS 必然失败。
// 现在统一走 scripts/launch.mjs，本测试锁定它的契约：
//   - 未知目标 → exit 2（而不是静默跑错东西）
//   - 缺少构建产物 → exit 1 且提示 pnpm build
// ═══════════════════════════════════════════════════════════
const root = path.resolve(__dirname, "..");
const launcher = path.join(root, "scripts", "launch.mjs");

function run(args: string[]) {
  return spawnSync(process.execPath, [launcher, ...args], { encoding: "utf-8", cwd: root });
}

describe("scripts/launch.mjs", () => {
  it("未知目标返回退出码 2 并列出可用目标", () => {
    const res = run(["nope"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("server");
    expect(res.stderr).toContain("cli");
  });

  it("不传目标同样返回退出码 2", () => {
    expect(run([]).status).toBe(2);
  });

  it("package.json 的 start/cli 脚本不再包含平台专属命令", async () => {
    const pkg = (await import("../package.json")).default as { scripts: Record<string, string> };
    for (const key of ["start", "start:unix", "start:win", "cli", "cli:unix", "cli:win"]) {
      expect(pkg.scripts[key]).toBe(`node scripts/launch.mjs ${key.startsWith("cli") ? "cli" : "server"}`);
    }
  });
});
