/**
 * Auto-Reply System — OpenClaw compatibility layer.
 *
 * Handles automatic replies when the agent is mentioned, receives a DM,
 * or matches a configured keyword filter. Supports:
 *
 *   - Mention-based triggers (agent name, @agent)
 *   - Keyword pattern matching
 *   - Off-hours auto-reply (vacation/away mode)
 *   - Rate limiting (cooldown between auto-replies)
 *   - Configurable reply templates
 *
 * The system evaluates rules in order and fires the first match.
 */
import type { EventBus } from "@evoclaw/core";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface AutoReplyRule {
  /** Unique rule id */
  id: string;
  /** Human label */
  label?: string;
  /** When this rule should be active */
  enabled?: boolean;
  /** Match type */
  trigger: "mention" | "keyword" | "dm" | "always" | "scheduled";
  /** Keyword patterns (case-insensitive regex supported) */
  keywords?: string[];
  /** Regex pattern(s) */
  patterns?: string[];
  /** Sender filter (glob patterns) */
  senderFilter?: string[];
  /** Channel filter */
  channelFilter?: string[];
  /** Reply template. Use {{sender}} {{message}} {{channel}} {{time}} */
  template: string;
  /** Priority (lower = higher priority). Default 100. */
  priority?: number;
  /** Minimum cooldown between replies in ms. Default 30_000. */
  cooldownMs?: number;
  /** Cron-based availability (e.g. "off-hours only") */
  schedule?: string;
  /** Require agent mention in the message text */
  requireMention?: boolean;
  /** Agent names / keywords that count as mentions */
  mentionNames?: string[];
}

export interface AutoReplyContext {
  senderId: string;
  senderName?: string;
  message: string;
  channel: string;
  isDM: boolean;
  mentionsAgent: boolean;
  timestamp?: number;
}

export interface AutoReplyMatch {
  rule: AutoReplyRule;
  renderedReply: string;
  matchedAt: number;
}

export interface AutoReplyConfig {
  rules: AutoReplyRule[];
  /** Global cooldown in ms (applied across all rules) */
  globalCooldownMs?: number;
  /** Whether auto-reply is enabled globally */
  enabled?: boolean;
}

// ──────────────────────────────────────────────────────────────
// AutoReplyEngine
// ──────────────────────────────────────────────────────────────

export class AutoReplyEngine {
  private rules: AutoReplyRule[] = [];
  private enabled = true;
  private globalCooldownMs = 10_000;
  private lastReplyAt = 0;
  private ruleCooldowns = new Map<string, number>();

  constructor(private eventBus?: EventBus) {}

  // ── Configuration ──

  configure(config: AutoReplyConfig): void {
    this.enabled = config.enabled ?? true;
    this.globalCooldownMs = config.globalCooldownMs ?? 10_000;
    this.rules = [...config.rules].sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100),
    );
  }

  addRule(rule: AutoReplyRule): void {
    this.rules.push(rule);
    this.rules.sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100),
    );
  }

  removeRule(id: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  getRules(): ReadonlyArray<AutoReplyRule> {
    return this.rules;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  // ── Matching ──

  /**
   * Evaluate all rules against a message context.
   * Returns the first match (highest priority / lowest priority number),
   * or null if no rule matches.
   */
  evaluate(ctx: AutoReplyContext): AutoReplyMatch | null {
    if (!this.enabled) return null;

    const now = Date.now();

    // Global cooldown
    if (now - this.lastReplyAt < this.globalCooldownMs) return null;

    for (const rule of this.rules) {
      if (rule.enabled === false) continue;

      // Per-rule cooldown
      const lastRule = this.ruleCooldowns.get(rule.id) ?? 0;
      if (now - lastRule < (rule.cooldownMs ?? 30_000)) continue;

      if (this.matchRule(rule, ctx)) {
        const rendered = this.renderTemplate(rule.template, ctx);
        this.lastReplyAt = now;
        this.ruleCooldowns.set(rule.id, now);
        return { rule, renderedReply: rendered, matchedAt: now };
      }
    }

    return null;
  }

  // ── Internal matching ──

  private matchRule(rule: AutoReplyRule, ctx: AutoReplyContext): boolean {
    // Channel filter
    if (
      rule.channelFilter &&
      rule.channelFilter.length > 0 &&
      !rule.channelFilter.some((c) =>
        globMatch(c, ctx.channel),
      )
    ) {
      return false;
    }

    // Sender filter
    if (
      rule.senderFilter &&
      rule.senderFilter.length > 0 &&
      !rule.senderFilter.some((s) =>
        globMatch(s, ctx.senderId),
      )
    ) {
      return false;
    }

    // Require mention
    if (rule.requireMention && !ctx.mentionsAgent) return false;

    // Trigger-specific matching
    switch (rule.trigger) {
      case "mention":
        return ctx.mentionsAgent;

      case "dm":
        return ctx.isDM;

      case "always":
        return true;

      case "keyword": {
        if (!rule.keywords || rule.keywords.length === 0) return false;
        const lower = ctx.message.toLowerCase();
        return rule.keywords.some((kw) => lower.includes(kw.toLowerCase()));
      }

      case "scheduled": {
        // Keyword match is required for scheduled rules too
        if (rule.keywords && rule.keywords.length > 0) {
          const lower = ctx.message.toLowerCase();
          return rule.keywords.some((kw) => lower.includes(kw.toLowerCase()));
        }
        return false;
      }

      default:
        return false;
    }
  }

  // ── Template rendering ──

  private renderTemplate(
    template: string,
    ctx: AutoReplyContext,
  ): string {
    return template
      .replace(/\{\{sender\}\}/g, ctx.senderName || ctx.senderId)
      .replace(/\{\{message\}\}/g, ctx.message)
      .replace(/\{\{channel\}\}/g, ctx.channel)
      .replace(/\{\{time\}\}/g, new Date(ctx.timestamp ?? Date.now()).toLocaleString());
  }
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function globMatch(pattern: string, value: string): boolean {
  // Simple glob: * matches any sequence
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*") +
      "$",
    "i",
  );
  return regex.test(value);
}