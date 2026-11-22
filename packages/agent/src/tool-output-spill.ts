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
import { redactSensitiveText } from "@evoclaw/security";

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

/**
 * 把超长单行切成固定宽度的多行（Hermes pageable_archive_text）。
 *
 * spill 文件 / 持久化结果可能来自 `JSON.stringify` 或单行命令输出——整份内容
 * 只有一行。file_read 只支持按**行** offset/limit 分页且每页硬上限 16K，
 * 单行文件因此永远读不到第 16K 之后的字节。按 1800 字符切行后，一次
 * file_read(offset, limit) 就能覆盖约 8 个分片、连续翻页可读回全文。
 *
 * 只插入换行，不删除/改写任何字符（可逆：读回后按行拼接即原文）。
 */
export function wrapLongLines(text: string, width = 1800): string {
  if (!text || width <= 0) return text;
  if (!text.split("\n").some((line) => line.length > width)) return text;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
  }
  return out.join("\n");
}

/**
 * 结构化 exec 结果的尾部保护截断（JSON 对象且含 `output` 字段）。
 *
 * 背景：shell_exec 结果是 `JSON.stringify({success, exitCode, output, stderr,
 * error, command, cwd})`——如果没有大数组字段，`truncateToolResult` 的
 * JSON 结构感知分支返回 null，随后走「保留头部、丢弃尾部」的兜底，
 * 把 exitCode/error（对象尾部）和输出末尾的失败摘要一起丢掉。
 * 这里只压缩 `output` 字符串本身（头 40%/尾 60%），其余字段原样保留。
 *
 * @returns 截断后的 JSON 字符串；不适用（非 JSON/无 output/未超限）返回 null。
 */
export function truncateExecJson(text: string, maxChars: number): string | null {
  if (text.length <= maxChars) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.output !== "string" || rec.output.length <= 200) return null;

  // 其余字段（exitCode / stderr / error / command / cwd / full_output_path）的
  // 序列化开销。预留 200 字符给截断标记与新增字段。
  const skeleton = JSON.stringify({ ...rec, output: "" }).length;
  const budget = Math.max(1_000, maxChars - skeleton - 200);
  if (rec.output.length <= budget) return null;

  return JSON.stringify({
    ...rec,
    output: truncateHeadTail(rec.output, budget),
    output_truncated: true,
    output_original_length: rec.output.length,
  });
}

export interface ToolSpill {
  /** 全文落盘路径（绝对路径） */
  path: string;
  /** 原文总字符数 */
  totalChars: number;
  /** 落盘前被脱敏的密钥数量（0 = 无命中） */
  redactedSecrets: number;
}

/**
 * 把全文写入 spill 文件：`<workspacePath|tmpdir>/tool-spill/<id>.<rand>.log`。
 * workspacePath 缺失时落系统临时目录（spill 是 best-effort，目录不可写则跳过）。
 *
 * ★ 2026-11-10（hermes 对齐 G1）：落盘前用同一套 secret pass 脱敏。
 * 命令输出里可能带 API key / token（`echo $OPENAI_API_KEY`、curl -v 回显
 * Authorization 头等），spill 文件会长期留在 workspace 里被后续读取/提交，
 * 明文密钥等价于落盘泄漏。hermes terminal_tool_result.py 的 spill 同样先
 * 脱敏再持久化。占位符 `[REDACTED:<kind>]`，上下文前缀也不保留。
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
    const redaction = redactSensitiveText(text, { preservePrefix: false });
    // Hermes pageable_archive_text：单行超长输出必须切行，否则 file_read 的
    // 行式 offset/limit + 16K 硬上限永远读不到第 16K 之后的字节。
    fs.writeFileSync(file, wrapLongLines(redaction.redacted), "utf8");
    return { path: file, totalChars: text.length, redactedSecrets: redaction.count };
  } catch {
    return null; // best-effort：落盘失败不阻断工具结果
  }
}

/**
 * shell_exec / execute_code 结果 JSON（已 serialize 前）的专用处理：
 *  - 不清洗（保真）
 *  - output/stdout/stderr 任一超 maxChars：spill 全文 + 头尾截断 +
 *    附 full_output_path / truncation_note（execute_code 用 stdout/stderr，
 *    shell_exec 用 output——两者都要覆盖，否则 >48K 的脚本输出永远拿不到尾部）
 * 返回可能带 full_output_path / truncation_note 字段的浅拷贝。
 */
export function sanitizeExecResult(
  workspacePath: string | undefined,
  callId: string,
  result: Record<string, unknown>,
  maxChars: number,
): Record<string, unknown> {
  const FIELDS = ["output", "stdout", "stderr"] as const;
  let next: Record<string, unknown> | null = null;
  const spilled: Array<{ field: string; totalChars: number; path: string }> = [];

  for (const field of FIELDS) {
    const value = result[field];
    if (typeof value !== "string" || value.length <= maxChars) continue;
    const spill = writeToolSpill(workspacePath, `${callId}-${field}`, value);
    if (!next) next = { ...result };
    next[field] = truncateHeadTail(value, maxChars);
    if (spill) spilled.push({ field, totalChars: spill.totalChars, path: spill.path });
  }

  if (!next) return result;
  if (spilled.length > 0) {
    next.full_output_path = spilled[0].path;
    next.truncation_note =
      `${spilled.map((s) => `${s.field} (${s.totalChars} chars)`).join(", ")} exceeded the capture window ` +
      `(head+tail shown). Full text saved to ${spilled.map((s) => s.path).join(", ")} — ` +
      `read it with file_read or search it with code_search instead of re-running.`;
  }
  return next;
}
