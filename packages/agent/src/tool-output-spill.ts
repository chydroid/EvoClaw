/**
 * 工具输出安全截断 + spill 落盘（对标 Hermes terminal_tool_result.py + Pi truncate.ts）
 *
 * 背景事故（2026-11-05 sess_mw2axgpv）：shell_exec 的 output 超过 200 字符
 * 就无条件送进 stripWebNoise「网页去噪」管线（删 HTML 标签 / 删 JS 语句 /
 * 删 // 注释 / 折叠重复行），源码被逐字符腐蚀——`Array<{ role: string }>`
 * 变成 `Array,`、`let cache = _lastIndexCache.get(messages);` 整行消失。
 * 模型 25 轮 grep/sed 读到的代码全是残缺的，无法定位修改点，任务失败。
 *
 * 修复原则（Hermes）：
 *   1. 代码/命令输出**保真**——不做任何「内容整形」清洗；
 *   2. 超长只按「头 40% / 尾 60%」截断（错误出现在前面、最新结论在末尾），
 *      单一固定形状的截断标记（幂等：下游认标记即跳过，不再二次截断）；
 *   3. 被截掉的全文落盘（spill 文件），结果里给出路径与重读指令——
 *      模型可用 file_read / code_search 取回，不必重跑命令。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/** 单一固定形状的截断标记（Hermes truncation_notice 语义：下游只认一种标记）。 */
export function truncationNotice(omitted: number, total: number): string {
  return `\n\n... [OUTPUT TRUNCATED - ${omitted} chars omitted out of ${total} total] ...\n\n`;
}

/** 幂等判定：内容已含截断标记（或 spill 文件字段）时，不再二次截断/摘要。 */
export function isTruncatedOrSpilled(content: string): boolean {
  return content.includes("[OUTPUT TRUNCATED -") || content.includes('"full_output_path"');
}

/**
 * 头 40% / 尾 60% 截断（Hermes HEAD_RATIO=0.4：错误/头部先行、尾部最新行最重要）。
 * 幂等：已截断内容（含标记）原样返回。
 */
export function truncateHeadTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (isTruncatedOrSpilled(text)) return text;
  const headLen = Math.floor(maxChars * 0.4);
  const tailLen = maxChars - headLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  return head + truncationNotice(text.length - maxChars, text.length) + tail;
}

export interface ToolSpill {
  /** 全文落盘路径（绝对路径） */
  path: string;
  /** 原文总字符数 */
  totalChars: number;
}

/**
 * 把全文写入 spill 文件：`<workspacePath|tmpdir>/tool-spill/<id>.<rand>.log`。
 * workspacePath 缺失时落系统临时目录（spill 是 best-effort，目录不可写则跳过）。
 */
export function writeToolSpill(
  workspacePath: string | undefined,
  callId: string,
  text: string,
): ToolSpill | null {
  try {
    const base = workspacePath
      ? path.resolve(workspacePath, "tool-spill")
      : path.join(process.env.TMPDIR || "/tmp", "evoclaw-tool-spill");
    fs.mkdirSync(base, { recursive: true });
    const safeId = String(callId || "call").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "call";
    const file = path.join(base, `${safeId}-${Date.now()}-${randomBytes(4).toString("hex")}.log`);
    fs.writeFileSync(file, text, "utf8");
    return { path: file, totalChars: text.length };
  } catch {
    return null; // best-effort：落盘失败不阻断工具结果
  }
}

/**
 * shell_exec / execute_code 结果 JSON（已 serialize 前）的专用处理：
 *  - 不清洗（保真）
 *  - output 超 maxChars：spill 全文 + 头尾截断 + 附 full_output_path / truncation_note
 * 返回可能带 full_output_path / truncation_note 字段的浅拷贝。
 */
export function sanitizeExecResult(
  workspacePath: string | undefined,
  callId: string,
  result: Record<string, unknown>,
  maxChars: number,
): Record<string, unknown> {
  const output = result.output;
  if (typeof output !== "string" || output.length <= maxChars) return result;
  const spill = writeToolSpill(workspacePath, callId, output);
  const next: Record<string, unknown> = { ...result };
  next.output = truncateHeadTail(output, maxChars);
  if (spill) {
    next.full_output_path = spill.path;
    next.truncation_note =
      `Output exceeded the capture window (head+tail shown). Full output (${spill.totalChars} chars) ` +
      `saved to ${spill.path} — read it with file_read or search it with code_search ` +
      `instead of re-running the command.`;
  }
  return next;
}
