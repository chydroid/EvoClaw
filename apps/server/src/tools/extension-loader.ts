/**
 * Extension Loader — 将 plugin-sdk 的 ToolRuntime 桥接到 AgentModelExecutor。
 *
 * 对标 OpenClaw 的工具扩展注册流程：外部包通过 `defineTool()` 声明工具，
 * 通过 `package.json` 的 `evoclaw.extensions` 字段被发现（extension-registry），
 * 加载后由本模块桥接到 AgentModelExecutor.registerTool()，无需修改核心代码。
 *
 * 转换要点：
 *   - plugin-sdk ToolDefinition.parameters 是 JSON Schema 风格
 *     ({ type:"object", properties:{...}, required?:string[] })
 *   - agent ToolDefinition.parameters 是扁平 map
 *     ({ paramName: { type, description, required, ... } })
 *   - 需要将 required 数组展开到每个参数上
 *   - ToolRuntime.execute(request) → (params) => Promise<unknown> handler
 */
import type { AgentModelExecutor } from "@evoclaw/agent";
import type { ToolDefinition as AgentToolDefinition } from "@evoclaw/agent";
import type {
  ToolRuntime,
  ToolDefinition as SdkToolDefinition,
  ToolParameterSchema,
  ToolParameter,
  ToolRequest,
  ToolResult,
  ToolRuntimeContext,
} from "@evoclaw/plugin-sdk/tool-runtime";

// ── 类型守卫 ────────────────────────────────────────────────────────

/** defineTool() 返回的工具扩展声明形状。 */
interface ToolExtensionEntry {
  kind: "tool";
  definition: SdkToolDefinition;
  create: (ctx: ToolRuntimeContext) => ToolRuntime | Promise<ToolRuntime>;
}

/** 判断未知值是否为 ToolExtensionEntry。 */
function isToolExtensionEntry(v: unknown): v is ToolExtensionEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return e["kind"] === "tool"
    && typeof e["definition"] === "object" && e["definition"] !== null
    && typeof e["create"] === "function";
}

// ── 参数 Schema 转换 ─────────────────────────────────────────────────

/**
 * 将 plugin-sdk 的 ToolParameterSchema（JSON Schema 风格）转换为
 * agent ToolDefinition.parameters（扁平 map 风格）。
 *
 * agent 侧的每个参数条目形如：
 *   { type, description, required, default?, enum?, items?, properties? }
 */
export function convertToolParameters(
  sdkSchema: ToolParameterSchema,
): Record<string, unknown> {
  const requiredSet = new Set(sdkSchema.required ?? []);
  const result: Record<string, unknown> = {};

  for (const [name, param] of Object.entries(sdkSchema.properties)) {
    result[name] = convertToolParameter(param, requiredSet.has(name));
  }
  return result;
}

function convertToolParameter(param: ToolParameter, required: boolean): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: param.type,
    description: param.description ?? "",
    required,
  };
  if (param.enum !== undefined) entry["enum"] = param.enum;
  if (param.default !== undefined) entry["default"] = param.default;
  if (param.items !== undefined) {
    entry["items"] = param.items;
  }
  if (param.properties !== undefined) {
    entry["properties"] = param.properties;
  }
  return entry;
}

/**
 * 将 plugin-sdk 的 ToolDefinition 转换为 agent 的 ToolDefinition。
 */
export function convertToolDefinition(sdkDef: SdkToolDefinition): AgentToolDefinition {
  return {
    name: sdkDef.name,
    description: sdkDef.description,
    parameters: convertToolParameters(sdkDef.parameters),
  };
}

// ── 单个工具注册 ─────────────────────────────────────────────────────

export interface RegisterToolExtensionOptions {
  /** 审批 API（当工具 definition.requiresApproval=true 时调用） */
  requestApproval?: ToolRuntimeContext["requestApproval"];
  /** logger */
  logger?: { warn(msg: string): void };
}

/**
 * 将单个 ToolRuntime 桥接到 AgentModelExecutor.registerTool()。
 *
 * @param executor AgentModelExecutor 实例
 * @param runtime 已加载的 ToolRuntime（来自 defineTool 的 create 工厂）
 * @param opts 可选的审批与日志选项
 */
