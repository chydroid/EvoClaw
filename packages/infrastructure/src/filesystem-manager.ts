import { ServiceRegistry, EventBus, atomicWriteFileSync, atomicReplaceSync } from "@evoclaw/core";
import { readFile, writeFile, unlink, access, mkdir, readdir, stat } from "fs/promises";
import { constants } from "fs";
import * as fsSync from "fs";
import * as path from "path";

interface FileInfo {
  path: string;
  size: number;
  modifiedAt: Date;
  createdAt: Date;
}

interface AuditLogEntry {
  timestamp: string;
  operation: "create" | "modify" | "delete" | "read";
  filePath: string;
  success: boolean;
  error?: string;
}

/**
 * 原子写入工具：委托给 @evoclaw/core 的 atomicWriteFileSync。
 * 保持异步签名，避免 infrastructure 调用方改动。
 */
export async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  atomicWriteFileSync(targetPath, content);
}

/**
 * 原子替换：委托给 @evoclaw/core 的 atomicReplaceSync。
 * 保持异步签名，避免 infrastructure 调用方改动。
 */
export async function atomicReplace(src: string, dst: string): Promise<void> {
  atomicReplaceSync(src, dst);
}

/**
 * 跨进程文件锁。
 * 使用 flag:"wx" 原子创建锁文件 + PID 写入 + stale lock 检测。
 * 支持可重入（同进程多次 acquire）和超时。
 *
 * 灵感来自 hermes-agent 的 cron/jobs.py _jobs_lock() 和 SessionManager 的实现。
 */
export class CrossProcessLock {
  private static readonly LOCK_SUFFIX = ".lock";
  private static readonly DEFAULT_TIMEOUT_MS = 60_000;
  private static readonly POLL_INTERVAL_MS = 100;

  constructor(
    private readonly lockDir: string,
    private readonly lockName: string
  ) {
    if (!fsSync.existsSync(lockDir)) {
      fsSync.mkdirSync(lockDir, { recursive: true });
    }
  }

