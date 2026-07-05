/**
 * ApplyPatchTool — 通用 SEARCH/REPLACE patch 应用工具
 *
 * 复用 packages/skills/src/patch-applier.ts 的核心逻辑，但适配为通用工具。
 * 不依赖 @evoclaw/skills，避免循环依赖。
 *
 * 设计要点：
 *   - parsePatch 支持标准 SEARCH/REPLACE 块格式 + 简化版 unified diff
 *   - applyPatch 两阶段：Phase 1 计算所有新内容，Phase 2 原子写盘
 *   - 4-pass 匹配：exact → rstrip → strip → unicode normalize + strip
 *   - 路径安全检查：resolve + startsWith + realpath 验证（防 symlink 逃逸）
 *   - tmp 文件名加 .${pid}.${timestamp}.tmp 防并发覆盖
 *   - 失败时找相似度 > 0.6 的行作为 hint
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface PatchHunk {
  relativePath: string;
  search: string;
  replace: string;
}

export interface PatchResult {
  success: boolean;
  appliedHunks: number;
  failedHunks: number;
  errors: Array<{ path: string; reason: string }>;
}

// ── Unicode 归一化 ───────────────────────────────────────────

const UNICODE_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/\u2018/g, "'"],
  [/\u2019/g, "'"],
  [/\u201C/g, '"'],
  [/\u201D/g, '"'],
  [/\u2014/g, "-"],
  [/\u2013/g, "-"],
  [/\u00A0/g, " "],
  [/\u2026/g, "..."],
  [/\u3000/g, " "],
  [/\uFEFF/g, ""],
];

function normalizeUnicode(text: string): string {
  let result = text;
  for (const [pattern, replacement] of UNICODE_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ── parsePatch ───────────────────────────────────────────────

/**
 * 解析 SEARCH/REPLACE 块或简化版 unified diff。
 *
 * SEARCH/REPLACE 格式：
 *   <<<<<<< SEARCH path/to/file
 *   ...search...
 *   =======
 *   ...replace...
 *   >>>>>>> REPLACE
 *
 * Unified diff（简化）：
 *   --- a/path
 *   +++ b/path
 *   @@ -x,y +x,y @@
 *    context
 *   -old
 *   +new
 */
export function parsePatch(patchText: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  const lines = patchText.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // SEARCH/REPLACE 块
    const srMatch = line.match(/^<<<<<<<\s+SEARCH\s+(\S+)/);
    if (srMatch) {
      const relativePath = srMatch[1];
      const searchLines: string[] = [];
      const replaceLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("=======")) {
        searchLines.push(lines[i]);
        i++;
      }
      i++; // 跳过 =======
      while (i < lines.length && !lines[i].startsWith(">>>>>>>")) {
        replaceLines.push(lines[i]);
        i++;
      }
      i++; // 跳过 >>>>>>> REPLACE
      hunks.push({
        relativePath,
        search: searchLines.join("\n"),
        replace: replaceLines.join("\n"),
      });
      continue;
    }

    // Unified diff
    if (line.startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
      const oldPath = parseDiffPath(line.slice(4));
      const newPath = parseDiffPath(lines[i + 1].slice(4));
      const relativePath = newPath || oldPath;
      i += 2;
      while (i < lines.length && lines[i].startsWith("@@")) {
        const result = parseUnifiedHunk(lines, i);
        hunks.push({ relativePath, search: result.search, replace: result.replace });
        i = result.nextI;
      }
      continue;
    }

    i++;
  }

  return hunks;
}

function parseDiffPath(s: string): string {
  let p = s.trim();
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  return p;
}

function parseUnifiedHunk(
  lines: string[],
  startI: number,
): { search: string; replace: string; nextI: number } {
  const searchLines: string[] = [];
  const replaceLines: string[] = [];
  let i = startI + 1; // 跳过 @@ 行
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) break;
    if (line.startsWith("+")) {
      replaceLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      searchLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      searchLines.push(line.slice(1));
      replaceLines.push(line.slice(1));
    } else if (line === "") {
      searchLines.push("");
      replaceLines.push("");
    } else {
      break;
    }
    i++;
  }
  return { search: searchLines.join("\n"), replace: replaceLines.join("\n"), nextI: i };
}

// ── applyPatch ───────────────────────────────────────────────

