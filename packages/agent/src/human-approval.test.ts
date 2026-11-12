import { describe, it, expect, afterEach, vi } from "vitest";
import { HumanApprovalManager, type PendingApproval } from "./human-approval";
import { setActiveSecurityLevel } from "@evoclaw/security";
import { stableHash } from "./stable-stringify";

/**
 * P0 — HITL 审批可解析化。
 *
 * 复现的真实缺陷：llm-caller 生成 `hitl-*` 审批请求后从不登记到
 * HumanApprovalManager，导致 /api/approvals/:id/approve|reject 一律 404。
 * 这里锁定登记、状态流转、以及「批准后重试必须放行」的信任规则语义。
 */
describe("HumanApprovalManager — HITL 非阻塞审批登记", () => {
  let manager: HumanApprovalManager | null = null;

  afterEach(() => {
    manager?.destroy();
    manager = null;
    vi.useRealTimers();
    setActiveSecurityLevel("normal");
  });

  function makePending(overrides: Partial<PendingApproval> = {}): PendingApproval {
    return {
      id: `hitl-${Math.random().toString(16).slice(2)}`,
      sessionId: "sess-1",
      toolName: "file_delete",
      toolArgs: { path: "/tmp/a.txt" },
      riskLevel: "critical",
      reason: 'Tool "file_delete" requires approval',
      createdAt: Date.now(),
      requestedBy: "agent",
      status: "pending",
      ...overrides,
    };
  }

  it("登记后出现在 getPendingApprovals(sessionId)", () => {
    manager = new HumanApprovalManager();
    const pending = makePending();
    expect(manager.registerPendingApproval(pending)).toBe(true);

    const list = manager.getPendingApprovals("sess-1");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(pending.id);
    expect(list[0].toolName).toBe("file_delete");
    // 其他会话不可见
    expect(manager.getPendingApprovals("sess-2")).toHaveLength(0);
  });

  it("遵守 maxPendingPerSession（超限 fail-closed）", () => {
    manager = new HumanApprovalManager({ maxPendingPerSession: 1 });
    expect(manager.registerPendingApproval(makePending())).toBe(true);
    expect(manager.registerPendingApproval(makePending({ id: "hitl-second" }))).toBe(false);
    expect(manager.getPendingApprovals("sess-1")).toHaveLength(1);
  });

  it("批准后：仅完全相同的 tool+args 放行（5 分钟窗口），其他参数仍需审批", () => {
    setActiveSecurityLevel("normal");
    manager = new HumanApprovalManager();
    const args = { path: "/tmp/a.txt" };
    const pending = makePending({ toolArgs: args });
    manager.registerPendingApproval(pending);

    // 批准前必须审批
    expect(manager.requiresApproval("file_delete", args)).toBe(true);

    expect(manager.approve(pending.id, "tester")).toBe(true);
    expect(manager.getApproval(pending.id)?.status).toBe("approved");

    // 重试（同一参数）放行
    expect(manager.requiresApproval("file_delete", args)).toBe(false);
    // 相同工具、不同参数不继承信任
    expect(manager.requiresApproval("file_delete", { path: "/tmp/b.txt" })).toBe(true);
  });

  it("trustFuture=true 时登记永久工具级信任", () => {
    setActiveSecurityLevel("normal");
    manager = new HumanApprovalManager();
    const pending = makePending();
    manager.registerPendingApproval(pending);

    expect(manager.approve(pending.id, "tester", true)).toBe(true);
    expect(manager.requiresApproval("file_delete", { path: "/tmp/other.txt" })).toBe(false);
    const rules = manager.getTrustRules().filter((r) => r.toolName === "file_delete");
    expect(rules.some((r) => r.expiresAt === 0 && r.argsHash === undefined)).toBe(true);
  });

  it("精确参数信任 5 分钟后失效", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
    setActiveSecurityLevel("normal");
    manager = new HumanApprovalManager();
    const args = { path: "/tmp/a.txt" };
    const pending = makePending({ toolArgs: args });
    manager.registerPendingApproval(pending);
    manager.approve(pending.id, "tester");

    expect(manager.requiresApproval("file_delete", args)).toBe(false);
    vi.setSystemTime(new Date("2026-11-12T00:06:00Z"));
    expect(manager.requiresApproval("file_delete", args)).toBe(true);
  });

  it("拒绝：状态落 rejected，不再放行，且不会新增信任规则", () => {
    setActiveSecurityLevel("normal");
    manager = new HumanApprovalManager();
    const pending = makePending();
    manager.registerPendingApproval(pending);
    const before = manager.getTrustRules().length;

    expect(manager.reject(pending.id, "tester", "nope")).toBe(true);
    expect(manager.getApproval(pending.id)?.status).toBe("rejected");
    expect(manager.getTrustRules().length).toBe(before);
    expect(manager.requiresApproval("file_delete", pending.toolArgs)).toBe(true);
  });

  it("argsHash 信任规则与 stableHash 的序列化一致", () => {
    setActiveSecurityLevel("normal");
    manager = new HumanApprovalManager();
    manager.addTrustRule({
      toolName: "file_delete",
      argsHash: stableHash({ path: "/tmp/a.txt", recursive: true }),
      trustedBy: "tester",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    // 键序不同也应命中（stableStringify 保证）
    expect(manager.requiresApproval("file_delete", { recursive: true, path: "/tmp/a.txt" })).toBe(false);
    expect(manager.requiresApproval("file_delete", { path: "/tmp/a.txt", recursive: false })).toBe(true);
  });

  it("同一个 id 重复登记不会产生重复条目", () => {
    manager = new HumanApprovalManager();
    const pending = makePending({ id: "hitl-dup" });
    expect(manager.registerPendingApproval(pending)).toBe(true);
    expect(manager.registerPendingApproval(pending)).toBe(true);
    expect(manager.getPendingApprovals("sess-1")).toHaveLength(1);
  });
});
