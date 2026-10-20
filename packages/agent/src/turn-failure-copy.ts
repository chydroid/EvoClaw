// EvoClaw 终态失败盖码与人话文案（借鉴 hermes-agent turn_failure_copy.py）
//
// hermes 的 turn_failure_copy 管的是：每一条终态失败结果都必须携带具体的
// failure_reason（FailoverReason 值或 SITE_FAILURE_CODES 站内码）+
// failure_retryable，让错误呈现层能说清「发生了什么 + 下一步做什么」，
// 而不是回一个 "unknown"。文案表只说 WHAT happened / WHAT TO DO；
// provider 原始错误只进尾部一行「服务方描述」。
//
// 移植边界（不整包搬）：hermes 461 行里约 1/3 是 hermes 专属
// （hermes doctor / hermes fallback add / OAuth profile 重登 / cron kanban
// breaker / _EXIT_REASON_FAILURES exit-reason 前缀表 / provider_label CLI），
// 本模块只取核心不变式，命名本地化：
//   ① stampFailure：终态 result 必带 failure_reason + failure_retryable
//   ② 站内失败码集合 SITE_FAILURE_CODES（循环站点自造的码，非 provider 裁定）
//   ③ 失败 turn 边界文案二分：没有任何动作跑过 → FAILED_TURN_NOTICE（"未处理，
//      重发即可"）；跑过工具 → PARTIAL_FAILED_TURN_NOTICE（"可能有副作用已生效，
//      重发前先验证"）——绝不能在有动作跑过时说"未处理"
//   ④ FAILURE_CAUSE_GLOSS：一个 reason → 一句人话（无 HTTP 码、无 provider 术语）
//   ⑤ 重试耗尽文案按 reason 分句；限流且**已知重置时间**（Retry-After 契约）时
//      给出具体重置时间而非"等一分钟"
//   ⑥ 非可重试 reason 的终态文案（model_not_found → 换模型 / auth → 检查
//      API Key / context_overflow → 开新会话 / truncated → 拆小步）

import { COMPRESSION_EXHAUSTED_NOTICE } from "./turn-overflow";

// ── 站内失败码 ───────────────────────────────────────────────────────────────

/**
 * 站内失败码集合（对齐 hermes SITE_FAILURE_CODES）：循环站点自造的失败码，
 * 不是 provider 裁定。与 failover-policy 的 FailoverReason 值并列，
 * 共同构成 failure_reason 的合法取值域。
 */
export const SITE_FAILURE_CODES = new Set<string>([
  "context_overflow",
  "truncated",
  "invalid_response",
  "empty_response",
  "loop_error",
  "interpreter_shutdown",
  "session_busy",
  "gateway_connection",
  "host_error",
]);

export function isSiteFailureCode(code: unknown): boolean {
  return typeof code === "string" && SITE_FAILURE_CODES.has(code);
}

// ── ① 盖码不变式 ─────────────────────────────────────────────────────────────

/** 可被盖码的结果对象（TryCallLLMResult / RecoveryResult 等）。 */
export interface FailureStamplable {
  failureReason?: string;
  failureRetryable?: boolean;
}

/**
 * 在终态结果上盖 UI 判定字段（原地，返回原对象）。
 * 不变式：终态失败结果**必须**同时携带 failure_reason + failure_retryable，
 * 否则下游只能显示 unknown（hermes stamp_failure 语义）。
 */
export function stampFailure<T extends FailureStamplable>(
  result: T,
  reason: string,
  retryable: boolean,
): T {
  result.failureReason = String(reason);
  result.failureRetryable = Boolean(retryable);
  return result;
}

// ── ② 失败 turn 边界文案二分 ─────────────────────────────────────────────────

/** 完全失败：本轮没有任何动作跑过（hermes FAILED_TURN_NOTICE 语义）。 */
export const FAILED_TURN_NOTICE =
  "您的请求未被处理。如果您仍希望执行，请重新发送。";

/** 部分执行失败：可能有副作用已生效（hermes PARTIAL_FAILED_TURN_NOTICE 语义）。 */
export const PARTIAL_FAILED_TURN_NOTICE =
  "本轮未完成。部分操作可能已生效，重发前请先核实其影响。";

/**
 * 边界文案二分（hermes failed_turn_notice 不变式）：turn 消息里出现过
 * role=tool 行，或带 tool_calls 的 assistant 行 → 有动作可能跑过 → 用
 * PARTIAL 文案；否则用「什么都没做」的 FULL 文案。
 * 绝不在有动作可能跑过时声称"未处理"。
 */
