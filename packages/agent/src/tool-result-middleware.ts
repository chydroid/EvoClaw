/**
 * ToolResultMiddleware — 工具结果后处理中间件
 *
 * 借鉴 hermes-agent hermes_cli/middleware.py + model_tools.py transform_tool_result：
 *
 * 核心机制：
 *   - 中间件契约：TOOL_EXECUTION_MIDDLEWARE 包装工具执行
 *   - transform_tool_result hook：在工具返回后、传给模型前执行
 *   - 可用于格式转换、敏感信息脱敏、结果验证
 *   - 多个中间件按顺序执行，第一个有效返回 wins
 *
 * 中间件类型：
 *   1. ToolRequestMiddleware — 工具调用前，可改写 args
 *   2. ToolExecutionMiddleware — 包装工具执行，可修改结果
 *   3. ToolResultTransform — 工具结果后处理（格式转换、脱敏等）
 *
 * 安全性：
 *   - 单次使用契约（重复调用抛 RuntimeError 等价）
 *   - deepcopy 失败回退到 shallow copy
 *   - _DownstreamExecutionError 错误传播
 */

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface ToolCallContext {
  /** 工具名称 */
  toolName: string;
  /** 工具调用 ID */
  toolCallId: string;
  /** 会话 ID */
  sessionId: string;
  /** Turn ID */
  turnId: string;
  /** 原始参数 */
  args: Record<string, unknown>;
}

export interface ToolResultContext extends ToolCallContext {
  /** 工具执行结果 */
  result: unknown;
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** 是否成功 */
  success: boolean;
  /** 错误信息（如果失败） */
  error?: string;
}

/** 工具请求中间件：工具调用前执行，可改写 args */
export type ToolRequestMiddleware = (
  ctx: ToolCallContext,
  next: (ctx: ToolCallContext) => Promise<ToolResultContext>,
) => Promise<ToolResultContext>;

/** 工具执行中间件：包装工具执行 */
export type ToolExecutionMiddleware = (
  ctx: ToolCallContext,
  next: (ctx: ToolCallContext) => Promise<ToolResultContext>,
) => Promise<ToolResultContext>;

/** 工具结果转换 hook */
export type ToolResultTransform = (
  ctx: ToolResultContext,
) => ToolResultContext | void;

/** 终端输出转换 hook */
export type TerminalOutputTransform = (
  output: string,
  ctx: ToolCallContext,
) => string | void;

export interface MiddlewareConfig {
  /** 启用请求中间件 */
  enableRequestMiddleware: boolean;
  /** 启用执行中间件 */
  enableExecutionMiddleware: boolean;
  /** 启用结果转换 */
  enableResultTransform: boolean;
  /** 启用终端输出转换 */
  enableTerminalOutputTransform: boolean;
}

export const DEFAULT_MIDDLEWARE_CONFIG: MiddlewareConfig = {
  enableRequestMiddleware: true,
  enableExecutionMiddleware: true,
  enableResultTransform: true,
  enableTerminalOutputTransform: true,
};

// ── 错误类 ──────────────────────────────────────────────────────────────────

/**
 * 下游执行错误。
 * 借鉴 hermes-agent _DownstreamExecutionError。
 */
export class DownstreamExecutionError extends Error {
  readonly index: number;
  readonly cause: Error;

  constructor(index: number, cause: Error) {
    super(`Middleware at index ${index} failed: ${cause.message}`);
    this.name = "DownstreamExecutionError";
    this.index = index;
    this.cause = cause;
  }
}

/**
 * 单次使用契约违规。
 * 借鉴 hermes-agent run_tool_execution_middleware 的单次使用契约。
 */
export class MiddlewareAlreadyConsumedError extends Error {
  constructor() {
    super("Middleware next() has already been consumed — each middleware may only call next() once");
    this.name = "MiddlewareAlreadyConsumedError";
  }
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 安全拷贝。
 * 借鉴 hermes-agent _safe_copy：deepcopy 失败回退到 shallow copy。
 */
function safeCopy<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    // deepcopy 失败，回退到 shallow copy
    if (Array.isArray(obj)) return [...obj] as unknown as T;
    return { ...obj };
  }
}

// ── 主类 ────────────────────────────────────────────────────────────────────

