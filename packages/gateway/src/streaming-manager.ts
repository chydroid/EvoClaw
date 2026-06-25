/**
 * Streaming Manager — gateway-level streaming abstraction for
 * outbound message delivery with backpressure, chunking, and
 * progress reporting.
 *
 * Features:
 *  - Chunk-based streaming with configurable chunk sizes
 *  - Backpressure-aware delivery pacing
 *  - Multi-channel simultaneous streaming
 *  - Progress callback per chunk
 *  - Stream cancellation / abort
 *  - Integration with ProgressDrafts for status display
 *  - Adaptive chunk sizing based on channel limits
 */

// ── Types ─────────────────────────────────────────────────

export interface StreamChunk {
  /** Unique chunk ID (sequential) */
  index: number;
  /** Text content of this chunk */
  text: string;
  /** Total chunks expected (if known) */
  total?: number;
  /** Whether this is the final chunk */
  isLast: boolean;
  /** Timestamp when chunk was emitted */
  timestamp: number;
}

export interface StreamConfig {
  /** Maximum characters per chunk */
  maxChunkSize: number;
  /** Minimum delay between chunks (ms) for pacing */
  minChunkIntervalMs: number;
  /** Maximum concurrent streams across all channels */
  maxConcurrentStreams: number;
  /** Default stream timeout (ms, 0 = no timeout) */
  streamTimeoutMs: number;
  /** Whether to split on word boundaries */
  splitOnWordBoundary: boolean;
  /** Channel-specific chunk size overrides */
  channelChunkSizes: Record<string, number>;
}

export interface StreamSession {
  /** Unique stream ID */
  streamId: string;
  /** Channel this stream is on */
  channel: string;
  /** Target recipient */
  target: string;
  /** Full message text being streamed */
  fullText: string;
  /** Current position (chars emitted) */
  position: number;
  /** Total message length */
  totalLength: number;
  /** Start time */
  startedAt: number;
  /** Whether this stream is active */
  active: boolean;
  /** Abort controller */
  aborter: AbortController;
  /** Chunks emitted so far */
  chunksEmitted: number;
}

export type StreamEvent =
  | { type: "chunk"; streamId: string; chunk: StreamChunk }
  | { type: "start"; streamId: string; totalLength: number }
  | { type: "complete"; streamId: string; totalChunks: number; elapsedMs: number }
  | { type: "error"; streamId: string; error: string }
  | { type: "cancelled"; streamId: string; reason?: string };

export interface StreamCallback {
  onEvent: (event: StreamEvent) => void;
  /** Called with each chunk — returns void or false to cancel */
  onChunk?: (chunk: StreamChunk, streamId: string) => void | false | Promise<void | false>;
}

// ── Defaults ──────────────────────────────────────────────

const DEFAULT_CONFIG: StreamConfig = {
  maxChunkSize: 2000,
  minChunkIntervalMs: 50,
  maxConcurrentStreams: 10,
  streamTimeoutMs: 120_000,  // 2 minutes
  splitOnWordBoundary: true,
  channelChunkSizes: {
    discord: 2000,
    telegram: 4096,
    slack: 4000,
    whatsapp: 4096,
    wechat: 2048,
  },
};

// ── Channel character limits ──────────────────────────────

const CHANNEL_MAX_LENGTHS: Record<string, number> = {
  discord: 2000,
  telegram: 4096,
  slack: 4000,
  whatsapp: 4096,
  wechat: 2048,
  feishu: 30000,
  matrix: 65536,
  qq: 4500,
  webchat: Infinity,
  cli: Infinity,
  api: Infinity,
};

// ── Manager ───────────────────────────────────────────────

export class StreamingManager {
  private config: StreamConfig;
  private streams = new Map<string, StreamSession>();

