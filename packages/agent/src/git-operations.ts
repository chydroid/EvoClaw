/**
 * GitOperations — Git 操作封装
 *
 * 通过 child_process.execFile 调用 git 命令（不依赖外部 git CLI 库）。
 *
 * 设计要点：
 *   - execFile 不经过 shell，避免 cwd 含元字符时的命令注入风险
 *   - 危险命令拦截：push --force 需显式 force=true；reset --hard / clean -fd / branch -D 直接拒绝
 *   - porcelain v1 解析 status、--pretty=format + --numstat 解析 log、-p 解析 blame
 *   - 所有 Promise 失败时抛 Error，错误信息含 git stderr
 */

import { execFile } from "node:child_process";

export interface GitOptions {
  cwd: string;
  maxBuffer?: number;
  timeoutMs?: number;
}

export interface GitDiffResult {
  files: Array<{
    path: string;
    status: "added" | "modified" | "deleted" | "renamed";
    insertions: number;
    deletions: number;
  }>;
  totalInsertions: number;
  totalDeletions: number;
}

export interface GitLogEntry {
  hash: string;
  author: string;
  email: string;
  date: string;
  message: string;
  filesChanged: number;
}

export interface GitBlameLine {
  hash: string;
  author: string;
  date: string;
  line: number;
  content: string;
}

export interface GitStatusEntry {
  path: string;
  staged: "modified" | "added" | "deleted" | "renamed" | "untracked";
  unstaged: "modified" | "added" | "deleted" | "untracked" | null;
}

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export class GitOperations {
  private readonly cwd: string;
  private readonly maxBuffer: number;
  private readonly timeoutMs: number;

  constructor(opts: GitOptions) {
    if (!opts.cwd) throw new Error("GitOptions.cwd is required");
    this.cwd = opts.cwd;
    this.maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 执行 git 子命令，失败抛出含 stderr 的 Error */
  private async run(args: string[]): Promise<string> {
    // assertSafe 在 async 函数中抛错 → Promise 自动 reject（调用方可用 await/rejects 捕获）
    assertSafe(args);
    return new Promise((resolve, reject) => {
      const cb = (err: Error | null, stdout?: string, stderr?: string): void => {
        if (err) {
          const stderrText = (stderr ?? "").trim();
          reject(new Error(`git ${args.join(" ")} failed: ${stderrText || err.message}`));
        } else {
          resolve(stdout ?? "");
        }
      };
      execFile(
        "git",
        ["-C", this.cwd, ...args],
        {
          cwd: this.cwd,
          maxBuffer: this.maxBuffer,
          timeout: this.timeoutMs,
          windowsHide: true,
          encoding: "utf-8",
        },
        cb,
      );
    });
  }

  async status(): Promise<GitStatusEntry[]> {
    return parsePorcelainV1(await this.run(["status", "--porcelain=v1"]));
  }

  async diff(target?: string, staged?: boolean): Promise<string> {
    const args = ["diff"];
    if (staged) args.push("--staged");
    if (target) args.push(target);
    return this.run(args);
  }

  async diffStat(target?: string): Promise<GitDiffResult> {
    const args = ["diff", "--numstat"];
    if (target) args.push(target);
    return parseNumstat(await this.run(args));
  }

  async log(maxCount?: number): Promise<GitLogEntry[]> {
    const args = ["log", "--pretty=format:%H|%an|%ae|%ad|%s", "--date=iso", "--numstat"];
    if (typeof maxCount === "number" && maxCount > 0) {
      args.push("-n", String(maxCount));
    }
    return parseLog(await this.run(args));
  }

  async blame(filePath: string, startLine?: number, endLine?: number): Promise<GitBlameLine[]> {
    const args = ["blame", "-p"];
    if (typeof startLine === "number" && typeof endLine === "number") {
      args.push("-L", `${startLine},${endLine}`);
    } else if (typeof startLine === "number") {
      args.push("-L", `${startLine},`);
    }
    args.push("--", filePath);
    return parseBlame(await this.run(args));
  }

  async show(ref: string, filePath?: string): Promise<string> {
    const args = ["show", ref];
    if (filePath) args.push("--", filePath);
    return this.run(args);
  }

  async branch(): Promise<{ current: string; branches: string[] }> {
    const out = await this.run(["branch"]);
    const branches: string[] = [];
    let current = "";
    for (const raw of out.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("* ")) {
        current = line.slice(2).trim();
        branches.push(current);
      } else {
        branches.push(line);
      }
    }
    return { current, branches };
  }

  async add(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.run(["add", "--", ...paths]);
  }

  async commit(message: string, amend?: boolean): Promise<string> {
    const args = ["commit", "-m", message];
    if (amend) args.push("--amend");
    return this.run(args);
  }

  async push(remote?: string, branch?: string, force?: boolean): Promise<void> {
    const args = ["push"];
    if (force) {
      console.warn(`[GitOperations] push --force 即将执行（cwd=${this.cwd}）`);
      args.push("--force");
    }
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    await this.run(args);
  }

  async pull(remote?: string, branch?: string): Promise<void> {
    const args = ["pull"];
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    await this.run(args);
  }

  async checkout(target: string, createBranch?: boolean): Promise<void> {
    const args = ["checkout"];
    if (createBranch) args.push("-b");
    args.push(target);
    await this.run(args);
  }

  async merge(target: string): Promise<void> {
    await this.run(["merge", target]);
  }

  async rebase(target: string): Promise<void> {
    await this.run(["rebase", target]);
  }
}

