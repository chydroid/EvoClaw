import { describe, it, expect, vi } from "vitest";
import { ExecutionAnalyzer, correctSkillRef, extractJsonObject } from "./execution-analyzer";
import type { RecordingRecord } from "@evoclaw/agent";

function recording(toolSuccess = false): {
  conversations: RecordingRecord[];
  trajectory: RecordingRecord[];
  metadata: null;
} {
  return {
    conversations: [
      {
        type: "iteration",
        timestamp: 1,
        iteration: 1,
        messages: [
          { role: "user", content: "extract tables from report.pdf" },
          { role: "assistant", content: "I will use skill pdf-extract" },
        ],
        tokenEstimate: 20,
      },
    ],
    trajectory: [
      {
        type: "skill_selection",
        timestamp: 1,
        iteration: 1,
        taskDescription: "extract tables",
        selectedSkills: [{ name: "PDF Extractor", skillId: "pdfid001", score: 1, source: "selection" }],
      },
      {
        type: "tool_execution",
        timestamp: 2,
        iteration: 1,
        toolName: "shell_exec",
        toolCallId: "c1",
        args: { command: "pdftotext report.pdf" },
        result: toolSuccess ? "ok" : "command not found: pdftotext",
        success: toolSuccess,
        durationMs: 12,
        error: toolSuccess ? undefined : "command not found",
      },
    ],
    metadata: null,
  };
}

const baseInput = {
  taskId: "t1",
  sessionId: "s1",
  message: "extract tables from report.pdf",
  reply: "Done",
  status: "completed" as const,
};

describe("ExecutionAnalyzer", () => {
  it("解析分析 JSON，纠正幻觉 skill_id，并保留工具问题", async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({
      task_completed: false,
      execution_note: "Tool missing",
      tool_issues: ["shell_exec: pdftotext not installed"],
      skill_judgments: [
        { skill_id: "pdf-extract", skill_applied: false, note: "never invoked" },
      ],
      evolution_suggestions: [
        { type: "fix", target_skills: ["pdfid01"], direction: "install poppler" },
        { type: "captured", target_skills: [], category: "workflow", direction: "pdf table pipeline" },
      ],
    }));
    const analyzer = new ExecutionAnalyzer(complete, {
      readRecording: () => recording(),
    });

    const result = await analyzer.analyze(baseInput);
    expect(result).not.toBeNull();
    expect(result!.taskCompleted).toBe(false);
    expect(result!.skillJudgments?.[0]).toMatchObject({
      skillId: "pdfid001",
      skillName: "PDF Extractor",
      skillApplied: false,
    });
    expect(result!.toolIssues[0].toolKey).toBe("shell_exec");
    expect(result!.suggestions.map((s) => s.type)).toEqual(["fix", "captured"]);
    expect(result!.suggestions[0].targetSkillIds).toEqual(["pdfid001"]);
    expect(result!.suggestions[1].category).toBe("workflow");
  });

  it("纯聊天（无工具无技能且完成）直接跳过，不调用 LLM", async () => {
    const complete = vi.fn();
    const analyzer = new ExecutionAnalyzer(complete, {
      readRecording: () => ({ conversations: [], trajectory: [], metadata: null }),
    });
    const result = await analyzer.analyze(baseInput);
    expect(result).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it("子代理/显式 skip 不分析", async () => {
    const complete = vi.fn();
    const analyzer = new ExecutionAnalyzer(complete, {
      readRecording: () => recording(),
    });
    expect(await analyzer.analyze({ ...baseInput, isSubagent: true })).toBeNull();
    expect(await analyzer.analyze({ ...baseInput, skip: true })).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it("LLM 返回非 JSON 时安全返回 null", async () => {
    const analyzer = new ExecutionAnalyzer(vi.fn().mockResolvedValue("not json"), {
      readRecording: () => recording(),
    });
    expect(await analyzer.analyze(baseInput)).toBeNull();
  });

  it("无目标的 fix 建议被丢弃，无 valid SKILL.md 不崩溃", async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({
      task_completed: true,
      tool_issues: [],
      skill_judgments: [],
      evolution_suggestions: [{ type: "fix", target_skills: ["does-not-exist"], direction: "x" }],
    }));
    const analyzer = new ExecutionAnalyzer(complete, { readRecording: () => recording(true) });
    const result = await analyzer.analyze(baseInput);
    expect(result!.suggestions).toEqual([]);
  });
});

describe("ExecutionAnalyzer helpers", () => {
  it("extractJsonObject 截取平衡 JSON", () => {
    expect(extractJsonObject('prefix {"a":{"b":1}} suffix')).toBe('{"a":{"b":1}}');
    expect(extractJsonObject("no json")).toBeNull();
  });

  it("correctSkillRef 支持精确/名称/近似匹配", () => {
    const skills = [{ skillId: "id-1", name: "pdf-extract" }];
    expect(correctSkillRef("id-1", skills)?.skillId).toBe("id-1");
    expect(correctSkillRef("PDF Extractor", skills)?.name).toBe("pdf-extract");
    expect(correctSkillRef("pdf_extract", skills)?.name).toBe("pdf-extract");
    expect(correctSkillRef("pdf-extractt", skills)?.name).toBe("pdf-extract");
    expect(correctSkillRef("totally-unrelated", skills)).toBeNull();
  });
});
