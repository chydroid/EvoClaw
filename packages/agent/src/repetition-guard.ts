// EvoClaw 模型输出重复检测（借鉴 hermes-agent repetition_guard.py）
//
// hermes 的 repetition_guard 防的是：模型陷入退化重复循环，耗尽整个输出预算
// 去回显一个片段；finish_reason=length 的续接会把它缝进最终回复
// （真实事故：一个 60k 字符的 turn 被当成 31 条 Discord 消息送达）。#86581、#100716、#112764。
//
// 三条检测路径：
//   1. _line_repetition_dominated：单行覆盖一半以上（最常见的 echo 形态）
//   2. _window_count_dominated：60 字符窗口计数——抓「带计数器/噪音 token 的循环」
//   3. _periodic_run_dominated：等间距锚点 + _expand_run——抓「长周期精确循环单元」
//
// is_runaway_repetition 更严格：重复窗口占优 AND（有行结构时）不同行不超过一半，
// 避免误伤批量输出（如表格行）。
//
// RunawayStreamWatch：在**流式**输出时应用 stop-path 判据——
// 首次检查在 STOP_PATH_MIN_CHARS（16k），间隔翻倍直到一个 tail 窗口（64k），
// 每次只读 tail，总工作量与输出量成线性。

/** 最小片段长度（短输入 fail-open，对齐 hermes）。 */
export const MIN_FRAGMENT_LENGTH = 400;

/** 重复窗口长度（hermes _REPEAT_WINDOW=60）。 */
export const REPEAT_WINDOW = 60;

/** 最小重复次数（hermes _MIN_REPEAT_COUNT=5）。 */
export const MIN_REPEAT_COUNT = 5;

/** 占比阈值（hermes _DOMINANCE_RATIO=0.5）。 */
export const DOMINANCE_RATIO = 0.5;

/** 不同行比例上限（hermes _RUNAWAY_DISTINCT_LINE_RATIO=0.5）。 */
export const RUNAWAY_DISTINCT_LINE_RATIO = 0.5;

/** 锚点采样数（hermes _MAX_ANCHOR_SAMPLES=32）。 */
export const MAX_ANCHOR_SAMPLES = 32;

/** 每个锚点最大匹配数（hermes _MAX_ANCHOR_MATCHES=8）。 */
export const MAX_ANCHOR_MATCHES = 8;

/** stop-path 首次检查阈值（hermes STOP_PATH_MIN_CHARS=16_000）。 */
export const STOP_PATH_MIN_CHARS = 16_000;

/** 流式 tail 窗口（hermes _STREAM_TAIL_CHARS=4×STOP_PATH_MIN_CHARS=64_000）。 */
export const STREAM_TAIL_CHARS = 4 * STOP_PATH_MIN_CHARS;

/** 中断检查点文案（hermes REPETITION_LOOP_INTERRUPTED）。 */
export const REPETITION_LOOP_INTERRUPTED =
  "（本轮回复陷入了重复循环，已中断。如需继续，请明确说明下一步要做什么。）";

/**
 * 规范化行（对齐 hermes norm：strip 后的行）。
 */
function normLine(line: string): string {
  return line.trim();
}

/**
 * 路径 1：单行覆盖一半以上（最常见的 echo 形态）。
 */
function lineRepetitionDominated(text: string, n: number): boolean {
  const counts = new Map<string, { line: string; count: number }>();
  for (const line of text.split("\n")) {
    const norm = normLine(line);
    if (!norm) continue;
    const entry = counts.get(norm);
    if (entry) {
      entry.count++;
    } else {
      counts.set(norm, { line: norm, count: 1 });
    }
  }
  for (const entry of counts.values()) {
    if (entry.count >= MIN_REPEAT_COUNT && entry.count * entry.line.length >= n * DOMINANCE_RATIO) {
      return true;
    }
  }
  return false;
}

/**
 * 路径 2：60 字符窗口计数——抓「带计数器/噪音 token 的循环」。
 */
function windowCountDominated(text: string, n: number): boolean {
  const window = REPEAT_WINDOW;
  const needed = Math.max(MIN_REPEAT_COUNT, Math.ceil((n * DOMINANCE_RATIO) / window));
  const counts = new Map<string, number>();
  for (let i = 0; i <= n - window; i++) {
    const key = text.slice(i, i + window);
    const c = (counts.get(key) ?? 0) + 1;
    if (c >= needed) return true;
    counts.set(key, c);
  }
  return false;
}

/**
 * 扩展一个已知相等窗口到其精确周期运行的 [left, right) 边界（hermes _expand_run）。
 */
