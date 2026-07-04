/**
 * reflection-contract 测试 — MacroTool 反思契约。
 */
import { describe, it, expect } from "vitest";
import {
  buildMacroToolSchema,
  extractReflectionAndAction,
  renderHistoryEntry,
  MACRO_TOOL_SYSTEM_PROMPT,
  observeUrlChange,
  observeWaitBudget,
  observeStepBudget,
  observeStuckWarning,
  type ToolSchema,
} from "./reflection-contract";

describe("reflection-contract.buildMacroToolSchema", () => {
  it("生成包含反思字段和 action union 的 schema", () => {
    const tools: ToolSchema[] = [
      { name: "click", description: "点击", inputSchema: { type: "object", properties: { index: { type: "number" } } } },
      { name: "input_text", description: "输入", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    ];
    const schema = buildMacroToolSchema(tools);
    expect(schema.name).toBe("AgentOutput");
    const props = schema.inputSchema.properties as Record<string, unknown>;
    expect(props.evaluation_previous_goal).toBeDefined();
    expect(props.memory).toBeDefined();
    expect(props.next_goal).toBeDefined();
    expect(props.action).toBeDefined();
    const action = props.action as { oneOf: unknown[] };
    expect(action.oneOf.length).toBe(2);
  });

  it("required 只包含 action（反思字段可选）", () => {
    const schema = buildMacroToolSchema([{ name: "t", description: "d", inputSchema: { type: "object" } }]);
    expect(schema.inputSchema.required).toEqual(["action"]);
  });
});

describe("reflection-contract.extractReflectionAndAction", () => {
  it("正常提取反思字段和行动", () => {
    const args = {
      evaluation_previous_goal: "Success - clicked",
      memory: "已找到按钮",
      next_goal: "输入用户名",
      action: { click: { index: 5 } },
    };
    const result = extractReflectionAndAction(args);
    expect(result).not.toBeNull();
    expect(result!.reflection.evaluationPreviousGoal).toBe("Success - clicked");
    expect(result!.reflection.memory).toBe("已找到按钮");
    expect(result!.reflection.nextGoal).toBe("输入用户名");
    expect(result!.actionName).toBe("click");
    expect(result!.actionInput).toEqual({ index: 5 });
  });

  it("缺 action 返回 null", () => {
    const result = extractReflectionAndAction({ memory: "thinking" });
    expect(result).toBeNull();
  });

  it("action 不是对象返回 null", () => {
    const result = extractReflectionAndAction({ action: "not_an_object" });
    expect(result).toBeNull();
  });

  it("缺失反思字段不会失败（仅 action 必填）", () => {
    const result = extractReflectionAndAction({ action: { wait: { seconds: 1 } } });
    expect(result).not.toBeNull();
    expect(result!.reflection.evaluationPreviousGoal).toBeUndefined();
    expect(result!.actionName).toBe("wait");
  });
});

describe("reflection-contract.renderHistoryEntry", () => {
  it("渲染包含 step 标签和所有字段", () => {
    const text = renderHistoryEntry({
      stepIndex: 3,
      reflection: {
        evaluationPreviousGoal: "Success",
        memory: "已登录",
        nextGoal: "搜索",
      },
      actionName: "click",
      actionInput: { index: 2 },
      actionOutput: "ok",
      success: true,
    });
    expect(text).toContain("<step_3>");
    expect(text).toContain("</step_3>");
    expect(text).toContain("Evaluation of Previous Step: Success");
    expect(text).toContain("Memory: 已登录");
    expect(text).toContain("Next Goal: 搜索");
    expect(text).toContain("Action: click(");
    expect(text).toContain("Result: ✅ ok");
  });

  it("失败结果用 ❌", () => {
    const text = renderHistoryEntry({
      stepIndex: 1,
      reflection: {},
      actionName: "click",
      actionInput: {},
      actionOutput: "not found",
      success: false,
    });
    expect(text).toContain("Result: ❌ not found");
  });
});

describe("reflection-contract.MACRO_TOOL_SYSTEM_PROMPT", () => {
  it("包含推理规则和输出格式", () => {
    expect(MACRO_TOOL_SYSTEM_PROMPT).toContain("Reasoning Rules");
    expect(MACRO_TOOL_SYSTEM_PROMPT).toContain("evaluation_previous_goal");
    expect(MACRO_TOOL_SYSTEM_PROMPT).toContain("Output Format");
  });
});

describe("reflection-contract 观察机制", () => {
  it("URL 变化触发观察", () => {
    const obs = observeUrlChange("https://a.com/", "https://b.com/");
    expect(obs).not.toBeNull();
    expect(obs!.type).toBe("url_change");
    expect(obs!.content).toContain("b.com");
  });

  it("URL 未变化不触发", () => {
    expect(observeUrlChange("https://a.com/", "https://a.com/")).toBeNull();
  });

  it("累计等待 >=3 秒触发警告", () => {
    const obs = observeWaitBudget(3.5);
    expect(obs).not.toBeNull();
    expect(obs!.type).toBe("wait_budget");
    expect(obs!.content).toContain("3.5");
  });

  it("累计等待 <3 秒不触发", () => {
    expect(observeWaitBudget(2)).toBeNull();
  });

  it("剩余步数 <=5 触发提醒", () => {
    const obs = observeStepBudget(5, 20);
    expect(obs).not.toBeNull();
    expect(obs!.type).toBe("step_budget");
  });

  it("剩余步数 >5 不触发", () => {
    expect(observeStepBudget(6, 20)).toBeNull();
  });

  it("剩余步数 <=2 触发关键提醒", () => {
    const obs = observeStepBudget(2, 20);
    expect(obs!.content).toContain("关键");
  });

  it("连续重复同一动作触发卡顿警告", () => {
    const actions = [
      { actionName: "click", actionInput: { index: 1 } },
      { actionName: "click", actionInput: { index: 1 } },
      { actionName: "click", actionInput: { index: 1 } },
    ];
    const obs = observeStuckWarning(actions, 3);
    expect(obs).not.toBeNull();
    expect(obs!.type).toBe("stuck_warning");
  });

  it("非重复动作不触发卡顿警告", () => {
    const actions = [
      { actionName: "click", actionInput: { index: 1 } },
      { actionName: "input_text", actionInput: { text: "a" } },
      { actionName: "scroll", actionInput: { amount: 100 } },
    ];
    expect(observeStuckWarning(actions, 3)).toBeNull();
  });
});