/**
 * 工具结果中间件管理器。
 *
 * 借鉴 hermes-agent hermes_cli/middleware.py。
 */
export class ToolResultMiddleware {
  private config: MiddlewareConfig;
  private requestMiddlewares: ToolRequestMiddleware[] = [];
  private executionMiddlewares: ToolExecutionMiddleware[] = [];
  private resultTransforms: ToolResultTransform[] = [];
  private terminalOutputTransforms: TerminalOutputTransform[] = [];

  constructor(config: Partial<MiddlewareConfig> = {}) {
    this.config = { ...DEFAULT_MIDDLEWARE_CONFIG, ...config };
  }

  /**
   * 注册请求中间件。
   */
  addRequestMiddleware(middleware: ToolRequestMiddleware): void {
    this.requestMiddlewares.push(middleware);
  }

  /**
   * 注册执行中间件。
   */
  addExecutionMiddleware(middleware: ToolExecutionMiddleware): void {
    this.executionMiddlewares.push(middleware);
  }

  /**
   * 注册结果转换 hook。
   * 借鉴 hermes-agent transform_tool_result hook。
   */
  addResultTransform(transform: ToolResultTransform): void {
    this.resultTransforms.push(transform);
  }

  /**
   * 注册终端输出转换 hook。
   * 借鉴 hermes-agent transform_terminal_output hook。
   */
  addTerminalOutputTransform(transform: TerminalOutputTransform): void {
    this.terminalOutputTransforms.push(transform);
  }

  /**
   * 执行工具调用，应用所有中间件。
   *
   * 借鉴 hermes-agent _run_execution_chain：
   *   1. 应用请求中间件（可改写 args）
   *   2. 应用执行中间件（包装执行）
   *   3. 应用结果转换
   *
   * @param ctx 工具调用上下文
   * @param executor 实际工具执行函数
   */
  async execute(
    ctx: ToolCallContext,
    executor: (ctx: ToolCallContext) => Promise<ToolResultContext>,
  ): Promise<ToolResultContext> {
    let currentCtx = ctx;

    // 1. 应用请求中间件（可改写 args）
    if (this.config.enableRequestMiddleware && this.requestMiddlewares.length > 0) {
      for (const mw of this.requestMiddlewares) {
        try {
          // 请求中间件可以修改 ctx，但不直接执行工具
          // 这里简化：只允许修改 args
          const modifiedCtx = { ...currentCtx, args: safeCopy(currentCtx.args) };
          // 中间件可以修改 modifiedCtx
          const result = await mw(modifiedCtx, async (innerCtx) => {
            currentCtx = innerCtx;
            return executor(innerCtx);
          });
          // 如果中间件返回了结果，直接使用
          if (result) return this.applyTransforms(result);
        } catch (err) {
          if (err instanceof DownstreamExecutionError) throw err;
          // 请求中间件失败，继续使用原 ctx
        }
      }
    }

    // 2. 应用执行中间件（包装执行）
    let result: ToolResultContext;
    if (this.config.enableExecutionMiddleware && this.executionMiddlewares.length > 0) {
      result = await this.runExecutionChain(currentCtx, executor, 0);
    } else {
      result = await executor(currentCtx);
    }

    // 3. 应用结果转换
    return this.applyTransforms(result);
  }

  /**
   * 递归执行中间件链。
   * 借鉴 hermes-agent _run_execution_chain。
   */
  private async runExecutionChain(
    ctx: ToolCallContext,
    finalExecutor: (ctx: ToolCallContext) => Promise<ToolResultContext>,
    index: number,
  ): Promise<ToolResultContext> {
    if (index >= this.executionMiddlewares.length) {
      return finalExecutor(ctx);
    }

    const middleware = this.executionMiddlewares[index];
    let consumed = false;

    try {
      return await middleware(ctx, async (innerCtx) => {
        if (consumed) {
          throw new MiddlewareAlreadyConsumedError();
        }
        consumed = true;
        return this.runExecutionChain(innerCtx, finalExecutor, index + 1);
      });
    } catch (err) {
      if (err instanceof DownstreamExecutionError) {
        throw err;
      }
      if (err instanceof MiddlewareAlreadyConsumedError) {
        throw err;
      }
      // 包装为下游执行错误
      throw new DownstreamExecutionError(index, err as Error);
    }
  }

