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
import { exec } from "child_process";

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
  cmd: string;
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
      { name: "ps", cmd: "ps aux" },
      { name: "pstree", cmd: `pstree -p ${process.pid}` },
      { name: "dmesg", cmd: "dmesg | tail -100" },
    ];

    const sections: string[] = [];
    for (const { name, cmd } of commands) {
      const output = await this.runCommand(name, cmd);
      sections.push(output);
    }

    fs.writeFileSync(logPath, sections.join("\n"), "utf8");
  }

  /** 运行单个诊断命令，返回格式化的输出段。 */
  private runCommand(name: string, cmd: string): Promise<string> {
    return new Promise((resolve) => {
      exec(cmd, { timeout: DIAGNOSTIC_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) {
          resolve(`=== ${name} (failed: ${err.message}) ===\n`);
          return;
        }
        const combined = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
        resolve(`=== ${name} ===\n${combined}\n`);
      });
    });
  }
}
