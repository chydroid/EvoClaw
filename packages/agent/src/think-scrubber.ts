/**
 * StreamingThinkScrubber — 流式推理块剥离状态机。
 *
 * 对标 Hermes v0.18.0 `agent/think_scrubber.py` 的 `StreamingThinkScrubber`：
 * 在流式 SSE delta 边界剥离 `<think)` / `<thinking>` / `<reasoning>` /
 * `<thought>` / `<REASONING_SCRATCHPAD>` 等 5 种推理 tag 变体。
 *
 * 核心问题：GLM-4.6 / Claude / MiniMax 等推理模型会把内部思考流到前端，
 * 逐 delta 处理时半个 tag 跨 chunk 会泄漏。本状态机在 delta 级别工作，
 * 保证：(1) 闭合对（<tag>X</tag>）总是被抑制；(2) 未闭合开 tag 仅在块
 * 边界（行首/空白行后）才被识别为推理块开始；(3) 跨 delta 的部分 tag
 * 被暂存，下一 delta 解决后释放。
 *
 * 用法：
 * ```ts
 * const scrubber = new StreamingThinkScrubber();
 * for (const delta of stream) {
 *   const visible = scrubber.feed(delta);
 *   if (visible) emit(visible);
 * }
 * const tail = scrubber.flush(); // 流结束时调用
 * if (tail) emit(tail);
 * ```
 */

/** 推理块 tag 名（不包含 <>） */
const OPEN_TAG_NAMES = [
  "think",
  "thinking",
  "reasoning",
  "thought",
  "REASONING_SCRATCHPAD",
] as const;

const OPEN_TAGS = OPEN_TAG_NAMES.map((n) => `<${n}>`);
const CLOSE_TAGS = OPEN_TAG_NAMES.map((n) => `</${n}>`);
const MAX_TAG_LEN = Math.max(...OPEN_TAGS.concat(CLOSE_TAGS).map((t) => t.length));

/** 匹配位置 [start, end) */
type Range = [number, number];

export class StreamingThinkScrubber {
  private inBlock = false;
  private buf = "";
  private lastEmittedEndedNewline = true;

  /** 重置状态。每个新 turn 开始时调用。 */
  reset(): void {
    this.inBlock = false;
    this.buf = "";
    this.lastEmittedEndedNewline = true;
  }

  /**
   * 投喂一个 delta，返回剥离推理块后的可见文本。
   * 可能返回空字符串（整个 delta 是推理内容，或被暂存等待解决部分 tag）。
   */
  feed(text: string): string {
    if (!text) return "";
    let buf = this.buf + text;
    this.buf = "";
    const out: string[] = [];

    while (buf) {
      if (this.inBlock) {
        // 在推理块内：寻找闭合 tag
        const [closeIdx, closeLen] = findFirstTag(buf, CLOSE_TAGS);
        if (closeIdx === -1) {
          // 未找到闭合 tag：暂存可能的闭合 tag 前缀，丢弃其余
          const held = maxPartialSuffix(buf, CLOSE_TAGS);
          this.buf = held > 0 ? buf.slice(-held) : "";
          return out.join("");
        }
        // 找到闭合 tag：丢弃块内容 + tag，继续
        buf = buf.slice(closeIdx + closeLen);
        this.inBlock = false;
      } else {
        // 优先级 1：闭合对 <tag>X</tag>（不受边界限制）
        const pair = findEarliestClosedPair(buf);
        // 优先级 2：块边界的未闭合开 tag
        const [openIdx, openLen] = this.findOpenAtBoundary(buf, out);

        // 选择最早出现的
        if (pair !== null && (openIdx === -1 || pair[0] <= openIdx)) {
          const [startIdx, endIdx] = pair;
          const preceding = buf.slice(0, startIdx);
          if (preceding) {
            const stripped = stripOrphanCloseTags(preceding);
            if (stripped) {
              out.push(stripped);
              this.lastEmittedEndedNewline = stripped.endsWith("\n");
            }
          }
          buf = buf.slice(endIdx);
          continue;
        }

        if (openIdx !== -1) {
          // 边界开 tag：输出前导文本，进入推理块
          const preceding = buf.slice(0, openIdx);
          if (preceding) {
            const stripped = stripOrphanCloseTags(preceding);
            if (stripped) {
              out.push(stripped);
              this.lastEmittedEndedNewline = stripped.endsWith("\n");
            }
          }
          this.inBlock = true;
          buf = buf.slice(openIdx + openLen);
          continue;
        }

        // 无可解决的 tag 结构：暂存尾部可能的 tag 前缀，输出其余
        const heldOpen = maxPartialSuffix(buf, OPEN_TAGS);
        const heldClose = maxPartialSuffix(buf, CLOSE_TAGS);
        const held = Math.max(heldOpen, heldClose);
        let emitText: string;
        if (held > 0) {
          emitText = buf.slice(0, -held);
          this.buf = buf.slice(-held);
        } else {
          emitText = buf;
          this.buf = "";
        }
        if (emitText) {
          const stripped = stripOrphanCloseTags(emitText);
          if (stripped) {
            out.push(stripped);
            this.lastEmittedEndedNewline = stripped.endsWith("\n");
          }
        }
        return out.join("");
      }
    }

    return out.join("");
  }

