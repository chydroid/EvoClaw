/**
 * 插件钩子接线回归测试（2026-11-23）
 *
 * 背景：审计发现 15 种钩子类型只有 4 种接了派发点，其余全是死码：
 * - before_agent_start：input-pipeline 调用不存在的 `runHook`（单数），
 *   typeof 守卫静默吞掉 → Memory Enhancer 会话初始化、System Logger 请求日志全失效
 * - before_prompt_build：零派发点 → 跨会话记忆恢复、对话摘要、Claude Code 指引全失效
 * - before_agent_reply：零派发点 → Response Validator 自动修复失效
 * - before_model_resolve：零派发点 → 内置 copilot-router 插件是死码
 *
 * 这些测试直接驱动 PluginManager + 各派发点，证明钩子真的会执行且结果被消费。
 */
import { describe, it, expect, vi } from "vitest";
import { PluginManager } from "@evoclaw/core";
import {
  PipelineRunner,
  createPluginPreProcessStage,
  type PipelineContext,
} from "./input-pipeline";

function makePipelineContext(message: string): PipelineContext {
  return {
    message,
    effectiveMessage: message,
    sessionId: "s1",
    channel: "web-ui",
    peerId: "p1",
    agentId: "a1",
    metadata: {},
    shortCircuit: false,
    warnings: [],
  };
}

function makeManager(): PluginManager {
  // 临时目录仅用于 dataDir 字段，本测试不写盘
  return new PluginManager("/tmp/evoclaw-plugin-hook-test");
}

describe("before_agent_start 派发（input-pipeline）", () => {
  it("钩子真的被执行（旧实现调用不存在的 runHook 静默跳过）", async () => {
    const pm = makeManager();
    const handler = vi.fn(async () => ({}));
    await pm.registerPlugin({
      manifest: { name: "probe", version: "1.0.0", description: "probe" },
      hooks: [{ hookType: "before_agent_start", priority: "normal", handler }],
    });

    const runner = new PipelineRunner([createPluginPreProcessStage(pm)]);
    await runner.run(makePipelineContext("hello"));

    expect(handler).toHaveBeenCalledTimes(1);
    const hook = handler.mock.calls[0][0] as { type: string; message: string; context: { sessionId?: string } };
    expect(hook.type).toBe("before_agent_start");
    expect(hook.message).toBe("hello");
    expect(hook.context.sessionId).toBe("s1");
  });

  it("插件改写 message 会被采纳", async () => {
    const pm = makeManager();
    await pm.registerPlugin({
      manifest: { name: "rewriter", version: "1.0.0", description: "rewriter" },
      hooks: [
        {
          hookType: "before_agent_start",
          priority: "normal",
          handler: async () => ({ message: "rewritten" }),
        },
      ],
    });

    const runner = new PipelineRunner([createPluginPreProcessStage(pm)]);
    const ctx = await runner.run(makePipelineContext("original"));
    expect(ctx.effectiveMessage).toBe("rewritten");
  });

  it("插件返回 syntheticReply 会短路整轮", async () => {
    const pm = makeManager();
    await pm.registerPlugin({
      manifest: { name: "synthetic", version: "1.0.0", description: "synthetic" },
      hooks: [
        {
          hookType: "before_agent_start",
          priority: "normal",
          handler: async () => ({ syntheticReply: "canned answer" }),
        },
      ],
    });

    const runner = new PipelineRunner([createPluginPreProcessStage(pm)]);
    const ctx = await runner.run(makePipelineContext("hi"));
    expect(ctx.shortCircuit).toBe(true);
    expect(ctx.shortCircuitReply).toBe("canned answer");
  });

  it("block:true 会短路并带上原因", async () => {
    const pm = makeManager();
    await pm.registerPlugin({
      manifest: { name: "blocker", version: "1.0.0", description: "blocker" },
      hooks: [
        {
          hookType: "before_agent_start",
          priority: "normal",
          handler: async () => ({ block: true, error: "nope" }),
        },
      ],
    });

    const runner = new PipelineRunner([createPluginPreProcessStage(pm)]);
    const ctx = await runner.run(makePipelineContext("hi"));
    expect(ctx.shortCircuit).toBe(true);
    expect(ctx.shortCircuitReply).toBe("nope");
  });

  it("appendSystemContext 落到 metadata 供 executor 取用", async () => {
    const pm = makeManager();
    await pm.registerPlugin({
      manifest: { name: "ctx", version: "1.0.0", description: "ctx" },
      hooks: [
        {
          hookType: "before_agent_start",
          priority: "normal",
          handler: async () => ({ appendSystemContext: "extra context" }),
        },
      ],
    });

    const runner = new PipelineRunner([createPluginPreProcessStage(pm)]);
    const ctx = await runner.run(makePipelineContext("hi"));
    expect(ctx.metadata.pluginAppendSystemContext).toBe("extra context");
  });

  it("没有该钩子的插件不会报错，也不改动上下文", async () => {
    const pm = makeManager();
    await pm.registerPlugin({
      manifest: { name: "unrelated", version: "1.0.0", description: "unrelated" },
      hooks: [{ hookType: "agent_end", priority: "normal", handler: async () => ({}) }],
    });

    const runner = new PipelineRunner([createPluginPreProcessStage(pm)]);
    const ctx = await runner.run(makePipelineContext("hi"));
    expect(ctx.effectiveMessage).toBe("hi");
    expect(ctx.shortCircuit).toBe(false);
  });
});

describe("PluginManager 钩子派发面（契约）", () => {
  it("不存在单数 runHook —— 这正是旧代码静默失效的根因", () => {
    const pm = makeManager();
    expect((pm as unknown as { runHook?: unknown }).runHook).toBeUndefined();
    expect(typeof pm.runHooks).toBe("function");
    expect(typeof pm.runHooksMerged).toBe("function");
    expect(typeof pm.runHooksRaw).toBe("function");
  });

  it("before_prompt_build / before_agent_reply / before_model_resolve 都能被派发", async () => {
    const pm = makeManager();
    const seen: string[] = [];
    await pm.registerPlugin({
      manifest: { name: "all-hooks", version: "1.0.0", description: "all" },
      hooks: [
        { hookType: "before_prompt_build", priority: "normal", handler: async () => { seen.push("prompt"); return {}; } },
        { hookType: "before_agent_reply", priority: "normal", handler: async () => { seen.push("reply"); return {}; } },
        { hookType: "before_model_resolve", priority: "normal", handler: async () => { seen.push("model"); return {}; } },
      ],
    });

    await pm.runHooksMerged({
      type: "before_prompt_build",
      context: { sessionId: "s1" },
      messages: [],
      systemPrompt: "sys",
    });
    await pm.runHooksMerged({
      type: "before_agent_reply",
      context: { sessionId: "s1" },
      messages: [{ role: "assistant", content: "hi" }],
      model: "m",
      provider: "p",
    });
    await pm.runHooksMerged({
      type: "before_model_resolve",
      context: { sessionId: "s1" },
      text: "hello",
      model: "m",
      provider: "p",
    });

    expect(seen).toEqual(["prompt", "reply", "model"]);
  });
});