  private get lockPath(): string {
    return path.join(this.lockDir, `${this.lockName}${CrossProcessLock.LOCK_SUFFIX}`);
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      // ESRCH: 进程不存在；EPERM: 进程存在但无权限（Windows 上常见）。
      // 仅当 ESRCH 才认为进程已死，EPERM 视为进程存活，避免误删他人持有的锁。
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EPERM") return true;
      return false;
    }
  }

  async acquire(timeoutMs: number = CrossProcessLock.DEFAULT_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const pid = process.pid;
    while (Date.now() < deadline) {
      try {
        fsSync.writeFileSync(this.lockPath, JSON.stringify({ pid, acquiredAt: Date.now() }), {
          flag: "wx",
        });
        return;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EEXIST") throw err;
        // 锁文件已存在，检查是否为 stale lock
        try {
          const raw = fsSync.readFileSync(this.lockPath, "utf-8");
          const data = JSON.parse(raw) as { pid: number; acquiredAt: number };
          if (!this.isProcessAlive(data.pid)) {
            // Stale lock — 原子地 rename 到唯一临时名后删除，避免 TOCTOU 竞态。
            // 两个进程可能同时判断 lock 为 stale，rename 是原子的，只有一个会成功，
            // 另一个会因 ENOENT 失败（被 catch 后 continue），避免误删另一进程刚创建的新锁文件。
            const staleTmp = `${this.lockPath}.${process.pid}.${Date.now()}.stale`;
            try {
              fsSync.renameSync(this.lockPath, staleTmp);
              try { fsSync.unlinkSync(staleTmp); } catch { /* ignore */ }
            } catch (renameErr: unknown) {
              const code = (renameErr as NodeJS.ErrnoException)?.code;
              if (code === "ENOENT") {
                // 另一个进程已经处理了 stale lock，直接重试创建
              } else {
                throw renameErr;
              }
            }
            continue;
          }
        } catch {
          // 锁文件损坏或无法解析，清理后重试
          try {
            fsSync.unlinkSync(this.lockPath);
          } catch {
            // 忽略
          }
          continue;
        }
        await new Promise((resolve) => {
          const t = setTimeout(resolve, CrossProcessLock.POLL_INTERVAL_MS);
          t.unref?.();
        });
      }
    }
    throw new Error(`Lock acquisition timed out after ${timeoutMs}ms: ${this.lockPath}`);
  }

  release(): void {
    try {
      const raw = fsSync.readFileSync(this.lockPath, "utf-8");
      const data = JSON.parse(raw) as { pid: number };
      if (data.pid === process.pid) {
        fsSync.unlinkSync(this.lockPath);
      }
    } catch {
      // 锁文件不存在或损坏，忽略
    }
  }

  async withLock<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export class FileSystemManager {
  private basePath = ".";
  private auditLogPath = "";

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    registry.registerService("fileSystemManager", this);
  }

  setBasePath(path: string): void {
    this.basePath = path;
    this.auditLogPath = `${path}/data/audit`;
  }

  async readFile(relativePath: string): Promise<string> {
    const fullPath = this.resolvePath(relativePath);
    await this.validatePath(fullPath);
    const content = await readFile(fullPath, "utf-8");
    await this.writeAuditLog("read", relativePath, true);
    return content;
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = this.resolvePath(relativePath);
    await this.validatePath(fullPath);
    const existed = fsSync.existsSync(fullPath);
    await this.ensureDir(relativePath);
    await this.writeContent(fullPath, content);
    await this.writeAuditLog(existed ? "modify" : "create", relativePath, true);
  }

  async deleteFile(relativePath: string): Promise<void> {
    const fullPath = this.resolvePath(relativePath);
    await this.validatePath(fullPath);

    try {
      await access(fullPath, constants.F_OK);
      await unlink(fullPath);
      await this.writeAuditLog("delete", relativePath, true);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.writeAuditLog("delete", relativePath, false, errorMsg);
      throw err;
    }
  }

  async createFile(relativePath: string, content: string, overwrite = false): Promise<{ path: string; size: number; created: boolean }> {
    const fullPath = this.resolvePath(relativePath);
    await this.validatePath(fullPath);

    const existed = fsSync.existsSync(fullPath);
    if (existed && !overwrite) {
      throw new Error(`File already exists: ${relativePath}`);
    }

    await this.ensureDir(relativePath);
    await this.writeContent(fullPath, content);
    await this.writeAuditLog(existed ? "modify" : "create", relativePath, true);

    const fileStat = await stat(fullPath);
    return { path: relativePath, size: fileStat.size, created: !existed };
  }

  /**
 * 在**调用方已完成授权裁决**的前提下，对任意绝对路径执行文件操作。
 *
 * ⚠️ 这是给「总体安全等级」用的显式通道，**不是绕过**：
 *   - 调用方（file-tools）必须先用 `decideFileAccess()` 判定 allow，
 *     或在 confirm 档位走完审批流程拿到批准，才允许调用本方法；
 *   - 本方法自身仍做 realpath 规范化与符号链接一致性检查，
 *     防止「授权的是 A 路径、实际写到 B 路径」这种调包；
 *   - 一切操作照常写审计日志。
 *
 * 默认路径（沙箱内）请继续用 createFile/modifyFile，它们走 basePath 校验。
 */
async operateAbsolute(
  absolutePath: string,
  content: string,
  mode: "create" | "modify",
  overwrite = false,
): Promise<{ path: string; size: number; created: boolean }> {
  const fullPath = path.resolve(absolutePath);
  // 授权的是哪个路径就必须是哪个路径：realpath 后必须仍指向同一目标，
  // 防止用符号链接把一次「可写 A」的授权偷换成「实际写 B」。
  if (fsSync.existsSync(fullPath)) {
    const real = await fsSync.promises.realpath(fullPath);
    if (real !== fullPath && path.resolve(real) !== fullPath) {
      throw new Error(
        `Symbolic link target mismatch: authorized "${fullPath}" resolves to "${real}". Refusing to operate on a different target.`,
      );
    }
  }

  const existed = fsSync.existsSync(fullPath);
  if (mode === "create" && existed && !overwrite) {
    throw new Error(`File already exists: ${absolutePath}`);
  }
  if (mode === "modify" && !existed) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  await fsSync.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fsSync.promises.writeFile(fullPath, content, "utf-8");
  await this.writeAuditLog(existed ? "modify" : "create", absolutePath, true);

  const fileStat = await stat(fullPath);
  return { path: absolutePath, size: fileStat.size, created: !existed };
}

