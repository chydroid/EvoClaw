/**
 * DelegateEngine — delegate_task 子代理执行引擎
 *
 * 对标 Hermes Agent `tools/delegate_tool.py`（891 行 + 9 个兄弟模块）的核心语义，
 * 用 EvoClaw 既有原语实现：
 *   - 独立子会话（`subsession_` 前缀 → 子预算 50，agent-model-executor 自动识别）
 *   - 批量并行派发（并发上限 max_concurrent_children，默认 10）
 *   - 后台派发（depth 0 顶层；结果在父会话下一个消息边界回投，between-turns 语义）
 *   - 深度限制（max_spawn_depth，默认 1 = flat；role 由深度派生，orchestrator/leaf）
 *   - output_schema 校验（先告知子代理契约，父侧校验，一次有界纠正重试）
 *   - action=list/steer/stop 实时控制（steer 经 SubagentRegistry.steerChannel 软转向）
 *
 * 与 Hermes 的差异（v1 明确取舍）：
 *   - steer 语义为「turn 间注入」而非「追加进下一轮 tool result」（chat() 是完整
 *     对话循环，无 tool-result 注入点；steer 消息作为新 turn 注入子会话）。
 *   - 子代理工具集不做按会话过滤（clarify/memory/cronjob 限制靠工具描述引导 +
 *     delegate 深度硬门禁；llm-caller 的按会话工具拦截留待后续）。
 *   - 子代理继承父模型（Hermes delegation.provider/model 路由不实现）。
 *   - 后台结果回投依赖父会话消息边界（takePendingResults），无消息即无回投。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { EventBus } from "@evoclaw/core";
import type {
  SubagentRegistry,
  SubagentSteerChannel,
  SubagentConfig,
} from "./subagent-registry";

// ─── 类型 ─────────────────────────────────────────────────────────────────────

/** 单个委派任务（对应 Hermes tasks[] 一项） */
export interface DelegateTaskItem {
  /** 子代理要完成的目标（必填，自包含） */
  goal: string;
  /** 该子代理需要的背景（文件路径、报错、约束；各子代理只见自己的 context） */
  context?: string;
  /** 子代理最终回答必须满足的 JSON Schema（可选） */
  output_schema?: Record<string, unknown>;
}

/** 深度派生角色：orchestrator 可继续委派，leaf 不可 */
export type DelegateRole = "orchestrator" | "leaf";

/** 运行终态（对齐 Hermes exit_reason 的子集） */
export type DelegateRunStatus = "running" | "completed" | "error" | "interrupted";

/** 单个子代理运行结果 */
export interface DelegateRunResult {
  /** 运行 ID（= SubagentRegistry 的 subagent ID） */
  id: string;
  goal: string;
  role: DelegateRole;
  status: DelegateRunStatus;
  /** 子代理最终总结（自述，未经父代理核实） */
  summary: string;
  /** output_schema 校验结果（未提供 schema 时为 undefined） */
  schema_valid?: boolean;
  schema_errors?: string[];
  durationMs: number;
  tokensUsed: number;
  error?: string;
  /** 子会话 ID（subsession_ 前缀） */
  sessionId: string;
}

/** 派发响应中的运行摘要 */
export interface DelegateRunSummary {
  id: string;
  goal: string;
  role: DelegateRole;
  status: DelegateRunStatus;
}

/** spawn 的返回值：前台带 results，后台返回 dispatch 句柄 */
export interface DelegateDispatchResult {
  status: "dispatched" | "completed";
  runs: DelegateRunSummary[];
  /** 前台模式才有：完整运行结果 */
  results?: DelegateRunResult[];
  /** 后台模式提示 */
  note?: string;
}

/** 引擎配置（默认值对齐 Hermes delegate_tool_config.py） */
export interface DelegateEngineConfig {
  /** 单用户并发子代理上限（Hermes delegation.max_concurrent_children，默认 10） */
  maxConcurrentChildren?: number;
  /** 委派深度上限（Hermes delegation.max_spawn_depth，默认 1 = flat） */
  maxSpawnDepth?: number;
  /** orchestrator 角色是否可用（Hermes delegation.orchestrator_enabled，默认 true） */
  orchestratorEnabled?: boolean;
}

