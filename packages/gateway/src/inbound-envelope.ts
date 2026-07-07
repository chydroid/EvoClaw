/**
 * Inbound Envelope — standardizes incoming messages from all channels into
 * a uniform envelope format. This is the single entry point for message
 * processing regardless of source (WhatsApp, Telegram, Discord, etc.).
 *
 * Responsibilities:
 *  - Normalize channel-specific payloads into a common shape
 *  - Attach routing metadata (agent binding, session affinity)
 *  - Track delivery context (reply references, retry counts)
 *  - Stamp messages with origin tracing info
 *  - Filter/block based on envelope-level policies
 *
 * Design: All channel adapters produce ChannelMessage, which is then
 * wrapped in an InboundEnvelope before entering the agent pipeline.
 */

import { createHash, randomUUID } from "crypto";
import type { ChannelMessage, ChannelType } from "./channel-manager.js";

// ── Types ─────────────────────────────────────────────────

export type MessageIntent =
  | "chat"           // Conversational message
  | "command"        // Slash command (e.g., /status, /reset)
  | "action"         // Button/interactive action
  | "attachment"     // File/media share
  | "system"         // System notification
  | "heartbeat";     // Keepalive/ping

export type EnvelopePriority = "low" | "normal" | "high" | "critical";

export interface DeliveryContext {
  /** Original reply reference */
  replyRef?: string;
  /** Retry count for this delivery */
  retryCount: number;
  /** Message origin (webhook, poll, relay, etc.) */
  origin: string;
  /** Raw delivery payload for debugging */
  rawPayload?: unknown;
}

export interface RoutingHint {
  /** Target agent ID (if explicitly routed) */
  agentId?: string;
  /** Session affinity key (for sticky routing) */
  sessionKey?: string;
  /** Preferred channel for response */
  responseChannel: ChannelType;
  /** Whether this was an escalation/transfer */
  escalated: boolean;
}

export interface EnvelopeMetadata {
  /** When the envelope was created (epoch ms) */
  stampedAt: number;
  /** UUID v4 for tracing */
  traceId: string;
  /** Causality chain (previous trace IDs) */
  causalityChain: string[];
  /** Tags for categorization */
  tags: string[];
}

export interface InboundEnvelope {
  /** Unique envelope ID */
  envelopeId: string;
  /** The original channel message */
  message: ChannelMessage;
  /** Classified intent */
  intent: MessageIntent;
  /** Priority level */
  priority: EnvelopePriority;
  /** Delivery tracking context */
  delivery: DeliveryContext;
  /** Routing hints for agent dispatch */
  routing: RoutingHint;
  /** Trace & timing metadata */
  metadata: EnvelopeMetadata;
  /** Content hash for dedup */
  contentHash: string;
}

// ── Envelope Builder ──────────────────────────────────────

export interface EnvelopeOptions {
  /** Override intent detection */
  intent?: MessageIntent;
  /** Override priority */
  priority?: EnvelopePriority;
  /** Reply reference message ID */
  replyRef?: string;
  /** Retry count (0 = first delivery) */
  retryCount?: number;
  /** Origin label */
  origin?: string;
  /** Target agent ID */
  agentId?: string;
  /** Session key for sticky routing */
  sessionKey?: string;
  /** Tags */
  tags?: string[];
  /** Previous trace IDs */
  causalityChain?: string[];
}

const DEFAULT_OPTIONS: Required<EnvelopeOptions> = {
  intent: "chat",
  priority: "normal",
  replyRef: "",
  retryCount: 0,
  origin: "direct",
  agentId: "",
  sessionKey: "",
  tags: [] as string[],
  causalityChain: [] as string[],
};

// ── Intent Detection ──────────────────────────────────────

const COMMAND_PREFIXES = ["/", "!", "."];

function detectIntent(msg: ChannelMessage): MessageIntent {
  if (msg.attachments && msg.attachments.length > 0 && !msg.text) {
    return "attachment";
  }

  const text = msg.text.trim();
  if (COMMAND_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    return "command";
  }

  return "chat";
}

function detectPriority(msg: ChannelMessage): EnvelopePriority {
  const text = msg.text.toLowerCase();
  if (text.includes("urgent") || text.includes("紧急") || text.includes("!!!!!")) {
    return "high";
  }
  if (text.includes("critical") || text.includes("严重") || text.includes("⚠️")) {
    return "critical";
  }
  return "normal";
}

