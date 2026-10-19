// EvoClaw 413 / context-overflow 恢复（借鉴 hermes-agent turn_overflow.py）
//
// hermes 的 turn_overflow 防的是：413 payload-too-large 和 context-length 错误。
// 关键洞察：**413 是字节数错误，所以进度按 payload 字节数打分，
// 绝不按 token 估计**——token 估计对图片是 byte-blind 的，导致图片密集
// 的会话在「无进展」上耗尽所有压缩尝试，永久卡死（#88960 / #47339）。
// 真实案例：两个 vision 结果占请求体 96.6%，但只占 token 估计的 ~3.7%。
//
// 核心语义：
//   - _recover_payload_too_large：413 → 压缩后按**字节**重新测量，
//     字节缩水 ≥5% 或消息数减少才重试；否则剥图片 parts 再试；
//     都不行才 fail turn（compression_exhausted 终端契约）
//   - _clamp_output_cap：max_tokens 过大时 clamp 到
//     min(provider_available, local_available) - 64
//   - _UNEXPLAINED_REJECTION_FRACTION=0.5：请求远低于窗口时不压缩，
//     软失败并提示 /retry
//   - max_compression_attempts 上限 + time.sleep(2) 重试间隔

/** 压缩后字节缩水比例阈值（hermes 0.95，即缩水 ≥5% 才算有进展）。 */
export const BYTE_SHRINK_RATIO = 0.95;

/** 未解释拒绝占比阈值（hermes _UNEXPLAINED_REJECTION_FRACTION=0.5）。 */
export const UNEXPLAINED_REJECTION_FRACTION = 0.5;

/** output-cap 安全边距（hermes -64）。 */
export const OUTPUT_CAP_MARGIN = 64;

/** 压缩重试间隔（hermes time.sleep(2)）。 */
export const COMPRESSION_RETRY_INTERVAL_MS = 2000;

/** 最大压缩尝试次数（hermes max_compression_attempts）。 */
export const MAX_COMPRESSION_ATTEMPTS = 3;

/** compression_exhausted 终端契约文案（hermes 语义）。 */
export const COMPRESSION_EXHAUSTED_NOTICE =
  "❌ 请求体过大且无法进一步压缩（payload too large, compression exhausted）。" +
  "请减少上下文（如清除历史、去掉大附件）后重试，或使用 /retry。";

/**
 * 计算消息列表的序列化字节数（413 是字节数错误，所以用字节打分，
* 不用 token 估计——token 估计对图片是 byte-blind 的）。
 */
export function serializedMessagesBytes(messages: Array<Record<string, unknown>>): number {
  return JSON.stringify(messages).length;
}

/**
 * 413 payload-too-large 恢复：按**字节**评估压缩是否有进展。
 *
 * @param messages 当前消息列表
 * @param compressFn 压缩函数（返回压缩后的消息列表，或 null 表示无法压缩）
 * @param options 配置
 * @returns verdict：retry（有进展）/ exhausted（无法压缩，应 fail turn）/ soft_fail（请求远低于窗口，软失败）
 */
export function recoverPayloadTooLarge(
  messages: Array<Record<string, unknown>>,
  compressFn: (msgs: Array<Record<string, unknown>>) => Array<Record<string, unknown>> | null,
  options: {
    attempt?: number;
    maxAttempts?: number;
    contextLength?: number;
    requestTokens?: number;
  } = {},
): {
  verdict: "retry" | "exhausted" | "soft_fail";
  newMessages: Array<Record<string, unknown>> | null;
  originalBytes: number;
  newBytes: number;
  message: string;
} {
  const attempt = options.attempt ?? 1;
  const maxAttempts = options.maxAttempts ?? MAX_COMPRESSION_ATTEMPTS;
  const originalBytes = serializedMessagesBytes(messages);

  // 压缩
  const compressed = compressFn(messages);
  if (!compressed) {
    return {
      verdict: "exhausted",
      newMessages: null,
      originalBytes,
      newBytes: originalBytes,
      message: COMPRESSION_EXHAUSTED_NOTICE,
    };
  }

  const newBytes = serializedMessagesBytes(compressed);
  const shrank = newBytes < originalBytes * BYTE_SHRINK_RATIO || compressed.length < messages.length;

  if (shrank) {
    return {
      verdict: "retry",
      newMessages: compressed,
      originalBytes,
      newBytes,
      message: `🗜️ 压缩后 payload 从 ${originalBytes.toLocaleString()} 字节降到 ${newBytes.toLocaleString()} 字节，重试中...`,
    };
  }

  // 字节数没怎么缩 → compression exhausted
  if (attempt >= maxAttempts) {
    return {
      verdict: "exhausted",
      newMessages: null,
      originalBytes,
      newBytes,
      message: COMPRESSION_EXHAUSTED_NOTICE,
    };
  }

  // 还有尝试次数：返回 exhausted 但让调用方继续尝试（剥图片 parts 等）
  return {
    verdict: "exhausted",
    newMessages: null,
    originalBytes,
    newBytes,
    message: `⚠️ 压缩未能缩小 payload（${originalBytes.toLocaleString()} → ${newBytes.toLocaleString()} 字节），已达尝试上限 ${maxAttempts}。`,
  };
}

/**
 * 判断是否应软失败（请求远低于窗口，不压缩）。
 * hermes _UNEXPLAINED_REJECTION_FRACTION=0.5：当请求远低于窗口时，
* 不压缩，软失败并提示 /retry（本地单槽服务器）。
 */
export function shouldSoftFailUnexplainedRejection(
  requestTokens: number,
  contextLength: number,
): boolean {
  if (contextLength <= 0) return false;
  return requestTokens < contextLength * UNEXPLAINED_REJECTION_FRACTION;
}

/**
 * output-cap clamp（hermes _clamp_output_cap）：
 * max_tokens 过大时 clamp 到 min(provider_available, local_available) - 64。
 */
export function clampOutputCap(
  providerAvailableOut: number,
  requestInputEstimate: number,
  oldCtx: number,
): number {
  const localAvailableOut = oldCtx - requestInputEstimate;
  const safeOut =
    localAvailableOut > 0
      ? Math.max(1, Math.min(providerAvailableOut, localAvailableOut) - OUTPUT_CAP_MARGIN)
      : Math.max(1, providerAvailableOut - OUTPUT_CAP_MARGIN);
  return safeOut;
}