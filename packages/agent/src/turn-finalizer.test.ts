/**
 * Turn Finalizer 测试 —— 终末安全网的三个结构机制
 *
 * 覆盖：
 *   1. 静默停止检测器（detectSilentStop）
 *   2. 完成状态强制器（enforceCompletionStatus）
 *   3. 碎片终止守卫（detectDegenerateFinal）
 *   4. 综合终末安全网（runTurnFinalizer）
 *
 * 对标 hermes-agent turn_finalizer.py 的测试策略：
 *   - 每个机制独立测试
 *   - 边界条件测试（空回复、无工具、碎片、完成状态）
 *   - 幂等性测试（运行两次结果相同）
 */

import { describe, it, expect } from "vitest";
import {
  detectSilentStop,
  enforceCompletionStatus,
  detectDegenerateFinal,
  runTurnFinalizer,
  hasCompletionStatusReport,
  type ToolExecutionStats,
  type ConversationMessageLite,
} from "./turn-finalizer";

// ── 测试辅助 ──────────────────────────────────────────────────────────────────

function makeToolStats(overrides: Partial<ToolExecutionStats> = {}): ToolExecutionStats {
  return {
    successful: 5,
    failed: 0,
    createdFiles: [],
    modifiedFiles: [],
    executedCommands: [],
    ...overrides,
  };
}

function makeMessages(
  roles: Array<{ role: string; content?: string }>,
): Array<ConversationMessageLite> {
  return roles.map((r) => ({
    role: r.role,
    content: r.content ?? null,
  }));
}

// ── 1. 静默停止检测器 ─────────────────────────────────────────────────────────

describe("detectSilentStop", () => {
  it("检测到静默停止：工具结果结尾 + 空回复 + 执行过工具", () => {
    const messages = makeMessages([
      { role: "user", content: "分析性能" },
      { role: "assistant", content: null }, // tool_calls 在此
      { role: "tool", content: "file content..." },
      { role: "tool", content: "grep result..." },
    ]);
    const verdict = detectSilentStop(messages, "", makeToolStats({ successful: 8 }));
    expect(verdict.isSilentStop).toBe(true);
    expect(verdict.summary).toContain("任务状态汇报");
    expect(verdict.summary).toContain("8 次成功");
  });

  it("不触发：回复有实质内容", () => {
    const messages = makeMessages([
      { role: "user", content: "分析性能" },
      { role: "assistant", content: null },
      { role: "tool", content: "result..." },
    ]);
    const verdict = detectSilentStop(messages, "分析完成，以下是详细报告...", makeToolStats());
    expect(verdict.isSilentStop).toBe(false);
  });

  it("不触发：工具结果后有 assistant 文本", () => {
    const messages = makeMessages([
      { role: "user", content: "分析性能" },
      { role: "assistant", content: null },
      { role: "tool", content: "result..." },
      { role: "assistant", content: "分析完成。" },
    ]);
    const verdict = detectSilentStop(messages, "", makeToolStats());
    expect(verdict.isSilentStop).toBe(false);
  });

  it("不触发：无工具执行", () => {
    const messages = makeMessages([
      { role: "user", content: "你好" },
    ]);
    const verdict = detectSilentStop(messages, "", makeToolStats({ successful: 0 }));
    expect(verdict.isSilentStop).toBe(false);
  });

  it("不触发：不以工具结果结尾", () => {
    const messages = makeMessages([
      { role: "user", content: "分析性能" },
      { role: "assistant", content: "好的，我来分析。" },
    ]);
    const verdict = detectSilentStop(messages, "", makeToolStats());
    expect(verdict.isSilentStop).toBe(false);
  });

  it("合成摘要包含创建的文件路径", () => {
    const messages = makeMessages([
      { role: "user", content: "创建脚本" },
      { role: "tool", content: "created" },
    ]);
    const verdict = detectSilentStop(messages, "", makeToolStats({
      successful: 2,
      createdFiles: ["/tmp/test.py", "/tmp/config.json"],
    }));
    expect(verdict.isSilentStop).toBe(true);
    expect(verdict.summary).toContain("/tmp/test.py");
    expect(verdict.summary).toContain("/tmp/config.json");
  });

  it("合成摘要包含执行的命令", () => {
    const messages = makeMessages([
      { role: "user", content: "跑测试" },
      { role: "tool", content: "test output" },
    ]);
    const verdict = detectSilentStop(messages, "", makeToolStats({
      successful: 1,
      executedCommands: ["npm test", "pnpm typecheck"],
    }));
    expect(verdict.isSilentStop).toBe(true);
    expect(verdict.summary).toContain("npm test");
  });

  it("碎片回复也触发静默停止", () => {
    const messages = makeMessages([
      { role: "user", content: "分析" },
      { role: "tool", content: "result..." },
    ]);
    // "让我看看" 是碎片（≤24字符、无句末标点）
    const verdict = detectSilentStop(messages, "让我看看", makeToolStats());
    expect(verdict.isSilentStop).toBe(true);
  });
});

