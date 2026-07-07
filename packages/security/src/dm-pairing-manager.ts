/**
 * DM Pairing Manager — OpenClaw-style DM security pairing flow.
 *
 * When a new/unknown sender messages the agent, they receive a pairing code
 * instead of a full response. The operator must approve the sender via
 * `pairing approve <channel> <code>` before the agent processes messages
 * from that sender.
 *
 * Supports three DM policies per channel:
 * - "open": all DMs are processed (no pairing required)
 * - "pairing": unknown senders must pair first (default)
 * - "allowlist": only pre-approved senders are processed
 */

import { EventBus, SystemEvents } from "@evoclaw/core";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DMPolicy = "open" | "pairing" | "allowlist";

export interface PairingRequest {
  /** Unique pairing code (6-digit numeric) */
  code: string;
  /** Channel name (telegram, discord, whatsapp, webchat, etc.) */
  channel: string;
  /** Sender identifier (phone number, user ID, etc.) */
  peerId: string;
  /** Optional: sender display name */
  peerName?: string;
  /** When the request was created */
  createdAt: Date;
  /** When the request expires */
  expiresAt: Date;
  /** Whether the request has been approved */
  approved: boolean;
  /** Who approved it */
  approvedBy?: string;
}

export interface DMPolicyConfig {
  /** Channel name */
  channel: string;
  /** DM policy for this channel */
  policy: DMPolicy;
  /** Allowlist of pre-approved peer IDs (when policy is "allowlist") */
  allowlist?: string[];
  /** Pairing code expiration in minutes (default: 10) */
  pairingExpiryMinutes?: number;
}

export interface DMCheckResult {
  /** Whether the message should be processed */
  allowed: boolean;
  /** If not allowed, the reason */
  reason?: string;
  /** If pairing is required, the pairing code to show to the user */
  pairingCode?: string;
  /** If pairing is required, the message to send back */
  pairingMessage?: string;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_EXPIRY_MINUTES = 10;
const DEFAULT_PAIRING_MESSAGE = (code: string) =>
  `Please ask the operator to approve this chat with:\n\n` +
  `  pairing approve {channel} ${code}\n\n` +
  `This code expires in ${DEFAULT_EXPIRY_MINUTES} minutes.`;

// ─── DM Pairing Manager ───────────────────────────────────────────────────────

export class DMPairingManager {
  private channelPolicies = new Map<string, DMPolicyConfig>();
  private pendingPairings = new Map<string, PairingRequest>(); // code → request
  private approvedPeers = new Map<string, Set<string>>(); // channel → Set<peerId>
  private pairingStorePath: string;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  /** approve() 调用次数追踪：防止 6 位配对码被暴力枚举。
   *  key = "channel:peerId"（per-source 限流），value = { count, firstAttemptAt, lockedUntil } */
  private approveAttempts = new Map<string, { count: number; firstAttemptAt: Date; lockedUntil: Date | null }>();
  private static MAX_APPROVE_ATTEMPTS = 5;
  private static APPROVE_LOCKOUT_MS = 5 * 60 * 1000; // 5 分钟锁定
  private static APPROVE_WINDOW_MS = 10 * 60 * 1000; // 10 分钟窗口

  constructor(
    private eventBus: EventBus,
    config?: {
      channelPolicies?: DMPolicyConfig[];
      pairingStorePath?: string;
    }
  ) {
    this.pairingStorePath = config?.pairingStorePath || path.resolve("data", "pairing-store.json");
    this.loadApprovedPeers();

    if (config?.channelPolicies) {
      for (const cp of config.channelPolicies) {
        this.channelPolicies.set(cp.channel, cp);
      }
    }

    // Periodic cleanup of expired pairing requests
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000);
    this.cleanupTimer.unref?.();
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  // ── Configuration ──

  /** Set DM policy for a channel */
  setChannelPolicy(config: DMPolicyConfig): void {
    this.channelPolicies.set(config.channel, config);

    // Initialize allowlist
    if (config.policy === "allowlist" && config.allowlist) {
      if (!this.approvedPeers.has(config.channel)) {
        this.approvedPeers.set(config.channel, new Set());
      }
      const set = this.approvedPeers.get(config.channel)!;
      for (const peer of config.allowlist) {
        set.add(peer);
      }
      this.persistApprovedPeers();
    }
  }

  /** Get DM policy for a channel */
  getChannelPolicy(channel: string): DMPolicy {
    return this.channelPolicies.get(channel)?.policy || "pairing";
  }

  // ── DM Check ──

