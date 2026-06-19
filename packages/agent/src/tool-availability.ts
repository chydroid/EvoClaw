// Tool Availability Evaluation System
// Evaluates tool descriptors against runtime availability constraints

import type { JsonObject, JsonValue } from './tool-types.js';

/**
 * Signal types for tool availability
 */
export type ToolAvailabilitySignal =
  | { kind: 'always' }
  | { kind: 'auth'; providerId: string }
  | { kind: 'config'; path: readonly string[]; check?: 'exists' | 'available' }
  | { kind: 'env'; name: string }
  | { kind: 'plugin-enabled'; pluginId: string }
  | { kind: 'context'; key: string; equals?: JsonPrimitive };

/**
 * Availability expression - can be a single signal or logical combination
 */
export type ToolAvailabilityExpression =
  | ToolAvailabilitySignal
  | { allOf: readonly ToolAvailabilityExpression[] }
  | { anyOf: readonly ToolAvailabilityExpression[] };

/**
 * Context for evaluating tool availability
 */
export interface ToolAvailabilityContext {
  authProviderIds?: Set<string>;
  config?: JsonObject;
  env?: Record<string, string>;
  enabledPluginIds?: Set<string>;
  values?: Record<string, JsonPrimitive>;
  isConfigValueAvailable?: (params: {
    value: JsonValue;
    path: readonly string[];
    signal: Extract<ToolAvailabilitySignal, { kind: 'config' }>;
  }) => boolean;
}

/**
 * Diagnostic information for unavailable tools
 */
export interface ToolAvailabilityDiagnostic {
  reason:
    | 'auth-missing'
    | 'config-missing'
    | 'env-missing'
    | 'plugin-disabled'
    | 'context-mismatch'
    | 'unsupported-signal';
  signal: ToolAvailabilitySignal;
  message: string;
}

type JsonPrimitive = string | number | boolean | null;

/**
 * Check if a value is a record (plain object)
 */
function isRecord(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolve a value from config by path
 */
function resolveConfigPath(
  config: JsonObject | undefined,
  path: readonly string[]
): JsonValue | undefined {
  let current: JsonValue | undefined = config;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/**
 * Check if a config value meets the availability requirement
 */
function hasConfiguredValue(params: {
  value: JsonValue | undefined;
  signal: Extract<ToolAvailabilitySignal, { kind: 'config' }>;
  context: ToolAvailabilityContext;
}): boolean {
  const { value, signal, context } = params;
  
  if (value === undefined || value === null) {
    return false;
  }
  
  // "available" check delegates to semantic validation
  if ((signal.check ?? 'exists') === 'available') {
    return (
      context.isConfigValueAvailable?.({
        value,
        path: signal.path,
        signal,
      }) === true
    );
  }
  
  // "exists" check just verifies the value is present
  if ((signal.check ?? 'exists') === 'exists') {
    return true;
  }
  
  // Type-specific existence checks
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length > 0;
  }
  
  return true;
}

/**
 * Create a diagnostic object
 */
function diagnostic(
  reason: ToolAvailabilityDiagnostic['reason'],
  signal: ToolAvailabilitySignal,
  message: string
): ToolAvailabilityDiagnostic {
  return { reason, signal, message };
}

/**
 * Evaluate a single availability signal
 */
function evaluateSignal(
  signal: ToolAvailabilitySignal,
  context: ToolAvailabilityContext
): ToolAvailabilityDiagnostic | null {
  switch (signal.kind) {
    case 'always':
      return null;
      
    case 'auth':
      return context.authProviderIds?.has(signal.providerId)
        ? null
        : diagnostic('auth-missing', signal, `Missing auth provider: ${signal.providerId}`);
        
    case 'config': {
      const value = resolveConfigPath(context.config, signal.path);
      return hasConfiguredValue({ value, signal, context })
        ? null
        : diagnostic('config-missing', signal, `Missing config path: ${signal.path.join('.')}`);
    }
    
    case 'env':
      return context.env?.[signal.name]?.trim()
        ? null
        : diagnostic('env-missing', signal, `Missing environment variable: ${signal.name}`);
        
    case 'plugin-enabled':
      return context.enabledPluginIds?.has(signal.pluginId)
        ? null
        : diagnostic('plugin-disabled', signal, `Plugin is not enabled: ${signal.pluginId}`);
        
    case 'context': {
      const value = context.values?.[signal.key];
      if (!('equals' in signal)) {
        return value === undefined
          ? diagnostic('context-mismatch', signal, `Missing context value: ${signal.key}`)
          : null;
      }
      return value === signal.equals
        ? null
        : diagnostic('context-mismatch', signal, `Context value did not match: ${signal.key}`);
    }
    
    default:
      return diagnostic('unsupported-signal', signal, 'Unsupported availability signal');
  }
}

/**
 * Check if a value has the shape of an availability expression
 */
function hasAvailabilityExpressionShape(value: unknown): value is ToolAvailabilityExpression {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('kind' in value || 'allOf' in value || 'anyOf' in value)
  );
}

