import { ServiceRegistry, EventBus } from "@evoclaw/core";
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
 * 原子写入工具：temp + fsync + rename，保证崩溃时不会产生截断文件。
 * 符号链接目标会被解析后原地替换，保留符号链接。
 * 跨设备（EXDEV/EBUSY）时回退到 目标侧 temp + fsync + rename（保持原子性）。
 * 保留原文件权限位（修复 Docker/NAS 卷挂载权限问题）。
 *
 * 临时文件名包含 pid + 随机后缀，避免同进程并发写入同一目标时冲突。
 *
 * 灵感来自 hermes-agent 的 utils.py atomic_json_write/atomic_replace。
 */
export async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
  // 临时文件名包含 pid + 随机后缀，避免同进程并发写入同一目标时冲突
  const tmpPath = `${targetPath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  // 写入临时文件；异常时清理临时文件，避免泄漏
  const fd = fsSync.openSync(tmpPath, "w");
  try {
    fsSync.writeFileSync(fd, content, "utf-8");
    fsSync.fsyncSync(fd);
  } catch (err) {
    try { fsSync.closeSync(fd); } catch { /* ignore */ }
    try { fsSync.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  fsSync.closeSync(fd);
  // 保留原文件权限位
  try {
    if (fsSync.existsSync(targetPath)) {
      const st = fsSync.statSync(targetPath);
      fsSync.chmodSync(tmpPath, st.mode);
    }
  } catch {
    // 权限复制失败不阻断写入
  }
  // 原子替换：处理符号链接和跨设备
  try {
    await atomicReplace(tmpPath, targetPath);
  } catch (err) {
    try { fsSync.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * 原子替换：将 src 替换为 dst。
 * 如果 dst 是符号链接，解析 realpath 后原地替换，保留符号链接。
 * 跨设备时回退到 目标侧 temp + fsync + rename（保持原子性）。
 */
export async function atomicReplace(src: string, dst: string): Promise<void> {
  let realDst = dst;
  try {
    const st = fsSync.lstatSync(dst);
    if (st.isSymbolicLink()) {
      realDst = fsSync.realpathSync(dst);
    }
  } catch {
    // dst 不存在，直接使用 dst
  }
  try {
    fsSync.renameSync(src, realDst);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EXDEV" || code === "EBUSY") {
      // 跨设备：在目标侧写临时文件后 rename，保持原子性
      const dstDir = path.dirname(realDst);
      const dstTmp = path.join(dstDir, `.${path.basename(realDst)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
      const content = fsSync.readFileSync(src, "utf-8");
      const fd = fsSync.openSync(dstTmp, "w");
      try {
        fsSync.writeFileSync(fd, content, "utf-8");
        fsSync.fsyncSync(fd);
      } catch (werr) {
        try { fsSync.closeSync(fd); } catch { /* ignore */ }
        try { fsSync.unlinkSync(dstTmp); } catch { /* ignore */ }
        try { fsSync.unlinkSync(src); } catch { /* ignore */ }
        throw werr;
      }
      fsSync.closeSync(fd);
      try {
        // 保留原文件权限位
        if (fsSync.existsSync(realDst)) {
          const st = fsSync.statSync(realDst);
          fsSync.chmodSync(dstTmp, st.mode);
        }
      } catch { /* ignore */ }
      try {
        fsSync.renameSync(dstTmp, realDst);
      } catch (rerr) {
        try { fsSync.unlinkSync(dstTmp); } catch { /* ignore */ }
        try { fsSync.unlinkSync(src); } catch { /* ignore */ }
        throw rerr;
      }
      try { fsSync.unlinkSync(src); } catch { /* ignore */ }
    } else {
      throw err;
    }
  }
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
            // 死进程的锁，清理后重试
            fsSync.unlinkSync(this.lockPath);
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
        await new Promise((resolve) => setTimeout(resolve, CrossProcessLock.POLL_INTERVAL_MS));
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
      await access(this.resolvePath(relativePath), constants.F_OK);
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
    // Verify the resolved path is still within basePath to prevent traversal
    const resolved = path.resolve(fullDir);
    const baseResolved = path.resolve(this.basePath);
    if (!resolved.startsWith(baseResolved) && resolved !== baseResolved) {
      throw new Error(`Directory outside base path: ${fullDir}`);
    }

    try {
      await mkdir(resolved, { recursive: true });
    } catch {
      throw new Error(`Unable to create directory: ${resolved}`);
    }
  }

  async listDir(relativePath: string): Promise<FileInfo[]> {
    const fullPath = this.resolvePath(relativePath);
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
  }

  private async writeContent(fullPath: string, content: string): Promise<void> {
    try {
      await atomicWriteFile(fullPath, content);
    } catch {
      throw new Error(`Unable to write file: ${fullPath}`);
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