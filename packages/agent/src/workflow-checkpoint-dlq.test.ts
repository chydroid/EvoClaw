/**
 * 集成测试：WorkflowEngine / SessionCheckpointManager / DLQBatchRetry
 *
 * 使用 vitest + 临时目录 (os.tmpdir + fs.mkdtempSync)。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  WorkflowEngine,
  type WorkflowDefinition,
  type WorkflowExecutorFn,
} from "./workflow-engine";
import {
  SessionCheckpointManager,
  FileCheckpointStore,
} from "./session-checkpoint";
import {
  DLQBatchRetry,
  type DLQEntry,
  type DLQRetryHandler,
} from "./dlq-batch-utils";

// ═══════════════════════════════════════════════════════════
// 测试辅助
// ═══════════════════════════════════════════════════════════

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-test-"));
}

function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function makeEntry(overrides: Partial<DLQEntry> = {}): DLQEntry {
  return {
    id: `dlq_${Math.random().toString(36).slice(2, 10)}`,
    topic: "default",
    payload: { hello: "world" },
    failedAt: Date.now(),
    retryCount: 0,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════
// WorkflowEngine
// ═══════════════════════════════════════════════════════════

describe("WorkflowEngine > validate", () => {
  it("无环工作流校验通过", () => {
    const engine = new WorkflowEngine(async () => null);
    const wf: WorkflowDefinition = {
      id: "wf-1",
      name: "linear",
      nodes: [
        { id: "A", toolName: "t", params: {}, dependsOn: [] },
        { id: "B", toolName: "t", params: {}, dependsOn: ["A"] },
        { id: "C", toolName: "t", params: {}, dependsOn: ["B"] },
      ],
    };
    const result = engine.validate(wf);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("有环工作流校验失败", () => {
    const engine = new WorkflowEngine(async () => null);
    const wf: WorkflowDefinition = {
      id: "wf-cycle",
      name: "cycle",
      nodes: [
        { id: "A", toolName: "t", params: {}, dependsOn: ["B"] },
        { id: "B", toolName: "t", params: {}, dependsOn: ["A"] },
      ],
    };
    const result = engine.validate(wf);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("循环依赖"))).toBe(true);
  });
});

describe("WorkflowEngine > execute", () => {
  it("顺序执行（链式依赖）按拓扑序运行", async () => {
    const order: string[] = [];
    const executor: WorkflowExecutorFn = async (toolName, params) => {
      order.push(params.__id as string);
      return params.__id;
    };
    const engine = new WorkflowEngine(executor);
    const wf: WorkflowDefinition = {
      id: "wf-seq",
      name: "sequential",
      nodes: [
        { id: "A", toolName: "t", params: { __id: "A" }, dependsOn: [] },
        { id: "B", toolName: "t", params: { __id: "B" }, dependsOn: ["A"] },
        { id: "C", toolName: "t", params: { __id: "C" }, dependsOn: ["B"] },
      ],
    };
    const result = await engine.execute(wf);
    expect(result.status).toBe("succeeded");
    expect(order).toEqual(["A", "B", "C"]);
    expect(result.nodeResults.get("A")?.status).toBe("succeeded");
    expect(result.nodeResults.get("C")?.status).toBe("succeeded");
  });

  it("并行执行（同层无依赖）节点并发运行", async () => {
    const startTimes: Record<string, number> = {};
    const endTimes: Record<string, number> = {};
    const executor: WorkflowExecutorFn = async (_tool, params) => {
      const id = params.__id as string;
      startTimes[id] = Date.now();
      await new Promise((r) => setTimeout(r, 80));
      endTimes[id] = Date.now();
      return id;
    };
    const engine = new WorkflowEngine(executor, { maxConcurrency: 3 });
    const wf: WorkflowDefinition = {
      id: "wf-par",
      name: "parallel",
      nodes: [
        { id: "A", toolName: "t", params: { __id: "A" }, dependsOn: [] },
        { id: "B", toolName: "t", params: { __id: "B" }, dependsOn: [] },
        { id: "C", toolName: "t", params: { __id: "C" }, dependsOn: [] },
      ],
    };
    const result = await engine.execute(wf);
    expect(result.status).toBe("succeeded");
    // 三个节点起始时间应非常接近（都 < 30ms 间隔），证明并发
    const starts = Object.values(startTimes).sort((a, b) => a - b);
    const spread = starts[starts.length - 1] - starts[0];
    expect(spread).toBeLessThan(30);
  });

  it("condition 返回 false 时节点被跳过", async () => {
    const called: string[] = [];
    const executor: WorkflowExecutorFn = async (_tool, params) => {
      called.push(params.__id as string);
      return "ok";
    };
    const engine = new WorkflowEngine(executor);
    const wf: WorkflowDefinition = {
      id: "wf-cond",
      name: "conditional",
      nodes: [
        { id: "A", toolName: "t", params: { __id: "A" }, dependsOn: [] },
        {
          id: "B",
          toolName: "t",
          params: { __id: "B" },
          dependsOn: ["A"],
          condition: () => false,
        },
        { id: "C", toolName: "t", params: { __id: "C" }, dependsOn: ["B"] },
      ],
    };
    const result = await engine.execute(wf);
    expect(result.nodeResults.get("A")?.status).toBe("succeeded");
    expect(result.nodeResults.get("B")?.status).toBe("skipped");
    // B 被跳过 → C 因上游 skipped 也被跳过
    expect(result.nodeResults.get("C")?.status).toBe("skipped");
    expect(called).toEqual(["A"]);
  });

  it("resume 从 checkpoint 跳过已成功节点", async () => {
    const tmpDir = makeTmpDir();
    try {
      const checkpointPath = path.join(tmpDir, "checkpoint.json");
      let callCount = 0;
      // 第一次执行：A 成功，B 失败
      const failingExecutor: WorkflowExecutorFn = async (_tool, params) => {
        callCount++;
        const id = params.__id as string;
        if (id === "B") throw new Error("B 故意失败");
        return id;
      };
      const engine1 = new WorkflowEngine(failingExecutor, {
        persistPath: checkpointPath,
      });
      const wf: WorkflowDefinition = {
        id: "wf-resume",
        name: "resume",
        nodes: [
          { id: "A", toolName: "t", params: { __id: "A" }, dependsOn: [] },
          { id: "B", toolName: "t", params: { __id: "B" }, dependsOn: ["A"] },
        ],
      };
      const result1 = await engine1.execute(wf);
      expect(result1.nodeResults.get("A")?.status).toBe("succeeded");
      expect(result1.nodeResults.get("B")?.status).toBe("failed");
      expect(fs.existsSync(checkpointPath)).toBe(true);

      // 第二次 resume：A 应被跳过（保留 succeeded），B 用成功 handler 重试
      callCount = 0;
      const successExecutor: WorkflowExecutorFn = async (_tool, params) => {
        callCount++;
        return params.__id as string;
      };
      const engine2 = new WorkflowEngine(successExecutor);
      const result2 = await engine2.resume(wf, checkpointPath);
      expect(result2.nodeResults.get("A")?.status).toBe("succeeded");
      expect(result2.nodeResults.get("B")?.status).toBe("succeeded");
      // A 不应被再次执行，只执行了 B
      expect(callCount).toBe(1);
    } finally {
      rmrf(tmpDir);
    }
  });

  it("节点超时后重试耗尽标记 failed", async () => {
    let callCount = 0;
    const executor: WorkflowExecutorFn = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 200)); // 超过 timeoutMs
      return "ok";
    };
    const engine = new WorkflowEngine(executor, { defaultTimeoutMs: 50, defaultRetries: 1 });
    const wf: WorkflowDefinition = {
      id: "wf-timeout",
      name: "t",
      nodes: [{ id: "A", toolName: "t", params: {}, dependsOn: [] }],
    };
    const result = await engine.execute(wf);
    expect(result.nodeResults.get("A")?.status).toBe("failed");
    expect(result.nodeResults.get("A")?.error).toMatch(/超时|timeout/i);
    expect(callCount).toBe(2); // 1 + 1 retry
  });

  it("resume 损坏 checkpoint 时返回 partial 且节点 failed", async () => {
    const corruptTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-corrupt-"));
    try {
      const corruptPath = path.join(corruptTmpDir, "corrupt.json");
      fs.writeFileSync(corruptPath, "{ invalid json !!!");
      const engine = new WorkflowEngine(async () => "ok");
      const wf: WorkflowDefinition = {
        id: "wf",
        name: "t",
        nodes: [{ id: "A", toolName: "t", params: {}, dependsOn: [] }],
      };
      const result = await engine.resume(wf, corruptPath);
      expect(result.status).toBe("partial");
      expect(result.nodeResults.get("A")?.status).toBe("failed");
    } finally {
      fs.rmSync(corruptTmpDir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════
// SessionCheckpointManager
// ═══════════════════════════════════════════════════════════

describe("SessionCheckpointManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  it("save 后能 load 还原，并按 sessionId 列出", async () => {
    const store = new FileCheckpointStore(tmpDir);
    const manager = new SessionCheckpointManager(store);

    const id = await manager.save(
      "session-1",
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      [
        {
          toolName: "search",
          params: { q: "test" },
          result: "ok",
          success: true,
          timestamp: Date.now(),
        },
      ],
      { systemPrompt: "you are helpful", skills: ["search"] },
      "first-checkpoint",
    );

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const restored = await manager.restore(id);
    expect(restored).not.toBeNull();
    expect(restored!.sessionId).toBe("session-1");
    expect(restored!.messages).toHaveLength(2);
    expect(restored!.messages[0].content).toBe("hi");
    expect(restored!.toolCallHistory).toHaveLength(1);
    expect(restored!.context.systemPrompt).toBe("you are helpful");
    expect(restored!.context.skills).toEqual(["search"]);
    expect(restored!.label).toBe("first-checkpoint");

    const list = await manager.list("session-1");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
    expect(list[0].sessionId).toBe("session-1");
  });

  it("list 按 createdAt 倒序排列", async () => {
    const store = new FileCheckpointStore(tmpDir);
    const manager = new SessionCheckpointManager(store);

    const id1 = await manager.save("s1", [{ role: "user", content: "a" }], [], {});
    // 确保时间戳不同
    await new Promise((r) => setTimeout(r, 5));
    const id2 = await manager.save("s1", [{ role: "user", content: "b" }], [], {});
    await new Promise((r) => setTimeout(r, 5));
    const id3 = await manager.save("s1", [{ role: "user", content: "c" }], [], {});

    const list = await manager.list("s1");
    expect(list.map((m) => m.id)).toEqual([id3, id2, id1]);
  });

  it("delete 后再 load 返回 null", async () => {
    const store = new FileCheckpointStore(tmpDir);
    const manager = new SessionCheckpointManager(store);

    const id = await manager.save(
      "s1",
      [{ role: "user", content: "x" }],
      [],
      {},
    );
    expect(await manager.restore(id)).not.toBeNull();

    await manager.delete(id);
    expect(await manager.restore(id)).toBeNull();
  });

  it("diff 比较两个 checkpoint 的消息和工具调用数量差", async () => {
    const store = new FileCheckpointStore(tmpDir);
    const manager = new SessionCheckpointManager(store);

    const id1 = await manager.save(
      "s1",
      [{ role: "user", content: "a" }],
      [
        {
          toolName: "t1",
          params: {},
          result: "ok",
          success: true,
          timestamp: 1,
        },
      ],
      {},
    );
    const id2 = await manager.save(
      "s1",
      [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      [
        {
          toolName: "t1",
          params: {},
          result: "ok",
          success: true,
          timestamp: 1,
        },
        {
          toolName: "t2",
          params: {},
          result: "ok",
          success: true,
          timestamp: 2,
        },
      ],
      {},
    );

    const d = await manager.diff(id1, id2);
    expect(d.addedMessages).toBe(2);
    expect(d.removedMessages).toBe(0);
    expect(d.toolCallsDiff).toBe(1);
  });

  it("sessionId 含 ../ 时应被拒绝（防路径逃逸）", async () => {
    const store = new FileCheckpointStore(tmpDir);
    const manager = new SessionCheckpointManager(store);

    // sessionId 路径注入
    await expect(
      manager.save("../../etc", [{ role: "user", content: "x" }], [], {}),
    ).rejects.toThrow(/Invalid checkpoint id\/sessionId/i);

    // checkpointId 路径注入（restore / delete / diff 入口）
    await expect(manager.restore("../../etc/passwd")).rejects.toThrow(
      /Invalid checkpoint id\/sessionId/i,
    );

    await expect(manager.delete("../../etc/passwd")).rejects.toThrow(
      /Invalid checkpoint id\/sessionId/i,
    );

    await expect(manager.diff("..", "..")).rejects.toThrow(
      /Invalid checkpoint id\/sessionId/i,
    );

    // 直接通过 store.save 测试 id 路径注入
    await expect(
      store.save({
        id: "../../etc/passwd",
        sessionId: "valid-session",
        createdAt: Date.now(),
        messages: [],
        toolCallHistory: [],
        context: {},
      }),
    ).rejects.toThrow(/Invalid checkpoint id\/sessionId/i);
  });
});

// ═══════════════════════════════════════════════════════════
// DLQBatchRetry
// ═══════════════════════════════════════════════════════════

describe("DLQBatchRetry", () => {
  it("retryAll 全部成功", async () => {
    const handler: DLQRetryHandler = async () => {
      // 立即成功
    };
    const retry = new DLQBatchRetry(handler, {
      maxRetries: 3,
      retryDelayMs: 10,
    });
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ id: `e${i}`, topic: "t1" }),
    );

    const result = await retry.retryAll(entries);
    expect(result.total).toBe(5);
    expect(result.succeeded).toBe(5);
    expect(result.failed).toBe(0);
    expect(result.recovered).toHaveLength(5);
    expect(result.stillFailed).toHaveLength(0);
  });

  it("retryAll 部分失败（handler 持续抛错）", async () => {
    const handler: DLQRetryHandler = async (entry) => {
      if (entry.id === "bad") throw new Error("永远失败");
    };
    const retry = new DLQBatchRetry(handler, {
      maxRetries: 2,
      retryDelayMs: 5,
    });
    const entries = [
      makeEntry({ id: "good-1", topic: "t" }),
      makeEntry({ id: "bad", topic: "t" }),
      makeEntry({ id: "good-2", topic: "t" }),
    ];

    const result = await retry.retryAll(entries);
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.recovered).toContain("good-1");
    expect(result.recovered).toContain("good-2");
    expect(result.stillFailed[0].id).toBe("bad");
    expect(result.stillFailed[0].reason).toContain("永远失败");
  });

  it("retryByTopic 仅重试匹配 topic 的条目", async () => {
    const handled: string[] = [];
    const handler: DLQRetryHandler = async (entry) => {
      handled.push(entry.id);
    };
    const retry = new DLQBatchRetry(handler);
    const entries = [
      makeEntry({ id: "a", topic: "email" }),
      makeEntry({ id: "b", topic: "sms" }),
      makeEntry({ id: "c", topic: "email" }),
    ];

    const result = await retry.retryByTopic(entries, "email");
    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(handled).toContain("a");
    expect(handled).toContain("c");
    expect(handled).not.toContain("b");
  });

  it("retryWithFilter 使用自定义过滤条件", async () => {
    const handled: string[] = [];
    const handler: DLQRetryHandler = async (entry) => {
      handled.push(entry.id);
    };
    const retry = new DLQBatchRetry(handler);
    const entries = [
      makeEntry({ id: "a", topic: "t", payload: { n: 1 } }),
      makeEntry({ id: "b", topic: "t", payload: { n: 5 } }),
      makeEntry({ id: "c", topic: "t", payload: { n: 10 } }),
    ];

    const result = await retry.retryWithFilter(
      entries,
      (e) => (e.payload as { n: number }).n >= 5,
    );
    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(handled).toEqual(expect.arrayContaining(["b", "c"]));
    expect(handled).not.toContain("a");
  });

  it("maxRetries 耗尽：retryCount 超限的条目直接标记 stillFailed", async () => {
    const handler: DLQRetryHandler = async () => {
      throw new Error("持续失败");
    };
    const retry = new DLQBatchRetry(handler, {
      maxRetries: 3,
      retryDelayMs: 1,
    });
    // retryCount=3 已达上限 → 直接 stillFailed，不调用 handler
    // retryCount=1 → 还可重试 2 次，但 handler 持续抛错 → 最终 stillFailed
    // retryCount=0 → 还可重试 3 次，handler 持续抛错 → stillFailed
    const entries = [
      makeEntry({ id: "exhausted", retryCount: 3 }),
      makeEntry({ id: "partial", retryCount: 1 }),
      makeEntry({ id: "fresh", retryCount: 0 }),
    ];

    const result = await retry.retryAll(entries);
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(3);
    expect(result.stillFailed.map((s) => s.id)).toEqual(
      expect.arrayContaining(["exhausted", "partial", "fresh"]),
    );
    // exhausted 的 reason 应是“已超过最大重试次数”
    const ex = result.stillFailed.find((s) => s.id === "exhausted");
    expect(ex?.reason).toContain("已超过最大重试次数");
  });
});
