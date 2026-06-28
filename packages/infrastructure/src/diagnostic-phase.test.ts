import { describe, it, expect, beforeEach } from "vitest";
import {
  DiagnosticPhaseTracker,
  type DiagnosticPhaseKind,
} from "./diagnostic-phase";

describe("DiagnosticPhaseTracker", () => {
  let tracker: DiagnosticPhaseTracker;

  beforeEach(() => {
    tracker = new DiagnosticPhaseTracker();
  });

  it("start 应创建 running 状态的 phase", () => {
    const phase = tracker.start("session-1", "init", { source: "test" });
    expect(phase.kind).toBe("init");
    expect(phase.status).toBe("running");
    expect(phase.endedAt).toBeUndefined();
    expect(phase.durationMs).toBeUndefined();
    expect(phase.metadata).toEqual({ source: "test" });
  });

  it("end 应将 phase 标记为 succeeded 并设置 durationMs", async () => {
    tracker.start("session-1", "init");
    // 等待一小段时间以保证 duration > 0
    await new Promise((r) => setTimeout(r, 5));
    tracker.end("session-1", "init", "succeeded");

    const all = tracker.getAllPhases("session-1");
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("succeeded");
    expect(all[0].endedAt).toBeInstanceOf(Date);
    expect(all[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("start 时应自动取消上一个未结束的 phase（cancelled, 原因 superseded by）", () => {
    tracker.start("session-1", "init");
    tracker.start("session-1", "auth");

    const all = tracker.getAllPhases("session-1");
    expect(all).toHaveLength(2);
    expect(all[0].kind).toBe("init");
    expect(all[0].status).toBe("cancelled");
    expect(all[0].error).toBe("superseded by auth");
    expect(all[0].endedAt).toBeInstanceOf(Date);
    expect(all[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(all[1].kind).toBe("auth");
    expect(all[1].status).toBe("running");
  });

  it("getCurrentPhase 应返回最后一个 running 阶段", () => {
    tracker.start("session-1", "init");
    tracker.start("session-1", "auth");
    tracker.end("session-1", "auth", "succeeded");

    const current = tracker.getCurrentPhase("session-1");
    // 全部已结束，返回最后一个（auth）
    expect(current?.kind).toBe("auth");
    expect(current?.status).toBe("succeeded");
  });

  it("getCurrentPhase 应优先返回 running 阶段", () => {
    tracker.start("session-1", "init");
    tracker.end("session-1", "init", "succeeded");
    tracker.start("session-1", "auth");

    const current = tracker.getCurrentPhase("session-1");
    expect(current?.kind).toBe("auth");
    expect(current?.status).toBe("running");
  });

  it("getCurrentPhase 在实体不存在时应返回 undefined", () => {
    expect(tracker.getCurrentPhase("nonexistent")).toBeUndefined();
  });

  it("getAllPhases 应返回按时间顺序的阶段列表（拷贝）", () => {
    tracker.start("session-1", "init");
    tracker.start("session-1", "auth");

    const all = tracker.getAllPhases("session-1");
    expect(all).toHaveLength(2);
    expect(all[0].kind).toBe("init");
    expect(all[1].kind).toBe("auth");

    // 修改拷贝不应影响内部状态
    all[0].kind = "done";
    expect(tracker.getAllPhases("session-1")[0].kind).toBe("init");
  });

  it("getAllPhases 在实体不存在时应返回空数组", () => {
    expect(tracker.getAllPhases("nonexistent")).toEqual([]);
  });

  it("getTotalDurationMs 应累加所有已结束阶段的 duration", async () => {
    tracker.start("session-1", "init");
    await new Promise((r) => setTimeout(r, 5));
    tracker.end("session-1", "init", "succeeded");
    tracker.start("session-1", "auth");
    await new Promise((r) => setTimeout(r, 5));
    tracker.end("session-1", "auth", "succeeded");

    const total = tracker.getTotalDurationMs("session-1");
    expect(total).toBeGreaterThanOrEqual(0);
  });

  it("getTotalDurationMs 在实体不存在时应返回 0", () => {
    expect(tracker.getTotalDurationMs("nonexistent")).toBe(0);
  });

  it("clear 应清理指定实体的所有阶段", () => {
    tracker.start("session-1", "init");
    tracker.start("session-2", "init");

    tracker.clear("session-1");
    expect(tracker.getAllPhases("session-1")).toEqual([]);
    expect(tracker.getAllPhases("session-2")).toHaveLength(1);
  });

  it("clearAll 应清理所有阶段", () => {
    tracker.start("session-1", "init");
    tracker.start("session-2", "init");

    tracker.clearAll();
    expect(tracker.getAllPhases("session-1")).toEqual([]);
    expect(tracker.getAllPhases("session-2")).toEqual([]);
    expect(tracker.getTrackedEntities()).toEqual([]);
  });

  it("end 应支持 failed 状态与错误信息", () => {
    tracker.start("session-1", "tool-call");
    tracker.end("session-1", "tool-call", "failed", "Tool execution failed: timeout");

    const all = tracker.getAllPhases("session-1");
    expect(all[0].status).toBe("failed");
    expect(all[0].error).toBe("Tool execution failed: timeout");
  });

  it("metadata 应正确透传", () => {
    const meta = { userId: 123, tags: ["test", "phase"], nested: { a: 1 } };
    tracker.start("session-1", "skill-exec", meta);

    const current = tracker.getCurrentPhase("session-1");
    expect(current?.metadata).toEqual(meta);
  });

  it("getTrackedEntities 应返回当前跟踪的所有实体 ID", () => {
    tracker.start("session-1", "init");
    tracker.start("session-2", "init");

    const entities = tracker.getTrackedEntities();
    expect(entities).toEqual(expect.arrayContaining(["session-1", "session-2"]));
    expect(entities).toHaveLength(2);
  });

  it("end 在实体不存在时不应抛出", () => {
    expect(() => tracker.end("nonexistent", "init", "succeeded")).not.toThrow();
  });

  it("end 在没有匹配 running 阶段时不应抛出", () => {
    tracker.start("session-1", "init");
    tracker.end("session-1", "init", "succeeded");
    // 已结束，再次 end 不应抛出
    expect(() => tracker.end("session-1", "init", "succeeded")).not.toThrow();
  });

  it("应支持所有 DiagnosticPhaseKind 类型", () => {
    const kinds: DiagnosticPhaseKind[] = [
      "init", "auth", "fetch-context", "llm-call", "tool-call",
      "skill-exec", "compact", "reply", "post-process", "cleanup",
      "error", "done",
    ];
    for (const kind of kinds) {
      const phase = tracker.start("session-1", kind);
      tracker.end("session-1", kind, "succeeded");
      expect(phase.kind).toBe(kind);
    }
    expect(tracker.getAllPhases("session-1")).toHaveLength(kinds.length);
  });
});
