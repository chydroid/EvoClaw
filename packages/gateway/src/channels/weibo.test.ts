/**
 * weibo.test — 微博通道适配器测试
 */

import { describe, it, expect, vi } from "vitest";
import { WeiboAdapter, type WeiboConfig } from "./weibo";
import type { ChannelConfig, ChannelMessage } from "../channel-manager";

// ── 辅助 ──────────────────────────────────────────────

function makeConfig(overrides: Partial<WeiboConfig> = {}): ChannelConfig {
  return {
    type: "weibo",
    enabled: true,
    label: "微博",
    dmPolicy: "open",
    allowFrom: [],
    blockFrom: [],
    settings: {
      mode: "dm",
      appKey: "test-app-key",
      appSecret: "test-app-secret",
      ...overrides,
    } as unknown as Record<string, unknown>,
  };
}

// ── WeiboAdapter ─────────────────────────────────────

describe("WeiboAdapter", () => {
  it("type 为 weibo", () => {
    const adapter = new WeiboAdapter(makeConfig());
    expect(adapter.type).toBe("weibo");
  });

  it("start 缺少 appKey 时报错", async () => {
    const adapter = new WeiboAdapter(makeConfig({ appKey: "" }));
    const onStatus = vi.fn();
    adapter.onStatusChange(onStatus);
    await adapter.start();
    expect(onStatus).toHaveBeenCalledWith("error");
  });

  it("start 缺少 appSecret 时报错", async () => {
    const adapter = new WeiboAdapter(makeConfig({ appSecret: "" }));
    const onStatus = vi.fn();
    adapter.onStatusChange(onStatus);
    await adapter.start();
    expect(onStatus).toHaveBeenCalledWith("error");
  });

  it("start 成功时设为 connected", async () => {
    const adapter = new WeiboAdapter(makeConfig());
    const onStatus = vi.fn();
    adapter.onStatusChange(onStatus);
    await adapter.start();
    expect(onStatus).toHaveBeenCalledWith("connected");
  });

  it("stop 设为 disconnected", async () => {
    const adapter = new WeiboAdapter(makeConfig());
    const onStatus = vi.fn();
    adapter.onStatusChange(onStatus);
    await adapter.start();
    await adapter.stop();
    expect(onStatus).toHaveBeenCalledWith("disconnected");
  });

  it("healthCheck 无 accessToken 时不健康", async () => {
    const adapter = new WeiboAdapter(makeConfig({ accessToken: undefined }));
    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(false);
  });

  it("sendMessage 无 accessToken 时失败", async () => {
    const adapter = new WeiboAdapter(makeConfig({ accessToken: undefined }));
    const result = await adapter.sendMessage("user123", "hello");
    expect(result.success).toBe(false);
    expect(result.error).toContain("access token");
    expect(result.channel).toBe("weibo");
  });

  it("onMessage 注册消息处理器", () => {
    const adapter = new WeiboAdapter(makeConfig());
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(handler);
    expect(handler).toBeDefined();
  });

  it("onStatusChange 注册状态处理器", () => {
    const adapter = new WeiboAdapter(makeConfig());
    const handler = vi.fn();
    adapter.onStatusChange(handler);
    expect(handler).toBeDefined();
  });

  it("handleCallback 处理私信事件", async () => {
    const adapter = new WeiboAdapter(makeConfig({ accessToken: "test-token" }));
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(handler);

    const callbackBody = JSON.stringify({
      event: "dm",
      from_user: "user456",
      text: "测试消息",
      id: 12345,
    });

    const result = await adapter.handleCallback(callbackBody);
    expect(result).toBe("ok");
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      from: "user456",
      text: "测试消息",
      channel: "weibo",
    }));
  });

  it("handleCallback 非 JSON 格式返回 ok", async () => {
    const adapter = new WeiboAdapter(makeConfig());
    const result = await adapter.handleCallback("not json");
    expect(result).toBe("ok");
  });

  it("handleCallback 消息去重", async () => {
    const adapter = new WeiboAdapter(makeConfig({ accessToken: "test-token" }));
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(handler);

    const callbackBody = JSON.stringify({
      event: "dm",
      from_user: "user456",
      text: "测试消息",
      id: 99999,
    });

    // 第一次调用应该触发 handler
    await adapter.handleCallback(callbackBody);
    expect(handler).toHaveBeenCalledTimes(1);

    // 第二次相同 id 不应触发
    await adapter.handleCallback(callbackBody);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("comment 模式启动轮询", async () => {
    const adapter = new WeiboAdapter(makeConfig({
      mode: "comment",
      accessToken: "test-token",
      listenWeiboId: "weibo-123",
    }));
    const onStatus = vi.fn();
    adapter.onStatusChange(onStatus);
    await adapter.start();
    expect(onStatus).toHaveBeenCalledWith("connected");
    await adapter.stop();
  });

  it("comment 模式缺少 listenWeiboId 时报错", async () => {
    const adapter = new WeiboAdapter(makeConfig({
      mode: "comment",
      accessToken: "test-token",
      listenWeiboId: undefined,
    }));
    const onStatus = vi.fn();
    adapter.onStatusChange(onStatus);
    await adapter.start();
    expect(onStatus).toHaveBeenCalledWith("error");
  });
});
