import { describe, it, expect, beforeEach } from "vitest";
import { CopilotRouter, type ProviderHealthInfo } from "./copilot-router";
import { classifyLLMError, LLMErrorType } from "./error-classifier";
import { QueueManager, QueueDrainingError, type QueueLane } from "./queue-manager";

// ═══════════════════════════════════════════════════════════
// 测试套件 3: 增强功能（copilot-router缓存/健康感知 + queue-manager车道/generation）
// 覆盖：多步骤任务、插件调用场景、技能组合、边界条件、异常输入
// ═══════════════════════════════════════════════════════════

// ── Mock EventBus ──────────────────────────────────────────
const mockEventBus = {
  publish: () => {},
  subscribe: () => () => {},
  unsubscribe: () => {},
};

// ═══════════════════════════════════════════════════════════
// CopilotRouter 缓存与健康感知
// ═══════════════════════════════════════════════════════════

describe("CopilotRouter > 路由缓存", () => {
  let router: CopilotRouter;

  beforeEach(() => {
    router = new CopilotRouter({
      userProviders: [
        { id: "deepseek", name: "DeepSeek", enabled: true, order: 1, selectedModel: "deepseek-chat", baseURL: "https://api.deepseek.com" },
      ],
      cacheTtlMs: 5000,
      cacheMaxEntries: 10,
    });
  });

  // TC-043: 缓存命中
  it("TC-043: 相同输入第二次命中缓存", () => {
    const result1 = router.route("Hello", "claude-3-opus", "anthropic");
    expect(result1.fromCache).toBeFalsy();

    const result2 = router.route("Hello", "claude-3-opus", "anthropic");
    expect(result2.fromCache).toBe(true);
    expect(result2.routedModel).toBe(result1.routedModel);
  });

  // TC-044: 缓存统计
  it("TC-044: 缓存统计正确记录 hits/misses", () => {
    router.route("Hello", "claude-3-opus", "anthropic");
    router.route("Hello", "claude-3-opus", "anthropic");
    router.route("Hi", "claude-3-opus", "anthropic");

    const stats = router.getCacheStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(2);
    expect(stats.hitRate).toBeCloseTo(1 / 3, 2);
  });

  // TC-045: 清除缓存
  it("TC-045: clearCache 清除所有缓存", () => {
    router.route("Hello", "claude-3-opus", "anthropic");
    router.clearCache();
    const stats = router.getCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });
});

describe("CopilotRouter > 健康感知", () => {
  let router: CopilotRouter;

  beforeEach(() => {
    router = new CopilotRouter({
      userProviders: [
        { id: "deepseek", name: "DeepSeek", enabled: true, order: 1, selectedModel: "deepseek-chat", baseURL: "https://api.deepseek.com" },
        { id: "openai", name: "OpenAI", enabled: true, order: 2, selectedModel: "gpt-4o", baseURL: "https://api.openai.com/v1" },
      ],
    });
  });

  // TC-046: 熔断 provider 被跳过
  it("TC-046: 熔断中的 provider 被跳过，选择下一个健康 provider", () => {
    router.updateProviderHealth({
      providerId: "deepseek",
      healthScore: 0,
      circuitOpen: true,
      avgLatencyMs: 5000,
    });

    const result = router.route("Hello", "claude-3-opus", "anthropic");
    expect(result.shouldDowngrade).toBe(true);
    // deepseek 熔断，应路由到 openai
    expect(result.routedProvider).toBe("openai");
  });

  // TC-047: 所有 provider 熔断时回退到第一个
  it("TC-047: 所有 provider 熔断时回退到第一个已启用 provider", () => {
    router.updateProviderHealthBatch([
      { providerId: "deepseek", healthScore: 0, circuitOpen: true, avgLatencyMs: 5000 },
      { providerId: "openai", healthScore: 0, circuitOpen: true, avgLatencyMs: 5000 },
    ]);

    const result = router.route("Hello", "claude-3-opus", "anthropic");
    expect(result.shouldDowngrade).toBe(true);
    // 全部熔断，回退到第一个（deepseek）
    expect(result.routedProvider).toBe("deepseek");
  });

  // TC-048: 规则匹配但目标 provider 熔断时不降级
  it("TC-048: 规则匹配但目标 provider 熔断 → 不降级", () => {
    router.addRule({
      pattern: /^hello/i,
      targetModel: "deepseek-chat",
      targetProvider: "deepseek",
      description: "Hello rule",
    });
    router.updateProviderHealth({
      providerId: "deepseek",
      healthScore: 0,
      circuitOpen: true,
      avgLatencyMs: 5000,
    });

    const result = router.route("Hello there", "claude-3-opus", "anthropic");
    expect(result.shouldDowngrade).toBe(false);
    expect(result.reason).toContain("circuit open");
  });

  // TC-049: provider 恢复后清除缓存重新路由
  it("TC-049: provider 恢复健康后重新路由到该 provider", () => {
    // 先熔断 deepseek
    router.updateProviderHealth({
      providerId: "deepseek",
      healthScore: 0,
      circuitOpen: true,
      avgLatencyMs: 5000,
    });
    let result = router.route("Hello", "claude-3-opus", "anthropic");
    expect(result.routedProvider).toBe("openai");

    // deepseek 恢复
    router.updateProviderHealth({
      providerId: "deepseek",
      healthScore: 100,
      circuitOpen: false,
      avgLatencyMs: 200,
    });
    result = router.route("Hello", "claude-3-opus", "anthropic");
    expect(result.routedProvider).toBe("deepseek");
  });
});

// ═══════════════════════════════════════════════════════════
// QueueManager 命名车道与 generation
// ═══════════════════════════════════════════════════════════

