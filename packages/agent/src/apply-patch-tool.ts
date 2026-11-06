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
import { atomicWriteFile } from "@evoclaw/infrastructure";

export interface PatchHunk {
  relativePath: string;
  search: string;
  replace: string;
  /** Add File 语义：search 恒为空，replace 即文件全量内容，直接覆盖写盘 */
  wholeFile?: boolean;
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
 * 解析 SEARCH/REPLACE 块、OpenAI `*** Begin Patch` 风格 patch，或简化版
 * unified diff。
 *
 * 支持三种格式：
 *
 * 1. SEARCH/REPLACE 块（路径可省略）：
 *    <<<<<<< SEARCH path/to/file
 *    ...search...
 *    =======
 *    ...replace...
 *    >>>>>>> REPLACE
 *    路径省略时（`<<<<<<< SEARCH` 后直接跟内容）沿用最近的
 *    `*** Update File: x` / `--- a/x` 头声明的目标文件。
 *
 * 2. OpenAI / Claude Code style：
 *    *** Begin Patch
 *    *** Update File: path/to/file
 *    @@ context @@
 *    context / -old / +new
 *    *** Add File: path/to/new
 *    full file content...
 *    *** End Patch
 *
 * 3. Unified diff（简化）：
 *    --- a/path
 *    +++ b/path
 *    @@ -x,y +x,y @@
 *     context
 *    -old
 *    +new
 *
 * 2026-11-06 修复：此前 SEARCH 头正则要求行内路径（`\s+(\S+)`），模型输出
 * 无路径块时整份 patch 解析为 0 hunk，工具报 "No valid hunks parsed from
 * patch text" 幽灵错误——会话存档中 8/19 次 apply_patch 调用死于该格式。
 * 现在无路径块沿游标取目标文件；全程无可判定路径时由 applyPatch 返回明确
 * 的格式错误（而不伪装成 "no hunks"）。
 */
export function parsePatch(patchText: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  const lines = patchText.split("\n");
  let i = 0;
  // 当前目标文件游标：`*** Update File` / `--- a/x` 头或带路径的 SEARCH 头
  // 声明后，后续无路径 SEARCH 块沿用它。
  let curFile: string | undefined;

  while (i < lines.length) {
    const line = lines[i];

    // ── OpenAI style：*** Begin / Update File / Add File / End Patch ──
    if (line === "*** Begin Patch" || line === "*** End Patch") {
      i++;
      continue;
    }
    const afMatch = line.match(/^\*\*\* (?:Update|Add) File:\s*(.+)$/);
    if (afMatch) {
      const relativePath = cleanPatchPath(afMatch[1]);
      curFile = relativePath;
      i++;
      if (line.includes("Add")) {
        // Add File：后续行直到下一个 *** 标记即全量内容
        const body: string[] = [];
        while (i < lines.length && !lines[i].startsWith("*** ")) {
          body.push(lines[i]);
          i++;
        }
        hunks.push({ relativePath, search: "", replace: body.join("\n"), wholeFile: true });
        continue;
      }
      while (i < lines.length && lines[i].startsWith("@@")) {
        const result = parseUnifiedHunk(lines, i);
        hunks.push({ relativePath, search: result.search, replace: result.replace });
        i = result.nextI;
      }
      continue;
    }

    // SEARCH/REPLACE 块（路径可省略，缺省沿用 curFile 游标）
    // 注意：非贪婪 `(.+?)\s*$` 兼容 CRLF（split("\n") 后行尾残留 \r）与尾部空格
    const srMatch = line.match(/^<<<<<<<\s+SEARCH(?:\s+(.+?))?\s*$/);
    if (srMatch) {
      const headerPath = srMatch[1] ? cleanPatchPath(srMatch[1]) : undefined;
      const relativePath = headerPath ?? curFile ?? "";
      if (headerPath) curFile = headerPath;
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
      curFile = relativePath;
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

/**
 * 清理 patch 头里的路径写法：去掉 `path:` 前缀（模型常写成
 * `SEARCH path:/home/...`）与 unified diff 的 `a/` `b/` 前缀。
 */
function cleanPatchPath(s: string): string {
  let p = s.trim();
  if (p.startsWith("path:")) p = p.slice("path:".length);
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  return p;
}

function parseDiffPath(s: string): string {
  return cleanPatchPath(s);
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
    if (line.startsWith("\\")) { i++; continue; } // `\ No newline at end of file`
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
    // ★ 2026-11-06：SEARCH 块路径缺失时明确报错（避免空字符串被当成工作区自身的
    //   边角语义，把 patch 写成不可理解的错误）。格式与错误一并给出，模型下轮即可修正。
    if (!hunk.relativePath) {
      errors.push({
        path: "(unspecified)",
        reason: "SEARCH 块未指定目标文件路径：需要 <<<<<<< SEARCH path/to/file，或位于 *** Update File: path/to/file / --- a/path 之后",
      });
      failedHunks++;
      continue;
    }

    const absPath = path.resolve(workspaceRoot, hunk.relativePath);

    if (!isPathSafe(workspaceRoot, absPath)) {
      errors.push({
        path: hunk.relativePath,
        reason: `Path escape detected: ${hunk.relativePath} resolves outside workspace`,
      });
      failedHunks++;
      continue;
    }

    // Add File（OpenAI 风格整文件写入）：文件已存在则拒绝，与惯例一致
    if (hunk.wholeFile && !hunk.search) {
      if (fs.existsSync(absPath)) {
        errors.push({
          path: hunk.relativePath,
          reason: `File already exists: ${hunk.relativePath}（Add File 拒绝覆盖已有文件，改用 Update File / SEARCH/REPLACE）`,
        });
        failedHunks++;
        continue;
      }
      plannedWrites.set(absPath, hunk.replace);
      appliedHunks++;
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
    // 文件不存在时（create 场景）：校验父目录 realpath，防止通过符号链接父目录逃逸
    try {
      const parentDir = path.dirname(absPath);
      const realParent = fs.realpathSync(parentDir);
      const realRoot = fs.realpathSync(normalizedRoot);
      return realParent.startsWith(realRoot + path.sep) || realParent === realRoot;
    } catch {
      // 父目录也不存在，保留前缀检查结果（后续 ensureDir 会创建）
      return true;
    }
  }
}


