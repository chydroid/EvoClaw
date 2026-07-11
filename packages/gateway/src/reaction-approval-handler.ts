// ── Reaction Approval Handler ──
// OpenClaw 5.26 引入: 反应式approval (Signal/iMessage/WhatsApp)
// 用户在手机上用emoji反应(如👍/👎)批准/拒绝agent操作, 不需要输入/approve命令

/** 渠道类型 */
export type ReactionChannel = "signal" | "imessage" | "whatsapp" | "telegram" | "discord" | "slack";

/** 审批类型 */
export type ApprovalType = "tool_execution" | "send_message" | "modify_data" | "delete_data" | "config_change";

/** Approval请求 */
export interface ReactionApprovalRequest {
  id: string;
  channel: ReactionChannel;
  messageId: string; // 原消息ID
  conversationId: string; // 会话ID
  userId: string;
  approvalType: ApprovalType;
  description: string;
  context?: Record<string, unknown>;
  /** 发送的提示文本 */
  promptText: string;
  /** 批准emoji */
  approveEmoji: string;
  /** 拒绝emoji */
  denyEmoji: string;
  createdAt: number;
  expiresAt: number;
}

/** Approval决定 */
export type ReactionDecision = "approved" | "denied" | "expired";

/** Reaction Approval 配置 */
export interface ReactionApprovalConfig {
  /** 默认超时(ms) */
  defaultTimeoutMs?: number;
  /** 按approvalType配置超时 */
  typeTimeouts?: Partial<Record<ApprovalType, number>>;
  /** 自定义emoji映射 */
  emojiMap?: Partial<Record<ApprovalType, { approve: string; deny: string }>>;
  /** 决定回调 */
  onDecision?: (request: ReactionApprovalRequest, decision: ReactionDecision) => Promise<void> | void;
  /** 检测到反应时调用(用于发送确认消息) */
  onReacted?: (request: ReactionApprovalRequest, decision: ReactionDecision) => Promise<void> | void;
}

const DEFAULT_EMOJI_MAP: Record<ApprovalType, { approve: string; deny: string }> = {
  tool_execution: { approve: "👍", deny: "👎" },
  send_message: { approve: "✅", deny: "❌" },
  modify_data: { approve: "✍️", deny: "🚫" },
  delete_data: { approve: "🔥", deny: "🛑" },
  config_change: { approve: "⚙️", deny: "⛔" },
};

const DEFAULT_TIMEOUTS: Record<ApprovalType, number> = {
  tool_execution: 60_000,      // 1分钟
  send_message: 30_000,         // 30秒
  modify_data: 120_000,         // 2分钟
  delete_data: 300_000,         // 5分钟
  config_change: 600_000,       // 10分钟
};

/**
 * ReactionApprovalHandler
 * 通过消息反应(emoji)实现免输入审批
 * 完整流程:
 * 1. agent需要执行敏感操作 → 创建approval request
 * 2. handler向用户发送带"👍/👎"的提示消息
 * 3. 用户用emoji反应
 * 4. handler检测reaction → 触发决定
 */
export class ReactionApprovalHandler {
  private config: Required<ReactionApprovalConfig>;
  private pending = new Map<string, ReactionApprovalRequest>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** channel + messageId -> approvalId (用于快速查询) */
  private messageIndex = new Map<string, string>();
  private counter = 0;
  private stats = {
    created: 0,
    approved: 0,
    denied: 0,
    expired: 0,
    errored: 0,
  };

  constructor(config: Partial<ReactionApprovalConfig> = {}) {
    this.config = {
      defaultTimeoutMs: config.defaultTimeoutMs ?? 60_000,
      typeTimeouts: config.typeTimeouts ?? {},
      emojiMap: { ...DEFAULT_EMOJI_MAP, ...(config.emojiMap ?? {}) },
      onDecision: config.onDecision ?? (() => {}),
      onReacted: config.onReacted ?? (() => {}),
    };
  }

