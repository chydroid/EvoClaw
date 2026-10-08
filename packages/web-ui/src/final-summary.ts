/**
 * 任务收尾总结（2026-10-08）。
 *
 * 用户原话：「最后的一个回复气泡放任务完成完成总结。任务完成总结要明显给出
 * 任务完成或者任务失败的提示，并给出较为简洁准确的任务执行总结。」
 *
 * 设计要点：
 * 1. **统计口径来自真实执行记录**（thinkingTrace），不采信模型自述的"已完成" ——
 *    此前正是因为直接展示模型回复，才会出现"声称完成、实际有工具失败"的情况。
 * 2. 失败时**明确写失败**，并给出可核对的事实，而不是含糊其辞。
 * 3. 简洁：最多几行，不复述过程细节（过程在上面的气泡与思考轨迹里）。
 */

export interface FinalSummaryInput {
  /** 本回合是否有工具执行失败 */
  ok: boolean;
  /** 工具调用次数（decision 条数） */
  toolCalls: number;
  /** 工具失败次数（error 条数） */
  failures: number;
  /** 模型推理条目数 */
  reasoningCount?: number;
  /** 产出的文件 */
  files?: Array<{ path: string }>;
  /** 用户中止 / 超时 */
  aborted?: boolean;
  /** 服务端错误文案 */
  errorText?: string;
}

export function buildFinalSummary(input: FinalSummaryInput): string {
  const { ok, toolCalls, failures } = input;
  const lines: string[] = [];

  if (input.aborted) {
    lines.push("## ⏹️ 任务已中止", "", "本次执行被手动停止或超时中断，结果可能不完整。");
  } else if (!ok) {
    lines.push(
      "## ❌ 任务未完成",
      "",
      `本回合共调用 ${toolCalls} 次工具，其中 **${failures} 次失败**。`,
      "下方思考轨迹中标记为 ❌ 的条目即为失败项，其对应的变更**没有生效**。",
      "如需继续，请说明下一步要做什么。",
    );
  } else {
    lines.push("## ✅ 任务已完成", "", `本回合共调用 ${toolCalls} 次工具，全部执行成功。`);
  }

  if (input.errorText) {
    lines.push("", `错误信息：${input.errorText}`);
  }

  const files = input.files ?? [];
  if (files.length > 0) {
    lines.push("", `产出文件 ${files.length} 个：`, ...files.slice(0, 10).map((f) => `- \`${f.path}\``));
    if (files.length > 10) lines.push(`- ……另有 ${files.length - 10} 个`);
  }

  return lines.join("\n");
}