// ── 危险命令拦截 ──────────────────────────────────────────────

/** 检查命令序列中是否含禁止项，命中即抛错 */
function assertSafe(args: string[]): void {
  const joined = args.join(" ");
  if (/\breset\b.*--hard\b/.test(joined)) {
    throw new Error("reset --hard is not allowed");
  }
  if (/\bclean\b/.test(joined) && /(^|\s)-[a-zA-Z]*f/.test(joined) && /(^|\s)-[a-zA-Z]*d/.test(joined)) {
    throw new Error("clean -fd is not allowed");
  }
  if (/\bbranch\b.*\s-D\b/.test(joined)) {
    throw new Error("branch -D is not allowed");
  }
}

// ── porcelain v1 status 解析 ─────────────────────────────────

function xToStatus(x: string): GitStatusEntry["staged"] | null {
  switch (x) {
    case "M": return "modified";
    case "A": return "added";
    case "D": return "deleted";
    case "R":
    case "C": return "renamed";
    case "?": return "untracked";
    default: return null;
  }
}

function yToStatus(y: string): GitStatusEntry["unstaged"] {
  switch (y) {
    case "M": return "modified";
    case "D": return "deleted";
    case "A": return "added";
    case "?": return "untracked";
    default: return null;
  }
}

/** 解析 porcelain v1 status 输出（行格式 `XY path`，重命名为 `XY newpath -> oldpath`） */
function parsePorcelainV1(out: string): GitStatusEntry[] {
  const result: GitStatusEntry[] = [];
  for (const raw of out.split("\n")) {
    if (raw.length < 3 || raw[2] !== " ") continue;
    const x = raw[0];
    const y = raw[1];
    let pathPart = raw.slice(3);
    const arrowIdx = pathPart.indexOf(" -> ");
    if (arrowIdx >= 0) pathPart = pathPart.slice(0, arrowIdx);
    if (!pathPart) continue;

    let staged: GitStatusEntry["staged"];
    let unstaged: GitStatusEntry["unstaged"];
    if (x === "?" && y === "?") {
      staged = "untracked";
      unstaged = null;
    } else {
      const sx = xToStatus(x);
      const sy = yToStatus(y);
      if (sx) {
        staged = sx;
      } else if (sy) {
        // X 为空（无 staged 改动）但有 unstaged 改动：用 "untracked" 作占位
        staged = "untracked";
      } else {
        continue;
      }
      unstaged = sy;
    }
    result.push({ path: pathPart, staged, unstaged });
  }
  return result;
}

