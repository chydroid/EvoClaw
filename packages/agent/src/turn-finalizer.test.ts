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
  isComplexWork,
  buildFileMutationFooter,
  buildVerificationFailureFooter,
  explainAbnormalExit,
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
    // 复杂任务（有文件变更）才会得到含命令明细的结构化摘要
    const verdict = detectSilentStop(messages, "", makeToolStats({
      successful: 1,
      createdFiles: ["/tmp/x.py"],
      executedCommands: ["npm test", "pnpm typecheck"],
    }));
    expect(verdict.isSilentStop).toBe(true);
    expect(verdict.summary).toContain("npm test");
  });

  it("简单任务静默停止 → 只给一句简短说明（2026-11-26 分级）", () => {
    const messages = makeMessages([
      { role: "user", content: "查股价" },
      { role: "tool", content: "quote" },
    ]);
    const verdict = detectSilentStop(messages, "", makeToolStats({ successful: 2 }));
    expect(verdict.isSilentStop).toBe(true);
    expect(verdict.summary).toContain("已处理完成");
    expect(verdict.summary).not.toContain("任务状态汇报");
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

describe("enforceCompletionStatus — 任务复杂度分级（2026-11-26 用户诉求）", () => {
  /**
   * 用户诉求：「简单任务不要任务完成的总结，只有复杂任务完成后才要总结」。
   *
   * 实证噪音：一条查股价的问答（2 次工具调用、零文件变更）在模型已给出完整
   * 回答后，仍被追加「📋 任务状态…✅ 已完成（2 次工具调用）」。
   */

  it("isComplexWork：有文件变更 → 复杂", () => {
    expect(isComplexWork(makeToolStats({ successful: 1, createdFiles: ["/tmp/a.py"] }))).toBe(true);
    expect(isComplexWork(makeToolStats({ successful: 1, modifiedFiles: ["/tmp/b.ts"] }))).toBe(true);
  });

  it("isComplexWork：有失败的文件写入 → 复杂（必须让用户知道）", () => {
    expect(isComplexWork(makeToolStats({
      successful: 1,
      failedFileMutations: [{ path: "/tmp/c.py", error: "EACCES" }],
    }))).toBe(true);
  });

  it("isComplexWork：工具调用 ≥5 → 复杂", () => {
    expect(isComplexWork(makeToolStats({ successful: 5 }))).toBe(true);
    expect(isComplexWork(makeToolStats({ successful: 4 }))).toBe(false);
    expect(isComplexWork(makeToolStats({ successful: 3, failed: 2 }))).toBe(true);
  });

  it("isComplexWork：shell 写入也算复杂（createdFiles 只跟踪 file_write）", () => {
    // 2026-11-26 实证：用 shell_exec 建 3 个文件的任务，createdFiles 为空，
    // 旧判据把它当成简单任务，得不到完成汇报。
    expect(isComplexWork(makeToolStats({ successful: 3, shellWriteOpCount: 2 }))).toBe(true);
    expect(isComplexWork(makeToolStats({ successful: 3, shellWriteOpCount: 0 }))).toBe(false);
  });

  it("isComplexWork：简单只读问答 → 不复杂", () => {
    expect(isComplexWork(makeToolStats({ successful: 2 }))).toBe(false);
    expect(isComplexWork(makeToolStats({ successful: 0 }))).toBe(false);
  });

  it("简单任务完整回答 → 不追加状态块", () => {
    const reply = "中国一重现价 2.76 元，跌 2.13%，处于 52 周区间中下段。";
    const verdict = enforceCompletionStatus(reply, makeToolStats({ successful: 2 }));
    expect(verdict.appended).toBe(false);
    expect(verdict.reason).toContain("Simple task");
  });

  it("复杂任务（有交付物）缺完成标记 → 追加状态块", () => {
    const reply = "写好了。";
    const verdict = enforceCompletionStatus(reply, makeToolStats({
      successful: 3,
      createdFiles: ["/tmp/report.md"],
    }));
    expect(verdict.appended).toBe(true);
    expect(verdict.statusBlock).toContain("任务状态");
  });

  it("复杂任务已自带完成汇报 → 不重复追加", () => {
    const reply = "✅ 任务完成。交付物：`/tmp/report.md`。";
    const verdict = enforceCompletionStatus(reply, makeToolStats({
      successful: 3,
      createdFiles: ["/tmp/report.md"],
    }));
    expect(verdict.appended).toBe(false);
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

  it("完成状态缺失 → 追加状态块（复杂任务）", () => {
    const messages = makeMessages([
      { role: "user", content: "创建脚本" },
      { role: "assistant", content: "已完成。" },
    ]);
    // 有文件变更 → 复杂任务
    const result = runTurnFinalizer("已完成。", messages, makeToolStats({
      successful: 3,
      createdFiles: ["/tmp/script.py"],
    }));
    expect(result.completionStatusAppended).toBe(true);
    expect(result.finalReply).toContain("任务状态");
  });

  it("简单任务（无文件变更、工具调用少）→ 不追加状态块（2026-11-26 分级）", () => {
    const messages = makeMessages([
      { role: "user", content: "查一下股价" },
      { role: "assistant", content: "现价 2.76 元，跌幅 2.13%。" },
    ]);
    const result = runTurnFinalizer("现价 2.76 元，跌幅 2.13%。", messages, makeToolStats({ successful: 2 }));
    expect(result.completionStatusAppended).toBe(false);
    expect(result.finalReply).toBe("现价 2.76 元，跌幅 2.13%。");
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
    // 有文件变更 → 复杂任务，才会追加状态块
    const toolStats = makeToolStats({ successful: 3, createdFiles: ["/tmp/a.py"] });
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

// ── 5. 文件变更 Footer（对标 Hermes _append_file_mutation_footer）───────────────

describe("buildFileMutationFooter", () => {
  it("追加 footer：有失败写入 + 有真实回复", () => {
    const reply = "我已经完成所有文件写入。";
    const result = buildFileMutationFooter(
      [{ path: "/tmp/test.py", error: "Permission denied" }],
      reply,
    );
    expect(result).not.toBeNull();
    expect(result).toContain("文件写入验证");
    expect(result).toContain("/tmp/test.py");
    expect(result).toContain("Permission denied");
    expect(result).toContain("未被成功写入");
  });

  it("返回 null：无失败写入", () => {
    const result = buildFileMutationFooter([], "正常回复。");
    expect(result).toBeNull();
  });

  it("返回 null：空回复", () => {
    const result = buildFileMutationFooter(
      [{ path: "/tmp/test.py", error: "Permission denied" }],
      "",
    );
    expect(result).toBeNull();
  });

  it("返回 null：仅空白字符的回复", () => {
    const result = buildFileMutationFooter(
      [{ path: "/tmp/test.py", error: "Permission denied" }],
      "   \n\n  ",
    );
    expect(result).toBeNull();
  });

  it("footer 包含多个失败路径", () => {
    const reply = "写入完成。";
    const result = buildFileMutationFooter([
      { path: "/tmp/a.py", error: "error A" },
      { path: "/tmp/b.ts", error: "error B" },
      { path: "/tmp/c.md", error: "error C" },
    ], reply);
    expect(result).toContain("/tmp/a.py");
    expect(result).toContain("/tmp/b.ts");
    expect(result).toContain("/tmp/c.md");
  });

  it("footer 截断超过 8 个失败路径", () => {
    const reply = "写入完成。";
    const mutations = Array.from({ length: 12 }, (_, i) => ({
      path: `/tmp/file${i}.py`,
      error: `error ${i}`,
    }));
    const result = buildFileMutationFooter(mutations, reply);
    expect(result).toContain("/tmp/file0.py");
    expect(result).toContain("/tmp/file7.py");
    expect(result).toContain("另有 4 个失败");
    expect(result).not.toContain("/tmp/file11.py");
  });

  it("footer 不修改原回复的前面内容", () => {
    const reply = "已完成分析工作。\n\n结论如下：xxx";
    const result = buildFileMutationFooter(
      [{ path: "/tmp/test.py", error: "Permission denied" }],
      reply,
    );
    expect(result.startsWith("已完成分析工作。\n\n结论如下：xxx")).toBe(true);
    expect(result).toContain("文件写入验证");
  });

  it("footer 中的 error 文本被截断到 80 字符", () => {
    const longError = "A".repeat(200);
    const reply = "写入完成。";
    const result = buildFileMutationFooter(
      [{ path: "/tmp/test.py", error: longError }],
      reply,
    );
    expect(result).not.toContain("A".repeat(200));
    expect(result).toContain("A".repeat(80));
  });
});

// ── 6. 异常退出说明器（对标 Hermes _explain_abnormal_exit）──────────────────────

describe("explainAbnormalExit", () => {
  it("空回复 + budget_exhausted → 返回说明文本", () => {
    const result = explainAbnormalExit("", "budget_exhausted");
    expect(result).toContain("迭代预算耗尽");
    expect(result).toContain("继续");
  });

  it("空回复 + max_iterations_reached → 返回说明文本", () => {
    const result = explainAbnormalExit("", "max_iterations_reached");
    expect(result).toContain("最大迭代轮数");
  });

  it("空回复 + session_persistence_failed → 返回说明文本", () => {
    const result = explainAbnormalExit("", "session_persistence_failed");
    expect(result).toContain("会话持久化失败");
  });

  it("空回复 + 未知原因 → 原样返回", () => {
    const result = explainAbnormalExit("", "unknown_reason");
    expect(result).toBe("");
  });

  it("(empty) 回复 + budget_exhausted → 返回说明文本", () => {
    const result = explainAbnormalExit("(empty)", "budget_exhausted");
    expect(result).toContain("迭代预算耗尽");
  });

  it("碎片回复 + budget_exhausted → 碎片 + 说明", () => {
    const result = explainAbnormalExit("让我看看", "budget_exhausted");
    expect(result).toContain("让我看看");
    expect(result).toContain("迭代预算耗尽");
  });

  it("实质回复 + budget_exhausted → 不追加说明", () => {
    const reply = "分析完成，以下是详细报告。";
    const result = explainAbnormalExit(reply, "budget_exhausted");
    expect(result).toBe(reply);
  });

  it("空回复 + guardrail_halt → 返回说明文本", () => {
    const result = explainAbnormalExit("", "guardrail_halt");
    expect(result).toContain("工具护栏拦截");
  });

  it("空回复 + content_filter → 返回说明文本", () => {
    const result = explainAbnormalExit("", "content_filter");
    expect(result).toContain("内容过滤触发");
  });

  it("空回复 + deterministic_empty → 返回说明文本", () => {
    const result = explainAbnormalExit("", "deterministic_empty");
    expect(result).toContain("确定性空响应");
  });

  it("空回复 + partial_stream_recovery → 返回说明文本", () => {
    const result = explainAbnormalExit("", "partial_stream_recovery");
    expect(result).toContain("流式响应部分恢复");
  });
});

// ── 7. 综合终末安全网 — 扩展机制测试 ────────────────────────────────────────────

describe("runTurnFinalizer — 扩展机制", () => {
  it("文件变更 footer：有失败写入 + 有真实回复 → 追加 footer", () => {
    const messages = makeMessages([
      { role: "user", content: "创建脚本" },
      { role: "assistant", content: "✅ 任务完成。" },
    ]);
    const result = runTurnFinalizer(
      "✅ 任务完成。",
      messages,
      makeToolStats({
        successful: 3,
        failedFileMutations: [{ path: "/tmp/test.py", error: "Permission denied" }],
      }),
    );
    expect(result.fileMutationFooterAppended).toBe(true);
    expect(result.finalReply).toContain("文件写入验证");
    expect(result.finalReply).toContain("/tmp/test.py");
  });

  it("文件变更 footer：无失败写入 → 不追加", () => {
    const messages = makeMessages([
      { role: "user", content: "创建脚本" },
      { role: "assistant", content: "✅ 任务完成。" },
    ]);
    const result = runTurnFinalizer(
      "✅ 任务完成。",
      messages,
      makeToolStats({ successful: 3 }),
    );
    expect(result.fileMutationFooterAppended).toBe(false);
  });

  it("异常退出说明：空回复 + budget_exhausted → 返回说明", () => {
    const messages = makeMessages([
      { role: "user", content: "分析性能" },
    ]);
    const result = runTurnFinalizer(
      "",
      messages,
      makeToolStats({ successful: 0 }),
      0,
      "budget_exhausted",
    );
    expect(result.abnormalExitExplained).toBe(true);
    expect(result.finalReply).toContain("迭代预算耗尽");
  });

  it("异常退出说明：实质回复 → 不追加", () => {
    const messages = makeMessages([
      { role: "user", content: "分析性能" },
      { role: "assistant", content: "✅ 任务完成。" },
    ]);
    const result = runTurnFinalizer(
      "✅ 任务完成。",
      messages,
      makeToolStats({ successful: 3 }),
      0,
      "budget_exhausted",
    );
    expect(result.abnormalExitExplained).toBe(false);
    expect(result.finalReply).toBe("✅ 任务完成。");
  });

  it("异常退出说明：空回复 + 未知原因 → 不追加", () => {
    const messages = makeMessages([
      { role: "user", content: "分析性能" },
    ]);
    const result = runTurnFinalizer(
      "",
      messages,
      makeToolStats({ successful: 0 }),
      0,
      "unknown_reason",
    );
    expect(result.abnormalExitExplained).toBe(false);
    expect(result.finalReply).toBe("");
  });

  it("碎片终止 + 异常退出说明：shouldContinue 跳过异常退出说明", () => {
    const messages = makeMessages([
      { role: "user", content: "分析" },
      { role: "assistant", content: null },
      { role: "tool", content: "result..." },
      { role: "assistant", content: "让我看看" },
    ]);
    const result = runTurnFinalizer(
      "让我看看",
      messages,
      makeToolStats({ successful: 5 }),
      0,
      "budget_exhausted",
    );
    // 碎片终止检测到后 shouldContinue=true，跳过异常退出说明
    expect(result.degenerateFinalDetected).toBe(true);
    expect(result.abnormalExitExplained).toBe(false);
  });

  it("文件变更 footer + 异常退出说明：两者可以同时追加", () => {
    const messages = makeMessages([
      { role: "user", content: "创建脚本" },
      { role: "assistant", content: "写入完成。" },
    ]);
    const result = runTurnFinalizer(
      "写入完成。",
      messages,
      makeToolStats({
        successful: 2,
        failedFileMutations: [{ path: "/tmp/test.py", error: "Permission denied" }],
      }),
      0,
      "",
    );
    expect(result.fileMutationFooterAppended).toBe(true);
    expect(result.finalReply).toContain("文件写入验证");
  });
});

// ── 5. v28 回归：进度报告式收尾不得被判为「✅ 已完成」 ─────────────────────────

describe("enforceCompletionStatus — 未完成自述（v28 Task 1/4 回归）", () => {
  const T1_REPLY =
    "主人，先汇报当前进度（还在进行中，还没到最后一步）：\n" +
    "**还没做**\n- README.md、真实运行 CLI 生成 report.json\n" +
    "我先把剩下的全部跑完再给你最终汇报。";

  const T4_REPLY =
    "**已交付**：multipart.py、test_multipart.py、README.md\n" +
    "**测试状态**：14/18 通过，剩余 4 个失败\n" +
    "**尚未执行**：CLI 生成 report.json\n\n" +
    "**下一步**：修正 test_multipart.py 的 body 构造，跑通 18/18 后执行 CLI。";

  it.each([["T1", T1_REPLY], ["T4", T4_REPLY]])(
    "%s 进度报告 → 状态块为 🔄 进行中（而非 ✅ 已完成）",
    (_name, reply) => {
      const verdict = enforceCompletionStatus(reply, makeToolStats({ successful: 45 }));
      expect(verdict.appended).toBe(true);
      expect(verdict.statusBlock).toContain("🔄 进行中");
      expect(verdict.statusBlock).not.toContain("✅ 已完成");
    },
  );

  it("正常完成汇报仍为 ✅ 已完成", () => {
    const verdict = enforceCompletionStatus(
      "工作已收尾，测试通过。",
      makeToolStats({ successful: 12 }),
    );
    expect(verdict.appended).toBe(true);
    expect(verdict.statusBlock).toContain("✅ 已完成");
  });
});

describe("buildVerificationFailureFooter — v28 Task 5 回归", () => {
  const FAILURE = { command: "python3 test_der.py 2>&1 | grep -E \"FAIL\"", exitCode: 1 };

  it("★ 宣称完成 + 本 turn 最后一次验证失败 → 追加失败事实", () => {
    const reply = "主人，🧬 交付状态汇报：\n**✅ 已完成** - der.py / test_der.py / README.md / report.json";
    const footer = buildVerificationFailureFooter(reply, FAILURE);
    expect(footer).toContain("⚠️ **验证未通过**");
    expect(footer).toContain("退出码 1");
    expect(footer).toContain("python3 test_der.py");
  });

  it("未宣称完成（如实报告失败）→ 不追加", () => {
    expect(buildVerificationFailureFooter("当前 15/59 项失败，仍需修复。", FAILURE)).toBeNull();
  });

  it("没有失败事件 → 不追加", () => {
    expect(buildVerificationFailureFooter("✅ 已完成，测试全绿。", null)).toBeNull();
  });

  it("幂等：已包含 footer 时不重复追加", () => {
    const reply = "✅ 已完成。";
    const once = buildVerificationFailureFooter(reply, FAILURE)!;
    expect(buildVerificationFailureFooter(reply + once, FAILURE)).toBeNull();
  });
});

describe("runTurnFinalizer — 集成：进度报告 + 完成状态块", () => {
  it("进度报告式回复最终带 🔄 进行中 状态块", () => {
    const messages = makeMessages([
      { role: "user", content: "实现 TOML 解析器" },
      { role: "assistant", content: "还没做 README 和 CLI。" },
    ]);
    const result = runTurnFinalizer(
      "还没做 README 和 CLI。我先把剩下的跑完再汇报。",
      messages,
      makeToolStats({ successful: 20 }),
    );
    expect(result.completionStatusAppended).toBe(true);
    expect(result.finalReply).toContain("🔄 进行中");
  });
});
