/**
 * ConversationFlow — NeMo Guardrails 风格的对话流护栏
 *
 * 与单条消息独立扫描的 GuardrailsManager/SecurityMiddleware 不同，对话流护栏
 * 维护**多轮对话状态机**，能够：
 * 1. 意图分类（intent classification）：基于关键词与正则识别用户意图
 * 2. 对话阶段（flow state）：跟踪当前对话处于哪个阶段
 * 3. 转移规则（transition rules）：定义什么意图在什么阶段允许/拒绝
 * 4. 话题白名单（topic allowed-list）：约束对话范围
 * 5. 渐进式 jailbreak 检测：跨多轮累积可疑信号
 *
 * 典型应用：客服机器人只允许在"身份已验证"阶段查询订单；
 * 技术支持 bot 拒绝超出领域的话题；检测多轮逐步诱导越界。
 *
 * 借鉴：NeMo Guardrails 的 dialog rails、LangChain ConversationChain 的状态跟踪。
 */

import type { PipelineContext, PipelineStage } from "./input-pipeline";

// ── 类型定义 ─────────────────────────────────────────────

/** 对话意图分类 */
export type ConversationIntent =
  | "greeting"          // 问候
  | "question"          // 通用提问
  | "code_request"      // 代码生成/修改请求
  | "file_operation"    // 文件操作
  | "task_delegation"   // 任务委托
  | "personal_info"     // 涉及个人敏感信息
  | "jailbreak_attempt" // 越狱尝试
  | "off_topic"         // 超出允许话题
  | "unknown";

/** 对话阶段状态机 */
export type ConversationState =
  | "init"              // 初始状态
  | "greeting_done"     // 已问候
  | "in_task"           // 任务执行中
  | "awaiting_clarify"  // 等待用户澄清
  | "sensitive_op"      // 敏感操作中（需额外确认）
  | "blocked";          // 被拦截

/** 意图识别规则 */
interface IntentRule {
  intent: ConversationIntent;
  patterns: RegExp[];
  description: string;
}

/** 状态转移规则：在 fromState 下遇到 intent 时，允许/拒绝并转移到 toState */
interface TransitionRule {
  fromState: ConversationState;
  intent: ConversationIntent;
  action: "allow" | "deny" | "require_confirm";
  toState: ConversationState;
  denyReason?: string;
}

/** 对话上下文（按 sessionId 索引） */
interface ConversationContext {
  state: ConversationState;
  intentHistory: ConversationIntent[];
  /** 累积的可疑信号分数 */
  suspicionScore: number;
  /** 最近一次意图 */
  lastIntent: ConversationIntent;
  /** 最近一次更新时间（用于过期清理） */
  updatedAt: number;
}

// ── 意图识别规则（关键词 + 正则） ──────────────────────

const INTENT_RULES: IntentRule[] = [
  {
    intent: "greeting",
    patterns: [
      /^(你好|您好|hi|hello|hey|早上好|晚上好|下午好)\b/i,
    ],
    description: "问候语",
  },
  {
    intent: "code_request",
    patterns: [
      /^(写|创建|实现|生成|修改|重构|修复|debug|write|create|implement|build|fix|refactor)\b/i,
      /\b(代码|函数|类|方法|api|组件|code|function|class|method)\b/i,
    ],
    description: "代码生成/修改请求",
  },
  {
    intent: "file_operation",
    patterns: [
      /^(读取|写入|删除|创建|移动|复制|read|write|delete|create|move|copy)\b/i,
      /\b(文件|目录|文件夹|file|folder|directory|path)\b/i,
    ],
    description: "文件操作",
  },
  {
    intent: "task_delegation",
    patterns: [
      /^(帮我|请|麻烦|assist|help|delegate|分配)\b/i,
      /\b(任务|子任务|委托|task|subtask|delegate)\b/i,
    ],
    description: "任务委托",
  },
  {
    intent: "personal_info",
    patterns: [
      /\b(password|密码|passwd|api[_-]?key|secret|token|信用卡|身份证|ssn)\b/i,
      /\b\d{16,19}\b/, // 信用卡号长度
      /\b\d{3}-\d{2}-\d{4}\b/, // SSN 格式
    ],
    description: "涉及个人敏感信息",
  },
  {
    intent: "jailbreak_attempt",
    patterns: [
      /(ignore|disregard|forget)\s+(previous|prior|above|all)\s+(instructions?|rules?|prompts?)/i,
      /(忽略|无视|忘记)(之前|上面|所有)(的)?(指令|规则|提示)/,
      /\b(system\s+prompt|系统提示词|jailbreak|越狱|DAN)\b/i,
      /\b(you\s+are\s+now|现在你是|pretend\s+to\s+be|扮演)\b/i,
      /\b(override|覆盖|绕过|bypass)\s+(safety|安全|filter|过滤)\b/i,
    ],
    description: "越狱尝试",
  },
];

