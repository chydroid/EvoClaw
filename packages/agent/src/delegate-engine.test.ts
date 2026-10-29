/**
 * DelegateEngine 测试 — delegate_task 子代理执行引擎
 *
 * 验证（对齐 Hermes delegate_tool.py 核心语义）：
 * - 深度门禁：depth >= maxSpawnDepth 的会话不可委派；role 由深度派生
 * - 批量并行：并发上限 maxConcurrentChildren
 * - output_schema：契约告知 + 校验 + 一次有界纠正重试
 * - 后台派发：立即返回 dispatch 句柄；结果经 takePendingResults 回投
 * - stop：abortSession → interrupted（部分输出返回）
 * - steer：软注入 → turn 间新消息注入
 * - validateAgainstSchema：容错 JSON 提取 + 精简 schema 校验
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DelegateEngine, validateAgainstSchema } from "./delegate-engine";
import { SubagentRegistry } from "./subagent-registry";
import type { DelegateExecutorLike, DelegateRunResult } from "./delegate-engine";
import type { EventBus } from "@evoclaw/core";

// ─── 测试脚手架 ───────────────────────────────────────────────────────────────

interface FakeState {
  calls: Array<{ message: string; sessionId: string }>;
  inFlight: number;
  maxInFlight: number;
  aborted: Set<string>;
  /** 回复脚本：按调用序号返回回复（默认 "done"） */
  replyFn: (callIndex: number, message: string) => string | Promise<string>;
  /** 延迟工具：让并发窗口可观测 */
  delayMs: number;
}

function createFakeDeps(state: FakeState) {
  const executor: DelegateExecutorLike = {
    async chat(message: string, context?: Record<string, unknown>) {
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      const sessionId = (context?.sessionId as string) ?? "unknown";
      state.calls.push({ message, sessionId });
      const callIndex = state.calls.length - 1;
      try {
        // abort 时机：chat 开始前或 replyFn 返回后（模拟真实 abortSession 语义）
        if (state.aborted.has(sessionId)) {
          throw new Error("session aborted");
        }
        const reply = await state.replyFn(callIndex, message);
        if (state.aborted.has(sessionId)) {
          throw new Error("session aborted");
        }
        if (state.delayMs > 0) {
          await new Promise((r) => setTimeout(r, state.delayMs));
        }
        return { reply, tokensUsed: 10 };
      } finally {
        state.inFlight--;
      }
    },
    abortSession(sessionId: string) {
      state.aborted.add(sessionId);
    },
  };

  const events: string[] = [];
  const eventBus = {
    publish: async (event: string) => {
      events.push(event);
    },
  } as unknown as EventBus;

  const subagentRegistry = new SubagentRegistry(eventBus, 10);
  return { executor, eventBus, subagentRegistry, events };
}

function makeEngine(state: FakeState, config?: { maxSpawnDepth?: number; maxConcurrentChildren?: number }) {
  const deps = createFakeDeps(state);
  const engine = new DelegateEngine({
    executor: deps.executor,
    eventBus: deps.eventBus,
    subagentRegistry: deps.subagentRegistry,
    config: { maxSpawnDepth: 1, ...config },
  });
  return { engine, ...deps };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timeout");
}

// ─── validateAgainstSchema ─────────────────────────────────────────────────────

describe("validateAgainstSchema", () => {
  const schema = {
    type: "object",
    required: ["status", "count"],
    properties: {
      status: { type: "string", enum: ["ok", "fail"] },
      count: { type: "integer", minimum: 0, maximum: 10 },
      tags: { type: "array", items: { type: "string" } },
    },
  };

  it("接受合法对象", () => {
    const r = validateAgainstSchema('{"status":"ok","count":5,"tags":["a"]}', schema);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("从包裹文本中提取平衡 JSON 子串", () => {
    const r = validateAgainstSchema('最终结果如下：\n{"status":"ok","count":3}\n以上。', schema);
    expect(r.valid).toBe(true);
  });

  it("缺失 required 字段报错", () => {
    const r = validateAgainstSchema('{"status":"ok"}', schema);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("missing required field"))).toBe(true);
  });

  it("类型/枚举/范围违规报错", () => {
    const r = validateAgainstSchema('{"status":"bad","count":99}', schema);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("enum"))).toBe(true);
    expect(r.errors.some((e) => e.includes("maximum"))).toBe(true);
  });

  it("数组 items 逐项校验", () => {
    const r = validateAgainstSchema('{"status":"ok","count":1,"tags":["a",42]}', schema);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("tags[1]"))).toBe(true);
  });

  it("不可解析 JSON 报错", () => {
    const r = validateAgainstSchema("完全不是 JSON", schema);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("JSON");
  });
});

