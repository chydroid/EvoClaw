import { describe, it, expect, beforeEach } from "vitest";
import {
  DiagnosticPayloadBuilder,
  DiagnosticPayloadCollector,
  DEFAULT_SENSITIVE_KEYS,
  type DiagnosticPayload,
} from "./diagnostic-payload";

describe("DiagnosticPayloadBuilder", () => {
  it("create 应生成包含 uuid / 时间戳 / severity 的载荷", () => {
    const payload = DiagnosticPayloadBuilder.create({
      severity: "warning",
      category: "session.stuck",
      message: "Session stuck in tool-call phase",
    });
    expect(payload.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(payload.timestamp).toBeInstanceOf(Date);
    expect(payload.severity).toBe("warning");
    expect(payload.category).toBe("session.stuck");
    expect(payload.message).toBe("Session stuck in tool-call phase");
    expect(payload.redacted).toBeUndefined();
  });

  it("create 应正确透传 traceId / spanId / entityId / entityType / phase / data", () => {
    const payload = DiagnosticPayloadBuilder.create({
      severity: "error",
      category: "tool.timeout",
      message: "Tool exceeded timeout",
      entityId: "session-1",
      entityType: "session",
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      phase: "tool-call",
      data: { toolName: "search", durationMs: 5000 },
    });
    expect(payload.entityId).toBe("session-1");
    expect(payload.entityType).toBe("session");
    expect(payload.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(payload.spanId).toBe("b7ad6b7169203331");
    expect(payload.phase).toBe("tool-call");
    expect(payload.data).toEqual({ toolName: "search", durationMs: 5000 });
  });

  it("create 应深拷贝 data 与 relatedPayloadIds", () => {
    const data = { count: 1 };
    const relatedIds = ["payload-1"];
    const payload = DiagnosticPayloadBuilder.create({
      severity: "info",
      category: "test",
      message: "test",
      data,
      relatedPayloadIds: relatedIds,
    });
    data.count = 999;
    relatedIds.push("payload-2");
    expect(payload.data).toEqual({ count: 1 });
    expect(payload.relatedPayloadIds).toEqual(["payload-1"]);
  });

  it("withParent 应继承父载荷的 traceId / spanId / entityId / entityType", () => {
    const parent = DiagnosticPayloadBuilder.create({
      severity: "warning",
      category: "session.stuck",
      message: "parent",
      entityId: "session-1",
      entityType: "session",
      traceId: "trace-abc",
      spanId: "span-xyz",
    });
    const child = DiagnosticPayloadBuilder.withParent(parent, {
      severity: "error",
      category: "tool.timeout",
      message: "child",
    });
    expect(child.traceId).toBe("trace-abc");
    expect(child.spanId).toBe("span-xyz");
    expect(child.entityId).toBe("session-1");
    expect(child.entityType).toBe("session");
    expect(child.parentPayloadId).toBe(parent.id);
  });

  it("redact 应替换敏感字段为占位符并标记 redacted", () => {
    const payload = DiagnosticPayloadBuilder.create({
      severity: "info",
      category: "test",
      message: "test",
      data: {
        apiKey: "sk-1234567890",
        normalField: "value",
        nested: { token: "tok-abc", other: 1 },
      },
    });
    const redacted = DiagnosticPayloadBuilder.redact(payload);
    expect(redacted.redacted).toBe(true);
    expect(redacted.redactedFields).toEqual(
      expect.arrayContaining(["apiKey", "nested.token"]),
    );
    expect(redacted.data).toEqual({
      apiKey: "***REDACTED***",
      normalField: "value",
      nested: { token: "***REDACTED***", other: 1 },
    });
    // 不应修改原 payload
    expect(payload.data).toEqual({
      apiKey: "sk-1234567890",
      normalField: "value",
      nested: { token: "tok-abc", other: 1 },
    });
  });

  it("redact 应处理数组内的对象", () => {
    const payload = DiagnosticPayloadBuilder.create({
      severity: "info",
      category: "test",
      message: "test",
      data: {
        items: [{ password: "p1" }, { password: "p2" }],
      },
    });
    const redacted = DiagnosticPayloadBuilder.redact(payload);
    expect((redacted.data as Record<string, unknown>).items).toEqual([
      { password: "***REDACTED***" },
      { password: "***REDACTED***" },
    ]);
    expect(redacted.redactedFields).toEqual(
      expect.arrayContaining(["items[0].password", "items[1].password"]),
    );
  });

  it("redact 在无敏感字段时应返回 redacted=undefined/false", () => {
    const payload = DiagnosticPayloadBuilder.create({
      severity: "info",
      category: "test",
      message: "test",
      data: { normalField: "value" },
    });
    const redacted = DiagnosticPayloadBuilder.redact(payload);
    expect(redacted.redacted).toBe(false);
    expect(redacted.redactedFields).toBeUndefined();
  });

  it("DEFAULT_SENSITIVE_KEYS 应包含 password / token / apiKey 等关键 key", () => {
    const lowerKeys = DEFAULT_SENSITIVE_KEYS.map((k) => k.toLowerCase());
    expect(lowerKeys).toContain("password");
    expect(lowerKeys).toContain("token");
    expect(lowerKeys).toContain("apikey");
    expect(lowerKeys).toContain("secret");
    expect(lowerKeys).toContain("credentials");
    expect(lowerKeys).toContain("accesstoken");
  });

  it("redact 应大小写不敏感匹配", () => {
    const payload = DiagnosticPayloadBuilder.create({
      severity: "info",
      category: "test",
      message: "test",
      data: { API_KEY: "sk-abc", ApiKey: "sk-xyz" },
    });
    const redacted = DiagnosticPayloadBuilder.redact(payload);
    expect((redacted.data as Record<string, unknown>).API_KEY).toBe("***REDACTED***");
    expect((redacted.data as Record<string, unknown>).ApiKey).toBe("***REDACTED***");
  });

  it("redact 应支持自定义 sensitiveKeys", () => {
    const payload = DiagnosticPayloadBuilder.create({
      severity: "info",
      category: "test",
      message: "test",
      data: { customSecret: "abc", password: "p" },
    });
    const redacted = DiagnosticPayloadBuilder.redact(payload, ["customsecret"]);
    expect((redacted.data as Record<string, unknown>).customSecret).toBe("***REDACTED***");
    // password 不在自定义列表里，应保持原值
    expect((redacted.data as Record<string, unknown>).password).toBe("p");
  });
});

describe("DiagnosticPayloadCollector", () => {
  let collector: DiagnosticPayloadCollector;

  beforeEach(() => {
    collector = new DiagnosticPayloadCollector({ maxSize: 5, maxAgeMs: 1000 });
  });

  it("add 应累积载荷", () => {
    const p1 = DiagnosticPayloadBuilder.create({
      severity: "info",
      category: "c1",
      message: "m1",
    });
    const p2 = DiagnosticPayloadBuilder.create({
      severity: "error",
      category: "c2",
      message: "m2",
    });
    collector.add(p1);
    collector.add(p2);
    expect(collector.size()).toBe(2);
  });

  it("add 应在超过 maxSize 时丢弃最旧条目", () => {
    for (let i = 0; i < 7; i++) {
      collector.add(
        DiagnosticPayloadBuilder.create({
          severity: "info",
          category: `c${i}`,
          message: `m${i}`,
        }),
      );
    }
    expect(collector.size()).toBe(5);
    const all = collector.query({});
    expect(all[0].category).toBe("c2");
    expect(all[4].category).toBe("c6");
  });

  it("query 应按 severity 过滤", () => {
    collector.add(
      DiagnosticPayloadBuilder.create({
        severity: "info",
        category: "c1",
        message: "m1",
      }),
    );
    collector.add(
      DiagnosticPayloadBuilder.create({
        severity: "error",
        category: "c2",
        message: "m2",
      }),
    );
    const errors = collector.query({ severity: "error" });
    expect(errors).toHaveLength(1);
    expect(errors[0].category).toBe("c2");
  });

  it("query 应按 category 过滤", () => {
    collector.add(
      DiagnosticPayloadBuilder.create({
        severity: "info",
        category: "session.stuck",
        message: "m1",
      }),
    );
    collector.add(
      DiagnosticPayloadBuilder.create({
        severity: "info",
        category: "tool.timeout",
        message: "m2",
      }),
    );
    const stuck = collector.query({ category: "session.stuck" });
    expect(stuck).toHaveLength(1);
    expect(stuck[0].message).toBe("m1");
  });

  it("query 应按 entityId 过滤", () => {
    collector.add(
      DiagnosticPayloadBuilder.create({
        severity: "info",
        category: "c",
        message: "m1",
        entityId: "session-1",
      }),
    );
    collector.add(
      DiagnosticPayloadBuilder.create({
        severity: "info",
        category: "c",
        message: "m2",
        entityId: "session-2",
      }),
    );
    const result = collector.query({ entityId: "session-1" });
    expect(result).toHaveLength(1);
    expect(result[0].entityId).toBe("session-1");
  });

  it("query 应按时间窗口过滤（after/before）", async () => {
    const t0 = new Date();
    // 等待一小段时间，确保 t0 严格早于第一个 payload 的时间戳
    await new Promise((r) => setTimeout(r, 10));
    collector.add(
      DiagnosticPayloadBuilder.create({
        severity: "info",
        category: "c",
        message: "m1",
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    const t1 = new Date();
    collector.add(
      DiagnosticPayloadBuilder.create({
        severity: "info",
        category: "c",
        message: "m2",
      }),
    );

    const after = collector.query({ after: t1 });
    expect(after).toHaveLength(1);
    expect(after[0].message).toBe("m2");

    const before = collector.query({ before: t0 });
    expect(before).toHaveLength(0);
  });

  it("query 应支持 limit 截断最新 N 条", () => {
    for (let i = 0; i < 4; i++) {
      collector.add(
        DiagnosticPayloadBuilder.create({
          severity: "info",
          category: "c",
          message: `m${i}`,
        }),
      );
    }
    const limited = collector.query({ limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0].message).toBe("m2");
    expect(limited[1].message).toBe("m3");
  });

  it("exportAll 应返回脱敏后的所有载荷", () => {
    collector.add(
      DiagnosticPayloadBuilder.create({
        severity: "info",
        category: "c",
        message: "m1",
        data: { apiKey: "sk-abc" },
      }),
    );
    const exported = collector.exportAll();
    expect(exported).toHaveLength(1);
    expect(exported[0].redacted).toBe(true);
    expect((exported[0].data as Record<string, unknown>).apiKey).toBe("***REDACTED***");
  });

  it("prune 应清理过期载荷并返回清理数量", async () => {
    collector.add(
      DiagnosticPayloadBuilder.create({
        severity: "info",
        category: "c",
        message: "m1",
      }),
    );
    await new Promise((r) => setTimeout(r, 1100));
    const removed = collector.prune();
    expect(removed).toBe(1);
    expect(collector.size()).toBe(0);
  });

  it("clear 应清空所有载荷", () => {
    collector.add(
      DiagnosticPayloadBuilder.create({
        severity: "info",
        category: "c",
        message: "m1",
      }),
    );
    collector.clear();
    expect(collector.size()).toBe(0);
  });

  it("应支持 relatedPayloadIds 关联关系", () => {
    const parent = DiagnosticPayloadBuilder.create({
      severity: "warning",
      category: "parent",
      message: "parent",
    });
    const child = DiagnosticPayloadBuilder.create({
      severity: "error",
      category: "child",
      message: "child",
      relatedPayloadIds: [parent.id],
      parentPayloadId: parent.id,
    });
    expect(child.parentPayloadId).toBe(parent.id);
    expect(child.relatedPayloadIds).toEqual([parent.id]);
  });
});
