import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentModelExecutor, type ToolDefinition } from "./agent-model-executor";
import { ServiceRegistry, EventBus } from "@evoclaw/core";

describe("Permission Fast Track", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let executor: AgentModelExecutor;
  let mockPermManager: {
    approveRequest: ReturnType<typeof vi.fn>;
    denyRequest: ReturnType<typeof vi.fn>;
  };

  const testToolDef: ToolDefinition = {
    name: "file_create",
    description: "Create a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
    },
  };

  beforeEach(() => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();

    mockPermManager = {
      approveRequest: vi.fn(),
      denyRequest: vi.fn(),
    };

    executor = new AgentModelExecutor(registry, eventBus);
    registry.registerService("permissionManager", mockPermManager);
  });

  function seedPending(requestId: string, overrides: Partial<{ sessionId: string; message: string; toolName: string; toolArgs: Record<string, unknown> }> = {}) {
    const entry = {
      sessionId: overrides.sessionId ?? "sess-1",
      message: overrides.message ?? "create a file",
      requestId,
      toolName: overrides.toolName ?? "file_create",
      toolArgs: overrides.toolArgs ?? { path: "/tmp/test.txt", content: "hello" },
    };
    (executor as any).pendingOperations.set(requestId, entry);
    return entry;
  }

  // ── (1) 普通消息流程不受影响 ────────────────────────

  describe("normal message flow (no pending operations)", () => {
    it("should have empty pendingOperations after construction", () => {
      expect((executor as any).pendingOperations.size).toBe(0);
    });

    it("should not intercept normal messages when pendingOperations is empty", () => {
      const result = (executor as any).pendingOperations.get("nonexistent");
      expect(result).toBeUndefined();
    });

    it("approveAndExecute should return failure when no pending operation exists", async () => {
      const result = await executor.approveAndExecute("nonexistent-id");
      expect(result.success).toBe(false);
      expect(result.reply).toContain("未找到");
    });

    it("rejectPermission should return failure when no pending operation exists", () => {
      const result = executor.rejectPermission("nonexistent-id");
      expect(result.success).toBe(false);
      expect(result.reply).toContain("未找到");
    });
  });

  // ── (2) 批准快速通道完整执行 ────────────────────────

  describe("approveAndExecute — full execution", () => {
    it("should re-execute the blocked tool and return success", async () => {
      const handler = vi.fn().mockResolvedValue({ content: "file created ok" });
      executor.registerTool("file_create", testToolDef, handler);

      const entry = seedPending("req-001");

      const result = await executor.approveAndExecute("req-001");

      expect(result.success).toBe(true);
      expect(result.toolName).toBe("file_create");
      expect(result.reply).toContain("file created ok");
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(entry.toolArgs);
    });

    it("should remove the entry from pendingOperations after approval", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      executor.registerTool("file_create", testToolDef, handler);

      seedPending("req-002");

      await executor.approveAndExecute("req-002");

      expect((executor as any).pendingOperations.has("req-002")).toBe(false);
    });

    it("should handle tool result with text field", async () => {
      const handler = vi.fn().mockResolvedValue({ text: "text-field-result" });
      executor.registerTool("file_create", testToolDef, handler);

      seedPending("req-003");

      const result = await executor.approveAndExecute("req-003");
      expect(result.success).toBe(true);
      expect(result.reply).toContain("text-field-result");
    });

    it("should handle tool result with message field", async () => {
      const handler = vi.fn().mockResolvedValue({ message: "message-field-result" });
      executor.registerTool("file_create", testToolDef, handler);

      seedPending("req-004");

      const result = await executor.approveAndExecute("req-004");
      expect(result.success).toBe(true);
      expect(result.reply).toContain("message-field-result");
    });

    it("should handle tool result as plain string", async () => {
      const handler = vi.fn().mockResolvedValue("plain-string-result");
      executor.registerTool("file_create", testToolDef, handler);

      seedPending("req-005");

      const result = await executor.approveAndExecute("req-005");
      expect(result.success).toBe(true);
      expect(result.reply).toContain("plain-string-result");
    });

    it("should handle tool result as non-standard object (JSON.stringify)", async () => {
      const handler = vi.fn().mockResolvedValue({ bytes: 42, lines: 10 });
      executor.registerTool("file_create", testToolDef, handler);

      seedPending("req-006");

      const result = await executor.approveAndExecute("req-006");
      expect(result.success).toBe(true);
      expect(result.reply).toContain("bytes");
    });

    it("should include target file info in reply when toolArgs has path", async () => {
      const handler = vi.fn().mockResolvedValue({ content: "done" });
      executor.registerTool("file_create", testToolDef, handler);

      seedPending("req-007", { toolArgs: { path: "/project/src/main.ts", content: "code" } });

      const result = await executor.approveAndExecute("req-007");
      expect(result.success).toBe(true);
      expect(result.reply).toContain("main.ts");
    });

    it("should truncate result text exceeding 2000 characters", async () => {
      const longContent = "A".repeat(3000);
      const handler = vi.fn().mockResolvedValue({ content: longContent });
      executor.registerTool("file_create", testToolDef, handler);

      seedPending("req-008");

      const result = await executor.approveAndExecute("req-008");
      expect(result.success).toBe(true);
      expect(result.reply).toContain("结果已截断");
    });
  });

  // ── (3) 拒绝权限处理逻辑 ──────────────────────────

  describe("rejectPermission", () => {
    it("should clear pendingOperations entry on reject", () => {
      seedPending("req-reject-1");

      const result = executor.rejectPermission("req-reject-1");

      expect(result.success).toBe(true);
      expect(result.reply).toContain("已取消");
      expect((executor as any).pendingOperations.has("req-reject-1")).toBe(false);
    });

    it("should call PermissionManager.denyRequest on reject", () => {
      seedPending("req-reject-2");

      executor.rejectPermission("req-reject-2");

      expect(mockPermManager.denyRequest).toHaveBeenCalledWith("req-reject-2");
    });

    it("should return failure for non-existent requestId", () => {
      const result = executor.rejectPermission("nonexistent");

      expect(result.success).toBe(false);
      expect(result.reply).toContain("未找到");
    });

    it("should not call denyRequest when requestId does not exist", () => {
      executor.rejectPermission("nonexistent");

      expect(mockPermManager.denyRequest).not.toHaveBeenCalled();
    });

    it("should handle PermissionManager.denyRequest throwing gracefully", () => {
      mockPermManager.denyRequest.mockImplementation(() => {
        throw new Error("deny failed");
      });

      seedPending("req-reject-3");

      expect(() => executor.rejectPermission("req-reject-3")).not.toThrow();
      expect((executor as any).pendingOperations.has("req-reject-3")).toBe(false);
    });
  });

  // ── (4) 异常场景 ──────────────────────────────────

  describe("error scenarios", () => {
    it("approveAndExecute should return failure for non-existent requestId", async () => {
      const result = await executor.approveAndExecute("ghost-id");

      expect(result.success).toBe(false);
      expect(result.reply).toContain("未找到");
    });

    it("approveAndExecute should return failure when tool is not registered", async () => {
      seedPending("req-no-tool", { toolName: "nonexistent_tool" });

      const result = await executor.approveAndExecute("req-no-tool");

      expect(result.success).toBe(false);
      expect(result.reply).toContain("未找到");
      expect(result.toolName).toBe("nonexistent_tool");
    });

    it("approveAndExecute should return failure when tool handler throws", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("disk full"));
      executor.registerTool("file_create", testToolDef, handler);

      seedPending("req-tool-fail");

      const result = await executor.approveAndExecute("req-tool-fail");

      expect(result.success).toBe(false);
      expect(result.reply).toContain("disk full");
      expect(result.toolName).toBe("file_create");
    });

    it("approveAndExecute should handle non-Error throws from tool handler", async () => {
      const handler = vi.fn().mockRejectedValue("string error");
      executor.registerTool("file_create", testToolDef, handler);

      seedPending("req-tool-string-err");

      const result = await executor.approveAndExecute("req-tool-string-err");

      expect(result.success).toBe(false);
      expect(result.reply).toContain("string error");
    });

    it("approveAndExecute should still remove pendingOperation even when tool is not registered", async () => {
      seedPending("req-cleanup-no-tool", { toolName: "missing_tool" });

      await executor.approveAndExecute("req-cleanup-no-tool");

      expect((executor as any).pendingOperations.has("req-cleanup-no-tool")).toBe(false);
    });

    it("approveAndExecute should still remove pendingOperation even when tool throws", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("boom"));
      executor.registerTool("file_create", testToolDef, handler);

      seedPending("req-cleanup-tool-err");

      await executor.approveAndExecute("req-cleanup-tool-err");

      expect((executor as any).pendingOperations.has("req-cleanup-tool-err")).toBe(false);
    });

    it("should not process the same requestId twice (idempotency)", async () => {
      const handler = vi.fn().mockResolvedValue({ content: "ok" });
      executor.registerTool("file_create", testToolDef, handler);

      seedPending("req-idempotent");

      const first = await executor.approveAndExecute("req-idempotent");
      expect(first.success).toBe(true);

      const second = await executor.approveAndExecute("req-idempotent");
      expect(second.success).toBe(false);
      expect(second.reply).toContain("未找到");

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  // ── (5) PermissionManager 被正确调用 ───────────────

  describe("PermissionManager integration", () => {
    it("approveAndExecute should call approveRequest with requestId and addToWhitelist=true by default", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      executor.registerTool("file_create", testToolDef, handler);

      seedPending("req-pm-approve");

      await executor.approveAndExecute("req-pm-approve");

      expect(mockPermManager.approveRequest).toHaveBeenCalledWith("req-pm-approve", true);
    });

    it("approveAndExecute should call approveRequest with addToWhitelist=false when specified", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      executor.registerTool("file_create", testToolDef, handler);

      seedPending("req-pm-no-whitelist");

      await executor.approveAndExecute("req-pm-no-whitelist", false);

      expect(mockPermManager.approveRequest).toHaveBeenCalledWith("req-pm-no-whitelist", false);
    });

    it("approveAndExecute should not throw when PermissionManager is not registered", async () => {
      const bareRegistry = new ServiceRegistry();
      const bareEventBus = new EventBus();
      const bareExecutor = new AgentModelExecutor(bareRegistry, bareEventBus);

      const handler = vi.fn().mockResolvedValue({ content: "ok" });
      bareExecutor.registerTool("file_create", testToolDef, handler);

      (bareExecutor as any).pendingOperations.set("req-no-pm", {
        sessionId: "sess-1",
        message: "test",
        requestId: "req-no-pm",
        toolName: "file_create",
        toolArgs: { path: "/tmp/x.txt" },
      });

      const result = await bareExecutor.approveAndExecute("req-no-pm");

      expect(result.success).toBe(true);
      expect(result.reply).toContain("ok");
    });

    it("approveAndExecute should handle PermissionManager.approveRequest throwing gracefully", async () => {
      mockPermManager.approveRequest.mockImplementation(() => {
        throw new Error("approve failed");
      });

      const handler = vi.fn().mockResolvedValue({ content: "still works" });
      executor.registerTool("file_create", testToolDef, handler);

      seedPending("req-pm-throw");

      const result = await executor.approveAndExecute("req-pm-throw");

      expect(result.success).toBe(true);
      expect(result.reply).toContain("still works");
    });

    it("rejectPermission should call denyRequest with requestId", () => {
      seedPending("req-pm-deny");

      executor.rejectPermission("req-pm-deny");

      expect(mockPermManager.denyRequest).toHaveBeenCalledWith("req-pm-deny");
    });

    it("rejectPermission should not throw when PermissionManager is not registered", () => {
      const bareRegistry = new ServiceRegistry();
      const bareEventBus = new EventBus();
      const bareExecutor = new AgentModelExecutor(bareRegistry, bareEventBus);

      (bareExecutor as any).pendingOperations.set("req-no-pm-deny", {
        sessionId: "sess-1",
        message: "test",
        requestId: "req-no-pm-deny",
        toolName: "file_create",
        toolArgs: { path: "/tmp/x.txt" },
      });

      const result = bareExecutor.rejectPermission("req-no-pm-deny");

      expect(result.success).toBe(true);
      expect(result.reply).toContain("已取消");
    });
  });
});
