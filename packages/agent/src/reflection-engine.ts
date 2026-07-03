// reflection-engine.ts — Reflect→Replan mechanism for the EvoClaw agent

export interface ToolExecutionTrace {
  toolName: string;
  params: Record<string, unknown>;
  result: unknown;
  success: boolean;
  duration: number;
  timestamp: number;
  error?: string;
}

export interface ReflectionResult {
  shouldContinue: boolean;
  shouldReplan: boolean;
  shouldRetry: boolean;
  retrySuggestion?: string;
  analysis: string;
  nextStepSuggestion?: string;
  confidence: number;
}

export interface ReflectionConfig {
  enabled: boolean;
  reflectAfterNTools: number;
  reflectOnFailure: boolean;
  maxReflections: number;
  confidenceThreshold: number;
  /** 启用自适应反思频率（根据错误率动态调整） */
  adaptiveReflection?: boolean;
  /** 自适应模式下的最小反思间隔（错误率高时） */
  minReflectInterval?: number;
  /** 自适应模式下的最大反思间隔（错误率低时） */
  maxReflectInterval?: number;
}

const DEFAULT_CONFIG: ReflectionConfig = {
  enabled: true,
  reflectAfterNTools: 3,
  reflectOnFailure: true,
  maxReflections: 3,
  confidenceThreshold: 0.3,
  adaptiveReflection: true,
  minReflectInterval: 2,
  maxReflectInterval: 6,
};

export class ReflectionEngine {
  private config: ReflectionConfig;
  private callLLMFn: (prompt: string, systemPrompt: string) => Promise<string>;
  private reflectionCount: number = 0;

  constructor(
    config?: Partial<ReflectionConfig>,
    callLLMFn: (prompt: string, systemPrompt: string) => Promise<string> = async () => "",
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.callLLMFn = callLLMFn;
  }

  async reflect(trace: ToolExecutionTrace[], planContext?: string): Promise<ReflectionResult> {
    if (!this.config.enabled) {
      return { shouldContinue: true, shouldReplan: false, shouldRetry: false, analysis: "Reflection disabled", confidence: 1.0 };
    }

    if (this.reflectionCount >= this.config.maxReflections) {
      return { shouldContinue: true, shouldReplan: false, shouldRetry: false, analysis: "Max reflections reached", confidence: 0.5 };
    }

    this.reflectionCount++;

    const formattedTrace = this.formatTraceForLLM(trace);
    const contextSection = planContext ? `Current plan context:\n${planContext}` : "No plan context available.";

    const prompt = `You are a reflection assistant analyzing an AI agent's tool execution trace.

Execution trace:
${formattedTrace}

${contextSection}

Analyze the execution and decide:
1. Is the agent making progress toward the goal?
2. Are there any errors that need correction?
3. Should the agent continue, replan, or retry the last step?

Output JSON:
{
  "shouldContinue": true/false,
  "shouldReplan": true/false,
  "shouldRetry": true/false,
  "retrySuggestion": "how to modify params" or null,
  "analysis": "brief analysis of what happened",
  "nextStepSuggestion": "what to do next" or null,
  "confidence": 0.0-1.0
}

Rules:
- shouldReplan only if the current approach is fundamentally wrong
- shouldRetry only if a simple parameter change might fix the issue
- shouldContinue if progress is being made
- Set confidence low (below 0.3) if you're uncertain about the analysis`;

    const systemPrompt = "You are a reflection assistant. You must respond with valid JSON only. No markdown, no explanation outside the JSON.";

    try {
      const response = await this.callLLMFn(prompt, systemPrompt);
      const parsed = this.parseResponse(response);
      return parsed;
    } catch {
      return {
        shouldContinue: true,
        shouldReplan: false,
        shouldRetry: false,
        analysis: "Failed to get LLM reflection, defaulting to continue",
        confidence: 0.5,
      };
    }
  }

  shouldReflect(trace: ToolExecutionTrace[]): boolean {
    if (!this.config.enabled) {
      return false;
    }

    if (trace.length === 0) {
      return false;
    }

    // Reflect on failure if configured
    if (this.config.reflectOnFailure) {
      const lastEntry = trace[trace.length - 1];
      if (!lastEntry.success) {
        return true;
      }
    }

    // 自适应反思频率：根据最近工具调用的错误率动态调整间隔
    const interval = this.getAdaptiveInterval(trace);
    if (trace.length >= interval && trace.length % interval === 0) {
      return true;
    }

    return false;
  }

  /**
   * 根据最近工具调用的错误率计算反思间隔。
   * - 错误率 > 50%：使用 minReflectInterval（频繁反思）
   * - 错误率 < 10%：使用 maxReflectInterval（稀疏反思）
   * - 中间值：线性插值
   */
  private getAdaptiveInterval(trace: ToolExecutionTrace[]): number {
    if (!this.config.adaptiveReflection) {
      return this.config.reflectAfterNTools;
    }
    const min = this.config.minReflectInterval ?? 2;
    const max = this.config.maxReflectInterval ?? 6;
    // 取最近 10 次工具调用的滑动窗口
    const window = trace.slice(-10);
    const failures = window.filter(t => !t.success).length;
    const errorRate = window.length > 0 ? failures / window.length : 0;
    // errorRate 0.5+ → min; errorRate 0.1- → max; 中间线性
    if (errorRate >= 0.5) return min;
    if (errorRate <= 0.1) return max;
    // 线性插值：errorRate 越高，interval 越小
    const ratio = (errorRate - 0.1) / (0.5 - 0.1); // 0..1
    return Math.round(max - ratio * (max - min));
  }

