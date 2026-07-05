/**
 * Reply Reference — tracks reply chains across messages for
 * threaded conversations with full context chain retrieval.
 *
 * Enables:
 *  - Reply tree construction (parent → children mapping)
 *  - Context chain retrieval (all ancestors of a message)
 *  - Quote/mention detection from message text
 *  - Reply threading across channels (cross-channel references)
 *  - Depth limiting to prevent infinite chains
 *  - Automatic root message detection
 *
 * Works alongside the message lifecycle and inbound envelope
 * systems to provide complete message context for the agent.
 */

import { createHash } from "crypto";
import type { ChannelMessage } from "./channel-manager.js";

// ── Types ─────────────────────────────────────────────────

export interface ReplyRef {
  /** Unique reply chain ID */
  chainId: string;
  /** The message ID being replied to */
  parentId: string;
  /** The reply message ID */
  childId: string;
  /** Depth in the reply chain (0 = root, increments per reply) */
  depth: number;
  /** When the reply was recorded */
  timestamp: number;
  /** Channel the reply occurred on */
  channel: string;
  /** Peer/target of the reply */
  peer?: string;
  /** Whether this reply spans channels */
  crossChannel: boolean;
}

export interface ReplyChainContext {
  /** The root message ID */
  rootId: string;
  /** All messages in the chain from root to leaf, in order */
  chain: ReplyRef[];
  /** Maximum depth in this chain */
  maxDepth: number;
  /** Channel of the root message */
  channel: string;
  /** Total messages in chain */
  totalMessages: number;
}

export interface ReplyNode {
  /** Message ID */
  messageId: string;
  /** Direct parent (null if root) */
  parentId: string | null;
  /** Direct children */
  children: string[];
  /** Depth from root */
  depth: number;
  /** Channel */
  channel: string;
  /** Peer/target */
  peer?: string;
  /** Timestamp */
  timestamp: number;
}

export interface ReplyTree {
  /** Root node ID */
  rootId: string;
  /** All nodes indexed by messageId */
  nodes: Map<string, ReplyNode>;
  /** Tree depth */
  depth: number;
  /** Total nodes */
  size: number;
}

export interface ReplyReferenceConfig {
  /** Maximum depth for a reply chain */
  maxDepth: number;
  /** Maximum chain size (total messages in one chain) */
  maxChainSize: number;
  /** TTL for reply references in ms (0 = never expire) */
  ttlMs: number;
  /** Whether to auto-clean expired references */
  autoClean: boolean;
  /** Clean interval in ms */
  cleanIntervalMs: number;
}

