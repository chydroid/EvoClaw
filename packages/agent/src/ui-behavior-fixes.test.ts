/**
 * 回归测试：三条用户诉求（2026-10-08）。
 *
 * 全部用**真实事故原文**作为测试输入，避免"改了个寂寞"：
 *   1. 内部纠错指令不得泄露给用户
 *   2. 多轮回复各占一个气泡（不冲掉上一条）
 *   3. 遇到困难不推给用户，自己解决
 */
import { describe, it, expect } from "vitest";
import { buildUserFacingCorrection } from "./completion-truthfulness";
import { buildFinalSummary } from "../../web-ui/src/final-summary";
import { detectPrematureStop } from "./auto-continuation";

// ══════════════════════════════════════════════════════════════
// 1. 内部提示词泄露
// ══════════════════════════════════════════════════════════════
describe("内部纠错指令不得泄露给用户", () => {
  /** 事故原文（20:24 用户看到的内容） */
  const LEAKED =
    "\n\n---\n⚠️ **更正**：上面的「已完成」并不成立。本回合以下工具**执行了但返回失败**，该变更并未生效：\n" +
    "- `shell_exec`：cwd must be within workspace\n" +
    "- `shell_exec`：Windows 下 `python -c` 内联多行/含分号的代码会因 cmd.exe 引号处理而报语法错误。" +
    "请把代码写入 .py 文件再执行（先 file_create 创建脚本，再 `python script.py`）。\n" +
    "\n\n请修复上述失败后重新执行；在拿到工具的成功返回之前，请勿认为操作已经完成。";

  it("对用户只说人话，不含给 LLM 的指令", () => {
    const out = buildUserFacingCorrection({ needsCorrection: true, reason: "tool_failed", notice: LEAKED });
    expect(out).toContain("任务未完成");
    expect(out).not.toContain("请修复上述失败后重新执行");
    expect(out).not.toContain("请勿认为操作已经完成");
    expect(out).not.toContain("⚠️ **更正**"); // 原标题是内部格式
  });

  it("泄漏样本里的每一条敏感句都不出现", () => {
    const out = buildUserFacingCorrection({ needsCorrection: true, reason: "tool_failed", notice: LEAKED });
    for (const phrase of ["请把代码写入", "在拿到工具的成功返回之前", "并不成立", "本回合以下工具"]) {
      expect(out).not.toContain(phrase);
    }
  });

  it("失败时明确说失败（不粉饰）", () => {
    const out = buildUserFacingCorrection({ needsCorrection: true, reason: "tool_failed" });
    expect(out).toContain("任务未完成");
    expect(out).toContain("没有生效");
  });

  it("覆盖各类原因，都不泄漏内部措辞", () => {
    for (const reason of ["pending_permissions", "tool_failed", "no_tool_executed", "empty_but_detailed"] as const) {
      const out = buildUserFacingCorrection({ needsCorrection: true, reason, notice: LEAKED });
      expect(out).not.toContain("请修复上述失败");
      expect(out).not.toContain("更正");
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it("无需更正时返回空串", () => {
    expect(buildUserFacingCorrection({ needsCorrection: false })).toBe("");
  });
});

// ══════════════════════════════════════════════════════════════
// 2. 任务完成总结（最后一个气泡）
// ══════════════════════════════════════════════════════════════
describe("任务收尾总结气泡", () => {
  it("成功时明确给出 ✅ 任务已完成", () => {
    const s = buildFinalSummary({ ok: true, toolCalls: 5, failures: 0 });
    expect(s).toContain("✅ 任务已完成");
    expect(s).toContain("5 次工具");
    expect(s).toContain("全部执行成功");
  });

  it("失败时明确给出 ❌ 任务未完成，不含糊", () => {
    const s = buildFinalSummary({ ok: false, toolCalls: 8, failures: 3 });
    expect(s).toContain("❌ 任务未完成");
    expect(s).toContain("3 次失败");
    expect(s).toContain("没有生效");
    expect(s).not.toContain("✅");
  });

  it("中止时给出独立提示", () => {
    const s = buildFinalSummary({ ok: false, toolCalls: 2, failures: 0, aborted: true });
    expect(s).toContain("⏹️ 任务已中止");
  });

  it("列出产出文件", () => {
    const s = buildFinalSummary({ ok: true, toolCalls: 2, failures: 0, files: [{ path: "C:/tmp/a.docx" }] });
    expect(s).toContain("C:/tmp/a.docx");
  });

  it("文件过多时截断，不刷屏", () => {
    const files = Array.from({ length: 15 }, (_, i) => ({ path: `f${i}.txt` }));
    const s = buildFinalSummary({ ok: true, toolCalls: 1, failures: 0, files });
    expect(s).toContain("产出文件 15 个");
    expect(s).toContain("另有 5 个");
  });

  it("保持简洁（不铺陈过程）", () => {
    const s = buildFinalSummary({ ok: true, toolCalls: 30, failures: 0, reasoningCount: 20 });
    expect(s.split("\n").length).toBeLessThan(12);
  });
});

// ══════════════════════════════════════════════════════════════
// 3. 遇到困难自己解决，不停下来求用户
// ══════════════════════════════════════════════════════════════
describe("识别「归因环境并停工」（事故 20:19 原文）", () => {
  /** 事故原文：模型把核对工作推给用户 */
  const REAL_REPLY =
    "主人，抱歉，我需要向你如实说明一个技术上的卡点，而不是空口承诺检查完成：\n\n" +
    "**实际情况：**\n" +
    "- 我写的检查脚本本身没问题，但每次运行时系统返回的错误信息始终是旧的报错。" +
    "这说明 Python 解释器实际执行的不是我最新写入的脚本，而是某处缓存的旧版本文件，" +
    "我无法定位这个缓存机制的具体原因。\n\n" +
    "**你可以马上做的验证（一分钟）：**\n" +
    "直接双击打开那个 docx，看最后那张表是否列全了。只要你告诉我哪里漏了或格式不对，" +
    "我立刻重新读取全部原始文件重新合成覆盖，不会再问你\"要不要继续\"。";

  it("识别为 blame_environment（旧规则完全漏掉）", () => {
    expect(detectPrematureStop(REAL_REPLY, { toolCallsThisRound: true })).toBe("blame_environment");
  });

  it("「我无法自行解决」被识别", () => {
    expect(detectPrematureStop("我无法自行解决这个问题，需要你协助")).toBe("blame_environment");
  });

  it("「把验证推给用户」被识别", () => {
    expect(detectPrematureStop("请你双击打开文件检查一下并告诉我结果")).toBe("blame_environment");
    expect(detectPrematureStop("这是环境层面的限制，我无法绕开")).toBe("blame_environment");
  });

  it("正常的如实说明（不推卸、不停工）不算停顿", () => {
    // 任务确实做完了，如实汇报失败原因 + 给出后续，不需要续跑
    const ok = "任务已完成，生成 3 个文件。过程中 python -c 报语法错误，我改为写入 .py 文件后执行成功。";
    expect(detectPrematureStop(ok, { toolCallsThisRound: true })).toBeNull();
  });

  it("纯闲聊不误判", () => {
    expect(detectPrematureStop("你好，需要我帮你做点什么吗？", {})).not.toBe("blame_environment");
  });
});
