/**
 * reflection-contract — MacroTool "Reflection-Before-Action" 契约。
 *
 * 借鉴 page-agent 的核心创新：用工具 schema 物理约束 LLM 行为，把反思从
 * "prompt 建议"提升到"工具调用契约"。LLM 每一步必须同时输出反思字段和
 * 行动字段，无法不反思就行动。
 *
 * 设计：
 *   - LLM 每步必须调用名为 AgentOutput 的 MacroTool
 *   - MacroTool schema 包含 evaluation_previous_goal / memory / next_goal + action
 *   - action 是 union 类型，每个分支是 {toolName: toolInput} 单字段对象
 *   - tool_choice 强制为 { name: 'AgentOutput' }
 *
 * 本模块提供：
 *   1. ReflectionFields 类型定义
 *   2. buildMacroToolSchema — 把多个工具 schema 合并为 MacroTool schema
 *   3. extractReflection — 从 LLM 响应中提取反思字段
 *   4. ReflectionHistoryEntry — 渲染到 LLM 上下文的历史条目格式
 */

/** 反思字段（强制 LLM 输出）。 */
export interface ReflectionFields {
  /** 对上一步结果的判定：Success / Failure / Uncertain + 简短理由。 */
  evaluationPreviousGoal?: string;
  /** 工作记忆：1-3 句话的关键信息，跨步骤保持上下文。 */
  memory?: string;
  /** 下一步目标：一句话说明要做什么。 */
  nextGoal?: string;
}

/** MacroTool 输入 = 反思 + 行动。 */
export interface MacroToolInput {
  evaluationPreviousGoal?: string;
  memory?: string;
  nextGoal?: string;
  /** 行动：{ toolName: toolInput } 单字段对象。 */
  action: Record<string, unknown>;
}

/** 反思+行动的历史条目（喂回 LLM 上下文用）。 */
export interface ReflectionHistoryEntry {
  stepIndex: number;
  reflection: ReflectionFields;
  /** 工具名（从 action 中提取）。 */
  actionName: string;
  /** 工具入参。 */
  actionInput: Record<string, unknown>;
  /** 工具执行结果摘要。 */
  actionOutput?: string;
  /** 是否成功。 */
  success?: boolean;
  /** 错误信息（失败时）。 */
  error?: string;
}

/** 工具的简化 schema 描述（用于 buildMacroToolSchema）。 */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema（OpenAI 兼容）。 */
  inputSchema: Record<string, unknown>;
}

/**
 * 把多个工具的 schema 合并为一个 MacroTool schema。
 *
 * 生成的 schema 形如：
 * ```json
 * {
 *   "type": "object",
 *   "properties": {
 *     "evaluation_previous_goal": { "type": "string" },
 *     "memory": { "type": "string" },
 *     "next_goal": { "type": "string" },
 *     "action": { "oneOf": [ {tool1 schema}, {tool2 schema}, ... ] }
 *   },
 *   "required": ["action"]
 * }
 * ```
 *
 * 注意：action 用 oneOf 而非 anyOf，强制 LLM 只选一个工具。
 */
export function buildMacroToolSchema(tools: ToolSchema[]): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  const actionSchemas = tools.map((tool) => ({
    type: "object",
    properties: {
      [tool.name]: tool.inputSchema,
    },
    required: [tool.name],
    description: tool.description,
  }));

  return {
    name: "AgentOutput",
    description:
      "反思与行动的统一输出。必须在 action 中选择一个工具调用。" +
      "evaluation_previous_goal: 判定上一步 Success/Failure/Uncertain。" +
      "memory: 跨步骤关键信息。" +
      "next_goal: 下一步目标。",
    inputSchema: {
      type: "object",
      properties: {
        evaluation_previous_goal: {
          type: "string",
          description: "对上一步结果的判定。必须明确说出 Success / Failure / Uncertain，并简短说明理由。",
        },
        memory: {
          type: "string",
          description: "工作记忆：1-3 句话的关键信息，用于跨步骤保持上下文。例如已访问的页数、找到的条目数等。",
        },
        next_goal: {
          type: "string",
          description: "下一步目标：一句话说明要做什么。",
        },
        action: {
          oneOf: actionSchemas,
          description: "行动：选择一个工具调用。每个分支是 {工具名: 入参} 的单字段对象。",
        },
      },
      required: ["action"],
    },
  };
}