  /**
   * Check if a message from a given peer should be processed.
   * Returns a DMCheckResult indicating whether to allow, block, or require pairing.
   */
  checkDM(params: {
    channel: string;
    peerId: string;
    peerName?: string;
  }): DMCheckResult {
    const { channel, peerId, peerName } = params;
    const policyConfig = this.channelPolicies.get(channel);
    const policy = policyConfig?.policy || "pairing";

    switch (policy) {
      case "open":
        return { allowed: true };

      case "allowlist": {
        const approved = this.approvedPeers.get(channel);
        if (approved?.has(peerId)) {
          return { allowed: true };
        }
        return {
          allowed: false,
          reason: "sender_not_in_allowlist",
          pairingMessage: "You are not authorized to interact with this agent.",
        };
      }

      case "pairing":
      default: {
        // Check if already approved
        const approved = this.approvedPeers.get(channel);
        if (approved?.has(peerId)) {
          return { allowed: true };
        }

        // Check if there's already a pending pairing for this peer
        for (const [code, req] of this.pendingPairings) {
          if (req.channel === channel && req.peerId === peerId && !req.approved) {
            if (new Date() > req.expiresAt) {
              // Expired, will create a new one below
              this.pendingPairings.delete(code);
              break;
            }
            return {
              allowed: false,
              reason: "pairing_required",
              pairingCode: code,
              pairingMessage: DEFAULT_PAIRING_MESSAGE(code).replace("{channel}", channel),
            };
          }
        }

        // Create new pairing request
        const code = this.generatePairingCode();
        const now = new Date();
        const expiryMinutes = policyConfig?.pairingExpiryMinutes || DEFAULT_EXPIRY_MINUTES;

        const request: PairingRequest = {
          code,
          channel,
          peerId,
          peerName,
          createdAt: now,
          expiresAt: new Date(now.getTime() + expiryMinutes * 60_000),
          approved: false,
        };

        this.pendingPairings.set(code, request);

        this.eventBus.publish(SystemEvents.SECURITY_ALERT, {
          type: "dm_pairing_request",
          channel,
          peerId,
          peerName,
          code,
        }, "dm-pairing-manager").catch(() => {});

        return {
          allowed: false,
          reason: "pairing_required",
          pairingCode: code,
          pairingMessage: DEFAULT_PAIRING_MESSAGE(code).replace("{channel}", channel),
        };
      }
    }
  }

  // ── Pairing Approval ──

  /**
   * Approve a pairing request by code.
   * Returns the peer info if successful, or null if code not found/expired.
   * 包含速率限制：6 位配对码空间仅 10^6，无限尝试可被暴力枚举。
   * 每个 source（channel:peerId）在 10 分钟窗口内最多 5 次失败尝试，
   * 超出后锁定 5 分钟。
   */
  approve(code: string, approvedBy?: string): { channel: string; peerId: string; peerName?: string } | null {
    // 速率限制检查（approvedBy 作为 source 标识）
    const sourceKey = approvedBy || "anonymous";
    const now = new Date();
    const attempt = this.approveAttempts.get(sourceKey);

    if (attempt?.lockedUntil && now < attempt.lockedUntil) {
      this.eventBus.publish(SystemEvents.SECURITY_ALERT, {
        type: "dm_pairing_locked",
        source: sourceKey,
        lockedUntil: attempt.lockedUntil,
      }, "dm-pairing-manager").catch(() => {});
      return null; // 锁定中，直接拒绝
    }

    const request = this.pendingPairings.get(code);
    if (!request) {
      // 记录失败尝试
      this.recordApproveFailure(sourceKey, now);
      return null;
    }

    if (new Date() > request.expiresAt) {
      this.pendingPairings.delete(code);
      this.recordApproveFailure(sourceKey, now);
      return null;
    }

    request.approved = true;
    request.approvedBy = approvedBy;

    // Add to approved peers
    if (!this.approvedPeers.has(request.channel)) {
      this.approvedPeers.set(request.channel, new Set());
    }
    this.approvedPeers.get(request.channel)!.add(request.peerId);

    // Remove from pending
    this.pendingPairings.delete(code);

    // 成功后清除失败计数
    this.approveAttempts.delete(sourceKey);

    // Persist
    this.persistApprovedPeers();

    this.eventBus.publish(SystemEvents.SECURITY_ALERT, {
      type: "dm_pairing_approved",
      channel: request.channel,
      peerId: request.peerId,
      peerName: request.peerName,
      approvedBy,
    }, "dm-pairing-manager").catch(() => {});

    return {
      channel: request.channel,
      peerId: request.peerId,
      peerName: request.peerName,
    };
  }