function computeContentHash(msg: ChannelMessage): string {
  const normalized = `${msg.text}|${msg.channel}|${msg.from}|${msg.timestamp}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

// ── Factory ───────────────────────────────────────────────

export function createInboundEnvelope(
  message: ChannelMessage,
  options: EnvelopeOptions = {},
): InboundEnvelope {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const intent = opts.intent !== "chat" || options.intent
    ? opts.intent
    : detectIntent(message);

  const priority = options.priority || detectPriority(message);

  return {
    envelopeId: randomUUID(),
    message,
    intent,
    priority,
    delivery: {
      replyRef: opts.replyRef || message.replyTo,
      retryCount: opts.retryCount,
      origin: opts.origin,
      rawPayload: message.raw,
    },
    routing: {
      agentId: opts.agentId,
      sessionKey: opts.sessionKey || `${message.channel}:${message.from}`,
      responseChannel: message.channel,
      escalated: false,
    },
    metadata: {
      stampedAt: Date.now(),
      traceId: randomUUID(),
      causalityChain: opts.causalityChain,
      tags: opts.tags,
    },
    contentHash: computeContentHash(message),
  };
}

// ── Filtering ─────────────────────────────────────────────

export interface EnvelopeFilter {
  /** Block specific channels */
  blockedChannels?: ChannelType[];
  /** Block specific senders */
  blockedSenders?: string[];
  /** Only allow specific intents */
  allowedIntents?: MessageIntent[];
  /** Max retry count before drop */
  maxRetries?: number;
  /** Require minimum text length */
  minTextLength?: number;
}

export function filterEnvelope(
  envelope: InboundEnvelope,
  filter: EnvelopeFilter,
): { allowed: boolean; reason?: string } {
  if (filter.blockedChannels?.includes(envelope.message.channel)) {
    return { allowed: false, reason: `Blocked channel: ${envelope.message.channel}` };
  }

  if (filter.blockedSenders?.includes(envelope.message.from)) {
    return { allowed: false, reason: `Blocked sender: ${envelope.message.from}` };
  }

  if (filter.allowedIntents && !filter.allowedIntents.includes(envelope.intent)) {
    return { allowed: false, reason: `Disallowed intent: ${envelope.intent}` };
  }

  if (
    filter.maxRetries !== undefined &&
    envelope.delivery.retryCount > filter.maxRetries
  ) {
    return { allowed: false, reason: `Max retries exceeded (${envelope.delivery.retryCount} > ${filter.maxRetries})` };
  }

  if (
    filter.minTextLength !== undefined &&
    envelope.message.text.length < filter.minTextLength
  ) {
    return {
      allowed: false,
      reason: `Text too short (${envelope.message.text.length} < ${filter.minTextLength})`,
    };
  }

  return { allowed: true };
}

// ── Serialization ─────────────────────────────────────────

export function serializeEnvelope(envelope: InboundEnvelope): string {
  return JSON.stringify(envelope);
}

export function deserializeEnvelope(json: string): InboundEnvelope | null {
  try {
    return JSON.parse(json) as InboundEnvelope;
  } catch (err) {
    process.stderr.write('[InboundEnvelope] deserializeEnvelope failed: ' + err + '\n');
    return null;
  }
}

// ── Utilities ─────────────────────────────────────────────

export function bumpRetry(envelope: InboundEnvelope): InboundEnvelope {
  return {
    ...envelope,
    envelopeId: randomUUID(),
    delivery: {
      ...envelope.delivery,
      retryCount: envelope.delivery.retryCount + 1,
    },
    metadata: {
      ...envelope.metadata,
      stampedAt: Date.now(),
      traceId: randomUUID(),
      causalityChain: [
        ...envelope.metadata.causalityChain,
        envelope.metadata.traceId,
      ],
    },
  };
}

export function withRoutingHint(
  envelope: InboundEnvelope,
  hint: Partial<RoutingHint>,
): InboundEnvelope {
  return {
    ...envelope,
    routing: { ...envelope.routing, ...hint },
  };
}

export function withAgentBinding(
  envelope: InboundEnvelope,
  agentId: string,
): InboundEnvelope {
  return withRoutingHint(envelope, { agentId });
}

export function tagEnvelope(
  envelope: InboundEnvelope,
  ...tags: string[]
): InboundEnvelope {
  return {
    ...envelope,
    metadata: {
      ...envelope.metadata,
      tags: [...new Set([...envelope.metadata.tags, ...tags])],
    },
  };
}