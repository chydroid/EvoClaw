/**
 * Response Validator with Rescue Parsing and Smart Nudges
 * Inspired by Forge project - boosts tool calling success rate
 *
 * Key Forge techniques integrated:
 * 1. Rescue parsing — extract tool calls from text, code fences, Mistral/Qwen formats
 * 2. Smart retry nudges — escalating prompts to help the model correct errors
 * 3. Synthetic respond tool — force models to stay in tool-calling mode (Forge's #1 technique)
 * 4. Context warning nudges — escalating warnings when context fills up
 * 5. Error-as-tool-result — emit errors as tool results instead of user nudges
 */

export interface Nudge {
  role: "user" | "system";
  content: string;
  kind: "retry" | "unknown_tool" | "invalid_args" | "format" | "context_warning";
}

export interface ValidationResult {
  toolCalls: ToolCall[] | null;
  nudge: Nudge | null;
  needsRetry: boolean;
}

// Internal ToolCall type since it's not exported from plugin-sdk
interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

// Internal ToolDefinition for type safety
interface SimpleToolDefinition {
  name: string;
}

// Nudge message templates
const NUDGE_TEMPLATES = {
  retry: (raw: string) =>
    "Your previous response was not a valid tool call. You must respond with a tool call, not free text. Please try again with a valid tool call.",

  unknownTool: (toolName: string, availableTools: string[]) => {
    const toolsList = availableTools.join(", ");
    return `Tool '${toolName}' does not exist. Available tools: ${toolsList}. Call one of them.`;
  },

  invalidArgs: (toolName: string, error: string) =>
    `Invalid arguments for tool '${toolName}': ${error}. Please fix the arguments and try again.`,

  format: (hint: string) =>
    `Your response format was incorrect. ${hint} Please format your response properly and try again.`,

  contextWarning: (tokens: number, budget: number, pct: number) =>
    `[Context usage: ${Math.round(pct * 100)}% (${tokens.toLocaleString()} / ${budget.toLocaleString()} tokens). Context is filling up. Be concise in your responses and prioritize completing the current task.]`,
};

/**
 * Attempt to rescue tool calls from text responses (parsing from various formats)
 * Handles:
 * - JSON inside code fences
 * - Mistral-style [TOOL_CALLS]name{args}
 * - Qwen-style <tool_call>
 * - Plain JSON arrays/objects
 */
export function rescueToolCalls(
  content: string,
  availableToolNames: string[]
): ToolCall[] | null {
  if (!content || !content.trim()) return null;

  // Strategy 1: Extract JSON from code fences
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    const extracted = tryParseToolCalls(fenceMatch[1], availableToolNames);
    if (extracted) return extracted;
  }

  // Strategy 2: Try parse entire content as JSON
  const directParse = tryParseToolCalls(content, availableToolNames);
  if (directParse) return directParse;

  // Strategy 3: Mistral-style [TOOL_CALLS]name{args}
  const mistralMatch = content.match(/\[TOOL_CALLS\]([\s\S]*)/);
  if (mistralMatch) {
    const extracted = parseMistralFormat(mistralMatch[1], availableToolNames);
    if (extracted) return extracted;
  }

  // Strategy 4: Qwen-style <tool_call>
  const qwenMatch = content.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  if (qwenMatch) {
    const extracted = tryParseToolCalls(qwenMatch[1], availableToolNames);
    if (extracted) return extracted;
  }

  // Strategy 5: Look for {"name":"tool","arguments":{...}} patterns anywhere
  const looseJsonMatch = content.match(/\{[^{}]*"name"[^{}]*"arguments"[^{}]*\}/);
  if (looseJsonMatch) {
    const extracted = tryParseToolCalls(`[${looseJsonMatch[0]}]`, availableToolNames);
    if (extracted) return extracted;
  }

  return null;
}

/**
 * Try to parse tool calls from JSON string
 */
