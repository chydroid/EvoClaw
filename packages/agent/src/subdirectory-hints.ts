/**
 * Subdirectory hints — 渐进式子目录上下文发现（对标 hermes agent/subdirectory_hints.py）。
 *
 * 不变量（只移植这些，不搬 hosted/desktop 专属管线）：
 *   - 当 agent 通过工具进入某子目录（读文件 / cd 进目录）时，加载该目录的项目上下文文件
 *     （AGENTS.md / CLAUDE.md / .cursorrules），**追加到工具结果**而非系统提示 → 缓存安全。
 *   - 每个目录首个命中的上下文文件生效（按优先级）。
 *   - 内容摘要去重：同一文件经 symlink/硬链/副本再次出现时不重复注入。
 *   - 祖先回溯（最多 5 层）：读 project/src/main.py 也能发现 project/AGENTS.md。
 *   - 路径必须落在 working_dir 树内（symlink 解析后仍在树内），否则绝不加载
 *     （防止把 ~/.claude/CLAUDE.md 或 .env 注进会话）。
 *   - working_dir 是「家目录样」时整体禁用（#76902：桌面端 cwd 落到 ~ 会把整棵 ~ 下
 *     的 AGENTS.md 全注入）。
 *   - 排除依赖/构建/缓存树（node_modules、vendor、dist…）里的副本。
 *   - 每文件上限 32K（头尾保留 + 路径标记）。
 *
 * 与 Hermes 的差异：
 *   - Hermes 的 hosted/沙箱（host_feature_enabled）/ safe_worker 管线不移植；
 *   - 内容安全扫描复用 `scanForThreats(content, "context")`（对标 Hermes `_scan_context_content`）：
 *     命中 prompt-injection 模式即阻止，内容不进入会话。
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanForThreats } from "@evoclaw/security";

/** 上下文文件候选（按优先级，每目录首个命中生效）。 */
export const HINT_FILENAMES: ReadonlyArray<string> = [
  "AGENTS.override.md",
  "AGENTS.md",
  "agents.md",
  "CLAUDE.md",
  "claude.md",
  ".cursorrules",
];

/** 每文件注入上限（32 KiB，对齐 Codex project_doc_max_bytes 默认）。 */
export const MAX_HINT_CHARS = 32_000;

/** 从工具参数里提取路径的键（与 EvoClaw 工具 schema 一致）。 */
export const PATH_ARG_KEYS: ReadonlyArray<string> = ["path", "file_path", "workdir"];

/** 视为「shell 工具」的名称集合（其 command 需解析 cd/pushd）。 */
export const COMMAND_TOOLS: ReadonlySet<string> = new Set([
  "shell_exec",
  "terminal",
  "bash",
  "exec",
]);

/** 祖先回溯层数上限（读 src/a/b/c.py 仍能发现上层 AGENTS.md）。 */
export const MAX_ANCESTOR_WALK = 5;

/** 依赖/构建/缓存树：其中的上下文文件是副本，不是权威源（对齐 search_policy prune）。 */
export const HINT_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  ".git", ".hg", ".svn",
  "node_modules", "venv", ".venv", "site-packages", "dist-packages",
  "vendor", "third_party",
  "build", "dist", "target", "out", "coverage",
  ".next", ".turbo", ".parcel-cache", ".nuxt", ".svelte-kit",
  "__pycache__",
]);

const SHELL_OPERATORS = new Set(["&&", "||", "|", ";", "&", ";;", "|&", "(", ")"]);
const NAV_COMMANDS = new Set(["cd", "pushd"]);

