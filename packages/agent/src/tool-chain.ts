/**
 * Declarative tool chains — predefined sequences of tool calls executed as a unit.
 */

export interface ToolChainStep {
  tool: string;
  params: Record<string, unknown>;
  /** Map output from previous step to this step's params. Key=param name, Value=JSONPath expression on previous result */
  mapFromPrevious?: Record<string, string>;
  /** Optional condition: JS expression evaluated with previous result. If false, skip this step */
  condition?: string;
  /** Timeout in ms (default: 30000) */
  timeoutMs?: number;
}

export interface ToolChainDefinition {
  name: string;
  description: string;
  steps: ToolChainStep[];
  /** Whether to stop on error (default: true) */
  stopOnError?: boolean;
}

export interface ToolChainStepResult {
  tool: string;
  success: boolean;
  result: unknown;
  duration: number;
  skipped: boolean;
  error?: string;
}

export interface ToolChainResult {
  chainName: string;
  success: boolean;
  steps: ToolChainStepResult[];
  totalDuration: number;
  finalResult: unknown;
}

export type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;

export class ToolChainExecutor {
  constructor(
    private readonly toolRegistry: Map<string, { handler: ToolHandler }>,
  ) {}

  async execute(
    chain: ToolChainDefinition,
    initialParams?: Record<string, unknown>,
  ): Promise<ToolChainResult> {
    const startTime = Date.now();
    const stepResults: ToolChainStepResult[] = [];
    let previousResult: unknown = initialParams ?? null;
    let lastSuccessfulResult: unknown = undefined;
    let chainSuccess = true;
    const stopOnError = chain.stopOnError ?? true;

    for (const step of chain.steps) {
      const stepStart = Date.now();

      // Resolve params: merge static params with mapped params from previous step
      const resolvedParams = { ...step.params };
      if (step.mapFromPrevious && previousResult != null) {
        const mapped = this.resolveParamMapping(previousResult, step.mapFromPrevious);
        for (const [key, value] of Object.entries(mapped)) {
          resolvedParams[key] = value;
        }
      }

      // Check condition — skip if false
      // 安全：使用受限表达式求值器替代 new Function，防止代码注入。
      // 仅支持 prev.xxx / prev.xxx.yyy 属性访问 + ==/!=/&&/||/!</>/>=/<= 比较 + 字面量。
      if (step.condition != null) {
        try {
          const condResult = this.evaluateCondition(step.condition, previousResult);
          if (!condResult) {
            stepResults.push({
              tool: step.tool,
              success: true,
              result: null,
              duration: Date.now() - stepStart,
              skipped: true,
            });
            continue;
          }
        } catch {
          stepResults.push({
            tool: step.tool,
            success: false,
            result: null,
            duration: Date.now() - stepStart,
            skipped: false,
            error: `Condition evaluation failed: ${step.condition}`,
          });
          if (stopOnError) {
            chainSuccess = false;
            break;
          }
          continue;
        }
      }

      // Execute tool
      const toolEntry = this.toolRegistry.get(step.tool);
      if (!toolEntry) {
        stepResults.push({
          tool: step.tool,
          success: false,
          result: null,
          duration: Date.now() - stepStart,
          skipped: false,
          error: `Tool not found: ${step.tool}`,
        });
        if (stopOnError) {
          chainSuccess = false;
          break;
        }
        continue;
      }

      const timeoutMs = step.timeoutMs ?? 30000;
      try {
        const result = await this.executeWithTimeout(
          toolEntry.handler,
          resolvedParams,
          timeoutMs,
        );
        previousResult = result;
        lastSuccessfulResult = result;
        stepResults.push({
          tool: step.tool,
          success: true,
          result,
          duration: Date.now() - stepStart,
          skipped: false,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        stepResults.push({
          tool: step.tool,
          success: false,
          result: null,
          duration: Date.now() - stepStart,
          skipped: false,
          error: errorMsg,
        });
        if (stopOnError) {
          chainSuccess = false;
          break;
        }
      }
    }

    return {
      chainName: chain.name,
      success: chainSuccess,
      steps: stepResults,
      totalDuration: Date.now() - startTime,
      finalResult: lastSuccessfulResult,
    };
  }

  /**
   * Simple JSONPath-like resolution:
   * - "$.result"       → previousResult.result
   * - "$.data.items[0]" → previousResult.data.items[0]
   * - "$.content"      → previousResult.content
   * - Fallback: return the mapping value as-is if path not found
   */
  resolveParamMapping(
    previousResult: unknown,
    mapping: Record<string, string>,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [paramName, pathExpr] of Object.entries(mapping)) {
      if (!pathExpr.startsWith('$.')) {
        resolved[paramName] = pathExpr;
        continue;
      }

      const pathParts = pathExpr.slice(2).split(/\.|\[(\d+)\]/).filter(Boolean);
      let current: unknown = previousResult;

      let found = true;
      for (const part of pathParts) {
        if (current == null || typeof current !== 'object') {
          found = false;
          break;
        }
        current = (current as Record<string, unknown>)[part];
      }

      resolved[paramName] = found ? current : pathExpr;
    }

    return resolved;
  }

  private executeWithTimeout(
    handler: ToolHandler,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Tool execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      handler(params)
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /**
   * 受限条件表达式求值器（替代 new Function / eval，防止代码注入）。
   *
   * 支持的语法子集：
   * - prev  → 前一步结果
   * - prev.xxx / prev.xxx.yyy → 属性访问
   * - prev.xxx == value / != / > / < / >= / <= → 比较
   * - expr && expr / expr || expr / !expr → 逻辑组合
   * - 字面量: 数字 / 字符串(单引号) / true / false / null
   *
   * 不支持: 函数调用、new、赋值、require、process 等。
   * 遇到不支持的语法抛 Error（被外层 catch 捕获）。
   */
  private evaluateCondition(expr: string, prev: unknown): boolean {
    const trimmed = expr.trim();
    if (trimmed.length === 0) return true;
    // 安全：拒绝任何危险关键字
    if (/\b(require|process|global|globalThis|eval|Function|constructor|prototype|__proto__|window|document|import|export|new\s+)\b/.test(trimmed)) {
      throw new Error(`Condition contains forbidden keyword: ${expr}`);
    }
    // 递归处理 || 和 && 和 !
    return this.evalOrExpr(trimmed, prev);
  }

  private evalOrExpr(expr: string, prev: unknown): boolean {
    const parts = this.splitTopLevel(expr, "||");
    if (parts.length > 1) {
      return parts.some((p) => this.evalAndExpr(p.trim(), prev));
    }
    return this.evalAndExpr(expr, prev);
  }

  private evalAndExpr(expr: string, prev: unknown): boolean {
    const parts = this.splitTopLevel(expr, "&&");
    if (parts.length > 1) {
      return parts.every((p) => this.evalNotExpr(p.trim(), prev));
    }
    return this.evalNotExpr(expr, prev);
  }

  private evalNotExpr(expr: string, prev: unknown): boolean {
    const trimmed = expr.trim();
    if (trimmed.startsWith("!")) {
      return !this.evalNotExpr(trimmed.slice(1), prev);
    }
    return this.evalComparison(trimmed, prev);
  }

  private evalComparison(expr: string, prev: unknown): boolean {
    const trimmed = expr.trim();
    // 括号包裹
    if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
      return this.evalOrExpr(trimmed.slice(1, -1), prev);
    }
    // 比较操作符
    const ops = ["===", "!==", "==", "!=", ">=", "<=", ">", "<"];
    for (const op of ops) {
      const idx = this.findTopLevelOp(trimmed, op);
      if (idx !== -1) {
        const left = this.evalValue(trimmed.slice(0, idx).trim(), prev);
        const right = this.evalValue(trimmed.slice(idx + op.length).trim(), prev);
        switch (op) {
          case "===": return left === right;
          case "!==": return left !== right;
          case "==": return left == right; // eslint-disable-line eqeqeq
          case "!=": return left != right; // eslint-disable-line eqeqeq
          case ">=": return (left as number) >= (right as number);
          case "<=": return (left as number) <= (right as number);
          case ">": return (left as number) > (right as number);
          case "<": return (left as number) < (right as number);
        }
      }
    }
    // 无操作符：取真值
    const val = this.evalValue(trimmed, prev);
    return !!val;
  }

  /** 求值单个值（prev.xxx 路径或字面量） */
  private evalValue(expr: string, prev: unknown): unknown {
    const trimmed = expr.trim();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed === "null") return null;
    if (trimmed === "undefined") return undefined;
    // 数字
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    // 字符串字面量（单引号或双引号）
    if (/^['"].*['"]$/.test(trimmed)) return trimmed.slice(1, -1);
    // prev.xxx.yyy 路径访问
    if (trimmed === "prev") return prev;
    if (trimmed.startsWith("prev.")) {
      const path = trimmed.slice(5).split(".");
      let current: unknown = prev;
      for (const key of path) {
        if (current == null || typeof current !== "object") return undefined;
        current = (current as Record<string, unknown>)[key];
      }
      return current;
    }
    throw new Error(`Unsupported value expression: ${expr}`);
  }

  /** 在顶层（不在括号或引号内）查找操作符位置 */
  private findTopLevelOp(expr: string, op: string): number {
    let depth = 0;
    let inStr: string | null = null;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (inStr) {
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === "'" || ch === '"') { inStr = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 0 && expr.substring(i, i + op.length) === op) {
        // 避免 == 匹配到 === 的前缀
        if ((op === "==" || op === "!=") && expr[i + 2] === "=") continue;
        return i;
      }
    }
    return -1;
  }

  /** 在顶层（不在括号或引号内）按分隔符拆分 */
  private splitTopLevel(expr: string, sep: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let inStr: string | null = null;
    let start = 0;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (inStr) {
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === "'" || ch === '"') { inStr = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 0 && expr.substring(i, i + sep.length) === sep) {
        parts.push(expr.slice(start, i));
        start = i + sep.length;
      }
    }
    parts.push(expr.slice(start));
    return parts;
  }
}