export function failedTurnNotice(
  turnMessages?: Array<Record<string, unknown>> | null,
): string {
  for (const row of turnMessages ?? []) {
    if (!row || typeof row !== "object") continue;
    const role = row.role;
    const toolCalls = row.tool_calls;
    const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
    if (role === "tool" || (role === "assistant" && hasToolCalls)) {
      return PARTIAL_FAILED_TURN_NOTICE;
    }
  }
  return FAILED_TURN_NOTICE;
}

// ── ③ FAILURE_CAUSE_GLOSS：一个 reason → 一句人话 ────────────────────────────

/**
 * reason → 一句人话（无 HTTP 码、无 provider 术语）。
 * 覆盖 failover-policy 的 25 个 FailoverReason 值 + SITE_FAILURE_CODES
 * 站内码（其中 context_overflow / empty_response 两边共用同一句）。
 * 表中缺失的 reason 不翻译——调用方退回原始错误文本（hermes 口径：
 * "Reasons absent here are NOT provider-shaped"）。
 */
export const FAILURE_CAUSE_GLOSS: Record<string, string> = {
  // ── 瞬时（transient） ──
  rate_limit: "模型服务被限流（请求过于频繁）",
  overloaded: "模型服务当前过载",
  unknown: "模型服务返回了未知错误",
  empty_response: "模型服务返回了空响应",
  no_error_details: "模型服务返回了错误但没有提供详情",
  unclassified: "模型服务返回了无法归类的错误",
  timeout: "模型服务未及时响应",
  network: "本地网络与模型服务的连接中断",
  server_error: "模型服务内部出错",
  payload_too_large: "请求体（含附件）过大",
  image_too_large: "请求中的图片超出模型服务单图限制",
  invalid_encrypted_content: "模型服务拒绝了重放的加密内容",
  multimodal_tool_content_unsupported: "模型服务不支持工具消息中的多模态内容",
  thinking_signature: "模型思考块的签名失效",
  long_context_tier: "模型服务要求开通长上下文档位",
  // ── 非瞬时（non-transient） ──
  billing: "模型服务侧账户用量或额度已达上限",
  model_not_found: "使用的模型在模型服务上不存在",
  format: "请求格式被模型服务拒绝",
  format_error: "请求格式被模型服务拒绝",
  auth: "模型服务拒绝了登录凭证（API Key 问题）",
  auth_permanent: "模型服务永久拒绝了登录凭证（API Key 已失效）",
  session_expired: "会话凭证已过期，需要重新登录或刷新",
  context_overflow: "对话上下文已增长到模型无法读取的大小",
  provider_policy_blocked: "模型服务因账户策略拒绝了本次请求",
  content_policy_blocked: "模型服务的安全过滤器拒绝了本次请求",
  // ── 站内码（与上方共用的不再重复） ──
  truncated: "模型的回复在中途被截断（撞到输出长度上限）",
  invalid_response: "模型服务返回了空或损坏的回复",
  loop_error: "代理循环中发生反复内部错误",
  interpreter_shutdown: "宿主进程正在关闭",
  session_busy: "会话正被其他任务占用",
  gateway_connection: "网关与代理之间的连接中断",
  host_error: "宿主环境发生错误",
};

/** 查一个 reason 的人话说明；表中没有 → null（调用方退回原始错误文本）。 */
export function failureCauseGloss(reason: unknown): string | null {
  if (typeof reason !== "string" || !reason) return null;
  return FAILURE_CAUSE_GLOSS[reason] ?? null;
}

// ── ④ 重试耗尽文案 ───────────────────────────────────────────────────────────

/** 各 reason 的重试耗尽主句（hermes _EXHAUSTED_LEADS 语义，中文本地化）。 */
const EXHAUSTED_LEADS: Record<string, string> = {
  rate_limit: "{label} 在 {attempts} 次尝试中全部被限流",
  overloaded: "{label} 在 {attempts} 次尝试中全部报告过载",
  server_error: "{label} 在 {attempts} 次尝试中全部返回内部错误",
  timeout: "{label} 在 {attempts} 次尝试中均未及时响应",
  network: "本地网络在 {attempts} 次尝试中反复中断",
};
const EXHAUSTED_DEFAULT_LEAD = "{label} 在 {attempts} 次尝试后仍未响应";

/** 重置时间下限（秒）：已知重置窗口 ≥2 分钟才点名具体时间（hermes 120s 阈值）。 */
const RESET_NAMED_THRESHOLD_S = 120;

