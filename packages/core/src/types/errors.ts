/**
 * Structured error classes for EvoClaw.
 *
 * Replace ad-hoc `throw new Error("message")` with typed errors
 * so callers can discriminate and handle specific failure modes.
 */

// ── Base ──────────────────────────────────────────────────────────────────────

export class EvoError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly context?: Record<string, unknown>;

  constructor(opts: {
    message: string;
    code: string;
    retryable?: boolean;
    context?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = "EvoError";
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.context = opts.context;
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

export class ConfigError extends EvoError {
  constructor(message: string, context?: Record<string, unknown>) {
    super({ message, code: "CONFIG_ERROR", retryable: false, context });
    this.name = "ConfigError";
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export class AuthError extends EvoError {
  constructor(message: string, context?: Record<string, unknown>) {
    super({ message, code: "AUTH_ERROR", retryable: false, context });
    this.name = "AuthError";
  }
}

// ── Provider / LLM ───────────────────────────────────────────────────────────

export class ProviderError extends EvoError {
  readonly statusCode?: number;
  readonly provider?: string;

  constructor(opts: {
    message: string;
    statusCode?: number;
    provider?: string;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super({
      message: opts.message,
      code: "PROVIDER_ERROR",
      retryable: opts.retryable ?? false,
      context: { statusCode: opts.statusCode, provider: opts.provider },
      cause: opts.cause,
    });
    this.name = "ProviderError";
    this.statusCode = opts.statusCode;
    this.provider = opts.provider;
  }
}

export class RateLimitError extends ProviderError {
  readonly retryAfterMs: number;

  constructor(opts: { message: string; retryAfterMs?: number; provider?: string }) {
    super({ message: opts.message, statusCode: 429, provider: opts.provider, retryable: true });
    this.name = "RateLimitError";
    this.retryAfterMs = opts.retryAfterMs ?? 5000;
  }
}

export class ContextOverflowError extends ProviderError {
  constructor(message: string, provider?: string) {
    super({ message: message || "Context window exceeded", provider });
    this.name = "ContextOverflowError";
  }
}

// ── Task ──────────────────────────────────────────────────────────────────────

export class TaskError extends EvoError {
  readonly taskId: string;

  constructor(opts: { message: string; taskId: string; retryable?: boolean; cause?: unknown }) {
    super({
      message: opts.message,
      code: "TASK_ERROR",
      retryable: opts.retryable ?? false,
      context: { taskId: opts.taskId },
      cause: opts.cause,
    });
    this.name = "TaskError";
    this.taskId = opts.taskId;
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class PluginError extends EvoError {
  readonly pluginId: string;

  constructor(opts: { message: string; pluginId: string; cause?: unknown }) {
    super({
      message: opts.message,
      code: "PLUGIN_ERROR",
      context: { pluginId: opts.pluginId },
      cause: opts.cause,
    });
    this.name = "PluginError";
    this.pluginId = opts.pluginId;
  }
}

// ── Type guards ───────────────────────────────────────────────────────────────

export function isEvoError(err: unknown): err is EvoError {
  return err instanceof EvoError;
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

export function isRateLimitError(err: unknown): err is RateLimitError {
  return err instanceof RateLimitError;
}

export function isContextOverflowError(err: unknown): err is ContextOverflowError {
  return err instanceof ContextOverflowError;
}

export function isConfigError(err: unknown): err is ConfigError {
  return err instanceof ConfigError;
}

export function isAuthError(err: unknown): err is AuthError {
  return err instanceof AuthError;
}

export function isTaskError(err: unknown): err is TaskError {
  return err instanceof TaskError;
}

export function isPluginError(err: unknown): err is PluginError {
  return err instanceof PluginError;
}
