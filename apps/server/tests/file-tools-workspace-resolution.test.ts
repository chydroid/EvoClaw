import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { setActiveSecurityLevel, resetActiveSecurityLevel } from "@evoclaw/security";
import { registerFileTools, resolveToolPath } from "../src/tools/file-tools";

/**
 * e2e 11 任务压测（2026-11-07）暴露的真实缺陷回归测试。
 * 全部测试使用**平台无关的临时目录**（Linux/Windows/macOS 同语义）。

   * 缺陷 1（t11-5）：绝对路径指向真实存在的工作区文件时，
   *   stripWorkspacePrefix 盲目剥掉 /data/workspace/ 段 → 解析到不存在的路径。
   * 缺陷 2（t11-5/t11-9）：ENOENT 被当瞬态错误重试 → 外层 30s 工具超时
   *   把错误包装成误导性的 timeout（Security 套件覆盖重试语义，本文件覆盖
   *   handler 层的报错提示）。
 * 缺陷 3（t11-9）：错误信息不含 workspace 根路径 → 模型连续猜错路径。
 */

interface Registered {
  name: string;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

function mountTools(
  fsBase: string,
  errRecovery: unknown,
  fsMgr: unknown = null,
): { registry: Map<string, Registered> } {
  const registry = new Map<string, Registered>();
  const executor = {
    registerTool(name: string, def: Record<string, unknown>, handler: Registered["handler"]) {
      registry.set(name, { name, handler, definition: def });
    },
  } as never;
  const permissionManager = {
    isPathAutoApproved: () => true,
    requestPermission: () => ({ id: "p1", status: "approved" as const }),
  } as never;
  const fallbackFsMgr = {
    createFile: async (p: string, c: string) => ({ path: p, size: c.length, created: true }),
    modifyFile: async (p: string) => ({ path: p, size: 1 }),
    deleteFile: async () => undefined,
    readFile: async () => "inside-content",
    listAll: () => [],
    operateAbsolute: async (p: string, c: string) => ({ path: p, size: c.length, created: true }),
    deleteFileAbsolute: async () => undefined,
  };
  registerFileTools(
    executor,
    permissionManager,
    undefined,
    errRecovery,
    fsMgr ?? fallbackFsMgr,
    fsBase,
    path.join(fsBase, "data", "workspace"),
  );
  return { registry };
}

/** errRecovery 桩：模拟 ErrorRecoveryManager 在 ENOENT 修复后的"1 次即抛"行为。 */
function throwingRecovery(): unknown {
  return {
    executeWithRetry: async (_op: string, _target: string, fn: () => Promise<unknown>) => {
      return await fn();
    },
  } as never;
}

/** errRecovery 桩：永远抛 ENOENT，模拟旧重试模块最终向上透传的形态。 */
function hardEnoentRecovery(): unknown {
  return {
    executeWithRetry: async () => {
      throw new Error("ENOENT: no such file or directory, open '/x'");
    },
  } as never;
}

describe("resolveToolPath × 绝对路径真实性优先（2026-11-07 修正）", () => {
  let tmp: string;
  let fsBase: string;
  let workspace: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-fttools-"));
    fsBase = tmp;
    workspace = path.join(tmp, "data", "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "analyze_app_log.py"), "print(1)\n", "utf-8");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });

  it("绝对路径指向真实存在的 workspace 文件 → 保留原路径，不得剥离 /data/workspace/ 段", () => {
    const p = path.join(workspace, "analyze_app_log.py");
    const r = resolveToolPath(fsBase, workspace, p);
    expect(r.resolved).toBe(p);
    expect(r.forFs).toBe(path.join("data", "workspace", "analyze_app_log.py").replace(/\\/g, "/"));
  });

  it("绝对路径含 /data/workspace/ 段且剥段目标真实存在 → 仍剥离（2026-11-03 仓库根读场景保留）", () => {
    // 仓库源码文件场景：模型把 /repo/packages/... 误写成 /repo/data/workspace/packages/...
    // 剥段目标（/repo/packages/...）在磁盘上真实存在 → 判定为「读真实仓库文件」→ 剥离。
    const target = path.join(tmp, "packages", "agent", "src", "x.ts");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "export {};\n", "utf-8");
    const r = resolveToolPath(fsBase, workspace, path.join(tmp, "data", "workspace", "packages", "agent", "src", "x.ts"));
    expect(r.resolved).toBe(target);
  });

  it("★ Task 6 事故回归：绝对路径含 /data/workspace/ 段且剥段目标**不存在** → 保持声明路径，文件落在 workspace", () => {
    // v9 压测 Task 6（2026-11-08）：模型声称写
    //   /home/chy/EvoClaw/data/workspace/v9-novel/the-last-city.md
    // 但旧逻辑无条件剥掉 /data/workspace/ 段 → 文件实际落到仓库根
    //   /home/chy/EvoClaw/v9-novel/the-last-city.md（不存在 data/workspace）
    // 磁盘核验判缺失 → 续跑指令要求「原样重传该绝对路径」→ 又被剥段 → 死循环。
    // 修复：剥段目标（仓库根同名）不存在时不再剥离，声明的 workspace 路径直通。
    const claimed = path.join(workspace, "v9-novel", "the-last-city.md");
    // 仓库根下的剥段目标此时不存在
    expect(fs.existsSync(path.join(tmp, "v9-novel", "the-last-city.md"))).toBe(false);
    const r = resolveToolPath(fsBase, workspace, claimed);
    expect(r.resolved).toBe(claimed);
    expect(r.forFs).toBe(path.join("data", "workspace", "v9-novel", "the-last-city.md").replace(/\\/g, "/"));
  });

  it("相对路径带 data/workspace/ 前缀 → 归一到 workspace 下同名文件", () => {
    const r = resolveToolPath(fsBase, workspace, "data/workspace/analyze_app_log.py");
    expect(r.resolved).toBe(path.join(workspace, "analyze_app_log.py"));
  });
});

describe("file_read × ENOENT 报错指引（workspace 根可见）", () => {  let tmp: string;
  let fsBase: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-fttools2-"));
    fsBase = tmp;
    fs.mkdirSync(path.join(fsBase, "data", "workspace"), { recursive: true });
    setActiveSecurityLevel("normal");
  });

