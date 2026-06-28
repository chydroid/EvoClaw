import { describe, it, expect, beforeEach } from "vitest";
import {
  MessageTurnGuardrails,
  DEFAULT_TURN_GUARDRAILS_CONFIG,
  type TurnGuardrailsConfig,
} from "./message-turn-guardrails.js";

// ─── 测试工具 ─────────────────────────────────────────────────────────────────

function smallConfig(
  overrides: Partial<TurnGuardrailsConfig> = {},
): Partial<TurnGuardrailsConfig> {
  return {
    maxMessagesPerTurn: 5,
    maxTurnsPerMinute: 3,
    maxTurnDurationMs: 10_000,
    maxMessageLength: 100,
    warnThresholdRatio: 0.8,
    ...overrides,
  };
}

// ─── 测试主体 ─────────────────────────────────────────────────────────────────

describe("MessageTurnGuardrails", () => {
  let guardrails: MessageTurnGuardrails;

  beforeEach(() => {
    guardrails = new MessageTurnGuardrails(smallConfig());
  });

  describe("消息长度护栏", () => {
    it("超过 maxMessageLength 应触发 block", () => {
      guardrails.startTurn("t1", ["user1"]);
      const longContent = "a".repeat(101);
      const results = guardrails.evaluate({
        turnId: "t1",
        senderId: "user1",
        content: longContent,
      });
      const lenRule = results.find((r) => r.rule === "max-message-length");
      expect(lenRule).toBeDefined();
      expect(lenRule!.action).toBe("block");
      expect(lenRule!.current).toBe(101);
      expect(lenRule!.threshold).toBe(100);
    });

    it("达到 warn 阈值应触发 warn", () => {
      guardrails.startTurn("t1", ["user1"]);
      const warnContent = "a".repeat(80); // 80% of 100
      const results = guardrails.evaluate({
        turnId: "t1",
        senderId: "user1",
        content: warnContent,
      });
      const lenRule = results.find((r) => r.rule === "max-message-length");
      expect(lenRule).toBeDefined();
      expect(lenRule!.action).toBe("warn");
    });

    it("短消息不触发任何护栏", () => {
      guardrails.startTurn("t1", ["user1"]);
      const results = guardrails.evaluate({
        turnId: "t1",
        senderId: "user1",
        content: "hi",
      });
      // 第一条消息可能触发 turn rate warn（因 startTurn 一次）
      // 但不应触发 max-message-length
      const lenRule = results.find((r) => r.rule === "max-message-length");
      expect(lenRule).toBeUndefined();
    });
  });

  describe("单回合消息数护栏", () => {
    it("超过 maxMessagesPerTurn 应触发 block", () => {
      guardrails.startTurn("t1", ["user1"]);
      // maxMessagesPerTurn=5，发 6 条
      for (let i = 0; i < 5; i++) {
        guardrails.evaluate({
          turnId: "t1",
          senderId: "user1",
          content: "msg",
        });
      }
      const results = guardrails.evaluate({
        turnId: "t1",
        senderId: "user1",
        content: "msg6",
      });
      const cntRule = results.find((r) => r.rule === "max-messages-per-turn");
      expect(cntRule).toBeDefined();
      expect(cntRule!.action).toBe("block");
      expect(cntRule!.current).toBe(6);
      expect(cntRule!.threshold).toBe(5);
    });

    it("达到 warn 阈值应触发 warn", () => {
      guardrails.startTurn("t1", ["user1"]);
      // max=5, warnThresholdRatio=0.8 → warn>=4
      for (let i = 0; i < 3; i++) {
        guardrails.evaluate({
          turnId: "t1",
          senderId: "user1",
          content: "msg",
        });
      }
      const results = guardrails.evaluate({
        turnId: "t1",
        senderId: "user1",
        content: "msg4",
      });
      const cntRule = results.find((r) => r.rule === "max-messages-per-turn");
      expect(cntRule).toBeDefined();
      expect(cntRule!.action).toBe("warn");
    });
  });

  describe("回合持续时间护栏", () => {
    it("超过 maxTurnDurationMs 应触发 block", () => {
      // 用绝对时间戳避免与 now 冲突；start=0s, msg=12s, max=10s → duration 12s 严格大于 10s
      const start = new Date(0);
      guardrails.startTurn("t1", ["user1"], start);
      const results = guardrails.evaluate({
        turnId: "t1",
        senderId: "user1",
        content: "msg",
        timestamp: new Date(12_000),
      });
      const durRule = results.find((r) => r.rule === "max-turn-duration");
      expect(durRule).toBeDefined();
      expect(durRule!.action).toBe("block");
      expect(durRule!.current).toBeGreaterThanOrEqual(10_000);
    });

    it("达到 warn 阈值应触发 warn", () => {
      const start = new Date(1000);
      guardrails.startTurn("t1", ["user1"], start);
      // 8s 后发消息（max=10s, warn>=8s）
      const results = guardrails.evaluate({
        turnId: "t1",
        senderId: "user1",
        content: "msg",
        timestamp: new Date(9_000),
      });
      const durRule = results.find((r) => r.rule === "max-turn-duration");
      expect(durRule).toBeDefined();
      expect(durRule!.action).toBe("warn");
    });
  });

  describe("回合速率护栏", () => {
    it("超过 maxTurnsPerMinute 应触发 block", () => {
      const base = Date.now();
      // 该 sender 启动 4 个回合（max=3）
      guardrails.startTurn("t1", ["user1"], new Date(base));
      guardrails.startTurn("t2", ["user1"], new Date(base + 100));
      guardrails.startTurn("t3", ["user1"], new Date(base + 200));
      guardrails.startTurn("t4", ["user1"], new Date(base + 300));
      // 第 4 个回合发消息时 turnsLastMin=4 > 3
      const results = guardrails.evaluate({
        turnId: "t4",
        senderId: "user1",
        content: "msg",
        timestamp: new Date(base + 400),
      });
      const rateRule = results.find((r) => r.rule === "max-turns-per-minute");
      expect(rateRule).toBeDefined();
      expect(rateRule!.action).toBe("block");
    });

    it("达到 warn 阈值应触发 warn", () => {
      const base = Date.now();
      // max=3, warn>=3*0.8=2.4 → 3 个回合时触发 warn
      guardrails.startTurn("t1", ["user1"], new Date(base));
      guardrails.startTurn("t2", ["user1"], new Date(base + 100));
      guardrails.startTurn("t3", ["user1"], new Date(base + 200));
      const results = guardrails.evaluate({
        turnId: "t3",
        senderId: "user1",
        content: "msg",
        timestamp: new Date(base + 300),
      });
      const rateRule = results.find((r) => r.rule === "max-turns-per-minute");
      expect(rateRule).toBeDefined();
      expect(rateRule!.action).toBe("warn");
    });
  });

  describe("warn 阈值比例", () => {
    it("warnThresholdRatio=0.5 应在 50% 时触发 warn", () => {
      const g = new MessageTurnGuardrails(
        smallConfig({ warnThresholdRatio: 0.5, maxMessagesPerTurn: 10 }),
      );
      g.startTurn("t1", ["u1"]);
      // 第 5 条触发 warn（50% of 10）
      for (let i = 0; i < 4; i++) {
        g.evaluate({ turnId: "t1", senderId: "u1", content: "m" });
      }
      const results = g.evaluate({
        turnId: "t1",
        senderId: "u1",
        content: "m5",
      });
      const cntRule = results.find((r) => r.rule === "max-messages-per-turn");
      expect(cntRule).toBeDefined();
      expect(cntRule!.action).toBe("warn");
    });
  });

  describe("startTurn / endTurn", () => {
    it("startTurn 应创建 TurnContext", () => {
      const ctx = guardrails.startTurn("t1", ["u1", "u2"]);
      expect(ctx.turnId).toBe("t1");
      expect(ctx.participantIds).toEqual(["u1", "u2"]);
      expect(ctx.messageCount).toBe(0);
      expect(ctx.ended).toBe(false);
      expect(guardrails.getTurn("t1")).toBe(ctx);
    });

    it("对已存在未结束的 startTurn 应刷新参与者", () => {
      guardrails.startTurn("t1", ["u1"]);
      guardrails.startTurn("t1", ["u2"]);
      const ctx = guardrails.getTurn("t1");
      expect(ctx!.participantIds).toEqual(["u1", "u2"]);
    });

    it("endTurn 应标记 ended=true 但保留上下文", () => {
      guardrails.startTurn("t1", ["u1"]);
      guardrails.endTurn("t1");
      const ctx = guardrails.getTurn("t1");
      expect(ctx).toBeDefined();
      expect(ctx!.ended).toBe(true);
    });

    it("已结束的回合上 evaluate 应返回 turn-ended warn", () => {
      guardrails.startTurn("t1", ["u1"]);
      guardrails.endTurn("t1");
      const results = guardrails.evaluate({
        turnId: "t1",
        senderId: "u1",
        content: "msg",
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.rule).toBe("turn-ended");
      expect(results[0]!.action).toBe("warn");
    });

    it("endTurn 未知 turnId 应静默无操作", () => {
      expect(() => guardrails.endTurn("unknown")).not.toThrow();
    });
  });

  describe("getTurn", () => {
    it("未启动的 turnId 应返回 undefined", () => {
      expect(guardrails.getTurn("nope")).toBeUndefined();
    });

    it("evaluate 自动创建 TurnContext（若未 startTurn）", () => {
      const results = guardrails.evaluate({
        turnId: "auto-turn",
        senderId: "u1",
        content: "hi",
      });
      // 第一条消息不应触发护栏
      expect(results).toEqual([]);
      const ctx = guardrails.getTurn("auto-turn");
      expect(ctx).toBeDefined();
      expect(ctx!.messageCount).toBe(1);
      expect(ctx!.participantIds).toEqual(["u1"]);
    });
  });

  describe("prune", () => {
    it("应清理 startedAt 早于 olderThanMs 的回合", () => {
      const old = new Date(Date.now() - 100_000);
      guardrails.startTurn("t1", ["u1"], old);
      guardrails.startTurn("t2", ["u1"], new Date());
      const removed = guardrails.prune(50_000);
      expect(removed).toBe(1);
      expect(guardrails.getTurn("t1")).toBeUndefined();
      expect(guardrails.getTurn("t2")).toBeDefined();
    });

    it("prune 应同时清理 turnEvents 中过期项", () => {
      const old = new Date(Date.now() - 100_000);
      guardrails.startTurn("t1", ["u1"], old);
      guardrails.prune(50_000);
      // 之后 u1 启动新回合不应携带过期计数
      guardrails.startTurn("t2", ["u1"]);
      const results = guardrails.evaluate({
        turnId: "t2",
        senderId: "u1",
        content: "m",
      });
      const rateRule = results.find((r) => r.rule === "max-turns-per-minute");
      expect(rateRule).toBeUndefined();
    });

    it("无过期回合时 prune 返回 0", () => {
      guardrails.startTurn("t1", ["u1"], new Date());
      expect(guardrails.prune(60_000)).toBe(0);
    });
  });

  describe("多 senders", () => {
    it("不同 sender 的 turnEvents 应独立计数", () => {
      const base = Date.now();
      guardrails.startTurn("t1", ["u1"], new Date(base));
      guardrails.startTurn("t2", ["u1"], new Date(base + 100));
      // u2 仅启动 1 个回合
      guardrails.startTurn("t3", ["u2"], new Date(base + 200));
      const results = guardrails.evaluate({
        turnId: "t3",
        senderId: "u2",
        content: "m",
        timestamp: new Date(base + 300),
      });
      const rateRule = results.find((r) => r.rule === "max-turns-per-minute");
      expect(rateRule).toBeUndefined(); // u2 仅 1 次
    });

    it("参与者应被加入 TurnContext.participantIds", () => {
      guardrails.startTurn("t1", ["u1"]);
      guardrails.evaluate({ turnId: "t1", senderId: "u2", content: "m" });
      guardrails.evaluate({ turnId: "t1", senderId: "u3", content: "m" });
      const ctx = guardrails.getTurn("t1");
      expect(ctx!.participantIds).toEqual(["u1", "u2", "u3"]);
    });

    it("evaluate 应累计 totalChars", () => {
      guardrails.startTurn("t1", ["u1"]);
      guardrails.evaluate({ turnId: "t1", senderId: "u1", content: "abc" });
      guardrails.evaluate({ turnId: "t1", senderId: "u1", content: "de" });
      const ctx = guardrails.getTurn("t1");
      expect(ctx!.totalChars).toBe(5);
      expect(ctx!.messageCount).toBe(2);
    });
  });

  describe("默认配置", () => {
    it("DEFAULT_TURN_GUARDRAILS_CONFIG 应有合理默认值", () => {
      expect(DEFAULT_TURN_GUARDRAILS_CONFIG.maxMessagesPerTurn).toBe(20);
      expect(DEFAULT_TURN_GUARDRAILS_CONFIG.maxTurnsPerMinute).toBe(10);
      expect(DEFAULT_TURN_GUARDRAILS_CONFIG.maxTurnDurationMs).toBe(5 * 60 * 1000);
      expect(DEFAULT_TURN_GUARDRAILS_CONFIG.maxMessageLength).toBe(4000);
      expect(DEFAULT_TURN_GUARDRAILS_CONFIG.warnThresholdRatio).toBe(0.8);
    });

    it("getConfig 应返回配置副本", () => {
      const g = new MessageTurnGuardrails({ maxMessagesPerTurn: 42 });
      const cfg = g.getConfig();
      expect(cfg.maxMessagesPerTurn).toBe(42);
      // 修改返回值不应影响内部配置
      cfg.maxMessagesPerTurn = 1;
      expect(g.getConfig().maxMessagesPerTurn).toBe(42);
    });
  });

  describe("无配置参数构造", () => {
    it("应使用默认配置且不报错", () => {
      const g = new MessageTurnGuardrails();
      g.startTurn("t1", ["u1"]);
      const results = g.evaluate({
        turnId: "t1",
        senderId: "u1",
        content: "hi",
      });
      expect(results).toEqual([]);
    });
  });
});
