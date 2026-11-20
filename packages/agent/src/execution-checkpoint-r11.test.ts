/**
 * R11 P0 死码接线测试（台账第 5 项续）
 *  - AgentModelExecutor.setFailoverManager：provider 注册镜像 + 记账转发
 *  - ExecutionCheckpointStore：resume 句柄已下线（观测面保留）
 */
import { describe, it, expect } from "vitest";
import { ExecutionCheckpointStore } from "./execution-checkpoint";
import { ModelFailoverManager } from "./model-failover";

// ── ExecutionCheckpointStore：resume 句柄下线，观测面保留 ──

describe("R11 P0: ExecutionCheckpointStore resume 语义下线（选项 B）", () => {
  it("resume/getSnapshotForResume 方法已移除（真实续跑由 DurableTaskRunner 承接）", () => {
    const store = new ExecutionCheckpointStore();
    const s = store as unknown as Record<string, unknown>;
    expect(s.resume).toBeUndefined();
    expect(s.getSnapshotForResume).toBeUndefined();
    void store; // 无 dispose：store 不持有 timer（cleanup 由外部调）
  });

  it("观测面保留：startExecution/saveSnapshot/getRecent/getResumableExecutions 可用", () => {
    const store = new ExecutionCheckpointStore();
    store.startExecution("sess-obs", "原始消息");
    store.saveSnapshot("sess-obs", {
      sessionId: "sess-obs", stepIndex: 0, stepType: "tool_result",
      timestamp: 0, messages: [], tokensUsed: 0, durationMs: 0,
    });
    const recent = store.getRecent();
    expect(recent.some((e) => e.sessionId === "sess-obs")).toBe(true);
    // running 状态可被 getResumableExecutions 统计（/api/executions resumableCount 消费）
    expect(store.getResumableExecutions().some((e) => e.sessionId === "sess-obs")).toBe(true);
    store.completeExecution("sess-obs", "done");
    expect(store.getResumableExecutions().some((e) => e.sessionId === "sess-obs")).toBe(false);
    store.deleteExecution("sess-obs");
  });

  it("快照 messages 是请求形状（含 tool 角色）——这正是 resume 下线的原因", () => {
    const store = new ExecutionCheckpointStore();
    store.startExecution("sess-shape", "原始消息");
    const requestShapedMessages = [
      { role: "system", content: "sys" },
      { role: "user", content: "增强后的消息（非原始）" },
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", content: "result", tool_call_id: "1" },
    ];
    store.saveSnapshot("sess-shape", {
      sessionId: "sess-shape", stepIndex: 1, stepType: "tool_result",
      timestamp: 0, messages: requestShapedMessages, tokensUsed: 0, durationMs: 0,
    });
    const snap = store.getSnapshot("sess-shape", 0)!;
    expect(snap.messages.some((m) => m.role === "tool")).toBe(true);
    expect(snap.messages.some((m) => m.role === "system")).toBe(true);
    // 请求形状 ≠ 持久 history 形状（只有 user/assistant 对）→ 直接回填会串位
    store.deleteExecution("sess-shape");
  });
});

// ── ModelFailoverManager：executor 镜像 setter 的注册契约 ──
// setFailoverManager 本体在 AgentModelExecutor 上（构造依赖 registry/eventBus，
// 不在此实例化）；此处验证 manager 侧契约：setter 会遍历 this.providers 调
// registerProvider（未注册的才注册），随后 recordProviderSuccess/Failure 转发。

describe("R11 P0: failover manager 镜像注册契约（executor setter 消费的形状）", () => {
  it("registerProvider 幂等（getHealth 已存在则 setter 不重复注册）", () => {
    const fm = new ModelFailoverManager();
    const provider = { id: "prov-a", name: "A", enabled: true, order: 1, healthCheck: async () => true };
    fm.registerProvider(provider);
    const first = fm.getHealth("prov-a")!;
    fm.registerProvider(provider); // setter 二次调用同 id
    const second = fm.getHealth("prov-a")!;
    expect(second).toEqual(first);
    fm.dispose();
  });

  it("镜像记账走 recordSuccess/recordFailure（executor recordProvider* 转发目标）", () => {
    const fm = new ModelFailoverManager();
    fm.registerProvider({ id: "prov-b", name: "B", enabled: true, order: 2, healthCheck: async () => true });
    fm.recordSuccess("prov-b", 200);
    fm.recordFailure("prov-b", "AUTH: invalid key");
    const h = fm.getHealth("prov-b")!;
    expect(h.totalRequests).toBe(2);
    expect(h.lastError).toContain("AUTH");
    fm.dispose();
  });
});
