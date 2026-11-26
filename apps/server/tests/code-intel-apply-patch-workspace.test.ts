import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { setWorkspaceDir, clearWorkspaceOverride } from "@evoclaw/core";
import { FileStateRegistry, ReadTracker } from "@evoclaw/agent";
import { registerCodeIntelTools } from "../src/tools/code-intelligence-tools";

/**
 * apply_patch 路径基准回归（2026-11-09，v9 P1 压测 Task 1 根因）。
 *
 * 事故：apply_patch 的相对路径此前固定以**仓库根 fsBase** 为基准解析，
 * 而模型按 shell_exec 的 cwd（data/workspace）推断相对路径，传
 * `v9-finance/process-csv.js` → 被解析到仓库根 → File not found ×3，
 * 任务收尾时语法修复未落地、报告未产出（P1 不变量门判定 regression）。
 *
 * 修复（P2 路径契约收敛的 apply_patch 侧）：相对路径改以 getWorkspaceDir()
 * 为根（与 file_write / shell_exec 同基准），支持运行时工作区切换；
 * 绝对路径经 applyPatch 的 path.resolve 原样直通，isPathSafe 仍做
 * 沙箱边界 fail-closed 校验（越界拒绝，不静默改写）。
 */

interface Registered {
  name: string;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

function mountTools(fsBase: string): Map<string, Registered> {
  const registry = new Map<string, Registered>();
  const executor = {
    registerTool(name: string, _def: unknown, handler: Registered["handler"]) {
      registry.set(name, { name, handler });
    },
  } as never;
  registerCodeIntelTools({
    executor,
    permissionManager: { isPathAutoApproved: () => true, requestPermission: () => ({ id: "p", status: "approved" as const }) } as never,
    gitOps: {} as never,
    codeIntel: {} as never,
    fsBase,
  });
  return registry;
}

function searchReplacePatch(relPath: string, search: string, replace: string): string {
  return `<<<<<<< SEARCH ${relPath}\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`;
}

describe("apply_patch × 路径契约（相对=工作区基准，绝对原样直通）", () => {
  let repoRoot: string;
  let workspace: string;
  let outside: string;
  let registry: Map<string, Registered>;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-cpt-repo-"));
    workspace = path.join(repoRoot, "data", "workspace");
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-cpt-out-"));
    fs.mkdirSync(path.join(workspace, "v9-finance"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "v9-finance", "process-csv.js"),
      "const lines = [];\nfor (const line of rl) lines.push(line);\n",
      "utf-8",
    );
    setWorkspaceDir(workspace);
    registry = mountTools(repoRoot);
  });

  afterEach(() => {
    clearWorkspaceOverride();
    try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });

