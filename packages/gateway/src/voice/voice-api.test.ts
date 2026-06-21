import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { GatewayServer, VoiceService } from "../index";
import { AuthProvider } from "../auth-provider";

describe("Voice API", () => {
  let tmpDir: string;
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let gateway: GatewayServer;
  let voice: VoiceService;
  let authHeader: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-api-test-"));
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    voice = new VoiceService(tmpDir);
    registry.registerService("voiceService", voice);
    gateway = new GatewayServer(registry, eventBus);
    const authProvider = registry.resolveService<AuthProvider>("authProvider")!;
    authHeader = `Bearer ${authProvider.generateToken("voice-test")}`;
  });

  afterEach(async () => {
    try {
      await gateway.stop();
    } catch { /* noop */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startServer(): Promise<number> {
    gateway.configure({ port: 0, host: "127.0.0.1", enableWS: false, shutdownTimeoutMs: 2000 });
    await gateway.start();
    const address = (gateway as any).server.address();
    return typeof address === "object" && address ? address.port : 0;
  }

  it("GET /api/voice 返回默认配置与状态", async () => {
    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/voice`, {
      headers: { Authorization: authHeader },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.enabled).toBe(false);
    expect(body.config.engine).toBe("browser");
    expect(body.status.available).toBe(false);
  });

  it("POST /api/voice/verify 返回验证结果", async () => {
    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/voice/verify`, {
      method: "POST",
      headers: { Authorization: authHeader },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.available).toBe(true);
  });

  it("未验证时 POST /api/voice/toggle 拒绝启用", async () => {
    const port = await startServer();
    // 切换到缺少模型的 vosk 引擎，使验证必然失败
    await fetch(`http://127.0.0.1:${port}/api/voice`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ engine: "vosk" }),
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/voice/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status.enabled).toBe(false);
  });

  it("PUT /api/voice 更新配置", async () => {
    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/voice`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ language: "en-US", autoSubmit: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status.engine).toBe("browser");
  });

  it("POST /api/voice/reset 重置配置", async () => {
    const port = await startServer();
    await voice.verify();
    await voice.toggle(true);
    const res = await fetch(`http://127.0.0.1:${port}/api/voice/reset`, {
      method: "POST",
      headers: { Authorization: authHeader },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status.enabled).toBe(false);
  });
});