function tryParseToolCalls(jsonStr: string, availableToolNames: string[]): ToolCall[] | null {
  try {
    const parsed = JSON.parse(jsonStr);

    // Case 1: Array of tool calls
    if (Array.isArray(parsed)) {
      const calls = parsed
        .map(parseSingleToolCall)
        .filter((tc): tc is ToolCall => tc !== null && availableToolNames.includes(tc.name));
      if (calls.length > 0) return calls;
    }

    // Case 2: Single tool call object
    const singleCall = parseSingleToolCall(parsed);
    if (singleCall && availableToolNames.includes(singleCall.name)) {
      return [singleCall];
    }

    // Case 3: OpenAI tool_calls format (array of {id, type, function: {name, arguments}})
    if (Array.isArray(parsed)) {
      const openaiCalls = parsed
        .map((item: any) => {
          if (item.type === "function" && item.function) {
            return parseSingleToolCall({
              name: item.function.name,
              arguments: item.function.arguments,
            });
          }
          return null;
        })
        .filter((tc): tc is ToolCall => tc !== null && availableToolNames.includes(tc.name));
      if (openaiCalls.length > 0) return openaiCalls;
    }
  } catch {
    // Invalid JSON, continue to next strategy
  }
  return null;
}

/**
 * Parse Mistral [TOOL_CALLS] format
 */
function parseMistralFormat(content: string, availableToolNames: string[]): ToolCall[] | null {
  const calls: ToolCall[] = [];

  // Look for toolName{...} patterns
  const toolCallRegex = /(\w+)\s*\{([^}]*)\}/g;
  let match;

  while ((match = toolCallRegex.exec(content)) !== null) {
    const toolName = match[1];
    if (!availableToolNames.includes(toolName)) continue;

    try {
      const args = JSON.parse(`{${match[2]}}`);
      calls.push({ name: toolName, arguments: args });
    } catch {
      try {
        // Try without surrounding braces
        const args = JSON.parse(match[2]);
        calls.push({ name: toolName, arguments: args });
      } catch {
        // Can't parse args, skip
      }
    }
  }

  return calls.length > 0 ? calls : null;
}

/**
 * Parse a single tool call object
 */
function parseSingleToolCall(obj: any): ToolCall | null {
  if (!obj || typeof obj !== "object") return null;

  const name = obj.name || obj.tool_name || obj.tool;
  let args = obj.arguments || obj.args || obj.parameters || obj.input;

  if (!name) return null;

  // Parse string args to object if needed
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      // Keep as empty object if can't parse
      args = {};
    }
  }

  return { name, arguments: args || {} };
}

/**
 * Response Validator - the core guardrail
 */
export class ResponseValidator {
  private availableToolNames: string[];
  private rescueEnabled: boolean;
  private customRetryNudge?: (raw: string) => string;

  constructor(
    tools: SimpleToolDefinition[],
    options: { rescueEnabled?: boolean; customRetryNudge?: (raw: string) => string } = {}
  ) {
    this.availableToolNames = tools.map((t) => t.name);
    this.rescueEnabled = options.rescueEnabled !== false;
    this.customRetryNudge = options.customRetryNudge;
  }

  /**
   * Validate an LLM response
   * Returns either valid tool calls or a nudge to retry
   */
  validate(
    message: { content: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> }
  ): ValidationResult {
    // Case 1: Has explicit tool_calls (OpenAI format)
    if (message.tool_calls && message.tool_calls.length > 0) {
      const calls = message.tool_calls
        .map((tc) => {
          try {
            return {
              name: tc.function.name,
              arguments:
                typeof tc.function.arguments === "string"
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments,
            };
          } catch {
            return null;
          }
        })
        .filter((tc): tc is ToolCall => tc !== null);

      // Check for unknown tools
      const unknownTools = calls.filter((tc) => !this.availableToolNames.includes(tc.name));
      if (unknownTools.length > 0) {
        return {
          toolCalls: null,
          nudge: {
            role: "user",
            content: NUDGE_TEMPLATES.unknownTool(unknownTools[0].name, this.availableToolNames),
            kind: "unknown_tool",
          },
          needsRetry: true,
        };
      }

      if (calls.length > 0) {
        return { toolCalls: calls, nudge: null, needsRetry: false };
      }
    }

    // Case 2: Text response - try rescue parsing
    if (message.content) {
      if (this.rescueEnabled) {
        const rescued = rescueToolCalls(message.content, this.availableToolNames);
        if (rescued) {
          process.stdout.write(
            `[ResponseValidator] 🔧 Rescued ${rescued.length} tool call(s) from text response\n`
          );
          return { toolCalls: rescued, nudge: null, needsRetry: false };
        }
      }

      // Text response with no tool calls - needs retry nudge
      const nudgeFn = this.customRetryNudge || NUDGE_TEMPLATES.retry;
      return {
        toolCalls: null,
        nudge: {
          role: "user",
          content: nudgeFn(message.content),
          kind: "retry",
        },
        needsRetry: true,
      };
    }

    // Case 3: Empty response - retry
    return {
      toolCalls: null,
      nudge: {
        role: "user",
        content: NUDGE_TEMPLATES.retry(""),
        kind: "retry",
      },
      needsRetry: true,
    };
  }

