/**
 * 滚动文件日志 Appender（对齐 openclaw-main 的 logging/redact.ts + pruneOldRollingLogs + rotateLogFile）。
 *
 * 设计要点：
 * - 单文件大小上限（默认 100MB），超过后自动滚动到 .1 / .2 / .3 后缀
 * - 滚动文件数量上限（默认 5 个），超出时删除最旧的
 * - 写入使用 fs.createWriteStream + append，每行 flush
 * - 原子重命名：先写 .tmp 再 rename，防止读时看到半写入
 * - pruneOldRollingLogs：启动时清理孤儿文件与超量文件
 */

import fs from "fs";
import path from "path";

export interface RotatingFileAppenderConfig {
  /** 日志文件路径 */
  filePath: string;
  /** 单文件最大字节数（默认 100MB） */
  maxFileSize?: number;
  /** 滚动文件数量上限（默认 5） */
  maxFiles?: number;
  /** 是否同步写入（默认 false，异步） */
  sync?: boolean;
}

interface InternalState {
  stream: fs.WriteStream | null;
  currentSize: number;
  rotating: boolean;
}

const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const DEFAULT_MAX_FILES = 5;

/**
 * 滚动文件 Appender。
 *
 * 使用方式：
 * ```ts
 * const appender = new RotatingFileAppender({ filePath: "logs/evoclaw.log" });
 * appender.append("[2026-01-01T00:00:00Z] INFO message\n");
 * ```
 */
export class RotatingFileAppender {
  private config: Required<RotatingFileAppenderConfig>;
  private state: InternalState = {
    stream: null,
    currentSize: 0,
    rotating: false,
  };

  constructor(config: RotatingFileAppenderConfig) {
    this.config = {
      maxFileSize: DEFAULT_MAX_FILE_SIZE,
      maxFiles: DEFAULT_MAX_FILES,
      sync: false,
      ...config,
    };
    this.openStream();
  }

