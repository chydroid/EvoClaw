/**
 * L1.5 任务边界判定 — 短任务 vs 长任务判断。
 *
 * 借鉴 TencentDB-Agent-Memory 的 `src/offload/hooks/before-agent-start.ts` L1.5：
 * - 判断当前对话是"短任务"（闲聊、单步查询）还是"长任务"（多步骤、工具调用密集）
 * - 短任务：不创建 MMD 画布，避免噪音
 * - 长任务：创建 MMD 画布，记录任务状态图
 *
 * 启发式判定（不依赖 LLM）：
 * 1. 用户消息长度 > 阈值 → 长任务
 * 2. 包含"步骤性"关键词（"然后"、"接着"、"第一步"、"分几步"）→ 长任务
 * 3. 包含"工具性"关键词（"搜索"、"安装"、"部署"、"构建"）→ 长任务
 * 4. 历史消息数 > 阈值 → 长任务
 * 5. 已有画布存在 → 继续长任务
 */

/** 任务类型判定结果。 */
export type TaskType = "short" | "long" | "continuation";

/** L1.5 判定结果。 */
export interface TaskBoundaryDecision {
  /** 任务类型。 */
  type: TaskType;
  /** 是否应该创建/继续画布。 */
  shouldUseCanvas: boolean;
  /** 触发的判定规则（调试用）。 */
  reason: string;
  /** 置信度（0-1）。 */
  confidence: number;
}

/** L1.5 配置。 */
export interface TaskBoundaryOptions {
  /** 用户消息长度阈值（> 此值视为长任务）。默认 100。 */
  longMessageThreshold?: number;
  /** 历史消息数阈值（> 此值视为长任务）。默认 6。 */
  longHistoryThreshold?: number;
  /** 步骤性关键词。 */
  stepKeywords?: string[];
  /** 工具性关键词。 */
  toolKeywords?: string[];
}

const DEFAULT_OPTIONS: Required<TaskBoundaryOptions> = {
  longMessageThreshold: 100,
  longHistoryThreshold: 6,
  stepKeywords: [
    "然后", "接着", "下一步", "第一步", "第二步", "最后",
    "分几步", "多个步骤", "流程", "依次",
    "first", "second", "then", "next", "finally", "step",
  ],
  toolKeywords: [
    "搜索", "安装", "部署", "构建", "测试", "修复", "重构", "迁移", "配置",
    "生成", "分析", "查询", "执行", "运行", "调试", "提交",
    "search", "install", "deploy", "build", "test", "fix", "refactor",
    "migrate", "configure", "generate", "analyze", "query", "execute",
  ],
};

/**
 * L1.5 任务边界判定器。
 *
 * 使用方式：
 *   const judge = new TaskBoundaryJudge();
 *   const decision = judge.judge({ userMessage, historyLength, hasActiveCanvas });
 *   if (decision.shouldUseCanvas) { canvas.start(...); }
 */
export class TaskBoundaryJudge {
  private opts: Required<TaskBoundaryOptions>;

  constructor(options?: TaskBoundaryOptions) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * 判定任务类型。
   *
   * @param userMessage 当前用户消息
   * @param historyLength 历史消息数（不含当前消息）
   * @param hasActiveCanvas 是否已有活跃画布
   */
  judge(params: {
    userMessage: string;
    historyLength?: number;
    hasActiveCanvas?: boolean;
  }): TaskBoundaryDecision {
    const { userMessage, historyLength = 0, hasActiveCanvas = false } = params;

    // 规则 5：已有画布 → 继续长任务
    if (hasActiveCanvas) {
      return {
        type: "continuation",
        shouldUseCanvas: true,
        reason: "active canvas exists, continue",
        confidence: 0.9,
      };
    }

    // 规则 4：历史消息数 > 阈值
    if (historyLength >= this.opts.longHistoryThreshold) {
      return {
        type: "long",
        shouldUseCanvas: true,
        reason: `history length ${historyLength} >= ${this.opts.longHistoryThreshold}`,
        confidence: 0.7,
      };
    }

    // 规则 1：用户消息长度 > 阈值
    if (userMessage.length > this.opts.longMessageThreshold) {
      return {
        type: "long",
        shouldUseCanvas: true,
        reason: `message length ${userMessage.length} > ${this.opts.longMessageThreshold}`,
        confidence: 0.6,
      };
    }

    // 规则 2：步骤性关键词
    const stepHit = this.matchKeywords(userMessage, this.opts.stepKeywords);
    if (stepHit) {
      return {
        type: "long",
        shouldUseCanvas: true,
        reason: `step keyword "${stepHit}" matched`,
        confidence: 0.75,
      };
    }

    // 规则 3：工具性关键词
    const toolHit = this.matchKeywords(userMessage, this.opts.toolKeywords);
    if (toolHit) {
      return {
        type: "long",
        shouldUseCanvas: true,
        reason: `tool keyword "${toolHit}" matched`,
        confidence: 0.65,
      };
    }

    // 默认：短任务
    return {
      type: "short",
      shouldUseCanvas: false,
      reason: "no long-task signals detected",
      confidence: 0.5,
    };
  }

  private matchKeywords(text: string, keywords: string[]): string | null {
    const lower = text.toLowerCase();
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) return kw;
    }
    return null;
  }
}

/**
 * 判断是否应该结束当前画布（任务完成）。
 *
 * 借鉴 TencentDB-Agent-Memory 的 `handleTaskTransition`：
 * - 用户说"谢谢"、"完成"、"OK" → 任务完成
 * - 新话题开始 → 结束旧画布
 */
export function shouldEndCanvas(userMessage: string): boolean {
  const lower = userMessage.toLowerCase().trim();
  // 任务完成信号
  const endSignals = [
    "谢谢", "感谢", "好的", "ok", "done", "thanks",
    "完成", "搞定", "结束", "可以了", "就这样",
  ];
  for (const sig of endSignals) {
    if (lower === sig || lower === `${sig}。` || lower === `${sig}!`) return true;
  }
  // 短消息 + 无工具性关键词 → 可能是新话题
  if (lower.length < 10 && !/[?？]/.test(lower)) {
    return true;
  }
  return false;
}