function digestOf(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/** working_dir 是否「家目录样」（桌面/容器回落到 ~ 或 /home、/root、/workspace）。 */
export function isHomeLikeWorkingDir(workingDir: string): boolean {
  try {
    const wd = path.resolve(workingDir);
    const home = path.resolve(os.homedir());
    if (wd === home) return true;
    const containerHomes = ["/home", "/root", "/workspace"].map((p) => path.resolve(p));
    if (containerHomes.includes(wd)) return true;
    if (containerHomes.includes(path.dirname(wd))) return true;
    // 本地沙箱把宿主 home 挂到某容器路径，basename 仍是用户名（.home/host-home/host_home）
    for (const part of wd.split(path.sep)) {
      if (part === ".home" || part === "host-home" || part === "host_home") return true;
    }
  } catch {
    return true; // 无法解析 → 保守禁用
  }
  return false;
}

/** 内容裁切：超上限保留头 + 尾 + 标记。 */
export function truncateHintContent(content: string, maxChars: number = MAX_HINT_CHARS): string {
  if (content.length <= maxChars) return content;
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = maxChars - headLen;
  const omitted = content.length - headLen - tailLen;
  return (
    content.slice(0, headLen) +
    `\n\n… [目录上下文已省略 ${omitted} 字符，可用 file_read 读取全文] …\n\n` +
    content.slice(content.length - tailLen)
  );
}

/** 目录内首个可读上下文文件（按优先级），返回 {path, content} 或 null。 */
export function firstHintFile(
  directory: string,
): { path: string; content: string } | null {
  for (const name of HINT_FILENAMES) {
    const candidate = path.join(directory, name);
    try {
      const real = fs.realpathSync(candidate);
      // 解析后目标仍须是上下文文件名：挡 `sub/AGENTS.md -> .env` 这类 symlink 注入
      // （Hermes 用 file_safety deny-list 达到同一目的）。
      if (!HINT_FILENAMES.includes(path.basename(real))) continue;
      if (!fs.statSync(real).isFile()) continue;
      const content = fs.readFileSync(real, "utf-8").replace(/^﻿/, "").trim();
      if (content.length > 0) return { path: candidate, content };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 子目录上下文追踪器。用法：每次工具调用后 `tracker.checkToolCall(name, args)`，
 * 返回的文本追加到工具结果。
 */
export class SubdirectoryHintTracker {
  private readonly workingDir: string;
  private readonly enabled: boolean;
  private readonly homeLike: boolean;
  private readonly loadedDirs: Set<string>;
  private readonly loadedDigests: Set<string>;

  constructor(workingDir?: string, opts: { enabled?: boolean } = {}) {
    this.enabled = opts.enabled ?? true;
    let wd: string;
    try {
      wd = path.resolve(workingDir ?? process.cwd());
    } catch {
      wd = path.resolve(process.cwd());
    }
    this.workingDir = wd;
    this.homeLike = isHomeLikeWorkingDir(wd);
    // working_dir 预标记已加载（启动上下文由 system prompt 处理）。
    this.loadedDirs = new Set([wd]);
    this.loadedDigests = new Set();
    const found = firstHintFile(wd);
    if (found) this.loadedDigests.add(digestOf(found.content));
  }

  isEnabled(): boolean {
    return this.enabled && !this.homeLike;
  }

  /** 重新锚定到新工作区（会话采纳新 workspace）。 */
  rebindWorkingDir(workingDir: string): void {
    let wd: string;
    try {
      wd = path.resolve(workingDir);
      if (!fs.statSync(wd).isDirectory() || isHomeLikeWorkingDir(wd)) return;
    } catch {
      return;
    }
    this.loadedDirs.clear();
    this.loadedDirs.add(wd);
    this.loadedDigests.clear();
    const found = firstHintFile(wd);
    if (found) this.loadedDigests.add(digestOf(found.content));
  }

  /** 返回新访问目录的提示文本（含前缀），或 null。 */
  checkToolCall(toolName: string, toolArgs: Record<string, unknown>): string | null {
    if (!this.isEnabled()) return null;
    const hints: string[] = [];
    for (const dir of this.extractDirectories(toolName, toolArgs)) {
      const hint = this.loadHintsForDirectory(dir);
      if (hint) hints.push(hint);
    }
    return hints.length > 0 ? "\n\n" + hints.join("\n\n") : null;
  }

  private extractDirectories(toolName: string, args: Record<string, unknown>): string[] {
    const candidates = new Set<string>();
    for (const key of PATH_ARG_KEYS) {
      const val = args[key];
      if (typeof val === "string" && val.trim()) this.addPathCandidate(val, candidates);
    }
    if (COMMAND_TOOLS.has(toolName)) {
      const cmd = args["command"];
      if (typeof cmd === "string") this.extractPathsFromCommand(cmd, candidates);
    }
    return Array.from(candidates);
  }

  private addPathCandidate(rawPath: string, candidates: Set<string>): void {
    try {
      let p = rawPath;
      if (!path.isAbsolute(p)) p = path.join(this.workingDir, p);
      let resolved = path.resolve(p);
      try {
        if (fs.statSync(resolved).isFile()) resolved = path.dirname(resolved);
      } catch {
        if (path.extname(resolved)) resolved = path.dirname(resolved);
      }
      for (let i = 0; i < MAX_ANCESTOR_WALK; i++) {
        if (this.loadedDirs.has(resolved)) break;
        if (this.isValidSubdir(resolved)) candidates.add(resolved);
        const parent = path.dirname(resolved);
        if (parent === resolved) break;
        resolved = parent;
      }
    } catch {
      /* 解析失败忽略 */
    }
  }

  private extractPathsFromCommand(cmd: string, candidates: Set<string>): void {
    // 解析 cd/pushd 的操作数（段落起始处）
    const tokens = this.tokenize(cmd);
    let segmentStart = true;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (SHELL_OPERATORS.has(tok)) {
        segmentStart = true;
        continue;
      }
      if (segmentStart && NAV_COMMANDS.has(tok)) {
        const operand = tokens.slice(i + 1).find((t) => SHELL_OPERATORS.has(t) || !t.startsWith("-"));
        if (operand && !SHELL_OPERATORS.has(operand) && !operand.startsWith("~")) {
          this.addPathCandidate(operand, candidates);
        }
      }
      segmentStart = false;
    }
    // 通用：含 / 或 . 的路径样 token（非 flag/URL）
    for (const tok of tokens) {
      if (tok.startsWith("-") || tok.startsWith("http://") || tok.startsWith("https://") || tok.startsWith("git@")) continue;
      if (!tok.includes("/") && !tok.includes(".")) continue;
      this.addPathCandidate(tok, candidates);
    }
  }

  private tokenize(cmd: string): string[] {
    // 极简分词：按 shell 操作符切割 + 空白切分（不追求完整 shlex 语义）。
    const out: string[] = [];
    let cur = "";
    let quote: string | null = null;
    for (let i = 0; i < cmd.length; i++) {
      const ch = cmd[i];
      if (quote) {
        if (ch === quote) quote = null;
        else cur += ch;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === "(" || ch === ")") {
        if (cur.trim()) out.push(cur.trim());
        cur = "";
        out.push(ch);
        continue;
      }
      if (ch === "&" || ch === "|" || ch === ";") {
        if (cur.trim()) out.push(cur.trim());
        cur = "";
        // 合并双字符操作符
        const two = cmd.slice(i, i + 2);
        const op = ["&&", "||", ";;", "|&"].includes(two) ? two : ch;
        out.push(op);
        if (op.length === 2) i++;
        continue;
      }
      if (ch === " " || ch === "\t" || ch === "\n") {
        if (cur.trim()) out.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  private withinWorkingDir(p: string): boolean {
    try {
      const rel = path.relative(this.workingDir, p);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    } catch {
      return false;
    }
  }

  private isValidSubdir(p: string): boolean {
    try {
      if (!fs.statSync(p).isDirectory()) return false;
    } catch {
      return false;
    }
    return !this.loadedDirs.has(p) && this.withinWorkingDir(p) && !this.isExcluded(p);
  }

  private isExcluded(p: string): boolean {
    let rel: string;
    try {
      rel = path.relative(this.workingDir, p);
    } catch {
      return true;
    }
    // working_dir 树「之下」的段若命中排除名单才排除（用户有意进入 vendor/ 仍合法）。
    const parts = rel.split(path.sep).filter(Boolean);
    return parts.some((part) => HINT_EXCLUDED_DIRS.has(part));
  }

  private loadHintsForDirectory(directory: string): string | null {
    this.loadedDirs.add(directory);
    if (this.homeLike || !this.withinWorkingDir(directory)) return null;
    const found = firstHintFile(directory);
    if (!found) return null;
    // symlink 解析后仍须在树内
    let real: string;
    try {
      real = fs.realpathSync(found.path);
    } catch {
      return null;
    }
    const digest = digestOf(found.content);
    if (this.loadedDigests.has(digest)) return null;
    this.loadedDigests.add(digest); // 先登记摘要：同一内容被阻止后，副本目录不再重复报
    const relPath = this.displayPath(found.path);
    // 与启动期上下文加载同等级的安全扫描：「context」作用域命中即**阻止**（内容不进会话）。
    const findings = scanForThreats(found.content, "context", found.path);
    if (findings.length > 0) {
      const ids = findings.map((f) => f.patternId).join(", ");
      process.stderr.write(`[SubdirectoryHints] blocked ${relPath}: ${ids}\n`);
      return `[Subdirectory context discovered: ${relPath}]\n[BLOCKED: ${relPath} contained potential prompt injection (${ids}). Content not loaded.]`;
    }
    return `[Subdirectory context discovered: ${relPath}]\n${truncateHintContent(found.content)}`;
  }

  private displayPath(p: string): string {
    const rel = path.relative(this.workingDir, p);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
    return p;
  }
}
