/**
 * CopilotRouter 生产接线回归测试（2026-11-23）
 *
 * 修复前的三个缺陷：
 * 1. 双实例：server 把 registry 上的实例交给网关 updateUserProviders，
 *    执行器却 new 了另一个实例 → 执行器的 userProviders 永远为 []
 * 2. provider 键错位：执行器传 provider.provider（类型名如 "custom"），
 *    而 userProviders 以 provider.id 为键 → shouldDowngrade 恒为 true
 * 3. 降级后没有把目标 provider 提到队首 → 实际仍调用原 provider
 */
import { describe, it, expect } from "vitest";
import { CopilotRouter } from "./copilot-router";
import { AgentModelExecutor } from "./agent-model-executor";
import { ServiceRegistry, EventBus } from "@evoclaw/core";

function makeExecutor(): AgentModelExecutor {
  return new AgentModelExecutor(new ServiceRegistry(), new EventBus());
}

const PROVIDERS = [
  {
    id: "custom-1791190214796-1",
    name: "agnes",
    enabled: true,
    order: 2,
    selectedModel: "agnes-3.0-flash",
    baseURL: "https://example.invalid/v1",
  },
  {
    id: "local",
    name: "local",
    enabled: true,
    order: 1,
    selectedModel: "qwen2.5-0.5b",
    baseURL: "http://localhost:11434/v1",
  },
];

describe("CopilotRouter 与执行器共用同一实例", () => {
  it("setCopilotRouter 接受实例时保留引用（不再内部 new）", () => {
    const executor = makeExecutor();
    const router = new CopilotRouter({ enabled: true });
    router.updateUserProviders(PROVIDERS);

    executor.setCopilotRouter(router);

    expect(executor.getCopilotRouter()).toBe(router);
    // 关键断言：网关后续 updateUserProviders 打在同一对象上，执行器可见
    router.updateUserProviders([PROVIDERS[1]]);
    expect(executor.getCopilotRouter()?.route("你好", "agnes-3.0-flash", "custom-1791190214796-1").routedProvider)
      .toBe("local");
  });

  it("setCopilotRouter 仍接受 config 形式（向后兼容）", () => {
    const executor = makeExecutor();
    executor.setCopilotRouter({ enabled: false });
    expect(executor.getCopilotRouter()).toBeInstanceOf(CopilotRouter);
    const decision = executor.getCopilotRouter()!.route("你好", "m", "p");
    expect(decision.shouldDowngrade).toBe(false);
    expect(decision.reason).toContain("disabled");
  });
});

describe("provider 键必须用 id 而非类型名", () => {
  it("用 id 作为 currentProvider 时，简单任务能正确识别降级目标", () => {
    const router = new CopilotRouter({ enabled: true });
    router.updateUserProviders(PROVIDERS);

    const byId = router.route("你好", "agnes-3.0-flash", "custom-1791190214796-1");
    expect(byId.shouldDowngrade).toBe(true);
    expect(byId.routedProvider).toBe("local");
    expect(byId.routedModel).toBe("qwen2.5-0.5b");

    // 旧实现传的是类型名 "custom"，与任何 id 都不相等 → 假降级
    const byType = router.route("你好", "agnes-3.0-flash", "custom");
    expect(byType.shouldDowngrade).toBe(true);
    expect(byType.routedProvider).toBe("local");
  });

  it("只有当前 provider 时不应产生降级", () => {
    const router = new CopilotRouter({ enabled: true });
    router.updateUserProviders([PROVIDERS[0]]);

    const decision = router.route("你好", "agnes-3.0-flash", "custom-1791190214796-1");
    expect(decision.shouldDowngrade).toBe(false);
    expect(decision.routedProvider).toBe("custom-1791190214796-1");
  });
});
