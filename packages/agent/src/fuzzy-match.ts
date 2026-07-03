/**
 * FuzzyMatch — 多策略模糊匹配链。
 *
 * 对标 Hermes v0.18.0 `tools/fuzzy_match.py` 的 `fuzzy_find_and_replace`：
 * LLM 生成的 old_string 经 JSON 序列化后常出现空白/转义/Unicode 漂移，
 * 精确匹配失败时按以下顺序回退：
 *
 * 1. exact               — 直接字符串比较
 * 2. line_trimmed        — 每行去首尾空白后比较
 * 3. whitespace_normalized — 多空白折叠为单空格
 * 4. indentation_flexible — 忽略缩进差异
 * 5. escape_normalized   — `\n` 字面量转真换行
 * 6. trimmed_boundary    — 仅首尾行去空白
 * 7. unicode_normalized  — 智能引号/em-dash 等 Unicode 归一化
 * 8. block_anchor        — 首尾行锚定 + 中间相似度
 * 9. context_aware       — 50% 行相似度阈值
 *
 * 命中后：
 * - escape-drift 检测：阻止 `\'` / `\"` 序列化伪影污染文件
 * - 缩进自动调整：根据匹配区域的实际缩进平移 new_string
 * - Unicode 保留：策略 7 命中时保留文件原有 Unicode 字符
 */

/** 匹配结果 */
export interface FuzzyMatchResult {
  /** 是否成功 */
  success: boolean;
  /** 替换后的完整内容（失败时为原 content） */
  newContent: string;
  /** 匹配次数 */
  matchCount: number;
  /** 命中的策略名 */
  strategy: FuzzyStrategy | null;
  /** 错误信息 */
  error: string | null;
}

/** 9 种策略名 */
export type FuzzyStrategy =
  | "exact"
  | "line_trimmed"
  | "whitespace_normalized"
  | "indentation_flexible"
  | "escape_normalized"
  | "trimmed_boundary"
  | "unicode_normalized"
  | "block_anchor"
  | "context_aware";

/** 匹配位置 [start, end) */
type Match = [number, number];

/** Unicode → ASCII 归一化映射 */
const UNICODE_MAP: Record<string, string> = {
  "\u201c": '"', "\u201d": '"',  // 智能双引号
  "\u2018": "'", "\u2019": "'",  // 智能单引号
  "\u2014": "--", "\u2013": "-", // em-dash / en-dash
  "\u2026": "...",                // 省略号
  "\u00a0": " ",                  // 不间断空格
};

function unicodeNormalize(text: string): string {
  let out = text;
  for (const [from, to] of Object.entries(UNICODE_MAP)) {
    out = out.split(from).join(to);
  }
  return out;
}

/** 行首空白 */
function leadingWhitespace(line: string): string {
  const m = line.match(/^[ \t]*/);
  return m ? m[0] : "";
}

/** 公共缩进量（空格数，tab 算 4） */
function commonIndent(lines: string[]): number {
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const ws = leadingWhitespace(line);
    let n = 0;
    for (const ch of ws) n += ch === "\t" ? 4 : 1;
    if (n < min) min = n;
  }
  return min === Infinity ? 0 : min;
}

/** 缩进平移：将 new_string 的缩进对齐到 targetIndent */
function reindent(text: string, targetIndent: string): string {
  const lines = text.split("\n");
  const srcIndent = commonIndent(lines.filter(l => l.trim() !== ""));
  if (srcIndent === 0 && !targetIndent) return text;
  return lines
    .map((line) => {
      if (line.trim() === "") return "";
      let consumed = 0;
      let stripped = "";
      for (const ch of line) {
        if (consumed >= srcIndent) { stripped = line.slice(consumed); break; }
        const step = ch === "\t" ? 4 : 1;
        if (consumed + step > srcIndent) break;
        consumed += step;
        stripped = line.slice(consumed);
      }
      return targetIndent + stripped;
    })
    .join("\n");
}

// ── 9 策略实现 ────────────────────────────────────────────

/** 1. exact — 直接字符串比较 */
function strategyExact(content: string, oldStr: string): Match[] {
  const matches: Match[] = [];
  let from = 0;
  while (true) {
    const idx = content.indexOf(oldStr, from);
    if (idx === -1) break;
    matches.push([idx, idx + oldStr.length]);
    from = idx + 1;
  }
  return matches;
}

