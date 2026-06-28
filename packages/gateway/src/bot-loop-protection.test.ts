import { describe, it, expect, beforeEach } from "vitest";
import {
  BotLoopProtection,
  DEFAULT_BOT_LOOP_CONFIG,
  type BotLoopProtectionConfig,
} from "./bot-loop-protection.js";
import type { HistoryEntry } from "./history-window.js";

// ─── 测试工具 ─────────────────────────────────────────────────────────────────

function makeEntry(
  id: string,
  senderId: string,
  recipientId: string,
  content: string,
  timestampMs: number,
  isBot = true,
): HistoryEntry {
  return {
    messageId: id,
    senderId,
    recipientId,
    content,
    timestamp: new Date(timestampMs),
    isBot,
  };
}

function aggressiveConfig(overrides: Partial<BotLoopProtectionConfig> = {}): Partial<BotLoopProtectionConfig> {
  return {
    windowSize: 10,
    minRepeats: 3,
    contentSimilarityThreshold: 0.8,
    throttleAfter: 2,
    blockAfter: 4,
    alertAfter: 6,
    cooldownMs: 60_000,
    ...overrides,
  };
}

// ─── 测试主体 ─────────────────────────────────────────────────────────────────

describe("BotLoopProtection", () => {
  let protection: BotLoopProtection;

  beforeEach(() => {
    protection = new BotLoopProtection(aggressiveConfig());
  });

  describe("无循环场景", () => {
    it("历史不足时应 allow 且 detected=false", () => {
      const r = protection.evaluate(
        makeEntry("m1", "A", "B", "hello", 1000),
      );
      expect(r.detected).toBe(false);
      expect(r.action).toBe("allow");
      expect(r.severity).toBe("none");
      expect(r.pattern).toBe("none");
    });

    it("内容不相似时应 allow", () => {
      const base = 1000;
      protection.evaluate(makeEntry("m1", "A", "B", "你好，今天天气真好", base));
      protection.evaluate(makeEntry("m2", "B", "A", "我想吃火锅", base + 1000));
      protection.evaluate(makeEntry("m3", "A", "B", "明天会下雨吗", base + 2000));
      const r = protection.evaluate(
        makeEntry("m4", "B", "A", "不知道，我去看新闻", base + 3000),
      );
      expect(r.detected).toBe(false);
      expect(r.action).toBe("allow");
    });
  });

  describe("ping-pong 检测", () => {
    it("A↔B 交替且内容相似应触发 ping-pong", () => {
      const base = 1000;
      const text = "你在干嘛";
      protection.evaluate(makeEntry("m1", "A", "B", text, base));
      protection.evaluate(makeEntry("m2", "B", "A", text, base + 1000));
      protection.evaluate(makeEntry("m3", "A", "B", text, base + 2000));
      const r = protection.evaluate(makeEntry("m4", "B", "A", text, base + 3000));
      expect(r.detected).toBe(true);
      expect(r.pattern).toBe("ping-pong");
      expect(r.participants).toEqual(["A", "B"]);
      expect(r.loopLength).toBe(2);
      expect(r.repeatedCount).toBeGreaterThanOrEqual(3);
    });

    it("参与者相同（sender=recipient）不应触发 ping-pong", () => {
      const base = 1000;
      const text = "自言自语";
      protection.evaluate(makeEntry("m1", "A", "A", text, base));
      const r = protection.evaluate(makeEntry("m2", "A", "A", text, base + 1000));
      // senderId === recipientId 走 self-repeat 分支或 allow
      expect(r.pattern).not.toBe("ping-pong");
    });

    it("交替模式被破坏不应触发 ping-pong（A→B→A→A）", () => {
      const base = 1000;
      const text = "重复话术";
      // m1=A→B, m2=B→A, m3=A→B, m4=A→B（最后破坏交替）
      protection.evaluate(makeEntry("m1", "A", "B", text, base));
      protection.evaluate(makeEntry("m2", "B", "A", text, base + 1000));
      protection.evaluate(makeEntry("m3", "A", "B", text, base + 2000));
      const r = protection.evaluate(makeEntry("m4", "A", "B", text, base + 3000));
      // recentBetween(A,B) 序列 sender = [A, B, A, A]：最后破坏交替
      // 不应被识别为 ping-pong（可能被识别为 self-repeat，那是正确的）
      expect(r.pattern).not.toBe("ping-pong");
    });
  });

  describe("self-repeat 检测", () => {
    it("同一发送者连续相似消息应触发 self-repeat", () => {
      const base = 1000;
      const text = "我重复我自己";
      protection.evaluate(makeEntry("m1", "A", "B", text, base));
      protection.evaluate(makeEntry("m2", "A", "B", text, base + 1000));
      protection.evaluate(makeEntry("m3", "A", "B", text, base + 2000));
      const r = protection.evaluate(makeEntry("m4", "A", "B", text, base + 3000));
      expect(r.detected).toBe(true);
      expect(r.pattern).toBe("self-repeat");
      expect(r.participants).toEqual(["A"]);
      expect(r.loopLength).toBe(1);
      expect(r.repeatedCount).toBeGreaterThanOrEqual(3);
    });

    it("内容发散的同一发送者不应触发", () => {
      const base = 1000;
      protection.evaluate(makeEntry("m1", "A", "B", "苹果", base));
      protection.evaluate(makeEntry("m2", "A", "B", "香蕉", base + 1000));
      protection.evaluate(makeEntry("m3", "A", "B", "橙子", base + 2000));
      const r = protection.evaluate(makeEntry("m4", "A", "B", "葡萄", base + 3000));
      expect(r.detected).toBe(false);
      expect(r.action).toBe("allow");
    });
  });

  describe("cycle 检测", () => {
    it("A→B→C→A→B→C 三方循环应触发 cycle", () => {
      const base = 1000;
      const text = "轮流转";
      // 构造 6 条消息：A→B, B→C, C→A, A→B, B→C, C→A
      protection.evaluate(makeEntry("m1", "A", "B", text, base));
      protection.evaluate(makeEntry("m2", "B", "C", text, base + 1000));
      protection.evaluate(makeEntry("m3", "C", "A", text, base + 2000));
      protection.evaluate(makeEntry("m4", "A", "B", text, base + 3000));
      protection.evaluate(makeEntry("m5", "B", "C", text, base + 4000));
      const r = protection.evaluate(makeEntry("m6", "C", "A", text, base + 5000));
      expect(r.detected).toBe(true);
      expect(r.pattern).toBe("cycle");
      expect(r.loopLength).toBe(3);
      expect(r.participants).toEqual(expect.arrayContaining(["A", "B", "C"]));
    });
  });

  describe("相似度阈值", () => {
    it("相似度低于阈值不应触发 ping-pong", () => {
      const p = new BotLoopProtection(
        aggressiveConfig({ contentSimilarityThreshold: 0.99 }),
      );
      const base = 1000;
      p.evaluate(makeEntry("m1", "A", "B", "你好啊", base));
      p.evaluate(makeEntry("m2", "B", "A", "你很好", base + 1000));
      p.evaluate(makeEntry("m3", "A", "B", "你好啊", base + 2000));
      const r = p.evaluate(makeEntry("m4", "B", "A", "你很好", base + 3000));
      // 阈值 0.99 严苛，相似度不足时不应 trigger
      if (r.detected) {
        expect(r.repeatedCount).toBeLessThan(p["config"].minRepeats);
      }
    });

    it("完全相同内容相似度应为 1.0", () => {
      const sim = protection.computeSimilarity("hello world", "hello world");
      expect(sim).toBe(1);
    });

    it("空字符串相似度应为 0", () => {
      const sim = protection.computeSimilarity("", "abc");
      expect(sim).toBe(0);
    });
  });

  describe("throttle/block/alert 阶梯", () => {
    it("repeatedCount 达到 throttleAfter 应 throttle", () => {
      const p = new BotLoopProtection(
        aggressiveConfig({ throttleAfter: 2, blockAfter: 100, alertAfter: 100 }),
      );
      const base = 1000;
      const text = "重复内容";
      p.evaluate(makeEntry("m1", "A", "B", text, base));
      p.evaluate(makeEntry("m2", "B", "A", text, base + 1000));
      p.evaluate(makeEntry("m3", "A", "B", text, base + 2000));
      const r = p.evaluate(makeEntry("m4", "B", "A", text, base + 3000));
      expect(r.detected).toBe(true);
      // repeatedCount >= 4，预期 action >= throttle
      expect(["throttle", "block", "alert"]).toContain(r.action);
    });

    it("repeatedCount 达到 blockAfter 应 block", () => {
      const p = new BotLoopProtection(
        aggressiveConfig({
          throttleAfter: 1,
          blockAfter: 3,
          alertAfter: 100,
          minRepeats: 3,
        }),
      );
      const base = 1000;
      const text = "完全相同的话";
      p.evaluate(makeEntry("m1", "A", "B", text, base));
      p.evaluate(makeEntry("m2", "B", "A", text, base + 1000));
      p.evaluate(makeEntry("m3", "A", "B", text, base + 2000));
      p.evaluate(makeEntry("m4", "B", "A", text, base + 3000));
      const r = p.evaluate(makeEntry("m5", "A", "B", text, base + 4000));
      expect(r.detected).toBe(true);
      expect(["block", "alert"]).toContain(r.action);
    });

    it("repeatedCount 达到 alertAfter 应 alert", () => {
      const p = new BotLoopProtection(
        aggressiveConfig({
          throttleAfter: 1,
          blockAfter: 2,
          alertAfter: 4,
          minRepeats: 3,
          windowSize: 20,
        }),
      );
      const base = 1000;
      const text = "警报等级";
      for (let i = 0; i < 6; i++) {
        const sender = i % 2 === 0 ? "A" : "B";
        const recipient = i % 2 === 0 ? "B" : "A";
        p.evaluate(makeEntry(`m${i}`, sender, recipient, text, base + i * 1000));
      }
      // 第 7 条
      const r = p.evaluate(makeEntry("m6", "A", "B", text, base + 6000));
      expect(r.detected).toBe(true);
      expect(r.action).toBe("alert");
      expect(r.severity).toBe("critical");
    });
  });

  describe("冷却期", () => {
    it("isSuppressed 在冷却期应返回 true", () => {
      const p = new BotLoopProtection(
        aggressiveConfig({ cooldownMs: 60_000 }),
      );
      p.suppress("A", "test", 60_000);
      expect(p.isSuppressed("A", new Date(Date.now() + 10_000))).toBe(true);
    });

    it("冷却到期后应自动解除", () => {
      const p = new BotLoopProtection(
        aggressiveConfig({ cooldownMs: 60_000 }),
      );
      // 压制到 1000ms 前
      p.suppress("A", "test", 1000);
      // 2000ms 后应已过期
      const later = new Date(Date.now() + 2000);
      expect(p.isSuppressed("A", later)).toBe(false);
    });

    it("冷却期内评估应直接 block", () => {
      const p = new BotLoopProtection(
        aggressiveConfig({ cooldownMs: 60_000 }),
      );
      p.suppress("A", "test");
      const r = p.evaluate(
        makeEntry("m1", "A", "B", "any", 1000),
      );
      expect(r.detected).toBe(true);
      expect(r.action).toBe("block");
      expect(r.reason).toContain("cooldown");
    });
  });

  describe("suppress 手动压制", () => {
    it("suppress 应使后续 evaluate block", () => {
      protection.suppress("botX", "manual override");
      const r = protection.evaluate(
        makeEntry("m1", "botX", "botY", "msg", 1000),
      );
      expect(r.action).toBe("block");
    });

    it("pruneSuppressions 应清理过期项", () => {
      protection.suppress("A", "test", 1); // 1ms 后过期
      // 等待过期
      const future = new Date(Date.now() + 10);
      const removed = protection.pruneSuppressions(future);
      expect(removed).toBe(1);
      expect(protection.isSuppressed("A", future)).toBe(false);
    });

    it("pruneSuppressions 未过期项应保留", () => {
      protection.suppress("A", "test", 60_000);
      const removed = protection.pruneSuppressions();
      expect(removed).toBe(0);
      expect(protection.isSuppressed("A")).toBe(true);
    });
  });

  describe("文本归一化与 Levenshtein", () => {
    it("normalizeText 应折叠空白与转小写", () => {
      const n = protection.normalizeText("Hello   World!");
      expect(n).toBe("hello world");
    });

    it("normalizeText 应去除标点", () => {
      const n = protection.normalizeText("Hi, there. How's it going?");
      expect(n).toBe("hi there hows it going");
    });

    it("Levenshtein 距离：kitten → sitting 距离为 3", () => {
      // kitten → sitten → sittin → sitting = 3 编辑
      const sim = protection.computeSimilarity("kitten", "sitting");
      // maxLen=7, dist=3, sim=1-3/7≈0.571
      expect(sim).toBeCloseTo(1 - 3 / 7, 2);
    });

    it("完全不同字符串相似度应较低", () => {
      const sim = protection.computeSimilarity("abc", "xyz");
      expect(sim).toBeLessThan(0.4);
    });
  });

  describe("默认配置", () => {
    it("DEFAULT_BOT_LOOP_CONFIG 应有合理默认值", () => {
      expect(DEFAULT_BOT_LOOP_CONFIG.windowSize).toBe(10);
      expect(DEFAULT_BOT_LOOP_CONFIG.minRepeats).toBe(3);
      expect(DEFAULT_BOT_LOOP_CONFIG.throttleAfter).toBe(2);
      expect(DEFAULT_BOT_LOOP_CONFIG.blockAfter).toBe(4);
      expect(DEFAULT_BOT_LOOP_CONFIG.alertAfter).toBe(6);
      expect(DEFAULT_BOT_LOOP_CONFIG.cooldownMs).toBe(60_000);
    });
  });
});