// ── 2. 完成状态强制器 ─────────────────────────────────────────────────────────

describe("enforceCompletionStatus", () => {
  it("追加状态块：回复无完成状态标记 + 执行过工具", () => {
    const reply = "我已经完成了分析工作。";
    const verdict = enforceCompletionStatus(reply, makeToolStats({ successful: 5 }));
    expect(verdict.appended).toBe(true);
    expect(verdict.statusBlock).toContain("任务状态");
    expect(verdict.statusBlock).toContain("5 次成功");
  });

  it("不追加：回复已包含完成状态标记", () => {
    const reply = "✅ 任务完成，交付物如下：...";
    const verdict = enforceCompletionStatus(reply, makeToolStats());
    expect(verdict.appended).toBe(false);
  });

  it("不追加：无工具执行", () => {
    const reply = "你好，有什么可以帮你的吗？";
    const verdict = enforceCompletionStatus(reply, makeToolStats({ successful: 0 }));
    expect(verdict.appended).toBe(false);
  });

  it("不追加：空回复（由静默停止检测器处理）", () => {
    const verdict = enforceCompletionStatus("", makeToolStats({ successful: 5 }));
    expect(verdict.appended).toBe(false);
  });

  it("状态块包含创建的文件路径", () => {
    const reply = "工作已完成。";
    const verdict = enforceCompletionStatus(reply, makeToolStats({
      successful: 3,
      createdFiles: ["/tmp/output.csv", "/tmp/report.md"],
    }));
    expect(verdict.appended).toBe(true);
    expect(verdict.statusBlock).toContain("/tmp/output.csv");
    expect(verdict.statusBlock).toContain("/tmp/report.md");
  });

  it("状态块包含修改的文件路径", () => {
    const reply = "修改完毕。";
    const verdict = enforceCompletionStatus(reply, makeToolStats({
      successful: 2,
      modifiedFiles: ["/tmp/config.ts", "/tmp/utils.ts"],
    }));
    expect(verdict.appended).toBe(true);
    expect(verdict.statusBlock).toContain("修改文件");
    expect(verdict.statusBlock).toContain("/tmp/config.ts");
  });

  it("状态块标记为 ✅ 已完成", () => {
    const reply = "执行了操作。";
    const verdict = enforceCompletionStatus(reply, makeToolStats({ successful: 10 }));
    expect(verdict.appended).toBe(true);
    expect(verdict.statusBlock).toContain("✅ 已完成");
    expect(verdict.statusBlock).toContain("10 次工具调用");
  });
});

describe("hasCompletionStatusReport", () => {
  it("检测 ✅ 完成标记", () => {
    expect(hasCompletionStatusReport("✅ 任务完成")).toBe(true);
  });

  it("检测 🔄 进行中标记", () => {
    expect(hasCompletionStatusReport("🔄 进行中...")).toBe(true);
  });

  it("检测 ❌ 未完成标记", () => {
    expect(hasCompletionStatusReport("❌ 未完成")).toBe(true);
  });

  it("检测交付物关键词", () => {
    expect(hasCompletionStatusReport("交付物：文件 A、文件 B")).toBe(true);
  });

  it("检测剩余工作关键词", () => {
    expect(hasCompletionStatusReport("剩余工作：测试")).toBe(true);
  });

  it("无标记返回 false", () => {
    expect(hasCompletionStatusReport("我已经完成了分析工作。")).toBe(false);
  });
});

// ── 3. 碎片终止守卫 ───────────────────────────────────────────────────────────

describe("detectDegenerateFinal", () => {
  it("检测碎片终止：碎片 + 工具工作", () => {
    const verdict = detectDegenerateFinal("让我看看", makeToolStats({ successful: 3 }), 0);
    expect(verdict.isDegenerate).toBe(true);
    expect(verdict.nudge).toContain("完成状态");
  });

  it("不触发：实质回复", () => {
    const verdict = detectDegenerateFinal("分析完成，以下是详细报告。", makeToolStats(), 0);
    expect(verdict.isDegenerate).toBe(false);
  });

  it("不触发：碎片是完成状态汇报", () => {
    const verdict = detectDegenerateFinal("✅ 完成", makeToolStats({ successful: 3 }), 0);
    expect(verdict.isDegenerate).toBe(false);
  });

  it("不触发：无工具执行", () => {
    const verdict = detectDegenerateFinal("好的", makeToolStats({ successful: 0 }), 0);
    expect(verdict.isDegenerate).toBe(false);
  });

  it("不触发：nudge 次数耗尽", () => {
    const verdict = detectDegenerateFinal("让我看看", makeToolStats({ successful: 3 }), 2, 2);
    expect(verdict.isDegenerate).toBe(false);
  });

  it("带句末标点的碎片不触发", () => {
    const verdict = detectDegenerateFinal("完成了。", makeToolStats({ successful: 3 }), 0);
    expect(verdict.isDegenerate).toBe(false);
  });
});

