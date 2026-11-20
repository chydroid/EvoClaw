/**
 * UsageAnchor — usage-anchored token accounting（对标 Hermes agent/usage_anchor.py）。
 *
 * R11 GAP-1：压缩门此前纯 chars×0.25 估算（estimateTokensFromText），
 * 流式 `chunk.usage.prompt_tokens` 拿到了只进记账不进判定。CJK 会话误差可达 2×
 * （中文 ≈1-2 token/char，0.25 token/char 假设严重低估 → 压缩触发过晚 → 溢出）。
 *
 * hermes 语义：
 * - provider 真实 `usage.prompt_tokens` 是唯一权威上下文尺寸；
 * - 本地估算只覆盖「锚捕获之后追加的消息」（delta）；
 * - 锚 = prompt_tokens + 捕获时的消息数 + 已计价前缀的指纹；
 * - 前缀被改写（压缩/剪枝/splice）→ 指纹失配 → fail-closed 回退全量估算。
 *
 * EvoClaw 对位差异（不照抄，写明）：
 * 1. hermes 的锚绑定「整条已计价 transcript」（其 history 含全部工具流量）。
 *    EvoClaw 的持久 conversationHistory 每回合只追加 [user, assistant] 一对
 *    （工具流量留在回合内 conversationMessages，不进 history），且请求里
 *    user 消息是增强版（effectiveMessage）而 history 存原始版（P0-9）——
 *    请求形状与 history 形状不同构，锚绑定请求会永久失配。
 *    → 本实现锚绑定**持久 history**：捕获时记录 history.length 与其整体指纹，
 *    消费方（needsCompaction）用同一数组比较。锚值 = 完整请求 promptTokens
 *    （含 sys/skills/tail/tools/当前 user——全在锚内，压缩门不再另加
 *    systemTokens，比旧路径更准）。
 * 2. delta 语义：回合结束 history 追加 [user, assistant] 对。user 与 assistant
 *    都已被锚计价（user 在捕获请求里；assistant 由 completionTokens 覆盖），
 *    → delta 跳过首对 [user, assistant]；其后追加的轮次（下一回合的 user 等）
 *    才用 chars×0.25 粗估。仅 assistant 或仅 user 的残缺 delta 同样跳过
 *    （保守：宁可少估不清零——方向偏早压缩，安全侧）。
 * 3. hermes 把锚持久化到 session DB（跨进程恢复）。EvoClaw 的
 *    conversationHistory 是内存 Map，锚保持内存态（per-session），进程重启
 *    后自然回退全量估算——fail-closed 语义不变，无需持久层。
 * 4. 指纹键：hermes 用 (role, content, api_content, tool_call_id, tool_calls)。
 *    EvoClaw 的 SessionHistoryEntry 对应 (role, content, tool_calls, tool_call_id, name)。
 *    非字符串 content（多模态 parts）JSON.stringify 后进指纹。
 */

import * as crypto from "crypto";
import type { SessionHistoryEntry } from "./session-persistence";

export interface UsageAnchor {
  /** provider 上报的本次请求 prompt tokens（sys/skills/tail/tools/user 全含） */
  promptTokens: number;
  /** provider 上报的本次回复 tokens（回合结束追加的 assistant 由它覆盖） */
  completionTokens: number;
  /** 捕获时持久 history 的条数（= 已计价的前缀条数） */
  baseCount: number;
  /** 持久 history 前缀整体指纹（压缩/剪枝改写前缀即失配） */
  basePrefixFp: string;
}

/** 指纹覆盖的 provider-visible 字段（对齐 hermes _FINGERPRINT_KEYS，键名按 EvoClaw Entry）。 */
const FINGERPRINT_KEYS = ["role", "content", "tool_calls", "tool_call_id", "name"] as const;

/** 单条消息的稳定指纹（内容寻址，不依赖对象身份——P0-9 原始消息存储保证跨轮字节一致）。 */
export function messageFingerprint(msg: unknown): string | null {
  if (!msg || typeof msg !== "object") return null;
  const rec = msg as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  for (const k of FINGERPRINT_KEYS) {
    if (rec[k] !== undefined && rec[k] !== null) payload[k] = rec[k];
  }
  try {
    const raw = JSON.stringify(payload);
    if (raw === undefined) return null;
    return crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
  } catch {
    return null;
  }
}

