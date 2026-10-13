/**
 * P1-2 Subagent mid-flight steering：SubagentRegistry.steer() + BackgroundDelegator.steerTask()
 *
 * 覆盖：
 * - SubagentRegistry.steer() 软转向（push）/ 硬转向（abort）/ 不可操控（无 steerChannel）/ 终态拒绝
 * - BackgroundDelegator.steerTask() 软指令队列累积 + drainInstructions 取空 + hard steer 触发 abort
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EventBus } from "@evoclaw/core";
import { SubagentRegistry, type SubagentSteerChannel } from "./subagent-registry";
import { BackgroundDelegator } from "./background-delegator";

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

describe("P1-2 BackgroundDelegator.steerTask() / drainInstructions()", () => {
  let delegator: BackgroundDelegator;

  beforeEach(() => {
    delegator = new BackgroundDelegator();
  });

  it("软转向指令累积进 pendingInstructions，drainInstructions 取出后清空", async () => {
    let resolved = false;
    const task = delegator.delegate("do work", async () => {
      // 模拟长任务：期间外部注入指令
      await new Promise((r) => setTimeout(r, 10));
      // DelegateFn 实现方在下一轮 prompt 组装点取出指令
      const drained = delegator.drainInstructions(task.id);
      expect(drained).toEqual(["focus on tests", "focus on docs"]);
      resolved = true;
      return "done";
    });

    delegator.steerTask(task.id, "focus on tests");
    delegator.steerTask(task.id, "focus on docs");
    expect(task.pendingInstructions).toEqual(["focus on tests", "focus on docs"]);

    await delegator.awaitTask(task.id);
    expect(resolved).toBe(true);
    expect(task.pendingInstructions).toEqual([]);
    expect(task.status).toBe("completed");
  });

  it("hard steer 立即取消任务（status=cancelled）", () => {
    const task = delegator.delegate(
      "long running",
      async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return "never";
      },
      { timeoutMs: 60000 },
    );
    // 让 executeTask 内层先跑起来（soft/pending 皆可），再 hard steer
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const ok = delegator.steerTask(task.id, "stop now", { hard: true });
        expect(ok).toBe(true);
        expect(task.status).toBe("cancelled");
        expect(task.lastHardSteer).toBe("stop now");
        resolve();
      }, 10);
    });
  });

  it("终态任务 steerTask 返回 false", async () => {
    const task = delegator.delegate("fast", async () => "quick");
    await delegator.awaitTask(task.id);
    expect(task.status).toBe("completed");
    expect(delegator.steerTask(task.id, "too late")).toBe(false);
  });

  it("buildSteerChannel 返回 push/abort 适配器，桥接到 steerTask", () => {
    const task = delegator.delegate("work", async () => "done");
    const channel = delegator.buildSteerChannel(task.id);
    channel.push("stay on target");
    expect(task.pendingInstructions).toEqual(["stay on target"]);
    channel.abort();
    expect(task.status).toBe("cancelled");
  });
});