/**
 * 从 LLM 的 MacroTool 调用参数中提取反思字段和行动字段。
 *
 * @param args LLM 返回的工具调用 arguments（已 JSON.parse）
 * @returns 解析后的反思 + 行动；若格式不符返回 null
 */
export function extractReflectionAndAction(
  args: Record<string, unknown>
): { reflection: ReflectionFields; actionName: string; actionInput: Record<string, unknown> } | null {
  const reflection: ReflectionFields = {
    evaluationPreviousGoal: typeof args.evaluation_previous_goal === "string" ? args.evaluation_previous_goal : undefined,
    memory: typeof args.memory === "string" ? args.memory : undefined,
    nextGoal: typeof args.next_goal === "string" ? args.next_goal : undefined,
  };

  const action = args.action;
  if (!action || typeof action !== "object") return null;

  const actionObj = action as Record<string, unknown>;
  const actionName = Object.keys(actionObj)[0];
  if (!actionName) return null;

  const actionInput = (actionObj[actionName] as Record<string, unknown>) || {};
  return { reflection, actionName, actionInput };
}

/**
 * 把反思+行动历史条目渲染为 LLM 上下文文本。
 *
 * 格式参照 page-agent 的 system_prompt：
 * ```
 * <step_3>
 * Evaluation of Previous Step: Success - button clicked
 * Memory: 已找到登录按钮
 * Next Goal: 输入用户名
 * Action: click_element_by_index({ index: 5 })
 * Result: ✅ success
 * </step_3>
 * ```
 */
export function renderHistoryEntry(entry: ReflectionHistoryEntry): string {
  const lines: string[] = [`<step_${entry.stepIndex}>`];
  if (entry.reflection.evaluationPreviousGoal) {
    lines.push(`Evaluation of Previous Step: ${entry.reflection.evaluationPreviousGoal}`);
  }
  if (entry.reflection.memory) {
    lines.push(`Memory: ${entry.reflection.memory}`);
  }
  if (entry.reflection.nextGoal) {
    lines.push(`Next Goal: ${entry.reflection.nextGoal}`);
  }
  const inputStr = JSON.stringify(entry.actionInput).slice(0, 200);
  lines.push(`Action: ${entry.actionName}(${inputStr})`);
  if (entry.actionOutput) {
    lines.push(`Result: ${entry.success ? "✅" : "❌"} ${entry.actionOutput}`);
  }
  if (entry.error) {
    lines.push(`Error: ${entry.error}`);
  }
  lines.push(`</step_${entry.stepIndex}>`);
  return lines.join("\n");
}

/**
 * 系统提示词片段：指导 LLM 如何使用 MacroTool。
 *
 * 借鉴 page-agent 的 system_prompt.md 中的 <reasoning_rules> 和 <output_format>。
 */
