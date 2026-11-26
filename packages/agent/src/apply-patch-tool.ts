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
import { isAlreadyApplied } from "./fuzzy-match";

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
  /** 已落盘（重发的同一 patch）而未实际写盘的 hunk 数 */
  alreadyAppliedHunks?: number;
  note?: string;
}

/**
 * 写盘回调：每个成功落盘的文件调用一次（绝对路径 + 新全文）。
 *
 * ★ 2026-11-26 取证（v28-t4 / v26-t4 / v26-t9 实证）：apply_patch 写盘后
 *   从不更新 FileStateRegistry / ReadTracker 的记账，于是同一会话紧接着
 *   `file_write action=modify` 会被「was modified outside this session since
 *   you last read it (mtime)」拒绝——文件明明是本会话自己刚 patch 的，
 *   却被判成外部改动。模型只能先 file_read 整个文件再重试（3 次调用白烧）。
 *   hermes 在 `_note_edited` 里对每个 patch 目标做 note_write + 刷新读戳，
 *   这里用回调把同样的记账交给调用方（工具层持有 sessionId 与两个 registry）。
 */
export type PatchWriteObserver = (absPath: string, newContent: string) => void;

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
    // 注意：非贪婪 `(.+?)\s*$` 兼容 CRLF（split("\n") 后行尾残留 \r）与尾部空格。
    // ★ 2026-11-26 容错（会话取证）：模型写过的变体——`<<< SEARCH`（3 尖角，
    //   v26-t9 / v28-t5 / v32-t5）、`SEARCH /path` 裸头（v32-t6）、
    //   `<<<<<<< SEARCH path /x`（path 后空格而非冒号，v28-t5）。
    //   旧正则只认 `<<<<<<< SEARCH`，这些整份 patch 解析为 0 hunk，报
    //   "No valid hunks parsed" —— 格式错误伪装成工具故障，模型只能重发。
    const srMatch = line.match(/^(?:<{3,}\s*)?SEARCH(?:\s+(.+?))?\s*$/i);
    if (srMatch) {
      const headerPath = srMatch[1] ? cleanPatchPath(srMatch[1]) : undefined;
      let relativePath = headerPath ?? curFile ?? "";
      if (headerPath) curFile = headerPath;
      const searchLines: string[] = [];
      const replaceLines: string[] = [];
      i++;
      // ★ 2026-11-26 容错（v26-t9 实证）：模型把路径写在 SEARCH 头的**下一行**
      //   （`<<< SEARCH` / `path: /x/gql.py` / 正文…）。旧实现把这一行当成
      //   search 正文的一部分，结果 relativePath 为空 →「SEARCH 块未指定目标
      //   文件路径」，参数其实完全够用。头后紧跟的 path 行既认作路径、也不计入正文。
      if (!headerPath) {
        const nextLine = lines[i] ?? "";
        // 必须带显式分隔符（`path:` / `path=`）且长得像路径（含 `/` 或文件扩展名），
        // 避免把正文首行 `path = os.path.join(a, b)` 当成目标文件。
        const pathLine = nextLine.match(/^\s*path\s*[:=]\s*(\S.*?)\s*$/i);
        const candidate = pathLine ? cleanPatchPath(pathLine[1]) : "";
        if (candidate && (candidate.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(candidate))) {
          relativePath = candidate;
          curFile = candidate;
          i++;
        }
      }
      while (i < lines.length && !lines[i].startsWith("=======")) {
        searchLines.push(lines[i]);
        i++;
      }
      i++; // 跳过 =======
      // 收尾标记同样容错：`>>> REPLACE`（3 尖角，v26-t9 / v32-t5 实证）
      // 与 `>>> /abs/path`（v32-t5）都要认；只认 7 尖角会把 REPLACE 正文
      // 一路吞到 patch 末尾。
      while (i < lines.length && !/^>{3,}/.test(lines[i])) {
        replaceLines.push(lines[i]);
        i++;
      }
      // ★ 2026-11-26 容错（v32-t5 实证）：收尾行写成 `>>> /abs/path`（模型把路径
      //   塞在 REPLACE 标记后面）。块内没有任何路径声明时，这就是唯一的目标文件线索。
      const terminator = lines[i] ?? "";
      if (!relativePath) {
        const tail = terminator.replace(/^>{3,}\s*/, "").trim();
        const tailPath = tail.replace(/^REPLACE\b\s*/i, "").trim();
        if (tailPath) {
          const candidate = cleanPatchPath(tailPath);
          if (candidate.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(candidate)) {
            relativePath = candidate;
            curFile = candidate;
          }
        }
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
  // `SEARCH path:/x`（模型常写）与 `SEARCH path /x`（v28-t5 实证）两种前缀都剥
  if (/^path\s*:\s*/i.test(p)) p = p.replace(/^path\s*:\s*/i, "");
  else if (/^path\s+/i.test(p)) p = p.replace(/^path\s+/i, "");
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  return p.trim();
}

/**
 * 解析 patch 头声明的目标文件为绝对路径（对齐 hermes
 * `_rewrite_v4a_patch_paths_for_host`：头部路径先落成宿主真实路径，后续读写
 * 不再二次按各自 cwd 猜）。
 *
 * 四级候选，全部带「存在性」判别（同 file-tools 的 stripWorkspacePrefix 语义，
 * 只改写真实存在的候选，绝不把新文件挪走）：
 * 1. 原样按工作区根解析（正常语义）；
 * 2. 模型多带了 `data/workspace/` 前缀（v29-t4 / v29b-t3 / v29d-t3 / v29f-t3
 *    实证：5 次 `File not found: data/workspace/v29-t4/x.js`）；
 * 3. unified diff 的 `a/` `b/` 前缀剥掉后开头的 `/` 也没了
 *    （`--- a/home/chy/...` → `home/chy/...`，v26-t3/v26-t9/v32-t6 实证 6 次
 *    `File not found: home/chy/...`）——若 `/ + rel` 存在，按绝对路径还原；
 * 4. 裸文件名（`*** Update File: sqleng.py`）——模型的 cwd 是工作区下的任务
 *    子目录，patch 头却只写了文件名（v26-t4 / v27-t1 / v27-t10 / v30-t1 实证
 *    5 次 `File not found: httpparser.py / datalog.py / mustache.py / sqleng.py`）。
 *    在工作区内按文件名做**唯一**匹配；有歧义就不猜（保持原解析，交错误信息）。
 */
function resolveHunkPath(workspaceRoot: string, rel: string): string {
  const direct = path.resolve(workspaceRoot, rel);
  if (path.isAbsolute(rel) || fs.existsSync(direct)) return direct;
  const posix = rel.replace(/\\/g, "/");
  const lower = posix.toLowerCase();
  if (lower.startsWith("data/workspace/")) {
    const stripped = path.resolve(workspaceRoot, posix.slice("data/workspace/".length));
    if (fs.existsSync(stripped)) return stripped;
  }
  if (!posix.startsWith("/")) {
    const recovered = path.resolve(path.sep + posix);
    if (fs.existsSync(recovered)) return recovered;
  }
  // 裸文件名唯一匹配（只在没有目录成分时尝试，避免把带子目录的路径乱指）
  if (!posix.includes("/")) {
    const unique = findUniqueBasename(workspaceRoot, posix);
    if (unique) return unique;
  }
  return direct;
}

/** 在工作区内按文件名查找唯一匹配（跳过依赖/构建目录，有上限防大仓库卡顿） */
function findUniqueBasename(root: string, basename: string): string | null {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "__pycache__"]);
  const MAX_ENTRIES = 20000;
  const MAX_DEPTH = 8;
  let seen = 0;
  let found: string | null = null;
  let ambiguous = false;
  const walk = (dir: string, depth: number): void => {
    if (ambiguous || depth > MAX_DEPTH || seen > MAX_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (ambiguous || seen++ > MAX_ENTRIES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.name === basename) {
        if (found === null) found = full;
        else {
          ambiguous = true;
          return;
        }
      }
    }
  };
  walk(root, 0);
  return ambiguous ? null : found;
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
  onWrite?: PatchWriteObserver,
): Promise<PatchResult> {
  const errors: Array<{ path: string; reason: string }> = [];
  const contentCache = new Map<string, string>();
  const plannedWrites = new Map<string, string>();
  let appliedHunks = 0;
  let failedHunks = 0;
  let alreadyAppliedHunks = 0;

  // Phase 1: 计算所有新内容
  for (const hunk of hunks) {
    // ★ 2026-11-06：SEARCH 块路径缺失时明确报错（避免空字符串被当成工作区自身的
    //   边角语义，把 patch 写成不可理解的错误）。格式与错误一并给出，模型下轮即可修正。
    if (!hunk.relativePath) {
      errors.push({
        path: "(unspecified)",
        reason:
          "SEARCH 块未指定目标文件路径：需要 <<<<<<< SEARCH path/to/file，或位于 *** Update File: path/to/file / --- a/path 之后" +
          "（也可把路径单独写在 SEARCH 头下一行 `path: /abs/file`，或在收尾行写 `>>> REPLACE /abs/file`）。" +
          "若只是想改文件里的几行，改调 file_write action=edit + path + old_string + new_string 更省事。",
      });
      failedHunks++;
      continue;
    }

    const absPath = resolveHunkPath(workspaceRoot, hunk.relativePath);

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
          reason:
            code === "ENOENT"
              ? `File not found: ${hunk.relativePath}（按工作区根解析为 ${absPath}）。` +
                "patch 头里的路径请用「相对工作区根」的写法（如 v30-t1/sqleng.py），或直接给绝对路径；" +
                "也可改用 file_write action=edit + path + old_string/new_string。"
              : `Read error: ${String(err)}`,
        });
        failedHunks++;
        continue;
      }
    }

    const result = seekAndReplace(content, hunk.search, hunk.replace);
    if (!result.found) {
      // 已落盘检测（hermes patch_parser 的两阶段一致性）：上一次 patch 其实
      // 已经生效、模型又发了一遍时，报「SEARCH 未命中」会把模型推去重读/重发。
      // 保守判据同 fuzzy-match 的 isAlreadyApplied。
      if (isAlreadyApplied(content, hunk.search, hunk.replace)) {
        alreadyAppliedHunks++; // 语义上已经达成，不写盘
        continue;
      }
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
      continue;
    }
    // 写盘成功 → 通知调用方记账（否则后续 modify 会被误判为「外部改动」）。
    // 记账失败不撤销已完成的写盘，只跳过。
    if (onWrite) {
      try {
        onWrite(absPath, newContent);
      } catch {
        /* 记账失败不阻断 patch 结果 */
      }
    }
  }
  if (writeErrors.length > 0) {
    return { success: false, appliedHunks: 0, failedHunks: writeErrors.length, errors: writeErrors };
  }

  const result: PatchResult = { success: true, appliedHunks, failedHunks: 0, errors: [] };
  if (alreadyAppliedHunks > 0) {
    result.alreadyAppliedHunks = alreadyAppliedHunks;
    result.note =
      `${alreadyAppliedHunks} 个 hunk 的目标文本**已在文件中**（上一次 patch 已生效），本次未重复写盘。` +
      "不要重发同一 patch。";
  }
  return result;
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


