import { describe, it, expect, beforeEach } from "vitest";
import {
  ToolGuardrails,
  IDEMPOTENT_TOOL_NAMES,
  MUTATING_TOOL_NAMES,
  isIdempotent,
  isMutating,
  computeArgsHash,
  evaluateToolCall,
  DEFAULT_GUARDRAIL_CONFIG,
} from "./tool-guardrails";

describe("Tool Guardrails", () => {
  describe("工具分类", () => {
    it("isIdempotent 应正确识别幂等工具", () => {
      expect(isIdempotent("file_read")).toBe(true);
      expect(isIdempotent("web_search")).toBe(true);
      expect(isIdempotent("file_delete")).toBe(false);
    });

    it("isMutating 应正确识别变异工具", () => {
      expect(isMutating("file_create")).toBe(true);
      expect(isMutating("email_send")).toBe(true);
      expect(isMutating("file_read")).toBe(false);
    });

    it("IDEMPOTENT_TOOL_NAMES 和 MUTATING_TOOL_NAMES 不应重叠", () => {
      for (const name of IDEMPOTENT_TOOL_NAMES) {
        expect(MUTATING_TOOL_NAMES.has(name)).toBe(false);
      }
    });
  });

  describe("computeArgsHash", () => {
    it("相同参数应产生相同哈希", () => {
      const args = { path: "/tmp/test", mode: "r" };
      expect(computeArgsHash(args)).toBe(computeArgsHash(args));
    });

    it("不同参数应产生不同哈希", () => {
      expect(computeArgsHash({ a: 1 })).not.toBe(computeArgsHash({ a: 2 }));
    });

    it("键顺序不影响哈希", () => {
      const h1 = computeArgsHash({ a: 1, b: 2 });
      const h2 = computeArgsHash({ b: 2, a: 1 });
      expect(h1).toBe(h2);
    });
  });

  describe("evaluateToolCall", () => {
    it("幂等工具默认允许", () => {
      const decision = evaluateToolCall("file_read", { path: "/tmp" });
      expect(decision.action).toBe("allow");
    });

    it("变异工具默认警告", () => {
      const decision = evaluateToolCall("file_delete", { path: "/tmp/test" });
      expect(decision.action).toBe("warn");
      expect(decision.reason).toContain("file_delete");
    });

    it("阻止列表中的工具应被 block", () => {
      const decision = evaluateToolCall("shell_execute", {}, {
        ...DEFAULT_GUARDRAIL_CONFIG,
        blockedTools: new Set(["shell_execute"]),
      });
      expect(decision.action).toBe("block");
    });

    it("hardStopEnabled 时变异工具应 halt", () => {
      const decision = evaluateToolCall("file_delete", { path: "/tmp" }, {
        ...DEFAULT_GUARDRAIL_CONFIG,
        hardStopEnabled: true,
      });
      expect(decision.action).toBe("halt");
    });

    it("warningsEnabled=false 时变异工具应 allow", () => {
      const decision = evaluateToolCall("file_delete", { path: "/tmp" }, {
        ...DEFAULT_GUARDRAIL_CONFIG,
        warningsEnabled: false,
      });
      expect(decision.action).toBe("allow");
    });
  });

  describe("ToolGuardrails 管理器", () => {
    let guardrails: ToolGuardrails;

    beforeEach(() => {
      guardrails = new ToolGuardrails();
    });

    it("幂等工具首次调用应 allow", () => {
      const decision = guardrails.check("file_read", { path: "/tmp" });
      expect(decision.action).toBe("allow");
    });

    it("幂等工具短时间重复调用应 warn", () => {
      guardrails.check("file_read", { path: "/tmp" });
      const decision = guardrails.check("file_read", { path: "/tmp" });
      expect(decision.action).toBe("warn");
      expect(decision.reason).toContain("Duplicate");
    });

    it("不同参数的幂等工具调用不应 warn", () => {
      guardrails.check("file_read", { path: "/tmp/a" });
      const decision = guardrails.check("file_read", { path: "/tmp/b" });
      expect(decision.action).toBe("allow");
    });

    it("变异工具应 warn", () => {
      const decision = guardrails.check("file_create", { path: "/tmp/new" });
      expect(decision.action).toBe("warn");
    });

    it("updateConfig 应更新配置", () => {
      guardrails.updateConfig({ hardStopEnabled: true });
      const config = guardrails.getConfig();
      expect(config.hardStopEnabled).toBe(true);
    });

    it("cleanup 应清理过期记录", () => {
      guardrails.check("file_read", { path: "/tmp" });
      // 手动修改时间戳使记录过期
      const key = "file_read:" + computeArgsHash({ path: "/tmp" });
      const map = (guardrails as any).recentCalls;
      map.set(key, [Date.now() - 10_000]);
      guardrails.cleanup();
      expect(map.has(key)).toBe(false);
    });
  });
});
