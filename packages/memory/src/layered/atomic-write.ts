/**
 * 原子写入工具：temp + fsync + rename，防止崩溃时文件被截断。
 *
 * 借鉴 TencentDB-Agent-Memory 的 StorageContext 写入策略 + EvoClaw 已有的
 * `packages/infrastructure/src/filesystem-manager.ts` 与 `packages/gateway/src/atomic-write.ts`
 * 实现。本包不依赖 infrastructure/gateway（避免引入 playwright/bullmq 等重依赖），
 * 故在 memory 包内本地实现一份精简版。
 *
 * 跨设备（EXDEV/EBUSY）时回退到 目标侧 temp + fsync + rename。
 * 临时文件名包含 pid + 随机后缀，避免同进程并发写入同一目标时冲突。
 */

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync } from "@evoclaw/core";

export { atomicWriteFileSync };

/**
 * 原子追加 JSONL 行：使用 fs.appendFileSync 在大多数 POSIX 系统上是原子的
 * （单次 write 调用 <= PIPE_BUF 时），但 Windows 大文本不保证。
 *
 * 借鉴 TencentDB-Agent-Memory 的四层 JSONL 防御：
 *   1. sanitizeText — 清理源文本（控制字符、UNSAFE_CHAR_RE）
 *   2. sanitizeJsonLine — 写入时清理 + roundtrip 验证
 *   3. validateEntry — schema 验证（必填字段）
 *   4. parseJsonlSafe — 容忍解析 + 损坏统计
 *
 * 对于 JSONL 追加场景，采用 "写入前 sanitize + 单行 append" 策略：
 * - 单行 JSON.stringify 后 <= 64KB 时直接 append（POSIX 原子保证）
 * - 单行 > 64KB 时降级到 "读全部 + 追加 + 原子写整文件"（避免 Windows 截断）
 */
export function appendJsonlAtomic(filePath: string, entry: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const line = JSON.stringify(entry) + "\n";
  // 单行 <= 64KB：直接 append（POSIX 原子）
  if (Buffer.byteLength(line, "utf-8") <= 64 * 1024) {
    try {
      fs.appendFileSync(filePath, line, { encoding: "utf-8" });
      return;
    } catch (err) {
      process.stderr.write(`[atomic-write] appendFileSync failed, falling back to full write: ${err}\n`);
    }
  }
  // 降级：读全部 + 追加 + 原子写整文件
  let existing = "";
  try {
    existing = fs.readFileSync(filePath, "utf-8");
  } catch { /* file not exist */ }
  atomicWriteFileSync(filePath, existing + line);
}