/** 持久 history 前缀的指纹（hermes _priced_prefix_fingerprint 同构，作用域改为 history 子数组）。 */
function historyPrefixFingerprint(history: readonly SessionHistoryEntry[], baseCount: number): string | null {
  if (baseCount <= 0 || history.length < baseCount) return null;
  const parts: string[] = [];
  for (let i = 0; i < baseCount; i++) {
    const fp = messageFingerprint(history[i]);
    if (!fp) return null;
    parts.push(`${history[i].role}:${fp}`);
  }
  return crypto.createHash("sha256").update(parts.join("|"), "utf-8").digest("hex");
}

/**
 * 从 provider usage 构建锚（绑定持久 history）。promptTokens <= 0
 * （部分 endpoint 不报 usage）→ null，调用方保留旧锚
 * （hermes capture_usage_anchor 同语义）。
 */
export function captureUsageAnchor(
  promptTokens: unknown,
  completionTokens: unknown,
  history: readonly SessionHistoryEntry[],
): UsageAnchor | null {
  const pt = typeof promptTokens === "number" ? promptTokens : Number(promptTokens);
  const ct = typeof completionTokens === "number" ? completionTokens : Number(completionTokens) || 0;
  if (!Number.isFinite(pt) || pt <= 0) return null;
  if (!Array.isArray(history)) return null;
  if (history.length === 0) return null; // 空 history（首回合）：锚绑定无意义，等下一回合
  const prefixFp = historyPrefixFingerprint(history, history.length);
  if (!prefixFp) return null;
  return {
    promptTokens: pt,
    completionTokens: Math.max(0, Number.isFinite(ct) ? ct : 0),
    baseCount: history.length,
    basePrefixFp: prefixFp,
  };
}

/** 锚是否仍绑定当前 history（前缀逐条指纹一致）。 */
export function anchorMatches(history: readonly SessionHistoryEntry[], anchor: UsageAnchor): boolean {
  if (!anchor || !(anchor.baseCount > 0) || history.length < anchor.baseCount) return false;
  return historyPrefixFingerprint(history, anchor.baseCount) === anchor.basePrefixFp;
}

/** 本地粗估（chars×0.25，与 estimateTokensFromText 同口径；仅 delta 用）。 */
function estimateEntryRough(entry: SessionHistoryEntry): number {
  let total = 0;
  const c = entry.content;
  if (typeof c === "string") {
    total += Math.ceil(c.length * 0.25) + 4;
  } else if (c != null) {
    try {
      total += Math.ceil(JSON.stringify(c).length * 0.25) + 4;
    } catch { /* ignore */ }
  }
  if (entry.tool_calls) {
    try {
      total += Math.ceil(JSON.stringify(entry.tool_calls).length * 0.25) + 4;
    } catch { /* ignore */ }
  }
  return total;
}

/**
 * 锚定上下文 token 数 = promptTokens + completionTokens + delta 粗估。
 *
 * delta 规则（见模块头注释第 2 点）：回合结束追加的 [user, assistant] 首对
 * 已被锚计价（user 在捕获请求内；assistant 由 completionTokens 覆盖）→ 跳过；
 * 其后追加的条目按 chars×0.25 粗估。残缺 delta（1 条）同样跳过。
 * 锚缺失或失配 → null（fail-closed，调用方回退全量估算）。
 */
export function anchoredContextTokens(
  history: readonly SessionHistoryEntry[],
  anchor: UsageAnchor | null | undefined,
): number | null {
  if (!anchor || !anchorMatches(history, anchor)) return null;
  let deltaStart = anchor.baseCount;
  // 跳过回合结束追加的已计价对：delta 首两条恰为 [user, assistant] 时跳过
  // （user 在捕获请求内；assistant 由 completionTokens 覆盖）。残缺 delta
  // （仅 1 条：回合中断的 assistant / 下一回合尚未落 assistant 的 user）
  // 同样跳过——两侧都已被锚计价，保守方向是宁可少估（偏早压缩，安全侧）。
  const deltaLen = history.length - anchor.baseCount;
  if (deltaLen >= 2 && history[deltaStart]?.role === "user" && history[deltaStart + 1]?.role === "assistant") {
    deltaStart += 2;
  } else if (deltaLen === 1) {
    deltaStart += 1;
  }
  let deltaTokens = 0;
  for (let i = deltaStart; i < history.length; i++) {
    deltaTokens += estimateEntryRough(history[i]);
  }
  return anchor.promptTokens + anchor.completionTokens + deltaTokens;
}
