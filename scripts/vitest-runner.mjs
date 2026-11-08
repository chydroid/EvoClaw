// 测试启动包装器
// 包装 vitest CLI 以统一处理参数传递。
// 同时将 Vitest 内部使用的 OS 临时目录固定到一次性子目录，
// 避免并发竞争导致 SSR 转换临时文件 ENOENT。
//
// 目录选择历史：
//   1) 早期用 `<repo>/.vitest/tmp`。WSL2 上该路径位于磁盘 backing 的 Drvfs
//      mount，递归删除大目录后出现跨进程目录视图不一致（同一时刻、同路径，
//      master 写成功、worker/自身 rm 视其不存在），导致 255+ 套件 fetchModule
//      ENOENT。tmpfs（/tmp、/dev/shm）无此问题。
//   2) 现默认 os.tmpdir()（Linux 通常即 /tmp，tmpfs；CI 如需钉在项目内可用
//      EVOCLAW_TEST_TMPDIR 覆盖）。
//   3) 结束不再删除本次 run 目录（删除与存活 worker 竞态），改为下次启动前
//      清理「进程已不存在」的 run-* 目录。

import { mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
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

const baseTmpDir = process.env.EVOCLAW_TEST_TMPDIR
  ? resolve(process.env.EVOCLAW_TEST_TMPDIR)
  : os.tmpdir();
mkdirSync(baseTmpDir, { recursive: true });

const runDirName = `run-${process.pid}-${Date.now()}`;
const runTmpDir = join(baseTmpDir, runDirName);
mkdirSync(runTmpDir, { recursive: true });

// 清理历史运行的临时目录。
// 历史做法为「运行结束后删除本次 run-* 目录」，但删除动作与存活 worker 发生竞态：
// Vitest close() 的 clearTmpDir 异步 rm <nanoid>、外层 rmSync 递归删除整个 run 目录，
// 二者都落在运行收尾的毫秒级窗口内，而 singleFork worker 此刻仍有在途 fetchModule
// （模块转换缓存 + 测试中 mkdtemp 目录），读到被删目录即抛 ENOENT，级联 255+ 套件失败。
// 因此改为「本次运行开始前清理上一代目录」：仅删除进程已不存在的 run-* 目录，
// 当前运行目录排除在外，存活并发运行目录（进程仍存在）保留。
try {
  for (const name of readdirSync(baseTmpDir)) {
    if (name === runDirName || !name.startsWith("run-")) continue;
    const m = name.match(/^run-(\d+)-\d+$/);
    if (!m) continue; // 命名不符的目录不冒险删除
    try {
      process.kill(Number(m[1]), 0);
      continue; // 对应进程仍存活（并发运行），跳过
    } catch {}
    try {
      rmSync(join(baseTmpDir, name), { recursive: true, force: true });
    } catch {}
  }
} catch {}

process.env.TMPDIR = runTmpDir;
process.env.TMP = runTmpDir;
process.env.TEMP = runTmpDir;

// process.argv: [node, vitest-runner.mjs, ...args]
// 包装成 vitest CLI 格式：["vitest", "run", ...args]
const cliArgv = ["vitest", "run", ...process.argv.slice(2)];
const { filter, options } = parseCLI(cliArgv);

const vitest = await startVitest("test", filter, options);

// 运行结束时不删除本次 run 目录：删除动作本体是存活 worker fetch 竞态之源
// （历史教训见上方清理说明）。此目录会在下一次测试启动时被「开始前清理」回收，
// 测试侧写入的 SKILL.md / _i18n.json / mkdtemp 等内容一并清除。
process.exit(vitest ? 0 : 1);