/** 2. line_trimmed — 每行去首尾空白后比较 */
function strategyLineTrimmed(content: string, oldStr: string): Match[] {
  return findViaLineNormalization(content, oldStr, (line) => line.trim());
}

/** 3. whitespace_normalized — 多空白折叠为单空格 */
function strategyWhitespaceNormalized(content: string, oldStr: string): Match[] {
  const norm = (s: string) => s.replace(/\s+/g, " ");
  return findViaLineNormalization(content, oldStr, norm);
}

/** 4. indentation_flexible — 忽略缩进差异 */
function strategyIndentationFlexible(content: string, oldStr: string): Match[] {
  const norm = (s: string) => s.replace(/^[ \t]+/gm, "");
  return findViaStringMatch(norm(content), norm(oldStr), content);
}

/** 5. escape_normalized — `\n` 字面量转真换行 */
function strategyEscapeNormalized(content: string, oldStr: string): Match[] {
  if (!oldStr.includes("\\n") && !oldStr.includes("\\t")) return [];
  const unescaped = oldStr
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
  return strategyExact(content, unescaped);
}

/** 6. trimmed_boundary — 仅首尾行去空白 */
function strategyTrimmedBoundary(content: string, oldStr: string): Match[] {
  const oldLines = oldStr.split("\n");
  if (oldLines.length <= 1) return [];
  const firstTrimmed = oldLines[0].trim();
  const lastTrimmed = oldLines[oldLines.length - 1].trim();
  const middle = oldLines.slice(1, -1).join("\n");

  const lines = content.split("\n");
  const matches: Match[] = [];
  let charIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === firstTrimmed) {
      // 寻找结束行
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === lastTrimmed) {
          // 检查中间内容是否匹配（行级相似度 > 0.7）
          const middleLines = lines.slice(i + 1, j);
          if (middle && middleLines.length > 0) {
            const actual = middleLines.join("\n");
            const sim = similarity(middle, actual);
            if (sim < 0.7) continue;
          }
          const start = charIdx;
          const end = charIdx + lines.slice(i, j + 1).join("\n").length;
          matches.push([start, end]);
          break;
        }
      }
    }
    charIdx += lines[i].length + 1;
  }
  return matches;
}

/** 7. unicode_normalized — 智能引号/em-dash 等 Unicode 归一化 */
function strategyUnicodeNormalized(content: string, oldStr: string): Match[] {
  const normContent = unicodeNormalize(content);
  const normOld = unicodeNormalize(oldStr);
  if (normContent === content && normOld === oldStr) return [];
  return findViaStringMatch(normContent, normOld, content);
}

/** 8. block_anchor — 首尾行锚定 + 中间相似度 */
function strategyBlockAnchor(content: string, oldStr: string): Match[] {
  const oldLines = oldStr.split("\n");
  if (oldLines.length < 3) return [];
  const firstLine = oldLines[0].trim();
  const lastLine = oldLines[oldLines.length - 1].trim();

  const lines = content.split("\n");
  const matches: Match[] = [];
  let charIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== firstLine) { charIdx += lines[i].length + 1; continue; }
    for (let j = i + oldLines.length - 1; j < lines.length; j++) {
      if (lines[j].trim() !== lastLine) continue;
      const actual = lines.slice(i, j + 1).join("\n");
      const sim = similarity(oldStr, actual);
      if (sim >= 0.6) {
        const start = charIdx;
        const end = start + actual.length;
        matches.push([start, end]);
      }
      break;
    }
    charIdx += lines[i].length + 1;
  }
  return matches;
}

/** 9. context_aware — 50% 行相似度阈值 */
function strategyContextAware(content: string, oldStr: string): Match[] {
  const oldLines = oldStr.split("\n");
  const lines = content.split("\n");
  const matches: Match[] = [];
  let charIdx = 0;
  for (let i = 0; i <= lines.length - oldLines.length; i++) {
    let matched = 0;
    for (let k = 0; k < oldLines.length; k++) {
      if (similarity(oldLines[k], lines[i + k]) >= 0.5) matched++;
    }
    if (matched / oldLines.length >= 0.5) {
      const block = lines.slice(i, i + oldLines.length).join("\n");
      matches.push([charIdx, charIdx + block.length]);
    }
    charIdx += lines[i].length + 1;
  }
  return matches;
}