export const MACRO_TOOL_SYSTEM_PROMPT = `
## Reasoning Rules (强制)

你必须在每一步调用 AgentOutput 工具，且必须同时填写反思字段和行动字段：

1. **evaluation_previous_goal**：判定上一步是否成功。
   - 必须明确说出 "Success" / "Failure" / "Uncertain"
   - 简短说明理由（一句话）
   - 不要因为工具"看起来执行了"就判定 Success，必须确认预期变化确实发生
   - 如果上一步失败，规划恢复方案

2. **memory**：1-3 句话的关键信息，跨步骤保持上下文。
   - 例如：已访问的页数、找到的条目、用户的偏好
   - 不要重复用户原始请求

3. **next_goal**：下一步目标，一句话说明要做什么。

4. **action**：选择一个工具调用。
   - 不要假设行动成功，必须基于下一步的 evaluation 验证
   - 如果重复同一动作多次无进展，考虑换策略或请求帮助

## Output Format

每步输出格式（必须严格遵守）：
\`\`\`json
{
  "evaluation_previous_goal": "Success - 登录按钮已点击",
  "memory": "已进入登录页，待输入用户名",
  "next_goal": "在用户名输入框输入 admin",
  "action": {
    "browser_input_by_index": { "index": 3, "text": "admin" }
  }
}
\`\`\`

注意：action 内部只能有一个工具，不能并行调用多个工具。
`.trim();

/** 双流信息架构：history（持久化，喂 LLM）vs activity（瞬态，仅 UI）。 */
export interface DualStreamEvent {
  /** 持久化历史事件（进 LLM 上下文）。 */
  history?: ReflectionHistoryEntry;
  /** 瞬态活动事件（仅 UI 反馈，不进 LLM 上下文）。 */
  activity?:
    | { type: "thinking" }
    | { type: "executing"; tool: string; input: Record<string, unknown> }
    | { type: "executed"; tool: string; duration: number; success: boolean }
    | { type: "error"; message: string }
    | { type: "retrying"; attempt: number; maxAttempts: number };
}

/**
 * 观察机制：自动注入的上下文提示（不来自 LLM 反思）。
 *
 * 借鉴 page-agent PageAgentCore.#handleObservations：
 * - URL 变化检测（页面导航后等页面稳定）
 * - 累计等待警告（避免无限等待）
 * - 剩余步数预算（接近上限时提醒收尾）
 */
export interface ObservationEvent {
  type: "url_change" | "wait_budget" | "step_budget" | "stuck_warning";
  content: string;
}

/** 生成 URL 变化观察。 */
export function observeUrlChange(oldUrl: string, newUrl: string): ObservationEvent | null {
  if (oldUrl === newUrl) return null;
  return {
    type: "url_change",
    content: `页面导航到 ${newUrl}。请观察新页面状态后再规划下一步。`,
  };
}

/** 生成累计等待观察。 */
export function observeWaitBudget(totalWaitSeconds: number): ObservationEvent | null {
  if (totalWaitSeconds < 3) return null;
  return {
    type: "wait_budget",
    content: `已累计等待 ${totalWaitSeconds.toFixed(1)} 秒。除非有充分理由，不要再调用 wait 工具。`,
  };
}

/** 生成剩余步数观察。 */
export function observeStepBudget(remaining: number, maxSteps: number): ObservationEvent | null {
  if (remaining > 5) return null;
  if (remaining > 2) {
    return {
      type: "step_budget",
      content: `剩余 ${remaining} 步（共 ${maxSteps} 步），考虑收尾。`,
    };
  }
  return {
    type: "step_budget",
    content: `关键：仅剩 ${remaining} 步，必须立即完成或汇报失败。`,
  };
}

/** 生成卡顿警告（连续重复同一动作）。 */
export function observeStuckWarning(
  recentActions: { actionName: string; actionInput: Record<string, unknown> }[],
  threshold = 3
): ObservationEvent | null {
  if (recentActions.length < threshold) return null;
  const last = recentActions[recentActions.length - 1];
  if (!last) return null;
  const repeated = recentActions.slice(-threshold).every(
    (a) => a.actionName === last.actionName &&
      JSON.stringify(a.actionInput) === JSON.stringify(last.actionInput)
  );
  if (!repeated) return null;
  return {
    type: "stuck_warning",
    content: `已连续 ${threshold} 次重复同一动作 ${last.actionName}，无进展。请换策略：滚动页面、请求用户帮助、或汇报失败。`,
  };
}
