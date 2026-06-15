// v0.35 提升 - Agent package综合测试
import { describe, it, expect, beforeEach } from "vitest";
import {
  LazySkillLoader,
  FirstEventTracer,
  TokenUsageTracker,
  SessionUndoManager,
  SessionFTSSearch,
  DEFAULT_MODEL_COSTS,
  type ModelCostInfo,
} from "./index";

describe("LazySkillLoader", () => {
  it("should lazy load skills on first access", async () => {
    const loader = new LazySkillLoader();
    let loadCount = 0;
    loader.register({
      name: "test",
      description: "test skill",
      category: "utility",
      loader: () => {
        loadCount++;
        return { name: "test", description: "test", execute: () => "ok" } as any;
      },
    });
    expect(loader.isLoaded("test")).toBe(false);
    const cmd = await loader.get("test");
    expect(cmd).toBeDefined();
    expect(loadCount).toBe(1);
    expect(loader.isLoaded("test")).toBe(true);
    // 第二次应使用缓存
    await loader.get("test");
    expect(loadCount).toBe(1);
  });

  it("should list metadata without loading", () => {
    const loader = new LazySkillLoader();
    loader.register({
      name: "a", description: "A", category: "utility",
      loader: () => ({ name: "a" } as any),
    });
    const meta = loader.listMetadata();
    expect(meta.length).toBe(1);
    expect(meta[0].status).toBe("unloaded");
  });

  it("should track hit rate", async () => {
    const loader = new LazySkillLoader();
    loader.register({
      name: "t", description: "T", category: "utility",
      loader: () => ({ name: "t" } as any),
    });
    await loader.get("t");
    await loader.get("t");
    const stats = loader.getStats();
    expect(stats.loads).toBe(1);
    expect(stats.cacheHits).toBe(1);
  });
});

