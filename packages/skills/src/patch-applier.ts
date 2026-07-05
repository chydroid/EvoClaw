/**
 * PatchApplier — 技能内容补丁应用器
 *
 * 借鉴 OpenSpace skill_engine/patch.py：
 *   - 4 pass seek_sequence（exact → rstrip → strip → Unicode 归一化 + strip）
 *   - 块锚定匹配（首末行锚 + 中间 Levenshtein 加权平均）
 *   - 类似行建议错误诊断（difflib.SequenceMatcher > 0.6）
 *   - 两阶段原子应用（先全验证再写盘，不留半改状态）
 *   - 路径逃逸安全检查（resolve() 必须 startswith skill_dir）
 *   - End-of-File 标记支持（*** End of File）
 *
 * EvoClaw 落地点：
 *   - skill-curator.ts 应用 LLM 生成的 SEARCH/REPLACE 块时使用
 *   - skill-workshop.ts 技能编辑器应用补丁时使用
 */

import * as fs from "fs";
import * as path from "path";

// ── 原子写入（同 lineage-store.ts 风格） ───────────────────────

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  // 使用进程 ID + 随机后缀避免多进程并发时 tmp 文件互相覆盖
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeFileSync(fd, content, { encoding: "utf-8" });
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// ── Unicode 归一化（借鉴 OpenSpace _normalize_unicode） ────────

const UNICODE_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/\u2018/g, "'"], // 左单引号
  [/\u2019/g, "'"], // 右单引号
  [/\u201C/g, '"'], // 左双引号
  [/\u201D/g, '"'], // 右双引号
  [/\u2014/g, "-"], // em-dash
  [/\u2013/g, "-"], // en-dash
  [/\u00A0/g, " "], // NBSP
  [/\u2026/g, "..."], // 省略号
  [/\u3000/g, " "], // 全角空格
  [/\uFEFF/g, ""], // BOM
];

