/**
 * 复合工具 `action` 判别字段不再声明必填（2026-11-26 失败会话取证）。
 *
 * 事故：v32-t7 第 5 轮模型调用 apply_patch 时省略 action（补丁正文里已写明要改什么），
 * 参数校验层直接拒绝：`Missing required parameter "action" for tool "apply_patch"`。
 * 而每个 handler 第一行就是 `String(params.action || "<默认>")`——默认值早就存在，
 * 声明 required 只制造了一整轮空转（v33-t2 / v33-t10 / v32-t1 的 file_write 同源）。
 *
 * 对齐 hermes：`_handle_patch` 在 `mode` 缺省时默认 `replace`，schema 从不把判别字段
 * 标成必填（tools/file_tools.py WRITE_FILE_SCHEMA 只有 path + content 必填）。
 *
 * 本测试守住整类：任何注册为「复合工具」（有 action 判别 + handler 有默认值）的工具，
 * 其 schema 必须 required:false 且 default 落在 enum 内，并且校验层放行省略 action。
 */
import { describe, it, expect, afterAll } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { setWorkspaceDir, clearWorkspaceOverride } from "@evoclaw/core";
import { validateToolParams } from "../../../packages/agent/src/llm-caller";
import { registerCodeIntelTools } from "../src/tools/code-intelligence-tools";

interface Def {
  name: string;
  parameters: Record<string, { type?: string; required?: boolean; default?: unknown; enum?: unknown[] }>;
}

function mountCodeIntel(fsBase: string): Map<string, { definition: Def; handler: (p: Record<string, unknown>) => Promise<unknown> }> {
  const registry = new Map<string, { definition: Def; handler: (p: Record<string, unknown>) => Promise<unknown> }>();
  const executor = {
    registerTool(name: string, def: Def, handler: (p: Record<string, unknown>) => Promise<unknown>) {
      registry.set(name, { definition: def, handler });
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

describe("复合工具 action 判别字段：省略即用默认（对齐 hermes）", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-actdef-"));
  const workspace = path.join(repoRoot, "data", "workspace");
  const registry = (() => {
    fs.mkdirSync(workspace, { recursive: true });
    setWorkspaceDir(workspace);
    return mountCodeIntel(repoRoot);
  })();

  afterAll(() => {
    clearWorkspaceOverride();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("★ apply_patch：action 非必填且默认 patch（v32-t7 R5 实证）", () => {
    const def = registry.get("apply_patch")!.definition;
    const action = def.parameters.action;
    expect(action.required).toBe(false);
    expect(action.default).toBe("patch");
    expect(action.enum).toContain("patch");
  });

  it("★ apply_patch：省略 action 时校验层放行（不再 Missing required parameter）", () => {
    const def = registry.get("apply_patch")!.definition;
    expect(validateToolParams("apply_patch", { patch: "*** Begin Patch\n*** End Patch" }, { parameters: def.parameters })).toBeNull();
  });

  it("★ apply_patch：省略 action 实际走 patch 分支", async () => {
    const target = path.join(workspace, "auto.txt");
    fs.writeFileSync(target, "old\n", "utf-8");
    const r = (await registry.get("apply_patch")!.handler({
      patch: `<<<<<<< SEARCH auto.txt\nold\n=======\nnew\n>>>>>>> REPLACE\n`,
    })) as Record<string, unknown>;
    expect(r.success).not.toBe(false);
    expect(fs.readFileSync(target, "utf-8")).toBe("new\n");
  });

  it("★ git / code_search 同样不把 action 标为必填", () => {
    for (const name of ["git", "code_search"]) {
      const action = registry.get(name)!.definition.parameters.action;
      expect(action.required, `${name}.action`).toBe(false);
      expect(action.default, `${name}.action`).toBeDefined();
      expect(action.enum, `${name}.action`).toContain(action.default);
    }
  });

  it("每个 action 的默认值都在 enum 内（防止发明不存在的取值）", () => {
    for (const [name, { definition }] of registry) {
      const action = definition.parameters.action;
      if (!action || action.required !== false || action.default === undefined) continue;
      expect(action.enum, `${name}.action 默认值必须在 enum 内`).toContain(action.default);
    }
  });
});

describe("复合工具 action 契约（全仓静态检查）", () => {
  it("★ 所有 action 判别字段 required:true 的复合工具，handler 必须没有默认值", () => {
    // 静态扫描：action schema 声明 required:true，且 handler 首行有
    // `params.action || "<默认>"` → 自相矛盾（校验层拒掉，handler 却准备好了默认值）。
    const toolsDir = path.resolve(__dirname, "..", "src", "tools");
    const offenders: string[] = [];
    for (const file of fs.readdirSync(toolsDir).filter((f) => f.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(toolsDir, file), "utf-8");
      const actionRe = /action:\s*\{([^{}]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = actionRe.exec(src)) !== null) {
        if (!/required:\s*true/.test(m[1])) continue;
        const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 6000);
        if (/params\.action\s*\|\|\s*"[a-z_]+"/.test(tail)) {
          offenders.push(`${file}: action required:true 但 handler 有默认值`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
