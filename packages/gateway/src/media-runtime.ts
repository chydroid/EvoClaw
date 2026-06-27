/**
 * Media Runtime — cross-channel media handling and optimization.
 *
 * Coordinates media across all channels: validates, optimizes, and
 * routes media attachments. Works alongside the infrastructure-level
 * media-processor for detection/parsing.
 *
 * Features:
 *  - Per-channel media size/type constraints
 *  - Image resizing hints (max dimensions)
 *  - Media format validation
 *  - Attachment counting and rate limiting
 *  - Cross-channel media conversion guidance
 *  - Media store abstraction for caching
 */

import type { ChannelMessage } from "./channel-manager.js";

// ── Types ─────────────────────────────────────────────────

export interface MediaConstraint {
  /** Maximum file size in bytes */
  maxSize: number;
  /** Allowed MIME type patterns (empty = all) */
  allowedTypes: string[];
  /** Maximum image dimension (width or height) in pixels */
  maxImageDimension?: number;
  /** Maximum video duration in seconds */
  maxVideoDurationSec?: number;
  /** Maximum audio duration in seconds */
  maxAudioDurationSec?: number;
  /** Maximum attachments per message */
  maxAttachments: number;
  /** Whether stickers are supported */
  stickersAllowed: boolean;
}

export interface MediaValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Whether the attachment should be resized before sending */
  needsResize: boolean;
  /** Whether format conversion is needed */
  needsConversion: boolean;
}

export interface MediaOptimizationHint {
  /** Recommended max width */
  maxWidth?: number;
  /** Recommended max height */
  maxHeight?: number;
  /** Recommended output format (e.g., "image/jpeg") */
  targetFormat?: string;
  /** Recommended quality (0-100) */
  quality?: number;
  /** Whether to strip EXIF metadata */
  stripMetadata: boolean;
}

export interface MediaAttachment {
  type: "image" | "video" | "audio" | "document" | "sticker";
  url?: string;
  data?: Buffer;
  mimeType?: string;
  filename?: string;
  /** Size in bytes (if known) */
  size?: number;
  /** Image dimensions (if known) */
  dimensions?: { width: number; height: number };
}

export interface MediaRuntimeConfig {
  /** Default max attachment size (bytes) */
  defaultMaxSize: number;
  /** Default max attachments per message */
  defaultMaxAttachments: number;
  /** Whether to strip EXIF metadata by default */
  stripMetadata: boolean;
  /** Per-channel constraints */
  channelConstraints: Record<string, Partial<MediaConstraint>>;
}

// ── Channel-Specific Defaults ─────────────────────────────

const CHANNEL_CONSTRAINTS: Record<string, MediaConstraint> = {
  whatsapp: {
    maxSize: 100 * 1024 * 1024,   // 100MB
    allowedTypes: ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/3gpp", "audio/aac", "audio/mp4", "audio/mpeg", "audio/ogg", "application/pdf", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.*"],
    maxImageDimension: 4096,
    maxVideoDurationSec: 60,
    maxAudioDurationSec: 300,
    maxAttachments: 1,
    stickersAllowed: true,
  },
  telegram: {
    maxSize: 50 * 1024 * 1024,    // 50MB (bots)
    allowedTypes: [],
    maxImageDimension: 2560,
    maxVideoDurationSec: 600,
    maxAudioDurationSec: 600,
    maxAttachments: 10,
    stickersAllowed: true,
  },
  discord: {
    maxSize: 25 * 1024 * 1024,    // 25MB (8MB for non-Nitro, but we target 25MB)
    allowedTypes: [],
    maxImageDimension: 4096,
    maxVideoDurationSec: 600,
    maxAudioDurationSec: 600,
    maxAttachments: 10,
    stickersAllowed: true,
  },
  slack: {
    maxSize: 1 * 1024 * 1024 * 1024, // 1GB
    allowedTypes: [],
    maxImageDimension: undefined,
    maxVideoDurationSec: undefined,
    maxAudioDurationSec: undefined,
    maxAttachments: 10,
    stickersAllowed: false,
  },
  feishu: {
    maxSize: 20 * 1024 * 1024,    // 20MB
    allowedTypes: [],
    maxImageDimension: 4096,
    maxVideoDurationSec: 600,
    maxAudioDurationSec: 600,
    maxAttachments: 10,
    stickersAllowed: false,
  },
  wechat: {
    maxSize: 10 * 1024 * 1024,    // 10MB
    allowedTypes: ["image/jpeg", "image/png", "image/gif", "audio/amr", "audio/mpeg", "video/mp4"],
    maxImageDimension: 2048,
    maxVideoDurationSec: 60,
    maxAudioDurationSec: 60,
    maxAttachments: 1,
    stickersAllowed: false,
  },
  qq: {
    maxSize: 30 * 1024 * 1024,    // 30MB
    allowedTypes: [],
    maxImageDimension: 4096,
    maxVideoDurationSec: 300,
    maxAudioDurationSec: 300,
    maxAttachments: 10,
    stickersAllowed: true,
  },
  matrix: {
    maxSize: 50 * 1024 * 1024,    // 50MB (configurable per server)
    allowedTypes: [],
    maxImageDimension: undefined,
    maxVideoDurationSec: undefined,
    maxAudioDurationSec: undefined,
    maxAttachments: 10,
    stickersAllowed: true,
  },
  webchat: {
    maxSize: 200 * 1024 * 1024,   // 200MB
    allowedTypes: [],
    maxImageDimension: undefined,
    maxVideoDurationSec: undefined,
    maxAudioDurationSec: undefined,
    maxAttachments: 50,
    stickersAllowed: true,
  },
};

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: MediaRuntimeConfig = {
  defaultMaxSize: 25 * 1024 * 1024,  // 25MB
  defaultMaxAttachments: 10,
  stripMetadata: true,
  channelConstraints: {},
};