// ── 默认状态转移规则 ──────────────────────────────────

const DEFAULT_TRANSITIONS: TransitionRule[] = [
  // init 阶段
  { fromState: "init", intent: "greeting", action: "allow", toState: "greeting_done" },
  { fromState: "init", intent: "question", action: "allow", toState: "in_task" },
  { fromState: "init", intent: "code_request", action: "allow", toState: "in_task" },
  { fromState: "init", intent: "file_operation", action: "allow", toState: "in_task" },
  { fromState: "init", intent: "task_delegation", action: "allow", toState: "in_task" },
  { fromState: "init", intent: "personal_info", action: "deny", toState: "blocked", denyReason: "请勿在对话中提供敏感信息（密码、API key、身份证号等）" },
  { fromState: "init", intent: "jailbreak_attempt", action: "deny", toState: "blocked", denyReason: "检测到越狱尝试，已拦截" },

  // greeting_done 阶段
  { fromState: "greeting_done", intent: "greeting", action: "allow", toState: "greeting_done" },
  { fromState: "greeting_done", intent: "question", action: "allow", toState: "in_task" },
  { fromState: "greeting_done", intent: "code_request", action: "allow", toState: "in_task" },
  { fromState: "greeting_done", intent: "jailbreak_attempt", action: "deny", toState: "blocked", denyReason: "检测到越狱尝试，已拦截" },

  // in_task 阶段
  { fromState: "in_task", intent: "question", action: "allow", toState: "in_task" },
  { fromState: "in_task", intent: "code_request", action: "allow", toState: "in_task" },
  { fromState: "in_task", intent: "file_operation", action: "require_confirm", toState: "sensitive_op" },
  { fromState: "in_task", intent: "personal_info", action: "deny", toState: "blocked", denyReason: "请勿在对话中提供敏感信息" },
  { fromState: "in_task", intent: "jailbreak_attempt", action: "deny", toState: "blocked", denyReason: "检测到越狱尝试，已拦截" },

  // sensitive_op 阶段
  { fromState: "sensitive_op", intent: "file_operation", action: "allow", toState: "in_task" },
  { fromState: "sensitive_op", intent: "question", action: "allow", toState: "in_task" },

  // blocked 阶段：只允许问候重新开始
  { fromState: "blocked", intent: "greeting", action: "allow", toState: "greeting_done" },
  { fromState: "blocked", intent: "question", action: "allow", toState: "in_task" },
];

// ── 默认话题白名单（空 = 允许所有话题） ────────────────

const DEFAULT_ALLOWED_TOPICS: RegExp[] = [
  // 默认不限制话题，仅靠 intent + transition 控制
  // 如需限制，可添加如：/\b(编程|代码|技术|programming|coding)\b/i
];

// ── ConversationFlow 主体 ──────────────────────────────

export interface ConversationFlowConfig {
  /** 允许的话题正则（空数组 = 不限制） */
  allowedTopics?: RegExp[];
  /** 自定义转移规则（与默认规则合并，自定义优先） */
  customTransitions?: TransitionRule[];
  /** 可疑分数阈值，超过则拦截 */
  suspicionThreshold?: number;
  /** 会话上下文过期时间（ms），默认 30 分钟 */
  sessionTimeoutMs?: number;
  /** 最大保留会话数（LRU 淘汰） */
  maxSessions?: number;
}

