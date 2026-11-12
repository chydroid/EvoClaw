import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { GatewayServer } from "./gateway-server";

/**
 * P2 — /api/plugins/install 的 before_install 准入接线。
 *
 * BeforeInstallHook 类型此前存在但零调用点；安装路由必须：
 * - block → 403 且不注册；
 * - hook 异常 → fail-closed；
 * - 放行 → 正常注册；
 * - 已安装（no-op）→ 不跑钩子。
 */
describe("插件安装路由 — before_install 准入（P2）", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let gateway: GatewayServer;
  let base: string;
  let headers: Record<string, string>;
  let registerPlugin: ReturnType<typeof vi.fn>;
  let runHooks: ReturnType<typeof vi.fn>;
  let installed: Array<{ manifest: { name: string; version: string; description: string }; status: string }>;

  beforeEach(async () => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    installed = [];
    registerPlugin = vi.fn(async (plugin: { manifest: { name: string; version: string; description: string } }) => {
      installed.push({ manifest: plugin.manifest, status: "active" });
    });
    runHooks = vi.fn(async () => ({ blocked: false, cancelled: false, results: [] }));
    registry.registerService("pluginManager", {
      registerPlugin,
      getPlugins: () => installed,
      runHooks,
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

  const install = (name: string) => fetch(`${base}/api/plugins/install`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, version: "1.0.0", source: "test" }),
  });

  it("hook block → 403，且不注册", async () => {
    runHooks.mockResolvedValueOnce({ blocked: true, blockReason: "policy denies untrusted plugin", cancelled: false, results: [] });
    const res = await install("p2-blocked-probe");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ success: false, error: "policy denies untrusted plugin" });
    expect(registerPlugin).not.toHaveBeenCalled();
    expect(runHooks).toHaveBeenCalledWith(expect.objectContaining({
      type: "before_install",
      packageName: "p2-blocked-probe",
      version: "1.0.0",
      source: "test",
    }));
  });

  it("hook 抛错 → fail-closed（403，不注册）", async () => {
    runHooks.mockRejectedValueOnce(new Error("scanner crashed"));
    const res = await install("p2-error-probe");
    expect(res.status).toBe(403);
    expect(String((await res.json() as { error: string }).error)).toContain("guard failed");
    expect(registerPlugin).not.toHaveBeenCalled();
  });

  it("hook 放行 → stub 正常注册", async () => {
    const res = await install("p2-allowed-probe");
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; stub?: boolean };
    expect(body.success).toBe(true);
    expect(body.stub).toBe(true);
    expect(registerPlugin).toHaveBeenCalledTimes(1);
    expect(runHooks).toHaveBeenCalledTimes(1);
  });

  it("已安装（no-op）→ 不跑钩子", async () => {
    installed.push({
      manifest: { name: "p2-existing-probe", version: "1.0.0", description: "x" },
      status: "active",
    });
    const res = await install("p2-existing-probe");
    expect(res.status).toBe(200);
    expect(registerPlugin).not.toHaveBeenCalled();
    expect(runHooks).not.toHaveBeenCalled();
  });
});
