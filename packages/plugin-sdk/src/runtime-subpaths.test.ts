import { describe, it, expect } from "vitest";
import {
  defineChannel,
  type ChannelRuntime,
  type ChannelRuntimeContext,
} from "../src/channel-runtime";
import {
  defineProvider,
  type ProviderRuntime,
  type ProviderRuntimeContext,
} from "../src/provider-runtime";
import {
  defineTool,
  type ToolRuntime,
  type ToolRuntimeContext,
} from "../src/tool-runtime";
import {
  evaluateApproval,
  createAlwaysAskPolicy,
  createAutoApprovePolicy,
  type ApprovalRuntimeContext,
  type ApprovalRequest,
} from "../src/approval-runtime";
import { definePlugin, type PluginEntry } from "../src/plugin-entry";

// 最小 logger 实现
const noopLogger = {
  fatal() {}, error() {}, warn() {}, info() {}, debug() {}, trace() {},
};

describe("plugin-sdk runtime sub-modules", () => {
  describe("channel-runtime defineChannel", () => {
    it("返回带 kind=channel 的定义对象", () => {
      const cap = {
        text: true, image: false, video: false, audio: false,
        document: false, reactions: false, threads: false,
        groups: false, interactive: false, maxMessageLength: 4096,
      };
      const def = defineChannel({
        channelId: "test-channel",
        capabilities: cap,
        async create() {
          return {
            capabilities: cap,
            async connect() {},
            onMessage() {},
          } satisfies ChannelRuntime;
        },
      });
      expect(def.kind).toBe("channel");
      expect(def.channelId).toBe("test-channel");
      expect(def.capabilities).toBe(cap);
      expect(typeof def.create).toBe("function");
    });
  });

  describe("provider-runtime defineProvider", () => {
    it("返回带 kind=provider 的定义对象", async () => {
      const def = defineProvider({
        providerId: "test-provider",
        async create() {
          return {
            async chat() {
              return { content: "hi", model: "test", usage: { totalTokens: 1 } };
            },
          } as unknown as ProviderRuntime;
        },
      });
      expect(def.kind).toBe("provider");
      expect(def.providerId).toBe("test-provider");

      // 实例化并调用 chat
      const ctx: ProviderRuntimeContext = {
        providerId: "test-provider",
        logger: noopLogger,
        services: { get: () => undefined, register: () => {}, has: () => false, list: () => [] },
        config: { providerId: "test-provider", apiBase: "", apiKey: "", models: [] } as never,
        http: {
          async fetch() {
            return new Response();
          },
          timeoutSignal(ms: number) {
            return AbortSignal.timeout(ms);
          },
        },
      };
      const rt = await def.create(ctx);
      const res = await rt.chat({} as never);
      expect(res.content).toBe("hi");
    });
  });

  describe("tool-runtime defineTool", () => {
    it("返回带 kind=tool 的定义对象", async () => {
      const def = defineTool({
        definition: {
          name: "echo",
          description: "echoes input",
          parameters: { type: "object", properties: { text: { type: "string" } } },
        },
        async create() {
          return {
            definition: {
              name: "echo",
              description: "echoes input",
              parameters: { type: "object", properties: { text: { type: "string" } } },
            },
            async execute(req) {
              return { content: String(req.arguments.text ?? "") };
            },
          } satisfies ToolRuntime;
        },
      });
      expect(def.kind).toBe("tool");
      expect(def.definition.name).toBe("echo");

      const ctx: ToolRuntimeContext = {
        toolName: "echo",
        logger: noopLogger,
        services: { get: () => undefined, register: () => {}, has: () => false, list: () => [] },
        config: {},
      };
      const rt = await def.create(ctx);
      const res = await rt.execute({ tool: "echo", arguments: { text: "hello" } });
      expect(res.content).toBe("hello");
    });
  });

  describe("approval-runtime", () => {
    it("always-ask 策略返回 defer", async () => {
      const policy = createAlwaysAskPolicy();
      const result = await policy.evaluate({ kind: "tool", operation: "rm" });
      expect(result).toBe("defer");
    });

    it("auto-approve 策略匹配 kind 时 approve", async () => {
      const policy = createAutoApprovePolicy({
        policyId: "approve-file-read",
        matchKinds: ["file_write"],
        matchOperations: ["read"],
        maxRiskLevel: "low",
      });
      const req: ApprovalRequest = {
        kind: "file_write",
        operation: "read",
        riskLevel: "low",
      };
      const result = await policy.evaluate(req);
      expect(result).not.toBe("defer");
      expect((result as { decision: string }).decision).toBe("approve");
    });

    it("auto-approve 策略不匹配 kind 时 defer", async () => {
      const policy = createAutoApprovePolicy({
        policyId: "approve-file-read",
        matchKinds: ["file_write"],
      });
      const result = await policy.evaluate({ kind: "exec", operation: "bash" });
      expect(result).toBe("defer");
    });

    it("auto-approve 策略风险超限 defer", async () => {
      const policy = createAutoApprovePolicy({
        policyId: "low-only",
        matchKinds: ["tool"],
        maxRiskLevel: "low",
      });
      const result = await policy.evaluate({
        kind: "tool",
        operation: "rm",
        riskLevel: "critical",
      });
      expect(result).toBe("defer");
    });

    it("evaluateApproval 按策略顺序返回首个非 defer 决策", async () => {
      const ctx: ApprovalRuntimeContext = {
        logger: noopLogger,
        defaultDecision: "deny",
        policies: [
          createAlwaysAskPolicy(),
          createAutoApprovePolicy({
            policyId: "approve-all-tools",
            matchKinds: ["tool"],
          }),
        ],
      };
      const result = await evaluateApproval(ctx, { kind: "tool", operation: "x" });
      expect(result.decision).toBe("approve");
      expect(result.approver).toBe("approve-all-tools");
    });

    it("evaluateApproval 全 defer 时返回 defaultDecision", async () => {
      const ctx: ApprovalRuntimeContext = {
        logger: noopLogger,
        defaultDecision: "deny",
        policies: [createAlwaysAskPolicy()],
      };
      const result = await evaluateApproval(ctx, { kind: "tool", operation: "x" });
      expect(result.decision).toBe("deny");
    });
  });

  describe("plugin-entry definePlugin", () => {
    it("返回原样 PluginEntry", () => {
      const entry: PluginEntry = {
        manifest: {
          id: "@test/plugin",
          name: "Test Plugin",
          version: "1.0.0",
          description: "test",
        },
        async setup() {},
      };
      const result = definePlugin(entry);
      expect(result).toBe(entry);
      expect(result.manifest.id).toBe("@test/plugin");
    });
  });
});
