/**
 * Response Delivery Filters — 交付过滤（对标 hermes-agent gateway/response_filters.py）
 *
 * 决定已完成的 agent 回合是否应该交付到聊天。
 * 核心能力：静默标记检测——agent 可以用 [SILENT]/NO_REPLY/静默 等标记表示
 * 「有意不回复」，此时不交付到聊天（但不丢弃到对话历史）。
 */

/** 精确整响应静默标记（agent 有意选择不回复） */
export const LIVE_GATEWAY_SILENT_MARKERS = new Set([
  "[SILENT]", "SILENT", "NO_REPLY", "NO REPLY",
  "[静默]", "静默", "[沉默]", "沉默",
]);

/** 带括号的静默标记（用于自主车道的前缀规则） */
export const BRACKETED_SILENCE_MARKERS = Array.from(LIVE_GATEWAY_SILENT_MARKERS)
  .filter((m) => m.startsWith("["))
  .sort();

/** 标记长度上限（比任何合理标记都长，即使有杂散标点） */
const MARKER_LENGTH_CAP = 64;

/** 机器内部通知的 display kind */
export const INTERNAL_NOTIFICATION_DISPLAY_KIND = "internal_notification";

/** 生产者通知的 display kind */
export const PRODUCER_NOTICE_DISPLAY_KINDS = new Set([
  "process_complete", "async_delegation_complete",
]);

/** 机器内部 display kind 集合 */
export const MACHINERY_DISPLAY_KINDS = new Set([
  INTERNAL_NOTIFICATION_DISPLAY_KIND,
  ...PRODUCER_NOTICE_DISPLAY_KINDS,
]);

/** 生产者卡片允许的 display kind */
export const PRODUCER_CARD_KINDS = new Set([
  INTERNAL_NOTIFICATION_DISPLAY_KIND,
  ...PRODUCER_NOTICE_DISPLAY_KINDS,
]);

// ─── 辅助函数 ──────────────────────────────────────────────

function isEdgePunctuation(ch: string): boolean {
  // 方括号保持结构，所以格式错误的 [SILENT 不会变成 SILENT
  if (ch === "[" || ch === "]") return false;
  const cat = getUnicodeCategory(ch);
  return cat.startsWith("P");
}

/** Unicode 类别前缀判断（简化版，不引入完整 ICU） */
function getUnicodeCategory(ch: string): string {
  // 只覆盖标点类别 P*（Pc/Pd/Pe/Pf/Pi/Po/Ps）
  const code = ch.codePointAt(0) ?? 0;
  // ASCII 标点
  if ((code >= 0x21 && code <= 0x2f) || (code >= 0x3a && code <= 0x40) ||
      (code >= 0x5b && code <= 0x60) || (code >= 0x7b && code <= 0x7e)) {
    return "Po"; // 其他标点
  }
  // 常见 Unicode 标点范围
  if ((code >= 0x2000 && code <= 0x206f) || (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)) {
    return "Po";
  }
  return "";
}

function stripEdgeSilencePunctuation(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isEdgePunctuation(text[start])) start++;
  while (end > start && isEdgePunctuation(text[end - 1])) end--;
  return text.slice(start, end).trim();
}

function canonicalSilenceCandidate(text: string): string {
  return text.trim().toUpperCase().split(/\s+/).join(" ");
}

function canonicalSilenceCandidates(text: unknown): string[] {
  const stripped = typeof text === "string" ? text.trim() : "";
  if (!stripped || stripped.length > MARKER_LENGTH_CAP) return [];
  const depunctuated = stripEdgeSilencePunctuation(stripped);
  const forms = depunctuated === stripped ? [stripped] : [stripped, depunctuated];
  return forms.map(canonicalSilenceCandidate);
}

// ─── 核心函数 ──────────────────────────────────────────────

/**
 * 检查响应是否恰好是一个静默标记。
 * 只有当响应完全是静默标记时才返回 true——
 * 只是提到 NO_REPLY 的普通文本必须正常交付。
 * 空白响应不算静默——那是 empty-response 失败路径。
 */
export function isIntentionalSilenceResponse(response: unknown): boolean {
  return canonicalSilenceCandidates(response).some((c) => LIVE_GATEWAY_SILENT_MARKERS.has(c));
}

/**
 * 自主车道（cron、webhook）的宽松静默匹配。
 * 模型可靠地用括号标记 [SILENT] 并附简短说明，
 * 所以不同于交互式的精确匹配，这里也在标记单独出现在首行/末行时抑制。
 * 埋在句子中间的标记仍然交付。
 */
export function isAutonomousSilenceResponse(response: unknown): boolean {
  const stripped = typeof response === "string" ? response.trim() : "";
  if (!stripped) return false;
  const lines = stripped.split("\n").filter((ln) => ln.trim());
  const upper = stripped.toUpperCase();
  // 带括号的标记作为前缀
  const startsWithBracketed = BRACKETED_SILENCE_MARKERS.some((m) => upper.startsWith(m));
  // 整响应/首行/末行中的精确标记
  const hasExact = canonicalSilenceCandidates(stripped).some((c) => LIVE_GATEWAY_SILENT_MARKERS.has(c))
    || (lines.length > 0 && canonicalSilenceCandidates(lines[0]).some((c) => LIVE_GATEWAY_SILENT_MARKERS.has(c)))
    || (lines.length > 0 && canonicalSilenceCandidates(lines[lines.length - 1]).some((c) => LIVE_GATEWAY_SILENT_MARKERS.has(c)));
  return startsWithBracketed || hasExact;
}

/**
 * 静默标记只抑制成功 agent 回合的交付。
 */
export function isIntentionalSilenceAgentResult(
  agentResult: { failed?: boolean } | null | undefined,
  response: unknown,
): boolean {
  return (
    typeof agentResult === "object" && agentResult !== null &&
    agentResult.failed !== true &&
    isIntentionalSilenceResponse(response)
  );
}

/**
 * 是否机器内部 display kind（只有机器内部回合可以在纯静默标记下不交付）
 */
export function isMachineryDisplayKind(displayKind: unknown): boolean {
  return MACHINERY_DISPLAY_KINDS.has(String(displayKind));
}

/**
 * 成功的纯静默标记是否可以在本回合保持静默。
 */
export function silenceAllowed(
  displayKind: unknown,
  replyExpected?: boolean | null,
): boolean {
  return isMachineryDisplayKind(displayKind) || replyExpected === false;
}

/**
 * 流式文本是否可能仍然解析为静默标记。
 * 缓冲区的规范化形式是某个标记的非空前缀时（如正在变成 NO_REPLY 的 "NO"），
 * 暂扣显示，以免原始标记先显示后被撤回。
 */
export function isPartialSilenceMarker(text: unknown): boolean {
  const candidates = canonicalSilenceCandidates(text);
  return candidates.some((c) => {
    if (!c) return false;
    return Array.from(LIVE_GATEWAY_SILENT_MARKERS).some((marker) => marker.startsWith(c));
  });
}

/**
 * 从 display kind 和回复期望判断是否应该抑制交付。
 */
export function shouldSuppressDelivery(
  displayKind: unknown,
  replyExpected: boolean | null | undefined,
  response: unknown,
  failed?: boolean,
): boolean {
  if (failed) return false; // 失败回合不抑制
  const isSilence = isIntentionalSilenceResponse(response);
  if (!isSilence) return false;
  return silenceAllowed(displayKind, replyExpected);
}
