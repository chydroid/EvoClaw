/**
 * UserSignalDetector — 用户信号自动检测器
 *
 * 为 EvolutionEngine 的四个"死订阅"事件提供自动触发源：
 *   - USER_CORRECTION_RECEIVED（user.correction_received）
 *   - CAPABILITY_GAP_DETECTED（capability.gap_detected）
 *
 * 设计原则：保守优先。误报一次会自动触发一次进化周期（用户纠正路径
 * 绕过进化门槛），因此只匹配强信号模式，宁可漏报不误报。
 *
 * 检测器本身是纯函数（无 I/O），便于单元测试；去重逻辑放在
 * RecentSignalStore（带 5 分钟 TTL 的内存签名存储）。
 */

export type UserSignalKind = "correction" | "capability_gap";

export interface CorrectionSignal {
  kind: "correction";
  /** 用户原话（截断） */
  title: string;
  /** 用户认为正确的做法（从原话提取或原样返回） */
  correction: string;
  context: string;
}

export interface CapabilityGapSignal {
  kind: "capability_gap";
  /** 用户请求的能力描述（取用户消息前缀） */
  capability: string;
  context: string;
}

export type UserSignal = CorrectionSignal | CapabilityGapSignal;

const MAX_SNIPPET = 500;

function snippet(text: string, max = MAX_SNIPPET): string {
  return text.trim().slice(0, max);
}

// ── 用户纠正检测 ───────────────────────────────────────────────
//
// 强信号：独立成句即视为纠正，无需上下文佐证。
const STRONG_CORRECTION_PATTERNS: RegExp[] = [
  /你错了/,
  /你答错/,
  /你搞错/,
  /理解错(?:了)?(?:你|我)/,
  /不是让你/,
  /不是说(?:过)?(?:让|你)/,
  /完全(?:不对|错)/,
  /(?:no|wrong)[,.!?\s]*(?:that'?s|that is|that was|you'?re|you are|you said)/i,
  /that'?s (?:not|wrong)/i,
  /not what i (?:asked|said|wanted|meant)/i,
  /you(?:'?re| are) (?:wrong|mistaken)/i,
];

// 弱信号：需要指向"上一轮输出"才视为纠正，降低普通陈述的误报。
const WEAK_CORRECTION_PATTERNS: RegExp[] = [
  /不对(?:[，,。.!！\s]|，应该)/,
  /应该是/,
  /应该改成/,
  /改成(?:这个|这样|我给|我说的|正确)/,
  /正确的是/,
  /正确的做法/,
  /而不是/,
  /(?:刚才|上面|之前|上条|上次)[^。！？\n]{0,24}(?:错|不对|应该是)/,
];

// 弱信号所需的"指向上文"佐证（中文指代或英文指代）。
const PRIOR_REFERENCE_PATTERN =
  /(?:你|你们|刚才|上面|之前|上条|上次|之前说|instead|you said|your (?:answer|response|output)|the (?:answer|response|output) (?:you|i))/i;

/**
 * 检测用户消息是否为对上一轮输出的纠正。
 * 返回 null 表示不构成纠正信号。
 */
export function detectUserCorrection(message: string): CorrectionSignal | null {
  if (!message || message.trim().length < 2) return null;
  const text = message.trim();

  // 强信号：直接命中
  for (const pattern of STRONG_CORRECTION_PATTERNS) {
    if (pattern.test(text)) {
      return {
        kind: "correction",
        title: snippet(text, 80),
        correction: snippet(text),
        context: snippet(text),
      };
    }
  }

  // 弱信号：命中 + 指代上文佐证
  for (const pattern of WEAK_CORRECTION_PATTERNS) {
    if (pattern.test(text) && PRIOR_REFERENCE_PATTERN.test(text)) {
      // 从弱信号中提取"正确的做法"：取"应该是/改成/正确的是"之后的内容
      const extraction =
        text.match(/(?:应该是|应该改成|改成|正确的是|正确的做法)[^。！？\n]*/)?.[0] || text;
      return {
        kind: "correction",
        title: snippet(text, 80),
        correction: snippet(extraction),
        context: snippet(text),
      };
    }
  }

  return null;
}

// ── 能力缺口检测 ───────────────────────────────────────────────
//
// 检测 Agent 回复中的"明确拒绝/声明无法做到"句式。
// 输入 userMessage 用于提取"用户请求的能力"作为缺口描述。
const CAPABILITY_GAP_PATTERNS: RegExp[] = [
  /我无法(?:完成|处理|做到|提供|实现|帮)/,
  /我不能(?:完成|处理|做到|提供|实现)/,
  /(?:我|系统|当前)(?:没有|不具备)(?:这个|该|此)?(?:功能|能力|支持)/,
  /做不到/,
  /不支持(?:该|这个|此)?(?:功能|操作|请求|命令)/,
  /无法(?:处理|完成|做到|实现)(?:该|这个|此)?任务/,
  /\bcannot (?:do|handle|complete|provide|support) (?:this|that)\b/i,
  /\bcan't (?:do|handle|complete|provide) (?:this|that)\b/i,
  /\bunable to (?:do|handle|complete|provide)\b/i,
  /\bnot (?:supported|available)\b/i,
];

/**
 * 检测 Agent 回复是否声明了能力缺口。
 * 返回 null 表示回复不构成能力缺口信号。
 */
export function detectCapabilityGap(
  reply: string,
  userMessage: string
): CapabilityGapSignal | null {
  if (!reply || reply.trim().length < 4) return null;
  const text = reply.trim();

  for (const pattern of CAPABILITY_GAP_PATTERNS) {
    if (pattern.test(text)) {
      return {
        kind: "capability_gap",
        // 能力描述取用户消息前缀（用户想要什么），而非拒绝句本身
        capability: snippet(userMessage || "agent-declared unsupported capability", 60),
        context: snippet(text),
      };
    }
  }

  return null;
}

// ── 近期信号去重 ───────────────────────────────────────────────

/**
 * 带 TTL 的签名去重存储。
 * 同一签名（如同一纠正文本）在 TTL 内只放行一次，防止刷屏触发重复进化周期。
 */
export class RecentSignalStore {
  private seen = new Map<string, number>();

  constructor(private ttlMs = 5 * 60 * 1000) {}

  /**
   * 记录并检查签名。返回 true 表示该签名已存在（应抑制），false 表示首次出现（放行）。
   */
  isDuplicate(key: string, now = Date.now()): boolean {
    const prev = this.seen.get(key);
    if (prev !== undefined && now - prev < this.ttlMs) {
      return true;
    }
    this.seen.set(key, now);
    // 顺手清理过期条目，防止 Map 无界增长
    if (this.seen.size > 500) {
      for (const [k, t] of this.seen) {
        if (now - t >= this.ttlMs) this.seen.delete(k);
      }
    }
    return false;
  }

  /** 注入签名（测试用）。 */
  seed(key: string, at = Date.now()): void {
    this.seen.set(key, at);
  }

  clear(): void {
    this.seen.clear();
  }
}