  formatTraceForLLM(trace: ToolExecutionTrace[]): string {
    return trace
      .map((entry, index) => {
        const lines: string[] = [
          `--- Tool Call #${index + 1} ---`,
          `Tool: ${entry.toolName}`,
          `Params: ${JSON.stringify(entry.params)}`,
          `Success: ${entry.success}`,
          `Duration: ${entry.duration}ms`,
          // entry.timestamp 可能来自损坏的 JSON，new Date(...) 会得到 Invalid Date，
          // 此时 toISOString() 会抛 RangeError: Invalid time value，导致整个反射流程中断。
          `Timestamp: ${(() => {
            const d = new Date(entry.timestamp);
            return Number.isNaN(d.getTime()) ? String(entry.timestamp) : d.toISOString();
          })()}`,
        ];
        if (entry.error) {
          lines.push(`Error: ${entry.error}`);
        }
        lines.push(`Result: ${JSON.stringify(entry.result)}`);
        return lines.join("\n");
      })
      .join("\n\n");
  }

  quickReflect(trace: ToolExecutionTrace[]): ReflectionResult {
    if (trace.length === 0) {
      return { shouldContinue: true, shouldReplan: false, shouldRetry: false, analysis: "No trace entries", confidence: 1.0 };
    }

    const lastEntry = trace[trace.length - 1];

    // If last 3+ tools all failed → shouldReplan
    if (trace.length >= 3) {
      const lastThree = trace.slice(-3);
      if (lastThree.every((t) => !t.success)) {
        return {
          shouldContinue: false,
          shouldReplan: true,
          shouldRetry: false,
          analysis: "Last 3+ tool calls all failed — the current approach is likely wrong",
          nextStepSuggestion: "Create a new plan with a different approach",
          confidence: 0.7,
        };
      }
    }

    // If last tool failed with network error → shouldRetry
    if (!lastEntry.success && lastEntry.error) {
      const errorLower = lastEntry.error.toLowerCase();
      if (
        errorLower.includes("network") ||
        errorLower.includes("econnrefused") ||
        errorLower.includes("econnreset") ||
        errorLower.includes("timeout") ||
        errorLower.includes("etimedout") ||
        errorLower.includes("fetch failed")
      ) {
        return {
          shouldContinue: false,
          shouldReplan: false,
          shouldRetry: true,
          retrySuggestion: "Network error occurred — retry the same call",
          analysis: `Network error in tool ${lastEntry.toolName}: ${lastEntry.error}`,
          confidence: 0.8,
        };
      }

      // If error contains "not found" or "does not exist" → shouldRetry with suggestion
      if (errorLower.includes("not found") || errorLower.includes("does not exist")) {
        return {
          shouldContinue: false,
          shouldReplan: false,
          shouldRetry: true,
          retrySuggestion: "Resource not found — try different parameters or an alternative path",
          analysis: `Tool ${lastEntry.toolName} reported resource not found: ${lastEntry.error}`,
          confidence: 0.7,
        };
      }
    }

    // If last tool succeeded → shouldContinue
    if (lastEntry.success) {
      return {
        shouldContinue: true,
        shouldReplan: false,
        shouldRetry: false,
        analysis: `Tool ${lastEntry.toolName} succeeded, continuing with current plan`,
        confidence: 0.8,
      };
    }

    // Generic failure — continue but with low confidence
    return {
      shouldContinue: true,
      shouldReplan: false,
      shouldRetry: false,
      analysis: `Tool ${lastEntry.toolName} failed but no specific heuristic matched`,
      confidence: 0.4,
    };
  }

  resetReflectionCount(): void {
    this.reflectionCount = 0;
  }

  private parseResponse(response: string): ReflectionResult {
    const conservative: ReflectionResult = {
      shouldContinue: true,
      shouldReplan: false,
      shouldRetry: false,
      analysis: "Failed to parse LLM reflection response, defaulting to continue",
      confidence: 0.5,
    };

    try {
      // Try to extract JSON from the response — handle cases where LLM wraps in markdown
      let jsonStr = response.trim();

      // Strip markdown code fences if present
      const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) {
        jsonStr = fenceMatch[1].trim();
      }

      const parsed = JSON.parse(jsonStr);

      return {
        shouldContinue: typeof parsed.shouldContinue === "boolean" ? parsed.shouldContinue : true,
        shouldReplan: typeof parsed.shouldReplan === "boolean" ? parsed.shouldReplan : false,
        shouldRetry: typeof parsed.shouldRetry === "boolean" ? parsed.shouldRetry : false,
        retrySuggestion: typeof parsed.retrySuggestion === "string" ? parsed.retrySuggestion : undefined,
        analysis: typeof parsed.analysis === "string" ? parsed.analysis : "No analysis provided",
        nextStepSuggestion: typeof parsed.nextStepSuggestion === "string" ? parsed.nextStepSuggestion : undefined,
        confidence: typeof parsed.confidence === "number" && !Number.isNaN(parsed.confidence) ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
      };
    } catch {
      return conservative;
    }
  }
}