  /**
   * Create a context warning nudge
   */
  static createContextWarning(tokens: number, budget: number): Nudge {
    const pct = tokens / budget;
    return {
      role: "user",
      content: NUDGE_TEMPLATES.contextWarning(tokens, budget, pct),
      kind: "context_warning",
    };
  }

  /**
   * Create an invalid args nudge
   */
  static createInvalidArgsNudge(toolName: string, error: string): Nudge {
    return {
      role: "user",
      content: NUDGE_TEMPLATES.invalidArgs(toolName, error),
      kind: "invalid_args",
    };
  }
}

/**
 * Error Tracker - counts retries and tool errors
 */
export class ErrorTracker {
  private _retries: number = 0;
  private _toolErrors: number = 0;
  readonly maxRetries: number;
  readonly maxToolErrors: number;

  constructor(options: { maxRetries?: number; maxToolErrors?: number } = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.maxToolErrors = options.maxToolErrors ?? 2;
  }

  get retries(): number {
    return this._retries;
  }

  get retriesExhausted(): boolean {
    return this._retries >= this.maxRetries;
  }

  get toolErrorsExhausted(): boolean {
    return this._toolErrors >= this.maxToolErrors;
  }

  recordRetry(): void {
    this._retries++;
  }

  recordToolError(): void {
    this._toolErrors++;
  }

  resetRetries(): void {
    this._retries = 0;
  }

  resetToolErrors(): void {
    this._toolErrors = 0;
  }

  resetAll(): void {
    this._retries = 0;
    this._toolErrors = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Synthetic Respond Tool — Forge's #1 technique for small model reliability
// ═══════════════════════════════════════════════════════════════════════════════
//
// Core insight: small models (~8B) cannot be trusted to correctly choose between
// returning text vs using tools in the expected format. Forge solves this by
// ALWAYS keeping the model in tool-calling mode: inject a synthetic "respond"
// tool that the model calls instead of producing bare text.
//
// The model calls respond(message="...") → we intercept, return the message as
// text, and the caller strips the respond tool call from the final output.
// This eliminates the entire class of "model returned text instead of tool call" errors.

export const RESPOND_TOOL_NAME = "respond";

export const RESPOND_TOOL_DESCRIPTION =
  "Respond to the user with a message. Use this when the user is chatting, " +
  "asking a question, when you need to ask a clarifying question before " +
  "proceeding, or when no other tool action is needed. Also use this " +
  "after completing the user's request to report the result.";

export const RESPOND_TOOL_DEFINITION: SimpleToolDefinition = {
  name: RESPOND_TOOL_NAME,
};

export const RESPOND_TOOL_OPENAI_SPEC = {
  type: "function" as const,
  function: {
    name: RESPOND_TOOL_NAME,
    description: RESPOND_TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The message to send to the user.",
        },
      },
      required: ["message"],
    },
  },
};

/**
 * Check if a tool call is the synthetic respond tool.
 * If so, extract the message text from its arguments.
 */
