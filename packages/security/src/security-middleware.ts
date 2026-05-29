import {
  ServiceRegistry,
  EventBus,
  PluginManager,
  type MessageReceivedHook,
  type MessageReceivedResult,
  type MessageSendingHook,
  type MessageSendingResult,
  type BeforeToolCallHook,
  type BeforeToolCallResult,
} from "@evoclaw/core";
import { ContentGuard, type ContentCheckResult } from "./content-guard";
import { SSRFProtection, type SSRFCheckResult } from "./ssrf-protection";

export interface SecurityMiddlewareConfig {
  enableInputGuard: boolean;
  enableOutputGuard: boolean;
  enableSSRFProtection: boolean;
  blockOnInjection: boolean;
  blockOnPII: boolean;
  blockOnSSRF: boolean;
  jwtSecretMinLength: number;
  jwtSecretWeakPatterns: string[];
}

export interface SecurityScanResult {
  passed: boolean;
  inputCheck?: ContentCheckResult;
  outputCheck?: ContentCheckResult;
  ssrfCheck?: SSRFCheckResult;
  blocked: boolean;
  reason?: string;
}

const DEFAULT_CONFIG: SecurityMiddlewareConfig = {
  enableInputGuard: true,
  enableOutputGuard: true,
  enableSSRFProtection: true,
  blockOnInjection: true,
  blockOnPII: false,
  blockOnSSRF: true,
  jwtSecretMinLength: 16,
  jwtSecretWeakPatterns: ["change-me", "secret", "dev", "default", "password"],
};

export class SecurityMiddleware {
  private contentGuard: ContentGuard;
  private ssrfProtection: SSRFProtection;
  private config: SecurityMiddlewareConfig;
  private scanLog: SecurityScanResult[];
  private maxScanLogEntries: number;
  private totalScans: number;
  private blockedScans: number;
  private injectionAttempts: number;
  private ssrfAttempts: number;

  constructor(
    registry: ServiceRegistry,
    eventBus: EventBus,
    config?: Partial<SecurityMiddlewareConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.contentGuard = new ContentGuard();
    this.ssrfProtection = new SSRFProtection();
    this.scanLog = [];
    this.maxScanLogEntries = 1000;
    this.totalScans = 0;
    this.blockedScans = 0;
    this.injectionAttempts = 0;
    this.ssrfAttempts = 0;

    registry.registerService("securityMiddleware", this);
    registry.registerService("contentGuard", this.contentGuard);
    registry.registerService("ssrfProtection", this.ssrfProtection);
  }

  registerHooks(pluginManager: PluginManager): void {
    pluginManager.registerPlugin({
      manifest: {
        name: "security-middleware",
        version: "1.0.0",
        description: "Security middleware integrating ContentGuard and SSRFProtection",
      },
      hooks: [
        {
          hookType: "message_received",
          priority: "first",
          handler: async (hook): Promise<MessageReceivedResult> => {
            const msgHook = hook as MessageReceivedHook;
            const result = this.scanInput(msgHook.text);
            if (result.blocked) {
              return { cancel: true, error: result.reason };
            }
            if (result.inputCheck?.sanitized) {
              return { text: result.inputCheck.sanitized };
            }
            return {};
          },
        },
        {
          hookType: "message_sending",
          priority: "first",
          handler: async (hook): Promise<MessageSendingResult> => {
            const msgHook = hook as MessageSendingHook;
            const result = this.scanOutput(msgHook.text);
            if (result.blocked) {
              return { cancel: true, error: result.reason };
            }
            if (result.outputCheck?.sanitized) {
              return { text: result.outputCheck.sanitized };
            }
            return {};
          },
        },
        {
          hookType: "before_tool_call",
          priority: "first",
          handler: async (hook): Promise<BeforeToolCallResult> => {
            const toolHook = hook as BeforeToolCallHook;
            if (
              toolHook.toolName === "web_fetch" ||
              toolHook.toolName === "browser_navigate"
            ) {
              const urlParam =
                toolHook.params.url ?? toolHook.params.href ?? "";
              if (typeof urlParam === "string" && urlParam.length > 0) {
                const result = await this.validateURL(urlParam);
                if (result.blocked) {
                  return { cancel: true, error: result.reason };
                }
              }
            }
            return {};
          },
        },
      ],
    });
  }

