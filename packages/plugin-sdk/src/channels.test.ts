/**
 * Channel 扩展样板测试。
 *
 * 覆盖：
 *   - signal/irc channel 的 capabilities 配置正确
 *   - defineChannel 工厂返回正确的 kind/channelId
 *   - create() 返回的 runtime 接口完整（capabilities/connect/disconnect/onMessage/healthCheck）
 *   - healthCheck 在配置缺失时返回 healthy=false
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { ChannelRuntimeContext } from "./channel-runtime.js";

function makeMockContext(
  config: Record<string, unknown> = {},
): ChannelRuntimeContext {
  return {
    channelId: "test",
    logger: {
      fatal: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
    },
    services: {
      get: () => undefined,
      register: () => {},
      has: () => false,
      list: () => [],
    },
    config,
    send: async () => ({ id: "test" }),
  };
}

describe("signal channel 扩展样板", () => {
  beforeEach(() => {
    delete process.env.SIGNAL_PHONE_NUMBER;
    delete process.env.SIGNAL_CLI_API_BASE;
  });
  afterEach(() => {
    delete process.env.SIGNAL_PHONE_NUMBER;
    delete process.env.SIGNAL_CLI_API_BASE;
  });

  it("defineChannel 返回 kind=channel", async () => {
    const mod = await import("./channels/signal.js");
    const channel = mod.SIGNAL_CHANNEL_EXPORT;
    expect(channel.kind).toBe("channel");
    expect(channel.channelId).toBe("signal");
  });

  it("capabilities 配置正确", async () => {
    const mod = await import("./channels/signal.js");
    const caps = mod.SIGNAL_CAPABILITIES_EXPORT;
    expect(caps.text).toBe(true);
    expect(caps.image).toBe(true);
    expect(caps.audio).toBe(true);
    expect(caps.groups).toBe(true);
    expect(caps.reactions).toBe(true);
    expect(caps.maxMessageLength).toBeGreaterThan(1000);
  });

  it("create 返回完整 runtime 接口", async () => {
    const mod = await import("./channels/signal.js");
    const ctx = makeMockContext({
      phoneNumber: "+8613800138000",
      apiBase: "http://localhost:8080",
    });
    const runtime = await mod.SIGNAL_CHANNEL_EXPORT.create(ctx);
    expect(runtime.capabilities).toBeDefined();
    expect(typeof runtime.connect).toBe("function");
    expect(typeof runtime.disconnect).toBe("function");
    expect(typeof runtime.onMessage).toBe("function");
    expect(typeof runtime.healthCheck).toBe("function");
  });

  it("connect 不抛出", async () => {
    const mod = await import("./channels/signal.js");
    const ctx = makeMockContext({
      phoneNumber: "+8613800138000",
    });
    const runtime = await mod.SIGNAL_CHANNEL_EXPORT.create(ctx);
    await expect(runtime.connect!()).resolves.toBeUndefined();
  });

  it("healthCheck 在缺少 phoneNumber 时返回 unhealthy", async () => {
    const mod = await import("./channels/signal.js");
    const ctx = makeMockContext({}); // 无 phoneNumber
    const runtime = await mod.SIGNAL_CHANNEL_EXPORT.create(ctx);
    const result = await runtime.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.detail).toContain("SIGNAL_PHONE_NUMBER");
  });

  it("healthCheck 在配置完整时尝试连接 api", async () => {
    const mod = await import("./channels/signal.js");
    const ctx = makeMockContext({
      phoneNumber: "+8613800138000",
      apiBase: "http://localhost:1", // 不存在的端口
    });
    const runtime = await mod.SIGNAL_CHANNEL_EXPORT.create(ctx);
    const result = await runtime.healthCheck!();
    // 端口 1 不存在，应返回 unhealthy
    expect(result.healthy).toBe(false);
  });
});

describe("irc channel 扩展样板", () => {
  beforeEach(() => {
    delete process.env.IRC_SERVER;
    delete process.env.IRC_PORT;
    delete process.env.IRC_NICK;
    delete process.env.IRC_CHANNELS;
  });
  afterEach(() => {
    delete process.env.IRC_SERVER;
    delete process.env.IRC_PORT;
    delete process.env.IRC_NICK;
    delete process.env.IRC_CHANNELS;
  });

  it("defineChannel 返回 kind=channel", async () => {
    const mod = await import("./channels/irc.js");
    const channel = mod.IRC_CHANNEL_EXPORT;
    expect(channel.kind).toBe("channel");
    expect(channel.channelId).toBe("irc");
  });

  it("capabilities 配置正确（IRC 限制）", async () => {
    const mod = await import("./channels/irc.js");
    const caps = mod.IRC_CAPABILITIES_EXPORT;
    expect(caps.text).toBe(true);
    expect(caps.image).toBe(false); // IRC 不支持原生图片
    expect(caps.audio).toBe(false);
    expect(caps.reactions).toBe(false);
    expect(caps.groups).toBe(true);
    expect(caps.maxMessageLength).toBeLessThanOrEqual(512); // IRC 协议限制
  });

  it("create 返回完整 runtime 接口", async () => {
    const mod = await import("./channels/irc.js");
    const ctx = makeMockContext({
      server: "irc.libera.chat",
      nick: "test-bot",
    });
    const runtime = await mod.IRC_CHANNEL_EXPORT.create(ctx);
    expect(runtime.capabilities).toBeDefined();
    expect(typeof runtime.connect).toBe("function");
    expect(typeof runtime.disconnect).toBe("function");
    expect(typeof runtime.onMessage).toBe("function");
    expect(typeof runtime.healthCheck).toBe("function");
  });

  it("connect 不抛出", async () => {
    const mod = await import("./channels/irc.js");
    const ctx = makeMockContext({
      server: "irc.libera.chat",
      nick: "test-bot",
      channels: "#general,#random",
    });
    const runtime = await mod.IRC_CHANNEL_EXPORT.create(ctx);
    await expect(runtime.connect!()).resolves.toBeUndefined();
  });

  it("healthCheck 在缺少 IRC_SERVER 时返回 unhealthy", async () => {
    const mod = await import("./channels/irc.js");
    const ctx = makeMockContext({}); // 无 server
    const runtime = await mod.IRC_CHANNEL_EXPORT.create(ctx);
    const result = await runtime.healthCheck!();
    expect(result.healthy).toBe(false);
    expect(result.detail).toContain("IRC_SERVER");
  });

  it("healthCheck 在配置完整时返回 healthy", async () => {
    const mod = await import("./channels/irc.js");
    const ctx = makeMockContext({
      server: "irc.libera.chat",
      port: 6667,
      nick: "test-bot",
      channels: "#general",
    });
    const runtime = await mod.IRC_CHANNEL_EXPORT.create(ctx);
    const result = await runtime.healthCheck!();
    expect(result.healthy).toBe(true);
    expect(result.detail).toContain("irc.libera.chat");
    expect(result.detail).toContain("test-bot");
  });

  it("channels 解析逗号分隔字符串", async () => {
    const mod = await import("./channels/irc.js");
    const ctx = makeMockContext({
      server: "irc.libera.chat",
      channels: " #general , #random ,",
    });
    const runtime = await mod.IRC_CHANNEL_EXPORT.create(ctx);
    await runtime.connect!();
    // 通过 healthCheck detail 验证配置已就绪
    const result = await runtime.healthCheck!();
    expect(result.healthy).toBe(true);
  });
});
