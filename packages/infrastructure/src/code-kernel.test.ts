/**
 * CodeKernelRegistry 测试（code-kernel.ts）。
 *
 * 覆盖 Hermes code_kernel.py 核心语义：跨调用状态保留 / warm import /
 * 超时 kill+丢弃+重启 / reset 换新 / LRU 上限（附着保护）/ SystemExit
 * 内核终点 / 并发同键串行化 / raw 输出归属 / staging 残留清扫。
 *
 * CI 有 docker 无关性：按需探测 python3，缺失时整体 skip。
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { CodeKernelRegistry } from "./code-kernel";

const hasPython = spawnSync("python3", ["-V"], { encoding: "utf-8" }).status === 0;
const describeIfPython = hasPython ? describe : describe.skip;
const CWD = os.tmpdir();

describeIfPython("CodeKernelRegistry（会话持久 Python kernel）", () => {
  let reg: CodeKernelRegistry;

  const keyOf = (owner: string) => ({ owner, interpreter: "python3", cwd: CWD });
  const cell = (owner: string, code: string, timeoutMs = 15_000) =>
    reg.executeCell({ ...keyOf(owner), code, timeoutMs });

  afterEach(() => {
    reg?.dispose();
  });

  afterAll(() => {
    try { reg?.dispose(); } catch { /* ignore */ }
  });

  it("状态与执行计数跨调用保留（code_kernel 核心语义；reused 标记区分新建/复用）", async () => {
    reg = new CodeKernelRegistry({ maxSessionKernels: 2, idleTimeoutMs: 3600_000, enableReaper: false });
    const r1 = await cell("a", "articles = [1, 2, 3]\nprint('init', len(articles))");
    expect(r1.status).toBe("success");
    expect(r1.reused).toBe(false);
    expect(r1.executionCount).toBe(1);
    expect(r1.stdout).toContain("init 3");

    const r2 = await cell("a", "articles.append(4)\nprint('after', sum(articles))");
    expect(r2.status).toBe("success");
    expect(r2.reused).toBe(true);
    expect(r2.executionCount).toBe(2);
    expect(r2.stdout).toContain("after 10");
  });

  it("异常 cell 返回 traceback 且 kernel 不损毁（后续 cell 继续可用）", async () => {
    reg = new CodeKernelRegistry({ maxSessionKernels: 2, enableReaper: false });
    const bad = await cell("a", "x = 1 / 0");
    expect(bad.status).toBe("error");
    expect(bad.exitCode).toBe(1);
    expect(bad.traceback ?? "").toContain("ZeroDivisionError");
    const good = await cell("a", "print('recovered', x * 2 if 'x' in dir() else 'no-x')");
    expect(good.status).toBe("success");
  });

  it("超时：kill kernel、丢弃注册、状态丢失（下一次调用重启新 kernel，reused=false）", async () => {
    reg = new CodeKernelRegistry({ maxSessionKernels: 2, enableReaper: false });
    const t0 = Date.now();
    const slow = await cell("a", "stale = 42\nimport time; time.sleep(5); print('never')", 1000);
    const wall = Date.now() - t0;
    expect(slow.status).toBe("timeout");
    expect(slow.timedOut).toBe(true);
    expect(slow.kernelDiscarded).toBe(true);
    expect(slow.error ?? "").toContain("state was lost");
    expect(wall).toBeLessThan(4000); // 看门狗 1s 触发即 kill，不真睡 5s

    // 新 kernel：先前定义的变量不存在 -> 状态确实随内核销毁（刻意语义）
    const r = await cell("a", "try:\n    print('KEPT', stale)\nexcept NameError:\n    print('FRESH')");
    expect(r.status).toBe("success");
    expect(r.stdout.trim()).toBe("FRESH");
    expect(r.reused).toBe(false);
    expect(r.executionCount).toBe(1); // 新内核重新计数
  });

  it("reset=true：换新进程与新状态（env 冻结语义的 reset）", async () => {
    reg = new CodeKernelRegistry({ maxSessionKernels: 2, enableReaper: false });
    await cell("a", "v = 7\nprint(v)");
    const r = await reg.executeCell({
      ...keyOf("a"),
      code: "print('kept' if 'v' in dir() else 'reset')",
      timeoutMs: 15_000,
      reset: true,
    });
    expect(r.status).toBe("success");
    expect(r.stdout.trim()).toBe("reset");
    expect(r.reused).toBe(false);
    expect(r.stateReset).toBe(true);
  });

  it("LRU 上限：evict 最旧空闲 kernel；附着中（in-flight cell）不被驱逐", async () => {
    reg = new CodeKernelRegistry({ maxSessionKernels: 2, idleTimeoutMs: 3600_000, enableReaper: false });
    // 3 个 owner 并行 in-flight（全部附着）→ 计数可临时越限但一律保留
    const ps = ["a", "b", "c"].map((o) => cell(o, "import time; time.sleep(0.4); print('ok')"));
    const results = await Promise.all(ps);
    expect(results.every((r) => r.status === "success")).toBe(true);

    // 空闲后引入第 4 个 owner 触发驱逐（容量 2）：a/b/c 均为空闲 → evict 最旧 a；
    // 新内核 d 入池后瞬时 cap+1，显式执行一轮回收即回落到容量内。
    await cell("d", "print(1)");
    reg.sweepIdle();
    const stats = reg.stats();
    expect(stats.count).toBeLessThanOrEqual(2);
    expect(stats.alive).toBeLessThanOrEqual(2);
    const keys = reg.keys();
    expect(keys).toContain(`d|python3|${CWD}`);
    expect(keys).not.toContain(`a|python3|${CWD}`);
  });

  it("idle 超时回收：sweepIdle 对超期空闲内核触发 teardown", async () => {
    reg = new CodeKernelRegistry({ maxSessionKernels: 8, idleTimeoutMs: 1000, enableReaper: false });
    await cell("a", "print(1)");
    await cell("b", "print(2)");
    expect(reg.keys().sort()).toEqual([`a|python3|${CWD}`, `b|python3|${CWD}`].sort());
    reg.sweepIdle(Date.now() + 5000);
    const keys = reg.keys();
    expect(keys.length).toBe(0);
  });

  it("SystemExit = kernel 终点：置 ended、丢弃、下次调用重启（Hermes exit 语义）", async () => {
    reg = new CodeKernelRegistry({ maxSessionKernels: 2, enableReaper: false });
    const r = await cell("a", "import sys; sys.exit(3)");
    expect(r.status).toBe("exit");
    expect(r.kernelDiscarded).toBe(true);
    const next = await cell("a", "print('reborn')");
    expect(next.status).toBe("success");
    expect(next.reused).toBe(false);
  });

  it("并发同键 cells 串行化执行（sleep cell 与即时 cell 不交叉）", async () => {
    reg = new CodeKernelRegistry({ maxSessionKernels: 1, enableReaper: false });
    const slow = reg.executeCell({ ...keyOf("a"), code: "import time; time.sleep(0.3); print('slow')", timeoutMs: 15_000 });
    const fast = reg.executeCell({ ...keyOf("a"), code: "print('fast')", timeoutMs: 15_000 });
    const [r1, r2] = await Promise.all([slow, fast]);
    expect(r1.status).toBe("success");
    expect(r2.status).toBe("success");
    expect(r1.stdout).toContain("slow");
    expect(r2.stdout).toContain("fast");
    expect(r1.executionCount).toBeLessThan(r2.executionCount); // 串行：fast 后于 slow 的 id 请求顺序
  });

  it("raw stdout（绕过 redirect_stdout）归属当前 cell", async () => {
    reg = new CodeKernelRegistry({ maxSessionKernels: 1, enableReaper: false });
    const r = await cell("a", "import sys; sys.__stdout__.write('RAW-MARKER\\n')");
    expect(r.status).toBe("success");
    expect(r.stdout).toContain("RAW-MARKER");
  });

  it("staging 残留清扫：sweepStaleDirs 移除超过 7 天的 evoclaw-kernel-* 目录", () => {
    reg = new CodeKernelRegistry({ maxSessionKernels: 1, enableReaper: false });
    const stale = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-kernel-"));
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-kernel-"));
    const old = Date.now() - 8 * 86400_000;
    fs.utimesSync(stale, old / 1000, old / 1000);
    const removed = reg.sweepStaleDirs();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    fs.rmSync(fresh, { recursive: true, force: true });
    reg.dispose();
  });
});