  afterEach(() => {
    resetActiveSecurityLevel();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  it("读取不存在的文件 → 报错含 workspace 根与沙箱根，不再呈现裸 ENOENT", async () => {
    const { registry } = mountTools(fsBase, hardEnoentRecovery());
    const entry = registry.get("file_read");
    if (!entry) throw new Error("file_read not registered");
    const r = (await entry.handler({ path: "missing.py" })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("ENOENT");
    const hint = String(r.hint ?? "");
    expect(hint).toContain(fsBase);
    expect(hint).toContain(path.join(fsBase, "data", "workspace"));
  });

  it("读取真实存在的 workspace 绝对路径 → 直达内容（t11-5 事故回归）", async () => {
    const target = path.join(fsBase, "data", "workspace", "analyze_app_log.py");
    const { registry } = mountTools(fsBase, throwingRecovery());
    const entry = registry.get("file_read");
    if (!entry) throw new Error("file_read not registered");
    const r = (await entry.handler({ path: target })) as Record<string, unknown>;
    expect(r.success).not.toBe(false);
    expect(r.path).toBe(target);
  });
});

describe("file_write × action 取值归一化（v10 Task 6 事故回归）", () => {
  // 事故：模型把枚举值写成 "create\n</parameter=overwrite>\ntrue"
  // （换行 + 伪 XML 尾巴混进取值），旧 dispatch 严格 === 判定 → 整条写路径
  // 报废，脚本从未落盘，续跑空转到 loop 检测。归一化取首个字母 token。
  let tmp: string;
  let fsBase: string;

  interface SpyCalls {
    calls: string[];
    fsMgr: Record<string, unknown>;
  }

  function spyFsMgr(): SpyCalls {
    const calls: string[] = [];
    const record = (op: string, p: string) => calls.push(`${op}:${p}`);
    return {
      calls,
      fsMgr: {
        createFile: async (p: string, c: string) => {
          record("create", p);
          return { path: p, size: c.length, created: true };
        },
        modifyFile: async (p: string) => {
          record("modify", p);
          return { path: p, size: 1 };
        },
        readFile: async () => "",
        deleteFile: async () => undefined,
        listAll: () => [],
        // 注意：测试目录在 os.tmpdir() 下，preflight 命中「临时目录豁免」
        // （沙箱外已授权）→ create/modify 都走 operateAbsolute，mode 参数
        // 才是真正的动作名。
        operateAbsolute: async (p: string, c: string, mode: string) => {
          record(String(mode), p);
          return { path: p, size: c.length, created: true };
        },
        deleteFileAbsolute: async () => undefined,
      },
    };
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-fttools-act-"));
    fsBase = tmp;
    fs.mkdirSync(path.join(fsBase, "data", "workspace"), { recursive: true });
    setActiveSecurityLevel("normal");
  });

  afterEach(() => {
    resetActiveSecurityLevel();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });

  it("action 混入换行与伪 XML 尾巴（实测取值）→ 仍按 create 落盘", async () => {
    const spy = spyFsMgr();
    const { registry } = mountTools(fsBase, throwingRecovery(), spy.fsMgr);
    const entry = registry.get("file_write");
    if (!entry) throw new Error("file_write not registered");
    const r = (await entry.handler({
      action: "create\n</parameter=overwrite>\ntrue",
      path: "v10-script/gps-relativity-script.md",
      content: "# 脚本\n",
    })) as Record<string, unknown>;
    expect(r.success).not.toBe(false);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].startsWith("create:")).toBe(true);
    expect(spy.calls[0]).toContain("gps-relativity-script.md");
  });