// ── 工具函数 ──────────────────────────────────────────────

/** 行级归一化匹配 */
function findViaLineNormalization(
  content: string,
  oldStr: string,
  normalize: (s: string) => string,
): Match[] {
  const contentLines = content.split("\n");
  const oldLines = oldStr.split("\n");
  if (oldLines.length === 0 || oldLines.length > contentLines.length) return [];

  const normOldLines = oldLines.map(normalize);
  const matches: Match[] = [];
  let charIdx = 0;

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let allMatch = true;
    for (let k = 0; k < oldLines.length; k++) {
      if (normalize(contentLines[i + k]) !== normOldLines[k]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      const block = contentLines.slice(i, i + oldLines.length).join("\n");
      matches.push([charIdx, charIdx + block.length]);
    }
    charIdx += contentLines[i].length + 1;
  }
  return matches;
}

/** 归一化字符串匹配，返回原 content 的位置区间 */
function findViaStringMatch(
  normContent: string,
  normOld: string,
  origContent: string,
): Match[] {
  // 简化：归一化后位置一一对应（仅适用于字符级归一化，不改变长度的情况）
  if (normContent === origContent) {
    return strategyExact(normContent, normOld);
  }
  // 对于长度不变的归一化（如 Unicode→ASCII 多对一），用归一化后做 indexOf
  // 然后通过累计偏移映射回原 content。这里保守处理：仅当长度不变时使用。
  if (normContent.length !== origContent.length) return [];
  const matches: Match[] = [];
  let from = 0;
  while (true) {
    const idx = normContent.indexOf(normOld, from);
    if (idx === -1) break;
    matches.push([idx, idx + normOld.length]);
    from = idx + 1;
  }
  return matches;
}

/** SequenceMatcher 风格的相似度（0-1） */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  // 简化 LCS 比率
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return 0;
  const dp: number[] = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    let prev = 0;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev + 1;
      } else {
        dp[j] = Math.max(dp[j], dp[j - 1]);
      }
      prev = tmp;
    }
  }
  return (2 * dp[n]) / (m + n);
}

/** escape-drift 检测 */
function detectEscapeDrift(
  content: string,
  matches: Match[],
  oldStr: string,
  newStr: string,
): string | null {
  if (!newStr.includes("\\'") && !newStr.includes('\\"')) return null;
  const matchedRegions = matches.map(([s, e]) => content.slice(s, e)).join("");
  for (const suspect of ["\\'", '\\"'] as const) {
    if (newStr.includes(suspect) && oldStr.includes(suspect) && !matchedRegions.includes(suspect)) {
      const plain = suspect[1];
      return (
        `Escape-drift detected: old_string 和 new_string 都包含字面序列 ${JSON.stringify(suspect)}，` +
        `但文件匹配区域不包含该序列。这通常是工具调用序列化时为 ${JSON.stringify(plain)} 添加了多余反斜杠。` +
        `请重新读取文件后传入不含反斜杠转义的 old_string/new_string。`
      );
    }
  }
  return null;
}

/** 应用替换 */
function applyReplacements(
  content: string,
  matches: Match[],
  newStr: string,
  keepIndent: boolean,
): string {
  if (matches.length === 0) return content;
  const parts: string[] = [];
  let last = 0;
  for (const [start, end] of matches) {
    parts.push(content.slice(last, start));
    if (keepIndent) {
      // 提取匹配区域的实际缩进
      const matched = content.slice(start, end);
      const firstLine = matched.split("\n")[0];
      const indent = leadingWhitespace(firstLine);
      parts.push(reindent(newStr, indent));
    } else {
      parts.push(newStr);
    }
    last = end;
  }
  parts.push(content.slice(last));
  return parts.join("");
}

/** Unicode 保留：对策略 7 命中时，将 new_string 中被归一化的字符还原为文件中的原字符 */
function preserveUnicodeInReplacement(
  content: string,
  matches: Match[],
  oldStr: string,
  newStr: string,
): string {
  if (matches.length === 0) return newStr;
  const [start, end] = matches[0];
  const matchedRegion = content.slice(start, end);
  // 仅在 new_string 中保留 ASCII 等价的部分；其他部分使用文件原字符
  // 简化：若 new_string 与 old_string 仅在 ASCII 部分不同，保留 Unicode 区域
  let result = newStr;
  for (const [unicode, ascii] of Object.entries(UNICODE_MAP)) {
    if (matchedRegion.includes(unicode) && newStr.includes(ascii)) {
      // new_string 中的 ASCII 等价字符替换为文件的 Unicode 字符（仅在 old_string 也含 ASCII 等价字符的位置）
      result = result.split(ascii).join(unicode);
    }
  }
  return result;
}

