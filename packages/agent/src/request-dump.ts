/**
 * 失败请求转储（对标 hermes `dump_api_request_debug`）。
 *
 * 背景（v35 实证）：一次 400 在线上只留下 `Error: {…}` 一行日志，而**真正
 * 被拒的请求体**从未落盘——事后无法回答「网关到底嫌哪条消息不合规」，
 * 只能靠猜 + 反复重放。hermes 在三个终态点（preflight / non-retryable 4xx /
 * max retries exhausted）都会写一份完整请求快照，本次对齐取其中最有价值的
 * 一处：**非可重试 4xx**（这类错误 100% 由请求形态引起，快照即根因证据）。
 *
 * 与 hermes 的一处有意差异：hermes 在**终态**（fallback 链耗尽后）对所有
 * non-retryable 4xx 都落盘；本实现只在「请求形态被拒」（reason 为
 * `format_error`/`format`）时落盘，且逐次尝试落盘。理由：auth / billing /
 * model_not_found / content_policy 与请求体形态无关，快照解释不了任何东西，
 * 只会按失败次数刷出大量脱敏文件。
 *
 * 三条硬约束（照抄 hermes 的事故教训）：
 *  1. **必须脱敏**：快照含完整 system prompt / history / 工具结果，凭据可能
 *     出现在工具参数或用户消息里。按叶子节点递归脱敏（`redactValueDeep`）——
 *     整段 JSON 正则替换会吃掉字符串的收尾引号，产出的文件无法 JSON.parse。
 *  2. **原子写**：`atomicWriteFileSync`（temp + fsync + rename），崩溃不留半截文件。
 *  3. **永不抛**：转储是诊断旁路，任何失败（磁盘满/权限/序列化环）都只能吞掉。
 *
 * 文件名对齐 hermes `request_dump_{safe_sid}_{%Y%m%d_%H%M%S_%f}.json`：
 * 会话 id 里可能有 `/` `..` 等路径成分，先做 `[^\w-] → _` 清洗，被改写时
 * 追加原值的 sha256 前 12 位（两个不同 id 清洗后撞名时不互相覆盖）。
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import { atomicWriteFileSync } from "@evoclaw/core";
import { redactValueDeep } from "./transcript-redactor";

/** 转储文件的落盘目录（相对进程 cwd；`data/` 已在 .gitignore 内） */
const DEFAULT_DUMP_DIR = path.join("data", "logs");

/**
 * 解析落盘目录：`EVOCLAW_REQUEST_DUMP_DIR` 可覆盖默认值。
 * 测试用它把快照写到临时目录，避免污染仓库 `data/logs/`。
 */
function resolveDumpDir(): string {
  const override = process.env.EVOCLAW_REQUEST_DUMP_DIR;
  return override ? path.resolve(override) : path.join(process.cwd(), DEFAULT_DUMP_DIR);
}

export interface ApiRequestDumpInput {
  /** 会话 id（可缺省：无作用域时用 "session" 占位） */
  sessionId?: string;
  /** 转储原因（对齐 hermes reason 取值，如 non_retryable_client_error） */
  reason: string;
  /** 请求 URL */
  url: string;
  /** 请求头（Authorization 等敏感值会被整体打码） */
  headers: Record<string, string>;
  /** 请求体（对象；内部按叶子脱敏后序列化） */
  body: unknown;
  /** provider 返回的错误描述 */
  error?: {
    status?: number;
    text?: string;
  };
  /** 覆盖落盘目录（测试用） */
  dir?: string;
  /** 覆盖时间戳（测试用，毫秒） */
  now?: number;
}

/**
 * 会话 id → 安全文件名片段（hermes `_safe_session_filename_component`）。
 * `[^\w-] → _`，去掉首尾 `.`/`_`，清洗后截断 96 字符；发生过改写时追加 sha256 前 12 位
 * （因此成品最长 109 字符）。空/全非法 → `session`。
 */
export function safeSessionFileComponent(raw: string): string {
  const original = String(raw ?? "").trim();
  const cleaned = original.replace(/[^\w-]/g, "_").replace(/^[._]+|[._]+$/g, "").slice(0, 96);
  if (!cleaned) return "session";
  if (cleaned === original) return cleaned;
  const digest = crypto.createHash("sha256").update(original, "utf-8").digest("hex").slice(0, 12);
  return `${cleaned}_${digest}`;
}

/** 时间戳 `%Y%m%d_%H%M%S_%f`（本地时区，微秒补零到 6 位） */
export function dumpTimestamp(nowMs: number): string {
  const d = new Date(nowMs);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_` +
    p(d.getMilliseconds(), 3) + "000"
  );
}

/**
 * 写一份脱敏的失败请求快照，返回落盘路径（失败返回 null）。
 * 永不抛异常。
 */
export function dumpFailedApiRequest(input: ApiRequestDumpInput): string | null {
  try {
    const now = input.now ?? Date.now();
    const sid = safeSessionFileComponent(input.sessionId ?? "session");
    const dir = input.dir ?? resolveDumpDir();
    const fileName = `request_dump_${sid}_${dumpTimestamp(now)}.json`;
    const target = path.join(dir, fileName);

    const payload = {
      timestamp: new Date(now).toISOString(),
      session_id: input.sessionId ?? null,
      reason: input.reason,
      request: {
        method: "POST",
        url: input.url,
        headers: redactValueDeep(input.headers),
        body: redactValueDeep(input.body),
      },
      ...(input.error
        ? { error: redactValueDeep({ status: input.error.status, text: input.error.text }) }
        : {}),
    };

    atomicWriteFileSync(target, JSON.stringify(payload, null, 2));
    return target;
  } catch {
    return null;
  }
}
