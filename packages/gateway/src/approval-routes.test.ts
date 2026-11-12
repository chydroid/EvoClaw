import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { GatewayServer } from "./gateway-server";

/**
 * P0 — 审批路由集成测试。
 *
 * 真实缺陷：HITL 请求（hitl-*）登记在 HumanApprovalManager，但 WebUI 聊天
 * 弹窗统一调用 /api/permission/approve|deny（PermissionManager）。若两条
 * 路由不回退，批准高危操作永远 404。
 */
describe("审批路由 — HITL 回退（P0）", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let gateway: GatewayServer;
  let base: string;
  let headers: Record<string, string>;
  let approveOperation: ReturnType<typeof vi.fn>;
  let rejectOperation: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    registry = new ServiceRegistry();
    eventBus = new EventBus();

    // PermissionManager：对 hitl-* 一律不识别（返回 undefined）
    registry.registerService("permissionManager", {
      approveRequest: () => undefined,
      denyRequest: () => undefined,
      getPendingRequests: () => [],
      addToWhitelist: () => ({}),
      removeFromWhitelist: () => true,
      getWhitelist: () => [],
    });

    approveOperation = vi.fn(() => true);
    rejectOperation = vi.fn(() => true);
    registry.registerService("agentModelExecutor", {
      approveOperation,
      rejectOperation,
    });

    gateway = new GatewayServer(registry, eventBus);
    gateway.configure({ port: 0, host: "127.0.0.1", enableWS: false, shutdownTimeoutMs: 2000 });
    await gateway.start();
    const address = (gateway as unknown as { server: { address(): { port: number } } }).server.address();
    base = `http://127.0.0.1:${address.port}`;

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin" }),
    });
    const { token } = await login.json() as { token: string };
    headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  });

  afterEach(async () => {
    await gateway.stop();
  });

  it("/api/permission/approve 对 hitl-* 回退到 executor.approveOperation", async () => {
    const res = await fetch(`${base}/api/permission/approve`, {
      method: "POST", headers, body: JSON.stringify({ requestId: "hitl-abc" }),
    });
    expect(res.status).toBe(200);
    expect(approveOperation).toHaveBeenCalledWith("hitl-abc", "webui", false);
    expect(await res.json()).toMatchObject({ success: true });
  });

  it("/api/permission/deny 对 hitl-* 回退到 executor.rejectOperation", async () => {
    const res = await fetch(`${base}/api/permission/deny`, {
      method: "POST", headers, body: JSON.stringify({ requestId: "hitl-def" }),
    });
    expect(res.status).toBe(200);
    expect(rejectOperation).toHaveBeenCalledWith("hitl-def", "webui", "Denied from Web UI");
  });

  it("/api/approvals/:id/approve 调用 executor.approveOperation", async () => {
    const res = await fetch(`${base}/api/approvals/hitl-ghi/approve`, { method: "POST", headers });
    expect(res.status).toBe(200);
    expect(approveOperation).toHaveBeenCalledWith("hitl-ghi", "api-user", undefined, undefined);
  });

  it("/api/approvals/:id/reject 调用 executor.rejectOperation", async () => {
    const res = await fetch(`${base}/api/approvals/hitl-jkl/reject`, {
      method: "POST", headers, body: JSON.stringify({ reason: "no" }),
    });
    expect(res.status).toBe(200);
    expect(rejectOperation).toHaveBeenCalledWith("hitl-jkl", "api-user", "no");
  });

  it("两条路由在 id 未知时返回 404", async () => {
    approveOperation.mockReturnValue(false);
    rejectOperation.mockReturnValue(false);
    const a = await fetch(`${base}/api/permission/approve`, {
      method: "POST", headers, body: JSON.stringify({ requestId: "hitl-unknown" }),
    });
    expect(a.status).toBe(404);
    const d = await fetch(`${base}/api/permission/deny`, {
      method: "POST", headers, body: JSON.stringify({ requestId: "hitl-unknown" }),
    });
    expect(d.status).toBe(404);
  });
});
