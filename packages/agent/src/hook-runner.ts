// Enhanced Hook System - Supports priority, timeout, and multiple execution strategies
// Inspired by OpenClaw's hook runner architecture

/**
 * Hook execution strategy
 */
export type HookExecutionStrategy =
  | 'void'        // Fire-and-forget, parallel execution
  | 'modifying'   // Sequential, merge results
  | 'claiming';   // Sequential, first handler wins

/**
 * Hook failure policy
 */
export type HookFailurePolicy = 'fail-open' | 'fail-closed';

/**
 * Hook handler function
 */
export type HookHandler<TEvent = any, TResult = any> = (
  event: TEvent,
  context?: any
) => Promise<TResult | void> | TResult | void;

/**
 * Hook registration
 */
export interface HookRegistration<TEvent = any, TResult = any> {
  /** Unique hook name */
  hookName: string;
  
  /** Plugin ID that registered this hook */
  pluginId: string;
  
  /** Hook handler function */
  handler: HookHandler<TEvent, TResult>;
  
  /** Priority (higher = executed first) */
  priority?: number;
  
  /** Timeout in milliseconds */
  timeoutMs?: number;
  
  /** Execution strategy */
  strategy?: HookExecutionStrategy;
  
  /** Failure policy */
  failurePolicy?: HookFailurePolicy;
}

/**
 * Hook runner options
 */
export interface HookRunnerOptions {
  /** Logger instance */
  logger?: {
    debug?: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
  
  /** Whether to catch errors (default: true) */
  catchErrors?: boolean;
  
  /** Default failure policy by hook name */
  failurePolicyByHook?: Partial<Record<string, HookFailurePolicy>>;
  
  /** Default timeout for void hooks */
  voidHookTimeoutMs?: number;
  
  /** Default timeout for modifying hooks */
  modifyingHookTimeoutMs?: number;
}

/**
 * Hook result for claiming hooks
 */
export interface ClaimingHookResult<TResult> {
  handled: boolean;
  result?: TResult;
}

/**
 * Hook result for modifying hooks
 */
export interface ModifyingHookResult<TResult> {
  result?: TResult;
  cancel?: boolean;
  cancelReason?: string;
}

/**
 * Hook runner registry
 */
export interface HookRunnerRegistry {
  hooks: HookRegistration[];
  plugins: Array<{ id: string; status: string }>;
}

/**
 * Default timeouts
 */
const DEFAULT_VOID_HOOK_TIMEOUT_MS = 30_000;
const DEFAULT_MODIFYING_HOOK_TIMEOUT_MS = 15_000;

/**
 * Create a hook runner with advanced execution strategies
 */
export function createHookRunner(
  registry: HookRunnerRegistry,
  options: HookRunnerOptions = {}
) {
  const logger = options.logger;
  const catchErrors = options.catchErrors ?? true;
  const failurePolicyByHook = options.failurePolicyByHook ?? {};
  const voidHookTimeoutMs = options.voidHookTimeoutMs ?? DEFAULT_VOID_HOOK_TIMEOUT_MS;
  const modifyingHookTimeoutMs = options.modifyingHookTimeoutMs ?? DEFAULT_MODIFYING_HOOK_TIMEOUT_MS;
  
  /**
   * Get hooks for a specific name, sorted by priority
   */
  function getHooksForName<TEvent, TResult>(
    hookName: string
  ): HookRegistration<TEvent, TResult>[] {
    return (registry.hooks as HookRegistration<TEvent, TResult>[])
      .filter((h) => h.hookName === hookName)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }
  
  /**
   * Handle hook errors
   */
  function handleHookError(params: {
    hookName: string;
    pluginId: string;
    error: unknown;
    failurePolicy?: HookFailurePolicy;
  }): void {
    const policy = params.failurePolicy ?? failurePolicyByHook[params.hookName] ?? 'fail-open';
    const msg = `[hooks] ${params.hookName} handler from ${params.pluginId} failed: ${String(params.error)}`;
    
    if (catchErrors && policy === 'fail-open') {
      logger?.error(msg);
      return;
    }
    
    throw new Error(msg, { cause: params.error });
  }
  
  /**
   * Execute a promise with timeout
   */
  async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Hook timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
  
  /**
   * Run a void hook (fire-and-forget, parallel execution)
   */
  async function runVoidHook<TEvent>(
    hookName: string,
    event: TEvent,
    context?: any
  ): Promise<void> {
    const hooks = getHooksForName<TEvent, void>(hookName);
    
    if (hooks.length === 0) {
      return;
    }
    
    logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, parallel)`);
    
    const promises = hooks.map(async (hook) => {
      try {
        const promise = Promise.resolve(hook.handler(event, context));
        const timeoutMs = hook.timeoutMs ?? voidHookTimeoutMs;
        
        await withTimeout(promise, timeoutMs);
      } catch (err) {
        handleHookError({
          hookName,
          pluginId: hook.pluginId,
          error: err,
          failurePolicy: hook.failurePolicy,
        });
      }
    });
    
    await Promise.all(promises);
  }
  
  /**
   * Run a modifying hook (sequential, merge results)
   */
  async function runModifyingHook<TEvent, TResult>(
    hookName: string,
    event: TEvent,
    context?: any,
    options?: {
      mergeResults?: (acc: TResult | undefined, next: TResult) => TResult;
      shouldStop?: (result: TResult) => boolean;
    }
  ): Promise<TResult | undefined> {
    const hooks = getHooksForName<TEvent, TResult>(hookName);
    
    if (hooks.length === 0) {
      return undefined;
    }
    
    logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, sequential)`);
    