  /**
   * 应用结果转换 hooks。
   * 借鉴 hermes-agent transform_tool_result：第一个有效返回 wins。
   */
  private applyTransforms(ctx: ToolResultContext): ToolResultContext {
    if (!this.config.enableResultTransform || this.resultTransforms.length === 0) {
      return ctx;
    }

    let current = ctx;

    // 终端输出特殊处理
    if (this.config.enableTerminalOutputTransform &&
        this.terminalOutputTransforms.length > 0 &&
        typeof current.result === "string" &&
        (current.toolName.includes("terminal") || current.toolName.includes("shell") ||
         current.toolName.includes("exec") || current.toolName.includes("bash"))) {
      let output = current.result as string;
      for (const transform of this.terminalOutputTransforms) {
        try {
          const transformed = transform(output, current);
          if (typeof transformed === "string") {
            output = transformed;
          }
        } catch {
          // 转换失败，跳过
        }
      }
      current = { ...current, result: output };
    }

    // 通用结果转换
    for (const transform of this.resultTransforms) {
      try {
        const transformed = transform(current);
        if (transformed) {
          // 第一个有效返回 wins
          current = transformed;
          break;
        }
      } catch {
        // 转换失败，跳过
      }
    }

    return current;
  }

  /**
   * 清除所有中间件。
   */
  clear(): void {
    this.requestMiddlewares = [];
    this.executionMiddlewares = [];
    this.resultTransforms = [];
    this.terminalOutputTransforms = [];
  }

  /**
   * 获取统计信息。
   */
  getStats(): {
    requestMiddlewares: number;
    executionMiddlewares: number;
    resultTransforms: number;
    terminalOutputTransforms: number;
  } {
    return {
      requestMiddlewares: this.requestMiddlewares.length,
      executionMiddlewares: this.executionMiddlewares.length,
      resultTransforms: this.resultTransforms.length,
      terminalOutputTransforms: this.terminalOutputTransforms.length,
    };
  }

  /**
   * 更新配置。
   */
  updateConfig(config: Partial<MiddlewareConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取配置。
   */
  getConfig(): MiddlewareConfig {
    return { ...this.config };
  }
}

// ── 内置转换器 ──────────────────────────────────────────────────────────────

/**
 * 敏感信息脱敏转换器。
 */
export function createRedactionTransform(
  patterns: Array<{ pattern: RegExp; replacement: string }>,
): ToolResultTransform {
  return (ctx: ToolResultContext): ToolResultContext | void => {
    if (typeof ctx.result !== "string") return;
    let result = ctx.result;
    for (const { pattern, replacement } of patterns) {
      result = result.replace(pattern, () => replacement);
    }
    return { ...ctx, result };
  };
}

/**
 * 结果大小限制转换器。
 */
export function createSizeLimitTransform(maxChars: number): ToolResultTransform {
  return (ctx: ToolResultContext): ToolResultContext | void => {
    if (typeof ctx.result !== "string") return;
    if (ctx.result.length <= maxChars) return;
    const truncated = ctx.result.slice(0, maxChars) +
      `\n... [truncated, ${ctx.result.length - maxChars} chars omitted]`;
    return { ...ctx, result: truncated };
  };
}

/**
 * JSON 格式化转换器。
 */
export function createJsonFormatTransform(): ToolResultTransform {
  return (ctx: ToolResultContext): ToolResultContext | void => {
    if (typeof ctx.result !== "string") return;
    try {
      const parsed = JSON.parse(ctx.result);
      return { ...ctx, result: JSON.stringify(parsed, null, 2) };
    } catch {
      return; // 不是 JSON，不转换
    }
  };
}

// ── 单例 ────────────────────────────────────────────────────────────────────

let singleton: ToolResultMiddleware | null = null;

export function getToolResultMiddleware(config?: Partial<MiddlewareConfig>): ToolResultMiddleware {
  if (!singleton) {
    singleton = new ToolResultMiddleware(config);
  } else if (config) {
    singleton.updateConfig(config);
  }
  return singleton;
}

export function resetToolResultMiddleware(): void {
  singleton = null;
}
