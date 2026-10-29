/**
 * TrajectoryCompressor — Hermes 风格 in-place 轨迹压缩。
 *
 * 对标 Hermes trajectory_compressor.py（868 行）核心算法：
 *   1. 保护头部（第一条 system/human/gpt/tool）和尾部（最后 N 轮）
 *   2. 从中间选择需要摘要的轮次，累积 token 直到覆盖超额 + 摘要本身
 *   3. 边界对齐：不在 tool 轮上切分（不拆分 gpt tool_call/tool response 对）
 *   4. 将摘要轮次替换为一条 human summary 轮
 *   5. 在 system prompt 末尾追加 summary notice
 *
 * 与 EvoClaw CompactionManager 的差异：
 *   - CompactionManager：successor transcript（新建会话、链式拼接）
 *   - TrajectoryCompressor：in-place 压缩（保护头尾、摘要中间、原地替换）
 *
 * 两者互补：TrajectoryCompressor 处理单轮消息装配前的即时压缩，
 * CompactionManager 处理会话级跨轮压缩。
 */

import type { LLMMessage } from "./llm-caller";

/** 压缩配置 */
export interface TrajectoryCompressionConfig {
  /** 目标最大 token 数 */
  targetMaxTokens: number;
  /** 摘要目标 token 数 */
  summaryTargetTokens: number;
  /** 保护第一条 system */
  protectFirstSystem: boolean;
  /** 保护第一条 human */
  protectFirstHuman: boolean;
  /** 保护第一条 gpt (assistant) */
  protectFirstGpt: boolean;
  /** 保护第一条 tool */
  protectFirstTool: boolean;
  /** 保护最后 N 轮 */
  protectLastNTurns: number;
  /** 摘要失败重试次数 */
  maxRetries: number;
  /** 摘要失败重试延迟（秒） */
  retryDelay: number;
  /** 是否在 system prompt 末尾追加 summary notice */
  addSummaryNotice: boolean;
  /** summary notice 文本 */
  summaryNoticeText: string;
}

/** 压缩结果统计 */
export interface TrajectoryCompressionMetrics {
  originalTokens: number;
  compressedTokens: number;
  tokensSaved: number;
  compressionRatio: number;
  originalTurns: number;
  compressedTurns: number;
  turnsRemoved: number;
  turnsCompressedStartIdx: number;
  turnsCompressedEndIdx: number;
  turnsInCompressedRegion: number;
  wasCompressed: boolean;
  stillOverLimit: boolean;
  skippedUnderTarget: boolean;
  summarizationApiCalls: number;
  summarizationErrors: number;
}

const DEFAULT_CONFIG: TrajectoryCompressionConfig = {
  targetMaxTokens: 15250,
  summaryTargetTokens: 750,
  protectFirstSystem: true,
  protectFirstHuman: true,
  protectFirstGpt: true,
  protectFirstTool: true,
  protectLastNTurns: 4,
  maxRetries: 3,
  retryDelay: 2,
  addSummaryNotice: true,
  summaryNoticeText: "\n\nSome of your previous tool responses may have been summarized to preserve context.",
};

/** 摘要 fallback（对齐 Hermes _SUMMARY_FALLBACK） */
const SUMMARY_FALLBACK =
  "[CONTEXT SUMMARY]: [Summary generation failed - previous turns contained tool calls and responses that have been compressed to save context space.]";

/** 摘要前缀（对齐 Hermes） */
const SUMMARY_PREFIX = "[CONTEXT SUMMARY]:";

/**
 * 估算 token 数（无 tokenizer 时用 char/4 近似）。
 * 对齐 Hermes count_tokens 的 fallback 逻辑。
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  // 粗略估算：英文 ~4 chars/token，中文 ~1.5 chars/token
  // 取折中值 3 chars/token
  return Math.ceil(text.length / 3);
}

/** 消息内容的 token 估算 */
function estimateMessageTokens(msg: LLMMessage): number {
  const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
  let tokens = estimateTokens(content);
  if (msg.tool_calls) {
    tokens += estimateTokens(JSON.stringify(msg.tool_calls));
  }
  return tokens;
}

/** 轮次 token 计数列表 */
function countTurnTokens(trajectory: LLMMessage[]): number[] {
  return trajectory.map(estimateMessageTokens);
}

/** 整条轨迹的 token 总数 */
function countTrajectoryTokens(trajectory: LLMMessage[]): number {
  return countTurnTokens(trajectory).reduce((a, b) => a + b, 0);
}

/**
 * 查找受保护的索引范围。
 * 返回 (compressibleStart, compressibleEnd) —— 可压缩区域 [start, end)。
 */
