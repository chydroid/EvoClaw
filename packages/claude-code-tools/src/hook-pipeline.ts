/**
 * Hook Pipeline — 生命周期拦截
 *
 * 借鉴 Claude Code 的 12 个 Hook 事件：
 *   SessionStart → UserPromptSubmit → PreToolUse → PermissionRequest
 *   → PostToolUse/PostToolUseFailure → Stop → SubagentStop
 *   → PreCompact → SessionEnd → Notification
 *
 * 每个 Hook 可以返回 Allow / Block / Modify 三种决策。
 *
 * 参考: https://docs.claude.com/en/docs/claude-code/hooks
 */

// ── Hook Event Types (mapped from Claude Code's 12 lifecycle events) ──

export enum HookEvent {
  SessionStart = "SessionStart",
  UserPromptSubmit = "UserPromptSubmit",
  PreToolUse = "PreToolUse",
  PermissionRequest = "PermissionRequest",
  PostToolUse = "PostToolUse",
  PostToolUseFailure = "PostToolUseFailure",
  Stop = "Stop",
  SubagentStart = "SubagentStart",
  SubagentStop = "SubagentStop",
  PreCompact = "PreCompact",
  SessionEnd = "SessionEnd",
  Notification = "Notification",
}

export enum HookDecision {
  /** Allow the operation to proceed */
  Allow = "allow",
  /** Block the operation (exit code 2 in Claude Code) */
  Block = "block",
  /** Modify the operation parameters before proceeding */
  Modify = "modify",
  /** Ask user for confirmation */
  Confirm = "confirm",
}

export interface HookContext {
  event: HookEvent;
  sessionId: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  messageContent?: string;
  timestamp: number;
  /** Extra metadata from the triggering context */
  meta: Record<string, unknown>;
}

export interface HookResult {
  decision: HookDecision;
  /** Reason for the decision (shown to user/model) */
  reason?: string;
  /** Modified arguments (when decision = Modify) */
  modifiedArgs?: Record<string, unknown>;
  /** Feedback to inject into model context (when decision = Allow/Modify) */
  feedback?: string;
}

export type HookHandler = (ctx: HookContext) => Promise<HookResult> | HookResult;

// ── Hook Pipeline ──

export class HookPipeline {
  private handlers = new Map<HookEvent, HookHandler[]>();

  /**
   * Register a handler for a specific event.
   * Multiple handlers can be registered per event — they execute in registration order.
   */
  on(event: HookEvent, handler: HookHandler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  /**
   * Remove all handlers for an event.
   */
  off(event: HookEvent): this {
    this.handlers.delete(event);
    return this;
  }

  /**
   * Execute all handlers for an event in chain.
   * The first Block decision stops the chain immediately.
   */
  async execute(event: HookEvent, ctx: HookContext): Promise<HookResult> {
    const handlers = this.handlers.get(event);
    if (!handlers || handlers.length === 0) {
      return { decision: HookDecision.Allow };
    }

    // 深拷贝 meta，避免 handler 间共享嵌套对象引用导致意外修改
    // 使用 structuredClone 原生支持循环引用，避免 JSON.stringify 在遇到
    // 循环引用时抛出 TypeError（项目要求 Node >= 20，已内置该 API）
    let context = { ...ctx, meta: ctx.meta ? structuredClone(ctx.meta) : ctx.meta };
    let finalDecision = HookDecision.Allow;
    let finalReason = "";
    const feedbacks: string[] = [];

    for (const handler of handlers) {
      let result;
      try {
        result = await handler(context);
      } catch (err) {
        // 单个 handler 抛错不应中断整条 pipeline，否则已累积的 feedbacks 和
        // context 修改全部丢失，调用方拿到异常而非 Allow/Block/Modify 决策。
        process.stderr.write(`[HookPipeline] Handler for "${event}" threw: ${err instanceof Error ? err.message : String(err)}\n`);
        continue;
      }

      // If a modify decision lacks modifiedArgs, warn and skip
      if (result.decision === HookDecision.Modify && !result.modifiedArgs) {
        console.warn(`Hook for ${event} returned Modify decision without modifiedArgs; skipping`);
        continue;
      }

      // If tool args were modified, update context for next handler
      if (result.decision === HookDecision.Modify && result.modifiedArgs) {
        context = { ...context, toolArgs: result.modifiedArgs };
      }
      if (result.feedback) {
        feedbacks.push(result.feedback);
      }
      if (result.reason) {
        finalReason = result.reason;
      }

      // Block stops the chain
      if (result.decision === HookDecision.Block) {
        return {
          decision: HookDecision.Block,
          reason: result.reason ?? `Blocked by hook: ${event}`,
        };
      }

      // Escalate decision priority: Block > Confirm > Modify > Allow
      if (result.decision === HookDecision.Confirm) {
        finalDecision = HookDecision.Confirm;
      } else if (result.decision === HookDecision.Modify && finalDecision !== HookDecision.Confirm) {
        finalDecision = HookDecision.Modify;
      }
    }

    return {
      decision: finalDecision,
      reason: finalReason || undefined,
      feedback: feedbacks.length > 0 ? feedbacks.join("\n") : undefined,
      modifiedArgs: context.toolArgs !== ctx.toolArgs ? context.toolArgs : undefined,
    };
  }

  /**
   * Check if any handlers are registered for an event.
   */
  hasHandlers(event: HookEvent): boolean {
    const list = this.handlers.get(event);
    return list !== undefined && list.length > 0;
  }

  /**
   * Get the number of registered handlers for an event.
   */
  handlerCount(event: HookEvent): number {
    return this.handlers.get(event)?.length ?? 0;
  }

  /** List all events that have at least one handler */
  get activeEvents(): HookEvent[] {
    return Array.from(this.handlers.entries())
      .filter(([, list]) => list.length > 0)
      .map(([event]) => event);
  }
}

// ── Default Pipeline Factory ──

/**
 * Create a HookPipeline pre-configured with common safety handlers.
 * (Inspired by Claude Code's default hooks: security blocks + format-on-write)
 */
export function createDefaultHookPipeline(): HookPipeline {
  const pipeline = new HookPipeline();

  // PreToolUse: Block dangerous Write operations outside workspace
  pipeline.on(HookEvent.PreToolUse, async (ctx) => {
    if (ctx.toolName === "Write" || ctx.toolName === "Edit") {
      const filePath = (ctx.toolArgs?.file_path as string) ?? "";
      // Basic safety: warn about writes outside the project root
      if (filePath.includes("..") || filePath.startsWith("/etc/") || filePath.startsWith("C:\\Windows")) {
        return {
          decision: HookDecision.Confirm,
          reason: `Writing outside project workspace: ${filePath}`,
        };
      }
    }
    return { decision: HookDecision.Allow };
  });

  // PostToolUseFailure: Log failures for debugging
  pipeline.on(HookEvent.PostToolUseFailure, async (ctx) => {
    return {
      decision: HookDecision.Allow,
      feedback: `Tool ${ctx.toolName} failed. Session: ${ctx.sessionId}`,
    };
  });

  // PreCompact: Save a backup before compaction
  pipeline.on(HookEvent.PreCompact, async (ctx) => {
    return {
      decision: HookDecision.Allow,
      feedback: `Compacting session ${ctx.sessionId} at ${new Date(ctx.timestamp).toISOString()}`,
    };
  });

  return pipeline;
}