// ── MIME type pattern matching ────────────────────────────

function matchesMimePattern(mimeType: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => {
    // Check if the pattern itself is a wildcard (e.g. "image/*")
    if (pattern.includes("*")) {
      // 先转义正则特殊字符，再将 * 转为 .*，避免恶意输入构造非法正则
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      try {
        const regex = new RegExp("^" + escaped + "$");
        return regex.test(mimeType);
      } catch (err) {
        process.stderr.write('[MediaRuntime] invalid mime pattern: ' + err + '\n');
        return false;
      }
    }
    // Check if the mimeType is a wildcard matching the pattern (e.g. mimeType="image/*" against pattern="image/jpeg")
    if (mimeType.includes("*")) {
      const escaped = mimeType.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      try {
        const regex = new RegExp("^" + escaped + "$");
        return regex.test(pattern);
      } catch (err) {
        process.stderr.write('[MediaRuntime] invalid mime pattern: ' + err + '\n');
        return false;
      }
    }
    return pattern === mimeType;
  });
}

// ── Runtime ───────────────────────────────────────────────

export class MediaRuntime {
  private config: MediaRuntimeConfig;

  constructor(config?: Partial<MediaRuntimeConfig>) {
    this.config = { ...DEFAULT_CONFIG, channelConstraints: { ...DEFAULT_CONFIG.channelConstraints, ...config?.channelConstraints } };
  }

