/**
 * Code Intelligence Tools — 代码智能工具集
 *
 * 对标 Claude Code / Cursor 的核心代码能力，以复合工具（composite tool）形式注册：
 *   - git（复合工具）：status / diff / log / blame / show / add / commit / push
 *   - code_search（复合工具）：symbol / references / text
 *   - apply_patch（复合工具）：patch / plan_rename / apply_rename
 *
 * 设计原则：
 *   - 一个工具族合并为一个工具，handler 内按 action 字符串分发（Hermes 模式：
 *     保持 schema 紧凑、降低每轮 token 成本）
 *   - git 写操作（commit/push）默认要求 permissionManager 审批
 *   - apply_patch / apply_rename 修改文件后通知 permissionRelay
 *   - 所有命令在 fsBase 限定的工作区内执行，路径逃逸直接拒绝
 */

import * as path from "path";
import * as fs from "fs";
import type { AgentModelExecutor, GitOperations, CodeIntelligence } from "@evoclaw/agent";
import type { PermissionManager } from "@evoclaw/security";
import {
  applyPatch as applyPatchFn,
  parsePatch,
  FileStateRegistry,
  ReadTracker,
  getCurrentToolCallContext,
} from "@evoclaw/agent";
import { getWorkspaceDir } from "@evoclaw/core";

/** 校验解析后的路径不超出允许的基目录，防止路径遍历攻击。
 *  Bug 9 修复：原实现仅做词法检查，不解析符号链接。改为词法检查通过后
 *  再用 fs.realpathSync 解析符号链接，防止 workspace 内 symlink 指向外部目录。 */
function validatePathWithinBase(resolvedPath: string, baseDir: string): string | null {
  const normalizedBase = path.resolve(baseDir);
  const normalizedTarget = path.resolve(resolvedPath);

  // 先做词法检查：若词法上已超出 base，直接拒绝（避免 realpath 浪费 IO）
  if (!normalizedTarget.startsWith(normalizedBase + path.sep) && normalizedTarget !== normalizedBase) {
    return `Path traversal blocked: "${resolvedPath}" is outside the allowed workspace "${normalizedBase}".`;
  }

  // 词法检查通过后，再用 realpath 解析符号链接，防止 workspace 内 symlink 指向外部目录
  try {
    let realTarget: string;
    if (fs.existsSync(normalizedTarget)) {
      realTarget = fs.realpathSync(normalizedTarget);
    } else {
      // 路径不存在（如 file_create）：realpath 父目录后拼接 basename
      const parentDir = path.dirname(normalizedTarget);
      if (fs.existsSync(parentDir)) {
        const realParent = fs.realpathSync(parentDir);
        realTarget = path.join(realParent, path.basename(normalizedTarget));
      } else {
        // 父目录也不存在：信任词法检查结果
        return null;
      }
    }
    // 对 realpath 结果再做一次词法检查
    if (!realTarget.startsWith(normalizedBase + path.sep) && realTarget !== normalizedBase) {
      return `Path traversal blocked (symlink escape): "${resolvedPath}" resolves to "${realTarget}" which is outside the allowed workspace "${normalizedBase}".`;
    }
  } catch {
    // realpath 失败（权限/IO 错误）：保守拒绝，避免误放行
    return `Path validation failed (realpath error): "${resolvedPath}".`;
  }
  return null;
}

/** 转义正则元字符，用于安全的字面量匹配（原 dev-tools，随 codebase_search 一并迁移） */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 简化 glob 匹配：支持 * 和 ?（原 dev-tools，随 codebase_search 一并迁移） */
function matchGlob(filename: string, pattern: string): boolean {
  // 先转义正则元字符（除 * 和 ?），再替换 glob 通配符
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(regex, "i").test(filename);
}

/** 提取最佳代码片段：找到关键词命中度最高的行，返回周围上下文（原 dev-tools，随 codebase_search 一并迁移） */
function extractSnippet(
  content: string,
  terms: string[],
  maxLen: number,
): { text: string; lines: string } {
  const lines = content.split("\n");
  let bestLine = 0;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (lower.includes(term)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }
  const start = Math.max(0, bestLine - 2);
  const end = Math.min(lines.length, bestLine + 3);
  const snippet = lines.slice(start, end).join("\n");
  return {
    text: snippet.length > maxLen ? snippet.substring(0, maxLen) + "..." : snippet,
    lines: `${start + 1}-${end}`,
  };
}

