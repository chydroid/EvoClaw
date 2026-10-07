import * as path from "path";
import * as fs from "fs";
import type { AgentModelExecutor } from "@evoclaw/agent";
import type { PermissionManager, PermissionRelay } from "@evoclaw/security";
import { getActiveSecurityPolicy, decideFileAccess } from "@evoclaw/security";
import type { ErrorRecoveryManager } from "@evoclaw/security";
import type { FileSystemManager } from "@evoclaw/infrastructure";

/** Validate that a resolved path stays within the allowed base directory.
 *  Prevents path traversal attacks (e.g. `../../etc/passwd`).
 *
 *  Bug 9 修复：原实现仅用 path.resolve 做词法规范化，不解析符号链接。
 *  攻击者可在 workspace 内创建指向外部目录的 symlink（如 workspace/evil -> /etc），
 *  path.resolve 会认为 evil 在 workspace 内，但实际访问的是 /etc。
 *  改为：对已存在路径用 realpathSync 解析符号链接后再检查；
 *  对不存在路径，realpath 父目录后拼接文件名再检查。 */
function validatePathWithinBase(resolvedPath: string, baseDir: string): string | null {
  const normalizedBase = path.resolve(baseDir);
  // On Windows, normalize drive letters for comparison
  const normalizedTarget = path.resolve(resolvedPath);

  // 先做词法检查：若词法上已超出 base，直接拒绝（避免 realpath 浪费 IO）
  if (!normalizedTarget.startsWith(normalizedBase + path.sep) && normalizedTarget !== normalizedBase) {
    return `Path traversal blocked: "${resolvedPath}" is outside the allowed workspace "${normalizedBase}". Use relative paths within the workspace only.`;
  }

  // Bug 9 修复：词法检查通过后，再用 realpath 解析符号链接，防止
  // workspace 内的 symlink 指向外部目录。
  try {
    let realTarget: string;
    if (fs.existsSync(normalizedTarget)) {
      // 路径存在：直接 realpath
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

/**
 * 解析工具入参里的文件路径，返回**绝对路径**与**供 FileSystemManager 使用的相对路径**。
 *
 * 真实事故（2026-10-07）：模型连续 3 次调用 file_create 被拦在「等待审批」，
 * 最后停下来问用户「请在弹窗中批准」，但界面根本没有弹窗。
 *
 * 根因是**相对路径的基准目录不一致**：
 *   - `shell_exec` 的 cwd 是 `data/workspace`
 *   - `file_create` 却把相对路径解析到**项目根**（fsBase）
 * 而白名单只覆盖 `data/workspace` 与 `data/skills`（刻意不白名单项目根，
 * 以防 agent 改源码 / .env）。于是模型写 `list_files.mjs`（它以为落在 workspace）
 * 实际落到 `<repo>/list_files.mjs` → 不在白名单 → 触发审批 → 任务彻底卡死。
 *
 * 现在：**相对路径按 workspace 解析**（与 shell_exec 的 cwd 对齐，
 * 产物也落在 workspace 而不是污染仓库根目录）。
 *
 * ⚠️ 必须同时返回 `forFs`：FileSystemManager 以 fsBase 为基准解析相对路径，
 * 若只把 `resolved` 换给审批检查、却仍把原始相对路径交给 fsMgr，
 * 就会出现「审批判定在 workspace、实际写入在仓库根」的错配 —— 那等于凭空开了一个
 * 绕过白名单的写入口。两者必须指向同一个绝对路径。
 *
 * 绝对路径与项目根的边界校验保持原样：项目根依旧不会被自动放行。
 */
/**
 * 剥掉模型习惯性带上的 workspace 前缀。
 * `data/workspace/x`、`.\data\workspace\x`、甚至多套几层的
 * `data/workspace/data/workspace/x` 都归一为 `x`。
 */
function stripWorkspacePrefix(filePath: string): string {
  let candidate = filePath.replace(/^\.[\\/]+/, "");
  const p = "data/workspace/";
  for (;;) {
    const lower = candidate.toLowerCase().replace(/\\/g, "/");
    if (!lower.startsWith(p)) break;
    candidate = candidate.slice(p.length);
  }
  return candidate;
}

function resolveToolPath(
  fsBase: string,
  workspaceBase: string | undefined,
  filePath: string,
): { resolved: string; forFs: string; display: string } {
  // 真实事故（2026-10-07 15:2x）：模型按 shell_exec 的 cwd 推断，
  // 传 `data/workspace/readme.md`（它以为相对项目根）。而相对路径已改为按
  // workspace 解析，于是拼成 `<ws>/data/workspace/readme.md` —— 目录多套一层，
  // 脚本写进了嵌套目录，后续 `node xxx.js` 报 SyntaxError（读到了另一个文件），
  // 模型据此误判为「file_create 往内容里注入了东西」，整整绕了几轮。
  // 这里先剥掉模型习惯性带上的 workspace 前缀再解析。
  const effective = workspaceBase && !path.isAbsolute(filePath)
    ? stripWorkspacePrefix(filePath)
    : filePath;
  const resolved = path.isAbsolute(effective)
    ? path.resolve(fsBase, effective)
    : path.resolve(workspaceBase || fsBase, effective);
  // 换算成 fsBase 相对路径（统一用正斜杠），供 FileSystemManager 解析
  const rel = path.relative(fsBase, resolved);
  const forFs = rel && !rel.startsWith("..") ? rel.split(path.sep).join("/") : resolved;
  return { resolved, forFs, display: effective };
}

/**
 * 按「总体安全等级」裁决一次文件访问。
 *
 * 接入点在此处（而非 PermissionManager），因为沙箱内外是**路径维度**的判定，
 * 与「哪个工具」无关。PermissionManager 仍负责白名单与 requestId 流程。
 *
 * 返回 `null` 表示放行；返回字符串表示拒绝原因；返回 `"__confirm__"` 时
 * 由调用方转成审批请求（一般档下沙箱外写入即走此分支）。
 */
function judgeBySecurityLevel(
  resolvedPath: string,
  fsBase: string,
  write: boolean,
): { decision: "allow" | "confirm" | "deny"; insideSandbox: boolean; reason?: string } {
  const policy = getActiveSecurityPolicy();
  const normalizedBase = path.resolve(fsBase);
  const insideSandbox =
    resolvedPath === normalizedBase || resolvedPath.startsWith(normalizedBase + path.sep);
  const decision = decideFileAccess(policy, { insideSandbox, write });
  if (decision === "allow") return { decision, insideSandbox };
  if (decision === "deny") {
    return {
      decision: "deny",
      insideSandbox,
      reason:
        `操作被安全策略拦截：当前为「${policy.label}」等级，只允许在沙箱（${normalizedBase}）内` +
        `${write ? "写入" : "读取"}文件，沙箱外路径一律禁止。` +
        `如需放开，请到「安全 → 总体安全」调整等级。`,
    };
  }
  return { decision: "confirm", insideSandbox };
}

/**
 * 文件操作前置检查：安全等级裁决 + 路径边界校验。
 *
 * 返回 `ok:false` 时直接拒绝；`ok:true` 时 `insideSandbox` 决定走
 * FileSystemManager 的常规入口还是 `operateAbsolute`（沙箱外已授权通道）。
 */
function preflight(
  resolvedPath: string,
  fsBase: string,
  write: boolean,
): { ok: false; error: string } | { ok: true; insideSandbox: boolean; needsConfirm: boolean } {
  const judge = judgeBySecurityLevel(resolvedPath, fsBase, write);
  if (judge.decision === "deny") return { ok: false, error: judge.reason! };
  if (judge.insideSandbox) {
    const pathError = validatePathWithinBase(resolvedPath, fsBase);
    if (pathError) return { ok: false, error: pathError };
    return { ok: true, insideSandbox: true, needsConfirm: false };
  }
  // 沙箱外：词法边界检查（路径穿越）已无意义——策略本身就允许越界，
  // 但符号链接一致性仍由 operateAbsolute 复核。
  return { ok: true, insideSandbox: false, needsConfirm: judge.decision === "confirm" };
}

export function registerFileTools(
  executor: AgentModelExecutor,
  permissionManager: PermissionManager,
  permissionRelay: PermissionRelay | undefined,
  errorRecoveryManager: ErrorRecoveryManager,
  fileSystemManager: FileSystemManager,
  fsBase: string,
  /** 相对路径的基准目录（通常是 data/workspace，已在白名单内）。缺省时退回 fsBase。 */
  workspaceBase?: string
): void {
  const fsMgr = fileSystemManager;
  const errRecovery = errorRecoveryManager;
  const permMgr = permissionManager;
  const permRelay = permissionRelay;

  executor.registerTool(
    "file_create",
    {
      name: "file_create",
      description: "Create a new file at the specified path with the given content. If the file already exists and overwrite is true, the file will be replaced. After creating a file, always inform the user of the file path and that they can download it via /api/files/download/{path}.",
      parameters: {
        path: { type: "string", description: "Relative file path to create", required: true },
        content: { type: "string", description: "Content to write to the file", required: true },
        overwrite: { type: "boolean", description: "Whether to overwrite if file already exists (default: false)", required: false, default: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const filePath = String(params.path || "");
      const content = String(params.content || "");
      const overwrite = params.overwrite === true;
      const { resolved: resolvedPath, forFs: fsPath, display } = resolveToolPath(fsBase, workspaceBase, filePath);
      const pf = preflight(resolvedPath, fsBase, true);
      if (!pf.ok) return { success: false, error: pf.error };
      // 沙箱外的写操作在「一般安全」档需要用户确认
      if (pf.needsConfirm) {
        const cReq = permMgr.requestPermission("file_create", filePath, { size: content.length, outsideSandbox: true }, "tool");
        if (cReq.status === "denied") {
          return { success: false, error: `Permission denied for file_create on ${filePath}. Request ID: ${cReq.id}` };
        }
        if (cReq.status === "pending") {
          permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_create", description: `创建沙箱外文件: ${filePath}`, params, category: "file" });
          return { success: false, requiresPermission: true, requestId: cReq.id, operation: "file_create", description: "创建文件", target: filePath, error: `该路径位于沙箱外，需要你确认后才能创建: ${filePath}` };
        }
      } else if (permMgr.isPathAutoApproved(resolvedPath, "file_create")) {
        permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_create", description: `创建文件: ${filePath}`, params, category: "file" });
      }
      const doCreate = async () => {
        const r = pf.insideSandbox
          ? await fsMgr.createFile(fsPath, content, overwrite)
          : await fsMgr.operateAbsolute(resolvedPath, content, "create", overwrite);
        // ★ 回报可直接复用的绝对路径。真实事故：早前只回报 fsBase 相对路径
        // （data/workspace/x.py），模型拿它当 cwd 又拼一次 →
        // `...\data\workspace\data\workspace`，连踩两个坑。
        return { ...(r as object), path: resolvedPath, workspaceRelative: display };
      };
      return await errRecovery.executeWithRetry("file_create", fsPath, doCreate);
    }
  );

  executor.registerTool(
    "file_modify",
    {
      name: "file_modify",
      description: "Modify an existing file's content",
      parameters: {
        path: { type: "string", description: "Relative file path to modify", required: true },
        content: { type: "string", description: "New content for the file", required: true },
      },
    },
    async (params: Record<string, unknown>) => {
      const filePath = String(params.path || "");
      const content = String(params.content || "");
      const { resolved: resolvedPath, forFs: fsPath, display } = resolveToolPath(fsBase, workspaceBase, filePath);
      const pf = preflight(resolvedPath, fsBase, true);
      if (!pf.ok) return { success: false, error: pf.error };
      if (pf.needsConfirm) {
        const cReq = permMgr.requestPermission("file_modify", filePath, { size: content.length, outsideSandbox: true }, "tool");
        if (cReq.status === "denied") {
          return { success: false, error: `Permission denied for file_modify on ${filePath}. Request ID: ${cReq.id}` };
        }
        if (cReq.status === "pending") {
          permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_modify", description: `修改沙箱外文件: ${filePath}`, params, category: "file" });
          return { success: false, requiresPermission: true, requestId: cReq.id, operation: "file_modify", description: "修改文件", target: filePath, error: `该路径位于沙箱外，需要你确认后才能修改: ${filePath}` };
        }
      } else if (permMgr.isPathAutoApproved(resolvedPath, "file_modify")) {
        permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_modify", description: `修改文件: ${filePath}`, params, category: "file" });
      }
      const doModify = async () => {
        const r = pf.insideSandbox
          ? await fsMgr.modifyFile(fsPath, content)
          : await fsMgr.operateAbsolute(resolvedPath, content, "modify", true);
        return { ...(r as object), path: resolvedPath, workspaceRelative: display };
      };
      return await errRecovery.executeWithRetry("file_modify", fsPath, doModify);
    }
  );

  executor.registerTool(
    "file_delete",
    {
      name: "file_delete",
      description: "Delete a file at the specified path",
      parameters: {
        path: { type: "string", description: "Relative file path to delete", required: true },
      },
    },
    async (params: Record<string, unknown>) => {
      const filePath = String(params.path || "");
      const { resolved: resolvedPath, forFs: fsPath, display } = resolveToolPath(fsBase, workspaceBase, filePath);
      const pf = preflight(resolvedPath, fsBase, true);
      if (!pf.ok) return { success: false, error: pf.error };
      if (pf.needsConfirm) {
        const cReq = permMgr.requestPermission("file_delete", filePath, { outsideSandbox: true }, "tool");
        if (cReq.status === "denied") {
          return { success: false, error: `Permission denied for file_delete on ${filePath}. Request ID: ${cReq.id}` };
        }
        if (cReq.status === "pending") {
          permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_delete", description: `删除沙箱外文件: ${filePath}`, params, category: "file" });
          return { success: false, requiresPermission: true, requestId: cReq.id, operation: "file_delete", description: "删除文件", target: filePath, error: `该路径位于沙箱外，需要你确认后才能删除: ${filePath}` };
        }
      } else if (permMgr.isPathAutoApproved(resolvedPath, "file_delete")) {
        permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_delete", description: `删除文件: ${filePath}`, params, category: "file" });
        return await errRecovery.executeWithRetry("file_delete", fsPath, async () => {
          if (pf.insideSandbox) await fsMgr.deleteFile(fsPath);
          else await fsMgr.deleteFileAbsolute(resolvedPath);
          return { success: true, path: filePath };
        });
      }
      const permRequest = permMgr.requestPermission("file_delete", filePath, {}, "tool");
      if (permRequest.status === "denied") {
        return { success: false, error: `Permission denied for file_delete on ${filePath}. Request ID: ${permRequest.id}` };
      }
      if (permRequest.status === "pending") {
        permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_delete", description: `删除文件: ${filePath}`, params, category: "file" });
        return { success: false, requiresPermission: true, requestId: permRequest.id, operation: "file_delete", description: permRequest.description, target: filePath, error: `Awaiting user approval to delete: ${filePath}` };
      }
      return await errRecovery.executeWithRetry("file_delete", fsPath, async () => {
        if (pf.insideSandbox) await fsMgr.deleteFile(fsPath);
        else await fsMgr.deleteFileAbsolute(resolvedPath);
        return { success: true, path: filePath };
      });
    }
  );

  executor.registerTool(
    "file_read",
    {
      name: "file_read",
      description: "Read the contents of a file",
      parameters: {
        path: { type: "string", description: "File path to read", required: true },
        offset: { type: "string", description: "Line number to start reading from (1-based, default: 1)" },
        limit: { type: "string", description: "Number of lines to read (default: all)" },
      },
    },
    async (params: Record<string, unknown>) => {
      const filePath = String(params.path || "");
      const { resolved: resolvedPath, forFs: fsPath, display } = resolveToolPath(fsBase, workspaceBase, filePath);
      const pf = preflight(resolvedPath, fsBase, false);
      if (!pf.ok) return { success: false, error: pf.error };
      // 「一般安全」档允许读取沙箱外的一般文件；只有严格档会在这里被拒（pf.ok=false）
      const readTarget = pf.insideSandbox
        ? () => fsMgr.readFile(fsPath)
        : () => Promise.resolve(fs.readFileSync(resolvedPath, "utf-8")) as Promise<string>;
      return await errRecovery.executeWithRetry("file_read", fsPath, async () => {
        let content = await readTarget();
        const parsedOffset = params.offset ? parseInt(String(params.offset), 10) : 1;
        const offset = Number.isFinite(parsedOffset) ? Math.max(1, parsedOffset) : 1;
        const parsedLimit = params.limit ? parseInt(String(params.limit), 10) : undefined;
        const limit = parsedLimit !== undefined && Number.isFinite(parsedLimit) ? Math.max(1, parsedLimit) : undefined;
        if (offset > 1 || limit) {
          const allLines = content.split("\n");
          const start = Math.max(0, offset - 1);
          const end = limit ? start + limit : allLines.length;
          content = allLines.slice(start, end).join("\n");
        }
        return { path: filePath, content };
      });
    }
  );

  executor.registerTool(
    "file_list",
    {
      name: "file_list",
      description: "List files and directories in a folder",
      parameters: {
        path: { type: "string", description: "Relative directory path to list" },
      },
    },
    async (params: Record<string, unknown>) => {
      const dirPath = String(params.path || ".");
      const { resolved: resolvedPath, forFs: fsDir } = resolveToolPath(fsBase, workspaceBase, dirPath);
      const pf = preflight(resolvedPath, fsBase, false);
      if (!pf.ok) return { success: false, error: pf.error };
      if (pf.insideSandbox) {
        return await errRecovery.executeWithRetry("file_list", fsDir, () => fsMgr.listAll(fsDir));
      }
      // 沙箱外目录列举（一般安全 / 一定风险档允许）
      return await errRecovery.executeWithRetry("file_list", fsDir, async () => {
        const entries = fs.readdirSync(resolvedPath, { withFileTypes: true }).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "directory" : "file",
        }));
        return { path: dirPath, entries };
      });
    }
  );
}
