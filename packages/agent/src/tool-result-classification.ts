/**
 * tool-result-classification — 工具结果分类（对标 hermes-agent agent/tool_result_classification.py）
 *
 * 用于中断/悬挂工具执行时判断结果是否可安全丢弃：
 *   - NO_EFFECT_TOOLS：只读工具，中断后可安全丢弃（不改变外部状态或会话状态）
 *   - FILE_MUTATING_TOOLS：文件写工具，中断后需验证写入是否落地
 *   - guardrail_refusal：护栏拒绝（重复读/搜索），不算失败——不计入失败链
 *
 * 关键设计（对标 hermes）：
 *   - 未知/插件/MCP 工具默认视为有副作用（fail-safe）
 *   - guardrail_refusal 的 body 仍含 "error" 字段让模型读到停止信号，
 *     但失败分类器不应计入——否则廉价拒绝会喂饱触发 repeated_exact_failure_block 的链
 */

// ── 工具名集合 ────────────────────────────────────────

/** 文件写类工具——中断后需验证写入是否落地 */
export const FILE_MUTATING_TOOL_NAMES = new Set([
  "file_write",
  "file_delete",
  "file_rename",
  "file_copy",
  "document",
  "write_file",
  "patch",
]);

/** 无副作用工具——中断后可安全丢弃（只读，不改变外部状态或会话状态） */
export const NO_EFFECT_TOOL_NAMES = new Set([
  "file_read",
  "file_list",
  "grep",
  "search",
  "web_fetch",
  "web_search",
  "browser_snapshot",
  "browser_console",
  "browser_get_images",
  "session_search",
  "skill_view",
  "skills_list",
  "vision_analyze",
  "read_terminal",
]);

/** 护栏拒绝标记键 */
const GUARDRAIL_REFUSAL_KEY = "guardrail_refusal";

// ── 函数 ──────────────────────────────────────────────

/**
 * 判断工具是否可能有副作用。
 * 不在 NO_EFFECT_TOOL_NAMES 中的工具默认可能有副作用（fail-safe）。
 */
export function toolMayHaveSideEffect(toolName: string): boolean {
  return !NO_EFFECT_TOOL_NAMES.has(toolName);
}

/**
 * 判断工具结果是否为护栏拒绝。
 * 护栏拒绝的 body 仍含 "error" 字段，但不算失败——不应计入失败链。
 */
export function isGuardrailRefusal(result: unknown): boolean {
  let data: unknown = result;
  if (typeof result === "string") {
    try {
      data = JSON.parse(result.trim());
    } catch {
      return false;
    }
  }
  return typeof data === "object" && data !== null && (data as Record<string, unknown>)[GUARDRAIL_REFUSAL_KEY] === true;
}

/**
 * 判断文件写工具的结果是否证明写入已落地。
 * write_file 需含 bytes_written，patch 需 success=true。
 */
export function fileMutationResultLanded(toolName: string, result: unknown): boolean {
  if (!FILE_MUTATING_TOOL_NAMES.has(toolName) || typeof result !== "string") return false;
  try {
    const data = JSON.parse(result.trim()) as Record<string, unknown>;
    if (data.error) return false;
    if (toolName === "write_file" || toolName === "file_write") {
      return "bytes_written" in data || "size" in data;
    }
    if (toolName === "patch" || toolName === "file_copy") {
      return data.success === true;
    }
    return false;
  } catch {
    return false;
  }
}
