import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { resetActiveSecurityLevel } from "@evoclaw/security";
import { FileStateRegistry, ReadTracker } from "@evoclaw/agent";
import { registerFileTools } from "../src/tools/file-tools";

/**
 * R11-1 文件编辑三件套回归测试（GAP-5 stale 阻断 + GAP-6 读追踪 + GAP-7 edit）。
 *
 * 场景全部走真实磁盘临时目录（与 workspace-resolution.test.ts 同模式），
 * FileStateRegistry / ReadTracker 用真实单例（beforeEach reset）。
 */

interface Registered {
  name: string;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
  definition?: Record<string, unknown>;
}

/** 真实磁盘 fsMgr 桩：与 FileSystemManager 的相对路径语义一致（相对 fsBase）。 */
function realDiskFsMgr(fsBase: string) {
  const full = (p: string) => path.resolve(fsBase, p);
  return {
    createFile: async (p: string, c: string, overwrite?: boolean) => {
      const f = full(p);
      if (fs.existsSync(f) && !overwrite) throw new Error(`EEXIST: ${f}`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, c, "utf-8");
      return { path: f, size: Buffer.byteLength(c), created: true };
    },
    modifyFile: async (p: string, c: string) => {
      const f = full(p);
      if (!fs.existsSync(f)) throw new Error(`ENOENT: no such file, open '${f}'`);
      fs.writeFileSync(f, c, "utf-8");
      return { path: f, size: Buffer.byteLength(c), modified: true };
    },
    deleteFile: async (p: string) => {
      fs.unlinkSync(full(p));
    },
    readFile: async (p: string) => {
      return fs.readFileSync(full(p), "utf-8");
    },
    listAll: () => [],
    operateAbsolute: async (p: string, c: string, mode: string, overwrite?: boolean) => {
      if (mode === "create") {
        if (fs.existsSync(p) && !overwrite) throw new Error(`EEXIST: ${p}`);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, c, "utf-8");
      } else {
        if (!fs.existsSync(p)) throw new Error(`ENOENT: no such file, open '${p}'`);
        fs.writeFileSync(p, c, "utf-8");
      }
      return { path: p, size: Buffer.byteLength(c) };
    },
    deleteFileAbsolute: async (p: string) => {
      fs.unlinkSync(p);
    },
  };
}

function mountTools(fsBase: string, workspace: string) {
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
  const errRecovery = {
    executeWithRetry: async (_o: string, _t: string, fn: () => Promise<unknown>) => fn(),
  } as never;
  registerFileTools(
    executor,
    permissionManager,
    undefined,
    errRecovery,
    realDiskFsMgr(fsBase),
    fsBase,
    workspace,
  );
  return registry;
}

