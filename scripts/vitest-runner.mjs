// 测试启动包装器
// 包装 vitest CLI 以统一处理参数传递。
// 同时将 Vitest 内部使用的 OS 临时目录固定到项目内的一次性子目录，
// 避免 Linux CI 上 /tmp 被系统清理或并发竞争导致 SSR 转换临时文件 ENOENT。

import { mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseCLI, startVitest } from "vitest/node";

// ── Node 版本引导（跨平台）──
// 背景：better-sqlite3 等原生模块与 Node ABI 绑定。本仓库的预编译二进制针对
// Node 24（ABI 137）构建，而 Windows 本机 PATH 上的 `node` 可能是受管的
// Node 22（ABI 127），直接跑会因 ABI 不匹配而加载失败。
//
// 早期做法是直接在 package.json 里写死 Windows 绝对路径
// `C:/PROGRA~1/nodejs/node.exe`，这在 GitHub Actions（Linux）上必然报
// "not found"。现改为在此处按平台探测：
//   - Windows：若当前 node 主版本不符，切到系统 Node 24（可用 EVOCLAW_TEST_NODE 覆盖）
//   - Linux / macOS：直接用当前 node（CI 由 NODE_VERSION 指定，本身即 Node 24）
const SELF = fileURLToPath(import.meta.url);
const EXPECTED_NODE_MAJOR = Number(process.env.EVOCLAW_TEST_NODE_MAJOR || "24");

if (!process.env.__EVOCLAW_TEST_BOOTSTRAPPED) {
  const currentMajor = Number(process.versions.node.split(".")[0]);
  let target = null;

  if (currentMajor !== EXPECTED_NODE_MAJOR) {
    if (process.platform === "win32") {
      // 依次尝试环境变量指定 → 系统安装路径（兼容 8.3 短名与默认安装目录）
      const candidates = [
        process.env.EVOCLAW_TEST_NODE,
        "C:/PROGRA~1/nodejs/node.exe",
        "C:/Program Files/nodejs/node.exe",
      ].filter(Boolean);
      target = candidates.find((p) => existsSync(p)) || null;
    } else {
      // 非 Windows：不做路径猜测，交由环境保证 node 版本；
      // 仅允许显式指定，避免污染 CI 行为。
      target = process.env.EVOCLAW_TEST_NODE && existsSync(process.env.EVOCLAW_TEST_NODE)
        ? process.env.EVOCLAW_TEST_NODE
        : null;
    }
  }

  if (target) {
    const res = spawnSync(target, [SELF, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, __EVOCLAW_TEST_BOOTSTRAPPED: "1" },
    });
    process.exit(res.status ?? 1);
  }
}

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