  /**
   * Validate attachments for a specific channel.
   */
  validateAttachments(
    channel: string,
    attachments: MediaAttachment[],
  ): MediaValidationResult {
    const constraint = this.getConstraint(channel);
    const errors: string[] = [];
    const warnings: string[] = [];
    let needsResize = false;
    let needsConversion = false;

    // Count check
    if (attachments.length > constraint.maxAttachments) {
      errors.push(
        `Too many attachments: ${attachments.length} > ${constraint.maxAttachments} max`,
      );
    }

    for (const att of attachments) {
      // Type check
      if (att.mimeType && !matchesMimePattern(att.mimeType, constraint.allowedTypes)) {
        errors.push(`Unsupported MIME type for ${channel}: ${att.mimeType}`);
        needsConversion = true;
      }

      // Size check
      if (att.size && att.size > constraint.maxSize) {
        errors.push(
          `Attachment too large: ${formatSize(att.size)} > ${formatSize(constraint.maxSize)}`,
        );
        needsResize = true;
      }

      // Dimension check
      if (att.dimensions && constraint.maxImageDimension) {
        const maxDim = Math.max(att.dimensions.width, att.dimensions.height);
        if (maxDim > constraint.maxImageDimension) {
          warnings.push(
            `Image dimensions ${att.dimensions.width}x${att.dimensions.height} exceed ${channel} max ${constraint.maxImageDimension}px`,
          );
          needsResize = true;
        }
      }

      // Sticker check
      if (att.type === "sticker" && !constraint.stickersAllowed) {
        errors.push(`Stickers not supported on ${channel}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      needsResize,
      needsConversion,
    };
  }

  /**
   * Get optimization hints for a channel.
   */
  getOptimizationHints(
    channel: string,
    attachment: MediaAttachment,
  ): MediaOptimizationHint {
    const constraint = this.getConstraint(channel);

    return {
      maxWidth: constraint.maxImageDimension,
      maxHeight: constraint.maxImageDimension,
      targetFormat: attachment.type === "image" && attachment.mimeType === "image/png"
        ? "image/jpeg" // Convert PNG to JPEG for smaller size
        : undefined,
      quality: attachment.type === "image" ? 85 : undefined,
      stripMetadata: this.config.stripMetadata,
    };
  }

  /**
   * Check if a file can be sent as-is on a channel.
   */
  canSendDirectly(
    channel: string,
    attachment: MediaAttachment,
  ): { canSend: boolean; reason?: string } {
    const constraint = this.getConstraint(channel);

    if (attachment.size && attachment.size > constraint.maxSize) {
      return {
        canSend: false,
        reason: `Size ${formatSize(attachment.size)} exceeds ${channel} limit of ${formatSize(constraint.maxSize)}`,
      };
    }

    if (
      attachment.mimeType &&
      !matchesMimePattern(attachment.mimeType, constraint.allowedTypes)
    ) {
      return {
        canSend: false,
        reason: `MIME type "${attachment.mimeType}" not supported on ${channel}`,
      };
    }

    if (attachment.type === "sticker" && !constraint.stickersAllowed) {
      return { canSend: false, reason: `Stickers not supported on ${channel}` };
    }

    return { canSend: true };
  }

  /**
   * Get the maximum attachment count for a channel.
   */
  getMaxAttachments(channel: string): number {
    return this.getConstraint(channel).maxAttachments;
  }

  /**
   * Get the maximum file size for a channel.
   */
  getMaxSize(channel: string): number {
    return this.getConstraint(channel).maxSize;
  }

  /**
   * Extract attachments from a ChannelMessage.
   */
  extractAttachments(message: ChannelMessage): MediaAttachment[] {
    if (!message.attachments) return [];
    return message.attachments.map((att) => ({
      type: att.type,
      url: att.url,
      data: att.data,
      mimeType: att.mimeType,
      filename: att.filename,
    }));
  }

  /**
   * Get summary of channel media capabilities.
   */
  getChannelCapabilities(channel: string): {
    maxSize: number;
    maxAttachments: number;
    supportsImages: boolean;
    supportsVideo: boolean;
    supportsAudio: boolean;
    supportsDocuments: boolean;
    supportsStickers: boolean;
  } {
    const c = this.getConstraint(channel);

    return {
      maxSize: c.maxSize,
      maxAttachments: c.maxAttachments,
      supportsImages: matchesMimePattern("image/*", c.allowedTypes) || c.allowedTypes.length === 0,
      supportsVideo: matchesMimePattern("video/*", c.allowedTypes) || c.allowedTypes.length === 0,
      supportsAudio: matchesMimePattern("audio/*", c.allowedTypes) || c.allowedTypes.length === 0,
      supportsDocuments: matchesMimePattern("application/*", c.allowedTypes) || c.allowedTypes.length === 0,
      supportsStickers: c.stickersAllowed,
    };
  }

  configure(updates: Partial<MediaRuntimeConfig>): void {
    this.config = { ...this.config, ...updates, channelConstraints: { ...this.config.channelConstraints, ...updates.channelConstraints } };
  }

  // ── Private ─────────────────────────────────────────────

  private getConstraint(channel: string): MediaConstraint {
    const base = CHANNEL_CONSTRAINTS[channel] ?? {
      maxSize: this.config.defaultMaxSize,
      allowedTypes: [],
      maxAttachments: this.config.defaultMaxAttachments,
      stickersAllowed: false,
    };

    const overrides = this.config.channelConstraints[channel] ?? {};
    return { ...base, ...overrides };
  }
}

// ── Utility ───────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}