describe("file_write action=edit — 精确编辑三件套（R11 GAP-7）", () => {
  let tmp: string;
  let fsBase: string;
  let workspace: string;
  let registry: Map<string, Registered>;

  beforeEach(() => {
    ReadTracker.resetInstance();
    FileStateRegistry.resetInstance();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-edit-"));
    fsBase = tmp;
    workspace = path.join(tmp, "data", "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    registry = mountTools(fsBase, workspace);
  });

  afterEach(() => {
    resetActiveSecurityLevel();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const fw = () => registry.get("file_write")!;
  const fr = () => registry.get("file_read")!;

  /** 建会话上下文（file-tools 用 getCurrentToolCallContext()?.sessionId ?? "default"） */
  const runWrite = (p: Record<string, unknown>) => fw().handler(p);
  const runRead = (p: Record<string, unknown>) => fr().handler(p);

  it("exact 策略：单行替换成功，只改动目标段", async () => {
    const f = path.join(workspace, "app.py");
    fs.writeFileSync(f, "line1\nline2\nline3\n", "utf-8");
    const r = (await runWrite({
      action: "edit", path: "app.py",
      old_string: "line2", new_string: "line2-changed",
    })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(fs.readFileSync(f, "utf-8")).toBe("line1\nline2-changed\nline3\n");
    expect(r.strategy).toBe("exact");
    expect(r.matchCount).toBe(1);
    expect(r.size).toBeGreaterThan(0);
  });

  it("非 exact 策略：多空白折叠被 whitespace_normalized 命中", async () => {
    const f = path.join(workspace, "app.py");
    fs.writeFileSync(f, "def f():\n    return  1\n", "utf-8"); // 两个空格
    const r = (await runWrite({
      action: "edit", path: "app.py",
      old_string: "return 1",   // 单空格
      new_string: "return 2",
    })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(r.strategy).not.toBeNull(); // 任一非 exact 策略命中（whitespace/indentation/context_aware 均可）
    expect(fs.readFileSync(f, "utf-8")).toBe("def f():\n    return 2\n");
  });

  it("多匹配且未 replace_all → 报错不落盘", async () => {
    const f = path.join(workspace, "dup.txt");
    fs.writeFileSync(f, "x\nx\n", "utf-8");
    const r = (await runWrite({
      action: "edit", path: "dup.txt",
      old_string: "x", new_string: "y",
    })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("匹配");
    expect(fs.readFileSync(f, "utf-8")).toBe("x\nx\n");
  });

  it("replace_all=true → 全部替换", async () => {
    const f = path.join(workspace, "dup.txt");
    fs.writeFileSync(f, "x\nx\n", "utf-8");
    const r = (await runWrite({
      action: "edit", path: "dup.txt",
      old_string: "x", new_string: "y", replace_all: true,
    })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(fs.readFileSync(f, "utf-8")).toBe("y\ny\n");
    expect(r.matchCount).toBe(2);
  });

  it("old_string 缺失 → 明确报错不落盘", async () => {
    const r = (await runWrite({ action: "edit", path: "a.txt", new_string: "y" })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("old_string");
  });

  it("new_string 缺失 → 明确报错", async () => {
    fs.writeFileSync(path.join(workspace, "a.txt"), "old text\n", "utf-8");
    const r = (await runWrite({ action: "edit", path: "a.txt", old_string: "old" })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("new_string");
  });

  it("删除场景：new_string 为空串 → 内容被删除", async () => {
    const f = path.join(workspace, "del.txt");
    fs.writeFileSync(f, "keep\nremove-me\nkeep2\n", "utf-8");
    const r = (await runWrite({
      action: "edit", path: "del.txt",
      old_string: "remove-me\n", new_string: "",
    })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(fs.readFileSync(f, "utf-8")).toBe("keep\nkeep2\n");
  });

  it("escape-drift 纠正：\\' 伪影被剥掉且结果附 note", async () => {
    const f = path.join(workspace, "q.py");
    fs.writeFileSync(f, "s = 'it works'\n", "utf-8");
    const r = (await runWrite({
      action: "edit", path: "q.py",
      old_string: "s = \\'it works\\'",
      new_string: "s = \\'it fails\\'",
    })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(fs.readFileSync(f, "utf-8")).toBe("s = 'it fails'\n");
    expect(String(r.note)).toContain("escape-drift");
  });

  it("CRLF 文件：替换后行尾保持 CRLF", async () => {
    const f = path.join(workspace, "crlf.txt");
    fs.writeFileSync(f, "a\r\nb\r\nc\r\n", "utf-8");
    const r = (await runWrite({
      action: "edit", path: "crlf.txt",
      old_string: "b", new_string: "B2",
    })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    // 单行替换不引入 \n，文件行尾不变
    expect(fs.readFileSync(f, "utf-8")).toBe("a\r\nB2\r\nc\r\n");
  });

  it("CRLF 文件 + 多行 new_string（LF 行尾）→ 归一为 CRLF", async () => {
    const f = path.join(workspace, "crlf2.txt");
    fs.writeFileSync(f, "a\r\nb\r\nc\r\n", "utf-8");
    const r = (await runWrite({
      action: "edit", path: "crlf2.txt",
      old_string: "a\r\nb", new_string: "x\ny",
    })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(fs.readFileSync(f, "utf-8")).toBe("x\r\ny\r\nc\r\n");
  });

  it("文件不存在 → ENOENT 兜底带 hint", async () => {
    const r = (await runWrite({
      action: "edit", path: "nope.txt",
      old_string: "a", new_string: "b",
    })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(String(r.hint)).toContain("file_read");
  });

  it("连续 3 次未命中 → 提示升级（停止变体重试）", async () => {
    fs.writeFileSync(path.join(workspace, "esc.txt"), "real content\n", "utf-8");
    for (let i = 0; i < 3; i++) {
      const r = (await runWrite({
        action: "edit", path: "esc.txt",
        old_string: `wrong-guess-${i}`, new_string: "x",
      })) as Record<string, unknown>;
      expect(r.success).toBe(false);
      if (i === 2) {
        expect(String(r.error)).toContain("连续 3 次");
      }
    }
  });
});

describe("stale 阻断 — 整文件覆盖守卫（R11 GAP-5）", () => {
  let tmp: string;
  let fsBase: string;
  let workspace: string;
  let registry: Map<string, Registered>;

  beforeEach(() => {
    ReadTracker.resetInstance();
    FileStateRegistry.resetInstance();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-stale-"));
    fsBase = tmp;
    workspace = path.join(tmp, "data", "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    registry = mountTools(fsBase, workspace);
  });

  afterEach(() => {
    resetActiveSecurityLevel();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const fw = () => registry.get("file_write")!;
  const fr = () => registry.get("file_read")!;

  it("从未读过的已存在文件 → modify 被拒并引导（stale_write_blocked）", async () => {
    const f = path.join(workspace, "existing.txt");
    fs.writeFileSync(f, "precious content\n", "utf-8");
    const r = (await fw().handler({ action: "modify", path: "existing.txt", content: "clobber!" })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(r.stale_write_blocked).toBe(true);
    expect(String(r.error)).toContain("full current content");
    expect(fs.readFileSync(f, "utf-8")).toBe("precious content\n");
  });

  it("全文读过 → modify 放行", async () => {
    const f = path.join(workspace, "read.txt");
    fs.writeFileSync(f, "full view\n", "utf-8");
    const rd = (await fr().handler({ path: "read.txt" })) as Record<string, unknown>;
    expect(rd.content).toBe("full view\n");
    const r = (await fw().handler({ action: "modify", path: "read.txt", content: "new full content" })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(fs.readFileSync(f, "utf-8")).toBe("new full content");
  });

  it("只读过部分（分页未到末行）→ modify 被拒", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n");
    fs.writeFileSync(path.join(workspace, "big.txt"), lines, "utf-8");
    await fr().handler({ path: "big.txt", offset: "1", limit: "10" });
    const r = (await fw().handler({ action: "modify", path: "big.txt", content: "clobber" })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(r.stale_write_blocked).toBe(true);
  });

  it("分页读完整个文件 → modify 放行（覆盖账合并）", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
    fs.writeFileSync(path.join(workspace, "paged.txt"), lines, "utf-8");
    await fr().handler({ path: "paged.txt", offset: "1", limit: "10" });
    await fr().handler({ path: "paged.txt", offset: "11", limit: "10" });
    const r = (await fw().handler({ action: "modify", path: "paged.txt", content: lines.replace("line1", "LINE1") })) as Record<string, unknown>;
    expect(r.success).toBe(true);
  });

  it("外部修改后（mtime/hash 变）→ 已读过也拒", async () => {
    const f = path.join(workspace, "ext.txt");
    fs.writeFileSync(f, "v1\n", "utf-8");
    await fr().handler({ path: "ext.txt" });
    // 模拟外部修改：直接绕过工具写文件
    fs.writeFileSync(f, "v2 external\n", "utf-8");
    const r = (await fw().handler({ action: "modify", path: "ext.txt", content: "clobber" })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(r.stale_write_blocked).toBe(true);
  });

  it("连续 modify 自放行（第一次 modify 后基线刷新）", async () => {
    const f = path.join(workspace, "chain.txt");
    fs.writeFileSync(f, "v1\n", "utf-8");
    await fr().handler({ path: "chain.txt" });
    const r1 = (await fw().handler({ action: "modify", path: "chain.txt", content: "v2" })) as Record<string, unknown>;
    expect(r1.success).toBe(true);
    const r2 = (await fw().handler({ action: "modify", path: "chain.txt", content: "v3" })) as Record<string, unknown>;
    expect(r2.success).toBe(true);
    const r3 = (await fw().handler({ action: "modify", path: "chain.txt", content: "v4" })) as Record<string, unknown>;
    expect(r3.success).toBe(true);
    expect(fs.readFileSync(f, "utf-8")).toBe("v4");
  });

  it("create 不拦（net-new 与 overwrite=true 均不受基线约束）", async () => {
    const f = path.join(workspace, "fresh.txt");
    const r = (await fw().handler({ action: "create", path: "fresh.txt", content: "new" })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    void f;
  });

  // ★ v26 实证（T4 R14 / T7 R11）：同一会话 create 成功后紧接 modify 必须放行。
  //   旧实现 create 不登记全文基线，modify 被「没读过全文」守卫拒绝，
  //   模型被迫先 file_read 整个文件再重试，白烧一轮。
  it("create 后同一会话 modify 放行（create 登记全文基线）", async () => {
    const f = path.join(workspace, "created-then-modify.txt");
    const r1 = (await fw().handler({ action: "create", path: "created-then-modify.txt", content: "v1" })) as Record<string, unknown>;
    expect(r1.success).toBe(true);
    const r2 = (await fw().handler({ action: "modify", path: "created-then-modify.txt", content: "v2" })) as Record<string, unknown>;
    expect(r2.success).toBe(true);
    expect(fs.readFileSync(f, "utf-8")).toBe("v2");
  });

  // ★ v26 T9 实证：模型一度怀疑 `:`/`=`/`$` 被写入链路改写，改用
  //   String.fromCharCode 绕行。实测是它自己的 shell 双引号里 `$"` 被
  //   bash 当 locale 翻译吞掉（探针误报），写入链路本身必须逐字保真。
  it("write 链路对 $ : = 等特殊字符逐字保真（T9「mangling」误判回归）", async () => {
    const content = 'const COLON = ":";\nconst EQ = "=";\nconst D = "$";\nconst T = "a$b";\n';
    const r1 = (await fw().handler({ action: "create", path: "punct.txt", content })) as Record<string, unknown>;
    expect(r1.success).toBe(true);
    expect(fs.readFileSync(path.join(workspace, "punct.txt"), "utf-8")).toBe(content);
    const r2 = (await fw().handler({ action: "modify", path: "punct.txt", content: content + "$" })) as Record<string, unknown>;
    expect(r2.success).toBe(true);
    expect(fs.readFileSync(path.join(workspace, "punct.txt"), "utf-8")).toBe(content + "$");
  });

  // ★ 2026-11-21（v23 Task 5 实证）：create 撞已有文件是确定性失败，必须给
  //   模型「下一步怎么改」的 hint，而不是只透传裸 EEXIST 让其反复试错。
  it("create 撞已有文件 → EEXIST 附三选一恢复 hint", async () => {
    const f = path.join(workspace, "exists.txt");
    fs.writeFileSync(f, "old", "utf-8");
    const r = (await fw().handler({ action: "create", path: "exists.txt", content: "new" })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("EEXIST");
    const hint = String(r.hint ?? "");
    expect(hint).toContain("action=modify");
    expect(hint).toContain("overwrite=true");
    expect(hint).toContain("action=edit");
    // 原内容未被破坏
    expect(fs.readFileSync(f, "utf-8")).toBe("old");
  });

  it("edit 不受「未全文读」阻断（hermes patch_tool 语义：old_string 命中即安全）", async () => {
    const f = path.join(workspace, "unread-edit.txt");
    fs.writeFileSync(f, "content\n", "utf-8");
    const r = (await fw().handler({
      action: "edit", path: "unread-edit.txt",
      old_string: "content", new_string: "new",
    })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(fs.readFileSync(f, "utf-8")).toBe("new\n");
  });

  it("跨会话 mtime 漂移后 edit → 成功但附 stale warning", async () => {
    const f = path.join(workspace, "drift.txt");
    fs.writeFileSync(f, "v1\n", "utf-8");
    await fr().handler({ path: "drift.txt" });
    // 外部（绕过工具）修改文件
    fs.writeFileSync(f, "v1 external change\n", "utf-8");
    const r = (await fw().handler({
      action: "edit", path: "drift.txt",
      old_string: "v1 external change", new_string: "v2",
    })) as Record<string, unknown>;
    // old_string 命中当前内容 → 放行，但带 warning
    expect(r.success).toBe(true);
    expect(String(r.warning)).toContain("modified since you last read");
    expect(fs.readFileSync(f, "utf-8")).toBe("v2\n");
  });
});

describe("读追踪 — dedup stub → BLOCK（R11 GAP-6）", () => {
  let tmp: string;
  let fsBase: string;
  let workspace: string;
  let registry: Map<string, Registered>;

  beforeEach(() => {
    ReadTracker.resetInstance();
    FileStateRegistry.resetInstance();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-dedup-"));
    fsBase = tmp;
    workspace = path.join(tmp, "data", "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    registry = mountTools(fsBase, workspace);
  });

  afterEach(() => {
    resetActiveSecurityLevel();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const fr = () => registry.get("file_read")!;
  const fw = () => registry.get("file_write")!;

  it("同 version 二次同参数读 → stub（content_returned=false）", async () => {
    fs.writeFileSync(path.join(workspace, "f.txt"), "abc\n", "utf-8");
    const r1 = (await fr().handler({ path: "f.txt" })) as Record<string, unknown>;
    expect(r1.content).toBe("abc\n");
    const r2 = (await fr().handler({ path: "f.txt" })) as Record<string, unknown>;
    expect(r2.status).toBe("unchanged");
    expect(r2.dedup).toBe(true);
    expect(r2.content_returned).toBe(false);
  });

  it("stub 后再读 → 硬 BLOCK（guardrail_refusal）", async () => {
    fs.writeFileSync(path.join(workspace, "g.txt"), "abc\n", "utf-8");
    await fr().handler({ path: "g.txt" });
    await fr().handler({ path: "g.txt" }); // stub
    const r3 = (await fr().handler({ path: "g.txt" })) as Record<string, unknown>;
    expect(r3.success).toBe(false);
    expect(r3.guardrail_refusal).toBe(true);
    expect(String(r3.error)).toContain("BLOCKED");
  });

  it("写后重读 → 回新内容（dedup 失效）", async () => {
    fs.writeFileSync(path.join(workspace, "h.txt"), "v1\n", "utf-8");
    await fr().handler({ path: "h.txt" });
    await fw().handler({ action: "modify", path: "h.txt", content: "v2\n" });
    const r = (await fr().handler({ path: "h.txt" })) as Record<string, unknown>;
    expect(r.content).toBe("v2\n");
  });

  it("16K 截断：大文件读返回截断标记，截断页不作全文证据", async () => {
    // 20000 字符
    const big = "x".repeat(20000);
    fs.writeFileSync(path.join(workspace, "big.txt"), big, "utf-8");
    const r = (await fr().handler({ path: "big.txt" })) as Record<string, unknown>;
    expect(r.truncated).toBe(true);
    expect((r.content as string).length).toBe(16000);
    expect(String(r.hint)).toContain("truncated");
    // 截断读不建全文基线 → modify 被拒
    const m = (await fw().handler({ action: "modify", path: "big.txt", content: "clobber" })) as Record<string, unknown>;
    expect(m.success).toBe(false);
    expect(m.stale_write_blocked).toBe(true);
  });

  it("不同 offset 的读不互相 stub", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join("\n");
    fs.writeFileSync(path.join(workspace, "page.txt"), lines, "utf-8");
    const r1 = (await fr().handler({ path: "page.txt", offset: "1", limit: "10" })) as Record<string, unknown>;
    expect(r1.content).toContain("L1");
    const r2 = (await fr().handler({ path: "page.txt", offset: "11", limit: "10" })) as Record<string, unknown>;
    expect(r2.content).toContain("L11");
    expect(r2.status).toBeUndefined();
  });

  it("不同会话互不干扰（sessionId 键控）", async () => {
    // 会话隔离在 handler 外层由 runWithToolCallContext 决定；handler 内无法切换
    // 上下文。此处直接验证 ReadTracker 单例语义：两 sessionId 互不 dedup。
    const rt = ReadTracker.getInstance();
    fs.writeFileSync(path.join(workspace, "s.txt"), "abc\n", "utf-8");
    await fr().handler({ path: "s.txt" }); // default 会话
    // 另一会话首读不受 default 的 dedup 影响——直接断言 tracker 状态
    expect(rt.checkBeforeRead("other-session", path.resolve(workspace, "s.txt"), rtVerdictVersion(workspace, "s.txt"), 1, undefined).action).toBe("allow");
  });
});

/** 辅助：与 file-tools.fileVersionOf 相同的 version 计算 */
function rtVerdictVersion(workspace: string, rel: string): string | null {
  const p = path.resolve(workspace, rel);
  try {
    const stat = fs.statSync(p);
    const content = fs.readFileSync(p, "utf-8");
    return `${stat.mtimeMs}:${FileStateRegistry.hashContent(content)}`;
  } catch {
    return null;
  }
}
