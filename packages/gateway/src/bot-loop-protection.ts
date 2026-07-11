/**
 * 机器人自循环检测：识别两个 bot 之间的 ping-pong 模式。
 *
 * 灵感来自 openclaw-main 的 src/channels/turn/bot-loop-protection.ts。
 *
 * 检测场景：
 *  1. 两个 bot 互相回复相似内容（ping-pong loop, A→B→A→B...）
 *  2. 单个 bot 重复发送相同消息（self-repeat, A→A→A...）
 *  3. 三个以上 bot 形成循环链（cycle, A→B→C→A→B→C...）
 *
 * 处理阶梯（按 repeatedCount 提升）：
 *  - < minRepeats          → allow
 *  - >= throttleAfter      → throttle
 *  - >= blockAfter         → block
 *  - >= alertAfter         → alert + block
 *
 * 冷却机制：触发 action 后该参与者被抑制 cooldownMs，期间所有消息被拒绝。
 */

import { HistoryWindow, type HistoryEntry } from "./history-window.js";

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** 循环严重度。 */
export type LoopSeverity = "none" | "info" | "warning" | "critical";

/** 循环应对动作。 */
export type LoopAction = "allow" | "throttle" | "block" | "alert";

/** 检测到的循环模式。 */
export type LoopPattern = "ping-pong" | "self-repeat" | "cycle" | "none";

/** 单次评估结果。 */
export interface LoopDetectionResult {
  /** 是否检测到循环 */
  detected: boolean;
  /** 严重度 */
  severity: LoopSeverity;
  /** 应对动作 */
  action: LoopAction;
  /** 循环模式 */
  pattern: LoopPattern;
  /** 参与者 ID 列表（按出现顺序） */
  participants: string[];
  /** 循环长度（2=ping-pong, 3+=cycle, 1=self-repeat） */
  loopLength: number;
  /** 重复次数 */
  repeatedCount: number;
  /** 重复内容样本（脱敏后，仅取首条） */
  sampleContent?: string;
  /** 检测原因（用于日志） */
  reason: string;
}

/** bot 循环保护配置。 */
export interface BotLoopProtectionConfig {
  /** 检测窗口大小（默认 10 条） */
  windowSize: number;
  /** 最小重复次数触发（默认 3） */
  minRepeats: number;
  /** 内容相似度阈值 0-1（默认 0.8） */
  contentSimilarityThreshold: number;
  /** 触发 throttle 的重复次数（默认 2） */
  throttleAfter: number;
  /** 触发 block 的重复次数（默认 4） */
  blockAfter: number;
  /** 触发 alert 的重复次数（默认 6） */
  alertAfter: number;
  /** 冷却时长毫秒（默认 60s） */
  cooldownMs: number;
}

/** 默认配置。 */
export const DEFAULT_BOT_LOOP_CONFIG: BotLoopProtectionConfig = {
  windowSize: 10,
  minRepeats: 3,
  contentSimilarityThreshold: 0.8,
  throttleAfter: 2,
  blockAfter: 4,
  alertAfter: 6,
  cooldownMs: 60 * 1000,
};

// ─── 主类 ─────────────────────────────────────────────────────────────────────

/**
 * BotLoopProtection：检测并抑制机器人自循环回复。
 *
 * 使用方式：
 *  - 每条消息到达后调用 evaluate(entry)
 *  - 根据 result.action 决定是否放行
 *  - 可手动 suppress(botId, reason, durationMs) 强制抑制
 */
export class BotLoopProtection {
  private readonly config: BotLoopProtectionConfig;
  private readonly window: HistoryWindow;
  private readonly suppressions = new Map<string, { until: Date; reason: string }>();

  constructor(config?: Partial<BotLoopProtectionConfig>) {
    this.config = { ...DEFAULT_BOT_LOOP_CONFIG, ...config };
    this.window = new HistoryWindow({
      maxSize: this.config.windowSize * 2,
      maxAgeMs: 5 * 60 * 1000,
    });
  }