// ─── 深度门禁与角色派生 ───────────────────────────────────────────────────────

describe("DelegateEngine 深度门禁与角色派生", () => {
  let state: FakeState;
  let engine: DelegateEngine;
  let deps: ReturnType<typeof createFakeDeps>;

  beforeEach(() => {
    state = { calls: [], inFlight: 0, maxInFlight: 0, aborted: new Set(), replyFn: () => "done", delayMs: 0 };
    ({ engine, ...deps } = makeEngine(state, { maxSpawnDepth: 2 }));
  });

  afterEach(() => {
    deps.subagentRegistry.dispose();
  });

  it("maxSpawnDepth=2 时子代理为 orchestrator（深度 1 < 2 可委派）", async () => {
    state.replyFn = ((i, msg) => (msg.includes("【目标】") ? `depth-canDelegate=${engine.canDelegate()}` : "correction"));
    const dispatch = await engine.withSession("s1", () =>
      engine.spawn([{ goal: "g1" }]),
    );
    expect(dispatch.status).toBe("completed");
    expect(dispatch.results?.[0].role).toBe("orchestrator");
    expect(dispatch.results?.[0].summary).toContain("depth-canDelegate=true");
  });

  it("maxSpawnDepth=1 时子代理为 leaf 且深度门禁拒绝其再次委派", async () => {
    // 独立引擎（maxSpawnDepth=1）：子代理（深度 1）是 leaf；
    // 其 chat 运行在引擎 ALS 注入的深度 1 上下文中：canDelegate=false，
    // 在该上下文内再次 spawn 应抛深度限制错误。
    const s1: FakeState = { calls: [], inFlight: 0, maxInFlight: 0, aborted: new Set(), replyFn: () => "done", delayMs: 0 };
    const e1 = makeEngine(s1, { maxSpawnDepth: 1 });
    try {
      s1.replyFn = async () => {
        const depth = e1.engine.currentDepth();
        const can = e1.engine.canDelegate();
        let nestedErr = "no-throw";
        try {
          await e1.engine.spawn([{ goal: "nested" }]);
        } catch (e) {
          nestedErr = e instanceof Error ? e.message : String(e);
        }
        return `depth=${depth},canDelegate=${can},nested=${nestedErr.slice(0, 60)}`;
      };
      const dispatch = await e1.engine.spawn([{ goal: "g1" }]);
      expect(dispatch.results?.[0].role).toBe("leaf");
      const summary = dispatch.results?.[0].summary ?? "";
      expect(summary).toContain("depth=1,canDelegate=false");
      expect(summary).toContain("Delegation depth limit reached");
    } finally {
      e1.subagentRegistry.dispose();
    }
  });

  it("顶层会话深度为 0 且可委派", async () => {
    expect(engine.currentDepth()).toBe(0);
    expect(engine.canDelegate()).toBe(true);
  });
});

// ─── 批量并发 ─────────────────────────────────────────────────────────────────

describe("DelegateEngine 批量并发", () => {
  let state: FakeState;
  let engine: DelegateEngine;
  let deps: ReturnType<typeof createFakeDeps>;

  beforeEach(() => {
    state = { calls: [], inFlight: 0, maxInFlight: 0, aborted: new Set(), replyFn: () => "done", delayMs: 10 };
    ({ engine, ...deps } = makeEngine(state, { maxConcurrentChildren: 2 }));
  });

  afterEach(() => {
    deps.subagentRegistry.dispose();
  });

  it("并发不超过 maxConcurrentChildren 且全部完成", async () => {
    const dispatch = await engine.withSession("s1", () =>
      engine.spawn(Array.from({ length: 5 }, (_, i) => ({ goal: `g${i}` }))),
    );
    expect(dispatch.status).toBe("completed");
    expect(dispatch.results?.length).toBe(5);
    expect(dispatch.results?.every((r) => r.status === "completed")).toBe(true);
    expect(state.maxInFlight).toBeLessThanOrEqual(2);
  });

  it("goal 缺失抛错", async () => {
    await expect(
      engine.withSession("s1", () => engine.spawn([{ goal: "" } as never])),
    ).rejects.toThrow(/goal is required/);
  });
});

// ─── output_schema 校验与纠正重试 ─────────────────────────────────────────────