  it("action=MODIFY（大小写混写）→ 走 modify 分支", async () => {
    const spy = spyFsMgr();
    const { registry } = mountTools(fsBase, throwingRecovery(), spy.fsMgr);
    const entry = registry.get("file_write");
    if (!entry) throw new Error("file_write not registered");
    const r = (await entry.handler({
      action: "MODIFY",
      path: "note.md",
      content: "x",
    })) as Record<string, unknown>;
    expect(r.success).not.toBe(false);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].startsWith("modify:")).toBe(true);
  });

  it("真正未知的 action → 报错不落盘，错误不含换行污染", async () => {
    const spy = spyFsMgr();
    const { registry } = mountTools(fsBase, throwingRecovery(), spy.fsMgr);
    const entry = registry.get("file_write");
    if (!entry) throw new Error("file_write not registered");
    const r = (await entry.handler({
      action: "delete",
      path: "note.md",
      content: "x",
    })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("未知 file_write action");
    expect(spy.calls).toHaveLength(0);
  });

  it("action 缺省 → auto：磁盘不存在 → create", async () => {
    const spy = spyFsMgr();
    const { registry } = mountTools(fsBase, throwingRecovery(), spy.fsMgr);
    const entry = registry.get("file_write");
    if (!entry) throw new Error("file_write not registered");
    const r = (await entry.handler({ path: "note.md", content: "x" })) as Record<string, unknown>;
    expect(r.success).not.toBe(false);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].startsWith("create:")).toBe(true);
  });

  it("action 缺省 → auto：磁盘已存在但会话无全文基线 → 拒绝覆盖（对齐 hermes）", async () => {
    // hermes write_file 只在「本任务有该文件当前全文」时才覆盖；否则拒绝。
    const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(fsBase, p));
    const seen: Array<{ op: string; path: string }> = [];
    const realFsMgr = {
      createFile: async (p: string, c: string) => {
        const file = abs(p);
        seen.push({ op: "create", path: file });
        fs.writeFileSync(file, c, "utf-8");
        return { path: p, size: c.length, created: true };
      },
      modifyFile: async (p: string, c: string) => {
        const file = abs(p);
        seen.push({ op: "modify", path: file });
        fs.writeFileSync(file, c, "utf-8");
        return { path: p, size: c.length };
      },
      readFile: async () => "",
      deleteFile: async () => undefined,
      listAll: () => [],
      operateAbsolute: async (p: string, c: string, mode: string) => {
        const file = abs(p);
        seen.push({ op: String(mode), path: file });
        fs.writeFileSync(file, c, "utf-8");
        return { path: p, size: c.length, created: true };
      },
      deleteFileAbsolute: async () => undefined,
    };
    fs.writeFileSync(path.join(fsBase, "data", "workspace", "note.md"), "existing\n", "utf-8");
    const { registry } = mountTools(fsBase, throwingRecovery(), realFsMgr);
    const entry = registry.get("file_write");
    if (!entry) throw new Error("file_write not registered");
    const r = (await entry.handler({ path: "note.md", content: "x" })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(r.stale_write_blocked).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("action=create 命中会话全文基线 → 透明覆盖并附 note（v33 实证修复）", async () => {
    // v33 事故：模型整文件重发刚写的文件却用 action=create 且不带 overwrite
    // → fsMgr 抛 EEXIST，模型再花一整轮改判 modify。本会话持有当前全文时
    // create 语义等同 modify（hermes write_file 的「存在则覆盖」）。
    const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(fsBase, p));
    const seen: Array<{ op: string; path: string; overwrite: boolean }> = [];
    const realFsMgr = {
      createFile: async (p: string, c: string, overwrite: boolean) => {
        const file = abs(p);
        if (!overwrite && fs.existsSync(file)) {
          throw new Error(`EEXIST: file already exists, open '${file}'`);
        }
        seen.push({ op: "create", path: file, overwrite });
        fs.writeFileSync(file, c, "utf-8");
        return { path: p, size: c.length, created: true };
      },
      modifyFile: async (p: string, c: string) => {
        const file = abs(p);
        seen.push({ op: "modify", path: file, overwrite: false });
        fs.writeFileSync(file, c, "utf-8");
        return { path: p, size: c.length };
      },
      readFile: async () => "",
      deleteFile: async () => undefined,
      listAll: () => [],
      operateAbsolute: async (p: string, c: string, mode: string, overwrite: boolean) => {
        const file = abs(p);
        if (!overwrite && mode === "create" && fs.existsSync(file)) {
          throw new Error(`EEXIST: file already exists, open '${file}'`);
        }
        seen.push({ op: String(mode), path: file, overwrite });
        fs.writeFileSync(file, c, "utf-8");
        return { path: p, size: c.length, created: true };
      },
      deleteFileAbsolute: async () => undefined,
    };
    const { registry } = mountTools(fsBase, throwingRecovery(), realFsMgr);
    const entry = registry.get("file_write");
    if (!entry) throw new Error("file_write not registered");
    const target = path.join(fsBase, "data", "workspace", "rewrite.md");
    // 第一次：建文件并登记全文基线
    const r1 = (await entry.handler({ action: "create", path: target, content: "v1\n" })) as Record<string, unknown>;
    expect(r1.success).not.toBe(false);
    // 第二次：同一会话整文件重发（模型漏写 overwrite），不得 EEXIST 报废
    const r2 = (await entry.handler({ action: "create", path: target, content: "v2\n" })) as Record<string, unknown>;
    expect(r2.success).not.toBe(false);
    expect(typeof r2.note).toBe("string");
    expect(fs.readFileSync(target, "utf-8")).toBe("v2\n");
    expect(seen.map((s) => s.op)).toEqual(["create", "create"]);
    expect(seen[1].overwrite).toBe(true);
  });

  it("auto 显式取值与缺省等价", async () => {
    const spy = spyFsMgr();
    const { registry } = mountTools(fsBase, throwingRecovery(), spy.fsMgr);
    const entry = registry.get("file_write");
    if (!entry) throw new Error("file_write not registered");
    const r = (await entry.handler({ action: "AUTO", path: "auto.md", content: "x" })) as Record<string, unknown>;
    expect(r.success).not.toBe(false);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].startsWith("create:")).toBe(true);
  });
});