    let result: TResult | undefined;
    
    for (const hook of hooks) {
      try {
        const promise = Promise.resolve(hook.handler(event, context));
        const timeoutMs = hook.timeoutMs ?? modifyingHookTimeoutMs;
        const handlerResult = await withTimeout(promise, timeoutMs);
        
        if (handlerResult !== undefined) {
          if (options?.mergeResults) {
            result = options.mergeResults(result, handlerResult);
          } else {
            result = handlerResult;
          }
          
          if (result && options?.shouldStop?.(result)) {
            logger?.debug?.(
              `[hooks] ${hookName} stopped by ${hook.pluginId}; skipping remaining handlers`
            );
            break;
          }
        }
      } catch (err) {
        handleHookError({
          hookName,
          pluginId: hook.pluginId,
          error: err,
          failurePolicy: hook.failurePolicy,
        });
      }
    }
    
    return result;
  }
  
  /**
   * Run a claiming hook (sequential, first handler wins)
   */
  async function runClaimingHook<TEvent, TResult>(
    hookName: string,
    event: TEvent,
    context?: any
  ): Promise<ClaimingHookResult<TResult> | undefined> {
    const hooks = getHooksForName<TEvent, ClaimingHookResult<TResult>>(hookName);
    
    if (hooks.length === 0) {
      return undefined;
    }
    
    logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, first-claim wins)`);
    
    for (const hook of hooks) {
      try {
        const promise = Promise.resolve(hook.handler(event, context));
        const timeoutMs = hook.timeoutMs ?? modifyingHookTimeoutMs;
        const handlerResult = await withTimeout(promise, timeoutMs);
        
        if (handlerResult?.handled) {
          return handlerResult;
        }
      } catch (err) {
        handleHookError({
          hookName,
          pluginId: hook.pluginId,
          error: err,
          failurePolicy: hook.failurePolicy,
        });
      }
    }
    
    return undefined;
  }
  
  /**
   * Check if any hooks are registered for a name
   */
  function hasHooks(hookName: string): boolean {
    return registry.hooks.some((h) => h.hookName === hookName);
  }
  
  /**
   * Get count of hooks for a name
   */
  function getHookCount(hookName: string): number {
    return registry.hooks.filter((h) => h.hookName === hookName).length;
  }
  
  return {
    runVoidHook,
    runModifyingHook,
    runClaimingHook,
    hasHooks,
    getHookCount,
  };
}

/**
 * Hook runner type
 */
export type HookRunner = ReturnType<typeof createHookRunner>;

/**
 * Common hook names
 */
export const HOOK_NAMES = {
  // Agent lifecycle hooks
  BEFORE_AGENT_START: 'before_agent_start',
  AFTER_AGENT_START: 'after_agent_start',
  BEFORE_AGENT_REPLY: 'before_agent_reply',
  AFTER_AGENT_REPLY: 'after_agent_reply',
  BEFORE_AGENT_END: 'before_agent_end',
  AFTER_AGENT_END: 'after_agent_end',
  
  // Model hooks
  BEFORE_MODEL_CALL: 'before_model_call',
  AFTER_MODEL_CALL: 'after_model_call',
  BEFORE_PROMPT_BUILD: 'before_prompt_build',
  AFTER_PROMPT_BUILD: 'after_prompt_build',
  
  // Tool hooks
  BEFORE_TOOL_CALL: 'before_tool_call',
  AFTER_TOOL_CALL: 'after_tool_call',
  
  // Message hooks
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_SENDING: 'message_sending',
  MESSAGE_SENT: 'message_sent',
  
  // Session hooks
  SESSION_START: 'session_start',
  SESSION_END: 'session_end',
  
  // Context hooks
  BEFORE_COMPACTION: 'before_compaction',
  AFTER_COMPACTION: 'after_compaction',
} as const;

/**
 * Create a hook registration
 */
export function createHookRegistration<TEvent, TResult>(
  hookName: string,
  pluginId: string,
  handler: HookHandler<TEvent, TResult>,
  options?: {
    priority?: number;
    timeoutMs?: number;
    strategy?: HookExecutionStrategy;
    failurePolicy?: HookFailurePolicy;
  }
): HookRegistration<TEvent, TResult> {
  return {
    hookName,
    pluginId,
    handler,
    ...options,
  };
}

/**
 * Validate a hook registration
 */
export function validateHookRegistration(registration: HookRegistration): void {
  if (!registration.hookName) {
    throw new Error('Hook name is required');
  }
  
  if (!registration.pluginId) {
    throw new Error('Plugin ID is required');
  }
  
  if (!registration.handler || typeof registration.handler !== 'function') {
    throw new Error('Handler must be a function');
  }
  
  if (registration.priority !== undefined && typeof registration.priority !== 'number') {
    throw new Error('Priority must be a number');
  }
  
  if (registration.timeoutMs !== undefined && registration.timeoutMs <= 0) {
    throw new Error('Timeout must be positive');
  }
}
