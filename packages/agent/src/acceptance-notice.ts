/**
 * 验收提示文案（交付物契约 × 冻结输入 × 轮次预算）
 *
 * 从 llm-caller 内联模板中抽出，做成纯函数：
 *   - 回合内续跑指令（给模型，要求补齐）；
 *   - 回合末 footer（给用户，如实列出未达标项）；
 *   - 80% 轮次预算的优先级清单（给模型，先补必交产物再收尾）。
 *
 * 文案本身是产品行为的一部分（模型对这些措辞的响应差异很大），
 * 单测直接断言关键指令，避免后续重构把「先补必交文件」这类指令丢掉。
 */

import type { AcceptanceIssue, FrozenMutation } from "./deliverable-contract";

export interface AcceptanceSummary {
  missing: string[];
  undersized: Array<{ path: string; actualBytes: number; minBytes: number }>;
  underAsserted: Array<{ path: string; actualAssertions: number; minAssertions: number }>;
  frozen: Array<{ path: string; kind: FrozenMutation["kind"] }>;
}

/** 把结构化 issue 归并成四类，供文案与 footer 复用 */
export function summarizeAcceptance(
  issues: AcceptanceIssue[],
  frozenMutations: FrozenMutation[] = [],
): AcceptanceSummary {
  return {
    missing: issues.filter((i) => i.kind === "missing").map((i) => i.path),
    undersized: issues
      .filter((i): i is Extract<AcceptanceIssue, { kind: "undersized" }> => i.kind === "undersized")
      .map((i) => ({ path: i.path, actualBytes: i.actualBytes, minBytes: i.minBytes })),
    underAsserted: issues
      .filter((i): i is Extract<AcceptanceIssue, { kind: "under_asserted" }> => i.kind === "under_asserted")
      .map((i) => ({ path: i.path, actualAssertions: i.actualAssertions, minAssertions: i.minAssertions })),
    frozen: frozenMutations.map((m) => ({ path: m.path, kind: m.kind })),
  };
}

export function hasAcceptanceViolations(summary: AcceptanceSummary): boolean {
  return (
    summary.missing.length > 0 ||
    summary.undersized.length > 0 ||
    summary.underAsserted.length > 0 ||
    summary.frozen.length > 0
  );
}

/**
 * 回合内续跑指令：点名具体差距 + 要求「在现有文件上补足」而非重建。
 * 空字符串表示无违规（调用方拼进 correction 时用 `|| undefined` 过滤）。
 */
export function buildAcceptanceCorrection(summary: AcceptanceSummary): string {
  const parts: string[] = [];

  if (summary.missing.length > 0) {
    parts.push(
      `\n\n**交付物契约未满足**：任务明确要求以下产物，但磁盘上不存在（你此前的回复也未提及）：\n` +
      summary.missing.map((p) => `- \`${p}\``).join("\n") +
      `\n\n请核对该产物是否属于必交项：若属于，立即用 file_write（绝对路径原样传入）真正创建，并按任务要求验证；` +
      `若任务已说明该产物由用户提供或无需生成，则在最终回复中明确说明该文件的来源/不需要生成的理由，不要保持沉默。`,
    );
  }

  if (summary.undersized.length > 0 || summary.underAsserted.length > 0) {
    const lines = [
      ...summary.undersized.map((u) => `- \`${u.path}\`：当前 ${u.actualBytes} 字节，任务要求 ≥${u.minBytes} 字节`),
      ...summary.underAsserted.map(
        (u) => `- \`${u.path}\`：当前 ${u.actualAssertions} 个断言，任务要求 ≥${u.minAssertions} 个`,
      ),
    ];
    parts.push(
      `\n\n**交付物未达到任务写明的验收门槛**：\n${lines.join("\n")}\n\n` +
      `请**在现有文件上补足内容**（不要重建整个文件、不要删掉已有正确部分）：README 补全任务点名的章节；` +
      `测试文件补充覆盖任务点名场景的**真实断言**（每个断言都必须实际执行并校验一个具体行为/数值，不能只增加注释或无断言的代码行）。` +
      `补完后重跑测试确认退出码 0。`,
    );
  }

  if (summary.frozen.length > 0) {
    const anyMissing = summary.frozen.some((f) => f.kind === "missing");
    const anyModified = summary.frozen.some((f) => f.kind === "modified");
    parts.push(
      `\n\n**冻结输入被修改**：任务明确要求以下输入只读、禁止修改，但检测到它们在本回合被${anyMissing ? "删除" : "改动"}：\n` +
      summary.frozen.map((f) => `- \`${f.path}\``).join("\n") +
      `\n\n${anyModified ? "改动版本已归档到工作区 `frozen-archive/`，原始内容已**还原**。\n\n" : ""}` +
      `不要把夹具改成迁就实现的样子——那会让测试假绿且违反任务约束。请改为修正实现/断言使其对**原始夹具**成立，` +
      `然后重跑测试确认退出码 0。若你确实认为夹具本身有误，在最终回复中说明具体理由，不要静默修改。`,
    );
  }

  return parts.join("");
}