describe("FirstEventTracer", () => {
  it("should track full lifecycle", () => {
    const tracer = new FirstEventTracer({ slowThresholdMs: 100 });
    const id = "trace-1";
    tracer.enqueue(id, { sessionId: "s1", promptLength: 100 });
    tracer.dispatched(id);
    tracer.firstToken(id);
    tracer.firstEvent(id, "content");
    tracer.complete(id, 50);
    const trace = tracer.get(id);
    expect(trace?.stage).toBe("completed");
    expect(trace?.ttftMs).toBeGreaterThanOrEqual(0);
    expect(trace?.ttfeMs).toBeGreaterThanOrEqual(0);
    expect(trace?.totalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("should detect slow responses", async () => {
    let slowDetected = false;
    const tracer = new FirstEventTracer({
      slowThresholdMs: 10,
      onSlow: () => { slowDetected = true; },
    });
    const id = "slow-1";
    tracer.enqueue(id, { sessionId: "s1", promptLength: 50 });
    await new Promise((r) => setTimeout(r, 20));
    tracer.firstEvent(id);
    expect(slowDetected).toBe(true);
  });

  it("should record error", () => {
    const tracer = new FirstEventTracer();
    const id = "err-1";
    tracer.enqueue(id, { sessionId: "s1", promptLength: 0 });
    tracer.error(id, "test error");
    const trace = tracer.get(id);
    expect(trace?.stage).toBe("error");
    expect(trace?.error).toBe("test error");
  });
});

describe("TokenUsageTracker", () => {
  it("should record and aggregate usage", () => {
    const tracker = new TokenUsageTracker();
    tracker.record({
      sessionId: "s1",
      provider: "openai",
      model: "gpt-4",
      inputTokens: 1000,
      outputTokens: 500,
    });
    tracker.record({
      sessionId: "s1",
      provider: "openai",
      model: "gpt-4",
      inputTokens: 2000,
      outputTokens: 1000,
    });
    const cost = tracker.getSessionCost("s1");
    expect(cost.inputTokens).toBe(3000);
    expect(cost.outputTokens).toBe(1500);
    expect(cost.calls).toBe(2);
  });

  it("should aggregate by provider", () => {
    const tracker = new TokenUsageTracker();
    tracker.record({ sessionId: "s", provider: "openai", model: "gpt-4", inputTokens: 100, outputTokens: 50 });
    tracker.record({ sessionId: "s", provider: "anthropic", model: "claude", inputTokens: 200, outputTokens: 100 });
    const summary = tracker.getSummary();
    expect(summary.byProvider["openai"]).toBeDefined();
    expect(summary.byProvider["anthropic"]).toBeDefined();
  });

  it("should use model cost from cache", () => {
    // 创建一个mock的ModelCostProvider
    const costMap = new Map<string, ModelCostInfo>();
    for (const c of DEFAULT_MODEL_COSTS) {
      costMap.set(`${c.provider}:${c.model}`, c);
    }
    const cache = {
      getModelCost: (provider: string, model: string) => costMap.get(`${provider}:${model}`),
    };
    const tracker = new TokenUsageTracker({ cache });
    tracker.record({
      sessionId: "s",
      provider: "openai",
      model: "gpt-4",
      inputTokens: 1000,
      outputTokens: 1000,
    });
    const recent = tracker.getRecent(1);
    // GPT-4: 0.03/0.06 per 1K
    expect(recent[0].inputCost).toBeCloseTo(0.03, 5);
    expect(recent[0].outputCost).toBeCloseTo(0.06, 5);
  });
});

describe("SessionUndoManager", () => {
  it("should push and undo", async () => {
    const manager = new SessionUndoManager();
    manager.push({
      sessionId: "s1",
      turnIds: ["t1", "t2"],
      lastUserMessage: "hello",
      lastAssistantMessage: "world",
    });
    manager.push({
      sessionId: "s1",
      turnIds: ["t3", "t4"],
    });
    const history = manager.getHistory("s1");
    expect(history.length).toBe(2);
    const reverted = await manager.undo("s1", 1);
    expect(reverted.length).toBe(1);
    expect(reverted[0].reverted).toBe(true);
  });

  it("should respect max size", () => {
    const manager = new SessionUndoManager({ maxUndoPerSession: 3 });
    for (let i = 0; i < 5; i++) {
      manager.push({ sessionId: "s", turnIds: [`t${i}`] });
    }
    expect(manager.getHistory("s").length).toBe(3);
  });
});

describe("SessionFTSSearch", () => {
  let search: SessionFTSSearch;
  beforeEach(() => {
    search = new SessionFTSSearch();
  });

  it("should index and search messages", () => {
    search.index({
      id: "m1",
      sessionId: "s1",
      role: "user",
      content: "How to deploy a kubernetes cluster",
      createdAt: Date.now(),
    });
    search.index({
      id: "m2",
      sessionId: "s1",
      role: "assistant",
      content: "Use kubectl apply with yaml file",
      createdAt: Date.now(),
    });
    const results = search.search("kubernetes");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].message.id).toBe("m1");
  });

  it("should support BM25-like ranking", () => {
    search.index({ id: "a", sessionId: "s", role: "user", content: "python tutorial", createdAt: Date.now() });
    search.index({ id: "b", sessionId: "s", role: "user", content: "python python python guide", createdAt: Date.now() });
    const results = search.search("python");
    expect(results[0].message.id).toBe("b"); // 频率高分数高
  });

  it("should support Chinese tokenization", () => {
    search.index({ id: "c", sessionId: "s", role: "user", content: "如何在Linux部署Kubernetes", createdAt: Date.now() });
    const results = search.search("部署");
    expect(results.length).toBeGreaterThan(0);
  });

  it("should filter by session", () => {
    search.index({ id: "x", sessionId: "s1", role: "user", content: "alpha", createdAt: Date.now() });
    search.index({ id: "y", sessionId: "s2", role: "user", content: "alpha", createdAt: Date.now() });
    const results = search.search("alpha", { sessionId: "s1" });
    expect(results.every((r) => r.message.sessionId === "s1")).toBe(true);
  });

  it("should return snippet", () => {
    search.index({ id: "z", sessionId: "s", role: "user", content: "This is a long message about deployment strategies for production", createdAt: Date.now() });
    const results = search.search("deployment");
    expect(results[0].snippet).toContain("deployment");
  });
});

describe("ModelCostInfo (default costs)", () => {
  it("should contain major providers", () => {
    const providers = new Set(DEFAULT_MODEL_COSTS.map((c) => c.provider));
    expect(providers.has("openai")).toBe(true);
    expect(providers.has("anthropic")).toBe(true);
    expect(providers.has("google")).toBe(true);
  });

  it("should have valid cost numbers", () => {
    for (const c of DEFAULT_MODEL_COSTS) {
      expect(c.inputCostPer1k).toBeGreaterThan(0);
      expect(c.outputCostPer1k).toBeGreaterThan(0);
      expect(c.contextWindow).toBeGreaterThan(0);
    }
  });

  it("should look up model cost", () => {
    const costMap = new Map<string, ModelCostInfo>();
    for (const c of DEFAULT_MODEL_COSTS) {
      costMap.set(`${c.provider}:${c.model}`, c);
    }
    const gpt4 = costMap.get("openai:gpt-4");
    expect(gpt4?.inputCostPer1k).toBe(0.03);
  });
});