export interface MentionInfo {
  /** The type of mention detected */
  type: "quote" | "reply_id" | "reply_to" | "from_metadata" | "none";
  /** The referenced message ID, if detected */
  referencedId?: string;
  /** The matched text fragment */
  fragment?: string;
  /** Confidence level 0-1 */
  confidence: number;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: ReplyReferenceConfig = {
  maxDepth: 50,
  maxChainSize: 500,
  ttlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  autoClean: false,
  cleanIntervalMs: 60_000,
};

// ── Manager ───────────────────────────────────────────────

export class ReplyReferenceManager {
  private config: ReplyReferenceConfig;
  private refs = new Map<string, ReplyRef>(); // childId → ReplyRef
  private chains = new Map<string, Set<string>>(); // rootId → Set<childId>
  private cleanTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<ReplyReferenceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.autoClean) {
      this.cleanTimer = setInterval(() => this.clean(), this.config.cleanIntervalMs);
      this.cleanTimer.unref?.();
    }
  }

  // ── Recording ───────────────────────────────────────────

  /**
   * Record a reply relationship between two messages.
   */
  record(
    parentId: string,
    childId: string,
    opts?: {
      channel?: string;
      peer?: string;
      crossChannel?: boolean;
    },
  ): ReplyRef | null {
    // Prevent self-replies
    if (parentId === childId) return null;

    // Check if this would exceed max depth
    const parentDepth = this.getDepth(parentId);
    if (parentDepth >= this.config.maxDepth) return null;

    // Check chain size
    const rootId = this.getRootId(parentId) ?? parentId;
    const chain = this.chains.get(rootId);
    if (chain && chain.size >= this.config.maxChainSize) return null;

    const ref: ReplyRef = {
      chainId: rootId,
      parentId,
      childId,
      depth: parentDepth + 1,
      timestamp: Date.now(),
      channel: opts?.channel ?? "unknown",
      peer: opts?.peer,
      crossChannel: opts?.crossChannel ?? false,
    };

    this.refs.set(childId, ref);

    // Update chain membership
    if (!this.chains.has(rootId)) {
      this.chains.set(rootId, new Set());
    }
    // Register parent in chain too if not already there
    if (!this.refs.has(parentId)) {
      this.chains.get(rootId)!.add(parentId);
    }
    this.chains.get(rootId)!.add(childId);

    return ref;
  }

  /**
   * Record a reply from a ChannelMessage (uses reply metadata if available).
   */
  recordFromMessage(
    parentMessage: ChannelMessage,
    childMessage: ChannelMessage,
  ): ReplyRef | null {
    return this.record(parentMessage.messageId ?? `msg_${Date.now()}`, childMessage.messageId ?? `msg_${Date.now() + 1}`, {
      channel: childMessage.channel,
      peer: parentMessage.from,
      crossChannel: parentMessage.channel !== childMessage.channel,
    });
  }

  // ── Retrieval ───────────────────────────────────────────

  /**
   * Get the parent message ID for a given message.
   */
  getParent(childId: string): string | null {
    const ref = this.refs.get(childId);
    return ref?.parentId ?? null;
  }

  /**
   * Get all children of a message.
   */
  getChildren(parentId: string): string[] {
    const children: string[] = [];
    for (const [childId, ref] of this.refs) {
      if (ref.parentId === parentId) {
        children.push(childId);
      }
    }
    return children;
  }

  /**
   * Get the depth of a message in its reply chain.
   * Root messages have depth 0.
   */
  getDepth(messageId: string): number {
    const ref = this.refs.get(messageId);
    return ref?.depth ?? 0;
  }

  /**
   * Get the root message ID of the chain this message belongs to.
   */
  getRootId(messageId: string): string | null {
    let current = messageId;
    const visited = new Set<string>();
    let iterations = 0;

    while (iterations < this.config.maxDepth) {
      if (visited.has(current)) return current; // Cycle detected
      visited.add(current);
      const ref = this.refs.get(current);
      if (!ref) return current; // Reached root
      current = ref.parentId;
      iterations++;
    }

    return current;
  }

  /**
   * Get the full reply chain context from a message to its root.
   * Returns ancestors in order: [root, ..., parent, message].
   */
  getChainContext(messageId: string): ReplyChainContext {
    const rootId = this.getRootId(messageId) ?? messageId;

    // Walk from root to leaf
    const chain: ReplyRef[] = [];
    const visited = new Set<string>();
    let current: string | null = rootId;

    while (current && !visited.has(current) && chain.length < this.config.maxChainSize) {
      visited.add(current);

      const ref = this.refs.get(current);
      if (ref) {
        chain.push(ref);
      }

      if (current === messageId) break;

      // Find the child that leads toward the target
      const children = this.getChildren(current);
      if (children.length === 0) break;

      // 在 children 中找通往目标的分支；找不到时停止遍历，避免沿不通往目标的 children[0] 走偏
      let next: string | null = null;
      for (const child of children) {
        if (child === messageId || this.isAncestor(child, messageId)) {
          next = child;
          break;
        }
      }
      if (next === null) break;
      current = next;
    }

    return {
      rootId,
      chain,
      maxDepth: chain.length > 0 ? Math.max(...chain.map((r) => r.depth)) : 0,
      channel: chain.length > 0 ? chain[0].channel : "unknown",
      totalMessages: chain.length,
    };
  }

  /**
   * Get the reply tree for a chain, starting from a root.
   */
  getReplyTree(rootId: string): ReplyTree {
    const nodes = new Map<string, ReplyNode>();
    const chain = this.chains.get(rootId);

    if (!chain) {
      return { rootId, nodes, depth: 0, size: 0 };
    }

    for (const msgId of chain) {
      const ref = this.refs.get(msgId);
      nodes.set(msgId, {
        messageId: msgId,
        parentId: ref?.parentId ?? null,
        children: this.getChildren(msgId),
        depth: ref?.depth ?? 0,
        channel: ref?.channel ?? "unknown",
        peer: ref?.peer,
        timestamp: ref?.timestamp ?? 0,
      });
    }

    const maxDepth = nodes.size > 0
      ? Math.max(...[...nodes.values()].map((n) => n.depth))
      : 0;

    return { rootId, nodes, depth: maxDepth, size: nodes.size };
  }

  /**
   * Get the reference for a specific message.
   */
  getRef(messageId: string): ReplyRef | null {
    return this.refs.get(messageId) ?? null;
  }

  // ── Detection ───────────────────────────────────────────

  /**
   * Detect reply references from message text content.
   * Scans for patterns like "> original text" (quote), "replying to <id>", etc.
   */
  detectMention(text: string): MentionInfo {
    // Check for quote pattern: line starting with "> "
    const quoteMatch = text.match(/^>\s+(.*)/m);
    if (quoteMatch) {
      return { type: "quote", fragment: quoteMatch[1], confidence: 0.7 };
    }

    // Check for explicit reply ID references
    const replyIdMatch = text.match(/(?:reply[_\s]?(?:to|id)|in[_\s]?reply[_\s]?to)[:\s]+([a-zA-Z0-9_-]+)/i);
    if (replyIdMatch) {
      return {
        type: "reply_id",
        referencedId: replyIdMatch[1],
        fragment: replyIdMatch[0],
        confidence: 0.9,
      };
    }

    // Check for "replying to X" pattern
    const replyToMatch = text.match(/replying\s+to\s+([a-zA-Z0-9_-]+)/i);
    if (replyToMatch) {
      return {
        type: "reply_to",
        referencedId: replyToMatch[1],
        fragment: replyToMatch[0],
        confidence: 0.8,
      };
    }

    return { type: "none", confidence: 0 };
  }

  /**
   * Extract mention info from a ChannelMessage's metadata.
   */
  detectMentionFromMessage(msg: ChannelMessage): MentionInfo {
    // Check metadata field first
    if ((msg as any).metadata?.replyTo) {
      return {
        type: "from_metadata",
        referencedId: (msg as any).metadata.replyTo,
        confidence: 1.0,
      };
    }

    // Check text content
    if (msg.text) {
      return this.detectMention(msg.text);
    }

    return { type: "none", confidence: 0 };
  }

  // ── Management ──────────────────────────────────────────

  /**
   * Check if one message is an ancestor of another.
   */
  isAncestor(ancestorId: string, descendantId: string): boolean {
    let current: string | null = descendantId;
    let iterations = 0;

    while (current && iterations < this.config.maxDepth) {
      if (current === ancestorId) return true;
      const ref = this.refs.get(current);
      current = ref?.parentId ?? null;
      iterations++;
    }

    return false;
  }

  /**
   * Count total reply references.
   */
  countRefs(): number {
    return this.refs.size;
  }

  /**
   * Count distinct chains.
   */
  countChains(): number {
    return this.chains.size;
  }

  /**
   * Remove all references for a chain.
   */
  removeChain(rootId: string): number {
    const chain = this.chains.get(rootId);
    if (!chain) return 0;

    let removed = 0;
    for (const id of chain) {
      this.refs.delete(id);
      removed++;
    }
    this.chains.delete(rootId);
    return removed;
  }

  /**
   * Remove references older than the TTL.
   */
  clean(): number {
    if (this.config.ttlMs <= 0) return 0;

    const cutoff = Date.now() - this.config.ttlMs;
    let removed = 0;

    for (const [id, ref] of this.refs) {
      if (ref.timestamp < cutoff) {
        this.refs.delete(id);
        removed++;
      }
    }

    // Clean up empty chains
    for (const [rootId, chain] of this.chains) {
      const remaining = new Set([...chain].filter((id) => this.refs.has(id)));
      if (remaining.size === 0) {
        this.chains.delete(rootId);
      } else {
        this.chains.set(rootId, remaining);
      }
    }

    return removed;
  }

  /**
   * Clear all reply references.
   */
  clear(): void {
    this.refs.clear();
    this.chains.clear();
  }

  /**
   * Dispose the manager (stop clean timer).
   */
  dispose(): void {
    if (this.cleanTimer) {
      clearInterval(this.cleanTimer);
      this.cleanTimer = null;
    }
    this.clear();
  }

  configure(updates: Partial<ReplyReferenceConfig>): void {
    this.config = { ...this.config, ...updates };
  }
}