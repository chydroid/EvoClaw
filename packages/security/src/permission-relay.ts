/**
 * Permission Relay — OpenClaw ACP compatibility layer.
 *
 * Centralized permission relay that intermediates between tool execution
 * and permission approval. All tool call permission requests flow through
 * this relay, which:
 *
 *   - Maintains a queue of pending permission requests
 *   - Supports auto-approve for whitelisted tools/patterns
 *   - Supports auto-deny for blacklisted tools/patterns
 *   - Implements timeouts for pending requests
 *   - Relays decisions to the requesting agent
 *   - Persists approval history for audit
 *
 * This is the ACP permission-relay pattern from OpenClaw — a single
 * point of control for all tool access decisions.
 */
import type { EventBus } from "@evoclaw/core";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export type PermissionDecision = "approved" | "denied" | "pending" | "timed_out";

export interface PermissionRequest {
  id: string;
  agentId: string;
  sessionId: string;
  toolName: string;
  description: string;
  params: Record<string, unknown>;
  category: "file" | "shell" | "web" | "browser" | "email" | "skill" | "other";
  createdAt: number;
  timeoutMs: number;
  status: PermissionDecision;
  decidedAt?: number;
  decidedBy?: string;
  reason?: string;
}

export interface PermissionRelayConfig {
  /** Auto-approve tools matching these patterns (glob) */
  autoApprovePatterns?: string[];
  /** Auto-deny tools matching these patterns (glob) */
  autoDenyPatterns?: string[];
  /** Default timeout for permission requests in ms */
  defaultTimeoutMs?: number;
  /** Max concurrent pending requests */
  maxPending?: number;
}

// ──────────────────────────────────────────────────────────────
// PermissionRelay
// ──────────────────────────────────────────────────────────────