export function extractRespondMessage(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (toolName === RESPOND_TOOL_NAME) {
    return (args.message as string) || (args.response as string) || null;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Context Warning Tracker — Forge-style escalating context pressure warnings
// ═══════════════════════════════════════════════════════════════════════════════
//
// Forge injects transient user messages at context usage thresholds (e.g. 65%,
// 80%) telling the model to be concise and wrap up. This prevents catastrophic
// context truncation and helps the model prioritize.
//
// Key design: warnings are transient (not persisted in conversation history),
// each threshold fires at most once per session, and resets if usage drops
// below the threshold after compaction.

const DEFAULT_CONTEXT_WARNING_TEMPLATES = {
  high: (tokens: number, budget: number, pct: number) =>
    `[Context usage: ${Math.round(pct * 100)}% (${tokens.toLocaleString()} / ${budget.toLocaleString()} tokens). ` +
    "Context is nearly full. Older tool results and reasoning will be " +
    "compacted soon — key information may be lost. Summarize critical " +
    "findings now and prioritize completing the current task.]",

  mid: (tokens: number, budget: number, pct: number) =>
    `[Context usage: ${Math.round(pct * 100)}% (${tokens.toLocaleString()} / ${budget.toLocaleString()} tokens). ` +
    "Context is filling up. When compaction triggers, older tool results " +
    "and reasoning will be condensed. Be concise in your responses and " +
    "front-load important information.]",

  low: (tokens: number, budget: number, pct: number) =>
    `[Context usage: ${Math.round(pct * 100)}% (${tokens.toLocaleString()} / ${budget.toLocaleString()} tokens). ` +
    "Be mindful of context usage.]",
};

export interface ContextWarningConfig {
  /** Context budget in tokens */
  budgetTokens: number;
  /** Thresholds as fractions of budget that trigger warnings. Default: [0.5, 0.65, 0.80] */
  thresholds?: number[];
  /** Custom warning template functions */
  templates?: {
    high?: (tokens: number, budget: number, pct: number) => string;
    mid?: (tokens: number, budget: number, pct: number) => string;
    low?: (tokens: number, budget: number, pct: number) => string;
  };
}

export class ContextWarningTracker {
  private budgetTokens: number;
  private thresholds: number[];
  private firedThresholds: Set<number> = new Set();
  private templates: {
    high: (tokens: number, budget: number, pct: number) => string;
    mid: (tokens: number, budget: number, pct: number) => string;
    low: (tokens: number, budget: number, pct: number) => string;
  };
  private lastKnownTokens: number | null = null;

  constructor(config: ContextWarningConfig) {
    this.budgetTokens = config.budgetTokens;
    this.thresholds = [...(config.thresholds || [0.5, 0.65, 0.80])].sort((a, b) => a - b);
    this.templates = {
      ...DEFAULT_CONTEXT_WARNING_TEMPLATES,
      ...(config.templates || {}),
    };
  }

  /** Update with actual token count from LLM backend */
  updateTokenCount(totalTokens: number): void {
    this.lastKnownTokens = totalTokens;
  }

  /** Estimate tokens from messages (chars/4 heuristic) */
  estimateTokens(messages: Array<{ content: string | null }>): number {
    if (this.lastKnownTokens !== null) return this.lastKnownTokens;
    return messages.reduce((sum, m) => sum + (m.content?.length || 0), 0) / 4;
  }

  /**
   * Check context thresholds and return a warning message if needed.
   * Returns null if no threshold has been newly crossed.
   * Resets fired thresholds when usage drops below them (after compaction).
   */
  checkThresholds(estimatedTokens: number): string | null {
    if (this.budgetTokens <= 0 || this.thresholds.length === 0) return null;

    const pct = estimatedTokens / this.budgetTokens;

    // Reset thresholds that usage has dropped below (e.g. after compaction)
    this.firedThresholds = new Set(
      [...this.firedThresholds].filter((t) => pct >= t),
    );

    // Find the highest unfired threshold that has been crossed
    for (let i = this.thresholds.length - 1; i >= 0; i--) {
      const threshold = this.thresholds[i];
      if (pct >= threshold && !this.firedThresholds.has(threshold)) {
        this.firedThresholds.add(threshold);

        // Return escalating warning based on tier
        if (i >= 2) {
          return this.templates.high(estimatedTokens, this.budgetTokens, pct);
        }
        if (i >= 1) {
          return this.templates.mid(estimatedTokens, this.budgetTokens, pct);
        }
        return this.templates.low(estimatedTokens, this.budgetTokens, pct);
      }
    }

    return null;
  }

  /** Reset all fired threshold tracking */
  reset(): void {
    this.firedThresholds.clear();
    this.lastKnownTokens = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stop Conditions — Inspired by Vercel AI SDK's stopWhen pattern
// ═══════════════════════════════════════════════════════════════════════════════
//
// Instead of simple round counting, EvoClaw supports composable stop conditions
// that can check multiple criteria. Each condition returns true when the agent
// should stop. Conditions are evaluated in order; the first true condition wins.

export type StopReason = "maxSteps" | "respondTool" | "errorExhausted" | "toolExhausted";

export interface StopCondition {
  name: string;
  check: (state: AgentLoopState) => { shouldStop: boolean; reason?: StopReason };
}

export interface AgentLoopState {
  round: number;
  maxRounds: number;
  finalReply: string | null;
  respondHandled: boolean;
  errorTracker: ErrorTracker;
}

/** Stop after a fixed number of steps (AI SDK's stepCountIs) */
export function stepCountIs(maxSteps: number): StopCondition {
  return {
    name: "stepCount",
    check: (state) => ({
      shouldStop: state.round >= maxSteps,
      reason: "maxSteps" as StopReason,
    }),
  };
}

/** Stop when the respond tool has been called */
export function respondCalled(): StopCondition {
  return {
    name: "respondCalled",
    check: (state) => ({
      shouldStop: state.respondHandled,
      reason: "respondTool" as StopReason,
    }),
  };
}

/** Stop when error retries are exhausted */
export function errorExhausted(): StopCondition {
  return {
    name: "errorExhausted",
    check: (state) => ({
      shouldStop: state.errorTracker.retriesExhausted,
      reason: "errorExhausted" as StopReason,
    }),
  };
}

/** Stop when tool errors are exhausted */
export function toolErrorsExhausted(): StopCondition {
  return {
    name: "toolErrorsExhausted",
    check: (state) => ({
      shouldStop: state.errorTracker.toolErrorsExhausted,
      reason: "toolExhausted" as StopReason,
    }),
  };
}

/** Default stop conditions for all agent loops */
export function defaultStopConditions(maxSteps: number): StopCondition[] {
  return [
    respondCalled(),
    errorExhausted(),
    toolErrorsExhausted(),
    stepCountIs(maxSteps),
  ];
}

/**
 * Evaluate stop conditions and return the winning condition, or null.
 */
export function evaluateStopConditions(
  conditions: StopCondition[],
  state: AgentLoopState,
): { shouldStop: boolean; reason?: StopReason; conditionName?: string } | null {
  for (const condition of conditions) {
    const result = condition.check(state);
    if (result.shouldStop) {
      return { shouldStop: true, reason: result.reason, conditionName: condition.name };
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool Lifecycle Hooks — Inspired by Claude Code's PreToolUse / PostToolUse / Stop pattern
// ═══════════════════════════════════════════════════════════════════════════════
//
// Claude Code uses hooks as pure extension points that can reject or modify
// tool calls at various lifecycle stages. EvoClaw adapts this pattern for
// its plugin system, adding PostToolUse hooks alongside existing PreToolUse ones.

export interface ToolLifecycleHook<Context = unknown> {
  /** Called before a tool executes. Return modified context or throw to abort. */
  preToolUse?: (toolName: string, args: Record<string, unknown>, context: Context) => Promise<Context | undefined> | Context | undefined;
  /** Called after a tool successfully executes. May modify or replace the result. */
  postToolUse?: (toolName: string, args: Record<string, unknown>, result: string, context: Context) => Promise<string> | string;
  /** Called when a tool execution fails. May provide a fallback result. */
  onToolError?: (toolName: string, args: Record<string, unknown>, error: Error, context: Context) => Promise<string | undefined> | string | undefined;
}

/**
 * OrderedDrain — Inspired by Claude Code's streaming executor pattern.
 *
 * When tools are executed in parallel, results arrive asynchronously but must
 * be presented to the LLM in the order the tools were called. OrderedDrain
 * buffers out-of-order results and flushes them in correct sequence.
 */
export class OrderedDrain<T> {
  private buffer: Map<number, T> = new Map();
  private nextExpected = 0;

  /** Push a result with its original index. Returns drained items in order. */
  push(index: number, item: T): T[] {
    this.buffer.set(index, item);
    return this.drain();
  }

  private drain(): T[] {
    const drained: T[] = [];
    while (this.buffer.has(this.nextExpected)) {
      drained.push(this.buffer.get(this.nextExpected)!);
      this.buffer.delete(this.nextExpected);
      this.nextExpected++;
    }
    return drained;
  }

  reset(): void {
    this.buffer.clear();
    this.nextExpected = 0;
  }
}