describe("DelegateEngine output_schema", () => {
  const schema = {
    type: "object",
    required: ["status"],
    properties: { status: { type: "string", enum: ["ok", "fail"] } },
  };

  let state: FakeState;
  let engine: DelegateEngine;
  let deps: ReturnType<typeof createFakeDeps>;

  beforeEach(() => {
    state = { calls: [], inFlight: 0, maxInFlight: 0, aborted: new Set(), replyFn: () => "done", delayMs: 0 };
    ({ engine, ...deps } = makeEngine(state));
  });

  afterEach(() => {
    deps.subagentRegistry.dispose();
  });

  it("首次不合规 → 一次纠正重试后 schema_valid=true", async () => {
    state.replyFn = (
      (i) => (i === 0 ? "这不是 JSON" : '{"status":"ok"}'),
    );
    const dispatch = await engine.withSession("s1", () =>
      engine.spawn([{ goal: "g", output_schema: schema }]),
    );
    const r = dispatch.results?.[0];
    expect(r?.schema_valid).toBe(true);
    expect(r?.status).toBe("completed");
    // 两次 chat：初始 prompt + 纠正 prompt
    expect(state.calls.length).toBe(2);
    expect(state.calls[1].message).toContain("不符合输出契约");
    // 纠正提示里带契约内容
    expect(state.calls[0].message).toContain("【输出契约】");
  });

  it("重试后仍不合规 → schema_valid=false + errors，summary 保留原文", async () => {
    state.replyFn = ((i) => (i === 0 ? "still-not-json" : "nope"));
    const dispatch = await engine.withSession("s1", () =>
      engine.spawn([{ goal: "g", output_schema: schema }]),
    );
    const r = dispatch.results?.[0];
    expect(r?.schema_valid).toBe(false);
    expect(r?.schema_errors?.length).toBeGreaterThan(0);
    expect(r?.summary).toBe("nope");
  });

  it("合规输出不触发重试", async () => {
    state.replyFn = (() => '{"status":"ok"}');
    const dispatch = await engine.withSession("s1", () =>
      engine.spawn([{ goal: "g", output_schema: schema }]),
    );
    expect(dispatch.results?.[0].schema_valid).toBe(true);
    expect(state.calls.length).toBe(1);
  });
});

// ─── 后台派发与结果回投 ───────────────────────────────────────────────────────

describe("DelegateEngine 后台派发", () => {
  let state: FakeState;
  let engine: DelegateEngine;
  let deps: ReturnType<typeof createFakeDeps>;

  beforeEach(() => {
    state = { calls: [], inFlight: 0, maxInFlight: 0, aborted: new Set(), replyFn: () => "done", delayMs: 0 };
    ({ engine, ...deps } = makeEngine(state));
  });

  afterEach(() => {
    deps.subagentRegistry.dispose();
  });

  it("background=true 立即返回 dispatch 句柄，结果经 takePendingResults 回投", async () => {
    state.replyFn = (() => "child-done");
    const dispatch = await engine.withSession("s1", () =>
      engine.spawn([{ goal: "bg-task" }], { background: true }),
    );
    expect(dispatch.status).toBe("dispatched");
    expect(dispatch.runs[0].status).toBe("running");

    // 结果异步完成 → 回投队列
    const results = await waitFor(() => {
      const r = engine.takePendingResults("s1");
      return r.length > 0 ? r : undefined;
    });
    expect(results[0].status).toBe("completed");
    expect(results[0].summary).toBe("child-done");
    expect(results[0].sessionId.startsWith("subsession_")).toBe(true);
  });

  it("orchestrator 子代理（depth>0）的后台请求被强制前台执行", async () => {
    // maxSpawnDepth=2：子代理（深度 1）是 orchestrator，可嵌套委派；
    // 其在 turn 内请求 background 时必须被强制改回前台（Hermes
    // _model_background_value：depth>0 的子代理需要在本 turn 内拿到结果）。
    const s2: FakeState = { calls: [], inFlight: 0, maxInFlight: 0, aborted: new Set(), replyFn: () => "done", delayMs: 0 };
    const e2 = makeEngine(s2, { maxSpawnDepth: 2 });
    try {
      s2.replyFn = async () => {
        const depth = e2.engine.currentDepth();
        // 嵌套子代理（深度 2）是 leaf：直接返回，避免 replyFn 递归触发深度门禁
        if (depth >= 2) return "leaf-done";
        const d = await e2.engine.spawn([{ goal: "inner" }], { background: true });
        return `depth=${depth},status=${d.status},inner=${d.results?.[0]?.status ?? "none"}`;
      };
      const dispatch = await e2.engine.withSession("s1", () => e2.engine.spawn([{ goal: "outer" }]));
      expect(dispatch.results?.[0].status).toBe("completed");
      const summary = dispatch.results?.[0].summary ?? "";
      expect(summary).toContain("depth=1");
      expect(summary).toContain("status=completed");
      expect(summary).toContain("inner=completed");
    } finally {
      e2.subagentRegistry.dispose();
    }
  });

  it("resultDeliver 回调在后台完成后触发", async () => {
    state.replyFn = (() => "done");
    const delivered: Array<[string | undefined, DelegateRunResult[]]> = [];
    engine.setResultDeliver((sessionId, results) => {
      delivered.push([sessionId, results]);
    });
    await engine.withSession("s2", () => engine.spawn([{ goal: "g" }], { background: true }));
    await waitFor(() => (delivered.length > 0 ? delivered : undefined));
    expect(delivered[0][0]).toBe("s2");
    expect(delivered[0][1][0].summary).toBe("done");
  });
});