  /**
   * 评估新消息是否会触发循环保护。
   * 副作用：将 entry 添加到内部历史窗口，并可能记录 suppression。
   */
  evaluate(entry: HistoryEntry): LoopDetectionResult {
    // 1. 添加到窗口
    this.window.add(entry);

    // 2. 检查是否在冷却期
    if (this.isSuppressed(entry.senderId, entry.timestamp)) {
      return {
        detected: true,
        severity: "critical",
        action: "block",
        pattern: "none",
        participants: [entry.senderId],
        loopLength: 0,
        repeatedCount: 0,
        reason: "sender is in cooldown window",
      };
    }

    // 3. 取窗口最近 N 条（按时间倒序：[0] = 最新）
    const recent = this.window.recent(this.config.windowSize);
    if (recent.length < this.config.minRepeats) {
      return this.allowResult("insufficient history");
    }

    // 4. 尝试检测各类模式
    const pingPong = this.detectPingPong(recent, entry);
    if (pingPong.detected) return pingPong;

    const selfRepeat = this.detectSelfRepeat(recent, entry);
    if (selfRepeat.detected) return selfRepeat;

    const cycle = this.detectCycle(recent, entry);
    if (cycle.detected) return cycle;

    return this.allowResult("no loop pattern detected");
  }

  /**
   * 检查指定参与者是否在冷却期。
   */
  isSuppressed(participantId: string, now: Date = new Date()): boolean {
    const sup = this.suppressions.get(participantId);
    if (!sup) return false;
    if (sup.until.getTime() <= now.getTime()) {
      this.suppressions.delete(participantId);
      return false;
    }
    return true;
  }

  /**
   * 手动压制指定参与者（用于外部反馈）。
   */
  suppress(participantId: string, reason: string, durationMs?: number): void {
    const duration = durationMs ?? this.config.cooldownMs;
    const until = new Date(Date.now() + duration);
    this.suppressions.set(participantId, { until, reason });
  }

