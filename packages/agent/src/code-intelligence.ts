/**
 * CodeIntelligence — 基于正则 + 启发式的代码智能
 *
 * 不依赖 tree-sitter 等外部库，零依赖。
 *
 * 设计要点：
 *   - 按扩展名映射语言；每语言一组正则匹配函数/类/方法/接口/类型定义
 *   - parseSymbols 用 mtime 缓存，避免重复解析
 *   - searchSymbols 模糊匹配 name（contains 或 Levenshtein ≤ 2），按 score 排序
 *   - findReferences 用 \b{name}\b 全局扫描，排除注释行
 *   - planRename/applyRename 实现安全重命名（跳过注释/字符串行）
 *   - 写入采用原子模式（temp + fsync + rename）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "@evoclaw/infrastructure";

export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "method" | "interface" | "type" | "variable" | "import";
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  signature?: string;
}

export interface CodeSearchResult {
  symbol: CodeSymbol;
  snippet: string;
  score: number;
}

export interface ReferenceResult {
  filePath: string;
  line: number;
  column: number;
  lineContent: string;
}

export interface RenamePlan {
  oldName: string;
  newName: string;
  changes: Array<{
    filePath: string;
    changes: Array<{ line: number; column: number; oldText: string; newText: string }>;
  }>;
  totalOccurrences: number;
}

const MAX_FILES_SCAN = 1000;
const MAX_SEARCH_RESULTS = 50;

// 文件扩展名 → 语言映射
const EXT_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript",
  ".js": "javascript", ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c", ".h": "c",
  ".cpp": "c++", ".hpp": "c++", ".cc": "c++", ".cxx": "c++",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".cs": "csharp",
  ".sh": "bash", ".bash": "bash",
  ".md": "markdown",
  ".json": "json",
  ".yaml": "yaml", ".yml": "yaml",
};

interface SymbolPattern {
  kind: CodeSymbol["kind"];
  regex: RegExp;
}

// 每语言符号定义模式（顺序敏感：更具体的放前面）
const PATTERNS: Record<string, SymbolPattern[]> = {
  typescript: [
    { kind: "function", regex: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/ },
    { kind: "class", regex: /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\s*[<{]/ },
    { kind: "interface", regex: /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\s*\{/ },
    { kind: "type", regex: /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
    { kind: "variable", regex: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/ },
  ],
  javascript: [
    { kind: "function", regex: /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/ },
    { kind: "class", regex: /\bclass\s+([A-Za-z_$][\w$]*)\s*[<{]/ },
    { kind: "variable", regex: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/ },
  ],
  python: [
    { kind: "method", regex: /\bdef\s+([A-Za-z_][\w]*)\s*\(self/ },
    { kind: "function", regex: /\bdef\s+([A-Za-z_][\w]*)\s*\(/ },
    { kind: "class", regex: /\bclass\s+([A-Za-z_][\w]*)\s*[:\(]/ },
  ],
  go: [
    { kind: "function", regex: /\bfunc\s+([A-Za-z_][\w]*)\s*\(/ },
    { kind: "interface", regex: /\btype\s+([A-Za-z_][\w]*)\s+interface\b/ },
    { kind: "type", regex: /\btype\s+([A-Za-z_][\w]*)\s+struct\b/ },
  ],
  rust: [
    { kind: "function", regex: /\bfn\s+([A-Za-z_][\w]*)\s*\(/ },
    { kind: "class", regex: /\bstruct\s+([A-Za-z_][\w]*)\s*[<{]/ },
    { kind: "interface", regex: /\btrait\s+([A-Za-z_][\w]*)\s*\{/ },
    { kind: "type", regex: /\btype\s+([A-Za-z_][\w]*)\s*=/ },
  ],
};

const GENERIC_PATTERNS: SymbolPattern[] = [
  { kind: "function", regex: /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/ },
  { kind: "class", regex: /\bclass\s+([A-Za-z_$][\w$]*)\s*[\{(]/ },
];

// 缓存：filePath → {mtime, symbols}
interface CacheEntry {
  mtime: number;
  symbols: CodeSymbol[];
}

export class CodeIntelligence {
  private static readonly CACHE_LIMIT = 500;
  private readonly symbolCache = new Map<string, CacheEntry>();

  constructor(private readonly workspaceRoot: string) {}

  /** 断言 target 解析后位于 workspaceRoot 内，返回绝对路径 */
  private assertWithinWorkspace(target: string): string {
    const abs = path.resolve(this.workspaceRoot, target);
    const root = path.resolve(this.workspaceRoot);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`Path escapes workspace: ${target}`);
    }
    return abs;
  }

  /** 写入缓存，超过上限时按 mtime 淘汰最旧条目 */
  private cacheSet(key: string, entry: CacheEntry): void {
    this.symbolCache.set(key, entry);
    if (this.symbolCache.size > CodeIntelligence.CACHE_LIMIT) {
      let oldestKey: string | null = null;
      let oldestMtime = Infinity;
      for (const [k, v] of this.symbolCache) {
        if (v.mtime < oldestMtime) {
          oldestMtime = v.mtime;
          oldestKey = k;
        }
      }
      if (oldestKey) this.symbolCache.delete(oldestKey);
    }
  }

  /** 清空符号缓存 */
  clearCache(): void {
    this.symbolCache.clear();
  }

  detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    return EXT_LANG[ext] ?? "unknown";
  }

  async parseSymbols(filePath: string): Promise<CodeSymbol[]> {
    const abs = this.assertWithinWorkspace(filePath);
    const stat = await fs.promises.stat(abs);
    const cached = this.symbolCache.get(abs);
    if (cached && cached.mtime === stat.mtimeMs) return cached.symbols;

    const content = await fs.promises.readFile(abs, "utf-8");
    const language = this.detectLanguage(abs);
    const symbols = extractSymbols(content, abs, language);
    this.cacheSet(abs, { mtime: stat.mtimeMs, symbols });
    return symbols;
  }

  async searchSymbols(
    query: string,
    language?: string,
    maxResults?: number,
  ): Promise<CodeSearchResult[]> {
    if (!query) return [];
    const limit = Math.min(maxResults ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
    const files = await collectSourceFiles(this.workspaceRoot, MAX_FILES_SCAN);
    const results: CodeSearchResult[] = [];

    for (const file of files) {
      const lang = this.detectLanguage(file);
      if (language && lang !== language) continue;
      const symbols = await this.parseSymbols(file);
      if (symbols.length === 0) continue;

      const content = await fs.promises.readFile(file, "utf-8");
      const lines = content.split("\n");
      for (const sym of symbols) {
        const score = scoreMatch(sym.name, query);
        if (score <= 0) continue;
        const snippet = lines[sym.startLine - 1] ?? "";
        results.push({ symbol: sym, snippet, score });
      }
      if (results.length >= limit * 2) break;
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async findReferences(symbolName: string, filePath?: string): Promise<ReferenceResult[]> {
    if (!symbolName) return [];
    const pattern = new RegExp(`\\b${escapeRegex(symbolName)}\\b`, "g");
    const results: ReferenceResult[] = [];

    if (filePath) {
      const abs = this.assertWithinWorkspace(filePath);
      await scanFileForReferences(abs, pattern, results);
      return results;
    }

    const files = await collectSourceFiles(this.workspaceRoot, MAX_FILES_SCAN);
    for (const file of files) {
      await scanFileForReferences(file, pattern, results);
    }
    return results;
  }

  async planRename(oldName: string, newName: string, filePath?: string): Promise<RenamePlan> {
    if (filePath) this.assertWithinWorkspace(filePath);
    const refs = await this.findReferences(oldName, filePath);
    const changesByFile = new Map<string, RenamePlan["changes"][number]["changes"]>();

    for (const ref of refs) {
      // 启发式：跳过注释行或 oldName 出现在字符串字面量内的行
      if (shouldSkipForRename(ref.lineContent, this.detectLanguage(ref.filePath), oldName)) continue;
      const fileChanges = changesByFile.get(ref.filePath) ?? [];
      fileChanges.push({
        line: ref.line,
        column: ref.column,
        oldText: oldName,
        newText: newName,
      });
      changesByFile.set(ref.filePath, fileChanges);
    }

    const changes: RenamePlan["changes"] = [];
    for (const [fp, fileChanges] of changesByFile) {
      changes.push({ filePath: fp, changes: fileChanges });
    }
    return {
      oldName,
      newName,
      changes,
      totalOccurrences: changes.reduce((sum, c) => sum + c.changes.length, 0),
    };
  }

  async applyRename(plan: RenamePlan): Promise<{ filesChanged: number; occurrences: number }> {
    let filesChanged = 0;
    let occurrences = 0;
    const pattern = new RegExp(`\\b${escapeRegex(plan.oldName)}\\b`, "g");

    for (const fileChange of plan.changes) {
      const abs = this.assertWithinWorkspace(fileChange.filePath);
      let content: string;
      try {
        content = await fs.promises.readFile(abs, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      const lang = this.detectLanguage(abs);
      let fileOcc = 0;
      const newLines: string[] = [];

      for (const line of lines) {
        if (shouldSkipForRename(line, lang, plan.oldName)) {
          newLines.push(line);
          continue;
        }
        const matches = line.match(pattern);
        if (matches && matches.length > 0) {
          fileOcc += matches.length;
          newLines.push(line.replace(pattern, plan.newName));
        } else {
          newLines.push(line);
        }
      }

      if (fileOcc > 0) {
        await atomicWriteFile(abs, newLines.join("\n"));
        filesChanged++;
        occurrences += fileOcc;
      }
    }
    return { filesChanged, occurrences };
  }
}

// ── 辅助函数 ──────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSymbols(content: string, filePath: string, language: string): CodeSymbol[] {
  const lines = content.split("\n");
  const patterns = PATTERNS[language] ?? GENERIC_PATTERNS;
  const symbols: CodeSymbol[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { kind, regex } of patterns) {
      const m = line.match(regex);
      if (!m || !m[1]) continue;
      const name = m[1];
      const key = `${kind}:${name}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const endLine = findBlockEnd(lines, i, language);
      symbols.push({
        name,
        kind,
        filePath,
        startLine: i + 1,
        endLine: endLine + 1,
        language,
        signature: line.trim(),
      });
    }
  }
  return symbols;
}

/** 剥离字符串字面量与行注释，保留长度（替换为空格），避免字符串/注释内的花括号被误统计 */
function stripStringsAndComments(line: string, language: string): string {
  let result = "";
  let i = 0;
  let inString: '"' | "'" | "`" | null = null;
  let escape = false;
  while (i < line.length) {
    const ch = line[i];
    if (inString) {
      if (escape) {
        escape = false;
        result += " ";
      } else if (ch === "\\") {
        escape = true;
        result += " ";
      } else if (ch === inString) {
        inString = null;
        result += " ";
      } else {
        result += " ";
      }
    } else {
      // 行注释：JS/TS/Rust/Go/C/C++/Java 等使用 //
      if (
        (language === "javascript" ||
          language === "typescript" ||
          language === "rust" ||
          language === "go" ||
          language === "c" ||
          language === "c++" ||
          language === "java" ||
          language === "csharp" ||
          language === "kotlin" ||
          language === "swift") &&
        ch === "/" &&
        line[i + 1] === "/"
      ) {
        result += " ".repeat(line.length - i);
        break;
      }
      // Python/Shell/Ruby 行注释
      if (ch === "#") {
        result += " ".repeat(line.length - i);
        break;
      }
      // 字符串开始
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
        result += " ";
      } else {
        result += ch;
      }
    }
    i++;
  }
  return result;
}

function findBlockEnd(lines: string[], startLine: number, language: string): number {
  const bracedLangs = new Set([
    "typescript", "javascript", "java", "csharp", "c++", "c",
    "rust", "go", "kotlin", "swift", "php",
  ]);
  if (bracedLangs.has(language)) {
    let depth = 0;
    let foundOpen = false;
    for (let i = startLine; i < lines.length; i++) {
      const stripped = stripStringsAndComments(lines[i], language);
      for (const ch of stripped) {
        if (ch === "{") {
          depth++;
          foundOpen = true;
        } else if (ch === "}") {
          depth--;
          if (foundOpen && depth === 0) return i;
        }
      }
    }
    return startLine;
  }
  if (language === "python") {
    const indent = lines[startLine].match(/^\s*/)?.[0].length ?? 0;
    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") continue;
      const curIndent = line.match(/^\s*/)?.[0].length ?? 0;
      if (curIndent <= indent && /^\s*(def|class)\b/.test(line)) {
        return i - 1;
      }
    }
    return lines.length - 1;
  }
  return startLine;
}

function scoreMatch(name: string, query: string): number {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return 10;
  if (n.startsWith(q)) return 5;
  if (n.includes(q)) return 3;
  if (levenshtein(n, q) <= 2) return 1;
  return 0;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  // 长度截断：超长字符串避免 O(m*n) 时间+内存 DoS
  const MAX_LEN = 200;
  if (a.length > MAX_LEN || b.length > MAX_LEN) {
    return Math.abs(a.length - b.length);
  }
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
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

/** 收集工作区源码文件（限制 maxFiles） */
async function collectSourceFiles(root: string, maxFiles: number): Promise<string[]> {
  const result: string[] = [];
  const skipDirs = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "vendor"]);

  async function walk(dir: string): Promise<void> {
    if (result.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext in EXT_LANG) result.push(full);
      }
    }
  }
  await walk(root);
  return result;
}

async function scanFileForReferences(
  filePath: string,
  pattern: RegExp,
  results: ReferenceResult[],
): Promise<void> {
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, "utf-8");
  } catch {
    return;
  }
  const lines = content.split("\n");
  const lang = path.extname(filePath).slice(1).toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line, lang)) continue;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      results.push({
        filePath,
        line: i + 1,
        column: match.index + 1,
        lineContent: line,
      });
      if (match.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }
}

function isCommentLine(line: string, _lang: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("<!--")
  );
}

/** 重命名时跳过注释行或 oldName 出现在字符串字面量内的行（启发式） */
function shouldSkipForRename(line: string, lang: string, oldName: string): boolean {
  if (isCommentLine(line, lang)) return true;
  // 检查 oldName 是否出现在字符串字面量（"..." / '...' / `...`）内
  const strLitPattern = /(["'`])(?:\\.|(?!\1).)*\1/g;
  let m: RegExpExecArray | null;
  while ((m = strLitPattern.exec(line)) !== null) {
    if (m[0].includes(oldName)) return true;
  }
  return false;
}