/** 引擎依赖（executor 用最小接口，便于测试注入） */
export interface DelegateEngineDeps {
  /** AgentModelExecutor 的最小执行面：chat + abortSession */
  executor: DelegateExecutorLike;
  eventBus: EventBus;
  subagentRegistry: SubagentRegistry;
  config?: DelegateEngineConfig;
  /** 子代理工作目录（默认 process.cwd()） */
  workspace?: string;
}

/** AgentModelExecutor 的最小执行面 */
export interface DelegateExecutorLike {
  chat(
    message: string,
    context?: Record<string, unknown>,
  ): Promise<{ reply: string; tokensUsed: number }>;
  abortSession(sessionId: string): void;
}

/** 后台结果回投回调（服务器接线：日志/监控；消息边界回投走 takePendingResults） */
export type DelegateResultDeliver = (
  parentSessionId: string | undefined,
  results: DelegateRunResult[],
) => void | Promise<void>;

// ─── ALS 会话上下文 ──────────────────────────────────────────────────────────

interface DelegateCtx {
  sessionId: string;
  /** 当前会话的委派深度（顶层会话由 withSession 注入 0；子会话 = 父深度 + 1） */
  depth: number;
}

// ─── 运行记录（引擎内部） ────────────────────────────────────────────────────

interface DelegateRunRecord {
  id: string;
  goal: string;
  role: DelegateRole;
  status: DelegateRunStatus;
  sessionId: string;
  parentSessionId: string | undefined;
  startedAt: number;
  /** stop 请求标记（stopRun 设置；executeChild 在 catch/收尾处检查以区分 interrupted） */
  stopRequested: boolean;
  result?: DelegateRunResult;
}

/** prepareRun 产出的预建运行（spawn 同步返回句柄用，executeChild 消费） */
interface PreparedRun {
  record: DelegateRunRecord;
  childSessionId: string;
  role: DelegateRole;
  depth: number;
  steerQueue: string[];
  steerChannel: SubagentSteerChannel;
}

// ─── 输出契约校验（精简 JSON Schema 子集，与 structured-output.validateValue 同语义） ──

interface SchemaValidationOutcome {
  valid: boolean;
  errors: string[];
  parsed?: unknown;
}

function checkJsonType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "null": return value === null;
    default: return true;
  }
}

function validateSchemaValue(value: unknown, schema: Record<string, unknown>, path: string, errors: string[]): void {
  const schemaType = schema["type"] as string | undefined;
  if (schemaType && !checkJsonType(value, schemaType)) {
    errors.push(`At ${path}: expected type "${schemaType}", got "${typeof value}"`);
    return;
  }
  const enumValues = schema["enum"] as unknown[] | undefined;
  if (enumValues && !enumValues.includes(value)) {
    errors.push(`At ${path}: value ${JSON.stringify(value)} not in enum`);
    return;
  }
  if (typeof value === "number") {
    const minimum = schema["minimum"] as number | undefined;
    const maximum = schema["maximum"] as number | undefined;
    if (minimum !== undefined && value < minimum) errors.push(`At ${path}: ${value} < minimum ${minimum}`);
    if (maximum !== undefined && value > maximum) errors.push(`At ${path}: ${value} > maximum ${maximum}`);
  }
  if (typeof value === "string") {
    const minLength = schema["minLength"] as number | undefined;
    const maxLength = schema["maxLength"] as number | undefined;
    if (minLength !== undefined && value.length < minLength) errors.push(`At ${path}: length < minLength ${minLength}`);
    if (maxLength !== undefined && value.length > maxLength) errors.push(`At ${path}: length > maxLength ${maxLength}`);
  }
  if (schemaType === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const properties = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
    const required = schema["required"] as string[] | undefined;
    if (required) {
      for (const reqField of required) {
        if (!(reqField in obj)) errors.push(`At ${path}: missing required field "${reqField}"`);
      }
    }
    if (properties) {
      for (const [propName, propSchema] of Object.entries(properties)) {
        if (propName in obj) validateSchemaValue(obj[propName], propSchema, `${path}.${propName}`, errors);
      }
    }
  }
  if (schemaType === "array" && Array.isArray(value)) {
    const items = schema["items"] as Record<string, unknown> | undefined;
    if (items) {
      value.forEach((v, i) => validateSchemaValue(v, items, `${path}[${i}]`, errors));
    }
  }
}