function normalizeUnicode(text: string): string {
  let result = text;
  for (const [pattern, replacement] of UNICODE_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ── 类型定义 ──────────────────────────────────────────────────

export interface SearchReplaceBlock {
  /** SEARCH 内容（要查找的原文） */
  search: string;
  /** REPLACE 内容（替换为） */
  replace: string;
  /** 是否在文件末尾追加 */
  isEndOfFile?: boolean;
}

export interface PatchHunk {
  /** 目标文件相对路径（相对 skill_dir） */
  relativePath: string;
  /** SEARCH/REPLACE 块列表 */
  blocks: SearchReplaceBlock[];
}

export interface PatchResult {
  /** 是否成功 */
  success: boolean;
  /** 应用的 hunk 数 */
  appliedHunks: number;
  /** 应用的 block 数 */
  appliedBlocks: number;
  /** 修改的文件列表（绝对路径） */
  modifiedFiles: string[];
  /** 错误信息（如果有） */
  errors: PatchError[];
}

export class PatchError extends Error {
  constructor(
    message: string,
    public readonly relativePath?: string,
    public readonly blockIndex?: number,
    public readonly similarLines?: Array<{ line: string; lineNum: number; similarity: number }>,
  ) {
    super(message);
    this.name = "PatchError";
  }
}

// ── 4 pass seek_sequence ──────────────────────────────────────

/**
 * 在 content 中查找 search 块的位置。
 *
 * 4 pass 策略（借鉴 OpenSpace patch.py seek_sequence）：
 *   1. exact: 完全匹配
 *   2. rstrip: 行尾去空白后匹配
 *   3. strip: 行首尾去空白后匹配
 *   4. unicode + strip: Unicode 归一化 + strip 后匹配
 *
 * @param content 文件内容
 * @param search 要查找的块
 * @param isEndOfFile 是否优先匹配文件末尾
 * @returns 起始行号（0-based），-1 表示未找到
 */
export function seekSequence(
  content: string,
  search: string,
  isEndOfFile: boolean = false,
): { lineNum: number; passUsed: number } {
  if (!search) return { lineNum: -1, passUsed: 0 };

  const contentLines = content.split("\n");
  const searchLines = search.split("\n");

  // Pass 1: exact
  {
    const lineNum = findExactMatch(contentLines, searchLines, isEndOfFile);
    if (lineNum >= 0) return { lineNum, passUsed: 1 };
  }

  // Pass 2: rstrip（行尾去空白）
  {
    const lineNum = findStrippedMatch(
      contentLines,
      searchLines,
      (s) => s.replace(/\s+$/, ""),
      isEndOfFile,
    );
    if (lineNum >= 0) return { lineNum, passUsed: 2 };
  }

  // Pass 3: strip（首尾去空白）
  {
    const lineNum = findStrippedMatch(
      contentLines,
      searchLines,
      (s) => s.trim(),
      isEndOfFile,
    );
    if (lineNum >= 0) return { lineNum, passUsed: 3 };
  }

  // Pass 4: Unicode 归一化 + strip
  {
    const lineNum = findStrippedMatch(
      contentLines,
      searchLines,
      (s) => normalizeUnicode(s).trim(),
      isEndOfFile,
    );
    if (lineNum >= 0) return { lineNum, passUsed: 4 };
  }

  return { lineNum: -1, passUsed: 0 };
}

function findExactMatch(
  contentLines: string[],
  searchLines: string[],
  isEndOfFile: boolean,
): number {
  const n = contentLines.length;
  const m = searchLines.length;
  if (m === 0 || m > n) return -1;

  // End-of-file 优先匹配末尾
  if (isEndOfFile) {
    const startFromEnd = n - m;
    if (startFromEnd >= 0 && isEqualRange(contentLines, searchLines, startFromEnd)) {
      return startFromEnd;
    }
  }

  for (let i = 0; i <= n - m; i++) {
    if (isEqualRange(contentLines, searchLines, i)) {
      return i;
    }
  }
  return -1;
}

function isEqualRange(contentLines: string[], searchLines: string[], start: number): boolean {
  for (let j = 0; j < searchLines.length; j++) {
    if (contentLines[start + j] !== searchLines[j]) return false;
  }
  return true;
}

function findStrippedMatch(
  contentLines: string[],
  searchLines: string[],
  normalize: (s: string) => string,
  isEndOfFile: boolean,
): number {
  const normContent = contentLines.map(normalize);
  const normSearch = searchLines.map(normalize);
  return findExactMatch(normContent, normSearch, isEndOfFile);
}

// ── 块锚定匹配（首末行锚 + 中间 Levenshtein） ─────────────────

/**
 * 块锚定匹配（借鉴 OpenSpace fuzzy_match.py block_anchor_replacer）。
 *
 * 适用于 ≥3 行的大块替换：
 *   - 首行 strip 后作为强锚点定位（必须严格相等）
 *   - 所有行（首、中、末）用 1 - dist/max_len 加权平均相似度
 *   - 相似度 ≥ threshold 才接受
 *
 * @returns 匹配的起始行号和相似度，未找到返回 { lineNum: -1, similarity: 0 }
 */
export function blockAnchorMatch(
  content: string,
  search: string,
  threshold: number = 0.7,
): { lineNum: number; similarity: number } {
  const contentLines = content.split("\n");
  const searchLines = search.split("\n");

  if (searchLines.length < 3) {
    return { lineNum: -1, similarity: 0 };
  }

  const firstAnchor = searchLines[0].trim();

  if (!firstAnchor) {
    return { lineNum: -1, similarity: 0 };
  }

  let bestMatch = { lineNum: -1, similarity: 0 };

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    // 首行强锚点：strip 后必须严格相等
    if (contentLines[i].trim() !== firstAnchor) continue;

    // 计算所有行（首、中、末）的加权平均相似度
    let totalSim = 0;
    let totalWeight = 0;
    for (let j = 0; j < searchLines.length; j++) {
      const contentLine = contentLines[i + j];
      const searchLine = searchLines[j];
      const maxLen = Math.max(contentLine.length, searchLine.length, 1);
      const dist = levenshtein(contentLine, searchLine);
      const sim = 1 - dist / maxLen;
      const weight = Math.max(searchLine.length, 1);
      totalSim += sim * weight;
      totalWeight += weight;
    }

    const avgSim = totalWeight > 0 ? totalSim / totalWeight : 1;
    if (avgSim >= threshold && avgSim > bestMatch.similarity) {
      bestMatch = { lineNum: i, similarity: avgSim };
    }
  }

  return bestMatch;
}

/**
 * 简化版 Levenshtein 距离（限制最大距离避免 O(n*m) 爆炸）。
 */
function levenshtein(a: string, b: string, maxDist: number = 100): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return Math.max(a.length, b.length);

  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

// ── 类似行建议错误诊断（借鉴 OpenSpace _find_similar_lines） ───

/**
 * 在 content 中找出与 searchLines 相似度 > 0.6 的行。
 *
 * 用于 SEARCH 失败时给 LLM 提示可能的匹配位置。
 */
export function findSimilarLines(
  content: string,
  search: string,
  maxResults: number = 3,
  threshold: number = 0.6,
): Array<{ line: string; lineNum: number; similarity: number }> {
  const contentLines = content.split("\n");
  const searchLines = search.split("\n").filter((l) => l.trim().length > 0);

  if (searchLines.length === 0) return [];

  const results: Array<{ line: string; lineNum: number; similarity: number }> = [];

  for (let i = 0; i < contentLines.length; i++) {
    const contentLine = contentLines[i];
    if (!contentLine.trim()) continue;

    // 找出与 contentLine 最相似的 searchLine
    let bestSim = 0;
    for (const searchLine of searchLines) {
      const maxLen = Math.max(contentLine.length, searchLine.length, 1);
      const dist = levenshtein(contentLine, searchLine, 200);
      const sim = 1 - dist / maxLen;
      if (sim > bestSim) bestSim = sim;
    }

    if (bestSim >= threshold) {
      results.push({ line: contentLine, lineNum: i + 1, similarity: bestSim });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, maxResults);
}

// ── 路径逃逸安全检查 ──────────────────────────────────────────

/**
 * 检查相对路径是否在 skillDir 内（防 ../../etc/passwd 逃逸 + symlink 逃逸）。
 */
export function isPathSafe(skillDir: string, relativePath: string): boolean {
  // 拒绝空路径或指向 skillDir 本身的路径
  if (!relativePath || relativePath === "." || relativePath === "./") {
    return false;
  }
  const resolved = path.resolve(skillDir, relativePath);
  const normalizedSkillDir = path.resolve(skillDir);
  // 基本前缀检查
  if (!resolved.startsWith(normalizedSkillDir + path.sep) && resolved !== normalizedSkillDir) {
    return false;
  }
  // 解析符号链接后再校验（防 symlink 指向外部）
  try {
    const realResolved = fs.realpathSync(resolved);
    const realSkillDir = fs.realpathSync(normalizedSkillDir);
    return (
      realResolved.startsWith(realSkillDir + path.sep) || realResolved === realSkillDir
    );
  } catch {
    // realpath 失败（文件不存在等）：保留前缀检查结果
    return true;
  }
}

// ── 应用单个 block ─────────────────────────────────────────────

function applyBlock(
  content: string,
  block: SearchReplaceBlock,
  blockIndex: number,
  relativePath: string,
): { newContent: string; passUsed: number; similarity: number } {
  // 1. 精确 + 模糊 4 pass 匹配
  const { lineNum, passUsed } = seekSequence(content, block.search, block.isEndOfFile);

  if (lineNum >= 0) {
    const contentLines = content.split("\n");
    const searchLines = block.search.split("\n");
    const replaced = [
      ...contentLines.slice(0, lineNum),
      ...block.replace.split("\n"),
      ...contentLines.slice(lineNum + searchLines.length),
    ];
    return { newContent: replaced.join("\n"), passUsed, similarity: 1 };
  }

  // 2. 块锚定匹配（≥3 行）
  if (block.search.split("\n").length >= 3) {
    const anchorMatch = blockAnchorMatch(content, block.search);
    if (anchorMatch.lineNum >= 0) {
      const contentLines = content.split("\n");
      const searchLines = block.search.split("\n");
      const replaced = [
        ...contentLines.slice(0, anchorMatch.lineNum),
        ...block.replace.split("\n"),
        ...contentLines.slice(anchorMatch.lineNum + searchLines.length),
      ];
      return {
        newContent: replaced.join("\n"),
        passUsed: 5, // 5 = 块锚定
        similarity: anchorMatch.similarity,
      };
    }
  }

  // 3. 匹配失败，给出类似行建议
  const similar = findSimilarLines(content, block.search);
  throw new PatchError(
    `SEARCH block not found in ${relativePath} (block #${blockIndex + 1})`,
    relativePath,
    blockIndex,
    similar,
  );
}

// ── 两阶段原子应用（先全验证再写盘） ───────────────────────────

/**
 * 应用多文件补丁。
 *
 * 两阶段策略（借鉴 OpenSpace _apply_multi_file_patch）：
 *   Phase 1: 遍历所有 hunk 计算新内容（含路径逃逸检查、文件存在检查）
 *   Phase 2: 全部成功后才写盘
 *
 * 任意 hunk 失败立即抛出，不会留下半改状态。
 */
export async function applyPatch(
  skillDir: string,
  hunks: PatchHunk[],
): Promise<PatchResult> {
  const errors: PatchError[] = [];
  // contentCache: 跟踪每个文件的当前内容，支持多 hunk 指向同文件时累积修改
  const contentCache = new Map<string, string>();
  const plannedWrites = new Map<string, string>();
  let appliedHunks = 0;
  let appliedBlocks = 0;
  const modifiedFilesSet = new Set<string>();

  // Phase 1: 验证并计算所有新内容
  for (const hunk of hunks) {
    // 路径逃逸检查
    if (!isPathSafe(skillDir, hunk.relativePath)) {
      errors.push(
        new PatchError(
          `Path escape detected: ${hunk.relativePath} resolves outside skill directory`,
          hunk.relativePath,
        ),
      );
      continue;
    }

    const absPath = path.resolve(skillDir, hunk.relativePath);

    // 从缓存或磁盘读取当前内容（支持多 hunk 同文件累积修改）
    let content: string;
    if (contentCache.has(absPath)) {
      content = contentCache.get(absPath)!;
    } else {
      try {
        content = fs.readFileSync(absPath, "utf-8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          errors.push(
            new PatchError(`File not found: ${hunk.relativePath}`, hunk.relativePath),
          );
        } else {
          errors.push(
            new PatchError(
              `Read error: ${String(err)}`,
              hunk.relativePath,
            ),
          );
        }
        continue;
      }
    }

    let blockSuccessCount = 0;

    for (let i = 0; i < hunk.blocks.length; i++) {
      const block = hunk.blocks[i];
      try {
        const result = applyBlock(content, block, i, hunk.relativePath);
        content = result.newContent;
        blockSuccessCount++;
      } catch (err) {
        if (err instanceof PatchError) {
          errors.push(err);
        } else {
          errors.push(
            new PatchError(
              `Unexpected error applying block: ${String(err)}`,
              hunk.relativePath,
              i,
            ),
          );
        }
        // 同文件的后续 block 仍然尝试（可能不依赖前面的 block）
      }
    }

    if (blockSuccessCount > 0) {
      contentCache.set(absPath, content);
      plannedWrites.set(absPath, content);
      modifiedFilesSet.add(absPath);
      appliedHunks++;
      appliedBlocks += blockSuccessCount;
    }
  }

  // 有错误时不写盘（保守策略）
  if (errors.length > 0) {
    return {
      success: false,
      appliedHunks: 0,
      appliedBlocks: 0,
      modifiedFiles: [],
      errors,
    };
  }

  // Phase 2: 原子写盘
  for (const [absPath, newContent] of plannedWrites) {
    await atomicWriteFile(absPath, newContent);
  }

  return {
    success: true,
    appliedHunks,
    appliedBlocks,
    modifiedFiles: Array.from(modifiedFilesSet),
    errors: [],
  };
}

// ── 单文件补丁便捷接口 ────────────────────────────────────────

/**
 * 对单文件应用 SEARCH/REPLACE 块。
 */
export async function applySearchReplaceBlocks(
  filePath: string,
  blocks: SearchReplaceBlock[],
): Promise<{ success: boolean; appliedBlocks: number; errors: PatchError[] }> {
  if (!fs.existsSync(filePath)) {
    return {
      success: false,
      appliedBlocks: 0,
      errors: [new PatchError(`File not found: ${filePath}`)],
    };
  }

  let content = fs.readFileSync(filePath, "utf-8");
  let appliedBlocks = 0;
  const errors: PatchError[] = [];

  for (let i = 0; i < blocks.length; i++) {
    try {
      const result = applyBlock(content, blocks[i], i, path.basename(filePath));
      content = result.newContent;
      appliedBlocks++;
    } catch (err) {
      if (err instanceof PatchError) {
        errors.push(err);
      } else {
        errors.push(new PatchError(`Unexpected error: ${String(err)}`, path.basename(filePath), i));
      }
    }
  }

  if (errors.length > 0) {
    return { success: false, appliedBlocks: 0, errors };
  }

  if (appliedBlocks > 0) {
    await atomicWriteFile(filePath, content);
  }

  return { success: true, appliedBlocks, errors };
}
