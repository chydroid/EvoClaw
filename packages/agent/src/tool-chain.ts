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
      if (step.condition != null) {
        try {
          const condFn = new Function('prev', `return (${step.condition});`);
          const condResult = condFn(previousResult) as boolean;
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
}
