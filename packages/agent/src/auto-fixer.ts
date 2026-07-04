/**
 * autoFixer — LLM 响应格式自动修复。
 *
 * 借鉴 page-agent 的 normalizeResponse（packages/core/src/utils/autoFixer.ts）：
 * 真实部署中 LLM 输出常有"几乎对但差点意思"的格式问题，需要在抛错前做
 * 穷举式修复，避免因模型返回格式小偏差导致整个任务失败。
 *
 * 修复场景（参照 page-agent 实战经验）：
 *   1. message.content 中有 JSON 但无 tool_calls → 提取 JSON
 *   2. 模型把 action 名当 tool name 调用 → 包一层 { action: ... }
 *   3. action 包了 AgentOutput 包装层 → 解开包装
 *   4. 双层包装（{type:'function', function:{arguments:...}}） → 解开第二层
 *   5. arguments 被双重 JSON.stringify → 二次 parse
 *   6. 单字段工具收到原始值（如 {"click_element_by_index": 2}） → coerce 成 {index: 2}
 *   7. 完全缺 action → 兜底 { wait: { seconds: 1 } }
 *
 * 注：本模块仅做格式修复，不做语义校验。修复后仍由调用方做 zod 校验。
 */

/** OpenAI 兼容的工具调用结构。 */
export interface ToolCall {
  id?: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** OpenAI 兼容的 message 结构。 */
export interface LLMMessage {
  role: "assistant";
  content?: string | null;
  tool_calls?: ToolCall[];
}

/** 标准化后的工具调用结果。 */
export interface NormalizedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** 修复结果。 */
export interface NormalizeResult {
  /** 修复后的工具调用列表（通常为 1 个）。 */
  toolCalls: NormalizedToolCall[];
  /** 应用了哪些修复规则（用于调试/日志）。 */
  fixes: string[];
}

/** 安全 JSON parse（容错）。 */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 递归尝试两次 parse（处理双重 stringify）。 */
function safeJsonParseTwice(text: string): unknown {
  const once = safeJsonParse(text);
  if (typeof once === "string") {
    const twice = safeJsonParse(once);
    if (twice !== undefined) return twice;
  }
  return once;
}

/** 从文本中提取第一个 JSON 对象（{ ... }）。 */
function extractJsonFromText(text: string): unknown | undefined {
  const match = text.match(/(\{[\s\S]*\})/);
  if (!match) return undefined;
  return safeJsonParse(match[1]);
}

/** 判断字符串看起来像工具名（snake_case + 小写）。 */
function looksLikeToolName(s: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(s) && s.length >= 3 && s.includes("_");
}

/**
 * 修复 LLM 响应。
 *
 * @param message LLM 返回的原始 message
 * @param expectedToolName 期望的工具名（如 "AgentOutput"），用于检测错位
 * @param knownToolNames 所有可用工具名（用于推断单字段工具的 coerce）
 * @returns 修复结果，toolCalls 为空表示无工具调用
 */
export function normalizeResponse(
  message: LLMMessage,
  expectedToolName?: string,
  knownToolNames: string[] = []
): NormalizeResult {
  const fixes: string[] = [];
  const toolCalls: NormalizedToolCall[] = [];

  // 路径 1：已有 tool_calls，直接解析
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      const name = tc.function.name;
      let args = safeJsonParseTwice(tc.function.arguments) as Record<string, unknown> | undefined;

      // 修复 4：双层包装 {type:'function', function:{arguments:...}}
      if (args && typeof args === "object" && "function" in args && "type" in args) {
        const inner = (args as { function?: { arguments?: unknown } }).function?.arguments;
        if (typeof inner === "string") {
          args = safeJsonParseTwice(inner) as Record<string, unknown> | undefined;
          fixes.push("unwrap_double_function_wrapper");
        }
      }

      // 修复 3：AgentOutput 包装层
      if (args && typeof args === "object" && "AgentOutput" in args) {
        const inner = (args as { AgentOutput?: unknown }).AgentOutput;
        if (inner && typeof inner === "object") {
          args = inner as Record<string, unknown>;
          fixes.push("unwrap_agent_output_wrapper");
        }
      }

      // 修复 2：把 action 名当 tool name 调用
      if (expectedToolName && name !== expectedToolName && knownToolNames.includes(name)) {
        // 模型直接调了具体工具而非 MacroTool
        toolCalls.push({
          name: expectedToolName,
          arguments: { action: { [name]: args || {} } },
        });
        fixes.push(`rewrap_action_as_${expectedToolName}`);
        continue;
      }

      // 修复 6：单字段工具收到原始值
      if (args && typeof args === "object") {
        for (const toolName of knownToolNames) {
          if (toolName in args) {
            const val = (args as Record<string, unknown>)[toolName];
            if (val !== null && typeof val !== "object") {
              // coerce 原始值到 { requiredKey: val }
              (args as Record<string, unknown>)[toolName] = { index: val };
              fixes.push(`coerce_primitive_for_${toolName}`);
            }
          }
        }
      }

      toolCalls.push({
        name,
        arguments: args || {},
      });
    }
    return { toolCalls, fixes };
  }

  // 路径 2：无 tool_calls，从 content 提取 JSON
  if (message.content) {
    const content = message.content.trim();

    // 修复 1：从 content 提取 JSON
    const extracted = extractJsonFromText(content);
    if (extracted && typeof extracted === "object") {
      fixes.push("extract_json_from_content");
      const obj = extracted as Record<string, unknown>;

      // 修复 3/4：解开包装
      let action: unknown = obj.action;
      if (!action && "AgentOutput" in obj) {
        action = (obj as { AgentOutput?: { action?: unknown } }).AgentOutput?.action;
        if (action) fixes.push("unwrap_agent_output_from_content");
      }

      // 修复 5：action 内部被双重 stringify
      if (typeof action === "string") {
        const parsed = safeJsonParse(action);
        if (parsed && typeof parsed === "object") {
          action = parsed;
          fixes.push("parse_stringified_action");
        }
      }

      // 修复 2：content 里直接是 {tool_name: args}
      if (!action) {
        for (const key of Object.keys(obj)) {
          if (knownToolNames.includes(key) || looksLikeToolName(key)) {
            action = { [key]: obj[key] };
            fixes.push(`rewrap_bare_tool_${key}`);
            break;
          }
        }
      }

      if (action && typeof action === "object") {
        const actionObj = action as Record<string, unknown>;
        const toolName = Object.keys(actionObj)[0];
        if (toolName) {
          toolCalls.push({
            name: expectedToolName || toolName,
            arguments: expectedToolName ? { action, ...obj } : (actionObj[toolName] as Record<string, unknown>) || {},
          });
          return { toolCalls, fixes };
        }
      }

      // 修复 7：完全缺 action，兜底 wait
      if (expectedToolName) {
        toolCalls.push({
          name: expectedToolName,
          arguments: { action: { wait: { seconds: 1 } } },
        });
        fixes.push("fallback_to_wait_action");
        return { toolCalls, fixes };
      }
    }
  }

  return { toolCalls, fixes };
}

/**
 * 把反思字段（evaluation_previous_goal / memory / next_goal）格式化为
 * 多行文本，便于在 LLM 历史上下文中渲染。
 *
 * 借鉴 page-agent PageAgentCore.#packMacroTool 的反思输出格式。
 */
export function formatReflection(reflection: {
  evaluationPreviousGoal?: string;
  memory?: string;
  nextGoal?: string;
}): string {
  const lines: string[] = [];
  if (reflection.evaluationPreviousGoal) {
    lines.push(`✅ Evaluation of Previous Step: ${reflection.evaluationPreviousGoal}`);
  }
  if (reflection.memory) {
    lines.push(`💾 Memory: ${reflection.memory}`);
  }
  if (reflection.nextGoal) {
    lines.push(`🎯 Next Goal: ${reflection.nextGoal}`);
  }
  return lines.join("\n");
}
