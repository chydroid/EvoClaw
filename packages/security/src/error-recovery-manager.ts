import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { v4 as uuid } from "uuid";

export interface ErrorRecord {
  id: string;
  operation: string;
  target: string;
  error: string;
  errorType: "network" | "filesystem" | "permission" | "timeout" | "unknown";
  timestamp: Date;
  recovered: boolean;
  recoveryAttempts: number;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

export interface RecoveryAction {
  id: string;
  description: string;
  action: () => Promise<boolean>;
  priority: number;
  errorTypes: string[];
}

export class ErrorRecoveryManager {
  private errors: ErrorRecord[] = [];
  private retryConfig: RetryConfig = {
    maxRetries: 5,
    baseDelayMs: 500,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
  };
  private recoveryActions: RecoveryAction[] = [];

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.registerDefaultActions();
  }

  private registerDefaultActions(): void {
    this.recoveryActions.push({
      id: "retry_with_delay",
      description: "Retry the operation after a short delay",
      action: async () => {
        await this.delay(1000);
        return true;
      },
      priority: 1,
      errorTypes: ["network", "timeout"],
    });

    this.recoveryActions.push({
      id: "retry_with_backoff",
      description: "Retry the operation with exponential backoff",
      action: async () => {
        return true;
      },
      priority: 2,
      errorTypes: ["network", "timeout", "unknown"],
    });

    this.recoveryActions.push({
      id: "check_permissions",
      description: "Verify and request necessary permissions",
      action: async () => {
        return false;
      },
      priority: 3,
      errorTypes: ["permission"],
    });

    this.recoveryActions.push({
      id: "validate_path",
      description: "Validate and correct the file path",
      action: async () => {
        return true;
      },
      priority: 2,
      errorTypes: ["filesystem"],
    });
  }

  classifyError(err: unknown): ErrorRecord["errorType"] {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();

    if (
      message.includes("enoent") ||
      message.includes("not found") ||
      message.includes("no such file")
    ) {
      return "filesystem";
    }

    if (
      message.includes("permission") ||
      message.includes("denied") ||
      message.includes("unauthorized") ||
      message.includes("forbidden") ||
      message.includes("eacces") ||
      message.includes("eperm")
    ) {
      return "permission";
    }

    if (
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("etimedout")
    ) {
      return "timeout";
    }

    if (
      message.includes("network") ||
      message.includes("econnrefused") ||
      message.includes("enotfound") ||
      message.includes("socket") ||
      message.includes("dns") ||
      message.includes("econnreset")
    ) {
      return "network";
    }

    return "unknown";
  }

  recordError(
    operation: string,
    target: string,
    err: unknown
  ): ErrorRecord {
    const errorType = this.classifyError(err);
    const message = err instanceof Error ? err.message : String(err);

    const record: ErrorRecord = {
      id: uuid().slice(0, 8),
      operation,
      target,
      error: message,
      errorType,
      timestamp: new Date(),
      recovered: false,
      recoveryAttempts: 0,
    };

    this.errors.push(record);

    if (this.errors.length > 200) {
      this.errors = this.errors.slice(-150);
    }

    this.eventBus.publish(
      "error.recorded",
      { errorId: record.id, operation, target, errorType, message },
      "error-recovery-manager"
    );

    return record;
  }

  async executeWithRetry<T>(
    operation: string,
    target: string,
    fn: () => Promise<T>,
    config?: Partial<RetryConfig>
  ): Promise<T> {
    const cfg = { ...this.retryConfig, ...config };
    let lastError: unknown;

    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      try {
        const result = await fn();

        if (attempt > 0) {
          this.eventBus.publish(
            "error.recovered",
            { operation, target, attempts: attempt },
            "error-recovery-manager"
          );
        }

        return result;
      } catch (err) {
        lastError = err;

        if (attempt < cfg.maxRetries) {
          this.recordError(operation, target, err);

          const delay = Math.min(
            cfg.baseDelayMs * Math.pow(cfg.backoffMultiplier, attempt),
            cfg.maxDelayMs
          );

          this.eventBus.publish(
            "error.retrying",
            {
              operation,
              target,
              attempt: attempt + 1,
              maxRetries: cfg.maxRetries,
              delayMs: delay,
              error: err instanceof Error ? err.message : String(err),
            },
            "error-recovery-manager"
          );

          await this.delay(delay);

          for (const action of this.recoveryActions.sort(
            (a, b) => a.priority - b.priority
          )) {
            const errorType = this.classifyError(err);
            if (action.errorTypes.includes(errorType)) {
              try {
                await action.action();
              } catch {
                // Continue to next action
              }
            }
          }
        }
      }
    }

    const errorRecord = this.recordError(operation, target, lastError);

    this.eventBus.publish(
      "error.max_retries_exceeded",
      { operation, target, errorId: errorRecord.id, maxRetries: cfg.maxRetries },
      "error-recovery-manager"
    );

    throw new Error(
      `${operation} failed after ${cfg.maxRetries + 1} attempts: ${errorRecord.error}`
    );
  }

  async diagnoseAndRecover(
    operation: string,
    target: string,
    errorType: ErrorRecord["errorType"]
  ): Promise<boolean> {
    const relevantActions = this.recoveryActions
      .filter((a) => a.errorTypes.includes(errorType))
      .sort((a, b) => a.priority - b.priority);

    for (const action of relevantActions) {
      try {
        const success = await action.action();
        if (success) {
          this.eventBus.publish(
            "error.recovery_successful",
            { operation, target, errorType, action: action.id },
            "error-recovery-manager"
          );
          return true;
        }
      } catch {
        continue;
      }
    }

    this.eventBus.publish(
      "error.recovery_failed",
      { operation, target, errorType },
      "error-recovery-manager"
    );

    return false;
  }

  getRecentErrors(limit: number = 50): ErrorRecord[] {
    return this.errors.slice(-limit);
  }

  getErrorsByType(errorType: ErrorRecord["errorType"]): ErrorRecord[] {
    return this.errors.filter((e) => e.errorType === errorType);
  }

  getErrorStats(): {
    total: number;
    byType: Record<string, number>;
    recovered: number;
    unrecovered: number;
  } {
    const byType: Record<string, number> = {};
    let recovered = 0;
    let unrecovered = 0;

    for (const err of this.errors) {
      byType[err.errorType] = (byType[err.errorType] || 0) + 1;
      if (err.recovered) recovered++;
      else unrecovered++;
    }

    return {
      total: this.errors.length,
      byType,
      recovered,
      unrecovered,
    };
  }

  clearErrors(): void {
    this.errors = [];
  }

  configureRetry(config: Partial<RetryConfig>): void {
    this.retryConfig = { ...this.retryConfig, ...config };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}