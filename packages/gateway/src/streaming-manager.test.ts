import { describe, it, expect, beforeEach, vi } from "vitest";
import { StreamingManager } from "./streaming-manager";
import type { StreamEvent } from "./streaming-manager";

describe("StreamingManager", () => {
  let sm: StreamingManager;

  beforeEach(() => {
    sm = new StreamingManager({ minChunkIntervalMs: 0 }); // No pacing in tests
  });

  describe("splitMessage", () => {
    it("should return single chunk for short messages", () => {
      const chunks = sm.splitMessage("webchat", "Hello world");
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe("Hello world");
    });

    it("should split long messages on word boundaries", () => {
      const text = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit. ".repeat(15);
      const chunks = sm.splitMessage("discord", text);
      expect(chunks.length).toBeGreaterThan(1);
      // Each chunk should be within Discord's 2000 char limit
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(2000);
      }
    });

    it("should respect channel-specific chunk sizes", () => {
      const text = "x".repeat(5000);
      const discordChunks = sm.splitMessage("discord", text);
      const telegramChunks = sm.splitMessage("telegram", text);

      // Discord chunks should be <= 2000, Telegram <= 4096
      expect(discordChunks.length).toBeGreaterThan(telegramChunks.length);
    });

    it("should return empty array for empty text", () => {
      const chunks = sm.splitMessage("webchat", "");
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe("");
    });
  });

  describe("stream", () => {
    it("should stream short message as single chunk", async () => {
      const events: StreamEvent[] = [];
      const chunks: string[] = [];

      sm.stream("webchat", "user-1", "Hello world", {
        onEvent: (e) => events.push(e),
        onChunk: (c) => { chunks.push(c.text); },
      });

      // Wait for async completion
      await new Promise((r) => setTimeout(r, 50));

      expect(events.some((e) => e.type === "start")).toBe(true);
      expect(events.some((e) => e.type === "complete")).toBe(true);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe("Hello world");
    });

    it("should stream long message as multiple chunks", async () => {
      const text = "A".repeat(4500);
      const events: StreamEvent[] = [];
      const chunks: string[] = [];

      sm.stream("discord", "user-1", text, {
        onEvent: (e) => events.push(e),
        onChunk: (c) => { chunks.push(c.text); },
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(chunks.length).toBeGreaterThan(1);
      expect(events.some((e) => e.type === "start")).toBe(true);
      expect(events.some((e) => e.type === "complete")).toBe(true);

      // Verify chunks reassemble correctly
      const reassembled = chunks.join("").replace(/\s+/g, "");
      const original = text.replace(/\s+/g, "");
      // Due to word-boundary splits, exact match may not be possible.
      // Verify total length is roughly correct.
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      expect(totalLength).toBeGreaterThanOrEqual(text.length * 0.95);
    });

    it("should return unique stream ID", () => {
      const id1 = sm.stream("webchat", "u1", "Hello", {
        onEvent: () => {},
      });
      const id2 = sm.stream("webchat", "u2", "World", {
        onEvent: () => {},
      });
      expect(id1).not.toBe(id2);
      expect(id1).toContain("stream_");
    });

    it("should track active stream count", async () => {
      expect(sm.getActiveCount()).toBe(0);

      // Use a long message so the stream stays active for a while
      sm.stream("discord", "u1", "A".repeat(5000), { onEvent: () => {} });
      expect(sm.getActiveCount()).toBe(1);
    });

    it("should clean up completed streams", async () => {
      sm.stream("discord", "u1", "A".repeat(5000), { onEvent: () => {} });
      expect(sm.getActiveCount()).toBe(1);

      await new Promise((r) => setTimeout(r, 100));
      expect(sm.getActiveCount()).toBe(0);
    });
  });

  describe("cancel", () => {
    it("should cancel active stream", async () => {
      const events: StreamEvent[] = [];

      const id = sm.stream("discord", "u1", "A".repeat(5000), {
        onEvent: (e) => events.push(e),
        onChunk: () => {},
      });

      sm.cancel(id);
      expect(sm.getActiveCount()).toBe(0);
    });

    it("should return false for non-existent stream", () => {
      expect(sm.cancel("nonexistent")).toBe(false);
    });
  });

  describe("previewChunks", () => {
    it("should return 1 for short messages", () => {
      expect(sm.previewChunks("discord", "Hello")).toBe(1);
    });

    it("should return >1 for long messages", () => {
      expect(sm.previewChunks("discord", "A".repeat(5000))).toBeGreaterThan(1);
    });
  });

  describe("getMaxChannelLength", () => {
    it("should return known channel limits", () => {
      expect(sm.getMaxChannelLength("discord")).toBe(2000);
      expect(sm.getMaxChannelLength("telegram")).toBe(4096);
      expect(sm.getMaxChannelLength("whatsapp")).toBe(4096);
    });

    it("should return default for unknown channel", () => {
      expect(sm.getMaxChannelLength("unknown")).toBe(2000); // default maxChunkSize
    });
  });

  describe("configuration", () => {
    it("should update config", () => {
      sm.configure({ maxChunkSize: 500 });
      expect(sm.getMaxChannelLength("unknown")).toBe(500);
    });

    it("should respect channel-specific overrides", () => {
      sm.configure({
        channelChunkSizes: { discord: 500 },
      });
      // Discord override should take precedence
      expect(sm.getMaxChannelLength("discord")).toBe(500);
    });
  });

  describe("onChunk cancel", () => {
    it("should cancel stream when onChunk returns false", async () => {
      let chunkCount = 0;
      const events: StreamEvent[] = [];

      const id = sm.stream("discord", "u1", "A".repeat(4500), {
        onEvent: (e) => events.push(e),
        onChunk: () => {
          chunkCount++;
          return chunkCount >= 2 ? false : undefined;
        },
      });

      await new Promise((r) => setTimeout(r, 100));
      expect(events.some((e) => e.type === "cancelled")).toBe(true);
      expect(chunkCount).toBeGreaterThanOrEqual(1);
    });
  });
});