/**
 * Evaluate an availability expression recursively
 */
function evaluateExpression(
  expression: ToolAvailabilityExpression,
  context: ToolAvailabilityContext
): readonly ToolAvailabilityDiagnostic[] {
  // Single signal
  if ('kind' in expression) {
    const result = evaluateSignal(expression, context);
    return result ? [result] : [];
  }
  
  // allOf - all signals must be available
  if ('allOf' in expression) {
    if (expression.allOf.length === 0) {
      return [
        {
          reason: 'unsupported-signal',
          signal: { kind: 'always' },
          message: 'Empty availability allOf group',
        },
      ];
    }
    return expression.allOf.flatMap((entry) => evaluateExpression(entry, context));
  }
  
  // anyOf - at least one signal must be available
  if ('anyOf' in expression) {
    if (expression.anyOf.length === 0) {
      return [
        {
          reason: 'unsupported-signal',
          signal: { kind: 'always' },
          message: 'Empty availability anyOf group',
        },
      ];
    }
    
    const diagnostics = expression.anyOf.map((entry) => evaluateExpression(entry, context));
    
    // "unsupported-signal" indicates a malformed descriptor, not a runtime condition
    const unsupported = diagnostics
      .flat()
      .filter((entry) => entry.reason === 'unsupported-signal');
    
    // If any branch is available, return only unsupported errors
    if (diagnostics.some((entries) => entries.length === 0)) {
      return unsupported;
    }
    
    // All branches failed, return all diagnostics
    return diagnostics.flat();
  }
  
  return [
    {
      reason: 'unsupported-signal',
      signal: { kind: 'always' },
      message: 'Unsupported availability expression',
    },
  ];
}

/**
 * Evaluate tool availability against runtime context
 * 
 * @param params - Evaluation parameters
 * @param params.availability - Tool availability expression
 * @param params.context - Runtime context for evaluation
 * @returns Array of diagnostics (empty if tool is available)
 * 
 * @example
 * ```typescript
 * const diagnostics = evaluateToolAvailability({
 *   availability: {
 *     allOf: [
 *       { kind: 'auth', providerId: 'openai' },
 *       { kind: 'env', name: 'OPENAI_API_KEY' }
 *     ]
 *   },
 *   context: {
 *     authProviderIds: new Set(['openai']),
 *     env: { OPENAI_API_KEY: 'sk-...' }
 *   }
 * });
 * 
 * if (diagnostics.length === 0) {
 *   process.stdout.write('Tool is available');
 * } else {
 *   process.stdout.write('Tool is unavailable:' + " " + diagnostics);
 * }
 * ```
 */
export function evaluateToolAvailability(params: {
  availability: ToolAvailabilityExpression;
  context?: ToolAvailabilityContext;
}): readonly ToolAvailabilityDiagnostic[] {
  const context = params.context ?? {};
  const availability = params.availability ?? { kind: 'always' };
  
  if (!hasAvailabilityExpressionShape(availability)) {
    return [
      {
        reason: 'unsupported-signal',
        signal: { kind: 'always' },
        message: 'Unsupported availability expression',
      },
    ];
  }
  
  return evaluateExpression(availability, context);
}

/**
 * Check if a tool is available (convenience function)
 */
export function isToolAvailable(params: {
  availability: ToolAvailabilityExpression;
  context?: ToolAvailabilityContext;
}): boolean {
  const diagnostics = evaluateToolAvailability(params);
  return diagnostics.length === 0;
}

/**
 * Get a human-readable summary of availability diagnostics
 */
export function formatAvailabilityDiagnostics(
  diagnostics: readonly ToolAvailabilityDiagnostic[]
): string {
  if (diagnostics.length === 0) {
    return 'Tool is available';
  }
  
  const reasons = diagnostics.map((d) => d.message).join('; ');
  return `Tool is unavailable: ${reasons}`;
}