function findProtectedIndices(
  trajectory: LLMMessage[],
  config: TrajectoryCompressionConfig
): { start: number; end: number } {
  const n = trajectory.length;
  const firstSeen = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const role = trajectory[i].role;
    if (!firstSeen.has(role)) firstSeen.set(role, i);
  }

  // 头部保护：第一条 system/human/gpt/tool
  const headProtected = new Set<number>();
  if (config.protectFirstSystem && firstSeen.has("system")) headProtected.add(firstSeen.get("system")!);
  if (config.protectFirstHuman && firstSeen.has("user")) headProtected.add(firstSeen.get("user")!);
  if (config.protectFirstGpt && firstSeen.has("assistant")) headProtected.add(firstSeen.get("assistant")!);
  if (config.protectFirstTool && firstSeen.has("tool")) headProtected.add(firstSeen.get("tool")!);

  // 尾部保护：最后 N 轮
  const tailStart = Math.max(0, n - config.protectLastNTurns);
  for (let i = tailStart; i < n; i++) headProtected.add(i);

  // 可压缩区域：头部保护之后、尾部保护之前
  const headProtectedList = [...headProtected].filter((i) => i < n / 2);
  const tailProtectedList = [...headProtected].filter((i) => i >= n / 2);

  const start = headProtectedList.length > 0 ? Math.max(...headProtectedList) + 1 : 0;
  const end = tailProtectedList.length > 0 ? Math.min(...tailProtectedList) : n;

  return { start, end };
}

/**
 * 边界对齐：将边界移动到最近的不在 tool 轮上的位置。
 * tool 轮总是紧随其回答的 assistant 轮之后，在 tool 轮上切分会拆散配对。
 */
function snapBoundary(trajectory: LLMMessage[], idx: number, minIdx: number, maxIdx: number): number {
  const isClean = (i: number): boolean => i >= trajectory.length || trajectory[i].role !== "tool";

  // 优先向前找
  let forward = idx;
  while (forward < maxIdx && !isClean(forward)) {
    forward++;
  }
  if (isClean(forward)) return forward;

  // 向前找
  let backward = idx;
  while (backward > minIdx && !isClean(backward)) {
    backward--;
  }
  return backward;
}

/** 提取待摘要的轮次内容（长值截断） */
function extractTurnContentForSummary(trajectory: LLMMessage[], start: number, end: number): string {
  const parts: string[] = [];
  for (let i = start; i < end; i++) {
    const msg = trajectory[i];
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
    // 长值截断（对齐 Hermes：>3000 chars 截断为 head 1500 + tail 500）
    const truncated = content.length > 3000
      ? content.slice(0, 1500) + "\n\n... [truncated] ...\n\n" + content.slice(-500)
      : content;
    const roleLabel = msg.role.toUpperCase();
    parts.push(`[Turn ${i} - ${roleLabel}]:\n${truncated}`);
  }
  return parts.join("\n\n");
}

/** 构建摘要提示词（对齐 Hermes _summary_prompt） */
function buildSummaryPrompt(content: string, summaryTargetTokens: number): string {
  return `Summarize the following agent conversation turns concisely. This summary will replace these turns in the conversation history.

Write the summary from a neutral perspective describing what the assistant did and learned. Include:
1. What actions the assistant took (tool calls, searches, file operations)
2. Key information or results obtained
3. Any important decisions or findings
4. Relevant data, file names, values, or outputs

Keep the summary factual and informative. Target approximately ${summaryTargetTokens} tokens.

---
TURNS TO SUMMARIZE:
${content}
---

Write only the summary, starting with "[CONTEXT SUMMARY]:" prefix.`;
}

/** 从 LLM 响应中提取摘要文本 */
function finishSummary(response: string): string {
  const text = response.trim();
  if (text.startsWith(SUMMARY_PREFIX)) return text;
  return text ? `${SUMMARY_PREFIX} ${text}` : SUMMARY_PREFIX;
}

/**
 * TrajectoryCompressor — in-place 轨迹压缩器。
 */
export class TrajectoryCompressor {
  private config: TrajectoryCompressionConfig;

