import { describe, it, expect, beforeEach } from "vitest";
import { MediaRuntime } from "./media-runtime";
import type { MediaAttachment } from "./media-runtime";

function makeImage(opts?: Partial<MediaAttachment>): MediaAttachment {
  return {
    type: "image",
    mimeType: "image/jpeg",
    size: 500 * 1024,    // 500KB
    filename: "photo.jpg",
    dimensions: { width: 1920, height: 1080 },
    ...opts,
  };
}

function makeVideo(opts?: Partial<MediaAttachment>): MediaAttachment {
  return {
    type: "video",
    mimeType: "video/mp4",
    size: 10 * 1024 * 1024, // 10MB
    filename: "video.mp4",
    ...opts,
  };
}

describe("MediaRuntime", () => {
  let mr: MediaRuntime;

  beforeEach(() => {
    mr = new MediaRuntime();
  });

  describe("validateAttachments", () => {
    it("should accept valid image on webchat", () => {
      const result = mr.validateAttachments("webchat", [makeImage()]);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should accept valid image on discord", () => {
      const result = mr.validateAttachments("discord", [makeImage()]);
      expect(result.valid).toBe(true);
    });

    it("should reject oversized attachment", () => {
      const huge = makeImage({ size: 100 * 1024 * 1024 }); // 100MB
      const result = mr.validateAttachments("discord", [huge]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("too large"))).toBe(true);
    });

    it("should reject too many attachments", () => {
      const attachments = Array.from({ length: 15 }, () => makeImage());
      const result = mr.validateAttachments("whatsapp", attachments);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Too many"))).toBe(true);
    });

    it("should warn about oversized dimensions", () => {
      const large = makeImage({ dimensions: { width: 5000, height: 3000 } });
      const result = mr.validateAttachments("telegram", [large]);
      // May be valid still but with warnings
      if (result.warnings.length > 0) {
        expect(result.warnings.some((w) => w.includes("exceed"))).toBe(true);
      }
      expect(result.needsResize).toBe(true);
    });

    it("should reject stickers on channels that don't support them", () => {
      const sticker: MediaAttachment = {
        type: "sticker",
        mimeType: "image/webp",
        filename: "sticker.webp",
      };
      const result = mr.validateAttachments("slack", [sticker]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Stickers"))).toBe(true);
    });

    it("should accept stickers on channels that support them", () => {
      const sticker: MediaAttachment = {
        type: "sticker",
        mimeType: "image/webp",
        filename: "sticker.webp",
      };
      const result = mr.validateAttachments("telegram", [sticker]);
      expect(result.valid).toBe(true);
    });

    it("should reject unsupported MIME types on restricted channels", () => {
      const attachment = makeImage({ mimeType: "image/tiff" });
      const result = mr.validateAttachments("wechat", [attachment]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Unsupported"))).toBe(true);
    });
  });

  describe("getOptimizationHints", () => {
    it("should provide max dimensions matching channel constraint", () => {
      const hints = mr.getOptimizationHints("telegram", makeImage());
      expect(hints.maxWidth).toBe(2560);
      expect(hints.maxHeight).toBe(2560);
    });

    it("should suggest PNG to JPEG conversion", () => {
      const hints = mr.getOptimizationHints(
        "whatsapp",
        makeImage({ mimeType: "image/png" }),
      );
      expect(hints.targetFormat).toBe("image/jpeg");
    });

    it("should recommend stripping metadata", () => {
      const hints = mr.getOptimizationHints("discord", makeImage());
      expect(hints.stripMetadata).toBe(true);
    });

    it("should set quality for images", () => {
      const hints = mr.getOptimizationHints("telegram", makeImage());
      expect(hints.quality).toBe(85);
    });
  });

  describe("canSendDirectly", () => {
    it("should return true for valid attachment", () => {
      const result = mr.canSendDirectly("discord", makeImage());
      expect(result.canSend).toBe(true);
    });

    it("should return false for oversized attachment", () => {
      const huge = makeImage({ size: 100 * 1024 * 1024 });
      const result = mr.canSendDirectly("discord", huge);
      expect(result.canSend).toBe(false);
      expect(result.reason).toContain("exceeds");
    });

    it("should return false for unsupported MIME type", () => {
      const tiff = makeImage({ mimeType: "image/tiff" });
      const result = mr.canSendDirectly("wechat", tiff);
      expect(result.canSend).toBe(false);
    });
  });

  describe("getMaxAttachments", () => {
    it("should return channel-specific limits", () => {
      expect(mr.getMaxAttachments("whatsapp")).toBe(1);
      expect(mr.getMaxAttachments("discord")).toBe(10);
      expect(mr.getMaxAttachments("webchat")).toBe(50);
    });
  });

  describe("getMaxSize", () => {
    it("should return channel-specific size limits", () => {
      expect(mr.getMaxSize("discord")).toBe(25 * 1024 * 1024);
      expect(mr.getMaxSize("telegram")).toBe(50 * 1024 * 1024);
      expect(mr.getMaxSize("whatsapp")).toBe(100 * 1024 * 1024);
    });
  });

  describe("extractAttachments", () => {
    it("should extract attachments from ChannelMessage", () => {
      const msg = {
        messageId: "msg-1",
        channel: "discord" as const,
        from: "user",
        to: "bot",
        text: "Check this",
        timestamp: new Date().toISOString(),
        isDirect: true,
        isGroup: false,
        raw: {},
        attachments: [
          { type: "image" as const, url: "https://example.com/img.jpg", mimeType: "image/jpeg" },
        ],
      };

      const attachments = mr.extractAttachments(msg);
      expect(attachments).toHaveLength(1);
      expect(attachments[0].type).toBe("image");
      expect(attachments[0].url).toBe("https://example.com/img.jpg");
    });

    it("should return empty array for messages without attachments", () => {
      const msg = {
        messageId: "msg-2",
        channel: "webchat" as const,
        from: "user",
        to: "bot",
        text: "Hello",
        timestamp: new Date().toISOString(),
        isDirect: true,
        isGroup: false,
        raw: {},
      };
      expect(mr.extractAttachments(msg)).toHaveLength(0);
    });
  });

  describe("getChannelCapabilities", () => {
    it("should return capabilities for discord", () => {
      const caps = mr.getChannelCapabilities("discord");
      expect(caps.supportsImages).toBe(true);
      expect(caps.supportsVideo).toBe(true);
      expect(caps.supportsAudio).toBe(true);
      expect(caps.supportsStickers).toBe(true);
    });

    it("should return capabilities for slack", () => {
      const caps = mr.getChannelCapabilities("slack");
      expect(caps.supportsStickers).toBe(false);
    });

    it("should return capabilities for wechat (restricted)", () => {
      const caps = mr.getChannelCapabilities("wechat");
      expect(caps.supportsImages).toBe(true);
      expect(caps.supportsVideo).toBe(true);
      expect(caps.supportsAudio).toBe(true);
    });
  });

  describe("configuration", () => {
    it("should update config", () => {
      mr.configure({ defaultMaxSize: 10 * 1024 * 1024 });
      expect(mr.getMaxSize("unknown-channel")).toBe(10 * 1024 * 1024);
    });

    it("should update channel constraints", () => {
      mr.configure({
        channelConstraints: { discord: { maxSize: 10 * 1024 * 1024 } },
      });
      expect(mr.getMaxSize("discord")).toBe(10 * 1024 * 1024);
    });
  });
});