export function registerToolExtension(
  executor: AgentModelExecutor,
  runtime: ToolRuntime,
  opts?: RegisterToolExtensionOptions,
): void {
  const sdkDef = runtime.definition;
  const agentDef = convertToolDefinition(sdkDef);

  const handler = async (params: Record<string, unknown>): Promise<unknown> => {
    // 审批门：requiresApproval=true 且提供了 requestApproval 时拦截
    if (sdkDef.requiresApproval && opts?.requestApproval) {
      const decision = await opts.requestApproval({
        toolName: sdkDef.name,
        args: params,
        reason: `Tool ${sdkDef.name} requires approval before execution`,
      });
      if (!decision.approved) {
        const denied: ToolResult = {
          error: true,
          content: `Tool execution denied: ${decision.reason ?? "not approved"}`,
        };
        return denied;
      }
    }

    const request: ToolRequest = {
      tool: sdkDef.name,
      arguments: params,
    };

    const result = await runtime.execute(request);
    return result;
  };

  executor.registerTool(sdkDef.name, agentDef, handler);

  opts?.logger?.warn?.(`[extension-loader] registered tool extension: ${sdkDef.name}`);
}

/**
 * 批量注册 ToolRuntime。
 */
export function registerToolExtensions(
  executor: AgentModelExecutor,
  runtimes: ReadonlyArray<ToolRuntime>,
  opts?: RegisterToolExtensionOptions,
): void {
  for (const rt of runtimes) {
    registerToolExtension(executor, rt, opts);
  }
}

// ── 从 LoadedExtension 全流程加载 ────────────────────────────────────

/**
 * 从已加载的扩展入口中提取工具扩展声明列表。
 *
 * 支持两种入口形状：
 *   1. PluginEntry（含 tools 数组）：entry.tools = [ToolExtensionEntry, ...]
 *   2. 直接的单个 ToolExtensionEntry（entry.kind === "tool"）
 *
 * @returns 工具扩展声明列表（可能为空）
 */
export function extractToolEntries(entry: unknown): ToolExtensionEntry[] {
  if (!entry || typeof entry !== "object") return [];
  const e = entry as Record<string, unknown>;

  // 形状 2：直接是单个 tool entry
  if (isToolExtensionEntry(e)) {
    return [e];
  }

  // 形状 1：PluginEntry.tools 数组
  const tools = e["tools"];
  if (!Array.isArray(tools)) return [];

  const result: ToolExtensionEntry[] = [];
  for (const t of tools) {
    if (isToolExtensionEntry(t)) {
      result.push(t);
    }
  }
  return result;
}

/**
 * 构建一个最小的 ToolRuntimeContext。
 */
function buildRuntimeContext(
  toolName: string,
  packageName: string,
  opts?: RegisterToolExtensionOptions,
): ToolRuntimeContext {
  const log = (msg: string) => opts?.logger?.warn?.(msg);
  return {
    toolName,
    logger: {
      fatal: (msg: string) => log(msg),
      error: (msg: string) => log(msg),
      warn: (msg: string) => log(msg),
      info: () => {},
      debug: () => {},
      trace: () => {},
    },
    services: {
      get: () => undefined,
      register: () => {},
      has: () => false,
      list: () => [],
    },
    config: {},
    requestApproval: opts?.requestApproval,
  };
}

export interface LoadAndRegisterResult {
  /** 成功注册的工具数 */
  registered: number;
  /** 注册失败的工具及原因 */
  failed: Array<{ toolName: string; error: string }>;
}

/**
 * 全流程：从 LoadedExtension 列表中发现工具扩展、实例化、注册。
 *
 * @param executor AgentModelExecutor 实例
 * @param loadedEntries 已加载的扩展入口列表（任意形状）
 * @param opts 选项
 * @returns 注册结果统计
 */
export async function loadAndRegisterToolExtensions(
  executor: AgentModelExecutor,
  loadedEntries: ReadonlyArray<{ entry: unknown; packageName?: string }>,
  opts?: RegisterToolExtensionOptions,
): Promise<LoadAndRegisterResult> {
  let registered = 0;
  const failed: Array<{ toolName: string; error: string }> = [];

  for (const { entry, packageName } of loadedEntries) {
    const toolEntries = extractToolEntries(entry);
    for (const toolEntry of toolEntries) {
      const toolName = toolEntry.definition.name;
      try {
        const ctx = buildRuntimeContext(toolName, packageName ?? "unknown", opts);
        const runtime = await toolEntry.create(ctx);
        registerToolExtension(executor, runtime, opts);
        registered += 1;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        failed.push({ toolName, error: errorMsg });
        opts?.logger?.warn?.(
          `[extension-loader] failed to register tool "${toolName}": ${errorMsg}`,
        );
      }
    }
  }

  return { registered, failed };
}
