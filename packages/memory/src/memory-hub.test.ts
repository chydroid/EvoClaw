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

// ═══════════════════════════════════════════════════════════
// P4 记忆写入闸门（2026-11-13）：updateMemoryContent 原地更新
// ═══════════════════════════════════════════════════════════

describe("MemoryHub — updateMemoryContent（P4 原地更新）", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();
  });

  const entryInput = (content: string) => ({
    type: "knowledge" as const,
    content,
    metadata: {
      source: "agent",
      sessionId: "s-1",
      userId: "u-1",
      tags: ["p4"],
      importance: 0.6,
      associations: [],
      entities: [],
    },
    ttl: 3_600_000,
    embedding: null,
  });

  it("保留 id/type/ttl/createdAt，仅替换 content", async () => {
    const hub = new MemoryHub(registry, eventBus, { useTransformers: false });
    const stored = await hub.remember(entryInput("原始内容：登录页已完成"));
    const updated = await hub.updateMemoryContent(stored.id, "更新内容：登录页已验收");

    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(stored.id);
    expect(updated!.type).toBe(stored.type);
    expect(updated!.ttl).toBe(stored.ttl);
    expect(updated!.createdAt).toEqual(stored.createdAt);
    expect(updated!.content).toBe("更新内容：登录页已验收");

    const reloaded = await hub.getLongTerm().get(stored.id);
    expect(reloaded?.content).toBe("更新内容：登录页已验收");
    // 本地长期存储是共享 data 目录，不能断言全库只有 1 条；只断言本次 id 未重复
    // （LongTermMemory 接口不暴露 getAll，这里按具体实现窄化）
    const store = hub.getLongTerm() as unknown as {
      getAll(): Promise<Array<{ id: string }>>;
    };
    const sameId = (await store.getAll()).filter((e) => e.id === stored.id);
    expect(sameId).toHaveLength(1);
  });

  it("FTS5 索引幂等覆盖：新内容可搜到，旧内容搜不到", async () => {
    const hub = new MemoryHub(registry, eventBus, { useTransformers: false });
    const stored = await hub.remember(entryInput("季度目标：完成支付网关"));
    await hub.updateMemoryContent(stored.id, "季度目标：完成风控网关");

    const hitNew = hub.getFTS5().search({ query: "风控网关", limit: 10 });
    expect(hitNew.map((r) => r.metadata.id)).toContain(stored.id);

    const hitOld = hub.getFTS5().search({ query: "支付网关", limit: 10 });
    expect(hitOld.map((r) => r.metadata.id)).not.toContain(stored.id);
  });

  it("不存在的 id 返回 null（不抛错、不新建条目）", async () => {
    const hub = new MemoryHub(registry, eventBus, { useTransformers: false });
    expect(await hub.updateMemoryContent("missing-id", "x")).toBeNull();
  });
});
