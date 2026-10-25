/**
 * P1-2 Subagent mid-flight steering：SubagentRegistry.steer()
 *
 * 覆盖：
 * - SubagentRegistry.steer() 软转向（push）/ 硬转向（abort）/ 不可操控（无 steerChannel）/ 终态拒绝
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EventBus } from "@evoclaw/core";
import { SubagentRegistry, type SubagentSteerChannel } from "./subagent-registry";

function createSteerChannel() {
  const pushed: string[] = [];
  let aborted = false;
  const channel: SubagentSteerChannel = {
    push: (i: string) => { pushed.push(i); },
    abort: () => { aborted = true; },
  };
  return { channel, pushed, wasAborted: () => aborted };
}

describe("P1-2 SubagentRegistry.steer()", () => {
  let registry: SubagentRegistry;

  beforeEach(() => {
    registry = new SubagentRegistry(new EventBus(), 5);
  });

  it("软转向（默认）调用 steerChannel.push，不 abort", () => {
    const { channel, pushed, wasAborted } = createSteerChannel();
    const info = registry.spawn({
      parentAgentId: "parent",
      workspace: "/tmp/ws",
      toolPolicy: { mode: "allowlist", tools: ["*"] },
      steerChannel: channel,
    });
    expect(info.steerChannel).toBe(channel);

    const ok = registry.steer(info.id, "refocus on error handling");
    expect(ok).toBe(true);
    expect(pushed).toEqual(["refocus on error handling"]);
    expect(wasAborted()).toBe(false);
  });

  it("硬转向调用 steerChannel.abort，并把指令记入 metadata", () => {
    const { channel, wasAborted } = createSteerChannel();
    const info = registry.spawn({
      parentAgentId: "parent",
      workspace: "/tmp/ws",
      toolPolicy: { mode: "allowlist", tools: ["*"] },
      steerChannel: channel,
    });

    const ok = registry.steer(info.id, "hard redirect: stop and pivot", { hard: true });
    expect(ok).toBe(true);
    expect(wasAborted()).toBe(true);
    expect(info.metadata?.["lastHardSteer"]).toBe("hard redirect: stop and pivot");
  });

  it("未注入 steerChannel 的子代理 steer 返回 false", () => {
    const info = registry.spawn({
      parentAgentId: "parent",
      workspace: "/tmp/ws",
      toolPolicy: { mode: "allowlist", tools: ["*"] },
    });
    expect(info.steerChannel).toBeUndefined();
    expect(registry.steer(info.id, "x")).toBe(false);
  });

  it("未知 id 或终态子代理 steer 返回 false", () => {
    const { channel } = createSteerChannel();
    const info = registry.spawn({
      parentAgentId: "parent",
      workspace: "/tmp/ws",
      toolPolicy: { mode: "allowlist", tools: ["*"] },
      steerChannel: channel,
    });
    expect(registry.steer("unknown-id", "x")).toBe(false);

    registry.markDone(info.id);
    expect(registry.steer(info.id, "too late")).toBe(false);
  });
});
