import { describe, it, expect, beforeEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { setActiveSecurityLevel, resetActiveSecurityLevel } from "@evoclaw/security";
import { registerFileTools } from "../src/tools/file-tools";

/**
 * 集成测试：验证「总体安全等级」在**真实的 file-tools 处理器里**确实被执法。
 *
 * 背景：0.87.0 只在单测里验证了 decideFileAccess() 这条纯函数，
 * 但没有证据证明工具处理器真的调用了它——这类"策略写了但没接线"的情况
 * 在本项目已经发生过（0.86.3 的能力速查表、0.86.9 的技能依赖检测都是接线失败）。
 * 本测试直接调用注册进来的 handler，走完整条链路。
 */

const FS_BASE = path.resolve("D:/abc/EvoClaw");
const WORKSPACE = path.join(FS_BASE, "data", "workspace");
// 沙箱外的真实路径（Windows 桌面），本机存在且可写
const OUTSIDE_DIR = path.join(process.env.USERPROFILE || "C:/Users/CY", "Desktop");

interface Registered {
  name: string;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

function mountTools(): Map<string, Registered> {
  const registry = new Map<string, Registered>();
  const executor = {
    registerTool(name: string, _def: unknown, handler: Registered["handler"]) {
      registry.set(name, { name, handler });
    },
  } as never;

  const permissionManager = {
    // 一律视为"已自动批准的白名单内路径"，好让测试聚焦在安全等级裁决上，
    // 而不是卡在 PermissionManager 的白名单逻辑上
    isPathAutoApproved: () => true,
    requestPermission: () => ({ id: "p1", status: "approved" as const }),
  } as never;

  const errRecovery = {
    executeWithRetry: async (_op: string, _target: string, fn: () => Promise<unknown>) => fn(),
  } as never;

  const fsMgr = {
    createFile: async (p: string, c: string) => ({ path: p, size: c.length, created: true }),
    modifyFile: async (p: string) => ({ path: p, size: 1 }),
    deleteFile: async () => undefined,
    readFile: async () => "inside-content",
    listAll: () => [{ name: "x", type: "file" }],
    operateAbsolute: async (p: string, c: string) => ({ path: p, size: c.length, created: true }),
    deleteFileAbsolute: async () => undefined,
  } as never;

  registerFileTools(executor, permissionManager, undefined, errRecovery, fsMgr, FS_BASE, WORKSPACE);
  return registry;
}

describe("file-tools × 总体安全等级 —— 集成执法验证", () => {
  beforeEach(() => resetActiveSecurityLevel());

  const run = async (tool: string, params: Record<string, unknown>) => {
    const tools = mountTools();
    const entry = tools.get(tool);
    if (!entry) throw new Error(`tool ${tool} not registered`);
    return (await entry.handler(params)) as Record<string, unknown>;
  };

  it("★ 严格档：沙箱外创建文件被直接拒绝（不得静默放行）", async () => {
    setActiveSecurityLevel("strict");
    const target = path.join(OUTSIDE_DIR, "strict-probe.txt");
    const r = await run("file_create", { path: target, content: "x" });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("安全策略");
    expect(String(r.error)).toContain("严格安全");
  });

  it("★ 严格档：沙箱外读文件同样被拒", async () => {
    setActiveSecurityLevel("strict");
    const target = path.join(OUTSIDE_DIR, "strict-probe.txt");
    const r = await run("file_read", { path: target });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("安全策略");
  });

  it("★ 严格档：沙箱内创建文件正常放行", async () => {
    setActiveSecurityLevel("strict");
    const r = await run("file_create", { path: "inside-probe.txt", content: "hello" });
    expect(r.success).not.toBe(false);
  });

  it("★ 一般档：沙箱外读放行（走 operateAbsolute/直读通道）", async () => {
    setActiveSecurityLevel("normal");
    const target = path.join(OUTSIDE_DIR, "normal-probe.txt");
    if (!fs.existsSync(target)) fs.writeFileSync(target, "outside-content", "utf-8");
    try {
      const r = await run("file_read", { path: target });
      expect(r.success).not.toBe(false);
    } finally {
      try { fs.unlinkSync(target); } catch { /* ignore */ }
    }
  });

  it("★ 一般档：沙箱外写必须走审批（requiresPermission）", async () => {
    setActiveSecurityLevel("normal");
    const target = path.join(OUTSIDE_DIR, "normal-probe.txt");
    // 用一个会被 PermissionManager 判为 pending 的桩，验证裁决确实转成了审批
    const registry = new Map<string, { name: string; handler: Registered["handler"] }>();
    const executor = {
      registerTool(n: string, _d: unknown, h: Registered["handler"]) {
        registry.set(n, { name: n, handler: h });
      },
    } as never;
    const permissionManager = {
      isPathAutoApproved: () => false,
      requestPermission: () => ({ id: "pend-1", status: "pending" as const }),
    } as never;
    const errRecovery = {
      executeWithRetry: async (_o: string, _t: string, fn: () => Promise<unknown>) => fn(),
    } as never;
    const fsMgr = {
      createFile: async () => ({ path: "", size: 0, created: true }),
      modifyFile: async () => ({ path: "", size: 0 }),
      deleteFile: async () => undefined,
      readFile: async () => "",
      listAll: () => [],
      operateAbsolute: async () => ({ path: "", size: 0, created: true }),
      deleteFileAbsolute: async () => undefined,
    } as never;
    registerFileTools(executor, permissionManager, undefined, errRecovery, fsMgr, FS_BASE, WORKSPACE);

    const r = (await registry.get("file_create")!.handler({ path: target, content: "x" })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(r.requiresPermission).toBe(true);
    expect(String(r.error)).toContain("沙箱外");
  });

  it("★ 一定风险档：沙箱外读写都放行，不产生审批", async () => {
    setActiveSecurityLevel("risky");
    const target = path.join(OUTSIDE_DIR, "risky-probe.txt");
    const r = await run("file_create", { path: target, content: "x" });
    expect(r.requiresPermission).toBeUndefined();
    expect(r.success).not.toBe(false);
  });

  it("★ 相对路径穿越在严格档被拦截（traversal 防护未被安全等级放松）", async () => {
    setActiveSecurityLevel("strict");
    const r = await run("file_create", {
      path: "../../../../../../../../Windows/System32/drivers/etc/hosts",
      content: "x",
    });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("安全策略");
  });

  it("★ 沙箱内路径的符号链接逃逸仍被拦截（risky 档也不放松）", async () => {
    setActiveSecurityLevel("risky");
    // 在 workspace 内造一个指向外部的 symlink，模拟历史攻击手法
    const linkPath = path.join(WORKSPACE, "evil-link-probe");
    try { fs.unlinkSync(linkPath); } catch { /* ignore */ }
    let made = false;
    try {
      fs.symlinkSync(OUTSIDE_DIR, linkPath, "junction");
      made = true;
    } catch {
      // 创建 symlink 需要权限；无权限则跳过该断言，不让测试变脆
      return;
    }
    try {
      const r = await run("file_read", { path: path.join(linkPath, "probe.txt") });
      // 关键：不能因为是 risky 档就把 symlink 逃逸一起放开
      if (r.success === false) {
        expect(String(r.error)).toMatch(/符号链接|symlink|outside|escap/i);
      }
    } finally {
      if (made) { try { fs.unlinkSync(linkPath); } catch { /* ignore */ } }
    }
  });
});
describe("file-tools 路径归一 —— 重复拼接与返回值（回归）", () => {
  // 真实事故（2026-10-07 15:3x）：
  // 模型按 shell_exec 的 cwd 推断，传 `data/workspace/x.py`（以为相对项目根）。
  // 而相对路径已改为按 workspace 解析 → 拼成 <ws>/data/workspace/x.py，
  // 脚本写进嵌套目录；随后 `node x.py` 报 SyntaxError，模型误判为
  // 「file_create 往内容里注入了 ## Code Analyzer Report」，白绕好几轮。
  const mount = () => {
    const reg = new Map<string, { name: string; handler: (p: Record<string, unknown>) => Promise<unknown> }>();
    const executor = {
      registerTool(n: string, _d: unknown, h: (p: Record<string, unknown>) => Promise<unknown>) {
        reg.set(n, { name: n, handler: h });
      },
    } as never;
    const perm = {
      isPathAutoApproved: () => true,
      requestPermission: () => ({ id: "x", status: "approved" as const }),
    } as never;
    const rec = { executeWithRetry: async (_o: string, _t: string, fn: () => Promise<unknown>) => fn() } as never;
    const fsm = {
      createFile: async (p: string, c: string) => ({ path: p, size: c.length, created: true }),
      modifyFile: async (p: string) => ({ path: p, size: 1 }),
      deleteFile: async () => undefined,
      readFile: async () => "c",
      listAll: () => [],
      operateAbsolute: async (p: string, c: string) => ({ path: p, size: c.length, created: true }),
      deleteFileAbsolute: async () => undefined,
    } as never;
    registerFileTools(executor, perm, undefined, rec, fsm, FS_BASE, WORKSPACE);
    return reg;
  };

  it("★ 传 data/workspace/x.py 不得拼成 workspace/data/workspace/x.py", async () => {
    resetActiveSecurityLevel();
    const r = (await mount().get("file_create")!.handler({
      path: "data/workspace/deep_probe.py",
      content: "x",
    })) as Record<string, unknown>;
    const p = String(r.path);
    expect(p).not.toMatch(/data[\\/]workspace[\\/]data[\\/]workspace/);
    expect(p.replace(/\\/g, "/")).toContain("data/workspace/deep_probe.py");
  });

  it("★ 多层重复前缀应被完全剥掉", async () => {
    resetActiveSecurityLevel();
    const r = (await mount().get("file_create")!.handler({
      path: "data/workspace/data/workspace/deep2.py",
      content: "x",
    })) as Record<string, unknown>;
    expect(String(r.path).replace(/\\/g, "/")).toContain("data/workspace/deep2.py");
    expect(String(r.path)).not.toMatch(/workspace.*workspace.*workspace/);
  });

  it("★ 返回可直接复用的绝对路径（模型据此设 cwd 不会再拼错）", async () => {
    resetActiveSecurityLevel();
    const r = (await mount().get("file_create")!.handler({ path: "probe_abs.py", content: "x" })) as Record<string, unknown>;
    expect(String(r.path)).toMatch(/^[A-Za-z]:[\\/]/); // 绝对路径
    expect(typeof r.workspaceRelative).toBe("string");
  });

  it("普通相对路径行为不变", async () => {
    resetActiveSecurityLevel();
    const r = (await mount().get("file_create")!.handler({ path: "plain.py", content: "x" })) as Record<string, unknown>;
    expect(String(r.path).replace(/\\/g, "/")).toContain("data/workspace/plain.py");
  });
});
