/**
 * Vision + Workflow + Checkpoint Tools — 一线 AI Agent 能力对齐工具集（复合工具版）
 *
 * 原 12 个细粒度工具合并为 3 个复合工具（action 判别字段，压缩 schema 与每轮 token 成本）：
 *   - vision_analyze（analyze / describe / find_elements / detect_issues / compare）
 *   - workflow（validate / execute / batch）
 *   - checkpoint（save / restore / list）
 * dlq_retry_batch 已并入 scheduler 复合工具的 retry_dlq action（见 scheduler-tools.ts）。
 *
 * 设计原则：
 *   - vision 工具直接调用 VisionAnalyzer（不依赖外部 LLM 路由）
 *   - workflow 需要注入 ToolExecutorFn（由 server 端绑定到 executor）
 *   - checkpoint 持久化到 data/checkpoints/
 */

import * as path from "path";
import type {
  AgentModelExecutor,
  VisionAnalyzer,
  BatchToolExecutorFn,
  BatchTask,
  WorkflowDefinition,
  DLQRetryHandler,
} from "@evoclaw/agent";
import {
  BatchExecutor as BatchExecutorClass,
  WorkflowEngine as WorkflowEngineClass,
  SessionCheckpointManager as SCPMClass,
  FileCheckpointStore as FCSClass,
} from "@evoclaw/agent";

export interface VisionBatchToolDeps {
  executor: AgentModelExecutor;
  visionAnalyzer: VisionAnalyzer;
  /** batch_execute 和 workflow_execute 调用的工具执行器（绑定到 AgentModelExecutor） */
  toolExecutorFn: BatchToolExecutorFn;
  /** checkpoint 文件存储根目录（默认 data/checkpoints） */
  checkpointBaseDir?: string;
  /**
   * DLQ 批量重试处理器（可选；未提供时工具返回错误）。
   * dlq_retry_batch 已并入 scheduler 复合工具的 retry_dlq action，本文件不再消费此字段；
   * 保留仅为兼容 index.ts 的调用签名，实际注入请改用 registerSchedulerTools 的 dlqHandler 参数。
   */
  dlqHandler?: DLQRetryHandler;
}

