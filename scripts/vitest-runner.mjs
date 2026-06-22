// 测试启动包装器
// 包装 vitest CLI 以统一处理参数传递。
// 同时将 Vitest 内部使用的 OS 临时目录固定到项目内的一次性子目录，
// 避免 Linux CI 上 /tmp 被系统清理或并发竞争导致 SSR 转换临时文件 ENOENT。

import { mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseCLI, startVitest } from "vitest/node";

const baseTmpDir = resolve(process.cwd(), ".vitest/tmp");
mkdirSync(baseTmpDir, { recursive: true });

const runTmpDir = join(baseTmpDir, `run-${process.pid}-${Date.now()}`);
mkdirSync(runTmpDir, { recursive: true });

process.env.TMPDIR = runTmpDir;
process.env.TMP = runTmpDir;
process.env.TEMP = runTmpDir;

// process.argv: [node, vitest-runner.mjs, ...args]
// 包装成 vitest CLI 格式：["vitest", "run", ...args]
const cliArgv = ["vitest", "run", ...process.argv.slice(2)];
const { filter, options } = parseCLI(cliArgv);

const vitest = await startVitest("test", filter, options);

// 测试运行结束后清理本次专用临时目录
// Vitest 自身会在 close() 中删除 project.tmpDir 下的 <nanoid> 子目录，
// 这里再删除外层 run-* 目录以清除测试代码写入的 SKILL.md / _i18n.json 等文件。
try {
  rmSync(runTmpDir, { recursive: true, force: true });
} catch {
  // ignore cleanup errors
}

process.exit(vitest ? 0 : 1);