export class PermissionRelay {
  private pending = new Map<string, PermissionRequest>();
  private history: PermissionRequest[] = [];
  private autoApprove: string[];
  private autoDeny: string[];
  private defaultTimeoutMs: number;
  private maxPending: number;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    config: PermissionRelayConfig = {},
    private eventBus?: EventBus,
  ) {
    this.autoApprove = config.autoApprovePatterns ?? [];
    this.autoDeny = config.autoDenyPatterns ?? [];
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 30_000;
    this.maxPending = config.maxPending ?? 50;
  }

  // ── Request ──

  /**
   * Submit a permission request. Returns immediately with a decision
   * if auto-approve/auto-deny applies, or "pending" otherwise.
   */
  request(params: {
    agentId: string;
    sessionId: string;
    toolName: string;
    description: string;
    params?: Record<string, unknown>;
    category?: PermissionRequest["category"];
    timeoutMs?: number;
  }): PermissionRequest {
    const id = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;

    const req: PermissionRequest = {
      id,
      agentId: params.agentId,
      sessionId: params.sessionId,
      toolName: params.toolName,
      description: params.description,
      params: params.params ?? {},
      category: params.category ?? classifyCategory(params.toolName),
      createdAt: Date.now(),
      timeoutMs,
      status: "pending",
    };

    // Auto-approve / auto-deny
    const autoDecision = this.evaluateAuto(params.toolName);
    if (autoDecision === "approved") {
      req.status = "approved";
      req.decidedAt = Date.now();
      req.decidedBy = "auto";
      req.reason = "Auto-approved by pattern";
      this.history.push(req);
      if (this.history.length > 10000) {
        this.history = this.history.slice(-5000);
      }
      this.eventBus?.publish("permission.auto_approved", req, "permission-relay");
      return req;
    }
    if (autoDecision === "denied") {
      req.status = "denied";
      req.decidedAt = Date.now();
      req.decidedBy = "auto";
      req.reason = "Auto-denied by pattern";
      this.history.push(req);
      if (this.history.length > 10000) {
        this.history = this.history.slice(-5000);
      }
      this.eventBus?.publish("permission.auto_denied", req, "permission-relay");
      return req;
    }

    // Enforce max pending
    if (this.pending.size >= this.maxPending) {
      req.status = "denied";
      req.decidedAt = Date.now();
      req.decidedBy = "system";
      req.reason = "Too many pending requests";
      this.history.push(req);
      if (this.history.length > 10000) {
        this.history = this.history.slice(-5000);
      }
      return req;
    }

    // Queue as pending
    this.pending.set(id, req);

    // Start timeout
    const timer = setTimeout(() => {
      const existing = this.pending.get(id);
      if (existing && existing.status === "pending") {
        existing.status = "timed_out";
        existing.decidedAt = Date.now();
        existing.reason = "Request timed out";
        this.pending.delete(id);
        this.timers.delete(id);
        this.history.push(existing);
        if (this.history.length > 10000) {
          this.history = this.history.slice(-5000);
        }
        this.eventBus?.publish("permission.timed_out", existing, "permission-relay");
      }
    }, timeoutMs);
    this.timers.set(id, timer);

    this.eventBus?.publish("permission.requested", req, "permission-relay");
    return req;
  }

  // ── Decision ──

  /**
   * Approve a pending permission request.
   */
  approve(id: string, by?: string): PermissionRequest | null {
    const req = this.pending.get(id);
    if (!req || req.status !== "pending") return null;

    req.status = "approved";
    req.decidedAt = Date.now();
    req.decidedBy = by ?? "user";
    this.pending.delete(id);
    this.clearTimer(id);
    this.history.push(req);
    if (this.history.length > 10000) {
      this.history = this.history.slice(-5000);
    }

    this.eventBus?.publish("permission.approved", req, "permission-relay");
    return req;
  }

  /**
   * Deny a pending permission request.
   */
  deny(id: string, reason?: string, by?: string): PermissionRequest | null {
    const req = this.pending.get(id);
    if (!req || req.status !== "pending") return null;

    req.status = "denied";
    req.decidedAt = Date.now();
    req.decidedBy = by ?? "user";
    req.reason = reason ?? "Denied by user";
    this.pending.delete(id);
    this.clearTimer(id);
    this.history.push(req);
    if (this.history.length > 10000) {
      this.history = this.history.slice(-5000);
    }

    this.eventBus?.publish("permission.denied", req, "permission-relay");
    return req;
  }

  /**
   * Bulk-approve all pending requests for an agent.
   */
  approveAllForAgent(agentId: string): number {
    let count = 0;
    for (const [id, req] of this.pending) {
      if (req.agentId === agentId && req.status === "pending") {
        if (this.approve(id, "agent")) count++;
      }
    }
    return count;
  }

  // ── Query ──

  /**
   * Get all pending requests.
   */
  getPending(): PermissionRequest[] {
    return [...this.pending.values()].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
  }

  /**
   * Get pending count.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Get all pending requests for a specific agent.
   */
  getPendingForAgent(agentId: string): PermissionRequest[] {
    return this.getPending().filter((r) => r.agentId === agentId);
  }

  /**
   * Get recent history (most recent first).
   */
  getHistory(limit?: number): PermissionRequest[] {
    const sorted = [...this.history].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
    return limit ? sorted.slice(0, limit) : sorted;
  }

  // ── Configuration ──

  setAutoApprove(patterns: string[]): void {
    this.autoApprove = patterns;
  }

  setAutoDeny(patterns: string[]): void {
    this.autoDeny = patterns;
  }

  addAutoApprove(pattern: string): void {
    if (!this.autoApprove.includes(pattern)) {
      this.autoApprove.push(pattern);
    }
  }

  addAutoDeny(pattern: string): void {
    if (!this.autoDeny.includes(pattern)) {
      this.autoDeny.push(pattern);
    }
  }

  // ── Cleanup ──

  /**
   * Cancel all timed-out requests and clear their timers.
   */
  cleanup(): number {
    let count = 0;
    for (const [id, req] of this.pending) {
      if (req.status !== "pending") {
        this.pending.delete(id);
        this.clearTimer(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Cancel a specific pending request (without approving or denying).
   */
  cancel(id: string): boolean {
    const existed = this.pending.delete(id);
    this.clearTimer(id);
    return existed;
  }

  // ── Internals ──

  private evaluateAuto(toolName: string): PermissionDecision | null {
    for (const pattern of this.autoDeny) {
      if (globMatch(pattern, toolName)) return "denied";
    }
    for (const pattern of this.autoApprove) {
      if (globMatch(pattern, toolName)) return "approved";
    }
    return null;
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function classifyCategory(toolName: string): PermissionRequest["category"] {
  if (toolName.startsWith("file_") || toolName.startsWith("fs_")) return "file";
  if (toolName.startsWith("shell_") || toolName === "shell_exec") return "shell";
  if (toolName.startsWith("web_") || toolName.startsWith("fetch_") || toolName.startsWith("http_")) return "web";
  if (toolName.startsWith("browser_")) return "browser";
  if (toolName.startsWith("email_")) return "email";
  if (toolName.startsWith("skill_")) return "skill";
  return "other";
}

function globMatch(pattern: string, value: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
      "$",
    "i",
  );
  return regex.test(value);
}