export function registerVisionBatchTools(deps: VisionBatchToolDeps): void {
  const { executor, visionAnalyzer, toolExecutorFn } = deps;
  const checkpointBaseDir = deps.checkpointBaseDir ?? path.resolve(process.cwd(), "data", "checkpoints");
  const checkpointStore = new FCSClass(checkpointBaseDir);
  const checkpointManager = new SCPMClass(checkpointStore);

  // ── vision_analyze 复合工具 ─────────────────────────────────
  // 以下 5 个 handler 为原 vision_* 工具的 handler 原样抽出，逻辑逐字保留

  /** 原 vision_analyze */
  const handleVisionAnalyze = async (params: Record<string, unknown>) => {
    try {
      const imageBase64 = String(params.imageBase64 || "");
      if (!imageBase64) return { success: false, error: "imageBase64 is required" };
      const prompt = String(params.prompt || "");
      if (!prompt) return { success: false, error: "prompt is required" };
      const result = await visionAnalyzer.analyze({
        imageBase64,
        imageMimeType: (params.imageMimeType as "image/png" | "image/jpeg" | "image/webp") ?? "image/png",
        prompt,
        maxTokens: (() => {
          if (!params.maxTokens) return undefined;
          const n = Number(params.maxTokens);
          return Number.isFinite(n) ? n : undefined;
        })(),
      });
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  /** 原 vision_describe_screen */
  const handleVisionDescribe = async (params: Record<string, unknown>) => {
    try {
      const imageBase64 = String(params.imageBase64 || "");
      if (!imageBase64) return { success: false, error: "imageBase64 is required" };
      const description = await visionAnalyzer.describeScreen(imageBase64, params.prompt ? String(params.prompt) : undefined);
      return { success: true, description };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  /** 原 vision_find_elements */
  const handleVisionFindElements = async (params: Record<string, unknown>) => {
    try {
      const imageBase64 = String(params.imageBase64 || "");
      if (!imageBase64) return { success: false, error: "imageBase64 is required" };
      const elements = await visionAnalyzer.findElements(imageBase64, params.elementType ? String(params.elementType) : undefined);
      return { success: true, elements, count: elements.length };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  /** 原 vision_detect_issues */
  const handleVisionDetectIssues = async (params: Record<string, unknown>) => {
    try {
      const imageBase64 = String(params.imageBase64 || "");
      if (!imageBase64) return { success: false, error: "imageBase64 is required" };
      const issues = await visionAnalyzer.detectUIIssues(imageBase64);
      return { success: true, issues, count: issues.length };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  /** 原 vision_compare_images */
  const handleVisionCompare = async (params: Record<string, unknown>) => {
    try {
      const image1Base64 = String(params.image1Base64 || "");
      const image2Base64 = String(params.image2Base64 || "");
      if (!image1Base64 || !image2Base64) return { success: false, error: "image1Base64 and image2Base64 are required" };
      const result = await visionAnalyzer.compareImages(image1Base64, image2Base64, params.prompt ? String(params.prompt) : undefined);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  executor.registerTool(
    "vision_analyze",
    {
      name: "vision_analyze",
      description:
        "复合视觉分析工具（composite vision tool），通过 action 参数选择具体操作，默认 analyze。" +
        "actions: " +
        "analyze（默认，用 VLM 通用分析图像：imageBase64 + prompt，返回描述/UI 元素/检测到的问题）； " +
        "describe（描述截图内容：布局、文本、按钮、错误信息）； " +
        "find_elements（按类型查找 UI 元素，返回带包围盒的元素数组）； " +
        "detect_issues（检测 UI/视觉问题：错位、重叠、文本截断、对比度、响应式布局错误）； " +
        "compare（对比两张截图并描述差异，返回差异描述 + 相似度 0-1）。",
      parameters: {
        action: {
          type: "string",
          description: "要执行的视觉操作。action to perform: analyze (default) / describe / find_elements / detect_issues / compare",
          enum: ["analyze", "describe", "find_elements", "detect_issues", "compare"],
          required: true,
        },
        imageBase64: { type: "string", description: "Base64-encoded image data (without data: prefix)（analyze / describe / find_elements / detect_issues 用）", required: false },
        imageMimeType: { type: "string", description: "Image MIME type: image/png (default), image/jpeg, image/webp（analyze 用）", required: false },
        prompt: { type: "string", description: "Analysis prompt（analyze / describe / compare 用）", required: false },
        maxTokens: { type: "number", description: "Max response tokens (default: 1000)（analyze 用）", required: false },
        elementType: { type: "string", description: "Element type to find: button, input, link, text, image, form, menu, dialog, unknown（find_elements 用）", required: false },
        image1Base64: { type: "string", description: "Base64-encoded first image（compare 用）", required: false },
        image2Base64: { type: "string", description: "Base64-encoded second image（compare 用）", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "analyze");
      if (action === "analyze") return await handleVisionAnalyze(params);
      if (action === "describe") return await handleVisionDescribe(params);
      if (action === "find_elements") return await handleVisionFindElements(params);
      if (action === "detect_issues") return await handleVisionDetectIssues(params);
      if (action === "compare") return await handleVisionCompare(params);
      return { success: false, error: `未知 vision_analyze action: ${action}（仅支持 analyze / describe / find_elements / detect_issues / compare）` };
    }
  );

  // ── workflow 复合工具 ──────────────────────────────────────
  // 原 workflow_validate / workflow_execute / batch_execute 三个工具合并

  /** 原 workflow_validate */
  const handleWorkflowValidate = async (params: Record<string, unknown>) => {
    try {
      const workflow = params.workflow as WorkflowDefinition;
      if (!workflow || !Array.isArray(workflow.nodes)) {
        return { success: false, error: "workflow.nodes must be an array" };
      }
      const engine = new WorkflowEngineClass(toolExecutorFn);
      const result = engine.validate(workflow);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  /** 原 workflow_execute */
  const handleWorkflowExecute = async (params: Record<string, unknown>) => {
    try {
      const workflow = params.workflow as WorkflowDefinition;
      if (!workflow || !Array.isArray(workflow.nodes)) {
        return { success: false, error: "workflow.nodes must be an array" };
      }
      // 路径穿越防护：workflow.id 拼接到持久化路径，必须限定为安全字符
      if (!workflow.id || !/^[A-Za-z0-9_\-]+$/.test(workflow.id)) {
        return { success: false, error: `Invalid workflow.id: ${workflow.id}. Only alphanumeric, underscore and hyphen are allowed.` };
      }
      const inputs = (params.inputs as Record<string, unknown>) ?? workflow.inputs ?? {};
      const engine = new WorkflowEngineClass(toolExecutorFn, {
        persistPath: path.join(checkpointBaseDir, "workflows", `${workflow.id}.json`),
      });
      const result = await engine.execute(workflow, inputs);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  /** 原 batch_execute */
  const handleWorkflowBatch = async (params: Record<string, unknown>) => {
    try {
      const tasks = Array.isArray(params.tasks) ? (params.tasks as BatchTask[]) : [];
      if (tasks.length === 0) return { success: false, error: "tasks array is required" };
      const batchExecutor = new BatchExecutorClass(toolExecutorFn, {
        maxConcurrency: (() => {
          if (!params.maxConcurrency) return undefined;
          const n = Number(params.maxConcurrency);
          return Number.isFinite(n) ? n : undefined;
        })(),
        rateLimitPerSecond: (() => {
          if (!params.rateLimitPerSecond) return undefined;
          const n = Number(params.rateLimitPerSecond);
          return Number.isFinite(n) ? n : undefined;
        })(),
        failFast: params.failFast === true,
      });
      const result = await batchExecutor.execute(tasks);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  executor.registerTool(
    "workflow",
    {
      name: "workflow",
      description:
        "复合工作流工具（composite workflow tool），通过 action 参数选择具体操作，默认 execute。" +
        "actions: " +
        "validate（校验 DAG 工作流定义：节点 ID 唯一性、依赖存在性、环检测，返回 {valid, errors}）； " +
        "execute（默认，执行 DAG 工作流：同层并行、依赖等待、条件分支、自动检查点持久化，返回逐节点结果）； " +
        "batch（并发批量执行工具调用：限速、重试、失败隔离，支持 dependsOn DAG 依赖）。",
      parameters: {
        action: {
          type: "string",
          description: "要执行的工作流操作。action to perform: validate / execute (default) / batch",
          enum: ["validate", "execute", "batch"],
          required: true,
        },
        workflow: { type: "object", description: "Workflow definition: {id, name, nodes: [{id, toolName, params, dependsOn, condition?, timeoutMs?, retries?}]}（validate / execute 用）", required: false },
        inputs: { type: "object", description: "Optional workflow-level inputs (passed to node params functions)（execute 用）", required: false },
        tasks: { type: "array", description: "Array of batch tasks: [{id, toolName, params, dependsOn?, timeoutMs?, retries?}]（batch 用）", required: false },
        maxConcurrency: { type: "number", description: "Max concurrent tasks (default: 5)（batch 用）", required: false },
        rateLimitPerSecond: { type: "number", description: "Max calls per second (optional rate limit)（batch 用）", required: false },
        failFast: { type: "boolean", description: "Stop on first failure (default: false)（batch 用）", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "execute");
      if (action === "validate") return await handleWorkflowValidate(params);
      if (action === "execute") return await handleWorkflowExecute(params);
      if (action === "batch") return await handleWorkflowBatch(params);
      return { success: false, error: `未知 workflow action: ${action}（仅支持 validate / execute / batch）` };
    }
  );

  // ── checkpoint 复合工具 ────────────────────────────────────
  // 原 checkpoint_save / checkpoint_restore / checkpoint_list 三个工具合并

  /** 原 checkpoint_save */
  const handleCheckpointSave = async (params: Record<string, unknown>) => {
    try {
      const sessionId = String(params.sessionId || "");
      if (!sessionId) return { success: false, error: "sessionId is required" };
      const messages = Array.isArray(params.messages) ? params.messages as Array<{role: string; content: string;}> : [];
      const toolCallHistory = Array.isArray(params.toolCallHistory) ? params.toolCallHistory as Array<{toolName: string; params: unknown; result: unknown; success: boolean; timestamp: number;}> : [];
      const id = await checkpointManager.save(
        sessionId,
        messages,
        toolCallHistory,
        {
          systemPrompt: params.systemPrompt ? String(params.systemPrompt) : undefined,
          skills: Array.isArray(params.skills) ? params.skills.map(String) : undefined,
        },
        params.label ? String(params.label) : undefined,
      );
      return { success: true, checkpointId: id };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  /** 原 checkpoint_restore */
  const handleCheckpointRestore = async (params: Record<string, unknown>) => {
    try {
      const checkpointId = String(params.checkpointId || "");
      if (!checkpointId) return { success: false, error: "checkpointId is required" };
      const checkpoint = await checkpointManager.restore(checkpointId);
      if (!checkpoint) return { success: false, error: `Checkpoint not found: ${checkpointId}` };
      return { success: true, checkpoint };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  /** 原 checkpoint_list */
  const handleCheckpointList = async (params: Record<string, unknown>) => {
    try {
      const sessionId = params.sessionId ? String(params.sessionId) : undefined;
      const list = await checkpointManager.list(sessionId);
      return { success: true, checkpoints: list, count: list.length };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  executor.registerTool(
    "checkpoint",
    {
      name: "checkpoint",
      description:
        "复合检查点工具（composite checkpoint tool），通过 action 参数选择具体操作，默认 save。" +
        "actions: " +
        "save（默认，保存当前会话状态 messages + 工具调用历史 + 上下文为检查点，返回 checkpointId）； " +
        "restore（恢复已保存的检查点，返回消息/历史/上下文，不修改任何状态，由调用方应用）； " +
        "list（列出已保存检查点，可按 sessionId 过滤）。",
      parameters: {
        action: {
          type: "string",
          description: "要执行的检查点操作。action to perform: save (default) / restore / list",
          enum: ["save", "restore", "list"],
          required: true,
        },
        sessionId: { type: "string", description: "Session ID（save / list 用）", required: false },
        messages: { type: "array", description: "Array of messages: [{role, content}]（save 用）", required: false },
        toolCallHistory: { type: "array", description: "Array of tool call records: [{toolName, params, result, success, timestamp}]（save 用）", required: false },
        systemPrompt: { type: "string", description: "System prompt (optional)（save 用）", required: false },
        skills: { type: "array", description: "Active skill names (optional)（save 用）", required: false },
        label: { type: "string", description: "Human-readable label for this checkpoint（save 用）", required: false },
        checkpointId: { type: "string", description: "Checkpoint ID (from checkpoint_save)（restore 用）", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "save");
      if (action === "save") return await handleCheckpointSave(params);
      if (action === "restore") return await handleCheckpointRestore(params);
      if (action === "list") return await handleCheckpointList(params);
      return { success: false, error: `未知 checkpoint action: ${action}（仅支持 save / restore / list）` };
    }
  );
}