  /** 记录 approve 失败并在超限时锁定 */
  private recordApproveFailure(sourceKey: string, now: Date): void {
    let attempt = this.approveAttempts.get(sourceKey);
    if (!attempt) {
      attempt = { count: 0, firstAttemptAt: now, lockedUntil: null };
      this.approveAttempts.set(sourceKey, attempt);
    }

    // 窗口过期则重置
    if (now.getTime() - attempt.firstAttemptAt.getTime() > DMPairingManager.APPROVE_WINDOW_MS) {
      attempt.count = 0;
      attempt.firstAttemptAt = now;
      attempt.lockedUntil = null;
    }

    attempt.count++;

    if (attempt.count >= DMPairingManager.MAX_APPROVE_ATTEMPTS) {
      attempt.lockedUntil = new Date(now.getTime() + DMPairingManager.APPROVE_LOCKOUT_MS);
      this.eventBus.publish(SystemEvents.SECURITY_ALERT, {
        type: "dm_pairing_rate_limit_exceeded",
        source: sourceKey,
        attempts: attempt.count,
        lockedUntil: attempt.lockedUntil,
      }, "dm-pairing-manager").catch(() => {});
    }
  }

  /** Deny/revoke a pairing request */
  deny(code: string): boolean {
    const request = this.pendingPairings.get(code);
    if (!request) return false;
    this.pendingPairings.delete(code);
    return true;
  }

  // ── Peer Management ──

  /** Manually add a peer to the approved list */
  addApprovedPeer(channel: string, peerId: string): void {
    if (!this.approvedPeers.has(channel)) {
      this.approvedPeers.set(channel, new Set());
    }
    this.approvedPeers.get(channel)!.add(peerId);
    this.persistApprovedPeers();
  }

  /** Remove a peer from the approved list */
  removeApprovedPeer(channel: string, peerId: string): boolean {
    const set = this.approvedPeers.get(channel);
    if (!set) return false;
    const removed = set.delete(peerId);
    if (removed) this.persistApprovedPeers();
    return removed;
  }

  /** Check if a specific peer is approved */
  isApproved(channel: string, peerId: string): boolean {
    return this.approvedPeers.get(channel)?.has(peerId) || false;
  }

  /** List all approved peers */
  listApprovedPeers(channel?: string): Array<{ channel: string; peerId: string }> {
    const result: Array<{ channel: string; peerId: string }> = [];
    for (const [ch, peers] of this.approvedPeers) {
      if (channel && ch !== channel) continue;
      for (const peer of peers) {
        result.push({ channel: ch, peerId: peer });
      }
    }
    return result;
  }

  /** List all pending pairing requests */
  listPendingPairings(): PairingRequest[] {
    return [...this.pendingPairings.values()]
      .filter((r) => !r.approved && new Date() <= r.expiresAt)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  // ── Internal ──

  private generatePairingCode(): string {
    // 6-digit numeric code
    const buf = crypto.randomBytes(4);
    const num = buf.readUInt32BE(0) % 1_000_000;
    return String(num).padStart(6, "0");
  }

  private cleanupExpired(): void {
    const now = new Date();
    for (const [code, request] of this.pendingPairings) {
      if (now > request.expiresAt) {
        this.pendingPairings.delete(code);
      }
    }
  }

  // ── Persistence ──

  private persistApprovedPeers(): void {
    try {
      const dir = path.dirname(this.pairingStorePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data: Record<string, string[]> = {};
      for (const [channel, peers] of this.approvedPeers) {
        data[channel] = [...peers];
      }
      // BUG 20.3 fix: 使用原子写入（temp + fsync + rename）替代 writeFileSync，
      // 防止进程崩溃或并发写入导致 pairing store 损坏。
      const tmpPath = `${this.pairingStorePath}.${process.pid}.${Date.now()}.tmp`;
      const fd = fs.openSync(tmpPath, "w");
      try {
        fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.renameSync(tmpPath, this.pairingStorePath);
      } catch {
        const dstTmp = `${this.pairingStorePath}.${process.pid}.${Date.now()}.dst.tmp`;
        try {
          fs.copyFileSync(tmpPath, dstTmp);
          fs.renameSync(dstTmp, this.pairingStorePath);
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        } catch (fallbackErr) {
          try { fs.unlinkSync(dstTmp); } catch { /* ignore */ }
          throw fallbackErr;
        }
      }
    } catch (err) {
      process.stderr.write(`[DMPairingManager] Failed to persist approved peers: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  private loadApprovedPeers(): void {
    try {
      if (fs.existsSync(this.pairingStorePath)) {
        const raw = fs.readFileSync(this.pairingStorePath, "utf-8");
        const data = JSON.parse(raw) as Record<string, string[]>;
        for (const [channel, peers] of Object.entries(data)) {
          this.approvedPeers.set(channel, new Set(peers));
        }
      }
    } catch {
      // Start fresh on load error
    }
  }
}