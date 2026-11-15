/**
 * web_fetch 大页截断 + 落盘 + 可回读
 *
 * 对标 hermes-agent `tools/web_tools_truncate.py`：超过字符预算的网页不再简单
 * `slice()` 丢弃中段，而是：
 *   1. head + tail 窗口呈现给模型（保留开头脉络与结尾结论）；
 *   2. 全文按固定宽度折行后落盘（`atomicWriteFileSync`，0600）；
 *   3. footer 告知模型「省略了多少、全文在哪、用哪条 file_read 调用回读中段」。
 *
 * 设计要点：
 * - **不改既有输出大小**：默认字符预算沿用调用方传入（web_fetch 默认 5000），
 *   只是在超预算时额外提供全文落盘与回读入口，不放大注入模型的 token。
 * - **纯函数与 IO 分离**：截断/折行/行号计算为纯函数，便于测试；落盘单独函数。
 * - **内联 base64 图片**替换为 `[IMAGE]` 占位符，避免大块无意义数据。
 */

import * as path from "path";
import * as crypto from "crypto";
import { atomicWriteFileSync } from "@evoclaw/core";

/** 落盘文件单行宽度（字符）。file_read 按行分页，故折行后行号稳定。 */
export const STORED_LINE_WIDTH = 2000;
/** 落盘全文上限，防多 MB 页面每次抓取写无界字节。 */
export const MAX_STORED_TEXT_CHARS = 2_000_000;
/** head 占呈现预算的比例（其余为 tail）。 */
const HEAD_RATIO = 0.6;

export interface WebTextTruncation {
  /** 呈现给模型的最终文本（截断窗口 + footer；未截断时为原文） */
  text: string;
  /** 是否发生截断 */
  truncated: boolean;
  /** 原始（去图后）总字符数 */
  totalChars: number;
  /** 实际呈现字符数 */
  shownChars: number;
  /** 被省略的字符数 */
  omittedChars: number;
  /** 省略中段在落盘文件中的起止行号（1-based，仅 truncated 时有值） */
  omittedStartLine?: number;
  omittedEndLine?: number;
}

/** 将内联 base64 图片替换为占位符（base64 字母表不含空白，故不以 \s 吞掉后续正文）。 */
export function stripInlineImages(text: string): string {
  return text.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "[IMAGE]");
}

/** 按固定宽度折行（供 file_read 按行分页）。保留原文顺序，不丢字符。 */
export function wrapForPaging(text: string, width: number = STORED_LINE_WIDTH): string {
  const safeWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : STORED_LINE_WIDTH;
  if (text.length <= safeWidth) return text;
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += safeWidth) {
    lines.push(text.slice(i, i + safeWidth));
  }
  return lines.join("\n");
}

/**
 * 纯函数：head+tail 截断。
 *
 * @param text 已去图的完整文本
 * @param charLimit 呈现给模型的字符预算
 * @returns 截断后的窗口文本与省略区间（行号基于 STORED_LINE_WIDTH 折行）
 */
export function truncateWebText(text: string, charLimit: number): WebTextTruncation {
  const totalChars = text.length;
  const limit = Number.isFinite(charLimit) && charLimit > 0 ? Math.floor(charLimit) : 5000;
  if (totalChars <= limit) {
    return { text, truncated: false, totalChars, shownChars: totalChars, omittedChars: 0 };
  }
  // 预留 marker 与换行开销
  const marker = `\n\n… [已省略 ${totalChars - limit} 字符中段，全文已落盘，见下方回读指引] …\n\n`;
  const budget = Math.max(2, limit - marker.length);
  const headChars = Math.max(1, Math.floor(budget * HEAD_RATIO));
  const tailChars = Math.max(1, budget - headChars);
  const head = text.slice(0, headChars);
  const tail = text.slice(totalChars - tailChars);
  const omittedChars = totalChars - headChars - tailChars;

  const width = STORED_LINE_WIDTH;
  const omittedStartLine = Math.floor(headChars / width) + 1;
  const omittedEndLine = Math.floor((totalChars - tailChars - 1) / width) + 1;

  return {
    text: head + marker + tail,
    truncated: true,
    totalChars,
    shownChars: head.length + tail.length,
    omittedChars,
    omittedStartLine,
    omittedEndLine,
  };
}

/** 回落目录：`<cwd>/data/cache/web/extract`（与 hermes `cache/web` 对齐）。 */
export function defaultWebCacheDir(cwd: string = process.cwd()): string {
  return path.join(cwd, "data", "cache", "web", "extract");
}

/**
 * 将完整网页文本落盘，供 file_read 分页回读。
 *
 * @returns 落盘文件绝对路径；写入失败返回 null（不阻断抓取主流程）。
 */
export function storeWebText(
  fullText: string,
  url: string,
  cacheDir: string = defaultWebCacheDir(),
): string | null {
  try {
    const stored = fullText.length > MAX_STORED_TEXT_CHARS
      ? fullText.slice(0, MAX_STORED_TEXT_CHARS)
      : fullText;
    const digest = crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
    const filePath = path.join(cacheDir, `${digest}.txt`);
    atomicWriteFileSync(filePath, wrapForPaging(stored), { encoding: "utf-8", mode: 0o600 });
    return filePath;
  } catch (err) {
    process.stderr.write(`[web_fetch] storeWebText failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
}

/** 构造回读指引 footer（指向真实可用的 file_read 调用）。 */
export function buildTruncationFooter(opts: {
  totalChars: number;
  shownChars: number;
  storedPath: string;
  omittedStartLine: number;
  omittedEndLine: number;
}): string {
  const limit = Math.max(1, opts.omittedEndLine - opts.omittedStartLine + 1);
  return (
    `\n\n---\n[web_fetch 截断] 页面共 ${opts.totalChars} 字符，此处仅显示约 ${opts.shownChars} 字符（省略中段）。` +
    `完整文本已保存到: ${opts.storedPath}\n` +
    `读取被省略的中段请调用：file_read path="${opts.storedPath}" offset=${opts.omittedStartLine} limit=${limit}`
  );
}
