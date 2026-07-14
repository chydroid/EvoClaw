import * as path from "path";
import * as fs from "fs";
import type { AgentModelExecutor } from "@evoclaw/agent";
import type { PermissionManager, PermissionRelay } from "@evoclaw/security";
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

export function registerFileTools(
  executor: AgentModelExecutor,
  permissionManager: PermissionManager,
  permissionRelay: PermissionRelay | undefined,
  errorRecoveryManager: ErrorRecoveryManager,
  fileSystemManager: FileSystemManager,
  fsBase: string
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
      const resolvedPath = path.resolve(fsBase, filePath);
      const pathError = validatePathWithinBase(resolvedPath, fsBase);
      if (pathError) return { success: false, error: pathError };
      if (permMgr.isPathAutoApproved(resolvedPath, "file_create")) {
        permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_create", description: `创建文件: ${filePath}`, params, category: "file" });
        return await errRecovery.executeWithRetry("file_create", filePath, () => fsMgr.createFile(filePath, content, overwrite));
      }
      const permRequest = permMgr.requestPermission("file_create", filePath, { size: content.length }, "tool");
      if (permRequest.status === "denied") {
        return { success: false, error: `Permission denied for file_create on ${filePath}. Request ID: ${permRequest.id}` };
      }
      if (permRequest.status === "pending") {
        permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_create", description: `创建文件: ${filePath}`, params, category: "file" });
        return { success: false, requiresPermission: true, requestId: permRequest.id, operation: "file_create", description: permRequest.description, target: filePath, error: `Awaiting user approval to create: ${filePath}` };
      }
      return await errRecovery.executeWithRetry("file_create", filePath, () => fsMgr.createFile(filePath, content, overwrite));
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
      const resolvedPath = path.resolve(fsBase, filePath);
      const pathError = validatePathWithinBase(resolvedPath, fsBase);
      if (pathError) return { success: false, error: pathError };
      if (permMgr.isPathAutoApproved(resolvedPath, "file_modify")) {
        permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_modify", description: `修改文件: ${filePath}`, params, category: "file" });
        return await errRecovery.executeWithRetry("file_modify", filePath, () => fsMgr.modifyFile(filePath, content));
      }
      const permRequest = permMgr.requestPermission("file_modify", filePath, { size: content.length }, "tool");
      if (permRequest.status === "denied") {
        return { success: false, error: `Permission denied for file_modify on ${filePath}. Request ID: ${permRequest.id}` };
      }
      if (permRequest.status === "pending") {
        permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_modify", description: `修改文件: ${filePath}`, params, category: "file" });
        return { success: false, requiresPermission: true, requestId: permRequest.id, operation: "file_modify", description: permRequest.description, target: filePath, error: `Awaiting user approval to modify: ${filePath}` };
      }
      return await errRecovery.executeWithRetry("file_modify", filePath, () => fsMgr.modifyFile(filePath, content));
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
      const resolvedPath = path.resolve(fsBase, filePath);
      const pathError = validatePathWithinBase(resolvedPath, fsBase);
      if (pathError) return { success: false, error: pathError };
      if (permMgr.isPathAutoApproved(resolvedPath, "file_delete")) {
        permRelay?.request({ agentId: "system", sessionId: "default", toolName: "file_delete", description: `删除文件: ${filePath}`, params, category: "file" });
        return await errRecovery.executeWithRetry("file_delete", filePath, async () => {
          await fsMgr.deleteFile(filePath);
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
      return await errRecovery.executeWithRetry("file_delete", filePath, async () => {
        await fsMgr.deleteFile(filePath);
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
      const resolvedPath = path.resolve(fsBase, filePath);
      const pathError = validatePathWithinBase(resolvedPath, fsBase);
      if (pathError) return { success: false, error: pathError };
      return await errRecovery.executeWithRetry("file_read", filePath, async () => {
        let content = await fsMgr.readFile(filePath);
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
      const resolvedPath = path.resolve(fsBase, dirPath);
      const pathError = validatePathWithinBase(resolvedPath, fsBase);
      if (pathError) return { success: false, error: pathError };
      return await errRecovery.executeWithRetry("file_list", dirPath, () => fsMgr.listAll(dirPath));
    }
  );
}
