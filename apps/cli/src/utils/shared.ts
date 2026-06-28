/**
 * shared.ts — CLI 共享工具
 *
 * 提供跨命令复用的辅助函数：
 * - ensureServer：检查 Gateway 可达
 * - printJson / printTable：JSON / 表格输出
 * - printError / printSuccess / printWarn / printInfo：统一彩色输出
 * - parseDurationMs：解析 "5s"/"1m"/"200ms" 等时长字符串
 * - readOptionalFile：读取可选文件内容
 * - confirmPrompt：交互式确认（CI 默认 yes/no 由 flag 决定）
 * - paginate：分页打印数组
 * - formatTimestamp：统一时间戳格式化
 * - maskSecret：脱敏字符串
 */
import * as fs from "fs";
import { c, ICONS } from "./colors";
import { checkServer } from "./api";

/** 检查 Gateway 可达，不可达时返回 false 并打印错误。 */
export async function ensureServer(): Promise<boolean> {
  const alive = await checkServer();
  if (!alive) {
    process.stderr.write(c("red", "❌ Gateway not reachable. Start with: EvoClaw gateway start\n"));
    return false;
  }
  return true;
}

/** 输出 JSON 到 stdout，自动 indent=2。 */
export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

/** 统一错误输出。 */
export function printError(message: string, detail?: string): void {
  process.stderr.write(c("red", `❌ ${message}\n`));
  if (detail) process.stderr.write(c("gray", `  ${detail}\n`));
}

/** 统一成功输出。 */
export function printSuccess(message: string): void {
  process.stdout.write(c("green", `✅ ${message}\n`));
}

/** 统一警告输出。 */
export function printWarn(message: string): void {
  process.stdout.write(c("yellow", `⚠  ${message}\n`));
}

/** 统一信息输出。 */
export function printInfo(message: string): void {
  process.stdout.write(c("blue", `ℹ  ${message}\n`));
}

/**
 * 解析时长字符串为毫秒数。
 * 支持：200ms / 5s / 1m / 2h / 1d
 * 不支持的格式返回 null。
 */
export function parseDurationMs(input: string): number | null {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
  if (!match) return null;
  const value = parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Math.floor(value * multipliers[unit]!);
}

/**
 * 读取可选文件内容。不存在时返回 null。
 */
export function readOptionalFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * 简单确认提示。若 process.stdin 非 TTY 则按 defaultYes 返回。
 */
export async function confirmPrompt(message: string, defaultYes = false): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;
  return new Promise((resolve) => {
    process.stdout.write(`${message} ${defaultYes ? "[Y/n]" : "[y/N]"} `);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.once("data", (answer) => {
      process.stdin.pause();
      const a = String(answer).trim().toLowerCase();
      if (a === "") resolve(defaultYes);
      else resolve(a === "y" || a === "yes");
    });
  });
}

/**
 * 简单表格打印。columns 为表头，rows 为对齐的行数组。
 */
export interface TableColumn {
  /** 表头 */
  header: string;
  /** 列宽（字符数，过窄会自动扩展） */
  width?: number;
  /** 对齐方式，默认左对齐 */
  align?: "left" | "right" | "center";
}

export function printTable(columns: TableColumn[], rows: string[][]): void {
  if (rows.length === 0) {
    process.stdout.write(c("gray", "  (no rows)\n"));
    return;
  }
  // 计算每列宽度
  const widths = columns.map((col, i) => {
    const headerWidth = col.header.length;
    const maxCellWidth = Math.max(...rows.map((r) => (r[i] ?? "").length));
    const desired = col.width ?? Math.max(headerWidth, maxCellWidth);
    return Math.min(Math.max(desired, headerWidth), 80);
  });
  // 表头
  const headerLine = columns
    .map((col, i) => {
      const w = widths[i]!;
      const text = col.header.padEnd(w).slice(0, w);
      return c("bold", text);
    })
    .join("  ");
  process.stdout.write(`  ${headerLine}\n`);
  process.stdout.write(`  ${widths.map((w) => "─".repeat(w)).join("  ")}\n`);
  // 行
  for (const row of rows) {
    const line = columns
      .map((col, i) => {
        const w = widths[i]!;
        const cell = (row[i] ?? "").slice(0, w);
        if (col.align === "right") return cell.padStart(w);
        if (col.align === "center") {
          const pad = Math.floor((w - cell.length) / 2);
          return " ".repeat(pad) + cell + " ".repeat(w - cell.length - pad);
        }
        return cell.padEnd(w);
      })
      .join("  ");
    process.stdout.write(`  ${line}\n`);
  }
}

/**
 * 格式化时间戳。输入可以是 ISO 字符串、Date、毫秒数。
 */
export function formatTimestamp(input: string | number | Date | undefined | null): string {
  if (input == null) return "—";
  try {
    let date: Date;
    if (input instanceof Date) date = input;
    else if (typeof input === "number") date = new Date(input < 1e12 ? input * 1000 : input);
    else if (typeof input === "string") {
      const n = Number(input);
      if (!isNaN(n)) date = new Date(n < 1e12 ? n * 1000 : n);
      else date = new Date(input);
    } else return "—";
    if (isNaN(date.getTime())) return "—";
    return date.toLocaleString();
  } catch {
    return "—";
  }
}

/**
 * 脱敏字符串，保留前 prefix 和后 suffix 个字符，中间用 * 替换。
 * 长度不足以脱敏时返回 "***"。
 */
export function maskSecret(input: string, prefix = 4, suffix = 4): string {
  if (input.length <= prefix + suffix + 1) return "***";
  return `${input.slice(0, prefix)}${"*".repeat(Math.min(input.length - prefix - suffix, 16))}${input.slice(-suffix)}`;
}

/**
 * 解析 JSON 参数（命令行 --params '{"k":"v"}' 形式）。
 * 失败时打印错误并返回 null。
 */
export function parseJsonArg(input: string, label = "JSON argument"): unknown | null {
  try {
    return JSON.parse(input);
  } catch (err) {
    printError(`Invalid JSON in ${label}`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * 截断长字符串（如错误消息）。
 */
export function truncate(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

/** 统一的"未实现"占位提示。 */
export function notImplemented(command: string, subcommand?: string): void {
  const path = subcommand ? `${command} ${subcommand}` : command;
  process.stdout.write(c("yellow", `⚠  ${path}: this subcommand is not yet wired to the gateway\n`));
  process.stdout.write(c("gray", `  Track implementation status at https://github.com/chydroid/EvoClaw\n`));
}
