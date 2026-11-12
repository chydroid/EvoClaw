import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import { tryCallLLM, type LLMCallerDeps } from "./llm-caller";
import { HumanApprovalManager } from "./human-approval";
import { ApprovalDenialBreaker } from "./approval-denial-breaker";
import { setActiveSecurityLevel } from "@evoclaw/security";

/**
 * P0 回归：llm-caller 的 HITL 分支必须把审批请求登记到 HumanApprovalManager，
 * 否则 /api/approvals/:id/approve|reject 对该 id 一律 404（高危操作无法批准）。
 */
describe("llm-caller — HITL 审批登记（P0）", () => {
  let manager: HumanApprovalManager;
  let seq = 0;

  beforeEach(() => {
    setActiveSecurityLevel("normal");
    manager = new HumanApprovalManager();
  });

  afterEach(() => {
    manager.destroy();
    setActiveSecurityLevel("normal");
  });

  function makeDeps(
    port: number,
    sessionId: string,
    extra: { breaker?: ApprovalDenialBreaker; permissionManager?: unknown; extraTools?: Array<[string, { definition: Record<string, unknown>; handler: () => Promise<unknown> }]> } = {},
  ): { deps: LLMCallerDeps; provider: LLMCallerDeps["providers"][number]; handlerCalls: { v: number } } {
    seq++;
    const provider = {
      id: `hitl-p1-${seq}`, name: `hitl-p1-${seq}`, provider: "openai", model: "m",
      baseURL: `http://127.0.0.1:${port}/v1`, enabled: true, order: 0, timeout: 5000,
    } as unknown as LLMCallerDeps["providers"][number];
    const handlerCalls = { v: 0 };
    const deps = {
      registry: {
        resolveService: (name: string) => (name === "permissionManager" ? extra.permissionManager ?? null : null),
      } as unknown as LLMCallerDeps["registry"],
      conversationHistory: new Map(),
      pendingOperations: new Map(),
      toolResultCache: new Map(),
      registeredTools: new Map([
        [
          "file_delete",
          {
            definition: { name: "file_delete", description: "delete a file", parameters: { path: { type: "string" } } },
            handler: async () => { handlerCalls.v++; return { success: true }; },
          },
        ],
        ...(extra.extraTools ?? []),
      ]),
      buildSkillsPromptForRun: async () => "",
      recordProviderSuccess: () => {},
      recordProviderFailure: () => {},
      getEventLedger: () => null,
      config: { maxTokens: 4096 } as LLMCallerDeps["config"],
      persona: { name: "t", style: "s", formatConstraints: "" } as LLMCallerDeps["persona"],
      sessionManager: null,
      pluginManager: null,
      maxHistoryLength: 200,
      sessionDataDir: "/tmp",
      sessionPersistenceEnabled: false,
      autoCompactionEnabled: false,
      compactionTokenThreshold: 0,
      compactionManager: null,
      lifecycleManager: null,
      memoryHub: null,
      providers: [provider],
      humanApprovalManager: manager,
      approvalDenialBreaker: extra.breaker,
      resetApprovalDenials: (sid: string) => extra.breaker?.recordApproval(sid),
    } as unknown as LLMCallerDeps;
    return { deps, provider, handlerCalls };
  }

  it("高危工具调用 → 登记 pending approval + pendingOperations，且不执行工具", async () => {
    let calls = 0;
    const server = http.createServer((_req, res) => {
      calls++;
      res.setHeader("Content-Type", "application/json");
      if (calls === 1) {
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "tc1", type: "function", function: { name: "file_delete", arguments: JSON.stringify({ path: "/tmp/a.txt" }) } }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { total_tokens: 4, prompt_tokens: 2 },
        }));
      } else {
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Awaiting your approval." }, finish_reason: "stop" }],
          usage: { total_tokens: 2, prompt_tokens: 1 },
        }));
      }
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const sessionId = `hitl-reg-${seq}-${Date.now()}`;
    const { deps, provider, handlerCalls } = makeDeps(port, sessionId);

    const res = await tryCallLLM(deps, {
      message: "delete /tmp/a.txt",
      systemPrompt: "SYS",
      installedSkills: [],
      providers: [provider],
      startTime: Date.now(),
      sessionId,
      pendingPermissions: [],
    });
    server.close();

    expect(res).not.toBeNull();
    // 工具不得真正执行
    expect(handlerCalls.v).toBe(0);
    // 审批已登记，可在 /api/approvals/pending 看到
    const pending = manager.getPendingApprovals(sessionId);
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe("file_delete");
    expect(pending[0].status).toBe("pending");
    // requestId → session 映射已建立
    const entry = deps.pendingOperations.get(pending[0].id);
    expect(entry).toBeDefined();
    expect(entry!.sessionId).toBe(sessionId);
    // 结果通过 pendingPermissions 暴露给前端
    expect(res!.permissionRequests.map((p) => p.id)).toContain(pending[0].id);

    // 批准后，同一参数重试放行
    expect(manager.approve(pending[0].id, "tester")).toBe(true);
    expect(manager.requiresApproval("file_delete", { path: "/tmp/a.txt" })).toBe(false);
  });

  // ── P3：连续拒绝熔断 ─────────────────────────────────────────────

  function llmServer(onFirst: () => unknown): { server: http.Server; bodies: string[] } {
    const bodies: string[] = [];
    let calls = 0;
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => { raw += d; });
      req.on("end", () => {
        bodies.push(raw);
        calls++;
        res.setHeader("Content-Type", "application/json");
        const payload = calls === 1
          ? onFirst()
          : { choices: [{ message: { role: "assistant", content: "Stopped by breaker." }, finish_reason: "stop" }], usage: { total_tokens: 2, prompt_tokens: 1 } };
        res.end(JSON.stringify(payload));
      });
    });
    return { server, bodies };
  }

  it("已熔断：HITL 分支返回 blockedByBreaker，不再登记新审批", async () => {
    const sessionId = `hitl-breaker-${seq}-${Date.now()}`;
    const { server, bodies } = llmServer(() => ({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "tc1", type: "function", function: { name: "file_delete", arguments: JSON.stringify({ path: "/tmp/a.txt" }) } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { total_tokens: 4, prompt_tokens: 2 },
    }));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    const breaker = new ApprovalDenialBreaker({ threshold: 1 });
    breaker.recordDenial(sessionId, "prior-denial");
    const { deps, provider, handlerCalls } = makeDeps(port, sessionId, { breaker });

    const res = await tryCallLLM(deps, {
      message: "delete /tmp/a.txt",
      systemPrompt: "SYS",
      installedSkills: [],
      providers: [provider],
      startTime: Date.now(),
      sessionId,
      pendingPermissions: [],
    });
    server.close();

    expect(handlerCalls.v).toBe(0);
    expect(manager.getPendingApprovals(sessionId)).toHaveLength(0);
    expect(res!.permissionRequests).toHaveLength(0);
    const all = bodies.join("\n");
    expect(all).toContain("CIRCUIT BREAKER");
    expect(all).toContain("blockedByBreaker");
  });

  it("已熔断：工具级 requiresPermission 被拒绝并关闭 PermissionManager 请求", async () => {
    const sessionId = `perm-breaker-${seq}-${Date.now()}`;
    const denyRequest = vi.fn();
    const { server, bodies } = llmServer(() => ({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "tc1", type: "function", function: { name: "perm_tool", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { total_tokens: 4, prompt_tokens: 2 },
    }));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    const breaker = new ApprovalDenialBreaker({ threshold: 1 });
    breaker.recordDenial(sessionId, "prior-denial");
    const { deps, provider } = makeDeps(port, sessionId, {
      breaker,
      permissionManager: { denyRequest },
      extraTools: [[
        "perm_tool",
        {
          definition: { name: "perm_tool", description: "needs approval", parameters: {} },
          handler: async () => ({
            success: false,
            requiresPermission: true,
            requestId: "req-perm-1",
            operation: "perm_tool",
            description: "needs approval",
            target: "perm_tool",
          }),
        },
      ]],
    });

    const res = await tryCallLLM(deps, {
      message: "do the thing",
      systemPrompt: "SYS",
      installedSkills: [],
      providers: [provider],
      startTime: Date.now(),
      sessionId,
      pendingPermissions: [],
    });
    server.close();

    expect(denyRequest).toHaveBeenCalledWith("req-perm-1");
    expect(res!.permissionRequests).toHaveLength(0);
    expect(deps.pendingOperations.has("req-perm-1")).toBe(false);
    const all = bodies.join("\n");
    expect(all).toContain("CIRCUIT BREAKER");
    expect(all).toContain("blockedByBreaker");
  });
});
