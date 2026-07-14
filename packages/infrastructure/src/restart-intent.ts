/**
 * restart-intent.ts — 持久化 gateway 重启意图文件
 *
 * 对齐 openclaw-main 的 src/infra/restart.ts 中的 intent 文件机制。
 *
 * 设计意图：
 * - 跨进程通信：旧进程退出前写入 intent，新进程启动时读取并消费
 * - 原子写入：使用 temp + fsync + rename 模式，避免半写入被读到
 * - TTL 限制：60s 内未消费的 intent 自动失效，防止陈旧意图误导新进程
 * - PID 匹配：仅当 intent 中记录的 pid === process.pid 时才视为有效
 * - 体积上限：最大 1024 字节，防止恶意大文件攻击
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "@evoclaw/core";

const GATEWAY_RESTART_INTENT_FILENAME = "gateway-restart-intent.json";
const GATEWAY_RESTART_INTENT_TTL_MS = 60_000;
const GATEWAY_RESTART_INTENT_MAX_BYTES = 1024;
const RESTART_INTENT_TEMP_PREFIX = ".gateway-restart-intent";

/**
 * 重启意图载荷 — 写入磁盘的完整结构。
 */
export interface GatewayRestartIntentPayload {
  kind: "gateway-restart";
  pid: number;
  createdAt: number;
  reason?: string;
  force?: boolean;
  waitMs?: number;
}

/**
 * 重启意图 — 消费后返回给业务层的结构（剥离了 pid 与 createdAt）。
 */
export interface GatewayRestartIntent {
  reason?: string;
  force?: boolean;
  waitMs?: number;
}

/**
 * 解析后的 intent 校验结果。
 */
export type ConsumeIntentResult =
  | { ok: true; intent: GatewayRestartIntent }
  | { ok: false; reason: "no-file" | "unreadable" | "oversize" | "invalid-json" | "schema-mismatch" | "pid-mismatch" | "expired" };

/**
 * 默认 state 目录解析（与 EvoClaw 现有 ./data 约定一致）。
 * 允许注入 env 以便测试。
 */
export function resolveDefaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = typeof env.EVOCLAW_STATE_DIR === "string" ? env.EVOCLAW_STATE_DIR.trim() : "";
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(process.cwd(), "data");
}

/**
 * 解析 intent 文件路径。
 */
export function resolveRestartIntentPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDefaultStateDir(env), GATEWAY_RESTART_INTENT_FILENAME);
}

/**
 * 归一化 reason 字段：trim + 截断 200 字符。
 */
function normalizeRestartIntentReason(reason: string | undefined): string | undefined {
  const normalized = reason?.trim();
  return normalized ? normalized.slice(0, 200) : undefined;
}

/**
 * 同步原子写入 intent 文件。
 * 使用 temp + fsync + rename 模式，保证崩溃安全。
 *
 * @returns true 写入成功；false 写入失败（参数无效或 IO 错误）
 */