  /**
   * 清理过期 suppressions。返回清理条数。
   */
  pruneSuppressions(now: Date = new Date()): number {
    let removed = 0;
    for (const [id, sup] of this.suppressions.entries()) {
      if (sup.until.getTime() <= now.getTime()) {
        this.suppressions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  // ─── 内部：模式检测 ─────────────────────────────────────────────────────────

  /** 允许结果工厂。 */
  private allowResult(reason: string): LoopDetectionResult {
    return {
      detected: false,
      severity: "none",
      action: "allow",
      pattern: "none",
      participants: [],
      loopLength: 0,
      repeatedCount: 0,
      reason,
    };
  }

  /**
   * 检测 ping-pong：A→B→A→B... 模式。
   * 要求最近 N 条中 A 与 B 交替出现，且内容相似度高于阈值。
   * 不假设序列起点：从数据中推断 even/odd 模式。
   */
  private detectPingPong(recent: HistoryEntry[], current: HistoryEntry): LoopDetectionResult {
    const { senderId, recipientId } = current;
    if (!senderId || !recipientId || senderId === recipientId) {
      return this.allowResult("invalid sender/recipient for ping-pong");
    }

    // 过滤 A↔B 双向消息（按时间正序）
    const between = this.window
      .recentBetween(senderId, recipientId, this.config.windowSize)
      .reverse(); // 正序：旧 → 新

    if (between.length < this.config.minRepeats) {
      return this.allowResult("insufficient ping-pong history");
    }

    // 从数据推断 even/odd 模式：偶数索引 sender 与奇数索引 sender 应不同
    const evenSender = between[0]!.senderId;
    const oddSender = between.length > 1 ? between[1]!.senderId : evenSender;
    if (evenSender === oddSender) {
      // 同一发送者连续，不是 ping-pong（可能是 self-repeat）
      return this.allowResult("not alternating");
    }
    // 验证参与者必须是 {senderId, recipientId}
    const participants = new Set([evenSender, oddSender]);
    if (
      participants.size !== 2 ||
      !participants.has(senderId) ||
      !participants.has(recipientId)
    ) {
      return this.allowResult("participants mismatch");
    }

    // 检查交替模式完整性
    let alternationCount = 0;
    let similarCount = 0;
    let sampleContent: string | undefined;
    for (let i = 0; i < between.length; i++) {
      const expected = i % 2 === 0 ? evenSender : oddSender;
      if (between[i]!.senderId !== expected) {
        // 模式中断：交替性破坏则不是 ping-pong
        alternationCount = 0;
        break;
      }
      alternationCount++;
      // 内容相似度：与最早一条比较
      if (i > 0) {
        const sim = this.computeSimilarity(between[0]!.content, between[i]!.content);
        if (sim >= this.config.contentSimilarityThreshold) {
          similarCount++;
          if (sampleContent === undefined) sampleContent = between[0]!.content;
        }
      }
    }

    // 要求：交替数 >= minRepeats 且相似数 >= minRepeats - 1
    if (
      alternationCount >= this.config.minRepeats &&
      similarCount >= this.config.minRepeats - 1
    ) {
      const repeatedCount = alternationCount;
      const result = this.decideAction(repeatedCount, sampleContent);
      // 规范化 participants 顺序：以 [evenSender, oddSender] 返回（最早消息的 sender 优先）
      const orderedParticipants = [evenSender, oddSender];
      return {
        detected: true,
        severity: result.severity,
        action: result.action,
        pattern: "ping-pong",
        participants: orderedParticipants,
        loopLength: 2,
        repeatedCount,
        sampleContent,
        reason: `ping-pong loop detected between ${senderId} and ${recipientId}`,
      };
    }
    return this.allowResult("no ping-pong pattern");
  }

  /**
   * 检测 self-repeat：A→A→A... 模式（同一发送者连续相似消息）。
   */
  private detectSelfRepeat(recent: HistoryEntry[], current: HistoryEntry): LoopDetectionResult {
    const senderId = current.senderId;
    const bySender = recent.filter((e) => e.senderId === senderId);
    if (bySender.length < this.config.minRepeats) {
      return this.allowResult("insufficient self-repeat history");
    }

    // 取连续相似的消息（从最新往回数）
    const base = bySender[0]!.content; // 最新一条（也是 current）
    let repeatedCount = 1; // 包含当前
    let sampleContent: string | undefined;
    for (let i = 1; i < bySender.length; i++) {
      const sim = this.computeSimilarity(base, bySender[i]!.content);
      if (sim >= this.config.contentSimilarityThreshold) {
        repeatedCount++;
        if (sampleContent === undefined) sampleContent = bySender[i]!.content;
      } else {
        break; // 遇到不相似则中断
      }
    }

    if (repeatedCount >= this.config.minRepeats) {
      const result = this.decideAction(repeatedCount, sampleContent);
      return {
        detected: true,
        severity: result.severity,
        action: result.action,
        pattern: "self-repeat",
        participants: [senderId],
        loopLength: 1,
        repeatedCount,
        sampleContent,
        reason: `self-repeat loop detected for ${senderId}`,
      };
    }
    return this.allowResult("no self-repeat pattern");
  }

  /**
   * 检测 cycle：A→B→C→A→B→C... 模式（3 个以上参与者循环）。
   * 通过寻找 senderId 序列的最小重复单元。
   */
  private detectCycle(recent: HistoryEntry[], current: HistoryEntry): LoopDetectionResult {
    if (recent.length < this.config.minRepeats + 1) {
      return this.allowResult("insufficient cycle history");
    }

    // 取 recent 中最近的 senderId 序列（最新在前）
    const senderSeq = recent.map((e) => e.senderId);
    // 尝试 cycle 长度 3..N/2
    const maxLen = Math.floor(senderSeq.length / 2);
    for (let cycleLen = 3; cycleLen <= maxLen; cycleLen++) {
      // 检查前 cycleLen 项是否与再前 cycleLen 项一致
      const pattern1 = senderSeq.slice(0, cycleLen);
      const pattern2 = senderSeq.slice(cycleLen, cycleLen * 2);
      if (this.arraysEqual(pattern1, pattern2)) {
        // 进一步检查内容相似度
        const baseContent = recent[0]!.content;
        let similarCount = 0;
        let sampleContent: string | undefined;
        for (let i = 0; i < cycleLen; i++) {
          const sim = this.computeSimilarity(baseContent, recent[i]!.content);
          if (sim >= this.config.contentSimilarityThreshold) {
            similarCount++;
            if (sampleContent === undefined) sampleContent = recent[i]!.content;
          }
        }
        if (similarCount >= Math.max(1, cycleLen - 1)) {
          // repeatedCount = 一个完整 cycle 中的相似次数 × 出现的 cycle 数
          const cycleOccurrences = Math.floor(senderSeq.length / cycleLen);
          const repeatedCount = cycleOccurrences * similarCount;
          const result = this.decideAction(repeatedCount, sampleContent);
          const participants = [...new Set(pattern1)];
          return {
            detected: true,
            severity: result.severity,
            action: result.action,
            pattern: "cycle",
            participants,
            loopLength: cycleLen,
            repeatedCount,
            sampleContent,
            reason: `cycle loop detected (${participants.join("→")} repeated ${cycleOccurrences}x)`,
          };
        }
      }
    }
    return this.allowResult("no cycle pattern");
  }

  /** 根据 repeatedCount 与配置决定 severity 与 action。 */
  private decideAction(
    repeatedCount: number,
    sampleContent: string | undefined,
  ): { severity: LoopSeverity; action: LoopAction } {
    if (repeatedCount >= this.config.alertAfter) {
      return { severity: "critical", action: "alert" };
    }
    if (repeatedCount >= this.config.blockAfter) {
      return { severity: "warning", action: "block" };
    }
    if (repeatedCount >= this.config.throttleAfter) {
      return { severity: "info", action: "throttle" };
    }
    return { severity: "none", action: "allow" };
  }

  /** 比较两个字符串数组是否相等。 */
  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }

  /**
   * 计算两段文本的相似度（0-1）。
   * 使用 Levenshtein 距离归一化。
   * 1 = 完全相同，0 = 完全不同。
   */
  computeSimilarity(a: string, b: string): number {
    const na = this.normalizeText(a);
    const nb = this.normalizeText(b);
    if (na === nb) return 1;
    if (na.length === 0 || nb.length === 0) return 0;
    // DoS 防护：超长输入跳过 O(m*n) Levenshtein，按长度差异估算相似度
    // 若长度差异大则相似度趋近 0，长度相近时给出保守估计
    const MAX_LEVENSHTEIN_LEN = 500;
    if (na.length > MAX_LEVENSHTEIN_LEN || nb.length > MAX_LEVENSHTEIN_LEN) {
      const maxLen = Math.max(na.length, nb.length);
      return 1 - Math.abs(na.length - nb.length) / maxLen;
    }
    const dist = this.levenshtein(na, nb);
    const maxLen = Math.max(na.length, nb.length);
    return 1 - dist / maxLen;
  }

  /**
   * 文本归一化：去标点 + 转小写 + 折叠空白。
   */
  normalizeText(text: string): string {
    return text
      .toLowerCase()
      // 折叠所有空白为单空格
      .replace(/\s+/g, " ")
      // 去除标点（保留字母、数字、空格、CJK 范围）
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .trim();
  }

  /**
   * Levenshtein 距离：两字符串的最小编辑距离。
   * 使用动态规划两行实现，空间 O(min(m,n))。
   */
  private levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // 确保 b 是较短的，节省空间
    if (a.length < b.length) {
      [a, b] = [b, a];
    }
    const bLen = b.length;
    let prev = new Array<number>(bLen + 1);
    let curr = new Array<number>(bLen + 1);
    for (let j = 0; j <= bLen; j++) prev[j] = j;

    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      for (let j = 1; j <= bLen; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j]! + 1, // 删除
          curr[j - 1]! + 1, // 插入
          prev[j - 1]! + cost, // 替换
        );
      }
      [prev, curr] = [curr, prev];
    }
    return prev[bLen]!;
  }
}