/** 应用 patch：两阶段，先全验证再写盘 */
export async function applyPatch(
  workspaceRoot: string,
  hunks: PatchHunk[],
): Promise<PatchResult> {
  const errors: Array<{ path: string; reason: string }> = [];
  const contentCache = new Map<string, string>();
  const plannedWrites = new Map<string, string>();
  let appliedHunks = 0;
  let failedHunks = 0;

  // Phase 1: 计算所有新内容
  for (const hunk of hunks) {
    const absPath = path.resolve(workspaceRoot, hunk.relativePath);

    if (!isPathSafe(workspaceRoot, absPath)) {
      errors.push({
        path: hunk.relativePath,
        reason: `Path escape detected: ${hunk.relativePath} resolves outside workspace`,
      });
      failedHunks++;
      continue;
    }

    let content: string;
    if (contentCache.has(absPath)) {
      content = contentCache.get(absPath) ?? "";
    } else {
      try {
        content = fs.readFileSync(absPath, "utf-8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        errors.push({
          path: hunk.relativePath,
          reason: code === "ENOENT" ? `File not found: ${hunk.relativePath}` : `Read error: ${String(err)}`,
        });
        failedHunks++;
        continue;
      }
    }

    const result = seekAndReplace(content, hunk.search, hunk.replace);
    if (!result.found) {
      const hint = result.hint ? ` (similar: ${result.hint})` : "";
      errors.push({
        path: hunk.relativePath,
        reason: `SEARCH block not found${hint}`,
      });
      failedHunks++;
      continue;
    }

    contentCache.set(absPath, result.newContent);
    plannedWrites.set(absPath, result.newContent);
    appliedHunks++;
  }

  // 有错误时不写盘（保守策略）
  if (errors.length > 0) {
    return { success: false, appliedHunks: 0, failedHunks, errors };
  }

  // Phase 2: 原子写盘（逐文件捕获错误，避免部分写入后 unhandled rejection）
  const writeErrors: Array<{ path: string; reason: string }> = [];
  for (const [absPath, newContent] of plannedWrites) {
    try {
      await atomicWriteFile(absPath, newContent);
    } catch (err) {
      writeErrors.push({
        path: path.relative(workspaceRoot, absPath),
        reason: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  if (writeErrors.length > 0) {
    return { success: false, appliedHunks: 0, failedHunks: writeErrors.length, errors: writeErrors };
  }

  return { success: true, appliedHunks, failedHunks: 0, errors: [] };
}

// ── 4-pass 匹配 ──────────────────────────────────────────────

interface SeekResult {
  found: boolean;
  newContent: string;
  hint: string | null;
}

function seekAndReplace(content: string, search: string, replace: string): SeekResult {
  if (!search) return { found: false, newContent: content, hint: null };

  // Pass 1: exact substring
  const idx = content.indexOf(search);
  if (idx >= 0) {
    const newContent = content.slice(0, idx) + replace + content.slice(idx + search.length);
    return { found: true, newContent, hint: null };
  }

  const contentLines = content.split("\n");
  const searchLines = search.split("\n");

  // Pass 2: rstrip（行尾去空白）
  {
    const pos = findSubarray(contentLines, searchLines, (a, b) => a.replace(/\s+$/, "") === b.replace(/\s+$/, ""));
    if (pos >= 0) return makeReplace(contentLines, pos, searchLines.length, replace);
  }

  // Pass 3: strip（首尾去空白）
  {
    const pos = findSubarray(contentLines, searchLines, (a, b) => a.trim() === b.trim());
    if (pos >= 0) return makeReplace(contentLines, pos, searchLines.length, replace);
  }

  // Pass 4: Unicode 归一化 + strip
  {
    const pos = findSubarray(contentLines, searchLines, (a, b) => normalizeUnicode(a).trim() === normalizeUnicode(b).trim());
    if (pos >= 0) return makeReplace(contentLines, pos, searchLines.length, replace);
  }

  return { found: false, newContent: content, hint: findSimilarLine(content, search) };
}

function makeReplace(
  contentLines: string[],
  pos: number,
  searchLen: number,
  replace: string,
): SeekResult {
  const newLines = [
    ...contentLines.slice(0, pos),
    ...replace.split("\n"),
    ...contentLines.slice(pos + searchLen),
  ];
  return { found: true, newContent: newLines.join("\n"), hint: null };
}

function findSubarray(
  haystack: string[],
  needle: string[],
  eq: (a: string, b: string) => boolean,
): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (!eq(haystack[i + j], needle[j])) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

// ── 相似行 hint ──────────────────────────────────────────────

function findSimilarLine(content: string, search: string): string | null {
  const contentLines = content.split("\n");
  const searchLines = search.split("\n").filter((l) => l.trim().length > 0);
  if (searchLines.length === 0) return null;

  let bestLine: string | null = null;
  let bestSim = 0;
  for (const cl of contentLines) {
    if (!cl.trim()) continue;
    for (const sl of searchLines) {
      const sim = similarity(cl, sl);
      if (sim > bestSim) {
        bestSim = sim;
        bestLine = cl;
      }
    }
  }
  return bestSim > 0.6 ? bestLine : null;
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length, 1);
  const dist = levenshtein(a, b, 200);
  return 1 - dist / maxLen;
}

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

// ── 路径安全检查 ─────────────────────────────────────────────

function isPathSafe(workspaceRoot: string, absPath: string): boolean {
  const normalizedRoot = path.resolve(workspaceRoot);
  if (!absPath.startsWith(normalizedRoot + path.sep) && absPath !== normalizedRoot) {
    return false;
  }
  // realpath 验证（防 symlink 逃逸）
  try {
    const realAbs = fs.realpathSync(absPath);
    const realRoot = fs.realpathSync(normalizedRoot);
    return realAbs.startsWith(realRoot + path.sep) || realAbs === realRoot;
  } catch {
    // 文件不存在时 realpath 失败，保留前缀检查结果
    return true;
  }
}

// ── 原子写入 ─────────────────────────────────────────────────

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`;
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