export interface CodeIntelToolDeps {
  executor: AgentModelExecutor;
  permissionManager: PermissionManager;
  gitOps: GitOperations;
  codeIntel: CodeIntelligence;
  fsBase: string;
}

export function registerCodeIntelTools(deps: CodeIntelToolDeps): void {
  const { executor, permissionManager, gitOps, codeIntel, fsBase } = deps;

  // ── git 复合工具的各 action handler（逻辑体与合并前逐字一致） ──

  async function handleGitStatus(_params: Record<string, unknown>): Promise<unknown> {
    try {
      const entries = await gitOps.status();
      return { success: true, entries, count: entries.length };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function handleGitDiff(params: Record<string, unknown>): Promise<unknown> {
    try {
      const target = params.target ? String(params.target) : undefined;
      const staged = params.staged === true;
      const diff = await gitOps.diff(target, staged);
      return { success: true, diff, length: diff.length };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function handleGitLog(params: Record<string, unknown>): Promise<unknown> {
    try {
      const maxCountRaw = Number(params.maxCount);
      const maxCount = Number.isFinite(maxCountRaw) && maxCountRaw > 0 ? maxCountRaw : 20;
      const log = await gitOps.log(maxCount);
      return { success: true, log, count: log.length };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function handleGitBlame(params: Record<string, unknown>): Promise<unknown> {
    try {
      const filePath = String(params.path || "");
      if (!filePath) return { success: false, error: "path is required" };
      const pathError = validatePathWithinBase(path.resolve(fsBase, filePath), fsBase);
      if (pathError) return { success: false, error: pathError };
      const startLine = params.startLine ? Number(params.startLine) : undefined;
      const endLine = params.endLine ? Number(params.endLine) : undefined;
      const blame = await gitOps.blame(filePath, startLine, endLine);
      return { success: true, blame, count: blame.length };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function handleGitShow(params: Record<string, unknown>): Promise<unknown> {
    try {
      const ref = String(params.ref || "");
      if (!ref) return { success: false, error: "ref is required" };
      const filePath = params.path ? String(params.path) : undefined;
      if (filePath) {
        const pathError = validatePathWithinBase(path.resolve(fsBase, filePath), fsBase);
        if (pathError) return { success: false, error: pathError };
      }
      const content = await gitOps.show(ref, filePath);
      return { success: true, content, length: content.length };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function handleGitAdd(params: Record<string, unknown>): Promise<unknown> {
    try {
      const paths = Array.isArray(params.paths) ? params.paths.map(String) : [];
      if (paths.length === 0) return { success: false, error: "paths array is required" };
      for (const p of paths) {
        const pathError = validatePathWithinBase(path.resolve(fsBase, p), fsBase);
        if (pathError) return { success: false, error: pathError };
      }
      await gitOps.add(paths);
      return { success: true, staged: paths.length };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function handleGitCommit(params: Record<string, unknown>): Promise<unknown> {
    const message = String(params.message || "");
    if (!message) return { success: false, error: "message is required" };
    const amend = params.amend === true;
    const permReq = permissionManager.requestPermission("git_commit", message, { amend }, "tool");
    if (permReq.status === "denied") {
      return { success: false, error: `Permission denied for git_commit. Request ID: ${permReq.id}` };
    }
    if (permReq.status === "pending") {
      return { success: false, error: `Permission pending for git_commit. Request ID: ${permReq.id}`, requiresPermission: true, requestId: permReq.id };
    }
    try {
      const hash = await gitOps.commit(message, amend);
      return { success: true, hash, message, amend };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function handleGitPush(params: Record<string, unknown>): Promise<unknown> {
    const force = params.force === true;
    const remote = params.remote ? String(params.remote) : "origin";
    const branch = params.branch ? String(params.branch) : undefined;
    const permReq = permissionManager.requestPermission("git_push", `${remote}/${branch ?? "current"}${force ? " (FORCE)" : ""}`, { force }, "tool");
    if (permReq.status === "denied") {
      return { success: false, error: `Permission denied for git_push. Request ID: ${permReq.id}` };
    }
    if (permReq.status === "pending") {
      return { success: false, error: `Permission pending for git_push. Request ID: ${permReq.id}`, requiresPermission: true, requestId: permReq.id };
    }
    try {
      await gitOps.push(remote, branch, force);
      return { success: true, remote, branch, force };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── code_search 复合工具的各 action handler（逻辑体与合并前逐字一致） ──

  async function handleCodeSearchSymbol(params: Record<string, unknown>): Promise<unknown> {
    try {
      const query = String(params.query || "");
      if (!query) return { success: false, error: "query is required" };
      const language = params.language ? String(params.language) : undefined;
      const maxResultsRaw = Number(params.maxResults);
      const maxResults = Number.isFinite(maxResultsRaw) && maxResultsRaw > 0 ? maxResultsRaw : 20;
      const results = await codeIntel.searchSymbols(query, language, maxResults);
      return { success: true, results, count: results.length };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function handleCodeSearchReferences(params: Record<string, unknown>): Promise<unknown> {
    try {
      const symbolName = String(params.symbolName || "");
      if (!symbolName) return { success: false, error: "symbolName is required" };
      const filePath = params.path ? String(params.path) : undefined;
      const refs = await codeIntel.findReferences(symbolName, filePath);
      return { success: true, references: refs, count: refs.length };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function handleCodeSearchText(params: Record<string, unknown>): Promise<unknown> {
    // workspaceRoot 由 deps.fsBase 注入：原 dev-tools 的 workspaceRoot 默认值
    // （仓库根）与 fsBase 运行时取值一致，搜索范围不变
    const workspaceRoot = fsBase;
    const query = String(params.query || "");
    const maxResults = Math.max(1, parseInt(String(params.maxResults ?? "20"), 10) || 20);
    const filePattern = params.filePattern ? String(params.filePattern) : null;

    if (!query) return { success: false, error: "Query is required" };

    const queryTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);
    if (queryTerms.length === 0) {
      return { success: false, error: "Query must contain at least one term longer than 2 characters" };
    }

    const results: Array<{ file: string; score: number; snippet: string; lines: string }> = [];

    const excludeDirs = new Set([
      "node_modules",
      "dist",
      ".git",
      "data",
      ".cache",
      "coverage",
      "build",
      ".next",
      "target",
      ".vitest",
      ".github",
      ".vscode",
      ".idea",
      "logs",
      "__pycache__",
    ]);
    const excludeExts = new Set([
      ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".woff", ".woff2",
      ".ttf", ".eot", ".mp4", ".webm", ".zip", ".gz", ".tar", ".db",
      ".sqlite", ".lock", ".bin", ".exe", ".dll", ".so", ".dylib",
    ]);
    const maxFileSize = 100 * 1024; // 100KB
    const MAX_RESULTS_WALK = maxResults * 3;
    const maxDepth = 20;
    const maxFiles = 10000;
    let filesScanned = 0;

    const walkDir = (dir: string, depth: number): void => {
      if (depth > maxDepth || results.length >= MAX_RESULTS_WALK) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= MAX_RESULTS_WALK || filesScanned >= maxFiles) return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!excludeDirs.has(entry.name)) {
            walkDir(fullPath, depth + 1);
          }
        } else if (entry.isFile()) {
          filesScanned++;
          const ext = path.extname(entry.name).toLowerCase();
          if (excludeExts.has(ext)) continue;

          if (filePattern && !matchGlob(entry.name, filePattern)) continue;

          let stat: fs.Stats;
          try {
            stat = fs.statSync(fullPath);
          } catch {
            continue;
          }
          if (stat.size > maxFileSize || stat.size === 0) continue;

          let content: string;
          try {
            content = fs.readFileSync(fullPath, "utf-8");
          } catch {
            continue;
          }

          const lowerContent = content.toLowerCase();
          let score = 0;
          for (const term of queryTerms) {
            const count = (lowerContent.match(new RegExp(escapeRegex(term), "g")) || []).length;
            if (count > 0) {
              // TF 归一化：词频 / log(文件长度)，避免长文件天然占优
              score += count * (1 / Math.log(Math.max(content.length, 10)));
            }
          }

          // 文件名匹配加分
          const lowerName = entry.name.toLowerCase();
          for (const term of queryTerms) {
            if (lowerName.includes(term)) score += 5;
          }

          if (score > 0) {
            const snippet = extractSnippet(content, queryTerms, 200);
            const relativePath = path.relative(workspaceRoot, fullPath).replace(/\\/g, "/");
            results.push({
              file: relativePath,
              score,
              snippet: snippet.text,
              lines: snippet.lines,
            });
          }
        }
      }
    };

    walkDir(workspaceRoot, 0);
    results.sort((a, b) => b.score - a.score);

    return {
      query,
      results: results.slice(0, maxResults),
      totalMatches: results.length,
    };
  }

  // ── apply_patch 复合工具的各 action handler（逻辑体与合并前逐字一致） ──

  async function handlePlanRename(params: Record<string, unknown>): Promise<unknown> {
    try {
      const oldName = String(params.oldName || "");
      const newName = String(params.newName || "");
      if (!oldName || !newName) return { success: false, error: "oldName and newName are required" };
      const filePath = params.path ? String(params.path) : undefined;
      const plan = await codeIntel.planRename(oldName, newName, filePath);
      return { success: true, plan, totalOccurrences: plan.totalOccurrences };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function handleApplyRename(params: Record<string, unknown>): Promise<unknown> {
    try {
      const oldName = String(params.oldName || "");
      const newName = String(params.newName || "");
      if (!oldName || !newName) return { success: false, error: "oldName and newName are required" };
      const filePath = params.path ? String(params.path) : undefined;
      const plan = await codeIntel.planRename(oldName, newName, filePath);
      if (plan.totalOccurrences === 0) {
        return { success: true, filesChanged: 0, occurrences: 0, message: "No occurrences found" };
      }
      const result = await codeIntel.applyRename(plan);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 定点替换模式（对标 hermes patch_tool 的 mode=replace）。
   *
   * ★ 2026-11-26 取证（v27-t1 第 61 行）：模型按肌肉记忆把 apply_patch 当
   *   patch 工具用，发 {action:"edit", path, old_string, new_string}，旧实现
   *   直接回「未知 apply_patch action」——参数其实完全够用，白白烧一轮。
   *   hermes 的 patch handler 对任何模型都同时接受 patch 文本与 replace 三件套，
   *   这里同样：三件套齐备就合成为一段 SEARCH/REPLACE 走同一条应用路径
   *   （4 趟模糊匹配、原子写、路径安全检查全部复用）。
   */
  function replaceModePatch(params: Record<string, unknown>): string | null {
    const filePath = params.path ?? params.file_path;
    const oldS = params.old_string ?? params.oldText ?? params.search;
    const newS = params.new_string ?? params.newText ?? params.replace;
    if (typeof filePath !== "string" || !filePath.trim()) return null;
    if (typeof oldS !== "string" || oldS === "") return null;
    if (typeof newS !== "string") return null;
    return `<<<<<<< SEARCH ${filePath.trim()}\n${oldS}\n=======\n${newS}\n>>>>>>> REPLACE`;
  }

  async function handleApplyPatch(params: Record<string, unknown>): Promise<unknown> {
    try {
      const patchText = String(params.patch || "") || replaceModePatch(params) || "";
      if (!patchText) {
        return {
          success: false,
          error:
            "patch 为空。两种用法：① 传 patch 文本（SEARCH/REPLACE 块 / OpenAI *** Update File 风格 / unified diff）；" +
            "② 定点替换传 path + old_string + new_string（等价 file_write action=edit）。",
        };
      }
      const hunks = parsePatch(patchText);
      if (hunks.length === 0) {
        // ★ 2026-11-26 取证（v27-t8）：模型把整段源码当 patch 发（没有任何
        //   SEARCH/=======/REPLACE 标记），旧错误只说「支持三种格式」，模型
        //   无法判断自己错在哪，重发同样内容。这里先做确定性诊断，再给格式说明。
        const head = patchText.trim().split("\n").slice(0, 3).join("\n").slice(0, 200);
        const hasAnyMarker = /(?:<{3,}\s*SEARCH|={5,}|>{3,}\s*REPLACE|\*\*\*\s*(?:Begin|Update|Add|End)|\+\+\+ |@@)/i.test(patchText);
        const diagnosis = hasAnyMarker
          ? "patch 文本里出现了标记，但没有组成完整的 SEARCH ... ======= ... >>>>>>> REPLACE 块（或 *** Update File + @@ hunk）。"
          : "patch 文本里**没有任何 patch 标记**——看起来是直接粘贴的源码/文件内容，不是 patch。";
        return {
          success: false,
          error:
            `No valid hunks parsed from patch text. ${diagnosis}\n` +
            `收到的开头：${JSON.stringify(head)}\n` +
            "支持三种格式：" +
            "(1) <<<<<<< SEARCH path/to/file ... ======= ... >>>>>>> REPLACE（SEARCH 后路径可省略，但需先出现 *** Update File: path 或 --- a/path 头）；" +
            "(2) OpenAI 风格 *** Begin Patch / *** Update File: path / @@ hunks / *** End Patch；" +
            "(3) 简化 unified diff：--- a/path +++ b/path + @@ hunks。",
          hint:
            "如果只是想改文件里的几行，不要拼 patch——直接调 file_write action=edit + path + old_string + new_string（old_string 从 file_read 结果逐字复制）；" +
            "整文件重写用 file_write action=modify + content。",
        };
      }
      // ★ 2026-11-09 P2 路径契约：apply_patch 的相对路径必须与 file_write /
      //   shell_exec 的基准一致——即当前工作区（data/workspace），而非仓库根 fsBase。
      //   此前固定用 fsBase，模型传 `v9-finance/process-csv.js`（它按 shell_exec
      //   的 cwd 推断是工作区相对路径）被解析到仓库根 → File not found，反复失败
      //   （v9 压测 Task 1 实测 8 次 apply_patch 因落点错配浪费多轮，任务 10 轮后
      //   收尾时 process-csv.js 仍带 for-of→async iterable 语法错，报告未产出）。
      //   改：相对路径以 getWorkspaceDir() 为根（支持运行时工作区切换，与
      //   file-tools 的 resolveToolPath 同构）；绝对路径由 applyPatch 的
      //   path.resolve 语义原样直通。
      const workspaceRoot = getWorkspaceDir();
      // ★ 2026-11-26：patch 写盘后必须更新会话记账（FileStateRegistry 读戳 +
      //   ReadTracker 全文基线），否则同一会话紧接着的 file_write action=modify
      //   会被「was modified outside this session」/「没读过全文」误拒——
      //   文件是本会话自己刚 patch 的（v26-t4 / v26-t9 / v28-t4 实证各烧 1-3 次）。
      //   对齐 hermes `_note_edited`：每个写成功的路径做 note_write + 刷新读戳。
      const sessionId = getCurrentToolCallContext()?.sessionId ?? "default";
      const notePatched = (absPath: string, newContent: string): void => {
        try {
          FileStateRegistry.getInstance().recordWrite(sessionId, absPath, newContent);
        } catch {
          /* 记账失败不阻断 patch */
        }
        try {
          const tracker = ReadTracker.getInstance();
          const stat = fs.statSync(absPath);
          const version = `${stat.mtimeMs}:${FileStateRegistry.hashContent(newContent)}`;
          tracker.noteWriteServed(sessionId, absPath, version);
        } catch {
          /* 记账失败不阻断 patch */
        }
      };
      const result = await applyPatchFn(workspaceRoot, hunks, notePatched);
      return result;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── git 复合工具 ─────────────────────────────────────────────
  executor.registerTool(
    "git",
    {
      name: "git",
      description:
        "复合 Git 工具（composite git tool），通过 action 参数选择具体操作；默认 action 为 status。" +
        "Choose the action matching the user's request. " +
        "actions: " +
        "status（显示工作区状态：暂存 + 未暂存变更，返回文件路径与状态列表，无参数）； " +
        "diff（显示差异：staged=true 看暂存区，或传 target 指定对比目标分支/提交/文件）； " +
        "log（显示提交历史，返回 {hash, author, email, date, message, filesChanged}，maxCount 默认 20）； " +
        "blame（显示文件行归属，path 必填，startLine/endLine 可选）； " +
        "show（查看 commit/ref 内容，ref 必填，path 可选，返回原始内容）； " +
        "add（暂存文件，paths 为相对路径数组或 '.' 表示全部变更）； " +
        "commit（创建提交，message 必填，amend=true 修改上一次提交；需权限审批）； " +
        "push（推送到远程，remote 默认 origin，branch 默认当前分支，force=true 强推；需权限审批）。",
      parameters: {
        action: {
          type: "string",
          description: "要执行的 Git 操作。action to perform: status (default) / diff / log / blame / show / add / commit / push",
          enum: ["status", "diff", "log", "blame", "show", "add", "commit", "push"],
          required: false, default: "status",
        },
        target: { type: "string", description: "Branch/commit/file to diff against (default: HEAD)（diff 用）", required: false },
        staged: { type: "boolean", description: "Show staged changes (default: false)（diff 用）", required: false, default: false },
        maxCount: { type: "number", description: "Max commits to return (default: 20)（log 用）", required: false, default: 20 },
        path: { type: "string", description: "Relative file path（blame / show 用）", required: false },
        startLine: { type: "number", description: "Start line (1-based, default: 1)（blame 用）", required: false },
        endLine: { type: "number", description: "End line (default: file end)（blame 用）", required: false },
        ref: { type: "string", description: "Commit hash / branch / tag (e.g. HEAD, abc1234)（show 用）", required: false },
        paths: { type: "array", description: "Array of relative file paths to stage, or '.' for all changes（add 用）", required: false },
        message: { type: "string", description: "Commit message（commit 用）", required: false },
        amend: { type: "boolean", description: "Amend previous commit (default: false)（commit 用）", required: false, default: false },
        remote: { type: "string", description: "Remote name (default: origin)（push 用）", required: false, default: "origin" },
        branch: { type: "string", description: "Branch name (default: current)（push 用）", required: false },
        force: { type: "boolean", description: "Force push (default: false, use with caution)（push 用）", required: false, default: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "status");
      if (action === "status") return await handleGitStatus(params);
      if (action === "diff") return await handleGitDiff(params);
      if (action === "log") return await handleGitLog(params);
      if (action === "blame") return await handleGitBlame(params);
      if (action === "show") return await handleGitShow(params);
      if (action === "add") return await handleGitAdd(params);
      if (action === "commit") return await handleGitCommit(params);
      if (action === "push") return await handleGitPush(params);
      return { success: false, error: `未知 git action: ${action}（仅支持 status / diff / log / blame / show / add / commit / push）` };
    }
  );

  // ── code_search 复合工具 ─────────────────────────────────────
  executor.registerTool(
    "code_search",
    {
      name: "code_search",
      description:
        "复合代码搜索工具（composite code search tool），通过 action 参数选择具体操作；默认 action 为 symbol。" +
        "Choose the action matching the user's request. " +
        "actions: " +
        "symbol（按符号名搜索函数/类/方法/接口/类型，返回匹配符号的文件路径、行号与签名；query 必填，language/maxResults 可选）； " +
        "references（查找符号的全部引用，返回文件路径、行号与行内容；symbolName 必填，path 可选）； " +
        "text（自然语言语义搜索，基于文本匹配与模糊打分，返回相关代码片段与行号；query 为自然语言查询，filePattern 为 glob 过滤，maxResults 默认 20）。",
      parameters: {
        action: {
          type: "string",
          description: "要执行的搜索操作。action to perform: symbol (default) / references / text",
          enum: ["symbol", "references", "text"],
          required: false, default: "symbol",
        },
        query: { type: "string", description: "Symbol name or partial name to search（symbol 用） / Natural language search query（text 用）", required: false },
        language: { type: "string", description: "Filter by language (e.g. typescript, python)（symbol 用）", required: false },
        maxResults: { type: "number", description: "Max results (default: 20)（symbol / text 用）", required: false, default: 20 },
        symbolName: { type: "string", description: "Symbol name to find references for（references 用）", required: false },
        path: { type: "string", description: "Optional file path where the symbol is defined（references 用）", required: false },
        filePattern: { type: "string", description: "Glob pattern to filter files (e.g. '*.ts', '*.py', 'src/**/*')（text 用）", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "symbol");
      if (action === "symbol") return await handleCodeSearchSymbol(params);
      if (action === "references") return await handleCodeSearchReferences(params);
      if (action === "text") return await handleCodeSearchText(params);
      return { success: false, error: `未知 code_search action: ${action}（仅支持 symbol / references / text）` };
    }
  );

  // ── apply_patch 复合工具 ─────────────────────────────────────
  executor.registerTool(
    "apply_patch",
    {
      name: "apply_patch",
      description:
        "复合补丁工具（composite patch tool），通过 action 参数选择具体操作；默认 action 为 patch。" +
        "Choose the action matching the user's request. " +
        "actions: " +
        "patch（应用 SEARCH/REPLACE 补丁到文件：支持多文件多 hunk，4 趟模糊匹配（exact → rstrip → strip → unicode-normalize），原子写 temp+fsync+rename；patch 必填）； " +
        "plan_rename（规划符号重命名：返回所有将变更的位置，不修改文件；oldName/newName 必填，path 可选）； " +
        "apply_rename（执行 plan_rename 的重命名计划：原子写修改所有受影响文件；oldName/newName 必填，path 可选）。",
      parameters: {
        action: {
          type: "string",
          description: "要执行的补丁操作。action to perform: patch (default) / edit（path+old_string+new_string 定点替换，等价 replace 模式）/ plan_rename / apply_rename",
          enum: ["patch", "edit", "plan_rename", "apply_rename"],
          required: false, default: "patch",
        },
        patch: {
          type: "string",
          description:
            "Patch text. 三种受支持格式："
            + "① <<<<<<< SEARCH path/to/file ... ======= ... >>>>>>> REPLACE（一个文件可多块；"
            + "SEARCH 后路径可省略，此时沿用上方 *** Update File: path 头声明的目标文件）；"
            + "② OpenAI 风格：*** Begin Patch / *** Update File: path/to/file / @@ 上下文 / *** End Patch / *** Add File: path；"
            + "③ 简化 unified diff：--- a/path +++ b/path + @@ -x,y +x,y @@ + context/-old/+new（patch 用）。"
            + "也可改用 action=edit + path + old_string + new_string 做定点替换。",
          required: false,
        },
        old_string: { type: "string", description: "（action=edit）要查找的原文（替代 patch 文本）", required: false },
        new_string: { type: "string", description: "（action=edit）替换文本", required: false },
        oldName: { type: "string", description: "Current symbol name（plan_rename / apply_rename 用）", required: false },
        newName: { type: "string", description: "New symbol name（plan_rename / apply_rename 用）", required: false },
        path: { type: "string", description: "文件路径（action=edit 的目标文件；plan_rename / apply_rename 时为符号定义所在文件）", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const rawAction = String(params.action || "").trim();
      // 首 token 归一化（与 file_write 同规则）：`edit\n</parameter=...>` 这类脏取值
      const action = rawAction === "" ? "patch" : (/^[a-z_]+/i.exec(rawAction)?.[0] ?? "").toLowerCase();
      // 模型把 apply_patch 当 patch 工具用、发 {action:"edit"/"replace"/"update", path, old_string, new_string}
      // 时走 replace 模式（参数已齐备，不必报「未知 action」烧掉一轮）。
      if (action === "patch" || action === "edit" || action === "replace" || action === "update") {
        return await handleApplyPatch(params);
      }
      if (action === "plan_rename") return await handlePlanRename(params);
      if (action === "apply_rename") return await handleApplyRename(params);
      return { success: false, error: `未知 apply_patch action: ${rawAction.slice(0, 40)}（仅支持 patch / edit / plan_rename / apply_rename）` };
    }
  );
}
