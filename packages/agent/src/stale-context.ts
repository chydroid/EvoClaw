/**
 * Stale Context Invalidation — mark old tool results as unreliable
 * Inspired by OpenClaw 2026.5.7: "Stale context is invalidated rather than silently reused"
 *
 * After a long-running task, tool results may no longer reflect reality.
 * This module tracks tool result timestamps and marks them as stale.
 */

export interface ToolResultMeta {
  toolName: string;
  callId: string;
  timestamp: number;
  sessionId: string;
  isStale: boolean;
  staleAt?: number;
}

export interface StaleContextConfig {
  /** Tool results older than this are considered stale (default: 30 minutes) */
  staleThresholdMs: number;
  /** Tool results older than this are removed entirely (default: 2 hours) */
  removalThresholdMs: number;
  /** Tools whose results become stale faster (e.g., web_search, web_fetch) */
  fastStaleTools: string[];
  /** Fast-stale threshold (default: 5 minutes) */
  fastStaleThresholdMs: number;
}

export const DEFAULT_STALE_CONFIG: StaleContextConfig = {
  staleThresholdMs: 30 * 60 * 1000,
  removalThresholdMs: 2 * 60 * 60 * 1000,
  fastStaleTools: ["web_search", "web_fetch", "fetch", "search", "browse", "screenshot"],
  fastStaleThresholdMs: 5 * 60 * 1000,
};

export class StaleContextManager {
  private toolResults: Map<string, ToolResultMeta> = new Map();
  private config: StaleContextConfig;

  constructor(config?: Partial<StaleContextConfig>) {
    this.config = { ...DEFAULT_STALE_CONFIG, ...config };
  }

  /** Record a tool call result */
  recordToolResult(sessionId: string, toolName: string, callId?: string): void {
    const id = callId || `${sessionId}-${toolName}-${Date.now()}`;
    this.toolResults.set(id, {
      toolName,
      callId: id,
      timestamp: Date.now(),
      sessionId,
      isStale: false,
    });
  }

  /** Check and mark stale results for a session */
  markStaleResults(sessionId: string): ToolResultMeta[] {
    const now = Date.now();
    const staleResults: ToolResultMeta[] = [];

    for (const [id, meta] of this.toolResults) {
      if (meta.sessionId !== sessionId) continue;
      if (meta.isStale) continue;

      const isFastStale = this.config.fastStaleTools.includes(meta.toolName);
      const threshold = isFastStale ? this.config.fastStaleThresholdMs : this.config.staleThresholdMs;

      if ((now - meta.timestamp) > threshold) {
        meta.isStale = true;
        meta.staleAt = now;
        staleResults.push(meta);
      }
    }

    return staleResults;
  }

  /** Remove expired results entirely */
  removeExpiredResults(sessionId?: string): number {
    const now = Date.now();
    let removed = 0;

    for (const [id, meta] of this.toolResults) {
      if (sessionId && meta.sessionId !== sessionId) continue;
      if ((now - meta.timestamp) > this.config.removalThresholdMs) {
        this.toolResults.delete(id);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Generate stale context warnings to inject into conversation.
   * Returns system messages that inform the LLM about stale data.
   */
  generateStaleWarnings(sessionId: string): string[] {
    const staleResults = this.markStaleResults(sessionId);
    const warnings: string[] = [];

    for (const result of staleResults) {
      const ageMinutes = Math.round((Date.now() - result.timestamp) / 60000);
      warnings.push(
        `[上下文过期警告] 工具 "${result.toolName}" 的结果已过期（${ageMinutes}分钟前获取），可能不再反映当前状态。建议重新调用该工具获取最新数据。`
      );
    }

    return warnings;
  }

  /** Get all results for a session */
  getSessionResults(sessionId: string): ToolResultMeta[] {
    return Array.from(this.toolResults.values()).filter(m => m.sessionId === sessionId);
  }

  /** Get stale results for a session */
  getStaleResults(sessionId: string): ToolResultMeta[] {
    return this.getSessionResults(sessionId).filter(m => m.isStale);
  }

  /** Clear results for a session */
  clearSession(sessionId: string): void {
    for (const [id, meta] of this.toolResults) {
      if (meta.sessionId === sessionId) this.toolResults.delete(id);
    }
  }

  /** Update config */
  configure(updates: Partial<StaleContextConfig>): void {
    this.config = { ...this.config, ...updates };
  }
}