describe("file_list × 目录不存在（v33 实证：探测不是失败）", () => {
  let tmp: string;
  let fsBase: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-fttools-list-"));
    fsBase = tmp;
    fs.mkdirSync(path.join(fsBase, "data", "workspace"), { recursive: true });
    setActiveSecurityLevel("normal");
  });

  afterEach(() => {
    resetActiveSecurityLevel();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  });

  it("目录缺失 → 空列表 + exists:false + 提示，而不是 ENOENT 失败", async () => {
    const { registry } = mountTools(fsBase, throwingRecovery());
    const entry = registry.get("file_list");
    if (!entry) throw new Error("file_list not registered");
    const r = (await entry.handler({ path: "not-yet-created" })) as Record<string, unknown>;
    expect(r.success).not.toBe(false);
    expect(r.exists).toBe(false);
    expect(r.files).toEqual([]);
    expect(r.dirs).toEqual([]);
    expect(String(r.hint)).toContain("file_write");
  });

  it("目录存在 → 正常列出（回归：不得被存在性预检短路）", async () => {
    fs.mkdirSync(path.join(fsBase, "data", "workspace", "exists-dir"), { recursive: true });
    fs.writeFileSync(path.join(fsBase, "data", "workspace", "exists-dir", "a.txt"), "x", "utf-8");
    const { registry } = mountTools(fsBase, throwingRecovery());
    const entry = registry.get("file_list");
    if (!entry) throw new Error("file_list not registered");
    const r = (await entry.handler({ path: "exists-dir" })) as Record<string, unknown>;
    expect(r.exists).not.toBe(false);
  });
});
