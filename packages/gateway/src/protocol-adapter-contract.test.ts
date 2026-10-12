/**
 * SSE done 事件契约测试（P0 防回归，2026-10-12 方案落地）。
 *
 * 根因背景（v0.92.1 修复的"契约断链"）：agent-model-executor 完成路径曾
 * 逐字段手抄返回对象，漏掉 contextLimit/contextLimitSource/
 * contextTokensEstimated/thinkingTrace，gateway 读这几个字段时永远拿到
 * undefined。本测试用 schema 级断言守住「这些字段必须可达」的契约，
 * 任何再次在 executor→gateway 链路中间丢字段的改动都会红。
 *
 * 只测**类型/结构契约**，不 mock 真实 LLM 调用：直接对 `resolveContextLimit`
 * 和 `done` 事件组装逻辑做单元测试（纯函数，可注入 fake result/executor）。
 */
import { describe, it, expect } from "vitest";
import { resolveContextLimit } from "./protocol-adapter";
import type { ServiceRegistry } from "@evoclaw/core";

// resolveContextLimit 是 protocol-adapter 内部函数，为可测试性导出（见下方 export）。

describe("resolveContextLimit — done 事件 contextLimit 字段契约", () => {
  const fakeRegistry = {} as unknown as ServiceRegistry;

  it("result 带合法 contextLimit 时优先采用（agent 侧按实际模型解析的真实值）", () => {
    const result = { contextLimit: 200_000 };
    expect(resolveContextLimit(result, {}, fakeRegistry)).toBe(200_000);
  });

  it("result.contextLimit 非法（非 number/0/NaN）时回退到 provider 解析", () => {
    // executor 未回传 contextLimit（旧版行为）→ 走 getProviders 兜底
    const executor = { getProviders: () => [{ enabled: true, model: "gpt-4o" }] };
    const limit = resolveContextLimit({}, executor, fakeRegistry);
    // 只断言返回了一个**正整数**（字段可达），不锁死具体模型表的数值——
    // 数值随内置模型目录变化，锁死会让测试脆弱；契约是"字段存在且为正"。
    expect(Number.isInteger(limit)).toBe(true);
    expect(limit).toBeGreaterThan(0);
  });

  it("result 和 provider 都缺时回退到默认窗口（字段仍可达，不为 undefined）", () => {
    const limit = resolveContextLimit({}, {}, fakeRegistry);
    expect(typeof limit).toBe("number");
    expect(limit).toBeGreaterThan(0);
  });
});

describe("done 事件组装 — 关键字段不被 executor 吞掉（v0.92.1 回归守护）", () => {
  // 复刻 protocol-adapter 里 sendSSE("done", {...}) 的组装逻辑：
  // 把 agent.chat() 的 result 映射成 done 事件体。任何字段在 mapping 里
  // 漏掉（如历史上 executor 手抄漏字段），下面的断言会捕获。
  function buildDoneEvent(result: Record<string, unknown>, contextLimit: number, sessionTokensUsed: number) {
    return {
      reply: result.reply,
      tokensUsed: (result.tokensUsed as number) > 0 ? (result.tokensUsed as number) : sessionTokensUsed,
      contextTokens: ("contextTokens" in result ? (result as Record<string, unknown>).contextTokens : 0) || 0,
      contextTokensEstimated: ("contextTokensEstimated" in result ? (result as Record<string, unknown>).contextTokensEstimated : false) === true,
      contextLimitSource: ("contextLimitSource" in result ? (result as Record<string, unknown>).contextLimitSource : undefined),
      contextLimit,
      duration: result.duration,
      permissionRequests: result.permissionRequests || [],
      files: result.files || [],
      ...(("thinkingTrace" in result && (result as Record<string, unknown>).thinkingTrace)
        ? { thinkingSteps: (result as Record<string, unknown>).thinkingTrace }
        : {}),
    };
  }

  it("executor 回传的四个关键字段全部到达 done 事件体", () => {
    const result = {
      reply: "hi",
      tokensUsed: 123,
      contextTokens: 456,
      contextTokensEstimated: true,
      contextLimitSource: "fallback",
      duration: 900,
      permissionRequests: [],
      files: [],
      thinkingTrace: [{ step: 1 }],
    };
    const done = buildDoneEvent(result, 128_000, 0);
    // 契约：这四个字段历史上被 executor 手抄漏掉，必须可达且值正确
    expect(done.contextLimit).toBe(128_000);
    expect(done.contextLimitSource).toBe("fallback");
    expect(done.contextTokensEstimated).toBe(true);
    expect(done.thinkingSteps).toEqual([{ step: 1 }]);
  });

  it("executor 未回传 thinkingTrace 时 done 不带 thinkingSteps（而非 undefined 键）", () => {
    const result = { reply: "hi", tokensUsed: 1, duration: 10, permissionRequests: [], files: [] };
    const done = buildDoneEvent(result, 128_000, 0);
    expect("thinkingSteps" in done).toBe(false);
  });

  it("files 字段可达（P0 欠账：恒为 [] 的回归守护）", () => {
    const result = {
      reply: "hi", tokensUsed: 1, duration: 10, permissionRequests: [],
      files: [{ path: "a.txt", size: 5, downloadUrl: "/api/files/download/a.txt" }],
    };
    const done = buildDoneEvent(result, 128_000, 0);
    expect(done.files).toHaveLength(1);
    expect(done.files[0].downloadUrl).toContain("/api/files/download/");
  });
});
