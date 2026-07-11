/**
 * Vision + Batch + Workflow + Checkpoint + DLQ Tools — 一线 AI Agent 能力对齐工具集
 *
 * 注册以下工具（对标 Claude Computer Use / Devin / Manus）：
 *   - vision_analyze / vision_describe_screen / vision_find_elements / vision_detect_issues / vision_compare_images
 *   - batch_execute（并发批量执行 + 限速 + 失败隔离）
 *   - workflow_validate / workflow_execute（DAG 工作流 + 条件分支 + 持久化）
 *   - checkpoint_save / checkpoint_restore / checkpoint_list（会话检查点）
 *   - dlq_retry_batch（死信队列批量重试）
 *
 * 设计原则：
 *   - vision 工具直接调用 VisionAnalyzer（不依赖外部 LLM 路由）
 *   - batch/workflow 需要注入 ToolExecutorFn（由 server 端绑定到 executor）
 *   - checkpoint 持久化到 data/checkpoints/
 *   - dlq_retry_batch 需要注入 DLQRetryHandler（由 server 端绑定到 DeadLetterQueue）
 */

import * as path from "path";
import type {
  AgentModelExecutor,
  VisionAnalyzer,
  BatchToolExecutorFn,
  BatchTask,
  WorkflowDefinition,
  DLQEntry,
  DLQRetryHandler,
} from "@evoclaw/agent";
import {
  BatchExecutor as BatchExecutorClass,
  WorkflowEngine as WorkflowEngineClass,
  SessionCheckpointManager as SCPMClass,
  FileCheckpointStore as FCSClass,
  DLQBatchRetry as DLQClass,
} from "@evoclaw/agent";

export interface VisionBatchToolDeps {
  executor: AgentModelExecutor;
  visionAnalyzer: VisionAnalyzer;
  /** batch_execute 和 workflow_execute 调用的工具执行器（绑定到 AgentModelExecutor） */
  toolExecutorFn: BatchToolExecutorFn;
  /** checkpoint 文件存储根目录（默认 data/checkpoints） */
  checkpointBaseDir?: string;
  /** dlq_retry_batch 调用的重试处理器（可选；未提供时工具返回错误） */
  dlqHandler?: DLQRetryHandler;
}