/** 把秒数格式化成「约 N 分钟 / N 小时 M 分」。 */
export function formatResetWindow(seconds: number): string {
  if (seconds < 60) return `约 ${Math.max(1, Math.ceil(seconds))} 秒`;
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return `约 ${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `约 ${hours} 小时 ${minutes} 分钟` : `约 ${hours} 小时`;
}

/**
 * 重试 + failover 耗尽后的终态文案。
 * 限流且已知重置时间（resetSeconds）时点名具体重置窗口——
 * 8 小时的配额不是"等一分钟"（hermes exhausted_copy 语义，#89401）；
 * 未知重置时间才给通用的"稍后重试 / 切换模型"。
 */
export function exhaustedCopy(
  reason: string,
  label: string,
  attempts: number,
  options: { resetSeconds?: number; detail?: string } = {},
): string {
  const lead = (EXHAUSTED_LEADS[reason] ?? EXHAUSTED_DEFAULT_LEAD)
    .replace("{label}", label)
    .replace("{attempts}", String(attempts));

  let situation: string;
  if (options.resetSeconds != null && options.resetSeconds >= RESET_NAMED_THRESHOLD_S) {
    situation = `服务额度/限制将在${formatResetWindow(options.resetSeconds)}后重置，届时重试，或切换到其他模型提供商。`;
  } else {
    situation = `看起来暂时不可用。请稍后重试，或切换到其他模型提供商。`;
  }

  const detailLine = options.detail ? `\n\n服务方描述：${shortDetail(options.detail)}` : "";
  return `${lead} — ${situation}${detailLine}`;
}

// ── ⑤ 非可重试 reason 终态文案 ───────────────────────────────────────────────

/** 各 non-transient reason 的终态指引（hermes _NONRETRYABLE_COPY 语义，中文本地化）。 */
const NONRETRYABLE_COPY: Record<string, string> = {
  model_not_found:
    "模型 '{model}' 在 {label} 上不可用。请在模型设置中换一个模型，或核对模型名/前缀是否拼错。",
  format: "{label} 认为请求格式有误，模型未能应答。开一个新会话或换一个模型通常可以解决；若反复出现，请到 Ops 诊断页查看详情。",
  format_error: "{label} 认为请求格式有误，模型未能应答。开一个新会话或换一个模型通常可以解决；若反复出现，请到 Ops 诊断页查看详情。",
  auth: "{label} 拒绝了 API Key，模型无法访问。请检查该提供商配置的 API Key 是否正确、是否过期、是否有额度。",
  auth_permanent: "{label} 永久拒绝了 API Key，重试无意义。请更换或更新该提供商的 API Key 后重试。",
  session_expired: "会话凭证已过期，模型无法访问。请重新登录或刷新会话后重试。",
  billing: "账户用量或额度已达上限（{label} 侧）。请充值或检查配额后继续，或切换到其他有额度的模型。",
  provider_policy_blocked:
    "{label} 因账户策略（数据/隐私设置或上游提供商的封禁）拒绝了本次请求，重试无意义。请向服务提供方核对账户，或换一个模型。",
  content_policy_blocked:
    "模型服务的安全过滤器拒绝了本次请求。请改写措辞或移除敏感内容/附件，或换一个模型。",
};
const NONRETRYABLE_DEFAULT_COPY =
  "{label} 拒绝了本次请求，重试无意义。请切换到其他模型提供商，或到 Ops 诊断页查看详情。";

/**
 * 非可重试 provider 拒绝的终态文案（auth / model_not_found / 4xx 通用）。
 * provider 原始错误进尾部「服务方描述」行，不进正文（hermes nonretryable_copy 语义）。
 */
export function nonretryableCopy(
  reason: string,
  label: string,
  options: { model?: string; detail?: string } = {},
): string {
  const template = NONRETRYABLE_COPY[reason] ?? NONRETRYABLE_DEFAULT_COPY;
  const body = template
    .replace("{label}", label)
    .replace("{model}", options.model ?? "该模型");
  const detailLine = options.detail ? `\n\n服务方描述：${shortDetail(options.detail)}` : "";
  return body + detailLine;
}

// ── 站内码文案 ───────────────────────────────────────────────────────────────

/**
 * 站内失败码 / 一次性结果的聊天文案（hermes _SITE_COPY 语义，中文本地化）。
 * 每条带"下一步做什么"指引；payload_too_large 直接复用 turn-overflow 的
 * COMPRESSION_EXHAUSTED_NOTICE 语义（66614e4 已落地）。
 */
const SITE_CODE_COPY: Record<string, string> = {
  context_overflow:
    "对话已增长到模型无法完整读取，且自动压缩仍不够。请开一个新会话，或再执行一次 /compress，或切换到上下文窗口更大的模型。",
  truncated:
    "模型的回复在未完成前被截断（撞到输出长度上限），未完成的动作没有执行、没有任何改动。请拆成更小的步骤，或调大模型的 max_tokens。",
  invalid_response:
    "模型服务连续返回空或损坏的回复，可能处于过载或限流状态。请稍后重试，或切换到其他模型提供商。",
  loop_error: "代理遇到反复内部错误，已主动停止本轮以避免无限重试。您的消息已保留，请重试或开一个新会话。",
  empty_response: "模型连续返回空响应。请稍后重试；若反复出现，请切换到其他模型提供商。",
  interpreter_shutdown: "宿主进程正在关闭，本轮被中断。会话已保存——重新打开后重发您的消息即可。",
  session_busy: "会话正被另一个任务占用，本轮未能处理。等占用结束后再重发。",
  gateway_connection: "网关与代理之间的连接中断。请检查网络后重试。",
  host_error: "宿主环境发生错误，本轮被中断。请重试，若反复出现请查看运行日志。",
  payload_too_large: COMPRESSION_EXHAUSTED_NOTICE,
};

/** 站内码文案查询；未知码返回空串（调用方自行兜底，hermes site_copy 语义）。 */
export function siteCopy(code: string): string {
  return SITE_CODE_COPY[code] ?? "";
}

// ── 组合：兜底回复 ───────────────────────────────────────────────────────────

/** 一条终态失败的具体证据（llm-caller 从最后一次 ClassifiedError 收集）。 */
export interface TerminalFailureEvidence {
  /** failure_reason：FailoverReason 值或站内码；null = 没有任何具体错误 */
  reason: string | null;
  /** provider 展示名（"X（provider/model）"） */
  label: string;
  /** 该 provider 的尝试次数 */
  attempts: number;
  /** 该原因是否可重试（failover-policy 的 transient/non-transient 判定） */
  retryable: boolean;
  /** provider 原始错误文本（进尾部「服务方描述」行） */
  detail?: string;
  /** 已知限流重置秒数（Retry-After 契约） */
  resetSeconds?: number;
  /** 模型名（model_not_found 文案点名用） */
  model?: string;
}

/**
 * 全 provider 失败时的兜底回复（hermes 终态文案组合）。
 *
 * 边界二分（options.partial）：
 *  - partial=true（跑过工具）→ PARTIAL_FAILED_TURN_NOTICE 开头 + 工具统计
 *  - partial=false（什么都没跑）→ FAILED_TURN_NOTICE 开头
 * 主体：具体 cause + 按 reason 的下一步指引（替代"请检查 API Key/服务是否
 * 在线"通用三条）；reason=null（无具体错误证据）才退回通用文案。
 */
export function terminalFailureCopy(
  evidence: TerminalFailureEvidence,
  options: {
    partial?: boolean;
    toolStats?: { executed: number; failed: Array<{ name: string; error: string }> };
  } = {},
): string {
  const lines: string[] = [];
  if (options.partial) {
    lines.push(PARTIAL_FAILED_TURN_NOTICE);
    if (options.toolStats) {
      const { executed, failed } = options.toolStats;
      const failedList =
        failed.length > 0
          ? failed.map((t) => `${t.name}（${t.error.slice(0, 80)}）`).join("、")
          : "（无）";
      lines.push(
        `本轮已执行 ${executed} 次工具，但未能生成最终文字回复，执行已停止。` +
          `\n失败的工具：${failedList}`,
      );
    }
  } else {
    lines.push(FAILED_TURN_NOTICE);
  }

  // 具体 cause + 指引（reason 为 null 时退回通用）
  if (evidence.reason) {
    const gloss = failureCauseGloss(evidence.reason);
    if (gloss) lines.push(`原因：${gloss}。`);
    if (evidence.retryable) {
      lines.push(exhaustedCopy(evidence.reason, evidence.label, evidence.attempts, {
        resetSeconds: evidence.resetSeconds,
        detail: evidence.detail,
      }));
    } else {
      lines.push(nonretryableCopy(evidence.reason, evidence.label, {
        model: evidence.model,
        detail: evidence.detail,
      }));
    }
  } else if (options.partial) {
    // 跑过工具但没有具体错误证据（provider 静默跳过等）：沿用
    // turn_finalizer 的「重新描述需求」出口，不误导成"所有提供商都挂了"。
    lines.push("如需继续，请明确说明下一步要做什么，或重新描述需求。");
  } else {
    lines.push(
      "所有已启用的模型提供商均未能响应。请检查 API Key 配置、模型服务在线状态与网络连接，" +
        "或切换到其他模型提供商后重试。",
    );
  }
  return lines.join("\n");
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

/** 错误文本的第一行（截断到 limit），供尾部「服务方描述」行（hermes short_detail 语义）。 */
export function shortDetail(detail: unknown, limit = 200): string {
  const text = String(detail ?? "").trim().split("\n");
  const first = text[0] || "（无详情）";
  return first.length <= limit ? first : first.slice(0, limit - 1) + "…";
}
