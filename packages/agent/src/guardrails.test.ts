import { describe, it, expect } from "vitest";
import { GuardrailsManager } from "./guardrails";

/**
 * tool-sql-injection 规则回归（2026-10-14 真实浏览器评测中发现）：
 * 旧规则对所有工具生效，且含裸 `--\s*$`（多行）——file_create 写入的
 * Python 注释分隔线 `# -----` 任何以两个以上短横线结尾的行都会被判
 * 「SQL 注入」并 block，任务直接失败。修复后：写文件工具豁免 +
 * SQL 注释注入必须紧跟引号（`'\s*--`）+ `1=1` 加词界。
 */
describe("guardrails tool-sql-injection（回归）", () => {
  const mgr = new GuardrailsManager();

  const PY_CONTENT = [
    "#!/usr/bin/env python3",
    '"""json 转 Markdown 工具"""',
    "count1 = 1",
    "",
    "# ---------------------------------------------------------------------------",
    "# json_to_markdown 单元测试",
    "# ---------------------------------------------------------------------------",
    "import json2md",
  ].join("\n");

  it("file_create 搭载 Python 注释分隔线 + count1=1 赋值不被误拦", () => {
    const r = mgr.checkToolCall("file_create", {
      path: "tools/json2md.py",
      content: PY_CONTENT,
    });
    expect(r.passed).toBe(true);
  });

  it("file_modify 写 Markdown 水平分隔线（---）不被误拦", () => {
    const r = mgr.checkToolCall("file_modify", {
      path: "docs/x.md",
      content: "# 标题\n\n---\n\n正文段落。\n",
    });
    expect(r.passed).toBe(true);
  });

  it("shell_exec 执行 SQL 注入载荷仍被拦截", () => {
    const r = mgr.checkToolCall("shell_exec", {
      command: `mysql -e "'; DROP TABLE users; --"`,
    });
    expect(r.passed).toBe(false);
    expect(r.triggeredRules).toContain("tool-sql-injection");
  });

  it("execute_code 裸赋值 count1=1 不拦；OR 1=1 天真注入仍拦", () => {
    const ok = mgr.checkToolCall("execute_code", {
      code: "count1 = 1\nprint(count1)",
    });
    expect(ok.passed).toBe(true);

    const bad = mgr.checkToolCall("execute_code", {
      code: "SELECT * FROM users WHERE id = 1 OR 1=1",
    });
    expect(bad.passed).toBe(false);
    expect(bad.triggeredRules).toContain("tool-sql-injection");
  });

  it("shell_exec 中 SQL 注释注入（admin'--）仍被拦截", () => {
    const r = mgr.checkToolCall("shell_exec", {
      command: `mysql -e "SELECT * FROM t WHERE name = 'admin'--"`,
    });
    expect(r.passed).toBe(false);
  });
});
