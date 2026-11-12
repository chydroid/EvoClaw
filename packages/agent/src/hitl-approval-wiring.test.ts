import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentModelExecutor } from "./agent-model-executor";
import { HumanApprovalManager, type PendingApproval } from "./human-approval";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { setActiveSecurityLevel } from "@evoclaw/security";

/**
 * P0 — AgentModelExecutor 与 HumanApprovalManager 的接线。
 *
 * 覆盖：
 * - approveOperation 后「同一 tool+args」重试放行；
 * - rejectOperation 发布 permission.denied 并清理 pendingOperations；
 * - 外部 PermissionManager/PermissionRelay 发布 permission.denied 时同样清理。
 */
describe("AgentModelExecutor — HITL 审批接线（P0）", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let executor: AgentModelExecutor;
  let manager: HumanApprovalManager;

  beforeEach(() => {
    setActiveSecurityLevel("normal");
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    executor = new AgentModelExecutor(registry, eventBus);
    manager = new HumanApprovalManager();
    executor.setHumanApprovalManager(manager);
  });

  afterEach(() => {
    manager.destroy();
    setActiveSecurityLevel("normal");
  });

  function seedPending(id = "hitl-test-1"): PendingApproval {
    const pending: PendingApproval = {
      id,
      sessionId: "sess-1",
      toolName: "file_delete",
      toolArgs: { path: "/tmp/a.txt" },
      riskLevel: "critical",
      reason: 'Tool "file_delete" requires approval',
      createdAt: Date.now(),
      requestedBy: "agent",
      status: "pending",
    };
    manager.registerPendingApproval(pending);
    (executor as unknown as { pendingOperations: Map<string, unknown> }).pendingOperations.set(id, {
      sessionId: "sess-1",
      message: "delete it",
      requestId: id,
      toolName: "file_delete",
      toolArgs: { path: "/tmp/a.txt" },
    });
    return pending;
  }

  it("approveOperation：批准后同一参数的重试不再要求审批", async () => {
    const pending = seedPending();
    expect(executor.approveOperation(pending.id, "tester")).toBe(true);
    await Promise.resolve();
    expect(manager.getApproval(pending.id)?.status).toBe("approved");
    expect(manager.requiresApproval("file_delete", { path: "/tmp/a.txt" })).toBe(false);
  });

  it("rejectOperation：发布 permission.denied 并清理 pendingOperations", async () => {
    const pending = seedPending();
    expect(executor.rejectOperation(pending.id, "tester", "no")).toBe(true);
    // publish 是 fire-and-forget，处理在微任务中完成
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.getApproval(pending.id)?.status).toBe("rejected");
    expect((executor as unknown as { pendingOperations: Map<string, unknown> }).pendingOperations.has(pending.id)).toBe(false);
  });

  it("外部 permission.denied（PermissionManager 形状 requestId）也清理映射", async () => {
    seedPending("req-ext-1");
    await eventBus.publish("permission.denied", { requestId: "req-ext-1", operation: "file_delete", target: "/tmp/a.txt" }, "permission-manager");
    expect((executor as unknown as { pendingOperations: Map<string, unknown> }).pendingOperations.has("req-ext-1")).toBe(false);
  });

  it("外部 permission.denied（PermissionRelay 形状 id）也清理映射", async () => {
    seedPending("perm_123");
    await eventBus.publish("permission.denied", { id: "perm_123", sessionId: "sess-1", toolName: "file_delete" }, "permission-relay");
    expect((executor as unknown as { pendingOperations: Map<string, unknown> }).pendingOperations.has("perm_123")).toBe(false);
  });

  it("不存在的 id：approve/reject 均返回 false（路由据此返回 404）", () => {
    expect(executor.approveOperation("hitl-missing", "tester")).toBe(false);
    expect(executor.rejectOperation("hitl-missing", "tester")).toBe(false);
  });
});