// ── 主入口 ────────────────────────────────────────────────

/**
 * 多策略模糊查找并替换。
 *
 * @param content 原始文件内容
 * @param oldString 要查找的文本
 * @param newString 替换文本
 * @param replaceAll 是否替换所有匹配（默认 false，要求唯一匹配）
 */
export function fuzzyFindAndReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): FuzzyMatchResult {
  if (!oldString) {
    return { success: false, newContent: content, matchCount: 0, strategy: null, error: "old_string 不能为空" };
  }
  if (oldString === newString) {
    return { success: false, newContent: content, matchCount: 0, strategy: null, error: "old_string 和 new_string 相同" };
  }

  const strategies: Array<{ name: FuzzyStrategy; fn: (c: string, o: string) => Match[] }> = [
    { name: "exact", fn: strategyExact },
    { name: "line_trimmed", fn: strategyLineTrimmed },
    { name: "whitespace_normalized", fn: strategyWhitespaceNormalized },
    { name: "indentation_flexible", fn: strategyIndentationFlexible },
    { name: "escape_normalized", fn: strategyEscapeNormalized },
    { name: "trimmed_boundary", fn: strategyTrimmedBoundary },
    { name: "unicode_normalized", fn: strategyUnicodeNormalized },
    { name: "block_anchor", fn: strategyBlockAnchor },
    { name: "context_aware", fn: strategyContextAware },
  ];

  for (const { name, fn } of strategies) {
    const matches = fn(content, oldString);
    if (matches.length === 0) continue;

    if (matches.length > 1 && !replaceAll) {
      return {
        success: false,
        newContent: content,
        matchCount: 0,
        strategy: null,
        error: `找到 ${matches.length} 处匹配。请提供更多上下文使其唯一，或使用 replace_all=true。`,
      };
    }

    // escape-drift 检测（非 exact 策略时）
    if (name !== "exact") {
      const driftErr = detectEscapeDrift(content, matches, oldString, newString);
      if (driftErr) {
        return { success: false, newContent: content, matchCount: 0, strategy: null, error: driftErr };
      }
    }

    // 应用替换（非 exact 策略时进行缩进对齐）
    let effectiveNew = newString;
    if (name === "unicode_normalized") {
      effectiveNew = preserveUnicodeInReplacement(content, matches, oldString, newString);
    }
    const newContent = applyReplacements(content, matches, effectiveNew, name !== "exact");

    return {
      success: true,
      newContent,
      matchCount: matches.length,
      strategy: name,
      error: null,
    };
  }

  return {
    success: false,
    newContent: content,
    matchCount: 0,
    strategy: null,
    error: "未能在文件中找到 old_string 的匹配（所有 9 种策略均失败）",
  };
}

/** 仅查找（不替换），返回所有匹配位置 */
export function fuzzyFind(content: string, oldString: string): { matches: Match[]; strategy: FuzzyStrategy | null } {
  const strategies: Array<{ name: FuzzyStrategy; fn: (c: string, o: string) => Match[] }> = [
    { name: "exact", fn: strategyExact },
    { name: "line_trimmed", fn: strategyLineTrimmed },
    { name: "whitespace_normalized", fn: strategyWhitespaceNormalized },
    { name: "indentation_flexible", fn: strategyIndentationFlexible },
    { name: "escape_normalized", fn: strategyEscapeNormalized },
    { name: "trimmed_boundary", fn: strategyTrimmedBoundary },
    { name: "unicode_normalized", fn: strategyUnicodeNormalized },
    { name: "block_anchor", fn: strategyBlockAnchor },
    { name: "context_aware", fn: strategyContextAware },
  ];
  for (const { name, fn } of strategies) {
    const matches = fn(content, oldString);
    if (matches.length > 0) return { matches, strategy: name };
  }
  return { matches: [], strategy: null };
}