describe("QueueManager > 命名车道", () => {
  let qm: QueueManager;

  beforeEach(() => {
    qm = new QueueManager(mockEventBus as any, { persistQueue: false });
  });

  // TC-050: 不同车道独立并发
  it("TC-050: main 车道任务不影响 cron 车道", () => {
    qm.enqueue("s1", "main task", "steer", {}, undefined, "main");
    qm.enqueue("s1", "cron task", "steer", {}, undefined, "cron");

    const mainStats = qm.getLaneStats("main");
    const cronStats = qm.getLaneStats("cron");

    expect(mainStats.pending).toBe(1);
    expect(cronStats.pending).toBe(1);
    expect(mainStats.maxConcurrent).toBe(3);
    expect(cronStats.maxConcurrent).toBe(2);
  });

  // TC-051: 车道并发上限控制
  it("TC-051: 车道并发满时 dequeue 跳过该车道任务", () => {
    // nested 车道并发上限为 1
    qm.enqueue("s1", "task1", "steer", {}, undefined, "nested");
    qm.enqueue("s1", "task2", "steer", {}, undefined, "nested");

    // 取出第一个
    const item1 = qm.dequeue("s1");
    expect(item1).toBeDefined();
    expect(item1!.lane).toBe("nested");

    // 第二个应被跳过（nested 并发已满）
    const item2 = qm.dequeue("s1");
    expect(item2).toBeUndefined();
  });

  // TC-052: clearLane 清空指定车道
  it("TC-052: clearLane 只清空指定车道", () => {
    qm.enqueue("s1", "main task", "steer", {}, undefined, "main");
    qm.enqueue("s1", "cron task", "steer", {}, undefined, "cron");

    const cleared = qm.clearLane("cron");
    expect(cleared).toBe(1);

    const mainStats = qm.getLaneStats("main");
    const cronStats = qm.getLaneStats("cron");
    expect(mainStats.pending).toBe(1);
    expect(cronStats.pending).toBe(0);
  });
});

describe("QueueManager > generation 与排空", () => {
  let qm: QueueManager;

  beforeEach(() => {
    qm = new QueueManager(mockEventBus as any, { persistQueue: false });
  });

  // TC-053: generation 标记
  it("TC-053: 入队任务携带当前 generation", () => {
    const item = qm.enqueue("s1", "task", "steer");
    expect(item.generation).toBe(0);
  });

  // TC-054: bumpGeneration 后新任务使用新 generation
  it("TC-054: bumpGeneration 后新任务 generation 递增", () => {
    const gen = qm.bumpGeneration();
    expect(gen).toBe(1);

    const item = qm.enqueue("s1", "new task", "steer");
    expect(item.generation).toBe(1);
  });

  // TC-055: getStaleTasks 识别旧 generation 任务
  it("TC-055: getStaleTasks 返回旧 generation 的任务", () => {
    qm.enqueue("s1", "old task", "steer");
    qm.bumpGeneration();
    qm.enqueue("s1", "new task", "steer");

    const stale = qm.getStaleTasks();
    expect(stale.length).toBe(1);
    expect(stale[0].message).toBe("old task");
  });

  // TC-056: 排空模式拒绝入队
  it("TC-056: 排空模式时 enqueue 抛出 QueueDrainingError", () => {
    qm.startDraining();
    expect(qm.isDraining()).toBe(true);
    expect(() => qm.enqueue("s1", "task", "steer")).toThrow(QueueDrainingError);
  });

  // TC-057: 停止排空后恢复入队
  it("TC-057: stopDraining 后恢复入队", () => {
    qm.startDraining();
    qm.stopDraining();
    expect(qm.isDraining()).toBe(false);
    const item = qm.enqueue("s1", "task", "steer");
    expect(item).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// ErrorClassifier jitter 验证
// ═══════════════════════════════════════════════════════════

describe("ErrorClassifier > jitter 与 transient 增强", () => {
  // TC-058: 429 错误携带 transient 标记
  it("TC-058: 429 错误标记为 transient 且携带 reason", () => {
    const result = classifyLLMError(429);
    expect(result.type).toBe(LLMErrorType.RATE_LIMIT);
    expect(result.isTransient).toBe(true);
    expect(result.reason).toBe("rate_limit");
  });

  // TC-059: Retry-After 契约标记
  it("TC-059: 含 retry-after 的错误标记 hasRetryAfterContract", () => {
    const result = classifyLLMError(undefined, "rate limit, retry after 30 seconds");
    expect(result.type).toBe(LLMErrorType.RATE_LIMIT);
    expect(result.hasRetryAfterContract).toBe(true);
  });

  // TC-060: auth 错误标记为 non-transient
  it("TC-060: auth 错误标记为 non-transient", () => {
    const result = classifyLLMError(401);
    expect(result.type).toBe(LLMErrorType.AUTH);
    expect(result.isTransient).toBe(false);
    expect(result.reason).toBe("auth");
  });

  // TC-061: jitter 使 backoffMs 有随机性
  it("TC-061: 多次分类 429 产生不同的 backoffMs（jitter 随机性）", () => {
    const backoffs = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const result = classifyLLMError(429);
      backoffs.add(result.backoffMs);
    }
    // jitter 应产生至少 2 个不同的值
    expect(backoffs.size).toBeGreaterThanOrEqual(2);
  });

  // TC-062: timeout 错误携带 transient 标记
  it("TC-062: timeout 错误标记为 transient", () => {
    const result = classifyLLMError(undefined, "request timed out");
    expect(result.type).toBe(LLMErrorType.TIMEOUT);
    expect(result.isTransient).toBe(true);
    expect(result.reason).toBe("timeout");
  });
});
