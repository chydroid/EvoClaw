import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import { tryCallLLM, type LLMCallerDeps } from "./llm-caller";
import { HumanApprovalManager } from "./human-approval";
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

  function makeDeps(port: number, sessionId: string): { deps: LLMCallerDeps; provider: LLMCallerDeps["providers"][number]; handlerCalls: { v: number } } {
    seq++;
    const provider = {
      id: `hitl-p1-${seq}`, name: `hitl-p1-${seq}`, provider: "openai", model: "m",
      baseURL: `http://127.0.0.1:${port}/v1`, enabled: true, order: 0, timeout: 5000,
    } as unknown as LLMCallerDeps["providers"][number];
    const handlerCalls = { v: 0 };
    const deps = {
      registry: { resolveService: () => null } as unknown as LLMCallerDeps["registry"],
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
});
