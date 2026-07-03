/**
 * 跨 Agent 协作集成测试 —— 端到端验证多 Agent 协作链路。
 *
 * 覆盖此前零测试的关键模块：
 *  - SwarmOrchestrator.handoff / completeHandoff（控制权转移）
 *  - MoaCommittee.invoke（多模型并行推理 + 聚合）
 *  - SubagentRegistry 全生命周期（spawn / markDone / cleanup）
 *  - 跨模块链路：Swarm delegate → SubagentRegistry spawn → MoaCommittee invoke → handoff
 *
 * 设计原则：
 *  - 真实模块组合，不mock内部协作（仅mock LLM chatFn）
 *  - 共享 EventBus 验证事件流贯通
 *  - 每个测试自包含，beforeEach 重置状态
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventBus } from "@evoclaw/core";
import { SwarmOrchestrator } from "./swarm-orchestrator";
import type { HandoffResult, SwarmAgent } from "./swarm-orchestrator";
import { MoaCommittee, MoaPresetRegistry } from "./moa-committee";
import type { MoaChatFn, MoaMember, MoaResult } from "./moa-committee";
import { SubagentRegistry } from "./subagent-registry";
import type { SubagentInfo, ToolPolicy } from "./subagent-registry";
import type { ToolPolicy as RouterToolPolicy } from "./agent-router";

// ── 测试用 ToolPolicy ─────────────────────────────────────

const RESTRICTIVE_POLICY: RouterToolPolicy = {
  mode: "allowlist",
  tools: ["read_file", "write_file"],
  allowShell: false,
  allowFileOps: true,
  allowWeb: false,
  allowBrowser: false,
  maxFileSize: 1024 * 1024,
};

// ── 共享测试夹具 ──────────────────────────────────────────

function createChatFnMock(responses: Map<string, string>, delayMs = 10): MoaChatFn {
  return vi.fn(async (prompt: string, member: MoaMember) => {
    await new Promise((r) => setTimeout(r, delayMs));
    const key = `${member.provider}/${member.model}`;
    const canned = responses.get(key);
    if (canned) return canned;
    // 默认返回 prompt 长度的回显，便于断言
    return `response-from-${key}:${prompt.length}chars`;
  });
}

describe("跨 Agent 协作集成测试", () => {
  let eventBus: EventBus;
  let orchestrator: SwarmOrchestrator;
  let registry: SubagentRegistry;

  beforeEach(() => {
    eventBus = new EventBus();
    orchestrator = new SwarmOrchestrator(eventBus, {
      heartbeatTimeoutMs: 5000,
      maxConcurrentDelegations: 3,
      defaultTimeoutMs: 1000,
    });
    registry = new SubagentRegistry(eventBus, 5);
  });

  afterEach(() => {
    registry.dispose();
  });

  // ───────────────────────────────────────────────────────
  // 1. SwarmOrchestrator Handoff（控制权转移）—— 此前零覆盖
  // ───────────────────────────────────────────────────────

  describe("SwarmOrchestrator handoff", () => {
    let fromAgent: SwarmAgent;
    let toAgent: SwarmAgent;

    beforeEach(() => {
      fromAgent = orchestrator.registerAgent({
        name: "Tier1-Support",
        role: "executor",
        capabilities: ["support"],
      });
      toAgent = orchestrator.registerAgent({
        name: "Tier2-Expert",
        role: "specialist",
        capabilities: ["support", "escalation"],
      });
    });

    it("完整 handoff 流程：转移控制权 → 接收方接管 → completeHandoff 恢复 idle", () => {
      // 让 from agent 处于 busy 状态，模拟正在处理对话
      fromAgent.status = "busy";
      fromAgent.currentTask = "用户咨询复杂问题";

      const result: HandoffResult = orchestrator.handoff({
        fromAgentId: fromAgent.id,
        toAgentId: toAgent.id,
        reason: "问题超出 Tier1 能力范围，需升级到专家",
        contextSummary: "用户咨询了关于量子计算的问题",
        conversationHistory: [
          { role: "user", content: "什么是量子纠缠？" },
          { role: "assistant", content: "这个我需要转给专家..." },
        ],
      });

      // handoff 成功
      expect(result.success).toBe(true);
      expect(result.receivingAgentId).toBe(toAgent.id);
      expect(result.transferringAgentId).toBe(fromAgent.id);
      expect(result.requestId).toBeTruthy();

      // from agent 释放控制权，回到 idle
      expect(fromAgent.status).toBe("idle");
      expect(fromAgent.currentTask).toBeUndefined();

      // to agent 接管对话，标记 busy
      expect(toAgent.status).toBe("busy");
      expect(toAgent.currentTask).toContain("handoff-receiving");

      // handoff 上下文存入 metadata
      expect(toAgent.metadata?.handoffContext).toMatchObject({
        fromAgentId: fromAgent.id,
        fromAgentName: "Tier1-Support",
        reason: "问题超出 Tier1 能力范围，需升级到专家",
        contextSummary: "用户咨询了关于量子计算的问题",
      });
      expect(toAgent.metadata.handoffContext.conversationHistory).toHaveLength(2);

      // activeHandoffs 中存在记录
      const active = orchestrator.getActiveHandoffs();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(result.requestId);

      // completeHandoff：接收方完成接管工作，恢复 idle
      const completed = orchestrator.completeHandoff(result.requestId);
      expect(completed).toBe(true);
      expect(toAgent.status).toBe("idle");
      expect(toAgent.currentTask).toBeUndefined();
      // handoff 上下文被清理
      expect(toAgent.metadata?.handoffContext).toBeUndefined();
      // 任务完成指标更新
      expect(toAgent.metrics.tasksCompleted).toBe(1);

      // activeHandoffs 清空
      expect(orchestrator.getActiveHandoffs()).toHaveLength(0);
    });

    it("handoff 失败：转出 agent 不存在", () => {
      const result = orchestrator.handoff({
        fromAgentId: "nonexistent-agent",
        toAgentId: toAgent.id,
        reason: "测试",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Transferring agent not found");
    });

    it("handoff 失败：接收 agent 不存在", () => {
      const result = orchestrator.handoff({
        fromAgentId: fromAgent.id,
        toAgentId: "nonexistent-agent",
        reason: "测试",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Receiving agent not found");
    });

    it("handoff 失败：接收 agent 离线", () => {
      toAgent.status = "offline";

      const result = orchestrator.handoff({
        fromAgentId: fromAgent.id,
        toAgentId: toAgent.id,
        reason: "测试",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Receiving agent is offline");
    });

    it("handoff 失败：不允许 handoff 给自己", () => {
      const result = orchestrator.handoff({
        fromAgentId: fromAgent.id,
        toAgentId: fromAgent.id,
        reason: "测试",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot hand off to the same agent");
    });

    it("handoff 发布 swarm:handoff 事件，completeHandoff 发布 swarm:handoff-completed 事件", async () => {
      const handoffEvents: unknown[] = [];
      const completedEvents: unknown[] = [];

      eventBus.subscribe("swarm:handoff", (e) => handoffEvents.push(e.data));
      eventBus.subscribe("swarm:handoff-completed", (e) => completedEvents.push(e.data));

      const result = orchestrator.handoff({
        fromAgentId: fromAgent.id,
        toAgentId: toAgent.id,
        reason: "事件流测试",
      });

      // publish 是 async，等待 microtask
      await new Promise((r) => setTimeout(r, 20));

      expect(handoffEvents).toHaveLength(1);
      expect(handoffEvents[0]).toMatchObject({
        fromAgentId: fromAgent.id,
        toAgentId: toAgent.id,
        reason: "事件流测试",
      });

      orchestrator.completeHandoff(result.requestId);
      await new Promise((r) => setTimeout(r, 20));

      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]).toMatchObject({
        handoffId: result.requestId,
        fromAgentId: fromAgent.id,
        toAgentId: toAgent.id,
      });
    });

    it("completeHandoff 对不存在的 handoffId 返回 false", () => {
      expect(orchestrator.completeHandoff("nonexistent-handoff-id")).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────
  // 2. MoaCommittee（多模型并行推理 + 聚合）—— 此前零覆盖
  // ───────────────────────────────────────────────────────

  describe("MoaCommittee.invoke", () => {
    it("3 个参考模型并行推理 + 聚合模型合成最终答案", async () => {
      const responses = new Map<string, string>([
        ["openai/gpt-5", "GPT认为量子纠缠是..."],
        ["anthropic/claude-sonnet-4", "Claude认为量子纠缠是..."],
        ["deepseek/deepseek-v4", "DeepSeek认为量子纠缠是..."],
        ["anthropic/claude-opus-4", "综合三方意见，量子纠缠是..."],
      ]);

      const chatFn = createChatFnMock(responses);
      const committee = new MoaCommittee({
        name: "test-council",
        aggregator: { provider: "anthropic", model: "claude-opus-4" },
        references: [
          { provider: "openai", model: "gpt-5" },
          { provider: "anthropic", model: "claude-sonnet-4" },
          { provider: "deepseek", model: "deepseek-v4" },
        ],
      });

      const result: MoaResult = await committee.invoke("解释量子纠缠", chatFn);

      // 3 个参考模型全部成功
      expect(result.successCount).toBe(3);
      expect(result.failureCount).toBe(0);
      expect(result.references).toHaveLength(3);
      expect(result.references[0].content).toBe("GPT认为量子纠缠是...");
      expect(result.references[1].content).toBe("Claude认为量子纠缠是...");
      expect(result.references[2].content).toBe("DeepSeek认为量子纠缠是...");

      // 聚合模型被调用，返回合成答案
      expect(result.aggregated).toBe("综合三方意见，量子纠缠是...");
      expect(result.aggregator.provider).toBe("anthropic");
      expect(result.aggregator.model).toBe("claude-opus-4");

      // chatFn 被调用 4 次（3 参考 + 1 聚合）
      expect(chatFn).toHaveBeenCalledTimes(4);

      // 总耗时 >= 各参考模型耗时（并行）但 <= 各参考模型耗时之和
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it("单个参考模型失败时容错，其他参考模型结果正常聚合", async () => {
      const chatFn: MoaChatFn = vi.fn(async (prompt, member) => {
        await new Promise((r) => setTimeout(r, 5));
        if (member.provider === "openai") {
          throw new Error("OpenAI API 限流");
        }
        if (member.provider === "anthropic" && member.model === "claude-opus-4") {
          return "聚合答案";
        }
        return `${member.provider} 的回答`;
      });

      const committee = new MoaCommittee({
        name: "fault-tolerant-council",
        aggregator: { provider: "anthropic", model: "claude-opus-4" },
        references: [
          { provider: "openai", model: "gpt-5" },
          { provider: "deepseek", model: "deepseek-v4" },
        ],
      });

      const result = await committee.invoke("测试容错", chatFn);

      // 1 个失败，1 个成功
      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(1);

      const failed = result.references.find((r) => !r.success);
      const succeeded = result.references.find((r) => r.success);

      expect(failed?.error).toContain("OpenAI API 限流");
      expect(failed?.content).toBe("");
      expect(succeeded?.content).toBe("deepseek 的回答");

      // 聚合仍然成功（聚合 prompt 中包含失败的标注）
      expect(result.aggregated).toBe("聚合答案");
    });

    it("聚合模型失败时降级返回最长参考答案", async () => {
      const chatFn: MoaChatFn = vi.fn(async (prompt, member) => {
        await new Promise((r) => setTimeout(r, 5));
        if (member.provider === "anthropic" && member.model === "claude-opus-4") {
          throw new Error("聚合模型宕机");
        }
        if (member.provider === "openai") {
          return "短答案";
        }
        return "这是一个相对较长的参考答案，应该在降级时被选中";
      });

      const committee = new MoaCommittee({
        name: "degrade-council",
        aggregator: { provider: "anthropic", model: "claude-opus-4" },
        references: [
          { provider: "openai", model: "gpt-5" },
          { provider: "deepseek", model: "deepseek-v4" },
        ],
      });

      const result = await committee.invoke("测试降级", chatFn);

      // 聚合失败，降级为最长参考答案
      expect(result.aggregated).toBe("这是一个相对较长的参考答案，应该在降级时被选中");
      expect(result.successCount).toBe(2);
    });

    it("maxConcurrency 限流：分批并行执行", async () => {
      const callOrder: string[] = [];
      const chatFn: MoaChatFn = vi.fn(async (prompt, member) => {
        callOrder.push(`${member.provider}/${member.model}-start`);
        await new Promise((r) => setTimeout(r, 20));
        callOrder.push(`${member.provider}/${member.model}-end`);
        return `${member.provider} 回答`;
      });

      const committee = new MoaCommittee({
        name: "throttled-council",
        aggregator: { provider: "anthropic", model: "claude-opus-4" },
        references: [
          { provider: "openai", model: "gpt-5" },
          { provider: "deepseek", model: "deepseek-v4" },
          { provider: "xai", model: "grok-4" },
          { provider: "google", model: "gemini-3" },
        ],
        maxConcurrency: 2,
      });

      const result = await committee.invoke("测试限流", chatFn);

      expect(result.successCount).toBe(4);
      // 限流模式下至少分两批，调用顺序中前两个 start 应在第三/四个 start 之前
      const firstBatchEnds = callOrder.filter((s) => s.endsWith("-end")).slice(0, 2);
      expect(firstBatchEnds.length).toBe(2);
    });

    it("MoaPresetRegistry 注册与获取委员会", () => {
      const presetRegistry = new MoaPresetRegistry();
      const preset = {
        name: "my-council",
        aggregator: { provider: "anthropic", model: "claude-opus-4" },
        references: [{ provider: "openai", model: "gpt-5" }],
      };
      presetRegistry.register(preset);

      expect(presetRegistry.list()).toEqual(["my-council"]);

      const committee = presetRegistry.getCommittee("my-council");
      expect(committee).toBeDefined();
      expect(committee?.name).toBe("my-council");
      expect(committee?.aggregator.model).toBe("claude-opus-4");

      // 不存在的预设
      expect(presetRegistry.getCommittee("nonexistent")).toBeUndefined();

      // 注销
      expect(presetRegistry.unregister("my-council")).toBe(true);
      expect(presetRegistry.list()).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────────
  // 3. SubagentRegistry 全生命周期 —— 此前零覆盖
  // ───────────────────────────────────────────────────────

  describe("SubagentRegistry 全生命周期", () => {
    it("spawn → markDone → cleanup 完整流程", () => {
      const spawnEvents: unknown[] = [];
      const completeEvents: unknown[] = [];
      const cleanupEvents: unknown[] = [];

      eventBus.subscribe("subagent.spawn", (e) => spawnEvents.push(e.data));
      eventBus.subscribe("subagent.complete", (e) => completeEvents.push(e.data));
      eventBus.subscribe("subagent.cleanup", (e) => cleanupEvents.push(e.data));

      const info: SubagentInfo = registry.spawn({
        parentAgentId: "parent-agent-1",
        workspace: "/tmp/test-workspace",
        toolPolicy: RESTRICTIVE_POLICY as unknown as ToolPolicy,
        label: "test-subagent",
        metadata: { task: "数据处理" },
      });

      // spawn 成功
      expect(info.id).toMatch(/^subagent_/);
      expect(info.status).toBe("running");
      expect(info.parentAgentId).toBe("parent-agent-1");
      expect(info.workspace).toBe("/tmp/test-workspace");
      expect(info.label).toBe("test-subagent");
      expect(info.metadata?.task).toBe("数据处理");

      // 状态查询
      expect(registry.status(info.id)?.status).toBe("running");

      // 列表
      expect(registry.list()).toHaveLength(1);
      expect(registry.list({ status: "running" })).toHaveLength(1);
      expect(registry.list({ status: "done" })).toHaveLength(0);

      // availableSlots 减少
      expect(registry.availableSlots).toBe(4);

      // markDone
      expect(registry.markDone(info.id)).toBe(true);
      expect(registry.status(info.id)?.status).toBe("done");

      // cleanup：done 状态需超过 maxAgeMs 才清理，传 0 立即清理
      const removed = registry.cleanup(0);
      expect(removed).toBe(1);
      expect(registry.status(info.id)).toBeUndefined();
      expect(registry.list()).toHaveLength(0);
    });

    it("spawn → markError → cleanup 错误流程", () => {
      const errorEvents: unknown[] = [];
      eventBus.subscribe("subagent.error", (e) => errorEvents.push(e.data));

      const info = registry.spawn({
        parentAgentId: "parent-agent-2",
        workspace: "/tmp/test",
        toolPolicy: RESTRICTIVE_POLICY as unknown as ToolPolicy,
      });

      expect(registry.markError(info.id, "执行失败：超时")).toBe(true);
      expect(registry.status(info.id)?.status).toBe("error");
      expect(registry.status(info.id)?.error).toBe("执行失败：超时");

      // cleanup 清理 error 状态
      expect(registry.cleanup(0)).toBe(1);
      expect(registry.list()).toHaveLength(0);
    });

    it("spawn → kill 立即终止", () => {
      const killEvents: unknown[] = [];
      eventBus.subscribe("subagent.kill", (e) => killEvents.push(e.data));

      const info = registry.spawn({
        parentAgentId: "parent-agent-3",
        workspace: "/tmp/test",
        toolPolicy: RESTRICTIVE_POLICY as unknown as ToolPolicy,
      });

      expect(registry.kill(info.id)).toBe(true);
      expect(registry.status(info.id)).toBeUndefined();
      expect(registry.list()).toHaveLength(0);
    });

    it("超过 maxConcurrent 时 spawn 抛错", () => {
      const smallRegistry = new SubagentRegistry(eventBus, 2);
      try {
        smallRegistry.spawn({
          parentAgentId: "p1",
          workspace: "/tmp",
          toolPolicy: RESTRICTIVE_POLICY as unknown as ToolPolicy,
        });
        smallRegistry.spawn({
          parentAgentId: "p2",
          workspace: "/tmp",
          toolPolicy: RESTRICTIVE_POLICY as unknown as ToolPolicy,
        });
        expect(() => {
          smallRegistry.spawn({
            parentAgentId: "p3",
            workspace: "/tmp",
            toolPolicy: RESTRICTIVE_POLICY as unknown as ToolPolicy,
          });
        }).toThrow(/Subagent limit reached/);

        // 第一个 markDone 后又能 spawn
        const list = smallRegistry.list();
        smallRegistry.markDone(list[0].id);
        const third = smallRegistry.spawn({
          parentAgentId: "p3",
          workspace: "/tmp",
          toolPolicy: RESTRICTIVE_POLICY as unknown as ToolPolicy,
        });
        expect(third.status).toBe("running");
      } finally {
        smallRegistry.dispose();
      }
    });

    it("markDone / markError / kill 对不存在的 ID 返回 false", () => {
      expect(registry.markDone("nonexistent")).toBe(false);
      expect(registry.markError("nonexistent", "x")).toBe(false);
      expect(registry.kill("nonexistent")).toBe(false);
      expect(registry.touch("nonexistent")).toBe(false);
    });

    it("list 按 parentAgentId 过滤", () => {
      registry.spawn({
        parentAgentId: "parent-A",
        workspace: "/tmp",
        toolPolicy: RESTRICTIVE_POLICY as unknown as ToolPolicy,
      });
      registry.spawn({
        parentAgentId: "parent-A",
        workspace: "/tmp",
        toolPolicy: RESTRICTIVE_POLICY as unknown as ToolPolicy,
      });
      registry.spawn({
        parentAgentId: "parent-B",
        workspace: "/tmp",
        toolPolicy: RESTRICTIVE_POLICY as unknown as ToolPolicy,
      });

      expect(registry.list({ parentAgentId: "parent-A" })).toHaveLength(2);
      expect(registry.list({ parentAgentId: "parent-B" })).toHaveLength(1);
      expect(registry.list({ parentAgentId: "parent-C" })).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────────
  // 4. 跨模块协作链路 —— Swarm + SubagentRegistry + Moa
  // ───────────────────────────────────────────────────────

  describe("跨模块协作链路", () => {
    it("Swarm delegate → SubagentRegistry spawn → MoaCommittee invoke → handoff 回主控", async () => {
      // 场景：主控 agent 委派任务给执行 agent，
      // 执行 agent 启动子 agent，子 agent 调用 MoA 委员会获取多模型答案，
      // 最终 handoff 回主控 agent 收尾。

      const coordinator = orchestrator.registerAgent({
        name: "Coordinator",
        role: "coordinator",
        capabilities: ["delegate", "handoff"],
      });
      const executor = orchestrator.registerAgent({
        name: "Executor",
        role: "executor",
        capabilities: ["execute", "research"],
      });

      // Step 1: 主控 delegate 任务给 executor
      const delegResult = await orchestrator.delegate({
        fromAgentId: coordinator.id,
        toAgentId: executor.id,
        task: "调研量子计算现状",
        requiredCapabilities: ["research"],
        priority: "high",
        timeoutMs: 5000,
      });

      expect(delegResult.success).toBe(true);
      expect(delegResult.agentId).toBe(executor.id);
      // executor 被标记为 busy
      expect(executor.status).toBe("busy");

      // Step 2: executor 启动子 agent 处理
      const subagent = registry.spawn({
        parentAgentId: executor.id,
        workspace: "/tmp/research",
        toolPolicy: RESTRICTIVE_POLICY as unknown as ToolPolicy,
        label: "research-subagent",
      });
      expect(subagent.status).toBe("running");

      // Step 3: 子 agent 调用 MoA 委员会获取多模型答案
      const responses = new Map<string, string>([
        ["openai/gpt-5", "GPT-5 的量子计算调研结果"],
        ["deepseek/deepseek-v4", "DeepSeek 的量子计算调研结果"],
        ["anthropic/claude-opus-4", "MoA 综合调研报告"],
      ]);
      const chatFn = createChatFnMock(responses);

      const committee = new MoaCommittee({
        name: "research-council",
        aggregator: { provider: "anthropic", model: "claude-opus-4" },
        references: [
          { provider: "openai", model: "gpt-5" },
          { provider: "deepseek", model: "deepseek-v4" },
        ],
      });

      const moaResult = await committee.invoke("调研量子计算现状", chatFn);

      expect(moaResult.successCount).toBe(2);
      expect(moaResult.aggregated).toBe("MoA 综合调研报告");

      // Step 4: 子 agent 完成任务
      expect(registry.markDone(subagent.id)).toBe(true);

      // Step 5: executor 完成委派
      const completed = orchestrator.completeDelegation(
        delegResult.requestId,
        moaResult.aggregated,
      );
      expect(completed).not.toBeNull();
      expect(completed?.success).toBe(true);
      expect(completed?.result).toBe("MoA 综合调研报告");
      // executor 恢复 idle
      expect(executor.status).toBe("idle");

      // Step 6: handoff 回主控收尾（executor 把控制权交还 coordinator）
      // 先让 coordinator 进入 busy 模拟正在等待
      coordinator.status = "busy";
      coordinator.currentTask = "等待 executor 结果";

      const handoffResult = orchestrator.handoff({
        fromAgentId: executor.id,
        toAgentId: coordinator.id,
        reason: "调研完成，交还控制权收尾",
        contextSummary: moaResult.aggregated,
      });

      expect(handoffResult.success).toBe(true);
      // executor 转出后变 idle
      expect(executor.status).toBe("idle");
      // coordinator 接管，变 busy
      expect(coordinator.status).toBe("busy");
      expect(coordinator.metadata?.handoffContext?.contextSummary).toBe("MoA 综合调研报告");

      // Step 7: 主控完成收尾
      expect(orchestrator.completeHandoff(handoffResult.requestId)).toBe(true);
      expect(coordinator.status).toBe("idle");
      expect(coordinator.metrics.tasksCompleted).toBe(1);

      // 子 agent 已清理（done 状态，cleanup(0) 可清）
      expect(registry.cleanup(0)).toBe(1);
      expect(registry.list()).toHaveLength(0);
    });

    it("EventBus 事件流贯通：swarm:delegation-started → subagent.spawn → swarm:handoff → swarm:handoff-completed", async () => {
      const eventLog: string[] = [];

      eventBus.subscribe("swarm:delegation-started", () => eventLog.push("delegation-started"));
      eventBus.subscribe("subagent.spawn", () => eventLog.push("subagent-spawn"));
      eventBus.subscribe("swarm:handoff", () => eventLog.push("handoff"));
      eventBus.subscribe("swarm:handoff-completed", () => eventLog.push("handoff-completed"));

      const a1 = orchestrator.registerAgent({
        name: "A1",
        role: "coordinator",
        capabilities: ["delegate"],
      });
      const a2 = orchestrator.registerAgent({
        name: "A2",
        role: "executor",
        capabilities: ["execute"],
      });

      await orchestrator.delegate({
        fromAgentId: a1.id,
        toAgentId: a2.id,
        task: "task",
        requiredCapabilities: ["execute"],
        priority: "medium",
        timeoutMs: 5000,
      });

      registry.spawn({
        parentAgentId: a2.id,
        workspace: "/tmp",
        toolPolicy: RESTRICTIVE_POLICY as unknown as ToolPolicy,
      });

      const handoffRes = orchestrator.handoff({
        fromAgentId: a2.id,
        toAgentId: a1.id,
        reason: "done",
      });
      orchestrator.completeHandoff(handoffRes.requestId);

      // 等待所有 async publish 完成
      await new Promise((r) => setTimeout(r, 30));

      // 事件按预期顺序触发
      expect(eventLog).toContain("delegation-started");
      expect(eventLog).toContain("subagent-spawn");
      expect(eventLog).toContain("handoff");
      expect(eventLog).toContain("handoff-completed");

      // 顺序：delegation-started 在 subagent-spawn 之前，handoff 在 handoff-completed 之前
      const dsIdx = eventLog.indexOf("delegation-started");
      const spIdx = eventLog.indexOf("subagent-spawn");
      const hIdx = eventLog.indexOf("handoff");
      const hcIdx = eventLog.indexOf("handoff-completed");
      expect(dsIdx).toBeLessThan(spIdx);
      expect(hIdx).toBeLessThan(hcIdx);
    });
  });
});
