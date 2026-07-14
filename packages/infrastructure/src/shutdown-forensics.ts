/**
 * ShutdownForensics — 关闭取证快照。
 *
 * 借鉴 hermes-agent 的 shutdown_forensics.py：
 * - 收到 SIGTERM/SIGINT 时同步写入关闭上下文快照
 * - 异步运行诊断命令（ps/pstree/dmesg）到独立日志
 * - Windows 跳过诊断命令
 *
 * 快照使用原子写入（temp + fsync + rename），确保进程退出前数据落盘。
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";

/** 关闭上下文快照内容 */
export interface ShutdownSnapshot {
  timestamp: string;
  signal: string;
  pid: number;
  ppid: number;
  platform: string;
  arch: string;
  nodeVersion: string;
  uptime: number;
  memoryUsage: NodeJS.MemoryUsage;
  cwd: string;
  argv: string[];
}

/** 诊断命令定义 */
interface DiagnosticCommand {
  name: string;
  command: string;
  args: string[];
  tailLines?: number;
}

const DIAGNOSTIC_TIMEOUT_MS = 5000;

export class ShutdownForensics {
  private readonly outputDir: string;

  constructor(outputDir?: string) {
    this.outputDir = outputDir ?? path.join(process.cwd(), "data", "logs");
  }

  /**
   * 同步快照关闭上下文，写到 data/logs/shutdown-<timestamp>.json。
   * 使用原子写入（temp + fsync + rename），确保进程退出前数据落盘。
   * @returns 写入的文件路径
   */
  snapshotShutdownContext(signal: string): string {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    const timestamp = Date.now();
    const snapshot: ShutdownSnapshot = {
      timestamp: new Date(timestamp).toISOString(),
      signal,
      pid: process.pid,
      ppid: process.ppid,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      cwd: process.cwd(),
      argv: process.argv,
    };

    const filePath = path.join(this.outputDir, `shutdown-${timestamp}.json`);
    const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;

    // 原子写入：temp → fsync → rename
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(snapshot, null, 2), "utf8");
      fs.fsyncSync(fd);
    } catch (err) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
    fs.closeSync(fd);

    try {
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }

    return filePath;
  }

  /**
   * 异步运行诊断命令（ps/pstree/dmesg），写到独立 log。
   * Windows 跳过诊断命令（直接返回）。
   */
  async spawnDiagnostics(logPath: string): Promise<void> {
    if (process.platform === "win32") {
      return;
    }

    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const commands: DiagnosticCommand[] = [
      { name: "ps", command: "ps", args: ["aux"] },
      { name: "pstree", command: "pstree", args: ["-p", String(process.pid)] },
      { name: "dmesg", command: "dmesg", args: [], tailLines: 100 },
    ];

    const sections: string[] = [];
    for (const diag of commands) {
      const output = await this.runCommand(diag);
      sections.push(output);
    }

    fs.writeFileSync(logPath, sections.join("\n"), "utf8");
  }

  /** 运行单个诊断命令，返回格式化的输出段。使用 execFile 避免 shell 注入。 */
  private runCommand(diag: DiagnosticCommand): Promise<string> {
    return new Promise((resolve) => {
      execFile(
        diag.command,
        diag.args,
        { timeout: DIAGNOSTIC_TIMEOUT_MS, shell: false },
        (err, stdout, stderr) => {
          if (err) {
            resolve(`=== ${diag.name} (failed: ${err.message}) ===\n`);
            return;
          }
          let out = stdout;
          if (diag.tailLines && diag.tailLines > 0) {
            const lines = out.split("\n");
            out = lines.slice(-diag.tailLines).join("\n");
          }
          const combined = out + (stderr ? `\n[stderr]\n${stderr}` : "");
          resolve(`=== ${diag.name} ===\n${combined}\n`);
        }
      );
    });
  }
}
