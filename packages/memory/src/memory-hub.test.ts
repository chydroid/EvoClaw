import { describe, it, expect, beforeEach } from "vitest";
import { MemoryHub } from "./memory-hub";
import { TransformersEmbeddingProvider } from "./transformers-embedding";
import { ServiceRegistry } from "@evoclaw/core";
import { EventBus } from "@evoclaw/core";

describe("MemoryHub — Transformers embedding integration", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();
  });

  it("auto-wires TransformersEmbeddingProvider when @huggingface/transformers is installed", () => {
    const hub = new MemoryHub(registry, eventBus);
    const status = hub.getEmbeddingProviderStatus();
    if (TransformersEmbeddingProvider.isAvailable()) {
      expect(status).toBe("transformers");
      expect(hub.getEmbeddingProvider()).not.toBeNull();
      expect(hub.getVectorStore()).not.toBeNull();
      // The vector store should be registered in the service registry
      const registered = registry.resolveService("vectorMemory");
      expect(registered).toBe(hub.getVectorStore());
    } else {
      // In CI without the package installed, ensure graceful degradation
      expect(status).toBe("unavailable");
      expect(hub.getEmbeddingProvider()).toBeNull();
      expect(hub.getVectorStore()).toBeNull();
    }
  });

  it("respects useTransformers: false", () => {
    const hub = new MemoryHub(registry, eventBus, { useTransformers: false });
    expect(hub.getEmbeddingProviderStatus()).toBe("disabled");
    expect(hub.getEmbeddingProvider()).toBeNull();
  });

  it("exposes the embedding provider's dimensions (384 for all-MiniLM-L6-v2)", () => {
    const hub = new MemoryHub(registry, eventBus);
    const provider = hub.getEmbeddingProvider();
    if (provider) {
      expect(provider.dimensions).toBe(384);
    }
  });

  it("semanticSearch returns gracefully when provider unavailable", async () => {
    const hub = new MemoryHub(registry, eventBus, { useTransformers: false });
    const results = await hub.semanticSearch("anything");
    // Falls back to FTS5 — should not throw
    expect(Array.isArray(results)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// P1-3 Cron 运行间学习闭环（2026-10-12）
// ═══════════════════════════════════════════════════════════

describe("MemoryHub — Cron 运行间学习（rememberCronRun / recallCronRuns）", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();
  });

  it("rememberCronRun 成功运行 → recallCronRuns 按 jobId 召回，含结果摘要（最近优先）", async () => {
    const hub = new MemoryHub(registry, eventBus, { useTransformers: false });
    await hub.rememberCronRun({
      jobId: "job-1",
      jobName: "拉取邮件",
      success: true,
      result: "拉取到 3 封邮件",
      durationMs: 1200,
    });
    await hub.rememberCronRun({
      jobId: "job-1",
      jobName: "拉取邮件",
      success: true,
      result: "拉取到 5 封邮件",
      durationMs: 900,
    });

    // recallCronRuns 按最近运行优先（accessedAt/createdAt 降序）。
    // 磁盘 store 可能残留历史运行（LongTermMemoryStore 的 EVOCLAW_DATA_DIR 在
    // 模块加载时固定，无法按用例切换），故用 .some() 断言存在性而非精确计数。
    const recalled = await hub.recallCronRuns("job-1", 2);
    expect(recalled).toHaveLength(2);
    // 最近两次运行的结果都在
    expect(recalled.some((c) => c.includes("拉取到 3 封邮件"))).toBe(true);
    expect(recalled.some((c) => c.includes("拉取到 5 封邮件"))).toBe(true);
  });

  it("同一 job 多次运行各自独立（runId 去重），失败运行带错误摘要", async () => {
    const hub = new MemoryHub(registry, eventBus, { useTransformers: false });
    await hub.rememberCronRun({ jobId: "job-2", jobName: "拉取邮件", success: true, result: "ok" });
    await hub.rememberCronRun({ jobId: "job-2", jobName: "拉取邮件", success: false, error: "SMTP 超时", durationMs: 30000 });

    const recalled = await hub.recallCronRuns("job-2", 10);
    expect(recalled.some((c) => c.includes("SMTP 超时"))).toBe(true);
    expect(recalled.some((c) => c.includes("失败"))).toBe(true);
  });

  it("recallCronRuns 按 jobId 隔离：不同 job 的互不串扰", async () => {
    const hub = new MemoryHub(registry, eventBus, { useTransformers: false });
    await hub.rememberCronRun({ jobId: "job-A", jobName: "任务A", success: true, result: "A结果" });
    await hub.rememberCronRun({ jobId: "job-B", jobName: "任务B", success: true, result: "B结果" });

    const aOnly = await hub.recallCronRuns("job-A", 10);
    expect(aOnly.some((c) => c.includes("任务A"))).toBe(true);
    // job-A 的召回结果里绝不含 job-B（tag 隔离）
    expect(aOnly.some((c) => c.includes("任务B"))).toBe(false);
  });

  it("recallCronRuns 未命中时返回空数组（不抛错）", async () => {
    const hub = new MemoryHub(registry, eventBus, { useTransformers: false });
    const empty = await hub.recallCronRuns("never-ran", 3);
    expect(empty).toEqual([]);
  });
});