/** 从子代理回答中容错提取 JSON（直接解析 → 首个平衡 {...} 子串） */
function extractJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // 继续尝试平衡括号子串
  }
  const start = trimmed.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** 用 JSON Schema 校验子代理回答（Hermes _validate_child_output_schema 的精简版） */
export function validateAgainstSchema(text: string, schema: Record<string, unknown>): SchemaValidationOutcome {
  const parsed = extractJson(text);
  if (parsed === undefined) {
    return { valid: false, errors: ["输出不是可解析的 JSON"] };
  }
  const errors: string[] = [];
  validateSchemaValue(parsed, schema, "$", errors);
  return { valid: errors.length === 0, errors, parsed };
}

// ─── 子代理 prompt 构建 ───────────────────────────────────────────────────────

function buildChildPrompt(item: DelegateTaskItem, role: DelegateRole): string {
  const lines: string[] = [
    "你是 EvoClaw 的子代理（由 delegate_task 派生），拥有独立会话与工具集。",
    "- 只返回最终总结，不要复述本指令；你无法与用户直接交互，遇到歧义按最合理假设推进。",
  ];
  if (role === "orchestrator") {
    lines.push("- 你可以继续调用 delegate_task 把更小的子任务委派出去（深度预算内）。");
  } else {
    lines.push("- 你不得调用 delegate_task 继续委派。");
  }
  lines.push("");
  lines.push("【目标】");
  lines.push(item.goal);
  if (item.context && item.context.trim()) {
    lines.push("");
    lines.push("【背景上下文】");
    lines.push(item.context);
  }
  if (item.output_schema) {
    lines.push("");
    lines.push("【输出契约】");
    lines.push("你的最终回答必须是符合以下 JSON Schema 的 JSON 对象，直接输出该 JSON，不要额外文字：");
    lines.push(JSON.stringify(item.output_schema));
  }
  return lines.join("\n");
}

// ─── DelegateEngine ────────────────────────────────────────────────────────────

export class DelegateEngine {
  private config: Required<DelegateEngineConfig>;
  private readonly als = new AsyncLocalStorage<DelegateCtx>();
  private seq = 0;
  private runs = new Map<string, DelegateRunRecord>();
  /** 父会话 → 已完成但尚未回投的后台结果（服务器消息边界取用） */
  private pendingResults = new Map<string, DelegateRunResult[]>();
  private resultDeliver: DelegateResultDeliver | undefined;
  private readonly workspace: string;

  constructor(private deps: DelegateEngineDeps) {
    this.config = {
      maxConcurrentChildren: deps.config?.maxConcurrentChildren ?? 10,
      maxSpawnDepth: deps.config?.maxSpawnDepth ?? 1,
      orchestratorEnabled: deps.config?.orchestratorEnabled ?? true,
    };
    this.workspace = deps.workspace ?? process.cwd();
  }

  // ─── 会话上下文（ALS） ──────────────────────────────────────────────────────

  /**
   * 把主会话 chat() 调用包进 ALS 上下文，使工具处理器（含 delegate_task）
   * 能读到真实 sessionId 与委派深度。服务器在 channel/web/a2a/room 消息入口接线。
   */
  withSession<T>(sessionId: string, fn: () => T | Promise<T>): T | Promise<T> {
    return this.als.run({ sessionId, depth: 0 }, fn);
  }

  /** 当前异步调用链的委派上下文（顶层无 ALS store 时返回 undefined） */
  getCurrentContext(): { sessionId?: string; depth: number } | undefined {
    return this.als.getStore();
  }

  /** 当前会话是否允许委派（深度门禁 + orchestrator 开关） */
  canDelegate(): boolean {
    const depth = this.als.getStore()?.depth ?? 0;
    return this.config.orchestratorEnabled && depth < this.config.maxSpawnDepth;
  }