export interface FlowCheckResult {
  /** 是否通过 */
  passed: boolean;
  /** 识别到的意图 */
  intent: ConversationIntent;
  /** 当前对话状态 */
  state: ConversationState;
  /** 转移后的新状态 */
  newState: ConversationState;
  /** 拒绝原因（若 passed=false） */
  denyReason?: string;
  /** 是否需要用户确认 */
  requireConfirm: boolean;
  /** 当前可疑分数 */
  suspicionScore: number;
}

export class ConversationFlow {
  private sessions = new Map<string, ConversationContext>();
  private transitions: TransitionRule[];
  private allowedTopics: RegExp[];
  private suspicionThreshold: number;
  private sessionTimeoutMs: number;
  private maxSessions: number;
  /** 每次越狱尝试增加的可疑分数 */
  private static readonly JAILBREAK_SUSPICION_INCREMENT = 3;
  /** 每次敏感信息增加的可疑分数 */
  private static readonly SENSITIVE_SUSPICION_INCREMENT = 1;

  constructor(config: ConversationFlowConfig = {}) {
    // 自定义规则优先于默认规则（同 fromState+intent 时覆盖）
    const custom = config.customTransitions ?? [];
    const customKeys = new Set(custom.map((r) => `${r.fromState}:${r.intent}`));
    this.transitions = [
      ...custom,
      ...DEFAULT_TRANSITIONS.filter((r) => !customKeys.has(`${r.fromState}:${r.intent}`)),
    ];
    this.allowedTopics = config.allowedTopics ?? DEFAULT_ALLOWED_TOPICS;
    this.suspicionThreshold = config.suspicionThreshold ?? 5;
    this.sessionTimeoutMs = config.sessionTimeoutMs ?? 30 * 60 * 1000;
    this.maxSessions = config.maxSessions ?? 1000;
  }

  /**
   * 检查用户输入是否通过对话流护栏。
   *
   * 流程：
   * 1. 意图分类（关键词 + 正则）
   * 2. 话题白名单检查（若配置）
   * 3. 状态转移规则匹配
   * 4. 可疑分数累积与阈值检查
   * 5. 更新会话上下文
   */
  check(sessionId: string, message: string): FlowCheckResult {
    const ctx = this.getOrCreateContext(sessionId);
    const intent = this.classifyIntent(message);

    // 话题白名单检查（仅在配置了 allowedTopics 时生效）
    if (this.allowedTopics.length > 0 && intent !== "greeting") {
      const matchesTopic = this.allowedTopics.some((p) => p.test(message));
      if (!matchesTopic) {
        ctx.suspicionScore += 1;
        return this.buildResult(intent, ctx, false, "当前话题不在允许范围内", false);
      }
    }

    // 越狱尝试：累积可疑分数
    if (intent === "jailbreak_attempt") {
      ctx.suspicionScore += ConversationFlow.JAILBREAK_SUSPICION_INCREMENT;
    } else if (intent === "personal_info") {
      ctx.suspicionScore += ConversationFlow.SENSITIVE_SUSPICION_INCREMENT;
    }

    // 可疑分数阈值检查
    if (ctx.suspicionScore >= this.suspicionThreshold) {
      ctx.state = "blocked";
      ctx.intentHistory.push(intent);
      ctx.lastIntent = intent;
      ctx.updatedAt = Date.now();
      return this.buildResult(intent, ctx, false, `可疑分数累积达到阈值（${ctx.suspicionScore}/${this.suspicionThreshold}），对话已被拦截`, false);
    }

    // 状态转移规则匹配
    const rule = this.findTransitionRule(ctx.state, intent);
    if (!rule) {
      // 无匹配规则：默认允许，保持当前状态
      ctx.intentHistory.push(intent);
      ctx.lastIntent = intent;
      ctx.updatedAt = Date.now();
      return this.buildResult(intent, ctx, true, undefined, false);
    }

    if (rule.action === "deny") {
      ctx.intentHistory.push(intent);
      ctx.lastIntent = intent;
      ctx.updatedAt = Date.now();
      return this.buildResult(intent, ctx, false, rule.denyReason ?? "当前操作不被允许", false);
    }

    // allow 或 require_confirm：转移状态
    ctx.state = rule.toState;
    ctx.intentHistory.push(intent);
    ctx.lastIntent = intent;
    ctx.updatedAt = Date.now();

    // 限制 intentHistory 长度防止无限增长
    if (ctx.intentHistory.length > 50) {
      ctx.intentHistory = ctx.intentHistory.slice(-50);
    }

    return this.buildResult(intent, ctx, true, undefined, rule.action === "require_confirm");
  }