  constructor(config?: Partial<StreamConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config, channelChunkSizes: { ...DEFAULT_CONFIG.channelChunkSizes, ...config?.channelChunkSizes } };
  }

  /**
   * Stream a message to a channel, emitting chunks with pacing.
   * Returns the stream ID for tracking.
   */
  stream(
    channel: string,
    target: string,
    text: string,
    callbacks: StreamCallback,
  ): string {
    if (this.streams.size >= this.config.maxConcurrentStreams) {
      throw new Error(`Max concurrent streams reached (${this.config.maxConcurrentStreams})`);
    }

    const streamId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const aborter = new AbortController();
    const chunkSize = this.getChunkSize(channel);

    const session: StreamSession = {
      streamId,
      channel,
      target,
      fullText: text,
      position: 0,
      totalLength: text.length,
      startedAt: Date.now(),
      active: true,
      aborter,
      chunksEmitted: 0,
    };

    this.streams.set(streamId, session);

    callbacks.onEvent({ type: "start", streamId, totalLength: text.length });

    // Start async streaming
    this.executeStream(session, chunkSize, callbacks).catch((err) => {
      if (!session.active) return;
      session.active = false;
      callbacks.onEvent({ type: "error", streamId, error: err instanceof Error ? err.message : String(err) });
      this.streams.delete(streamId);
    });

    return streamId;
  }

  /**
   * Cancel an active stream.
   */
  cancel(streamId: string, reason?: string): boolean {
    const session = this.streams.get(streamId);
    if (!session || !session.active) return false;

    session.aborter.abort();
    session.active = false;
    this.streams.delete(streamId);
    return true;
  }

  /**
   * Get active stream count.
   */
  getActiveCount(): number {
    return this.streams.size;
  }

  /**
   * Get all active stream IDs.
   */
  getActiveStreams(): string[] {
    return [...this.streams.keys()];
  }

  /**
   * Get stream session info.
   */
  getStream(streamId: string): StreamSession | null {
    return this.streams.get(streamId) ?? null;
  }

  /**
   * Calculate how many chunks a message will be split into.
   */
  previewChunks(channel: string, text: string): number {
    const chunkSize = this.getChunkSize(channel);
    if (chunkSize >= text.length) return 1;
    return Math.ceil(text.length / chunkSize);
  }

  /**
   * Get effective chunk size for a channel.
   */
  getMaxChannelLength(channel: string): number {
    return this.getChunkSize(channel);
  }

  /**
   * Split a message into chunks without streaming.
   * Useful for channels that don't support streaming (batch send).
   */
  splitMessage(channel: string, text: string): string[] {
    const chunkSize = this.getChunkSize(channel);
    if (text.length <= chunkSize) return [text];

    const chunks: string[] = [];
    let pos = 0;

    while (pos < text.length) {
      let end = pos + chunkSize;
      if (end >= text.length) {
        chunks.push(text.slice(pos));
        break;
      }

      if (this.config.splitOnWordBoundary) {
        // Try to find a natural break point
        const searchEnd = Math.max(pos + chunkSize * 0.8, pos);
        const slice = text.slice(searchEnd, end + 1);
        const lastBreak = Math.max(
          slice.lastIndexOf("\n"),
          slice.lastIndexOf(". "),
          slice.lastIndexOf("! "),
          slice.lastIndexOf("? "),
          slice.lastIndexOf(" "),
        );

        if (lastBreak > 0) {
          end = searchEnd + lastBreak + 1;
        }
      }

      chunks.push(text.slice(pos, end).trim());
      pos = end;
    }

    return chunks;
  }

  configure(updates: Partial<StreamConfig>): void {
    this.config = { ...this.config, ...updates, channelChunkSizes: { ...this.config.channelChunkSizes, ...updates.channelChunkSizes } };
  }

  // ── Private ─────────────────────────────────────────────

  private getChunkSize(channel: string): number {
    const override = this.config.channelChunkSizes[channel];
    if (override !== undefined) return override;

    const max = CHANNEL_MAX_LENGTHS[channel];
    if (max !== undefined) return Math.min(max, this.config.maxChunkSize);
    return this.config.maxChunkSize;
  }

  private async executeStream(
    session: StreamSession,
    chunkSize: number,
    callbacks: StreamCallback,
  ): Promise<void> {
    const signal = session.aborter.signal;

    // Yield to event loop so the caller can observe the stream as active
    await Promise.resolve();

    if (session.fullText.length <= chunkSize) {
      // Single chunk — send immediately
      if (signal.aborted) return;

      const chunk: StreamChunk = {
        index: 0,
        text: session.fullText,
        total: 1,
        isLast: true,
        timestamp: Date.now(),
      };

      session.position = session.fullText.length;
      session.chunksEmitted = 1;
      session.active = false;

      const result = callbacks.onChunk?.(chunk, session.streamId);
      if (result instanceof Promise) await result;

      if (result !== false) {
        callbacks.onEvent({
          type: "complete",
          streamId: session.streamId,
          totalChunks: 1,
          elapsedMs: Date.now() - session.startedAt,
        });
      } else {
        callbacks.onEvent({ type: "cancelled", streamId: session.streamId, reason: "Chunk handler returned false" });
      }

      this.streams.delete(session.streamId);
      return;
    }

    // Multi-chunk streaming with pacing
    const chunks = this.splitMessage(session.channel, session.fullText);
    const totalChunks = chunks.length;

    for (let i = 0; i < chunks.length; i++) {
      if (signal.aborted) {
        callbacks.onEvent({ type: "cancelled", streamId: session.streamId, reason: "Aborted" });
        session.active = false;
        this.streams.delete(session.streamId);
        return;
      }

      const chunk: StreamChunk = {
        index: i,
        text: chunks[i],
        total: totalChunks,
        isLast: i === chunks.length - 1,
        timestamp: Date.now(),
      };

      session.position += chunks[i].length;
      session.chunksEmitted++;

      const result = callbacks.onChunk?.(chunk, session.streamId);
      if (result instanceof Promise) await result;
      if (result === false) {
        callbacks.onEvent({ type: "cancelled", streamId: session.streamId, reason: "Chunk handler returned false" });
        session.active = false;
        this.streams.delete(session.streamId);
        return;
      }

      callbacks.onEvent({ type: "chunk", streamId: session.streamId, chunk });

      // Pacing delay between chunks
      if (!chunk.isLast && this.config.minChunkIntervalMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            // 定时器正常触发时移除 abort 监听器，避免内存泄漏
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, this.config.minChunkIntervalMs);
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }).catch(() => {
          // Aborted during wait
        });
      }
    }

    session.active = false;

    callbacks.onEvent({
      type: "complete",
      streamId: session.streamId,
      totalChunks: session.chunksEmitted,
      elapsedMs: Date.now() - session.startedAt,
    });

    this.streams.delete(session.streamId);
  }
}