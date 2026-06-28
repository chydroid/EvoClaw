import { describe, it, expect, beforeEach } from "vitest";
import { HistoryWindow, type HistoryEntry } from "./history-window.js";

// ─── 测试工具 ─────────────────────────────────────────────────────────────────

function makeEntry(
  id: string,
  senderId: string,
  recipientId: string,
  content: string,
  timestampMs: number,
  isBot = false,
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

// ─── 测试主体 ─────────────────────────────────────────────────────────────────

describe("HistoryWindow", () => {
  let window: HistoryWindow;

  beforeEach(() => {
    window = new HistoryWindow({ maxSize: 5, maxAgeMs: 60_000 });
  });

  describe("add", () => {
    it("应追加新消息到窗口", () => {
      const entry = makeEntry("m1", "A", "B", "hello", 1000);
      window.add(entry);
      expect(window.size()).toBe(1);
      expect(window.snapshot()).toHaveLength(1);
      expect(window.snapshot()[0]!.messageId).toBe("m1");
    });

    it("应按时间顺序追加（旧→新）", () => {
      window.add(makeEntry("m1", "A", "B", "first", 1000));
      window.add(makeEntry("m2", "A", "B", "second", 2000));
      window.add(makeEntry("m3", "A", "B", "third", 3000));
      const snap = window.snapshot();
      expect(snap.map((e) => e.messageId)).toEqual(["m1", "m2", "m3"]);
    });
  });

  describe("recent", () => {
    it("应返回最近 N 条（按时间倒序：[0]=最新）", () => {
      window.add(makeEntry("m1", "A", "B", "first", 1000));
      window.add(makeEntry("m2", "A", "B", "second", 2000));
      window.add(makeEntry("m3", "A", "B", "third", 3000));
      const recent = window.recent(2);
      expect(recent.map((e) => e.messageId)).toEqual(["m3", "m2"]);
    });

    it("count 超过窗口大小时返回全部", () => {
      window.add(makeEntry("m1", "A", "B", "first", 1000));
      window.add(makeEntry("m2", "A", "B", "second", 2000));
      const recent = window.recent(10);
      expect(recent).toHaveLength(2);
    });

    it("count <= 0 时返回空数组", () => {
      window.add(makeEntry("m1", "A", "B", "first", 1000));
      expect(window.recent(0)).toEqual([]);
      expect(window.recent(-1)).toEqual([]);
    });
  });

  describe("recentBySender", () => {
    it("应只返回指定发送者的消息（倒序）", () => {
      window.add(makeEntry("m1", "A", "B", "a1", 1000));
      window.add(makeEntry("m2", "B", "A", "b1", 2000));
      window.add(makeEntry("m3", "A", "B", "a2", 3000));
      const byA = window.recentBySender("A", 10);
      expect(byA.map((e) => e.messageId)).toEqual(["m3", "m1"]);
    });

    it("未知发送者返回空数组", () => {
      window.add(makeEntry("m1", "A", "B", "a1", 1000));
      expect(window.recentBySender("Z", 10)).toEqual([]);
    });
  });

  describe("recentBetween", () => {
    it("应返回 A↔B 双向消息", () => {
      window.add(makeEntry("m1", "A", "B", "a→b", 1000));
      window.add(makeEntry("m2", "B", "A", "b→a", 2000));
      window.add(makeEntry("m3", "A", "C", "noise", 3000));
      window.add(makeEntry("m4", "B", "A", "b→a2", 4000));
      const between = window.recentBetween("A", "B", 10);
      expect(between.map((e) => e.messageId)).toEqual(["m4", "m2", "m1"]);
    });

    it("应排除第三方参与者", () => {
      window.add(makeEntry("m1", "A", "B", "a→b", 1000));
      window.add(makeEntry("m2", "A", "C", "a→c", 2000));
      window.add(makeEntry("m3", "B", "A", "b→a", 3000));
      const between = window.recentBetween("A", "B", 10);
      expect(between).toHaveLength(2);
      expect(between.map((e) => e.messageId)).toEqual(["m3", "m1"]);
    });
  });

  describe("prune", () => {
    it("应清理超过 maxAgeMs 的旧消息", () => {
      // maxAgeMs=200_000 足够大，避免 add() 内部自动 prune 清掉 old
      const w = new HistoryWindow({ maxSize: 100, maxAgeMs: 200_000 });
      w.add(makeEntry("old", "A", "B", "old", 1000)); // timestamp 1s
      w.add(makeEntry("new", "A", "B", "new", 100_000)); // timestamp 100s
      // 显式 prune（now=300_000，cutoff=100_000）：old(1000) 应被清理
      const removed = w.prune(new Date(300_000));
      expect(removed).toBe(1);
      expect(w.size()).toBe(1);
      expect(w.snapshot()[0]!.messageId).toBe("new");
    });

    it("窗口空时 prune 返回 0", () => {
      expect(window.prune()).toBe(0);
    });
  });

  describe("size", () => {
    it("应返回当前窗口大小", () => {
      window.add(makeEntry("m1", "A", "B", "x", 1000));
      window.add(makeEntry("m2", "A", "B", "y", 2000));
      expect(window.size()).toBe(2);
    });
  });

  describe("clear", () => {
    it("应清空窗口", () => {
      window.add(makeEntry("m1", "A", "B", "x", 1000));
      window.add(makeEntry("m2", "A", "B", "y", 2000));
      window.clear();
      expect(window.size()).toBe(0);
      expect(window.snapshot()).toEqual([]);
    });
  });

  describe("maxSize 限制", () => {
    it("超出 maxSize 时应从头部移除最旧的", () => {
      const w = new HistoryWindow({ maxSize: 3, maxAgeMs: 60_000 });
      w.add(makeEntry("m1", "A", "B", "1", 1000));
      w.add(makeEntry("m2", "A", "B", "2", 2000));
      w.add(makeEntry("m3", "A", "B", "3", 3000));
      w.add(makeEntry("m4", "A", "B", "4", 4000));
      expect(w.size()).toBe(3);
      // m1 应被移除
      expect(w.snapshot().map((e) => e.messageId)).toEqual(["m2", "m3", "m4"]);
    });

    it("add 时应自动 prune 超期消息", () => {
      const w = new HistoryWindow({ maxSize: 100, maxAgeMs: 1000 });
      // 第一条 timestamp 1000，add 时 prune(now=1000)：cutoff=0，保留
      w.add(makeEntry("m1", "A", "B", "old", 1000));
      // 第二条 timestamp 5000，add 时 prune(now=5000)：cutoff=4000，m1 被清理
      w.add(makeEntry("m2", "A", "B", "new", 5000));
      expect(w.size()).toBe(1);
      expect(w.snapshot()[0]!.messageId).toBe("m2");
    });
  });

  describe("默认配置", () => {
    it("无参数构造应使用默认 maxSize 与 maxAgeMs", () => {
      const w = new HistoryWindow();
      expect(w.size()).toBe(0);
      // 不报错即说明默认值有效
      w.add(makeEntry("m1", "A", "B", "x", Date.now()));
      expect(w.size()).toBe(1);
    });
  });
});