  /**
   * 流结束时的 flush。
   * 若仍在未闭合块内，暂存内容被丢弃（泄漏部分推理比截断答案更糟）。
   * 否则暂存的部分 tag 尾巴按原样输出（它最终不是真实 tag 前缀）。
   */
  flush(): string {
    if (this.inBlock) {
      this.buf = "";
      this.inBlock = false;
      return "";
    }
    const tail = this.buf;
    this.buf = "";
    if (!tail) return "";
    const stripped = stripOrphanCloseTags(tail);
    if (stripped) {
      this.lastEmittedEndedNewline = stripped.endsWith("\n");
    }
    return stripped;
  }

  // ── 内部辅助 ────────────────────────────────────────────

  /** 在 buf 中寻找块边界的开 tag，返回 (idx, len) 或 (-1, 0) */
  private findOpenAtBoundary(buf: string, alreadyEmitted: string[]): [number, number] {
    const bufLower = buf.toLowerCase();
    let bestIdx = -1;
    let bestLen = 0;
    for (const tag of OPEN_TAGS) {
      const tagLower = tag.toLowerCase();
      let searchStart = 0;
      while (true) {
        const idx = bufLower.indexOf(tagLower, searchStart);
        if (idx === -1) break;
        if (this.isBlockBoundary(buf, idx, alreadyEmitted)) {
          if (bestIdx === -1 || idx < bestIdx) {
            bestIdx = idx;
            bestLen = tag.length;
          }
          break; // 每个 tag 取第一个边界命中即可
        }
        searchStart = idx + 1;
      }
    }
    return [bestIdx, bestLen];
  }

  /** 判断位置 idx 是否是块边界 */
  private isBlockBoundary(buf: string, idx: number, alreadyEmitted: string[]): boolean {
    if (idx === 0) {
      // buf 起始：检查上一次输出是否以换行结束（或本 feed 内已输出换行）
      if (alreadyEmitted.length > 0) {
        return alreadyEmitted[alreadyEmitted.length - 1].endsWith("\n");
      }
      return this.lastEmittedEndedNewline;
    }
    const preceding = buf.slice(0, idx);
    const lastNl = preceding.lastIndexOf("\n");
    if (lastNl === -1) {
      // buf 内无换行：仅当上次输出以换行结束且 buf 前导是空白
      const priorNewline = alreadyEmitted.length > 0
        ? alreadyEmitted[alreadyEmitted.length - 1].endsWith("\n")
        : this.lastEmittedEndedNewline;
      return priorNewline && preceding.trim() === "";
    }
    // 换行后到 tag 之间必须全空白
    return preceding.slice(lastNl + 1).trim() === "";
  }
}

// ── 模块级辅助函数 ────────────────────────────────────────

/** 在 buf 中寻找最早的 tag（大小写不敏感），返回 (idx, len) 或 (-1, 0) */
function findFirstTag(buf: string, tags: readonly string[]): [number, number] {
  const bufLower = buf.toLowerCase();
  let bestIdx = -1;
  let bestLen = 0;
  for (const tag of tags) {
    const idx = bufLower.indexOf(tag.toLowerCase());
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
      bestLen = tag.length;
    }
  }
  return [bestIdx, bestLen];
}

/** 寻找最早的闭合对 <tag>...</tag>，返回 (startIdx, endIdx) 或 null */
function findEarliestClosedPair(buf: string): Range | null {
  const bufLower = buf.toLowerCase();
  let best: Range | null = null;
  for (let i = 0; i < OPEN_TAGS.length; i++) {
    const openLower = OPEN_TAGS[i].toLowerCase();
    const closeLower = CLOSE_TAGS[i].toLowerCase();
    const openIdx = bufLower.indexOf(openLower);
    if (openIdx === -1) continue;
    const closeIdx = bufLower.indexOf(closeLower, openIdx + openLower.length);
    if (closeIdx === -1) continue;
    const endIdx = closeIdx + closeLower.length;
    if (best === null || openIdx < best[0]) {
      best = [openIdx, endIdx];
    }
  }
  return best;
}

/** 返回 buf 的最长后缀，该后缀是某个 tag 的严格前缀（短于 tag 本身） */
function maxPartialSuffix(buf: string, tags: readonly string[]): number {
  if (!buf) return 0;
  const bufLower = buf.toLowerCase();
  const maxCheck = Math.min(bufLower.length, MAX_TAG_LEN - 1);
  for (let i = maxCheck; i > 0; i--) {
    const suffix = bufLower.slice(-i);
    for (const tag of tags) {
      const tagLower = tag.toLowerCase();
      if (tagLower.length > i && tagLower.startsWith(suffix)) {
        return i;
      }
    }
  }
  return 0;
}

/** 从文本中剥离孤儿闭合 tag（无匹配开 tag 的） */
function stripOrphanCloseTags(text: string): string {
  if (!text.includes("</")) return text;
  const textLower = text.toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let matched = false;
    if (textLower.slice(i, i + 2) === "</") {
      for (const tag of CLOSE_TAGS) {
        const tagLower = tag.toLowerCase();
        const tagLen = tagLower.length;
        if (textLower.slice(i, i + tagLen) === tagLower) {
          // 跳过 tag 及其后随空白
          let j = i + tagLen;
          while (j < text.length && "\t\n\r ".includes(text[j])) {
            j++;
          }
          i = j;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      out.push(text[i]);
      i++;
    }
  }
  return out.join("");
}

/**
 * 便捷函数：对完整文本一次性剥离推理块。
 * 适用于非流式场景。流式场景应使用 StreamingThinkScrubber 类。
 */
export function stripThinkBlocks(text: string): string {
  const scrubber = new StreamingThinkScrubber();
  const visible = scrubber.feed(text);
  const tail = scrubber.flush();
  return visible + tail;
}