// ── diff --numstat 解析 ──────────────────────────────────────

/** 解析 `insertions\tdeletions\tpath` 输出（二进制为 `-\t-\tpath`） */
function parseNumstat(out: string): GitDiffResult {
  const files: GitDiffResult["files"] = [];
  let totalInsertions = 0;
  let totalDeletions = 0;
  for (const line of out.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const ins = parts[0] === "-" ? 0 : parseInt(parts[0], 10);
    const del = parts[1] === "-" ? 0 : parseInt(parts[1], 10);
    if (Number.isNaN(ins) || Number.isNaN(del)) continue;
    const filePath = parts.slice(2).join("\t");
    const status: GitDiffResult["files"][number]["status"] =
      ins > 0 && del === 0 ? "added" : del > 0 && ins === 0 ? "deleted" : "modified";
    files.push({ path: filePath, status, insertions: ins, deletions: del });
    totalInsertions += ins;
    totalDeletions += del;
  }
  return { files, totalInsertions, totalDeletions };
}

// ── log --pretty + --numstat 解析 ────────────────────────────

/** 在 s 中找第一个 sep，返回前后两部分 */
function splitOnce(s: string, sep: string): { head: string; tail: string } | null {
  const i = s.indexOf(sep);
  if (i < 0) return null;
  return { head: s.slice(0, i), tail: s.slice(i + sep.length) };
}

/** 解析 log 输出（每个 commit 一个块：header 行 + numstat 行，块间空行分隔） */
function parseLog(out: string): GitLogEntry[] {
  const entries: GitLogEntry[] = [];
  const blocks = out.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const header = lines[0];
    const p1 = splitOnce(header, "|");
    if (!p1) continue;
    const hash = p1.head;
    const p2 = splitOnce(p1.tail, "|");
    if (!p2) continue;
    const author = p2.head;
    const p3 = splitOnce(p2.tail, "|");
    if (!p3) continue;
    const email = p3.head;
    const p4 = splitOnce(p3.tail, "|");
    if (!p4) continue;
    const date = p4.head;
    const message = p4.tail;

    let filesChanged = 0;
    for (const ns of lines.slice(1)) {
      const seg = ns.split("\t");
      if (seg.length >= 3) filesChanged++;
    }
    entries.push({ hash, author, email, date, message, filesChanged });
  }
  return entries;
}

// ── blame -p (porcelain) 解析 ────────────────────────────────

/**
 * 解析 git blame -p 输出。
 *
 * 每个 chunk 结构：
 *   `<hash> <orig-line> <final-line>`
 *   `author <name>`
 *   `author-mail <<email>>`
 *   `author-time <unix-seconds>`
 *   `author-tz <timezone>`
 *   `summary <subject>`
 *   `\t<content>`
 */
function parseBlame(out: string): GitBlameLine[] {
  const result: GitBlameLine[] = [];
  const lines = out.split("\n");
  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    if (!header) { i++; continue; }
    const m = header.match(/^([0-9a-f]+)\s+(\d+)\s+(\d+)/);
    if (!m) { i++; continue; }
    const hash = m[1];
    const finalLine = parseInt(m[3], 10);
    let author = "";
    let date = "";
    let content = "";
    let j = i + 1;
    while (j < lines.length) {
      const ln = lines[j];
      if (ln.startsWith("\t")) {
        content = ln.slice(1);
        j++;
        break;
      }
      if (ln.startsWith("author ")) {
        author = ln.slice("author ".length);
      } else if (ln.startsWith("author-time ")) {
        const t = parseInt(ln.slice("author-time ".length), 10);
        date = Number.isNaN(t) ? "" : new Date(t * 1000).toISOString();
      }
      j++;
    }
    result.push({ hash, author, date, line: finalLine, content });
    i = j;
  }
  return result;
}
