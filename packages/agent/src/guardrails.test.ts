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

  it("shell_exec 里 echo '---' 输出分隔线不被误拦（2026-10-16 实例任务复盘）", () => {
    // `'\s*--` 旧版命中 `echo '---'`（单引号后紧跟破折号串）；真注入 `admin'--`
    // 的特征是 `--` 后不再是破折号/引号/单词，负向前瞻已区分两者。
    const ok = mgr.checkToolCall("shell_exec", {
      command: "ls -la /home/chy/test/ 2>&1; echo '---'; ls /home/chy/EvoClaw/data/workspace/inst_eval2/",
    });
    expect(ok.passed).toBe(true);

    const ok2 = mgr.checkToolCall("shell_exec", {
      command: "echo '---' && df -h",
    });
    expect(ok2.passed).toBe(true);

    // 真注释注入（`'--` 后跟空格收尾）仍拦
    const bad = mgr.checkToolCall("shell_exec", {
      command: `mysql -e "SELECT 1 WHERE name = 'admin' -- "`,
    });
    expect(bad.passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 提权规则回归（2026-10-16 实例任务 worktemp.zip 汇总）：
// 旧 argPattern 含裸 `admin|root|elevated` 子串匹配，把合法 Python
// heredoc 里的 `root = ET.fromstring(...)`（变量名 root）判成提权并
// block，模型被迫改走 file_create 绕路。收窄后：变量名不命中，
// 真提权（sudo/su root/runas）仍拦。
// ═══════════════════════════════════════════════════════════
describe("guardrails tool-privilege-sudo（回归）", () => {
  const mgr = new GuardrailsManager();

  it("合法 Python heredoc（变量名 root）不被误拦", () => {
    const cmd =
      "cat > extract.py << 'EOF'\nimport xml.etree.ElementTree as ET\nroot = ET.fromstring(xml)\nbody = root.find('w:body', NS)\nEOF\npython3 extract.py";
    const r = mgr.checkToolCall("shell_exec", { command: cmd });
    expect(r.passed).toBe(true);
    expect(r.triggeredRules).not.toContain("tool-privilege-sudo");
  });

  it("sudo 调用仍被硬拦", () => {
    const r = mgr.checkToolCall("shell_exec", { command: "sudo rm -rf /tmp/x" });
    expect(r.passed).toBe(false);
    expect(r.triggeredRules).toContain("tool-privilege-sudo");
  });

  it("su root / runas 仍被硬拦", () => {
    expect(mgr.checkToolCall("shell_exec", { command: "su root -c id" }).passed).toBe(false);
    expect(mgr.checkToolCall("shell_exec", { command: "runas /user:admin cmd" }).passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 删除工具规则回归（2026-10-16 实例任务 worktemp.zip 汇总）：
// 旧 toolPattern 裸子串 `rm` 命中 "pe_rm_ission_status"、"con_firm"
// 家族工具名 → 查审批状态的 permission_status 被硬拦，模型失去审批
// 检查通道，任务对账为「未完成」。改为词界（lookaround）匹配后：
// permission_* 放行，真删除类工具名仍拦。
// ═══════════════════════════════════════════════════════════
describe("guardrails tool-file-deletion（回归）", () => {
  const mgr = new GuardrailsManager();

  it("permission_status / permission_confirm 不再被误拦", () => {
    expect(mgr.checkToolCall("permission_status", { requestId: "hitl-x" }).passed).toBe(true);
    expect(mgr.checkToolCall("permission_confirm", { requestId: "hitl-y" }).passed).toBe(true);
  });

  it("真删除类工具名仍被拦截", () => {
    for (const tool of ["file_delete", "memory_delete", "scheduler_delete", "rm", "truncate_file"]) {
      const r = mgr.checkToolCall(tool, { path: "x" });
      expect(r.passed).toBe(false);
      expect(r.triggeredRules).toContain("tool-file-deletion");
    }
  });
});