  it("★ 回归：工作区相对路径按工作区根解析（不再落到仓库根）", async () => {
    const target = path.join(workspace, "v9-finance", "process-csv.js");
    // 仓库根下同名文件不存在——旧语义会 File not found
    expect(fs.existsSync(path.join(repoRoot, "v9-finance", "process-csv.js"))).toBe(false);
    const entry = registry.get("apply_patch");
    if (!entry) throw new Error("apply_patch not registered");
    const r = (await entry.handler({
      action: "patch",
      patch: searchReplacePatch("v9-finance/process-csv.js", "for (const line of rl)", "for await (const line of rl)"),
    })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toContain("for await (const line of rl)");
  });

  it("工作区内绝对路径 → 原样直通（不受基准切换影响）", async () => {
    const target = path.join(workspace, "v9-finance", "process-csv.js");
    const entry = registry.get("apply_patch")!;
    const r = (await entry.handler({
      action: "patch",
      patch: searchReplacePatch(target, "for (const line of rl)", "for await (const ln of rl)"),
    })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toContain("for await (const ln of rl)");
  });

  it("工作区外绝对路径 → fail-closed 拒绝（不静默改写）", async () => {
    const outsideFile = path.join(outside, "x.js");
    fs.writeFileSync(outsideFile, "module.exports = 1;\n", "utf-8");
    const entry = registry.get("apply_patch")!;
    const r = (await entry.handler({
      action: "patch",
      patch: searchReplacePatch(outsideFile, "module.exports = 1;", "module.exports = 2;"),
    })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(fs.readFileSync(outsideFile, "utf-8")).toBe("module.exports = 1;\n"); // 未被改写
  });

  it("运行时工作区切换后 → apply_patch 基准随动（setWorkspaceDir 生效）", async () => {
    const entry = registry.get("apply_patch")!;
    // 把「工作区」切到另一个目录（模拟 Agent 改自身源码时切到仓库根的场景）
    setWorkspaceDir(repoRoot);
    const target = path.join(workspace, "v9-finance", "process-csv.js");
    const r = (await entry.handler({
      action: "patch",
      patch: searchReplacePatch("data/workspace/v9-finance/process-csv.js", "for (const line of rl)", "for await (const row of rl)"),
    })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toContain("for await (const row of rl)");
  });

  // ★ 2026-11-26 取证（v27-t1 第 61 行）：模型按肌肉记忆发
  //   {action:"edit", path, old_string, new_string}，旧实现回「未知 apply_patch
  //   action」——参数完全够用却白烧一轮。hermes patch handler 对任何模型都同时
  //   接受 patch 文本与 replace 三件套。
  it("action=edit + path/old_string/new_string → replace 模式（等价 patch 文本）", async () => {
    const target = path.join(workspace, "v9-finance", "process-csv.js");
    const r = (await registry.get("apply_patch")!.handler({
      action: "edit",
      path: "v9-finance/process-csv.js",
      old_string: "for (const line of rl)",
      new_string: "for await (const line of rl)",
    })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toContain("for await (const line of rl)");
  });

  it("action=patch 省略 patch 但给了三件套 → 同样走 replace 模式", async () => {
    const target = path.join(workspace, "v9-finance", "process-csv.js");
    const r = (await registry.get("apply_patch")!.handler({
      path: "v9-finance/process-csv.js",
      old_string: "const lines = [];",
      new_string: "const rows = [];",
    })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toContain("const rows = [];");
  });

  it("action=edit 缺三件套 → 可执行的错误提示（指明两种用法）", async () => {
    const r = (await registry.get("apply_patch")!.handler({
      action: "edit",
      path: "v9-finance/process-csv.js",
    })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("old_string");
  });

  // ★ 2026-11-26 取证（v26-t4 / v26-t9 / v28-t4 实证）：apply_patch 写盘后
  //   不更新会话记账，同一会话紧接着的 file_write action=modify 被
  //   「was modified outside this session」/「没读过全文」误拒——文件是本会话
  //   自己刚 patch 的。修：patch 写盘回调做 recordWrite + noteWriteServed。
  it("★ patch 写盘后登记会话基线（后续 file_write action=modify 不被误拒）", async () => {
    const target = path.join(workspace, "v9-finance", "process-csv.js");
    const r = (await registry.get("apply_patch")!.handler({
      action: "patch",
      patch: searchReplacePatch("v9-finance/process-csv.js", "for (const line of rl)", "for await (const line of rl)"),
    })) as Record<string, unknown>;
    expect(r.success).toBe(true);

    // 1) 跨会话 staleness：写者自己的读戳必须已刷新
    const stale = FileStateRegistry.getInstance().checkStale("default", target);
    expect(stale.stale, `写后自查不应 stale（${stale.reason}）`).toBe(false);

    // 2) 会话内全文基线：覆盖前检查应放行
    const content = fs.readFileSync(target, "utf-8");
    const stat = fs.statSync(target);
    const version = `${stat.mtimeMs}:${FileStateRegistry.hashContent(content)}`;
    expect(
      ReadTracker.getInstance().checkOverwriteBaseline("default", target, true, version),
    ).toBeNull();
  });
});
