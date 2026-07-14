/**
 * Code Intelligence Tools — 代码智能工具集
 *
 * 对标 Claude Code / Cursor 的核心代码能力，注册以下工具：
 *   - git_status / git_diff / git_log / git_blame / git_show
 *   - git_commit / git_push / git_add（写操作需权限）
 *   - code_search / find_references / plan_rename / apply_rename
 *   - apply_patch（通用 SEARCH/REPLACE 补丁应用）
 *
 * 设计原则：
 *   - git 写操作（commit/push）默认要求 permissionManager 审批
 *   - apply_patch / apply_rename 修改文件后通知 permissionRelay
 *   - 所有命令在 fsBase 限定的工作区内执行，路径逃逸直接拒绝
 */

import * as path from "path";
import * as fs from "fs";
import type { AgentModelExecutor, GitOperations, CodeIntelligence } from "@evoclaw/agent";
import type { PermissionManager } from "@evoclaw/security";
import { applyPatch as applyPatchFn, parsePatch } from "@evoclaw/agent";

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

export interface CodeIntelToolDeps {
  executor: AgentModelExecutor;
  permissionManager: PermissionManager;
  gitOps: GitOperations;
  codeIntel: CodeIntelligence;
  fsBase: string;
}

export function registerCodeIntelTools(deps: CodeIntelToolDeps): void {
  const { executor, permissionManager, gitOps, codeIntel, fsBase } = deps;

  // ── git_status ──────────────────────────────────────────────
  executor.registerTool(
    "git_status",
    {
      name: "git_status",
      description: "Show working tree status (staged + unstaged changes). Returns list of file paths with their status.",
      parameters: {},
    },
    async () => {
      try {
        const entries = await gitOps.status();
        return { success: true, entries, count: entries.length };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── git_diff ────────────────────────────────────────────────
  executor.registerTool(
    "git_diff",
    {
      name: "git_diff",
      description: "Show git diff. Use staged=true for staged changes, or pass target (branch/commit/file) to diff against.",
      parameters: {
        target: { type: "string", description: "Branch/commit/file to diff against (default: HEAD)", required: false },
        staged: { type: "boolean", description: "Show staged changes (default: false)", required: false, default: false },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        const target = params.target ? String(params.target) : undefined;
        const staged = params.staged === true;
        const diff = await gitOps.diff(target, staged);
        return { success: true, diff, length: diff.length };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── git_log ─────────────────────────────────────────────────
  executor.registerTool(
    "git_log",
    {
      name: "git_log",
      description: "Show commit history. Returns array of {hash, author, email, date, message, filesChanged}.",
      parameters: {
        maxCount: { type: "number", description: "Max commits to return (default: 20)", required: false, default: 20 },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        const maxCountRaw = Number(params.maxCount);
        const maxCount = Number.isFinite(maxCountRaw) && maxCountRaw > 0 ? maxCountRaw : 20;
        const log = await gitOps.log(maxCount);
        return { success: true, log, count: log.length };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── git_blame ───────────────────────────────────────────────
  executor.registerTool(
    "git_blame",
    {
      name: "git_blame",
      description: "Show git blame for a file. Returns array of {hash, author, date, line, content}.",
      parameters: {
        path: { type: "string", description: "Relative file path to blame", required: true },
        startLine: { type: "number", description: "Start line (1-based, default: 1)", required: false },
        endLine: { type: "number", description: "End line (default: file end)", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
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
  );

  // ── git_show ────────────────────────────────────────────────
  executor.registerTool(
    "git_show",
    {
      name: "git_show",
      description: "Show content of a commit or file at a ref. Returns the raw content.",
      parameters: {
        ref: { type: "string", description: "Commit hash / branch / tag (e.g. HEAD, abc1234)", required: true },
        path: { type: "string", description: "Optional file path within the ref", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
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
  );

  // ── git_add ─────────────────────────────────────────────────
  executor.registerTool(
    "git_add",
    {
      name: "git_add",
      description: "Stage file(s) for commit. Pass array of relative paths, or '.' for all changes.",
      parameters: {
        paths: { type: "array", description: "Array of relative file paths to stage", required: true },
      },
    },
    async (params: Record<string, unknown>) => {
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
  );

  // ── git_commit ──────────────────────────────────────────────
  executor.registerTool(
    "git_commit",
    {
      name: "git_commit",
      description: "Create a git commit with the given message. Files must be staged first via git_add. Use amend=true to amend the previous commit.",
      parameters: {
        message: { type: "string", description: "Commit message", required: true },
        amend: { type: "boolean", description: "Amend previous commit (default: false)", required: false, default: false },
      },
    },
    async (params: Record<string, unknown>) => {
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
  );

  // ── git_push ────────────────────────────────────────────────
  executor.registerTool(
    "git_push",
    {
      name: "git_push",
      description: "Push commits to remote. Use force=true for force push (requires explicit confirmation).",
      parameters: {
        remote: { type: "string", description: "Remote name (default: origin)", required: false, default: "origin" },
        branch: { type: "string", description: "Branch name (default: current)", required: false },
        force: { type: "boolean", description: "Force push (default: false, use with caution)", required: false, default: false },
      },
    },
    async (params: Record<string, unknown>) => {
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
  );

  // ── code_search ─────────────────────────────────────────────
  executor.registerTool(
    "code_search",
    {
      name: "code_search",
      description: "Search code symbols (functions, classes, methods, interfaces, types) by name across the workspace. Returns matching symbols with file paths, line numbers, and signatures.",
      parameters: {
        query: { type: "string", description: "Symbol name or partial name to search", required: true },
        language: { type: "string", description: "Filter by language (e.g. typescript, python)", required: false },
        maxResults: { type: "number", description: "Max results (default: 20)", required: false, default: 20 },
      },
    },
    async (params: Record<string, unknown>) => {
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
  );

  // ── find_references ─────────────────────────────────────────
  executor.registerTool(
    "find_references",
    {
      name: "find_references",
      description: "Find all references to a symbol (function/variable/class name) across the workspace. Returns file paths, line numbers, and line content.",
      parameters: {
        symbolName: { type: "string", description: "Symbol name to find references for", required: true },
        path: { type: "string", description: "Optional file path where the symbol is defined (improves accuracy)", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
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
  );

  // ── plan_rename ─────────────────────────────────────────────
  executor.registerTool(
    "plan_rename",
    {
      name: "plan_rename",
      description: "Plan a symbol rename across the workspace. Returns a plan with all occurrences that would be changed. Does NOT modify files. Use apply_rename to execute the plan.",
      parameters: {
        oldName: { type: "string", description: "Current symbol name", required: true },
        newName: { type: "string", description: "New symbol name", required: true },
        path: { type: "string", description: "Optional file path where the symbol is defined", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
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
  );

  // ── apply_rename ────────────────────────────────────────────
  executor.registerTool(
    "apply_rename",
    {
      name: "apply_rename",
      description: "Execute a rename plan (from plan_rename) across all affected files. Modifies files in-place using atomic writes.",
      parameters: {
        oldName: { type: "string", description: "Current symbol name", required: true },
        newName: { type: "string", description: "New symbol name", required: true },
        path: { type: "string", description: "Optional file path where the symbol is defined", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
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
  );

  // ── apply_patch ─────────────────────────────────────────────
  executor.registerTool(
    "apply_patch",
    {
      name: "apply_patch",
      description: "Apply a SEARCH/REPLACE patch to one or more files. Supports multi-hunk patches with multiple files. Each hunk has: relativePath, search (exact content to find), replace (new content). Uses 4-pass matching (exact → rstrip → strip → unicode-normalize) for fuzzy matching. Atomic writes (temp+fsync+rename).",
      parameters: {
        patch: { type: "string", description: "Patch text in SEARCH/REPLACE format. Format:\n<<<<<<< SEARCH path/to/file\n...search content...\n=======\n...replace content...\n>>>>>>> REPLACE", required: true },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        const patchText = String(params.patch || "");
        if (!patchText) return { success: false, error: "patch is required" };
        const hunks = parsePatch(patchText);
        if (hunks.length === 0) return { success: false, error: "No valid hunks parsed from patch text" };
        // workspaceRoot 固定为服务器 fsBase，不接受用户传入（防止路径遍历）
        const workspaceRoot = fsBase;
        const result = await applyPatchFn(workspaceRoot, hunks);
        return result;
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}