  scanInput(content: string): SecurityScanResult {
    this.totalScans++;

    if (!this.config.enableInputGuard) {
      const result: SecurityScanResult = {
        passed: true,
        blocked: false,
      };
      this.appendScanLog(result);
      return result;
    }

    const inputCheck = this.contentGuard.check(content);
    let blocked = false;
    let reason: string | undefined;

    const hasInjection = inputCheck.checks.some(
      (c) =>
        !c.passed &&
        (c.rule === "sanitization" || c.rule === "harmful_content") &&
        (c.severity === "high" || c.severity === "critical"),
    );

    if (hasInjection && this.config.blockOnInjection) {
      blocked = true;
      reason = `Injection detected: ${inputCheck.findings.join("; ")}`;
      this.injectionAttempts++;
    }

    if (
      !blocked &&
      inputCheck.piiDetected.length > 0 &&
      this.config.blockOnPII
    ) {
      blocked = true;
      reason = `PII detected: ${inputCheck.piiDetected.join(", ")}`;
    }

    if (blocked) {
      this.blockedScans++;
    }

    const result: SecurityScanResult = {
      passed: !blocked,
      inputCheck,
      blocked,
      reason,
    };
    this.appendScanLog(result);
    return result;
  }

  scanOutput(content: string): SecurityScanResult {
    this.totalScans++;

    if (!this.config.enableOutputGuard) {
      const result: SecurityScanResult = {
        passed: true,
        blocked: false,
      };
      this.appendScanLog(result);
      return result;
    }

    const outputFilter = this.contentGuard.filterOutput(content);
    let blocked = false;
    let reason: string | undefined;

    if (outputFilter.blocks.includes("system_prompt_leak")) {
      blocked = true;
      reason = "System prompt leak detected in output";
    }

    const outputCheck = this.contentGuard.check(outputFilter.filtered);

    if (outputFilter.blocks.includes("pii_in_output") && this.config.blockOnPII) {
      blocked = true;
      reason = reason
        ? `${reason}; PII detected in output`
        : "PII detected in output";
    }

    if (blocked) {
      this.blockedScans++;
    }

    const result: SecurityScanResult = {
      passed: !blocked,
      outputCheck,
      blocked,
      reason,
    };
    this.appendScanLog(result);
    return result;
  }

  async validateURL(url: string): Promise<SecurityScanResult> {
    this.totalScans++;

    if (!this.config.enableSSRFProtection) {
      const result: SecurityScanResult = {
        passed: true,
        blocked: false,
      };
      this.appendScanLog(result);
      return result;
    }

    const ssrfCheck = await this.ssrfProtection.checkURL(url);
    let blocked = false;
    let reason: string | undefined;

    if (!ssrfCheck.allowed && this.config.blockOnSSRF) {
      blocked = true;
      reason = ssrfCheck.reason ?? "SSRF protection blocked URL";
      this.ssrfAttempts++;
      this.blockedScans++;
    }

    const result: SecurityScanResult = {
      passed: !blocked,
      ssrfCheck,
      blocked,
      reason,
    };
    this.appendScanLog(result);
    return result;
  }

  validateJWTSecret(secret: string): { valid: boolean; reason?: string } {
    if (secret.length < this.config.jwtSecretMinLength) {
      return {
        valid: false,
        reason: `JWT secret is too short (${secret.length} chars, minimum ${this.config.jwtSecretMinLength})`,
      };
    }

    const lowerSecret = secret.toLowerCase();
    for (const pattern of this.config.jwtSecretWeakPatterns) {
      if (lowerSecret.includes(pattern.toLowerCase())) {
        return {
          valid: false,
          reason: `JWT secret contains weak pattern: "${pattern}"`,
        };
      }
    }

    return { valid: true };
  }

  getScanLog(limit?: number): SecurityScanResult[] {
    const n = limit ?? this.scanLog.length;
    return this.scanLog.slice(-n);
  }

  getStats(): {
    totalScans: number;
    blockedScans: number;
    injectionAttempts: number;
    ssrfAttempts: number;
  } {
    return {
      totalScans: this.totalScans,
      blockedScans: this.blockedScans,
      injectionAttempts: this.injectionAttempts,
      ssrfAttempts: this.ssrfAttempts,
    };
  }

  private appendScanLog(result: SecurityScanResult): void {
    this.scanLog.push(result);
    if (this.scanLog.length > this.maxScanLogEntries) {
      this.scanLog = this.scanLog.slice(-this.maxScanLogEntries);
    }
  }
}
