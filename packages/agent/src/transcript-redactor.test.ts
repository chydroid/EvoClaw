import { describe, it, expect } from "vitest";
import {
  redactValueDeep,
  redactToolCalls,
  redactContent,
  redactMetadata,
  redactSessionTurn,
} from "./transcript-redactor";

const SECRET = "DCq4QHXN46bMPCc9";

describe("transcript-redactor", () => {
  describe("redactValueDeep", () => {
    it("★ 敏感键的值整体打码，不保留任何片段", () => {
      const out = redactValueDeep({ email: "a@b.com", password: SECRET }) as Record<string, unknown>;
      expect(out.password).toBe("[REDACTED]");
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(out.email).toBe("a@b.com");
    });

    it("命中多种敏感键名（token/secret/apiKey/授权码）", () => {
      const out = redactValueDeep({
        token: "aaa", secret: "bbb", apiKey: "ccc", 授权码: "ddd", access_key: "eee",
      }) as Record<string, unknown>;
      expect(Object.values(out).every((v) => v === "[REDACTED]")).toBe(true);
    });

    it("递归处理嵌套对象与数组", () => {
      const out = redactValueDeep({ a: { b: [{ password: SECRET }] } }) as any;
      expect(out.a.b[0].password).toBe("[REDACTED]");
    });

    it("非字符串值不会被打码", () => {
      const out = redactValueDeep({ password: 12345, ok: true }) as Record<string, unknown>;
      expect(out.password).toBe(12345);
    });
  });

  describe("redactToolCalls", () => {
    it("★ 打码后 arguments 仍是可解析的合法 JSON", () => {
      const tcs = [{
        id: "call_1", type: "function",
        function: { name: "email_add_account", arguments: JSON.stringify({ email: "a@b.com", password: SECRET }) },
      }];
      const out = redactToolCalls(tcs) as any[];
      expect(() => JSON.parse(out[0].function.arguments)).not.toThrow();
      expect(JSON.parse(out[0].function.arguments).password).toBe("[REDACTED]");
      expect(out[0].function.arguments).not.toContain(SECRET);
    });

    it("arguments 非 JSON 时退化为文本脱敏且不抛异常", () => {
      const out = redactToolCalls([{ function: { name: "x", arguments: "授权码 " + SECRET } }]) as any[];
      expect(out[0].function.arguments).not.toContain(SECRET);
    });

    it("非数组输入原样返回", () => {
      expect(redactToolCalls(undefined)).toBe(undefined);
    });
  });

  describe("redactContent", () => {
    it("散文中复述的授权码被打码", () => {
      const out = redactContent(`密码填授权码 ${SECRET} 拉取收件箱`);
      expect(out).not.toContain(SECRET);
      expect(out).toContain("[REDACTED:");
    });

    it("null / undefined 安全穿透", () => {
      expect(redactContent(null)).toBe(null);
      expect(redactContent(undefined)).toBe(undefined);
    });
  });

  describe("redactMetadata", () => {
    it("tool_calls 走专用通道，其余递归", () => {
      const out = redactMetadata({
        tool_calls: [{ function: { name: "email_add_account", arguments: JSON.stringify({ password: SECRET }) } }],
        round: 2,
      }) as any;
      expect(out.tool_calls[0].function.arguments).not.toContain(SECRET);
      expect(out.round).toBe(2);
    });
  });

  describe("redactSessionTurn", () => {
    it("★ SessionTurn 的 content / toolCalls.arguments / toolResult 全部脱敏", () => {
      const turn = {
        turnIndex: 1,
        role: "assistant" as const,
        content: `已使用授权码 ${SECRET}`,
        timestamp: "2026-10-07T00:00:00.000Z",
        toolCalls: [{ id: "c1", name: "email_add_account", arguments: { password: SECRET } }],
        toolResult: { success: true, password: SECRET },
      };
      const out = redactSessionTurn(turn);
      expect(out.content).not.toContain(SECRET);
      expect(out.toolCalls![0].arguments.password).toBe("[REDACTED]");
      expect((out.toolResult as any).password).toBe("[REDACTED]");
      // 元数据不被破坏
      expect(out.turnIndex).toBe(1);
      expect(out.timestamp).toBe(turn.timestamp);
    });

    it("不修改原对象", () => {
      const turn = { role: "user" as const, content: `授权码 ${SECRET}`, turnIndex: 0, timestamp: "" };
      const copy = JSON.parse(JSON.stringify(turn));
      redactSessionTurn(turn);
      expect(turn).toEqual(copy);
    });
  });
});