export function registerVisionBatchTools(deps: VisionBatchToolDeps): void {
  const { executor, visionAnalyzer, toolExecutorFn } = deps;
  const checkpointBaseDir = deps.checkpointBaseDir ?? path.resolve(process.cwd(), "data", "checkpoints");
  const checkpointStore = new FCSClass(checkpointBaseDir);
  const checkpointManager = new SCPMClass(checkpointStore);

  // ── vision_analyze ──────────────────────────────────────────
  executor.registerTool(
    "vision_analyze",
    {
      name: "vision_analyze",
      description: "Analyze a screenshot/image with a VLM (vision language model). Pass base64-encoded image + analysis prompt. Returns structured result: description, UI elements (with bounding boxes), and detected issues.",
      parameters: {
        imageBase64: { type: "string", description: "Base64-encoded image data (without data: prefix)", required: true },
        imageMimeType: { type: "string", description: "Image MIME type: image/png (default), image/jpeg, image/webp", required: false },
        prompt: { type: "string", description: "Analysis prompt (what to look for in the image)", required: true },
        maxTokens: { type: "number", description: "Max response tokens (default: 1000)", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        const imageBase64 = String(params.imageBase64 || "");
        if (!imageBase64) return { success: false, error: "imageBase64 is required" };
        const prompt = String(params.prompt || "");
        if (!prompt) return { success: false, error: "prompt is required" };
        const result = await visionAnalyzer.analyze({
          imageBase64,
          imageMimeType: (params.imageMimeType as "image/png" | "image/jpeg" | "image/webp") ?? "image/png",
          prompt,
          maxTokens: params.maxTokens ? Number(params.maxTokens) : undefined,
        });
        return { success: true, ...result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── vision_describe_screen ──────────────────────────────────
  executor.registerTool(
    "vision_describe_screen",
    {
      name: "vision_describe_screen",
      description: "Describe the content of a screenshot in natural language. Useful for understanding page layout, visible text, buttons, forms, and error messages.",
      parameters: {
        imageBase64: { type: "string", description: "Base64-encoded screenshot", required: true },
        prompt: { type: "string", description: "Optional custom prompt (default: describe layout, text, buttons, errors)", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        const imageBase64 = String(params.imageBase64 || "");
        if (!imageBase64) return { success: false, error: "imageBase64 is required" };
        const description = await visionAnalyzer.describeScreen(imageBase64, params.prompt ? String(params.prompt) : undefined);
        return { success: true, description };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── vision_find_elements ────────────────────────────────────
  executor.registerTool(
    "vision_find_elements",
    {
      name: "vision_find_elements",
      description: "Identify UI elements in a screenshot by type (button, input, link, text, image, form, menu, dialog). Returns array of elements with bounding boxes (x, y, width, height) and labels.",
      parameters: {
        imageBase64: { type: "string", description: "Base64-encoded screenshot", required: true },
        elementType: { type: "string", description: "Element type to find: button, input, link, text, image, form, menu, dialog, unknown", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        const imageBase64 = String(params.imageBase64 || "");
        if (!imageBase64) return { success: false, error: "imageBase64 is required" };
        const elements = await visionAnalyzer.findElements(imageBase64, params.elementType ? String(params.elementType) : undefined);
        return { success: true, elements, count: elements.length };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── vision_detect_issues ────────────────────────────────────
  executor.registerTool(
    "vision_detect_issues",
    {
      name: "vision_detect_issues",
      description: "Detect UI/visual issues in a screenshot: misalignment, overlap, text truncation, contrast problems, responsive layout errors. Returns array of issues with severity and location.",
      parameters: {
        imageBase64: { type: "string", description: "Base64-encoded screenshot", required: true },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        const imageBase64 = String(params.imageBase64 || "");
        if (!imageBase64) return { success: false, error: "imageBase64 is required" };
        const issues = await visionAnalyzer.detectUIIssues(imageBase64);
        return { success: true, issues, count: issues.length };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── vision_compare_images ───────────────────────────────────
  executor.registerTool(
    "vision_compare_images",
    {
      name: "vision_compare_images",
      description: "Compare two screenshots and describe their differences. Returns text description of differences + similarity score (0-1).",
      parameters: {
        image1Base64: { type: "string", description: "Base64-encoded first image", required: true },
        image2Base64: { type: "string", description: "Base64-encoded second image", required: true },
        prompt: { type: "string", description: "Optional comparison prompt (default: describe differences)", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        const image1Base64 = String(params.image1Base64 || "");
        const image2Base64 = String(params.image2Base64 || "");
        if (!image1Base64 || !image2Base64) return { success: false, error: "image1Base64 and image2Base64 are required" };
        const result = await visionAnalyzer.compareImages(image1Base64, image2Base64, params.prompt ? String(params.prompt) : undefined);
        return { success: true, ...result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── batch_execute ───────────────────────────────────────────
  executor.registerTool(
    "batch_execute",
    {
      name: "batch_execute",
      description: "Execute multiple tool calls in parallel with concurrency limit, rate limiting, retries, and failure isolation. Each task: {id, toolName, params, dependsOn?, timeoutMs?, retries?}. Supports DAG dependency (dependsOn) for ordered execution. Use this instead of multiple sequential tool calls when tasks are independent.",
      parameters: {
        tasks: { type: "array", description: "Array of batch tasks: [{id, toolName, params, dependsOn?, timeoutMs?, retries?}]", required: true },
        maxConcurrency: { type: "number", description: "Max concurrent tasks (default: 5)", required: false },
        rateLimitPerSecond: { type: "number", description: "Max calls per second (optional rate limit)", required: false },
        failFast: { type: "boolean", description: "Stop on first failure (default: false)", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        const tasks = Array.isArray(params.tasks) ? (params.tasks as BatchTask[]) : [];
        if (tasks.length === 0) return { success: false, error: "tasks array is required" };
        const batchExecutor = new BatchExecutorClass(toolExecutorFn, {
          maxConcurrency: params.maxConcurrency ? Number(params.maxConcurrency) : undefined,
          rateLimitPerSecond: params.rateLimitPerSecond ? Number(params.rateLimitPerSecond) : undefined,
          failFast: params.failFast === true,
        });
        const result = await batchExecutor.execute(tasks);
        return { success: true, ...result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── workflow_validate ───────────────────────────────────────
  executor.registerTool(
    "workflow_validate",
    {
      name: "workflow_validate",
      description: "Validate a DAG workflow definition. Checks node ID uniqueness, dependency existence, and cycle detection. Returns {valid, errors}.",
      parameters: {
        workflow: { type: "object", description: "Workflow definition: {id, name, nodes: [{id, toolName, params, dependsOn, condition?, timeoutMs?, retries?}]}", required: true },
      },
    },
    async (params: Record<string, unknown>) => {
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
    }
  );

  // ── workflow_execute ────────────────────────────────────────
  executor.registerTool(
    "workflow_execute",
    {
      name: "workflow_execute",
      description: "Execute a DAG workflow. Nodes run in topological order: same-level nodes parallel, dependent nodes wait. Supports conditional branches (condition function), per-node timeout/retries, and automatic checkpoint persistence. Returns node-by-node results.",
      parameters: {
        workflow: { type: "object", description: "Workflow definition: {id, name, nodes, inputs?}", required: true },
        inputs: { type: "object", description: "Optional workflow-level inputs (passed to node params functions)", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
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
    }
  );

  // ── checkpoint_save ─────────────────────────────────────────
  executor.registerTool(
    "checkpoint_save",
    {
      name: "checkpoint_save",
      description: "Save current session state (messages + tool call history + context) as a checkpoint. Returns checkpoint ID. Useful before risky operations or for long-running tasks that may need to resume.",
      parameters: {
        sessionId: { type: "string", description: "Session ID", required: true },
        messages: { type: "array", description: "Array of messages: [{role, content}]", required: true },
        toolCallHistory: { type: "array", description: "Array of tool call records: [{toolName, params, result, success, timestamp}]", required: false },
        systemPrompt: { type: "string", description: "System prompt (optional)", required: false },
        skills: { type: "array", description: "Active skill names (optional)", required: false },
        label: { type: "string", description: "Human-readable label for this checkpoint", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
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
    }
  );

  // ── checkpoint_restore ──────────────────────────────────────
  executor.registerTool(
    "checkpoint_restore",
    {
      name: "checkpoint_restore",
      description: "Restore a saved session checkpoint. Returns the saved messages, tool call history, and context. Does NOT modify any state — caller must apply the restored state.",
      parameters: {
        checkpointId: { type: "string", description: "Checkpoint ID (from checkpoint_save)", required: true },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        const checkpointId = String(params.checkpointId || "");
        if (!checkpointId) return { success: false, error: "checkpointId is required" };
        const checkpoint = await checkpointManager.restore(checkpointId);
        if (!checkpoint) return { success: false, error: `Checkpoint not found: ${checkpointId}` };
        return { success: true, checkpoint };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── checkpoint_list ─────────────────────────────────────────
  executor.registerTool(
    "checkpoint_list",
    {
      name: "checkpoint_list",
      description: "List saved checkpoints, optionally filtered by session ID. Returns array of {id, sessionId, createdAt, label?}.",
      parameters: {
        sessionId: { type: "string", description: "Optional session ID filter", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        const sessionId = params.sessionId ? String(params.sessionId) : undefined;
        const list = await checkpointManager.list(sessionId);
        return { success: true, checkpoints: list, count: list.length };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── dlq_retry_batch ─────────────────────────────────────────
  executor.registerTool(
    "dlq_retry_batch",
    {
      name: "dlq_retry_batch",
      description: "Batch retry dead-letter queue entries with concurrency limit, exponential backoff, and failure isolation. Each entry: {id, topic, payload, originalError?, failedAt, retryCount}. Returns stats: total, succeeded, failed, recovered[], stillFailed[].",
      parameters: {
        entries: { type: "array", description: "Array of DLQ entries to retry", required: true },
        maxConcurrency: { type: "number", description: "Max concurrent retries (default: 10)", required: false },
        maxRetries: { type: "number", description: "Max retries per entry (default: 3)", required: false },
        failFast: { type: "boolean", description: "Stop on first failure (default: false)", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      try {
        if (!deps.dlqHandler) {
          return { success: false, error: "DLQ retry handler not configured on server" };
        }
        const entries = Array.isArray(params.entries) ? (params.entries as DLQEntry[]) : [];
        if (entries.length === 0) return { success: false, error: "entries array is required" };
        const dlqRetry = new DLQClass(deps.dlqHandler, {
          maxConcurrency: params.maxConcurrency ? Number(params.maxConcurrency) : undefined,
          maxRetries: params.maxRetries ? Number(params.maxRetries) : undefined,
          failFast: params.failFast === true,
        });
        const result = await dlqRetry.retryAll(entries);
        return { success: true, ...result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
}
