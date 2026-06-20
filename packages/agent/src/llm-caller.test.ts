import { describe, it, expect, beforeEach } from "vitest";
import * as http from "http";
import { isProviderSafetyRejection, nativeFetch, ProviderHealthTracker } from "./llm-caller";

// ═══════════════════════════════════════════════════════════
// 测试套件：LLM Caller 安全过滤拒绝检测
// 覆盖：Mimo 等远程提供商返回的纯文本拒绝信息
// ═══════════════════════════════════════════════════════════

describe("llm-caller > isProviderSafetyRejection", () => {
  // TC-001: 精确匹配 Mimo 高风险拒绝文案
  it("TC-001: 应识别 Mimo 高风险拒绝文案", () => {
    expect(
      isProviderSafetyRejection(
        "The request was rejected because it was considered high risk",
      ),
    ).toBe(true);
  });

  // TC-002: 大小写不敏感
  it("TC-002: 大小写不敏感", () => {
    expect(
      isProviderSafetyRejection(
        "the request was rejected because it was considered high risk",
      ),
    ).toBe(true);
    expect(
      isProviderSafetyRejection(
        "THE REQUEST WAS REJECTED BECAUSE IT WAS CONSIDERED HIGH RISK",
      ),
    ).toBe(true);
  });

  // TC-003: 部分匹配
  it("TC-003: 应识别包含核心短语的拒绝文案", () => {
    expect(isProviderSafetyRejection("This request was considered high risk.")).toBe(true);
    expect(isProviderSafetyRejection("rejected due to safety concerns")).toBe(true);
    expect(isProviderSafetyRejection("content filter triggered")).toBe(true);
    expect(isProviderSafetyRejection("Your input was blocked by the filter")).toBe(true);
    expect(isProviderSafetyRejection("request was blocked")).toBe(true);
  });

  // TC-004: 非拒绝文案不应误伤
  it("TC-004: 正常回复不应被识别为安全拒绝", () => {
    expect(isProviderSafetyRejection("信阳市平桥区明天日出 05:20，日落 19:35。")).toBe(false);
    expect(isProviderSafetyRejection("这是一个高风险投资，请谨慎。")).toBe(false);
    expect(isProviderSafetyRejection("")).toBe(false);
  });

  // TC-005: 空值处理
  it("TC-005: 空值/未定义值应返回 false", () => {
    expect(isProviderSafetyRejection(null)).toBe(false);
    expect(isProviderSafetyRejection(undefined)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 测试套件：nativeFetch 超时控制
// ═══════════════════════════════════════════════════════════

describe("llm-caller > nativeFetch", () => {
  it("应在指定超时时间内中断慢响应请求", async () => {
    const server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end("ok");
      }, 500);
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      await expect(
        nativeFetch(`http://127.0.0.1:${port}/slow`, { timeout: 100 })
      ).rejects.toThrow(/timeout|aborted/i);
    } finally {
      server.close();
    }
  });

  it("正常响应不应被短超时误杀", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("pong");
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const res = await nativeFetch(`http://127.0.0.1:${port}/fast`, { timeout: 2000 });
      expect(res.ok).toBe(true);
      expect(await res.text()).toBe("pong");
    } finally {
      server.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 测试套件：ProviderHealthTracker 熔断与健康度评估
// ═══════════════════════════════════════════════════════════

describe("llm-caller > ProviderHealthTracker", () => {
  let tracker: ProviderHealthTracker;

  beforeEach(() => {
    tracker = new ProviderHealthTracker(2, 1000);
  });

  it("连续成功应重置失败计数", () => {
    tracker.recordFailure("p1");
    tracker.recordSuccess("p1");
    tracker.recordFailure("p1");
    expect(tracker.isTripped("p1")).toBe(false);
    tracker.recordFailure("p1");
    expect(tracker.isTripped("p1")).toBe(true);
  });

  it("熔断冷却后应恢复可用", async () => {
    tracker.recordFailure("p1");
    tracker.recordFailure("p1");
    expect(tracker.isTripped("p1")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(tracker.isTripped("p1")).toBe(false);
  });

  it("应正确统计成功率与平均响应时间", () => {
    tracker.recordSuccess("p1", 100);
    tracker.recordSuccess("p1", 200);
    tracker.recordFailure("p1");

    const snap = tracker.getSnapshot("p1");
    expect(snap.totalSuccesses).toBe(2);
    expect(snap.totalFailures).toBe(1);
    expect(snap.consecutiveFailures).toBe(1);
    expect(snap.averageResponseMs).toBe(150);
    expect(snap.tripped).toBe(false);
  });

  it("reset 应清空指定 provider 状态", () => {
    tracker.recordFailure("p1");
    tracker.recordFailure("p1");
    tracker.reset("p1");
    expect(tracker.isTripped("p1")).toBe(false);
    expect(tracker.getSnapshot("p1").totalFailures).toBe(0);
  });
});