// ── 4. 综合终末安全网 ──────────────────────────────────────────────────────────

describe("runTurnFinalizer", () => {
  it("静默停止 → 合成状态摘要", () => {
    const messages = makeMessages([
      { role: "user", content: "分析性能" },
      { role: "tool", content: "result..." },
    ]);
    const result = runTurnFinalizer("", messages, makeToolStats({ successful: 5 }));
    expect(result.silentStopSynthesized).toBe(true);
    expect(result.finalReply).toContain("任务状态汇报");
  });

  it("完成状态缺失 → 追加状态块", () => {
    const messages = makeMessages([
      { role: "user", content: "创建脚本" },
      { role: "assistant", content: "已完成。" },
    ]);
    const result = runTurnFinalizer("已完成。", messages, makeToolStats({ successful: 3 }));
    expect(result.completionStatusAppended).toBe(true);
    expect(result.finalReply).toContain("任务状态");
  });

  it("静默停止优先于完成状态强制", () => {
    const messages = makeMessages([
      { role: "user", content: "分析" },
      { role: "tool", content: "result..." },
    ]);
    const result = runTurnFinalizer("", messages, makeToolStats({ successful: 5 }));
    // 静默停止合成后，回复已包含状态汇报 → 不再追加状态块
    expect(result.silentStopSynthesized).toBe(true);
    expect(result.finalReply).toContain("任务状态汇报");
  });

  it("幂等：运行两次结果相同", () => {
    const messages = makeMessages([
      { role: "user", content: "创建脚本" },
      { role: "assistant", content: "工作完成。" },
    ]);
    const toolStats = makeToolStats({ successful: 3 });
    const result1 = runTurnFinalizer("工作完成。", messages, toolStats);
    const result2 = runTurnFinalizer(result1.finalReply, messages, toolStats);
    // 第一次追加了状态块，第二次检测到已包含完成状态 → 不再追加
    expect(result1.completionStatusAppended).toBe(true);
    expect(result2.completionStatusAppended).toBe(false);
    // 但回复内容相同（因为状态块已包含完成状态标记）
    expect(result2.finalReply).toBe(result1.finalReply);
  });

  it("不修改无工具的回复", () => {
    const messages = makeMessages([
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好！有什么可以帮你的吗？" },
    ]);
    const result = runTurnFinalizer("你好！有什么可以帮你的吗？", messages, makeToolStats({ successful: 0 }));
    expect(result.finalReply).toBe("你好！有什么可以帮你的吗？");
    expect(result.silentStopSynthesized).toBe(false);
    expect(result.completionStatusAppended).toBe(false);
  });

  it("碎片终止 + 工具工作 → 追加状态块", () => {
    const messages = makeMessages([
      { role: "user", content: "分析" },
      { role: "assistant", content: null },
      { role: "tool", content: "result..." },
      { role: "assistant", content: "让我看看" },
    ]);
    const result = runTurnFinalizer("让我看看", messages, makeToolStats({ successful: 5 }));
    // 碎片终止检测到后，shouldContinue=true，跳过完成状态强制
    // 但由于在 turn 末尾无法续跑，finalReply 保持原样
    expect(result.degenerateFinalDetected).toBe(true);
  });

  it("空回复 + 无工具 → 不触发任何机制", () => {
    const messages = makeMessages([
      { role: "user", content: "你好" },
    ]);
    const result = runTurnFinalizer("", messages, makeToolStats({ successful: 0 }));
    expect(result.silentStopSynthesized).toBe(false);
    expect(result.completionStatusAppended).toBe(false);
    expect(result.degenerateFinalDetected).toBe(false);
  });

  it("已包含完成状态 → 不追加", () => {
    const messages = makeMessages([
      { role: "user", content: "创建脚本" },
      { role: "assistant", content: "✅ 任务完成，交付物如下..." },
    ]);
    const result = runTurnFinalizer("✅ 任务完成，交付物如下...", messages, makeToolStats({ successful: 5 }));
    expect(result.completionStatusAppended).toBe(false);
    expect(result.finalReply).toBe("✅ 任务完成，交付物如下...");
  });

  it("合成摘要包含失败的工具调用数", () => {
    const messages = makeMessages([
      { role: "user", content: "测试" },
      { role: "tool", content: "error..." },
    ]);
    const result = runTurnFinalizer("", messages, makeToolStats({
      successful: 3,
      failed: 2,
    }));
    expect(result.silentStopSynthesized).toBe(true);
    expect(result.finalReply).toContain("3 次成功");
    expect(result.finalReply).toContain("2 次失败");
  });
});