function expandRun(text: string, n: number, start: number, period: number, matched: number): [number, number] {
  let left = start;
  while (left > 0 && text[left - 1] === text[left - 1 + period]) {
    left--;
  }
  let right = start + matched;
  while (right + period < n && text[right] === text[right + period]) {
    right += 1;
  }
  return [left, right + period];
}

/**
 * 路径 3：等间距锚点 + _expand_run——抓「长周期精确循环单元」。
 */
function periodicRunDominated(text: string, n: number): boolean {
  const window = REPEAT_WINDOW;
  const maxStart = n - window;
  if (maxStart < 1) return false;

  const sampleStep = Math.max(
    1,
    (maxStart + MAX_ANCHOR_SAMPLES - 2) // (MAX_ANCHOR_SAMPLES - 1),
  );
  const sampleStarts: number[] = [];
  for (let i = 0; i <= maxStart; i += sampleStep) {
    sampleStarts.push(i);
  }
  if (sampleStarts[sampleStarts.length - 1] !== maxStart) {
    sampleStarts.push(maxStart);
  }

  const rejected: Array<[number, number, number]> = [];
  for (const start of sampleStarts) {
    const anchor = text.slice(start, start + window);
    let searchFrom = start + 1;
    for (let m = 0; m < MAX_ANCHOR_MATCHES; m++) {
      const match = text.indexOf(anchor, searchFrom);
      if (match < 0) break;
      const period = match - start;
      searchFrom = match + 1;
      if (rejected.some(([lo, hi, p]) => lo <= start && start < hi && period % p === 0)) {
        continue;
      }
      const [left, right] = expandRun(text, n, start, period, window);
      if (right - left >= MIN_REPEAT_COUNT * period && right - left >= n * DOMINANCE_RATIO) {
        return true;
      }
      rejected.push([left, right, period]);
    }
  }
  return false;
}

/**
 * 判定一段文本是否被重复主导（hermes is_repetition_dominated 的 TS 移植）。
 * 「连续 5 次以上精确重复覆盖至少一半文本」即判为模型重复循环。
 * 短输入 fail-open（对齐 hermes）。
 */
export function isRepetitionDominated(text: string): boolean {
  if (typeof text !== "string") return false;
  const n = text.length;
  if (n < MIN_FRAGMENT_LENGTH) return false;

  if (lineRepetitionDominated(text, n)) return true;
  return windowCountDominated(text, n) || periodicRunDominated(text, n);
}

/**
 * 更严格的 runaway 判定（hermes is_runaway_repetition 的 TS 移植）：
 * 重复占优 AND（有行结构时）不同行不超过一半——
 * 避免误伤批量输出（如表格行、合法重复）。
 * 中断检查点会丢弃部分文本，所以必须严格。
 */
export function isRunawayRepetition(text: string): boolean {
  if (!isRepetitionDominated(text)) return false;
  const lines = text.split("\n").map((line: string) => line.trim()).filter((line: string) => line.length > 0);
  if (lines.length < MIN_REPEAT_COUNT) return true; // 无行结构：单行循环
  return new Set(lines).size <= lines.length * RUNAWAY_DISTINCT_LINE_RATIO;
}

/**
 * 流式重复看门狗（hermes RunawayStreamWatch 的 TS 移植）。
 *
 * 在**流式**输出时应用 stop-path 判据：
 * - 首次检查在 STOP_PATH_MIN_CHARS（16k），间隔翻倍直到一个 tail 窗口（64k）
 * - 每次只读 tail，总工作量与输出量成线性
 * - 每次检查后把已持有文本裁到 tail，最多持有两个 tail 窗口 + 最新 delta
 */
export class RunawayStreamWatch {
  private parts: string[] = [];
  private chars = 0;
  private nextCheck = STOP_PATH_MIN_CHARS;

  /** 喂入一个 delta；一旦判定为 runaway loop 返回 true。 */
  feed(text: string): boolean {
    if (!text) return false;
    this.parts.push(text);
    this.chars += text.length;
    if (this.chars < this.nextCheck) return false;
    // 间隔翻倍，直到一个 tail 窗口
    this.nextCheck = this.chars + Math.min(this.chars, STREAM_TAIL_CHARS);
    const tail = this.parts.join("").slice(-STREAM_TAIL_CHARS);
    this.parts = [tail];
    return isRunawayRepetition(tail);
  }

  /** 已持有字符数。 */
  getChars(): number {
    return this.chars;
  }

  /** 重置（新 turn）。 */
  reset(): void {
    this.parts = [];
    this.chars = 0;
    this.nextCheck = STOP_PATH_MIN_CHARS;
  }
}