  constructor(config?: Partial<TrajectoryCompressionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 压缩一条轨迹到目标 token 预算内。
   * 返回 (compressedTrajectory, metrics)。
   *
   * 流程：
   *   1. 如果已在预算内，跳过（skippedUnderTarget=true）
   *   2. 找到受保护的头尾范围
   *   3. 从中间累积 token 直到覆盖超额 + 摘要本身
   *   4. 边界对齐（不在 tool 轮上切分）
   *   5. 生成摘要（LLM 调用 + 重试）
   *   6. 组装：头部（追加 summary notice）+ 摘要 human 轮 + 尾部
   */
  async compress(
    trajectory: LLMMessage[],
    llmSummarizer: (prompt: string) => Promise<string>
  ): Promise<{ trajectory: LLMMessage[]; metrics: TrajectoryCompressionMetrics }> {
    const metrics: TrajectoryCompressionMetrics = {
      originalTokens: 0,
      compressedTokens: 0,
      tokensSaved: 0,
      compressionRatio: 1.0,
      originalTurns: trajectory.length,
      compressedTurns: trajectory.length,
      turnsRemoved: 0,
      turnsCompressedStartIdx: -1,
      turnsCompressedEndIdx: -1,
      turnsInCompressedRegion: 0,
      wasCompressed: false,
      stillOverLimit: false,
      skippedUnderTarget: false,
      summarizationApiCalls: 0,
      summarizationErrors: 0,
    };

    const turnTokens = countTurnTokens(trajectory);
    const totalTokens = turnTokens.reduce((a, b) => a + b, 0);
    metrics.originalTokens = totalTokens;
    metrics.compressedTokens = totalTokens;

    // 已在预算内 → 跳过
    if (totalTokens <= this.config.targetMaxTokens) {
      metrics.skippedUnderTarget = true;
      return { trajectory, metrics };
    }
    metrics.stillOverLimit = true;

    // 找到可压缩区域
    const { start, end } = findProtectedIndices(trajectory, this.config);
    if (start >= end) {
      return { trajectory, metrics };
    }

    // 对齐起始边界（不在 tool 轮上切分）
    const snappedStart = snapBoundary(trajectory, start, start, end);
    if (snappedStart >= end) {
      return { trajectory, metrics };
    }

    // 累积 token 直到覆盖超额 + 摘要本身
    const targetTokensToCompress = totalTokens - this.config.targetMaxTokens + this.config.summaryTargetTokens;
    let accumulated = 0;
    let until = snappedStart;
    for (let i = snappedStart; i < end; i++) {
      accumulated += turnTokens[i];
      until = i + 1;
      if (accumulated >= targetTokensToCompress) break;
    }
    if (accumulated < targetTokensToCompress && until < end) {
      until = end;
    }

    // 对齐结束边界
    const snappedUntil = snapBoundary(trajectory, until, snappedStart, end);

    // 压缩区域不能比摘要本身还小
    if (snappedUntil <= snappedStart || turnTokens.slice(snappedStart, snappedUntil).reduce((a, b) => a + b, 0) <= this.config.summaryTargetTokens) {
      return { trajectory, metrics };
    }

    metrics.turnsCompressedStartIdx = snappedStart;
    metrics.turnsCompressedEndIdx = snappedUntil;
    metrics.turnsInCompressedRegion = snappedUntil - snappedStart;

    // 生成摘要
    const content = extractTurnContentForSummary(trajectory, snappedStart, snappedUntil);
    const prompt = buildSummaryPrompt(content, this.config.summaryTargetTokens);
    let summary: string = "";
    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        metrics.summarizationApiCalls++;
        const response = await llmSummarizer(prompt);
        summary = finishSummary(response);
        break;
      } catch (err) {
        metrics.summarizationErrors++;
        if (attempt >= this.config.maxRetries - 1) {
          summary = SUMMARY_FALLBACK;
          break;
        }
        // 指数退避
        const delay = this.config.retryDelay * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay * 1000));
      }
    }
    if (!summary) summary = SUMMARY_FALLBACK;

    // 组装压缩后的轨迹
    const compressed: LLMMessage[] = [];
    // 头部（system 追加 summary notice）
    for (let i = 0; i < snappedStart; i++) {
      const msg = { ...trajectory[i] };
      if (msg.role === "system" && this.config.addSummaryNotice) {
        msg.content = (typeof msg.content === "string" ? msg.content : "") + this.config.summaryNoticeText;
      }
      compressed.push(msg);
    }
    // 摘要 human 轮
    compressed.push({ role: "user", content: summary });
    // 尾部（逐字保留）
    for (let i = snappedUntil; i < trajectory.length; i++) {
      compressed.push({ ...trajectory[i] });
    }

    // 统计
    metrics.compressedTurns = compressed.length;
    metrics.compressedTokens = countTrajectoryTokens(compressed);
    metrics.turnsRemoved = metrics.originalTurns - metrics.compressedTurns;
    metrics.tokensSaved = metrics.originalTokens - metrics.compressedTokens;
    metrics.compressionRatio = metrics.compressedTokens / Math.max(metrics.originalTokens, 1);
    metrics.wasCompressed = true;
    metrics.stillOverLimit = metrics.compressedTokens > this.config.targetMaxTokens;

    return { trajectory: compressed, metrics };
  }
}
