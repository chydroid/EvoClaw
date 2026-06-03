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
          logs.push(...parsed);
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

    if (/^[a-zA-Z]:/.test(normalized)) {
      return normalized;
    }

    if (normalized.startsWith("/")) {
      return normalized;
    }

    return `${this.basePath}/${normalized}`.replace(/\/+/g, "/");
  }

  private async validatePath(fullPath: string): Promise<void> {
    const normalizedFull = path.resolve(fullPath);

    const dangerousPatterns = ["/etc/passwd", "/etc/shadow", "/proc/", "/sys/", "C:\\Windows\\System32", "/dev/null"];
    for (const pattern of dangerousPatterns) {
      if (normalizedFull.toLowerCase().includes(pattern.toLowerCase())) {
        throw new Error(`Access denied: restricted path pattern detected`);
      }
    }
  }

  private async writeContent(fullPath: string, content: string): Promise<void> {
    try {
      await writeFile(fullPath, content, "utf-8");
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
      fsSync.writeFileSync(logFile, JSON.stringify(entries, null, 2), "utf-8");
    } catch (err) {
      console.error(`[FileSystemManager] Audit log write failed:`, err);
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}