  /** 获取会话当前状态（用于调试与可视化） */
  getSessionState(sessionId: string): ConversationState | undefined {
    return this.sessions.get(sessionId)?.state;
  }

  /** 重置会话状态（用于用户主动重置或管理员介入） */
  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** 清理过期会话（应由外部定时调用） */
  cleanupExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, ctx] of this.sessions) {
      if (now - ctx.updatedAt > this.sessionTimeoutMs) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** 获取当前活跃会话数 */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  // ── 私有方法 ──

  private getOrCreateContext(sessionId: string): ConversationContext {
    let ctx = this.sessions.get(sessionId);
    if (!ctx) {
      // LRU 淘汰
      if (this.sessions.size >= this.maxSessions) {
        const oldestKey = this.sessions.keys().next().value;
        if (oldestKey) this.sessions.delete(oldestKey);
      }
      ctx = {
        state: "init",
        intentHistory: [],
        suspicionScore: 0,
        lastIntent: "unknown",
        updatedAt: Date.now(),
      };
      this.sessions.set(sessionId, ctx);
    }
    return ctx;
  }

  private classifyIntent(message: string): ConversationIntent {
    const text = message.trim();
    if (!text) return "unknown";

    // 按规则顺序匹配（越狱检测优先级最高，放在规则列表靠前）
    for (const rule of INTENT_RULES) {
      for (const pattern of rule.patterns) {
        if (pattern.test(text)) {
          return rule.intent;
        }
      }
    }

    // 默认归类为通用提问
    if (text.includes("?") || text.includes("？") || /^(what|how|why|when|where|什么|怎么|为什么|何时|哪里)\b/i.test(text)) {
      return "question";
    }

    return "unknown";
  }

  private findTransitionRule(state: ConversationState, intent: ConversationIntent): TransitionRule | undefined {
    return this.transitions.find((r) => r.fromState === state && r.intent === intent);
  }

  private buildResult(
    intent: ConversationIntent,
    ctx: ConversationContext,
    passed: boolean,
    denyReason: string | undefined,
    requireConfirm: boolean,
  ): FlowCheckResult {
    return {
      passed,
      intent,
      state: ctx.state,
      newState: ctx.state,
      denyReason,
      requireConfirm,
      suspicionScore: ctx.suspicionScore,
    };
  }
}

// ── Pipeline Stage 适配器 ──────────────────────────────

/**
 * 创建对话流护栏 pipeline stage。
 *
 * 在 input-pipeline 中插入此 stage，会在 guardrails stage 之后执行，
 * 维护多轮对话状态机，拦截越狱尝试与敏感信息泄露。
 */
export function createConversationFlowStage(flow: ConversationFlow): PipelineStage {
  return {
    name: "conversation-flow",
    async execute(ctx: PipelineContext): Promise<PipelineContext> {
      const result = flow.check(ctx.sessionId, ctx.effectiveMessage);

      if (!result.passed) {
        ctx.shortCircuit = true;
        ctx.shortCircuitReply = result.denyReason ?? "对话被流护栏拦截";
        return ctx;
      }

      if (result.requireConfirm) {
        ctx.warnings.push("此操作需要确认，请明确说明您的意图");
      }

      // 把意图信息写入 metadata，供下游 stage 与 agent 使用
      ctx.metadata.conversationIntent = result.intent;
      ctx.metadata.conversationState = result.newState;
      ctx.metadata.suspicionScore = result.suspicionScore;

      return ctx;
    },
  };
}
