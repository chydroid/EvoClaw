import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { RecordingManager } from "./recording-manager";

// ═══════════════════════════════════════════════════════════
// 测试套件：RecordingManager（任务执行录制）
// ═══════════════════════════════════════════════════════════

describe("RecordingManager", () => {
  let tmpDir: string;
  let mgr: RecordingManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-test-"));
    RecordingManager.resetInstance();
    mgr = RecordingManager.getInstance(tmpDir);
  });

  afterEach(() => {
    RecordingManager.resetInstance();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("startRecording 创建任务目录", () => {
    const dir = mgr.startRecording("task-1", "session-1");
    expect(dir).toBe(path.join(tmpDir, "task-1"));
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("recordConversationSetup 写入 conversations.jsonl", () => {
    mgr.startRecording("task-1", "session-1");
    mgr.recordConversationSetup("task-1", "system prompt", [{ name: "tool1" }], "session-1");

    const convPath = path.join(tmpDir, "task-1", "conversations.jsonl");
    expect(fs.existsSync(convPath)).toBe(true);
    const content = fs.readFileSync(convPath, "utf-8");
    const records = content.trim().split("\n").map((l) => JSON.parse(l));
    expect(records.length).toBe(1);
    expect(records[0].type).toBe("setup");
    expect(records[0].systemPrompt).toBe("system prompt");
  });

  it("recordIterationContext 写入迭代上下文", () => {
    mgr.startRecording("task-1", "session-1");
    mgr.recordIterationContext("task-1", 1, [{ role: "user", content: "hello" }], 100);

    const convPath = path.join(tmpDir, "task-1", "conversations.jsonl");
    const content = fs.readFileSync(convPath, "utf-8");
    const records = content.trim().split("\n").map((l) => JSON.parse(l));
    expect(records.length).toBe(1);
    expect(records[0].type).toBe("iteration");
    expect(records[0].iteration).toBe(1);
  });

  it("recordToolExecution 写入 traj.jsonl", () => {
    mgr.startRecording("task-1", "session-1");
    mgr.recordToolExecution("task-1", 1, "read_file", "call-1", { path: "/foo" }, "content", true, 50);

    const trajPath = path.join(tmpDir, "task-1", "traj.jsonl");
    expect(fs.existsSync(trajPath)).toBe(true);
    const content = fs.readFileSync(trajPath, "utf-8");
    const records = content.trim().split("\n").map((l) => JSON.parse(l));
    expect(records.length).toBe(1);
    expect(records[0].type).toBe("tool_execution");
    expect(records[0].toolName).toBe("read_file");
    expect(records[0].success).toBe(true);
  });

  it("recordSkillSelection 写入技能选择", () => {
    mgr.startRecording("task-1", "session-1");
    mgr.recordSkillSelection("task-1", 1, [{ name: "skill-a", score: 0.9, source: "tfidf" }], "do something");

    const trajPath = path.join(tmpDir, "task-1", "traj.jsonl");
    const content = fs.readFileSync(trajPath, "utf-8");
    const records = content.trim().split("\n").map((l) => JSON.parse(l));
    expect(records[0].type).toBe("skill_selection");
    expect(records[0].selectedSkills[0].name).toBe("skill-a");
  });

  it("endRecording 更新 metadata", () => {
    mgr.startRecording("task-1", "session-1");
    mgr.recordIterationContext("task-1", 1, [], 100);
    mgr.endRecording("task-1", "completed");

    const metaPath = path.join(tmpDir, "task-1", "metadata.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(meta.finalStatus).toBe("completed");
    expect(meta.endedAt).toBeDefined();
  });

  it("readRecording 返回完整数据", () => {
    mgr.startRecording("task-1", "session-1");
    mgr.recordConversationSetup("task-1", "sys", [], "session-1");
    mgr.recordIterationContext("task-1", 1, [{ role: "user", content: "hi" }], 50);
    mgr.recordToolExecution("task-1", 1, "tool", "call-1", {}, "ok", true, 10);
    mgr.endRecording("task-1", "completed");

    const data = mgr.readRecording("task-1");
    expect(data.conversations.length).toBe(2); // setup + iteration
    expect(data.trajectory.length).toBe(1); // tool_execution
    expect(data.metadata).not.toBeNull();
    expect(data.metadata?.finalStatus).toBe("completed");
  });

  it("listRecordings 列出所有录制", () => {
    mgr.startRecording("task-1", "session-1");
    mgr.endRecording("task-1", "completed");
    mgr.startRecording("task-2", "session-2");
    mgr.endRecording("task-2", "failed", "error");

    const list = mgr.listRecordings();
    expect(list.length).toBe(2);
    const taskIds = list.map((l) => l.taskId);
    expect(taskIds).toContain("task-1");
    expect(taskIds).toContain("task-2");
  });

  it("metadata 累计统计正确", () => {
    mgr.startRecording("task-1", "session-1");
    mgr.recordIterationContext("task-1", 1, [], 100);
    mgr.recordIterationContext("task-1", 2, [], 200);
    mgr.recordToolExecution("task-1", 1, "tool", "c1", {}, "ok", true, 10);
    mgr.recordToolExecution("task-1", 2, "tool", "c2", {}, "ok", true, 10);
    mgr.recordSkillSelection("task-1", 1, [{ name: "skill-a", score: 0.9, source: "tfidf" }], "task");

    // 在 endRecording 之前检查 metadata（endRecording 后从内存移除）
    const meta = mgr.getMetadata("task-1");
    expect(meta?.totalIterations).toBe(2);
    expect(meta?.totalToolCalls).toBe(2);
    expect(meta?.totalTokensUsed).toBe(300);
    expect(meta?.skillsUsed).toEqual(["skill-a"]);

    // endRecording 后从磁盘读取
    mgr.endRecording("task-1", "completed");
    const data = mgr.readRecording("task-1");
    expect(data.metadata?.totalIterations).toBe(2);
    expect(data.metadata?.totalToolCalls).toBe(2);
  });

  it("generateTaskId 生成唯一 ID", () => {
    const id1 = RecordingManager.generateTaskId();
    const id2 = RecordingManager.generateTaskId();
    expect(id1).not.toBe(id2);
    expect(id1.startsWith("task_")).toBe(true);
  });
});