/** 回合末 footer：给用户的事实陈述，不要求模型继续（回合已结束） */
export function buildAcceptanceFooter(summary: AcceptanceSummary): string | undefined {
  if (!hasAcceptanceViolations(summary)) return undefined;
  const lines = [
    ...summary.missing.map((p) => `- \`${p}\`：任务要求交付，磁盘上不存在`),
    ...summary.undersized.map((u) => `- \`${u.path}\`：${u.actualBytes} 字节 < 任务要求 ${u.minBytes} 字节`),
    ...summary.underAsserted.map(
      (u) => `- \`${u.path}\`：${u.actualAssertions} 个断言 < 任务要求 ${u.minAssertions} 个`,
    ),
    ...summary.frozen.map(
      (f) => `- \`${f.path}\`：任务声明为冻结/只读输入，本回合被${f.kind === "missing" ? "删除" : "修改"}`,
    ),
  ];
  return (
    "\n\n---\n\n**⚠️ 任务验收未全部满足**：以下为任务明写的硬指标，当前状态未达标：\n" +
    lines.join("\n") +
    "\n\n以上按实际文件状态核验得出，请勿据此认为任务已全部完成。"
  );
}

/**
 * 80% 轮次预算的收尾提醒。
 *
 * 语义对齐 Hermes RUN_BUDGET_WRAPUP_NOTICE：停止新的探索/调查，但**必须完成
 * 必交产物与验收**。旧文案「停止验证」会让模型带着红测试或空壳 README 收尾。
 *
 * @param used 已用轮次（1-based，用于展示）
 * @param limit 轮次上限
 * @param required 任务要求的必交产物绝对路径
 * @param missingNow 当前仍未落盘的必交产物
 */
export function buildWrapUpNotice(
  used: number,
  limit: number,
  required: string[],
  missingNow: string[],
): string {
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
  const requiredList = required.length > 0
    ? `任务要求的必交产物：${required.map((p) => `\`${p}\``).join("、")}。`
    : "";
  const priorityList = missingNow.length > 0
    ? `**当前仍缺失的必交产物（优先补齐，不要重写已完成的部分）**：\n${missingNow.map((p) => `- \`${p}\``).join("\n")}\n` +
      `执行顺序：① 写缺失的必交文件 → ② 跑任务的验收/测试命令并确认退出码 0 → ③ 收尾汇报。`
    : `执行顺序：① 确认全部必交产物已落盘 → ② 跑任务的验收/测试命令并确认退出码 0 → ③ 收尾汇报。`;
  return (
    `[系统提示] 工具轮次已使用 ${used}/${limit}（${pct}%），接近上限。` +
    `**立即停止新的探索/调查工作**，基于已有结果直接产出最终交付物（答案/文件/汇总），不要再做可选的额外工具调用。${requiredList}\n\n` +
    `${priorityList}\n\n` +
    `如果你已跑过的测试是失败的，先修到退出码 0——不要带着红测试收尾，也不要因为接近上限就跳过验收。完成后输出完成状态汇报。`
  );
}
