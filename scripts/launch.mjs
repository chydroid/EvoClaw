#!/usr/bin/env node
/**
 * 跨平台启动器 —— 替代 package.json 里写死 Windows 路径的
 * `chcp 65001 > nul && C:/PROGRA~1/nodejs/node.exe ...`。
 *
 * 背景：README 让所有平台的用户都执行 `pnpm start`，但旧脚本在
 * Linux/macOS 上必然失败（chcp 不存在 + node 路径是 Windows 的）。
 * Windows 仍需要 chcp 65001 才能让中文日志在控制台正常显示，
 * 因此按平台分流，而不是让用户自己记住 start:unix / start:win。
 *
 * 用法：
 *   node scripts/launch.mjs server   # 启动主服务
 *   node scripts/launch.mjs cli [args...]  # 透传参数给 CLI
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
const passthrough = process.argv.slice(3);
const isWindows = process.platform === "win32";

const TARGETS = {
  server: { entry: "apps/server/dist/index.js", nodeArgs: ["--max-old-space-size=4096"] },
  cli: { entry: "apps/cli/dist/index.js", nodeArgs: [] },
};

const spec = TARGETS[target];
if (!spec) {
  process.stderr.write(`[launch] unknown target "${target ?? ""}"; expected: ${Object.keys(TARGETS).join(" | ")}\n`);
  process.exit(2);
}

const entry = path.join(root, spec.entry);
if (!existsSync(entry)) {
  process.stderr.write(`[launch] ${spec.entry} not found — run \`pnpm build\` first.\n`);
  process.exit(1);
}

const nodeArgs = [...spec.nodeArgs];
// --env-file 需要 Node >= 20.6；文件不存在时显式跳过，避免 Node 直接报错。
const envFile = path.join(root, ".env");
if (existsSync(envFile)) nodeArgs.push(`--env-file=${envFile}`);
nodeArgs.push(entry, ...passthrough);

let child;
if (isWindows) {
  // cmd 的引号规则：路径里没有空格时直接拼接即可（仓库路径可能含空格，故整体加引号）。
  const quoted = nodeArgs.map((a) => (/[\s&|<>^]/.test(a) ? `"${a}"` : a));
  child = spawn("cmd", ["/c", `chcp 65001 > nul && node ${quoted.join(" ")}`], {
    stdio: "inherit",
    cwd: root,
  });
} else {
  child = spawn(process.execPath, nodeArgs, { stdio: "inherit", cwd: root });
}

child.on("error", (err) => {
  process.stderr.write(`[launch] failed to start: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