  /** 当前深度（无上下文视为 0） */
  currentDepth(): number {
    return this.als.getStore()?.depth ?? 0;
  }

  /** 委派深度上限（工具描述动态注入用） */
  get maxSpawnDepth(): number {
    return this.config.maxSpawnDepth;
  }

  /** 并发子代理上限（工具描述动态注入用） */
  get maxConcurrentChildren(): number {
    return this.config.maxConcurrentChildren;
  }

  /** orchestrator 开关（工具描述动态注入用） */
  get orchestratorEnabled(): boolean {
    return this.config.orchestratorEnabled;
  }

  // ─── 派发 ───────────────────────────────────────────────────────────────────

  /**
   * 派发子代理：单 goal 或批量 tasks。
   * - 前台：并行执行并等待全部完成，返回完整 results。
   * - 后台（仅 depth 0 顶层）：立即返回 dispatch 句柄，结果在父会话下一个
   *   消息边界回投（Hermes between-turns 语义的 EvoClaw 实现）。
   * orchestrator 子代理（depth > 0）强制前台执行——它需要在本 turn 内拿到结果。
   */
  async spawn(items: DelegateTaskItem[], opts?: { background?: boolean; parentSessionId?: string }): Promise<DelegateDispatchResult> {
    const normalized = items.map((item, i) => {
      if (!item.goal || typeof item.goal !== "string" || !item.goal.trim()) {
        throw new Error(`tasks[${i}].goal is required and must be a non-empty string`);
      }
      return {
        goal: item.goal,
        context: typeof item.context === "string" ? item.context : undefined,
        output_schema: item.output_schema && typeof item.output_schema === "object" ? item.output_schema : undefined,
      };
    });
    if (normalized.length === 0) {
      throw new Error("delegate_task requires at least one task");
    }

    const depth = this.currentDepth();
    if (!this.canDelegate()) {
      throw new Error(
        `Delegation depth limit reached (depth=${depth}, max_spawn_depth=${this.config.maxSpawnDepth}). ` +
          "Children at the depth floor cannot spawn further subagents.",
      );
    }

    const parentSessionId = this.als.getStore()?.sessionId ?? opts?.parentSessionId;
    // background 只对顶层（depth 0）生效；orchestrator 子代理强制前台（对齐
    // Hermes _model_background_value：depth > 0 的子代理需要在本 turn 内拿到结果）
    const background = opts?.background === true && depth === 0;

    if (background) {
      const summaries: DelegateRunSummary[] = [];
      for (const item of normalized) {
        const prepared = this.prepareRun(item, depth, parentSessionId);
        summaries.push(this.toSummary(prepared.record));
        // 后台执行：不 await；executeChild 内部捕获全部异常，此处仅防御性挂载
        void this.executeChild(prepared, item).catch((err) => {
          process.stderr.write(
            `[DelegateEngine] background child failed unexpectedly: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        });
      }
      return {
        status: "dispatched",
        runs: summaries,
        note:
          "Children are running in the background. Results will re-enter as a new message when they finish; " +
          "use action=list to check status, action=steer/stop to control them. Do not poll transcripts or artifacts.",
      };
    }

    const results = await this.mapWithConcurrency(normalized, this.config.maxConcurrentChildren, async (item) => {
      const prepared = this.prepareRun(item, depth, parentSessionId);
      return this.executeChild(prepared, item);
    });
    return {
      status: "completed",
      runs: results.map((r) => ({ id: r.id, goal: r.goal, role: r.role, status: r.status })),
      results,
    };
  }

  /** 预建运行记录 + registry spawn + steerChannel（spawn 句柄与 executeChild 的单一事实源） */
  private prepareRun(item: DelegateTaskItem, depth: number, parentSessionId: string | undefined): PreparedRun {
    const childSessionId = `subsession_delegate-${Date.now()}-${++this.seq}`;
    const role: DelegateRole = depth + 1 < this.config.maxSpawnDepth ? "orchestrator" : "leaf";
    const steerQueue: string[] = [];
    const prepared: PreparedRun = {
      record: undefined as unknown as DelegateRunRecord,
      childSessionId,
      role,
      depth,
      steerQueue,
      steerChannel: undefined as unknown as SubagentSteerChannel,
    };
    prepared.steerChannel = {
      push: (instruction: string) => {
        steerQueue.push(instruction);
      },
      abort: () => {
        prepared.record.stopRequested = true;
      },
    };
    const info = this.deps.subagentRegistry.spawn({
      parentAgentId: parentSessionId ?? "delegate-parent",
      sessionId: childSessionId,
      workspace: this.workspace,
      // 子代理工具集不做按会话过滤（见模块头差异说明）；策略仅登记为元数据
      toolPolicy: { mode: "denylist", tools: [] },
      label: item.goal.slice(0, 80),
      steerChannel: prepared.steerChannel,
    });
    prepared.record = {
      id: info.id,
      goal: item.goal,
      role,
      status: "running",
      sessionId: childSessionId,
      parentSessionId,
      startedAt: Date.now(),
      stopRequested: false,
    };
    this.runs.set(prepared.record.id, prepared.record);
    this.emit("spawn", { event: "spawn", run: prepared.record, timestamp: new Date().toISOString() });
    return prepared;
  }

  /**
   * 执行单个子代理：
   *   1. ALS 包裹 executor.chat()（子会话隔离 + 深度上下文）
   *   2. steer 队列 drain（turn 间注入，v1 语义）
   *   3. output_schema 校验 + 一次有界纠正重试
   *   4. markDone / markError / kill + 事件 + 后台结果回投
   */
  private async executeChild(prepared: PreparedRun, item: DelegateTaskItem): Promise<DelegateRunResult> {
    const { record, childSessionId, role, steerQueue } = prepared;

    let reply = "";
    let tokensUsed = 0;
    let status: DelegateRunStatus = "completed";
    let error: string | undefined;
    let schemaValid: boolean | undefined;
    let schemaErrors: string[] | undefined;
    const start = Date.now();
    const childCtx: DelegateCtx = { sessionId: childSessionId, depth: prepared.depth + 1 };

    try {
      const prompt = buildChildPrompt(item, role);
      const res = await this.als.run(childCtx, () =>
        this.deps.executor.chat(prompt, { sessionId: childSessionId, channel: "delegate", peerId: "parent" }),
      );
      reply = res.reply ?? "";
      tokensUsed += res.tokensUsed ?? 0;

      // ── steer 队列 drain：steer 消息作为新 turn 注入（turn 间语义，v1）──
      let steerGuard = 0;
      while (steerQueue.length > 0 && !record.stopRequested && steerGuard++ < 5) {
        const instruction = steerQueue.splice(0).join("\n\n");
        const steered = await this.als.run(childCtx, () =>
          this.deps.executor.chat(
            `【实时指令（steer）】${instruction}\n\n请在此基础上继续完成原始目标，并更新你的最终输出。`,
            { sessionId: childSessionId, channel: "delegate", peerId: "parent" },
          ),
        );
        reply = steered.reply ?? reply;
        tokensUsed += steered.tokensUsed ?? 0;
      }

      // ── output_schema 校验 + 一次有界纠正重试（Hermes parent-validates-with-one-retry）──
      if (item.output_schema) {
        let outcome = validateAgainstSchema(reply, item.output_schema);
        if (!outcome.valid && !record.stopRequested) {
          const fixed = await this.als.run(childCtx, () =>
            this.deps.executor.chat(
              `你上一轮的输出不符合输出契约：\n- ${outcome.errors.join("\n- ")}\n\n请只输出严格符合契约的 JSON 对象，不要额外文字。`,
              { sessionId: childSessionId, channel: "delegate", peerId: "parent" },
            ),
          );
          reply = fixed.reply ?? reply;
          tokensUsed += fixed.tokensUsed ?? 0;
          outcome = validateAgainstSchema(reply, item.output_schema);
        }
        schemaValid = outcome.valid;
        schemaErrors = outcome.valid ? undefined : outcome.errors;
      }
    } catch (err) {
      if (record.stopRequested) {
        status = "interrupted";
      } else {
        status = "error";
        error = err instanceof Error ? err.message : String(err);
      }
    }

    if (record.stopRequested && status === "completed") {
      status = "interrupted";
    }

    const result: DelegateRunResult = {
      id: record.id,
      goal: item.goal,
      role,
      status,
      summary: reply,
      schema_valid: schemaValid,
      schema_errors: schemaErrors,
      durationMs: Date.now() - start,
      tokensUsed,
      error,
      sessionId: childSessionId,
    };
    record.status = status;
    record.result = result;

    if (status === "completed") {
      this.deps.subagentRegistry.markDone(record.id);
    } else if (status === "error") {
      this.deps.subagentRegistry.markError(record.id, error ?? "unknown error");
    } else {
      this.deps.subagentRegistry.kill(record.id);
    }

    this.emit(status === "completed" ? "complete" : status === "error" ? "error" : "stop", {
      event: status,
      run: record,
      timestamp: new Date().toISOString(),
    });

    // ── 后台结果回投：暂存待父会话消息边界取用（takePendingResults）──
    if (record.parentSessionId) {
      const arr = this.pendingResults.get(record.parentSessionId) ?? [];
      arr.push(result);
      this.pendingResults.set(record.parentSessionId, arr);
    }
    if (this.resultDeliver) {
      void this.resultDeliver(record.parentSessionId, [result]);
    }

    return result;
  }

  // ─── 控制动作（action=list/steer/stop） ────────────────────────────────────

  /** 列出运行（可按父会话过滤），新到旧排序 */
  listRuns(filter?: { parentSessionId?: string }): DelegateRunSummary[] {
    const filtered =
      filter?.parentSessionId !== undefined
        ? Array.from(this.runs.values()).filter((r) => r.parentSessionId === filter.parentSessionId)
        : Array.from(this.runs.values());
    return filtered
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => this.toSummary(r));
  }

  /** 完整运行结果（供 list 详情用） */
  getRun(id: string): DelegateRunResult | undefined {
    return this.runs.get(id)?.result;
  }

  /** stop：中止子代理当前 turn（部分输出仍返回）；返回是否命中运行中的子代理 */
  stopRun(id: string): boolean {
    const record = this.runs.get(id);
    if (!record || record.status !== "running") return false;
    record.stopRequested = true;
    this.deps.executor.abortSession(record.sessionId);
    this.emit("stop", { event: "stop", run: record, timestamp: new Date().toISOString() });
    return true;
  }

  /** steer：向运行中的子代理软注入实时指令（不中止当前 turn，turn 间生效） */
  steerRun(id: string, message: string): boolean {
    const record = this.runs.get(id);
    if (!record || record.status !== "running") return false;
    return this.deps.subagentRegistry.steer(id, message);
  }

  // ─── 后台结果回投接口（服务器接线） ─────────────────────────────────────────

  /** 注册后台结果回投回调（可选；服务器用于日志/监控） */
  setResultDeliver(deliver: DelegateResultDeliver | undefined): void {
    this.resultDeliver = deliver;
  }

  /**
   * 取走指定父会话的待回投结果（服务器在消息边界调用：channel/web/room handler
   * 在拼装 chat 输入前 prepend 结果文本）。返回空数组表示无积压。
   */
  takePendingResults(parentSessionId: string): DelegateRunResult[] {
    const arr = this.pendingResults.get(parentSessionId);
    if (!arr || arr.length === 0) return [];
    this.pendingResults.delete(parentSessionId);
    return arr;
  }

  // ─── 并发工具 ──────────────────────────────────────────────────────────────

  /** 有界并发 map（滑动窗口语义：最多 limit 个 fn 同时在飞） */
  private async mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(limit, items.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await fn(items[i]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  // ─── 内部 ──────────────────────────────────────────────────────────────────

  private toSummary(record: DelegateRunRecord): DelegateRunSummary {
    return {
      id: record.id,
      goal: record.goal,
      role: record.role,
      status: record.status,
    };
  }

  private emit(event: "spawn" | "complete" | "error" | "stop", payload: Record<string, unknown>): void {
    void this.deps.eventBus
      .publish(`delegate.${event}`, payload, "delegate-engine")
      .catch((err) => {
        process.stderr.write(
          `[DelegateEngine] EventBus publish failed for "${event}": ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
  }
}