// ─── stop / steer ─────────────────────────────────────────────────────────────

describe("DelegateEngine stop / steer", () => {
  let state: FakeState;
  let engine: DelegateEngine;
  let deps: ReturnType<typeof createFakeDeps>;

  beforeEach(() => {
    state = { calls: [], inFlight: 0, maxInFlight: 0, aborted: new Set(), replyFn: () => "done", delayMs: 0 };
    ({ engine, ...deps } = makeEngine(state));
  });

  afterEach(() => {
    deps.subagentRegistry.dispose();
  });

  it("stop：运行中的子代理被中止，状态 interrupted", async () => {
    let resolveFirst: (() => void) | undefined;
    state.replyFn = (
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = () => resolve("partial-output");
        }),
    );
    // 后台派发拿到 id → stop → 释放首答 → chat 后检查 aborted 抛错 → interrupted
    const dispatch = await engine.withSession("s1", () =>
      engine.spawn([{ goal: "long-task" }], { background: true }),
    );
    const runId = dispatch.runs[0].id;
    expect(engine.stopRun(runId)).toBe(true);
    resolveFirst?.();
    const results = await waitFor(() => {
      const r = engine.takePendingResults("s1");
      return r.length > 0 ? r : undefined;
    });
    expect(results[0].status).toBe("interrupted");
  });

  it("stop 未命中（不存在/已完成）返回 false", async () => {
    expect(engine.stopRun("nonexistent")).toBe(false);
    state.replyFn = (() => "quick");
    const dispatch = await engine.withSession("s1", () => engine.spawn([{ goal: "g" }]));
    expect(engine.stopRun(dispatch.runs[0].id)).toBe(false);
  });

  it("steer：软注入指令在 turn 间作为新消息注入并更新最终输出", async () => {
    let resolveFirst: (() => void) | undefined;
    state.replyFn = (
      (i) => {
        if (i === 0) {
          return new Promise<string>((resolve) => {
            resolveFirst = () => resolve("first-answer");
          });
        }
        return "steered-answer";
      },
    );
    const dispatch = await engine.withSession("s1", () =>
      engine.spawn([{ goal: "g" }], { background: true }),
    );
    const runId = dispatch.runs[0].id;
    // 首 turn 挂起期间 steer → 队列 → 首答返回后 drain 成新 turn
    expect(engine.steerRun(runId, "请改用温水并重新验证")).toBe(true);
    resolveFirst?.();
    const results = await waitFor(() => {
      const r = engine.takePendingResults("s1");
      return r.length > 0 ? r : undefined;
    });
    expect(results[0].status).toBe("completed");
    expect(results[0].summary).toBe("steered-answer");
    // 第二次 chat 携带 steer 指令
    expect(state.calls.length).toBe(2);
    expect(state.calls[1].message).toContain("请改用温水并重新验证");
    expect(state.calls[1].message).toContain("实时指令");
  });

  it("steer 未命中运行中的子代理返回 false", () => {
    expect(engine.steerRun("nonexistent", "x")).toBe(false);
  });
});

// ─── list / getRun ─────────────────────────────────────────────────────────────

describe("DelegateEngine list / getRun", () => {
  let state: FakeState;
  let engine: DelegateEngine;
  let deps: ReturnType<typeof createFakeDeps>;

  beforeEach(() => {
    state = { calls: [], inFlight: 0, maxInFlight: 0, aborted: new Set(), replyFn: () => "done", delayMs: 0 };
    ({ engine, ...deps } = makeEngine(state));
  });

  afterEach(() => {
    deps.subagentRegistry.dispose();
  });

  it("listRuns 返回运行摘要，getRun 返回完整结果", async () => {
    state.replyFn = (() => "ok");
    const dispatch = await engine.withSession("s1", () => engine.spawn([{ goal: "g1" }, { goal: "g2" }]));
    const runs = engine.listRuns({ parentSessionId: "s1" });
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.status === "completed")).toBe(true);
    const full = engine.getRun(dispatch.runs[0].id);
    expect(full?.summary).toBe("ok");
    expect(full?.tokensUsed).toBe(10);
  });
});
