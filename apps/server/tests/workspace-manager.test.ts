/**
 * WorkspaceManager 单元测试
 *
 * 覆盖：
 * - getInfo：默认 / env / runtime 三种 source 判定。
 * - switchTo：合法目录 → 同步子系统 + 发 WORKSPACE_SWITCHED；非法路径 → 报错 + 无副作用。
 * - reset：清 override → 恢复默认 + 发 WORKSPACE_RESET。
 */

import { describe, it, expect, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { WorkspaceManager } from "../src/workspace-manager";
import { getWorkspaceDir, setWorkspaceDir, clearWorkspaceOverride } from "@evoclaw/core";

// ── 最小 mock ──────────────────────────────────────────────────────
interface MockCall { dir: string; }
interface MockExecutor { setWorkspacePath(dir: string): void; calls: string[]; }
interface MockBootstrap { setWorkspacePath(dir: string): void; calls: string[]; }
interface MockEventBus {
  publish(type: string, data: unknown, source: string): Promise<void>;
  published: Array<[string, unknown, string]>;
}

function createMockExecutor(): MockExecutor {
  const calls: string[] = [];
  return {
    setWorkspacePath(dir: string) { calls.push(dir); },
    calls,
  };
}
function createMockBootstrap(): MockBootstrap {
  const calls: string[] = [];
  return {
    setWorkspacePath(dir: string) { calls.push(dir); },
    calls,
  };
}
function createMockEventBus(): MockEventBus {
  const published: Array<[string, unknown, string]> = [];
  return {
    async publish(type: string, data: unknown, source: string) {
      published.push([type, data, source]);
    },
    published,
  };
}

function makeManager() {
  return {
    executor: createMockExecutor(),
    bootstrap: createMockBootstrap(),
    bus: createMockEventBus(),
    // 测试中使用 minimal 结构 mock（见 MockExecutor/MockBootstrap/MockEventBus），
    // 通过 as never 强转以通过 strict TS 校验——与项目内其他测试同模式
    // （programmatic-tools.test.ts:74、file-tools-security-level.test.ts:39 等）。
    mgr: (a: unknown, b: unknown, c: unknown) => new WorkspaceManager(a as never, b as never, c as never),
  };
}

describe("WorkspaceManager", () => {
  const originalEnv = process.env.EvoClaw_WORKSPACE;

  const cleanupEnv = () => {
    clearWorkspaceOverride();
    if (originalEnv === undefined) delete process.env.EvoClaw_WORKSPACE;
    else process.env.EvoClaw_WORKSPACE = originalEnv;
  };

  const tmpDirs: string[] = [];
  const newTmpDir = (prefix: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  };

  afterEach(() => {
    cleanupEnv();
    for (const d of tmpDirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("getInfo returns source=default when no env and no runtime override", () => {
    delete process.env.EvoClaw_WORKSPACE;
    clearWorkspaceOverride();
    const { mgr } = makeManager();
    const m = mgr(createMockExecutor(), createMockBootstrap(), createMockEventBus());
    const info = m.getInfo();
    expect(info.source).toBe("default");
    expect(info.overridden).toBe(false);
    // 默认路径应包含 data/workspace
    expect(info.dir).toMatch(/[\\/]data[\\/]workspace$/);
    // 且实际等于 getWorkspaceDir()
    expect(info.dir).toBe(getWorkspaceDir());
    // 预设路径必须非空且 dataWorkspace 位于 repoRoot 下
    expect(info.presets.repoRoot).toBeTruthy();
    expect(info.presets.dataWorkspace.startsWith(info.presets.repoRoot + path.sep)).toBe(true);
    expect(info.presets.dataWorkspace.endsWith(path.join("data", "workspace"))).toBe(true);
  });

  it("getInfo returns source=env when EvoClaw_WORKSPACE env is set", () => {
    process.env.EvoClaw_WORKSPACE = "/tmp/evoclaw-env-ws";
    clearWorkspaceOverride();
    const { mgr } = makeManager();
    const m = mgr(createMockExecutor(), createMockBootstrap(), createMockEventBus());
    const info = m.getInfo();
    expect(info.source).toBe("env");
    expect(info.overridden).toBe(false);
    expect(info.dir).toBe("/tmp/evoclaw-env-ws");
  });

  it("getInfo returns source=runtime when override is active", () => {
    delete process.env.EvoClaw_WORKSPACE;
    const tmp = newTmpDir("ws-info-runtime-");
    setWorkspaceDir(tmp);
    const { mgr } = makeManager();
    const m = mgr(createMockExecutor(), createMockBootstrap(), createMockEventBus());
    const info = m.getInfo();
    expect(info.source).toBe("runtime");
    expect(info.overridden).toBe(true);
    expect(info.dir).toBe(tmp);
  });

  it("switchTo valid dir → syncs executor + bootstrap + publishes WORKSPACE_SWITCHED", () => {
    delete process.env.EvoClaw_WORKSPACE;
    clearWorkspaceOverride();
    const target = newTmpDir("ws-switch-target-");
    const previous = getWorkspaceDir(); // capture before switch
    const { executor, bootstrap, bus, mgr } = makeManager();
    const m = mgr(executor, bootstrap, bus);
    const result = m.switchTo(target);
    expect(result.success).toBe(true);
    expect(result.dir).toBe(target);
    // 子系统被同步
    expect(executor.calls).toContain(target);
    expect(bootstrap.calls).toContain(target);
    // 事件被广播（fire-and-forget；mock 是 async，但 publish 已入数组）
    expect(bus.published).toHaveLength(1);
    expect(bus.published[0][0]).toBe("workspace.switched");
    const payload = bus.published[0][1] as { dir: string; source: string; previous: string };
    expect(payload.dir).toBe(target);
    expect(payload.source).toBe("runtime");
    expect(payload.previous).toBe(previous);
    // 全局单点已被更新
    expect(getWorkspaceDir()).toBe(target);
  });

  it("switchTo nonexistent path → returns error without side effects", () => {
    delete process.env.EvoClaw_WORKSPACE;
    clearWorkspaceOverride();
    const { executor, bootstrap, bus, mgr } = makeManager();
    const m = mgr(executor, bootstrap, bus);
    const result = m.switchTo("/some/nonexistent/xyz-123");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not exist/);
    expect(executor.calls).toHaveLength(0);
    expect(bootstrap.calls).toHaveLength(0);
    expect(bus.published).toHaveLength(0);
  });

  it("switchTo path that is a file → returns error without side effects", () => {
    delete process.env.EvoClaw_WORKSPACE;
    clearWorkspaceOverride();
    const f = path.join(newTmpDir("ws-file-"), "some-file.txt");
    fs.writeFileSync(f, "hello");
    const { executor, bootstrap, bus, mgr } = makeManager();
    const m = mgr(executor, bootstrap, bus);
    const result = m.switchTo(f);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a directory/);
    expect(executor.calls).toHaveLength(0);
    expect(bus.published).toHaveLength(0);
  });

  it("reset clears override and restores default (or env) dir", () => {
    delete process.env.EvoClaw_WORKSPACE;
    clearWorkspaceOverride();
    const defaultDir = getWorkspaceDir();
    // 模拟已切换到 tmp
    const tmp = newTmpDir("ws-reset-target-");
    setWorkspaceDir(tmp);
    const { executor, bootstrap, bus, mgr } = makeManager();
    const m = mgr(executor, bootstrap, bus);
    const result = m.reset();
    expect(result.success).toBe(true);
    expect(result.dir).toBe(defaultDir);
    expect(getWorkspaceDir()).toBe(defaultDir);
    expect(executor.calls).toContain(defaultDir);
    expect(bootstrap.calls).toContain(defaultDir);
    expect(bus.published).toHaveLength(1);
    expect(bus.published[0][0]).toBe("workspace.reset");
  });

  it("reset in env-mode restores env dir (not hard-coded default)", () => {
    process.env.EvoClaw_WORKSPACE = "/tmp/evoclaw-env-ws-2";
    const { executor, bootstrap, bus, mgr } = makeManager();
    const m = mgr(executor, bootstrap, bus);
    const result = m.reset();
    expect(result.success).toBe(true);
    expect(result.dir).toBe("/tmp/evoclaw-env-ws-2");
  });
});