  /** 打开写入流并初始化当前文件大小。 */
  private openStream(): void {
    try {
      // 确保目录存在
      const dir = path.dirname(this.config.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // 获取当前文件大小（若存在）
      try {
        const stat = fs.statSync(this.config.filePath, { throwIfNoEntry: false });
        this.state.currentSize = stat ? stat.size : 0;
      } catch {
        this.state.currentSize = 0;
      }
      // 以 append 模式打开流
      this.state.stream = fs.createWriteStream(this.config.filePath, {
        flags: "a",
        encoding: "utf8",
      });
      this.state.stream.on("error", (err) => {
        process.stderr.write(`[RotatingFileAppender] Stream error: ${err.message}\n`);
      });
    } catch (err) {
      process.stderr.write(`[RotatingFileAppender] Failed to open stream: ${err}\n`);
    }
  }

  /** 追加一行日志。若超出大小上限，先滚动再写入。 */
  append(line: string): void {
    if (this.state.rotating) {
      // 滚动中：直接丢弃避免递归（理论上不应发生）
      return;
    }
    const byteLength = Buffer.byteLength(line, "utf8");

    // 检查是否需要滚动（提前判断，避免写入后再滚动）
    if (this.state.currentSize + byteLength > this.config.maxFileSize) {
      this.rotate();
    }

    if (this.config.sync) {
      try {
        fs.appendFileSync(this.config.filePath, line, { encoding: "utf8" });
        this.state.currentSize += byteLength;
      } catch (err) {
        process.stderr.write(`[RotatingFileAppender] Sync append failed: ${err}\n`);
      }
    } else {
      if (!this.state.stream || this.state.stream.destroyed) {
        this.openStream();
      }
      this.state.stream?.write(line, "utf8", (err) => {
        if (err) {
          process.stderr.write(`[RotatingFileAppender] Write error: ${err.message}\n`);
        }
      });
      this.state.currentSize += byteLength;
    }
  }

  /**
   * 滚动当前日志文件：
   * 1. 关闭当前流
   * 2. 将 evoclaw.log.4 → 删除（最旧）
   * 3. 将 evoclaw.log.3 → evoclaw.log.4
   * 4. 将 evoclaw.log.2 → evoclaw.log.3
   * 5. 将 evoclaw.log.1 → evoclaw.log.2
   * 6. 将 evoclaw.log → evoclaw.log.1
   * 7. 重新打开新流
   */
  rotate(): void {
    if (this.state.rotating) return;
    this.state.rotating = true;
    try {
      // 关闭当前流
      if (this.state.stream) {
        try {
          this.state.stream.end();
        } catch {
          // ignore
        }
        this.state.stream = null;
      }

      const basePath = this.config.filePath;
      const maxFiles = this.config.maxFiles;

      // 删除最旧的滚动文件
      const oldestPath = `${basePath}.${maxFiles - 1}`;
      try {
        if (fs.existsSync(oldestPath)) {
          fs.unlinkSync(oldestPath);
        }
      } catch (err) {
        process.stderr.write(`[RotatingFileAppender] Failed to delete oldest: ${err}\n`);
      }

      // 从新到旧依次重命名：.maxFiles-2 → .maxFiles-1, ..., .1 → .2, .log → .1
      for (let i = maxFiles - 2; i >= 1; i--) {
        const src = `${basePath}.${i}`;
        const dst = `${basePath}.${i + 1}`;
        try {
          if (fs.existsSync(src)) {
            fs.renameSync(src, dst);
          }
        } catch (err) {
          process.stderr.write(`[RotatingFileAppender] Rename ${src} → ${dst} failed: ${err}\n`);
        }
      }
      // 当前文件 → .1
      try {
        if (fs.existsSync(basePath)) {
          fs.renameSync(basePath, `${basePath}.1`);
        }
      } catch (err) {
        process.stderr.write(`[RotatingFileAppender] Rename current → .1 failed: ${err}\n`);
      }

      // 重新打开流
      this.state.currentSize = 0;
      this.openStream();
    } finally {
      this.state.rotating = false;
    }
  }

  /** 关闭流（优雅关闭时调用）。 */
  close(): void {
    if (this.state.stream) {
      try {
        this.state.stream.end();
      } catch {
        // ignore
      }
      this.state.stream = null;
    }
  }

  /** 获取当前状态（用于诊断）。 */
  getStatus(): { currentSize: number; maxFileSize: number; maxFiles: number; rotating: boolean } {
    return {
      currentSize: this.state.currentSize,
      maxFileSize: this.config.maxFileSize,
      maxFiles: this.config.maxFiles,
      rotating: this.state.rotating,
    };
  }
}

/**
 * 清理过期的滚动日志文件。
 * 在启动时调用，删除超出 maxFiles 的孤儿文件，以及损坏的临时文件。
 */
export function pruneOldRollingLogs(params: {
  basePath: string;
  maxFiles: number;
}): { deleted: string[]; errors: string[] } {
  const { basePath, maxFiles } = params;
  const dir = path.dirname(basePath);
  const baseName = path.basename(basePath);
  const deleted: string[] = [];
  const errors: string[] = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    // 收集所有滚动文件，按编号排序
    const rotatedFiles: Array<{ name: string; index: number; fullPath: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // 匹配 baseName.N 或 baseName.tmp
      const match = entry.name.match(new RegExp(`^${escapeRegex(baseName)}\\.(\\d+)$`));
      if (match) {
        const idx = parseInt(match[1], 10);
        rotatedFiles.push({
          name: entry.name,
          index: idx,
          fullPath: path.join(dir, entry.name),
        });
      }
      // 清理 .tmp 残留
      if (entry.name === `${baseName}.tmp`) {
        try {
          fs.unlinkSync(path.join(dir, entry.name));
          deleted.push(entry.name);
        } catch (err) {
          errors.push(`Failed to delete ${entry.name}: ${err}`);
        }
      }
    }
    // 按编号降序排序
    rotatedFiles.sort((a, b) => b.index - a.index);
    // 删除编号 >= maxFiles 的文件
    for (const file of rotatedFiles) {
      if (file.index >= maxFiles) {
        try {
          fs.unlinkSync(file.fullPath);
          deleted.push(file.name);
        } catch (err) {
          errors.push(`Failed to delete ${file.name}: ${err}`);
        }
      }
    }
  } catch (err) {
    errors.push(`pruneOldRollingLogs failed: ${err}`);
  }

  return { deleted, errors };
}

/** 转义正则特殊字符。 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