  /** 创建reaction approval request */
  createRequest(info: Omit<ReactionApprovalRequest, "id" | "createdAt" | "expiresAt" | "approveEmoji" | "denyEmoji">): ReactionApprovalRequest {
    const id = `reaction-approval-${++this.counter}-${Date.now()}`;
    const timeout = this.config.typeTimeouts[info.approvalType] ?? this.config.defaultTimeoutMs;
    const emojis = this.config.emojiMap[info.approvalType] ?? DEFAULT_EMOJI_MAP[info.approvalType];
    const request: ReactionApprovalRequest = {
      ...info,
      id,
      approveEmoji: emojis.approve,
      denyEmoji: emojis.deny,
      createdAt: Date.now(),
      expiresAt: Date.now() + timeout,
    };
    this.pending.set(id, request);
    this.messageIndex.set(`${info.channel}:${info.messageId}`, id);
    this.stats.created++;
    // 设置超时
    const timer = setTimeout(() => {
      void this.expire(id).catch((err) => {
        process.stderr.write("[ReactionApprovalHandler] expire failed for" + " " + id + ":" + " " + (err instanceof Error ? err.message : String(err)) + "\n");
      });
    }, timeout);
    timer.unref?.();
    this.timers.set(id, timer);
    return request;
  }

  /**
   * 处理来自channel的reaction事件
   * @returns 是否处理了这次reaction (false = 不是approval reaction)
   */
  async handleReaction(channel: ReactionChannel, messageId: string, userId: string, emoji: string): Promise<{
    handled: boolean;
    request?: ReactionApprovalRequest;
    decision?: ReactionDecision;
  }> {
    const key = `${channel}:${messageId}`;
    const approvalId = this.messageIndex.get(key);
    if (!approvalId) return { handled: false };
    const request = this.pending.get(approvalId);
    if (!request) return { handled: false };
    if (Date.now() >= request.expiresAt) {
      await this.expire(approvalId);
      return { handled: true, request, decision: "expired" };
    }
    // 验证反应来自原始用户
    if (userId !== request.userId) {
      return { handled: false }; // 不是发起人,忽略
    }
    let decision: ReactionDecision;
    if (emoji === request.approveEmoji || emoji === "thumbsup" || emoji === "+1") {
      decision = "approved";
    } else if (emoji === request.denyEmoji || emoji === "thumbsdown" || emoji === "-1") {
      decision = "denied";
    } else {
      return { handled: false }; // 不认识的emoji
    }
    this.cleanup(approvalId);
    if (decision === "approved") this.stats.approved++;
    else this.stats.denied++;
    if (this.config.onReacted) {
      try { await this.config.onReacted(request, decision); } catch (err) {
        process.stderr.write(`[ReactionApproval] onReacted(${decision}) failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    if (this.config.onDecision) {
      try { await this.config.onDecision(request, decision); } catch (err) {
        process.stderr.write(`[ReactionApproval] onDecision(${decision}) failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    return { handled: true, request, decision };
  }

  /** 获取待处理列表 */
  getPending(channel?: ReactionChannel): ReactionApprovalRequest[] {
    let result = Array.from(this.pending.values());
    if (channel) {
      result = result.filter((r) => r.channel === channel);
    }
    return result;
  }

  /** 手动取消 */
  cancel(id: string): boolean {
    return this.cleanup(id);
  }

  private async expire(id: string): Promise<void> {
    const request = this.pending.get(id);
    if (!request) return;
    this.cleanup(id);
    this.stats.expired++;
    if (this.config.onReacted) {
      try { await this.config.onReacted(request, "expired"); } catch (err) {
        process.stderr.write(`[ReactionApproval] onReacted(expired) failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    if (this.config.onDecision) {
      try { await this.config.onDecision(request, "expired"); } catch (err) {
        process.stderr.write(`[ReactionApproval] onDecision(expired) failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  private cleanup(id: string): boolean {
    const request = this.pending.get(id);
    if (!request) return false;
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.messageIndex.delete(`${request.channel}:${request.messageId}`);
    this.pending.delete(id);
    return true;
  }

  getStats() {
    return {
      ...this.stats,
      pendingCount: this.pending.size,
    };
  }

  /** 清理所有待处理的定时器和状态，在服务关闭时调用 */
  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.pending.clear();
    this.messageIndex.clear();
  }
}
