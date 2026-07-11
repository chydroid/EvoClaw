/**
 * CredentialPool 持久化模块
 *
 * 借鉴 hermes-agent 的 credential_pool.json 持久化设计：
 * - 进程重启后凭证状态（OK / EXHAUSTED / DEAD）可恢复
 * - 使用 atomicWriteFileSync（temp + fsync + rename）保证崩溃安全
 * - 损坏文件静默回退为空池（避免单点故障阻断启动）
 *
 * AGENTS.md 硬约束：Config/state writes use atomicWriteFile (temp + fsync + rename)。
 * 此处使用同步版本 atomicWriteFileSync，符合相同的原子写入模式，且满足 persist(): void 同步签名。
 */
import * as fs from "fs";
import * as path from "path";
import { atomicWriteFileSync } from "@evoclaw/memory";
import type { CredentialEntry } from "./credential-pool";

/** 持久化文件默认路径 */
const DEFAULT_PATH = path.join(process.cwd(), "data", "credential-pool.json");

/**
 * 返回凭证池持久化文件路径。
 * 路径固定为 `data/credential-pool.json`（相对当前工作目录）。
 */
export function getCredentialPoolPath(): string {
  return DEFAULT_PATH;
}

/**
 * 将凭证条目列表原子写入 JSON 文件。
 *
 * 使用 atomicWriteFileSync（temp + fsync + rename）保证崩溃时不会产生截断文件。
 *
 * @param filePath 目标文件路径
 * @param entries 凭证条目列表
 */
export function persistCredentialPool(filePath: string, entries: CredentialEntry[]): void {
  const json = JSON.stringify(entries, null, 2);
  atomicWriteFileSync(filePath, json);
}

/**
 * 从 JSON 文件加载凭证条目列表。
 *
 * 文件不存在或为空时返回空数组；文件损坏（JSON 解析失败或结构不合法）时
 * 静默回退为空数组，避免阻断启动。
 *
 * @param filePath 目标文件路径
 * @returns 凭证条目列表；文件不存在/空/损坏时返回空数组
 */
export function loadCredentialPool(filePath: string): CredentialEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    // 文件不存在 — 视为空池
    return [];
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // JSON 损坏 — 回退为空池，避免阻断启动
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  // 结构校验：仅保留符合 CredentialEntry 形状的对象
  const result: CredentialEntry[] = [];
  for (const item of parsed) {
    if (isValidCredentialEntry(item)) {
      result.push(item);
    }
  }
  return result;
}

/**
 * 校验对象是否符合 CredentialEntry 形状。
 * 仅做关键字段与类型检查，不做业务语义校验。
 */
function isValidCredentialEntry(x: unknown): x is CredentialEntry {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.apiKey === "string" &&
    (o.state === "ok" || o.state === "exhausted" || o.state === "dead") &&
    typeof o.stateSince === "number" &&
    typeof o.cooldownUntil === "number" &&
    typeof o.useCount === "number" &&
    typeof o.errorCount === "number"
  );
}
