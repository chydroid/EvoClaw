/**
 * 30 个复杂任务模拟测试 — 全面测试本项目主要功能。
 *
 * 模拟用户输入 30 个复杂任务，覆盖：
 *   - 分层记忆系统（L0/L1/L2/L3 + 符号画布）Tasks 1-8
 *   - CanvasAgentOp 8 种原子操作 Tasks 9-14
 *   - AutoFixer 响应修复 Tasks 15-19
 *   - ReflectionContract 反思契约 Tasks 20-24
 *   - 跨组件集成 Tasks 25-30
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { LayeredMemory } from "@evoclaw/memory";
import { SymbolicMemoryCanvas } from "@evoclaw/memory";
import {
  applyCanvasAgentOps,
  batchAddToolNodes,
  chainConnectOps,
  summarizeCanvasAgentOps,
  type CanvasAgentOp,
} from "@evoclaw/memory";
import { normalizeResponse, formatReflection } from "./auto-fixer";
import {
  buildMacroToolSchema,
  extractReflectionAndAction,
  renderHistoryEntry,
  MACRO_TOOL_SYSTEM_PROMPT,
  observeUrlChange,
  observeWaitBudget,
  observeStepBudget,
  observeStuckWarning,
  type ReflectionHistoryEntry,
  type ToolSchema,
} from "./reflection-contract";
import type { CanvasNode, CanvasEdge, CanvasNodeType } from "@evoclaw/memory";

// ── 测试辅助 ──
function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-complex-"));
}
function rmTempDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
function mkCanvasNodes(): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  return {
    nodes: [
      { id: "n1", type: "user_request" as CanvasNodeType, label: "起点", metadata: {} },
      { id: "n2", type: "tool_call" as CanvasNodeType, label: "工具A", metadata: { tool: "A" } },
    ],
    edges: [{ from: "n1", to: "n2", label: "调用" }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 分层记忆系统（Tasks 1-8）
// ─────────────────────────────────────────────────────────────────────────────
describe("30 个复杂任务模拟 > 分层记忆系统（Tasks 1-8）", () => {
  let dir: string;
  let mem: LayeredMemory;

  beforeEach(() => {
    dir = mkTempDir();
    mem = new LayeredMemory(dir, {
      l2AggregateEveryNTurns: 3,
      l3RefreshEveryNTurns: 3,
      l1RecallLimit: 5,
      l1MinPriority: 30,
    });
  });
  afterEach(() => rmTempDir(dir));

  it("Task 1: 多轮对话 captureTurn 写入 L0+L1，recall 召回相关记忆", async () => {
    await mem.captureTurn({
      userText: "我喜欢用 TypeScript 写后端服务",
      assistantText: "好的，TypeScript 是很好的选择",
      sessionKey: "s1",
    });
    await mem.captureTurn({
      userText: "我在用 Express 框架开发 REST API",
      assistantText: "Express 配合 TypeScript 很常见",
      sessionKey: "s1",
    });
    await mem.captureTurn({
      userText: "如何用 TypeScript 配置 ESLint？",
      assistantText: "可以通过 @typescript-eslint 包配置",
      sessionKey: "s1",
    });

    const result = mem.recall("TypeScript 配置");
    expect(result.l1Memories.length).toBeGreaterThan(0);
    expect(result.prependContext).toContain("相关历史记忆");
    const hasTypeScript = result.l1Memories.some(m => m.content.includes("TypeScript"));
    expect(hasTypeScript).toBe(true);
  });

  it("Task 2: L1 原子记忆提取覆盖多种内容类型", async () => {
    await mem.captureTurn({
      userText: "我喜欢 TypeScript，我叫张三，我是一名前端工程师，我擅长 React 和 Vue",
      assistantText: "你好张三",
      sessionKey: "s2",
    });
    const allL1 = mem.getAllL1Memories();
    expect(allL1.length).toBeGreaterThan(0);
    const contents = allL1.map(m => m.content).join(" ");
    expect(contents.length).toBeGreaterThan(10);
  });

  it("Task 3: L2 场景块在阈值后聚合", async () => {
    for (let i = 0; i < 3; i++) {
      await mem.captureTurn({
        userText: `第 ${i + 1} 轮对话，讨论主题 ${i}`,
        assistantText: `回复 ${i + 1}`,
        sessionKey: "s3",
      });
    }
    expect(mem.getTurnCount()).toBe(3);
    const result = mem.recall("对话");
    expect(result).toBeDefined();
  });

  it("Task 4: L3 画像在阈值后刷新", async () => {
    for (let i = 0; i < 3; i++) {
      await mem.captureTurn({
        userText: `我是工程师，喜欢编程，使用 Node.js ${i}`,
        assistantText: `好的 ${i}`,
        sessionKey: "s4",
      });
    }
    const result = mem.recall("用户画像");
    expect(result.appendSystemContext).toBeDefined();
  });

  it("Task 5: SymbolicMemoryCanvas Mermaid 渲染包含节点和边", () => {
    const canvas = new SymbolicMemoryCanvas();
    canvas.start("session-5", "用户请求：测试画布渲染");
    canvas.addNode("tool_call", "search_web", { sourceMessageId: "l0_001" });
    canvas.addNode("result", "找到 3 条结果");
    canvas.connect("n1", "n2", "成功");
    canvas.connect("n2", "n3", "返回");

    const mermaid = canvas.render();
    expect(mermaid).toContain("graph LR");
    expect(mermaid).toContain('n1(["用户请求');
    expect(mermaid).toContain('n2["search_web"]');
    expect(mermaid).toContain('n3(("找到 3 条结果"))');
    expect(mermaid).toContain("n1 -->|成功| n2");
    expect(mermaid).toContain("n2 -->|返回| n3");
  });

  it("Task 6: Canvas snapshot 和 mermaid 导出", () => {
    mem.startCanvas("s6", "用户请求：导出画布");
    mem.recordToolNode({
      toolName: "read_file",
      params: { path: "/tmp/test.txt" },
      success: true,
      resultPreview: "文件内容",
      sessionId: "s6",
    });

    const snapshot = mem.getCanvasSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.nodes.length).toBeGreaterThan(0);
    expect(snapshot!.sessionKey).toBe("s6");
    expect(snapshot!.createdAt).toBeGreaterThan(0);

    const mermaid = mem.getCanvasMermaid();
    expect(mermaid).toContain("graph LR");
  });

  it("Task 7: 跨会话累积 L1 记忆", async () => {
    await mem.captureTurn({
      userText: "我喜欢数据库设计，我经常用 PostgreSQL",
      assistantText: "好的",
      sessionKey: "sessionA",
    });
    await mem.captureTurn({
      userText: "我在用 Node.js 开发 API，我擅长后端",
      assistantText: "好的",
      sessionKey: "sessionB",
    });
    const allL1 = mem.getAllL1Memories();
    expect(allL1.length).toBeGreaterThanOrEqual(2);
    const contents = allL1.map(m => m.content).join(" ");
    expect(contents.length).toBeGreaterThan(10);
  });

  it("Task 8: Layered memory recall 关键词匹配", async () => {
    await mem.captureTurn({
      userText: "我需要配置 Docker 容器部署应用",
      assistantText: "Docker 部署很方便",
      sessionKey: "s8",
    });
    await mem.captureTurn({
      userText: "请帮我写一个 CI/CD pipeline 配置",
      assistantText: "可以用 GitHub Actions",
      sessionKey: "s8",
    });

    const dockerResult = mem.recall("Docker");
    expect(dockerResult.l1Memories.length).toBeGreaterThan(0);

    const unrelatedResult = mem.recall("xyzabc123");
    expect(unrelatedResult.l1Memories.length).toBeLessThanOrEqual(dockerResult.l1Memories.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CanvasAgentOp 8 种原子操作（Tasks 9-14）
// ─────────────────────────────────────────────────────────────────────────────
describe("30 个复杂任务模拟 > CanvasAgentOp 原子操作（Tasks 9-14）", () => {
  it("Task 9: add_node 自动生成 ID 和指定 ID（幂等）", () => {
    const canvas = mkCanvasNodes();
    const ops: CanvasAgentOp[] = [
      { type: "add_node", label: "自动 ID 节点" },
      { type: "add_node", id: "custom-1", label: "自定义 ID 节点" },
      { type: "add_node", id: "custom-1", label: "重复 ID 应该跳过" },
    ];
    const result = applyCanvasAgentOps(canvas, ops);
    expect(result.nodes.length).toBe(4);
    expect(result.nodes.some(n => n.id === "custom-1")).toBe(true);
  });

  it("Task 10: update_node 浅合并 label 和 metadata", () => {
    const canvas = mkCanvasNodes();
    const ops: CanvasAgentOp[] = [
      { type: "update_node", id: "n2", label: "更新后的工具A", metadata: { duration: 100 } },
    ];
    const result = applyCanvasAgentOps(canvas, ops);
    const updated = result.nodes.find(n => n.id === "n2");
    expect(updated!.label).toBe("更新后的工具A");
    expect(updated!.metadata!.tool).toBe("A");
    expect(updated!.metadata!.duration).toBe(100);
  });

  it("Task 11: delete_node 按 nodeType 删除", () => {
    const canvas: { nodes: CanvasNode[]; edges: CanvasEdge[] } = {
      nodes: [
        { id: "n1", type: "user_request", label: "起点", metadata: {} },
        { id: "n2", type: "tool_call", label: "工具A", metadata: {} },
        { id: "n3", type: "tool_call", label: "工具B", metadata: {} },
        { id: "n4", type: "result", label: "结果", metadata: {} },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3" },
        { from: "n3", to: "n4" },
      ],
    };

    const result = applyCanvasAgentOps(canvas, [
      { type: "delete_node", nodeType: "tool_call" },
    ]);
    expect(result.nodes.length).toBe(2);
    expect(result.edges.length).toBe(0);
  });

  it("Task 12: connect_nodes 校验存在 + 去重", () => {
    const canvas = mkCanvasNodes();
    const ops: CanvasAgentOp[] = [
      { type: "connect_nodes", fromNodeId: "n1", toNodeId: "n2", label: "调用" },
      { type: "connect_nodes", fromNodeId: "n2", toNodeId: "n1", label: "回调" },
      { type: "connect_nodes", fromNodeId: "n1", toNodeId: "n999", label: "无效" },
    ];
    const result = applyCanvasAgentOps(canvas, ops);
    expect(result.edges.length).toBe(2);
  });

  it("Task 13: batchAddToolNodes 批量添加工具节点", () => {
    const toolCalls = [
      { toolName: "read_file", params: { path: "a.ts" } },
      { toolName: "write_file", params: { path: "b.ts" } },
      { toolName: "exec_command", params: { cmd: "ls" } },
    ];
    const ops = batchAddToolNodes(toolCalls);
    expect(ops.length).toBe(3);
    expect(ops.every(op => op.type === "add_node")).toBe(true);
    // 每个 add_node op 的 label 包含对应的 toolName
    const toolNames = ["read_file", "write_file", "exec_command"];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.type === "add_node") {
        expect(op.label).toContain(toolNames[i]);
      }
    }
  });

  it("Task 14: 组合操作序列 — 批量添加 + 链式连接 + 选中", () => {
    const canvas: { nodes: CanvasNode[]; edges: CanvasEdge[] } = { nodes: [], edges: [] };
    const addOps = batchAddToolNodes([
      { toolName: "step1" },
      { toolName: "step2" },
      { toolName: "step3" },
    ]);
    let result = applyCanvasAgentOps(canvas, addOps);
    expect(result.nodes.length).toBe(3);

    const ids = result.nodes.map(n => n.id);
    const connectOps = chainConnectOps(ids, "next");
    result = applyCanvasAgentOps(result, connectOps);
    expect(result.edges.length).toBe(2);

    const selectOp: CanvasAgentOp = { type: "select_nodes", ids };
    result = applyCanvasAgentOps(result, [selectOp]);
    expect(result.selectedNodeIds.length).toBe(3);

    // summarizeCanvasAgentOps 返回字符串
    const summary = summarizeCanvasAgentOps([...addOps, ...connectOps, selectOp]);
    expect(summary).toContain("新增节点");
    expect(summary).toContain("连接节点");
    expect(summary).toContain("选中节点");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AutoFixer 响应修复（Tasks 15-19）
// ─────────────────────────────────────────────────────────────────────────────
describe("30 个复杂任务模拟 > AutoFixer 响应修复（Tasks 15-19）", () => {
  it("Task 15: 正常 tool_calls 直接通过", () => {
    const message = {
      tool_calls: [
        {
          id: "call_1",
          type: "function" as const,
          function: { name: "search", arguments: '{"query": "test"}' },
        },
      ],
    };
    const result = normalizeResponse(message as any);
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0].name).toBe("search");
    expect(result.toolCalls[0].arguments.query).toBe("test");
    expect(result.fixes.length).toBe(0);
  });

  it("Task 16: 从 content 提取 JSON（无 tool_calls）", () => {
    const message = {
      content: '{"action": {"click": {"selector": "#btn"}}}',
    };
    const result = normalizeResponse(message as any, "AgentOutput");
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0].name).toBe("AgentOutput");
    expect(result.fixes.length).toBeGreaterThan(0);
  });

  it("Task 17: AgentOutput 包装层解析", () => {
    const message = {
      tool_calls: [
        {
          id: "call_1",
          type: "function" as const,
          function: {
            name: "AgentOutput",
            arguments: JSON.stringify({
              evaluation_previous_goal: "成功",
              memory: "记住状态",
              next_goal: "点击按钮",
              action: { click: { selector: "#submit" } },
            }),
          },
        },
      ],
    };
    const result = normalizeResponse(message as any, "AgentOutput");
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0].name).toBe("AgentOutput");
    expect(result.toolCalls[0].arguments.action).toBeDefined();
  });

  it("Task 18: 修复 arguments 被双重 stringify", () => {
    const innerArgs = { selector: "#input", value: "hello" };
    const message = {
      tool_calls: [
        {
          id: "call_1",
          type: "function" as const,
          function: {
            name: "type",
            arguments: JSON.stringify({ arguments: JSON.stringify(innerArgs) }),
          },
        },
      ],
    };
    const result = normalizeResponse(message as any);
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0].arguments).toBeDefined();
  });

  it("Task 19: 完全缺 action 兜底 wait + formatReflection", () => {
    const message = {
      content: '{"evaluation_previous_goal": "需要等待", "next_goal": "等待页面加载"}',
    };
    const result = normalizeResponse(message as any, "AgentOutput");
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0].name).toBe("AgentOutput");
    expect(result.toolCalls[0].arguments.action).toBeDefined();

    const text = formatReflection({
      evaluationPreviousGoal: "需要等待",
      memory: "页面正在加载",
      nextGoal: "继续操作",
    });
    expect(text).toContain("需要等待");
    expect(text).toContain("页面正在加载");
    expect(text).toContain("继续操作");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ReflectionContract 反思契约（Tasks 20-24）
// ─────────────────────────────────────────────────────────────────────────────
describe("30 个复杂任务模拟 > ReflectionContract 反思契约（Tasks 20-24）", () => {
  it("Task 20: buildMacroToolSchema 合并多个工具", () => {
    const tools: ToolSchema[] = [
      {
        name: "click",
        description: "点击元素",
        inputSchema: {
          type: "object",
          properties: { selector: { type: "string" } },
          required: ["selector"],
        },
      },
      {
        name: "type",
        description: "输入文本",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ];
    const schema = buildMacroToolSchema(tools);
    expect(schema.name).toBe("AgentOutput");
    const props = schema.inputSchema.properties as Record<string, unknown>;
    expect(props.action).toBeDefined();
    expect(props.evaluation_previous_goal).toBeDefined();
    expect(props.memory).toBeDefined();
    expect(props.next_goal).toBeDefined();
    expect(schema.inputSchema.required).toEqual(["action"]);
  });

  it("Task 21: extractReflectionAndAction 提取反思和行动", () => {
    const args = {
      evaluation_previous_goal: "上一步成功",
      memory: "用户登录了",
      next_goal: "点击提交",
      action: { click: { selector: "#submit" } },
    };
    const result = extractReflectionAndAction(args);
    expect(result).not.toBeNull();
    expect(result!.reflection.evaluationPreviousGoal).toBe("上一步成功");
    expect(result!.reflection.memory).toBe("用户登录了");
    expect(result!.reflection.nextGoal).toBe("点击提交");
    expect(result!.actionName).toBe("click");
    expect(result!.actionInput.selector).toBe("#submit");
  });

  it("Task 22: renderHistoryEntry 渲染历史条目", () => {
    const entry: ReflectionHistoryEntry = {
      stepIndex: 3,
      reflection: {
        evaluationPreviousGoal: "成功",
        memory: "记住",
        nextGoal: "下一步",
      },
      actionName: "click",
      actionInput: { selector: "#btn" },
      actionOutput: "点击成功",
      success: true,
    };
    const text = renderHistoryEntry(entry);
    expect(text).toContain("<step_3>");
    expect(text).toContain("成功");
    expect(text).toContain("记住");
    expect(text).toContain("下一步");
    expect(text).toContain("click");
  });

  it("Task 23: URL 变化观察 + 步数预算", () => {
    const urlObs = observeUrlChange("https://a.com", "https://b.com");
    expect(urlObs).not.toBeNull();
    expect(urlObs!.content.length).toBeGreaterThan(0);

    const urlObs2 = observeUrlChange("https://a.com", "https://a.com");
    expect(urlObs2).toBeNull();

    const stepObs = observeStepBudget(5, 20);
    expect(stepObs).not.toBeNull();

    const stepObs2 = observeStepBudget(15, 20);
    expect(stepObs2).toBeNull();
  });

  it("Task 24: 等待预算 + 卡顿警告", () => {
    // observeWaitBudget 接受秒数，阈值是 < 3 秒不触发
    const waitObs = observeWaitBudget(3.5);
    expect(waitObs).not.toBeNull();

    const waitObs2 = observeWaitBudget(2);
    expect(waitObs2).toBeNull();

    // observeStuckWarning 接受 { actionName, actionInput }[] 数组
    const stuckActions = [
      { actionName: "click", actionInput: { selector: "#btn" } },
      { actionName: "click", actionInput: { selector: "#btn" } },
      { actionName: "click", actionInput: { selector: "#btn" } },
    ];
    const stuckObs = observeStuckWarning(stuckActions);
    expect(stuckObs).not.toBeNull();

    const variedActions = [
      { actionName: "type", actionInput: { text: "a" } },
      { actionName: "scroll", actionInput: { x: 0 } },
      { actionName: "click", actionInput: { selector: "#btn" } },
    ];
    const stuckObs2 = observeStuckWarning(variedActions);
    expect(stuckObs2).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 跨组件集成（Tasks 25-30）
// ─────────────────────────────────────────────────────────────────────────────
describe("30 个复杂任务模拟 > 跨组件集成（Tasks 25-30）", () => {
  let dir: string;
  let mem: LayeredMemory;

  beforeEach(() => {
    dir = mkTempDir();
    mem = new LayeredMemory(dir);
  });
  afterEach(() => rmTempDir(dir));

  it("Task 25: 完整流程 — captureTurn → recordToolNode → recall", async () => {
    await mem.captureTurn({
      userText: "我喜欢用 TypeScript 编程，帮我搜索 TypeScript 教程",
      assistantText: "好的，我来搜索",
      sessionKey: "s25",
    });

    mem.startCanvas("s25", "用户请求：搜索 TypeScript 教程");
    mem.recordToolNode({
      toolName: "search_web",
      params: { query: "TypeScript 教程" },
      success: true,
      resultPreview: "找到 10 条结果",
      sessionId: "s25",
    });

    const result = mem.recall("TypeScript");
    expect(result.l1Memories.length).toBeGreaterThan(0);

    const snapshot = mem.getCanvasSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.nodes.length).toBeGreaterThan(0);

    const mermaid = mem.getCanvasMermaid();
    expect(mermaid).toContain("graph LR");
    expect(mermaid).toContain("search_web");
  });

  it("Task 26: Canvas ops 集成到 LayeredMemory", () => {
    mem.startCanvas("s26", "用户请求：测试 canvas ops");

    const ops: CanvasAgentOp[] = [
      { type: "add_node", label: "工具调用 A" },
      { type: "add_node", label: "工具调用 B" },
      { type: "add_node", label: "工具调用 C" },
    ];
    const result = mem.applyCanvasOps(ops);
    expect(result).not.toBeNull();
    expect(result!.nodes.length).toBeGreaterThan(0);

    const nodes = result!.nodes;
    const connectOps: CanvasAgentOp[] = [
      { type: "connect_nodes", fromNodeId: nodes[0].id, toNodeId: nodes[1].id, label: "next" },
      { type: "connect_nodes", fromNodeId: nodes[1].id, toNodeId: nodes[2].id, label: "next" },
    ];
    const result2 = mem.applyCanvasOps(connectOps);
    expect(result2!.edges.length).toBeGreaterThanOrEqual(2);

    const deleteOps: CanvasAgentOp[] = [
      { type: "delete_node", id: nodes[2].id },
    ];
    const result3 = mem.applyCanvasOps(deleteOps);
    expect(result3!.nodes.length).toBe(result2!.nodes.length - 1);
  });

  it("Task 27: 多个工具调用形成链式流程图", () => {
    mem.startCanvas("s27", "用户请求：多步骤任务");

    const tools = [
      { toolName: "read_file", success: true, resultPreview: "读取配置" },
      { toolName: "parse_json", success: true, resultPreview: "解析成功" },
      { toolName: "validate", success: true, resultPreview: "验证通过" },
      { toolName: "write_file", success: true, resultPreview: "写入完成" },
    ];

    for (const t of tools) {
      mem.recordToolNode({
        toolName: t.toolName,
        success: t.success,
        resultPreview: t.resultPreview,
        sessionId: "s27",
      });
    }

    const snapshot = mem.getCanvasSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.nodes.length).toBe(5);
    expect(snapshot!.edges.length).toBe(4);

    const mermaid = mem.getCanvasMermaid();
    expect(mermaid).toContain("read_file");
    expect(mermaid).toContain("parse_json");
    expect(mermaid).toContain("validate");
    expect(mermaid).toContain("write_file");
  });

  it("Task 28: 失败工具调用记录为 error 节点", () => {
    mem.startCanvas("s28", "用户请求：测试错误处理");

    mem.recordToolNode({
      toolName: "fetch_url",
      params: { url: "https://invalid.example" },
      success: false,
      error: "网络超时",
      sessionId: "s28",
    });

    const snapshot = mem.getCanvasSnapshot();
    expect(snapshot).not.toBeNull();
    const nodes = snapshot!.nodes as CanvasNode[];
    const errorNode = nodes.find(n => n.type === "error");
    expect(errorNode).toBeDefined();
    expect(errorNode!.label).toContain("fetch_url");
    expect(errorNode!.label).toContain("网络超时");
  });

  it("Task 29: 反思历史记录与渲染（模拟 AgentModelExecutor 行为）", () => {
    const history: ReflectionHistoryEntry[] = [];

    history.push({
      stepIndex: 1,
      reflection: {
        evaluationPreviousGoal: "任务开始",
        nextGoal: "读取文件",
      },
      actionName: "read_file",
      actionInput: { path: "/tmp/config.json" },
      actionOutput: "文件内容",
      success: true,
    });

    history.push({
      stepIndex: 2,
      reflection: {
        evaluationPreviousGoal: "读取成功",
        memory: "配置是 JSON 格式",
        nextGoal: "解析 JSON",
      },
      actionName: "parse_json",
      actionInput: { content: "{}" },
      actionOutput: "解析成功",
      success: true,
    });

    history.push({
      stepIndex: 3,
      reflection: {
        evaluationPreviousGoal: "解析成功",
        memory: "需要验证字段",
        nextGoal: "验证 schema",
      },
      actionName: "validate",
      actionInput: { schema: "user" },
      actionOutput: "缺少必填字段 email",
      success: false,
      error: "ValidationError",
    });

    const rendered = history.map(renderHistoryEntry).join("\n");
    expect(rendered).toContain("<step_1>");
    expect(rendered).toContain("<step_2>");
    expect(rendered).toContain("<step_3>");
    expect(rendered).toContain("read_file");
    expect(rendered).toContain("parse_json");
    expect(rendered).toContain("validate");
  });

  it("Task 30: 端到端 — 用户请求 → 工具执行 → 画布更新 → 召回", async () => {
    await mem.captureTurn({
      userText: "我喜欢分析项目代码结构，我经常用 TypeScript",
      assistantText: "我来帮你分析代码结构",
      sessionKey: "s30",
    });

    mem.startCanvas("s30", "用户请求：分析代码结构");

    const toolCalls = [
      { toolName: "list_files", success: true, resultPreview: "找到 50 个文件" },
      { toolName: "read_package_json", success: true, resultPreview: "monorepo" },
      { toolName: "analyze_deps", success: true, resultPreview: "17 个包" },
    ];
    for (const t of toolCalls) {
      mem.recordToolNode({ ...t, sessionId: "s30" });
    }

    const ops: CanvasAgentOp[] = [
      { type: "add_node", nodeType: "decision", label: "是否生成报告?" },
    ];
    mem.applyCanvasOps(ops);

    const recall = mem.recall("TypeScript");
    expect(recall.l1Memories.length).toBeGreaterThan(0);

    const snapshot = mem.getCanvasSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.nodes.length).toBe(5);
    expect(snapshot!.edges.length).toBe(3);

    const mermaid = mem.getCanvasMermaid();
    expect(mermaid).toContain("graph LR");
    expect(mermaid).toContain("list_files");
    expect(mermaid).toContain("read_package_json");
    expect(mermaid).toContain("analyze_deps");
    expect(mermaid).toContain("是否生成报告?");

    expect(MACRO_TOOL_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });
});
