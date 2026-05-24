/**
 * Channel SDK — standardized interface for messaging channel plugins.
 * 
 * Channels enable EvoClaw to connect to messaging platforms like
 * Telegram, WhatsApp, Discord, Slack, etc.
 */

import type { PluginManifest, PluginLogger, ServiceLocator } from "./types.js";

// ── Message Types ────────────────────────────────────────
export interface ChannelMessage {
  /** Unique message ID from the platform */
  id: string;
  /** Message text content */
  text: string;
  /** Sender identifier (platform-specific) */
  from: string;
  /** Recipient or chat identifier */
  to: string;
  /** Channel identifier */
  channel: string;
  /** Unix timestamp in ms */
  timestamp: number;
  /** Optional reply target message ID */
  replyTo?: string;
  /** Media attachments */
  media?: ChannelMedia[];
  /** Platform-specific raw data */
  raw?: unknown;
}

export interface ChannelMedia {
  /** Media type */
  type: "image" | "video" | "audio" | "document" | "sticker" | "location";
  /** URL or local path */
  url: string;
  /** Optional filename */
  filename?: string;
  /** Optional MIME type */
  mimeType?: string;
  /** Optional file size in bytes */
  size?: number;
}

export interface ChannelSendOptions {
  /** Target chat/peer identifier */
  to: string;
  /** Message text */
  text: string;
  /** Optional reply-to message ID */
  replyTo?: string;
  /** Optional media attachments */
  media?: ChannelMedia[];
  /** Platform-specific options */
  options?: Record<string, unknown>;
}

export interface ChannelInfo {
  /** Channel type identifier */
  type: string;
  /** Whether the channel is connected */
  connected: boolean;
  /** Channel capabilities */
  capabilities: ChannelCapabilities;
  /** Account/instance info */
  account?: string;
}

export interface ChannelCapabilities {
  /** Supports text messages */
  text: boolean;
  /** Supports image media */
  image: boolean;
  /** Supports video media */
  video: boolean;
  /** Supports audio media */
  audio: boolean;
  /** Supports document media */
  document: boolean;
  /** Supports reactions */
  reactions: boolean;
  /** Supports reply threads */
  threads: boolean;
  /** Supports group chats */
  groups: boolean;
  /** Supports inline keyboards/buttons */
  interactive: boolean;
  /** Maximum message length */
  maxMessageLength: number;
  /** Maximum file size in bytes */
  maxFileSize?: number;
}

// ── Channel Plugin Interface ─────────────────────────────
export interface ChannelPlugin {
  /** Channel type identifier (e.g., "telegram", "whatsapp") */
  readonly type: string;

  /** Initialize the channel */
  init(config: ChannelConfig, logger: PluginLogger, services: ServiceLocator): Promise<void>;

  /** Connect to the messaging platform */
  connect(): Promise<void>;

  /** Disconnect from the messaging platform */
  disconnect(): Promise<void>;

  /** Send a message */
  send(opts: ChannelSendOptions): Promise<{ id: string }>;

  /** Get channel info */
  getInfo(): Promise<ChannelInfo>;

  /** Check connection status */
  isConnected(): boolean;

  /** Register a message handler */
  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void;

  /** Get channel config schema for validation */
  getConfigSchema?(): Record<string, unknown>;

  /** Health check */
  healthCheck?(): Promise<{ healthy: boolean; message?: string }>;
}

// ── Channel Configuration ────────────────────────────────
export interface ChannelConfig {
  /** Whether the channel is enabled */
  enabled: boolean;
  /** DM access policy */
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  /** Allowlist of sender IDs */
  allowFrom?: string[];
  /** Group access policy */
  groupPolicy?: "open" | "allowlist" | "disabled";
  /** Group allowlist */
  groupAllowFrom?: string[];
  /** Require mention in groups */
  requireMention?: boolean;
  /** Platform-specific config */
  platform?: Record<string, unknown>;
}

// ── Channel Registry ─────────────────────────────────────
export interface ChannelRegistry {
  /** Register a channel plugin */
  register(plugin: ChannelPlugin): void;
  /** Unregister a channel plugin */
  unregister(type: string): void;
  /** Get a registered channel */
  get(type: string): ChannelPlugin | undefined;
  /** List all registered channels */
  list(): string[];
  /** Get info for all channels */
  listInfo(): Promise<ChannelInfo[]>;
}