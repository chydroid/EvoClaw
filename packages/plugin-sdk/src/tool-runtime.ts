/**
 * Tool Runtime — 工具插件运行时上下文与注册辅助。
 *
 * 对标 OpenClaw `@openclaw/plugin-sdk/tool-runtime`。
 */
import type { PluginLogger, ServiceLocator } from "./types.js";
import type {
  ToolDefinition,
  ToolRequest,
  ToolResult,
  ToolPlugin,
} from "./tool.js";

// ── Runtime Context ──────────────────────────────────────────────────

/** 工具插件加载时收到的运行时上下文。 */
export interface ToolRuntimeContext {
  /** 工具名 */
  readonly toolName: string;
  /** 插件 logger */
  readonly logger: PluginLogger;
  /** 服务定位器 */
  readonly services: ServiceLocator;
  /** 工具配置（已合并默认值与用户配置） */
  readonly config: Readonly<Record<string, unknown>>;
  /** 请求审批的 API（requiresApproval=true 时使用） */
  readonly requestApproval?: (req: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
}

export interface ToolApprovalRequest {
  toolName: string;
  args: Record<string, unknown>;
  reason?: string;
}

export interface ToolApprovalDecision {
  approved: boolean;
  reason?: string;
}

// ── Registration ─────────────────────────────────────────────────────

/** 工具插件工厂签名。 */
export type ToolPluginFactory = (ctx: ToolRuntimeContext) => ToolRuntime | Promise<ToolRuntime>;

/** 已加载的工具运行时句柄。 */
export interface ToolRuntime {
  /** 工具定义 */
  readonly definition: ToolDefinition;
  /** 执行工具 */
  execute(request: ToolRequest): Promise<ToolResult>;
  /** 参数校验 */
  validate?(args: Record<string, unknown>): { valid: boolean; errors?: string[] };
  /** 健康检查 */
  healthCheck?(): Promise<{ healthy: boolean; detail?: string }>;
}

/**
 * 工具插件定义工厂。对标 OpenClaw `defineTool`。
 *
 * @example
 *   export default defineTool({
 *     definition: { name: "my_tool", description: "...", parameters: { ... } },
 *     async create(ctx) {
 *       return {
 *         definition: ctx.definition,
 *         async execute(req) { /* ... * / },
 *       };
 *     },
 *   });
 */
export function defineTool(spec: {
  definition: ToolDefinition;
  create: ToolPluginFactory;
}): { kind: "tool"; definition: ToolDefinition; create: ToolPluginFactory } {
  return {
    kind: "tool",
    definition: spec.definition,
    create: spec.create,
  };
}

// ── Re-exports ──────────────────────────────────────────────────────

export type {
  ToolDefinition,
  ToolRequest,
  ToolResult,
  ToolPlugin,
  ToolParameterSchema,
  ToolParameter,
  ToolCategory,
} from "./tool.js";