export function writeGatewayRestartIntentSync(opts: {
  env?: NodeJS.ProcessEnv;
  targetPid?: number;
  intent?: GatewayRestartIntent;
  reason?: string;
}): boolean {
  const targetPid = normalizePid(opts.targetPid);
  if (targetPid === null) {
    return false;
  }
  const env = opts.env ?? process.env;
  try {
    const intentPath = resolveRestartIntentPath(env);
    const dir = path.dirname(intentPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const reason = normalizeRestartIntentReason(opts.reason ?? opts.intent?.reason);
    const payload: GatewayRestartIntentPayload = {
      kind: "gateway-restart",
      pid: targetPid,
      createdAt: Date.now(),
      ...(reason ? { reason } : {}),
      ...(opts.intent?.force ? { force: true } : {}),
      ...(typeof opts.intent?.waitMs === "number" &&
      Number.isFinite(opts.intent.waitMs) &&
      opts.intent.waitMs >= 0
        ? { waitMs: Math.floor(opts.intent.waitMs) }
        : {}),
    };
    const content = `${JSON.stringify(payload)}\n`;
    atomicWriteFileSync(intentPath, content, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 删除 intent 文件（如存在）。幂等。
 */
export function clearGatewayRestartIntentSync(env: NodeJS.ProcessEnv = process.env): void {
  try {
    const intentPath = resolveRestartIntentPath(env);
    const stat = fs.lstatSync(intentPath);
    if (!stat.isFile() || stat.nlink > 1) {
      // 不删除符号链接 / 硬链接 — 防止意外删除其他文件
      return;
    }
    fs.unlinkSync(intentPath);
  } catch {
    // 文件不存在 — 幂等
  }
}

/**
 * 解析 intent JSON 文本，并校验 schema。
 * 区分 JSON 解析失败与 schema 不匹配，便于调用方诊断。
 */
function parseGatewayRestartIntent(raw: string): { ok: true; payload: GatewayRestartIntentPayload } | { ok: false; reason: "invalid-json" | "schema-mismatch" } {
  let parsed: Partial<GatewayRestartIntentPayload>;
  try {
    parsed = JSON.parse(raw) as Partial<GatewayRestartIntentPayload>;
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  if (
    parsed.kind === "gateway-restart" &&
    typeof parsed.pid === "number" &&
    Number.isFinite(parsed.pid) &&
    typeof parsed.createdAt === "number" &&
    Number.isFinite(parsed.createdAt) &&
    (parsed.reason === undefined || typeof parsed.reason === "string") &&
    (parsed.force === undefined || typeof parsed.force === "boolean") &&
    (parsed.waitMs === undefined ||
      (typeof parsed.waitMs === "number" && Number.isFinite(parsed.waitMs) && parsed.waitMs >= 0))
  ) {
    const reason = normalizeRestartIntentReason(parsed.reason);
    const payload: GatewayRestartIntentPayload = {
      kind: "gateway-restart",
      pid: parsed.pid,
      createdAt: parsed.createdAt,
      ...(reason ? { reason } : {}),
      ...(parsed.force ? { force: true } : {}),
      ...(typeof parsed.waitMs === "number" ? { waitMs: Math.floor(parsed.waitMs) } : {}),
    };
    return { ok: true, payload };
  }
  return { ok: false, reason: "schema-mismatch" };
}

/**
 * 读取并消费 intent 文件，返回完整载荷（不删除文件）。
 * 调用方应根据 ConsumeIntentResult.ok 决定后续动作。
 *
 * 注意：本函数不删除 intent 文件。如需删除，请显式调用 clearGatewayRestartIntentSync。
 */
export function readGatewayRestartIntentPayloadSync(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): ConsumeIntentResult {
  const intentPath = resolveRestartIntentPath(env);
  let raw: string;
  try {
    const stat = fs.lstatSync(intentPath);
    if (!stat.isFile()) {
      return { ok: false, reason: "no-file" };
    }
    if (stat.size > GATEWAY_RESTART_INTENT_MAX_BYTES) {
      return { ok: false, reason: "oversize" };
    }
    raw = fs.readFileSync(intentPath, "utf8");
  } catch {
    return { ok: false, reason: "no-file" };
  }
  const parsed = parseGatewayRestartIntent(raw);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  const payload = parsed.payload;
  if (payload.pid !== process.pid) {
    return { ok: false, reason: "pid-mismatch" };
  }
  const ageMs = now - payload.createdAt;
  if (ageMs < 0 || ageMs > GATEWAY_RESTART_INTENT_TTL_MS) {
    return { ok: false, reason: "expired" };
  }
  return {
    ok: true,
    intent: {
      ...(payload.reason ? { reason: payload.reason } : {}),
      ...(payload.force ? { force: true } : {}),
      ...(typeof payload.waitMs === "number" ? { waitMs: payload.waitMs } : {}),
    },
  };
}

/**
 * 消费 intent：读取 + 删除文件。
 * 仅当返回 ok:true 时，调用方应执行重启后续动作。
 */
export function consumeGatewayRestartIntentSync(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): ConsumeIntentResult {
  const result = readGatewayRestartIntentPayloadSync(env, now);
  // 无论校验结果如何，都删除文件，防止下次启动时再次读到无效意图
  clearGatewayRestartIntentSync(env);
  return result;
}

/**
 * 归一化 PID：必须是正整数。
 */
function normalizePid(pid: number | undefined): number | null {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * 获取 intent TTL（毫秒）。导出供测试与配置覆盖使用。
 */
export function getIntentTtlMs(): number {
  return GATEWAY_RESTART_INTENT_TTL_MS;
}

/**
 * 获取 intent 最大字节数。导出供测试与配置覆盖使用。
 */
export function getIntentMaxBytes(): number {
  return GATEWAY_RESTART_INTENT_MAX_BYTES;
}

/**
 * 暴露内部常量给测试。
 */
export const __testing = {
  GATEWAY_RESTART_INTENT_FILENAME,
  GATEWAY_RESTART_INTENT_TTL_MS,
  GATEWAY_RESTART_INTENT_MAX_BYTES,
  RESTART_INTENT_TEMP_PREFIX,
  normalizePid,
  parseGatewayRestartIntent,
  normalizeRestartIntentReason,
};

// 防 unused 警告
void RESTART_INTENT_TEMP_PREFIX;
