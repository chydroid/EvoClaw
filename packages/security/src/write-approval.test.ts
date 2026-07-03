import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { WriteApprovalGate, createDefaultWriteGate } from "./write-approval";

describe("WriteApprovalGate", () => {
  let tmpDir: string;
  let pendingDir: string;
  let gate: WriteApprovalGate;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-test-"));
    pendingDir = path.join(tmpDir, "write-pending");
    gate = new WriteApprovalGate({ pendingDir, stageTtlMs: 5000, enabled: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("allow 决策应直接写入文件", async () => {
    const targetPath = path.join(tmpDir, "output", "file.txt");
    const decision = await gate.stageWrite(targetPath, "hello", {
      operation: "create",
      agentId: "agent-1",
    });
    expect(decision.decision).toBe("allow");
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("hello");
  });

  it("isSensitivePath: .env 应被拒绝", () => {
    const decision = gate.evaluate(
      path.join(tmpDir, ".env"),
      "SECRET=123",
      { operation: "edit", agentId: "agent-1" },
    );
    expect(decision.decision).toBe("deny");
    expect(decision.rule).toBe("sensitive_path");
    expect(decision.risk).toBe("critical");
  });

  it("isSensitivePath: .ssh/id_rsa 应被拒绝", () => {
    const decision = gate.evaluate(
      path.join(tmpDir, ".ssh", "id_rsa"),
      "PRIVATE KEY",
      { operation: "edit", agentId: "agent-1" },
    );
    expect(decision.decision).toBe("deny");
    expect(decision.rule).toBe("sensitive_path");
  });

  it("isSensitivePath: authorized_keys 应被拒绝", () => {
    const decision = gate.evaluate(
      path.join(tmpDir, ".ssh", "authorized_keys"),
      "ssh-rsa AAAA...",
      { operation: "edit", agentId: "agent-1" },
    );
    expect(decision.decision).toBe("deny");
    expect(decision.rule).toBe("sensitive_path");
  });

  it("denylist 路径应被拒绝", () => {
    const blockedDir = path.join(tmpDir, "blocked");
    const gateWithDenylist = new WriteApprovalGate({
      pendingDir,
      denylist: [blockedDir],
    });
    const decision = gateWithDenylist.evaluate(
      path.join(blockedDir, "file.txt"),
      "content",
      { operation: "create", agentId: "agent-1" },
    );
    expect(decision.decision).toBe("deny");
    expect(decision.rule).toBe("denylist");
  });

  it("allowedRoots 外的路径应被拒绝", () => {
    const gateWithRoots = new WriteApprovalGate({
      pendingDir,
      allowedRoots: [path.join(tmpDir, "allowed")],
    });
    const decision = gateWithRoots.evaluate(
      path.join(tmpDir, "outside", "file.txt"),
      "content",
      { operation: "create", agentId: "agent-1" },
    );
    expect(decision.decision).toBe("deny");
    expect(decision.rule).toBe("scope_violation");
  });

  it("confirmPatterns 应触发 needs_confirm 并暂存", async () => {
    const gateWithPattern = new WriteApprovalGate({
      pendingDir,
      confirmPatterns: [/\.conf$/],
    });
    const targetPath = path.join(tmpDir, "config.conf");
    const decision = await gateWithPattern.stageWrite(targetPath, "config", {
      operation: "edit",
      agentId: "agent-1",
    });
    expect(decision.decision).toBe("needs_confirm");
    expect(decision.stageId).toBeDefined();

    // pending store 应有记录
    const pending = gateWithPattern.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].stageId).toBe(decision.stageId);
  });

  it("approve 应从 pending store 写入目标文件", async () => {
    const gateWithPattern = new WriteApprovalGate({
      pendingDir,
      confirmPatterns: [/\.conf$/],
    });
    const targetPath = path.join(tmpDir, "approved.conf");
    const decision = await gateWithPattern.stageWrite(targetPath, "approved content", {
      operation: "edit",
      agentId: "agent-1",
    });
    expect(decision.decision).toBe("needs_confirm");

    const result = await gateWithPattern.approve(decision.stageId!);
    expect(result.success).toBe(true);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("approved content");
  });

  it("reject 应标记暂存记录为 rejected", async () => {
    const gateWithPattern = new WriteApprovalGate({
      pendingDir,
      confirmPatterns: [/\.conf$/],
    });
    const targetPath = path.join(tmpDir, "rejected.conf");
    const decision = await gateWithPattern.stageWrite(targetPath, "content", {
      operation: "edit",
      agentId: "agent-1",
    });

    const rejected = gateWithPattern.reject(decision.stageId!);
    expect(rejected).toBe(true);

    // pending 列表应不再包含该记录
    expect(gateWithPattern.listPending()).toHaveLength(0);
  });

  it("cleanupExpired 应清理过期暂存记录", async () => {
    const shortTtlGate = new WriteApprovalGate({
      pendingDir,
      confirmPatterns: [/\.conf$/],
      stageTtlMs: 10, // 10ms TTL
    });
    const targetPath = path.join(tmpDir, "expire.conf");
    const decision = await shortTtlGate.stageWrite(targetPath, "content", {
      operation: "edit",
      agentId: "agent-1",
    });
    expect(decision.decision).toBe("needs_confirm");
    expect(shortTtlGate.listPending()).toHaveLength(1);

    // 等待过期
    await new Promise((r) => setTimeout(r, 50));
    const cleaned = shortTtlGate.cleanupExpired();
    expect(cleaned).toBe(1);
    expect(shortTtlGate.listPending()).toHaveLength(0);
  });

  it("approve 不存在的 stageId 应返回失败", async () => {
    const result = await gate.approve("nonexistent-id");
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("disabled gate 应直接 allow", () => {
    const disabledGate = new WriteApprovalGate({
      pendingDir,
      enabled: false,
    });
    const decision = disabledGate.evaluate(
      path.join(tmpDir, ".env"),
      "SECRET=123",
      { operation: "edit", agentId: "agent-1" },
    );
    expect(decision.decision).toBe("allow");
  });
});

describe("createDefaultWriteGate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-default-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("应创建带 workspaceRoot 的默认 gate", () => {
    const gate = createDefaultWriteGate(tmpDir);
    // workspaceRoot 内的普通文件应 allow
    const decision = gate.evaluate(
      path.join(tmpDir, "src", "file.ts"),
      "content",
      { operation: "create", agentId: "agent-1" },
    );
    expect(decision.decision).toBe("allow");
  });

  it("workspaceRoot 外的路径应被拒绝", () => {
    const gate = createDefaultWriteGate(tmpDir);
    const decision = gate.evaluate(
      path.join(os.tmpdir(), "outside", "file.txt"),
      "content",
      { operation: "create", agentId: "agent-1" },
    );
    expect(decision.decision).toBe("deny");
    expect(decision.rule).toBe("scope_violation");
  });
});