/**
 * 在**调用方已完成授权裁决**的前提下删除任意绝对路径。
 * 与 {@link operateAbsolute} 同一条通道，审计日志照常写。
 */
async deleteFileAbsolute(absolutePath: string): Promise<void> {
  const fullPath = path.resolve(absolutePath);
  if (!fsSync.existsSync(fullPath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }
  // 只删文件本身；目录删除是另一类高危操作，不在此通道内放开
  if (fsSync.statSync(fullPath).isDirectory()) {
    throw new Error(`Refusing to delete a directory via the trusted path: ${absolutePath}`);
  }
  await fsSync.promises.unlink(fullPath);
  await this.writeAuditLog("delete", absolutePath, true);
}

async modifyFile(relativePath: string, content: string): Promise<{ path: string; size: number }> {
    const fullPath = this.resolvePath(relativePath);
    await this.validatePath(fullPath);

    if (!fsSync.existsSync(fullPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }

    await this.writeContent(fullPath, content);
    await this.writeAuditLog("modify", relativePath, true);

    const fileStat = await stat(fullPath);
    return { path: relativePath, size: fileStat.size };
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      // 安全：使用 validatePath 防止符号链接逃逸（resolvePath 仅做词法校验）
      const fullPath = this.resolvePath(relativePath);
      try {
        await this.validatePath(fullPath);
      } catch {
        return false;
      }
      await access(fullPath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async ensureDir(relativePath: string): Promise<void> {
    const parts = relativePath.replace(/\\/g, "/").split("/");
    const dirs = parts.slice(0, -1).join("/");

    if (!dirs) return;

    const fullDir = this.resolvePath(dirs);
    // 安全：使用 validatePath 防止符号链接逃逸（path.resolve 不解析 symlink）
    await this.validatePath(fullDir);

    try {
      await mkdir(fullDir, { recursive: true });
    } catch {
      throw new Error(`Unable to create directory: ${fullDir}`);
    }
  }

  async listDir(relativePath: string): Promise<FileInfo[]> {
    const fullPath = this.resolvePath(relativePath);
    // 安全：使用 validatePath 防止符号链接逃逸
    await this.validatePath(fullPath);
    const entries = await readdir(fullPath, { withFileTypes: true });

    const files: FileInfo[] = [];
    for (const entry of entries) {
      const relPath = `${relativePath}/${entry.name}`.replace(/\/+/g, "/");
      try {
        const s = await stat(this.resolvePath(relPath));
        files.push({
          path: relPath,
          size: s.size,
          modifiedAt: s.mtime,
          createdAt: s.birthtime,
        });
      } catch {
        files.push({
          path: relPath,
          size: 0,
          modifiedAt: new Date(),
          createdAt: new Date(),
        });
      }
    }
    return files;
  }

  async listAll(
    relativePath: string
  ): Promise<{ files: FileInfo[]; dirs: string[] }> {
    const fullPath = this.resolvePath(relativePath);
    // 安全：使用 validatePath 防止符号链接逃逸
    await this.validatePath(fullPath);
    const entries = await readdir(fullPath, { withFileTypes: true });

    const files: FileInfo[] = [];
    const dirs: string[] = [];

    for (const entry of entries) {
      const relPath = `${relativePath}/${entry.name}`;
      if (entry.isDirectory()) {
        dirs.push(relPath);
      } else {
        try {
          const s = await stat(this.resolvePath(relPath));
          files.push({
            path: relPath,
            size: s.size,
            modifiedAt: s.mtime,
            createdAt: s.birthtime,
          });
        } catch {
          files.push({
            path: relPath,
            size: 0,
            modifiedAt: new Date(),
            createdAt: new Date(),
          });
        }
      }
    }

    return { files, dirs };
  }

  async getAuditLogs(limit = 50): Promise<AuditLogEntry[]> {
    if (!this.auditLogPath) return [];

    try {
      if (!fsSync.existsSync(this.auditLogPath)) return [];
      const entries = await readdir(this.auditLogPath, { withFileTypes: true });
      const logFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .sort((a, b) => b.name.localeCompare(a.name));

      const logs: AuditLogEntry[] = [];
      for (const logFile of logFiles) {
        if (logs.length >= limit) break;
        try {
          const content = fsSync.readFileSync(
            path.join(this.auditLogPath, logFile.name),
            "utf-8"
          );
          const parsed = JSON.parse(content) as AuditLogEntry[];
          logs.push(...[...parsed].reverse());
        } catch {
          continue;
        }
      }

      return logs.slice(0, limit);
    } catch {
      return [];
    }
  }

  private resolvePath(relativePath: string): string {
    // 安全：拒绝 UNC 路径（如 \\server\share、\\?\C:\、\\.\COM1），
    // 防止通过 UNC 路径绕过 basePath 限制访问任意网络/设备资源。
    if (relativePath.startsWith("\\\\")) {
      throw new Error(`Access denied: UNC paths are not allowed. Use relative paths within the workspace.`);
    }

    const normalized = relativePath.replace(/\\/g, "/");

    // Block absolute paths - all paths must be relative to basePath
    if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith("/")) {
      throw new Error(`Access denied: absolute paths are not allowed. Use relative paths within the workspace.`);
    }

    // Block path traversal
    if (normalized.includes("..")) {
      throw new Error(`Access denied: path traversal ("..") is not allowed.`);
    }

    return `${this.basePath}/${normalized}`.replace(/\/+/g, "/");
  }

  private async validatePath(fullPath: string): Promise<void> {
    const normalizedFull = path.resolve(fullPath);
    const normalizedBase = path.resolve(this.basePath);

    // Whitelist approach: only allow paths within basePath
    if (!normalizedFull.startsWith(normalizedBase + path.sep) && normalizedFull !== normalizedBase) {
      throw new Error(`Access denied: path outside base directory`);
    }

    // 防符号链接逃逸：realpath 解析后再次校验
    try {
      const real = await fsSync.promises.realpath(normalizedFull);
      if (!real.startsWith(normalizedBase + path.sep) && real !== normalizedBase) {
        throw new Error(`Access denied: symlink escapes base directory`);
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        // 目标文件不存在（create 场景）：校验父目录 realpath，防止通过符号链接父目录逃逸
        try {
          const parentDir = path.dirname(normalizedFull);
          const realParent = await fsSync.promises.realpath(parentDir);
          if (!realParent.startsWith(normalizedBase + path.sep) && realParent !== normalizedBase) {
            throw new Error(`Access denied: parent symlink escapes base directory`);
          }
        } catch (parentErr: unknown) {
          const parentCode = (parentErr as NodeJS.ErrnoException)?.code;
          if (parentCode === "ENOENT") return; // 父目录也不存在，允许后续 ensureDir 创建
          throw parentErr;
        }
        return;
      }
      throw err;
    }
  }

  private async writeContent(fullPath: string, content: string): Promise<void> {
    try {
      await atomicWriteFile(fullPath, content);
    } catch (err) {
      throw new Error(`Unable to write file: ${fullPath}`, { cause: err });
    }
  }

  private async writeAuditLog(
    operation: string,
    filePath: string,
    success: boolean,
    error?: string
  ): Promise<void> {
    try {
      if (!this.auditLogPath) return;
      if (!fsSync.existsSync(this.auditLogPath)) {
        fsSync.mkdirSync(this.auditLogPath, { recursive: true });
      }

      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const logFile = path.join(this.auditLogPath, `audit-${dateStr}.json`);

      const entry: AuditLogEntry = {
        timestamp: now.toISOString(),
        operation: operation as AuditLogEntry["operation"],
        filePath,
        success,
        ...(error ? { error } : {}),
      };

      // 使用跨进程锁保护审计日志的读-改-写
      const lock = new CrossProcessLock(this.auditLogPath, `audit-${dateStr}`);
      await lock.withLock(async () => {
        let entries: AuditLogEntry[] = [];
        if (fsSync.existsSync(logFile)) {
          try {
            const existing = fsSync.readFileSync(logFile, "utf-8");
            entries = JSON.parse(existing);
          } catch {
            entries = [];
          }
        }
        entries.push(entry);
        await atomicWriteFile(logFile, JSON.stringify(entries, null, 2));
      });
    } catch (err) {
      process.stderr.write(`[FileSystemManager] Audit log write failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}