/**
 * 沙箱抽象层测试 —— ISandboxBackend / LocalSandboxBackend / SandboxManager process 后端。
 *
 * 验证：
 *  - LocalSandboxBackend 基本执行（node -e / echo）
 *  - SandboxPolicy 路径越界拒绝
 *  - timeout 强制 kill
 *  - maxOutputBytes 输出截断
 *  - SandboxManager process 后端端到端
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SandboxManager } from "./sandbox-manager";
import { LocalSandboxBackend } from "./sandbox-backend";
import type { SandboxPolicy } from "@evoclaw/core";
import * as path from "node:path";
import * as os from "node:os";

const RESTRICTIVE_POLICY: SandboxPolicy = {
  allowNetwork: false,
  allowFileSystem: true,
  allowSubprocess: true,
  maxExecutionTime: 5000,
  maxMemoryMB: 256,
  allowedHosts: [],
  allowedPaths: [],
};

describe("LocalSandboxBackend", () => {
  let backend: LocalSandboxBackend;

  beforeEach(() => {
    backend = new LocalSandboxBackend();
  });

  afterEach(async () => {
    await backend.dispose();
  });

  it("isAvailable 始终返回 true", async () => {
    expect(await backend.isAvailable()).toBe(true);
  });

  it("执行 node -e 打印 hello", async () => {
    const result = await backend.execute(
      process.platform === "win32" ? ["node", "-e", "console.log('hello')"] : ["node", "-e", "console.log('hello')"],
      { timeoutMs: 5000, workdir: os.tmpdir() },
    );

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.timedOut).toBe(false);
  });

  it("type 属性为 process", () => {
    expect(backend.type).toBe("process");
  });

  it("空命令返回错误", async () => {
    const result = await backend.execute([], { workdir: os.tmpdir() });
    expect(result.success).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("不存在的工作目录返回错误", async () => {
    const result = await backend.execute(["node", "-e", "1"], {
      workdir: "/nonexistent/path/that/does/not/exist",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("does not exist");
  });

  it("timeout 超时后 kill 进程", async () => {
    // node 死循环，5s 超时
    const result = await backend.execute(
      ["node", "-e", "while(true){}"],
      { timeoutMs: 500, workdir: os.tmpdir() },
    );

    expect(result.timedOut).toBe(true);
    expect(result.success).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(400);
  });

  it("maxOutputBytes 截断输出", async () => {
    // 输出 10000 字符，限制 100 字节
    const result = await backend.execute(
      ["node", "-e", "process.stdout.write('x'.repeat(10000))"],
      { timeoutMs: 5000, workdir: os.tmpdir(), maxOutputBytes: 100 },
    );

    expect(result.stdout.length).toBeLessThanOrEqual(100);
    expect(result.error).toContain("truncated");
  });

  it("SandboxPolicy allowedPaths 越界拒绝", async () => {
    const policy: SandboxPolicy = {
      ...RESTRICTIVE_POLICY,
      allowedPaths: [os.tmpdir()], // 只允许 tmpdir
    };
    // 引用 tmpdir 之外的路径
    const outsidePath = path.resolve(os.tmpdir(), "..", "..", "etc", "passwd");
    const result = await backend.execute(["cat", outsidePath], {
      workdir: os.tmpdir(),
      policy,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("allowedPaths");
  });

  it("SandboxPolicy allowFileSystem=false 拒绝路径参数", async () => {
    const policy: SandboxPolicy = {
      ...RESTRICTIVE_POLICY,
      allowFileSystem: false,
    };
    const result = await backend.execute(["node", "/usr/local/bin/node"], {
      workdir: os.tmpdir(),
      policy,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("file system access");
  });

  it("executeScript 执行 node 脚本", async () => {
    const result = await backend.executeScript(
      "console.log('script-output:' + (1 + 2))",
      { interpreter: "node", timeoutMs: 5000, workdir: os.tmpdir() },
    );

    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe("script-output:3");
  });

  it("exitCode 非零时 success=false", async () => {
    const result = await backend.execute(
      ["node", "-e", "process.exit(3)"],
      { timeoutMs: 5000, workdir: os.tmpdir() },
    );

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
  });
});

describe("SandboxManager process 后端", () => {
  let manager: SandboxManager;

  beforeEach(() => {
    manager = new SandboxManager();
  });

  afterEach(async () => {
    await manager.dispose();
  });

  it("createSession 创建 process 会话", async () => {
    const session = await manager.createSession({
      backend: "process",
      policy: RESTRICTIVE_POLICY,
    });

    expect(session.backend).toBe("process");
    expect(session.status).toBe("ready");
    expect(session.policy).toEqual(RESTRICTIVE_POLICY);
  });

  it("execute 通过 process 后端执行命令", async () => {
    const session = await manager.createSession({
      backend: "process",
      policy: RESTRICTIVE_POLICY,
    });

    const result = await manager.execute(
      session.id,
      ["node", "-e", "console.log('via-manager')"],
      { timeoutMs: 5000, workdir: os.tmpdir() },
    );

    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe("via-manager");
  });

  it("executeScript 通过 process 后端执行脚本", async () => {
    const session = await manager.createSession({
      backend: "process",
    });

    const result = await manager.executeScript(
      session.id,
      "console.log('script-via-manager')",
      { interpreter: "node", timeoutMs: 5000 },
    );

    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe("script-via-manager");
  });

  it("destroySession 销毁会话", async () => {
    const session = await manager.createSession({ backend: "process" });
    await manager.destroySession(session.id);

    const retrieved = manager.getSession(session.id);
    expect(retrieved).toBeUndefined();
  });

  it("不存在的 sessionId 返回错误", async () => {
    const result = await manager.execute("nonexistent", ["node", "-e", "1"]);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Session not found");
  });

  it("listBackends 包含 process 且 available=true", async () => {
    const backends = await manager.listBackends();
    const processBackend = backends.find((b) => b.type === "process");
    expect(processBackend).toBeDefined();
    expect(processBackend?.available).toBe(true);
  });

  it("会话绑定 policy 在 execute 时自动应用", async () => {
    const policy: SandboxPolicy = {
      ...RESTRICTIVE_POLICY,
      allowedPaths: [os.tmpdir()],
    };
    const session = await manager.createSession({
      backend: "process",
      policy,
    });

    // 引用 tmpdir 外的路径，应被 policy 拒绝
    const outsidePath = path.resolve(os.tmpdir(), "..", "..", "etc", "passwd");
    const result = await manager.execute(session.id, ["cat", outsidePath], {
      workdir: os.tmpdir(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("allowedPaths");
  });
});
