/**
 * Tool Guardrails — 工具调用护栏
 *
 * 借鉴 hermes-agent 的 tool_guardrails.py 设计：
 * - 幂等/变异工具分类
 * - 工具调用签名（tool_name + args_hash）
 * - 护栏决策（allow/warn/block/halt）
 */

/** 幂等工具：重复调用无副作用 */
export const IDEMPOTENT_TOOL_NAMES = new Set([
  "file_read",
  "file_list",
  "file_search",
  "web_search",
  "web_fetch",
  "skill_find",
  "skill_list",
  "skill_view",
  "memory_search",
  "memory_get",
  "session_list",
  "session_get",
  "task_status",
  "task_list",
  "health_check",
  "metrics_get",
]);

/** 变异工具：有副作用，需谨慎 */
export const MUTATING_TOOL_NAMES = new Set([
  "file_create",
  "file_write",
  "file_modify",
  "file_delete",
  "file_move",
  "file_copy",
  "email_send",
  "scheduler_create",
  "scheduler_delete",
  "browser_navigate",
  "browser_click",
  "browser_submit_form",
  "browser_download",
  "shell_execute",
  "git_commit",
  "git_push",
  "skill_install",
  "skill_uninstall",
  "memory_store",
  "memory_delete",
  "session_delete",
  "session_archive",
  "config_update",
]);

export type ToolGuardrailAction = "allow" | "warn" | "block" | "halt";

export interface ToolCallSignature {
  toolName: string;
  argsHash: string;
}

export interface ToolGuardrailConfig {
  warningsEnabled: boolean;
  hardStopEnabled: boolean;
  /** 阻止列表中的工具完全禁用 */
  blockedTools: Set<string>;
  /** 需要人工批准的变异工具 */
  approvalRequiredTools: Set<string>;
}

export interface ToolGuardrailDecision {
  action: ToolGuardrailAction;
  reason?: string;
}

/** 默认配置 */
export const DEFAULT_GUARDRAIL_CONFIG: ToolGuardrailConfig = {
  warningsEnabled: true,
  hardStopEnabled: false,
  blockedTools: new Set(),
  approvalRequiredTools: new Set(),
};

/**
 * 计算参数的规范哈希（用于幂等性检测）
 */
export function computeArgsHash(args: Record<string, unknown>): string {
  const canonical = JSON.stringify(args, Object.keys(args).sort());
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) {
    const char = canonical.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `h${Math.abs(hash).toString(36)}`;
}

/**
 * 判断工具是否幂等
 */
export function isIdempotent(toolName: string): boolean {
  return IDEMPOTENT_TOOL_NAMES.has(toolName);
}

/**
 * 判断工具是否为变异工具
 */
export function isMutating(toolName: string): boolean {
  return MUTATING_TOOL_NAMES.has(toolName);
}

/**
 * 评估工具调用是否应被允许
 */
export function evaluateToolCall(
  toolName: string,
  args: Record<string, unknown>,
  config: ToolGuardrailConfig = DEFAULT_GUARDRAIL_CONFIG
): ToolGuardrailDecision {
  // 1. 阻止列表
  if (config.blockedTools.has(toolName)) {
    return { action: "block", reason: `Tool "${toolName}" is blocked by policy` };
  }

  // 2. 变异工具需要批准
  if (config.approvalRequiredTools.has(toolName) || isMutating(toolName)) {
    if (config.hardStopEnabled) {
      return { action: "halt", reason: `Mutating tool "${toolName}" requires approval` };
    }
    if (config.warningsEnabled) {
      return { action: "warn", reason: `Mutating tool "${toolName}" — ensure intent is correct` };
    }
  }

  // 3. 默认允许
  return { action: "allow" };
}

/**
 * ToolGuardrails 管理器
 */
export class ToolGuardrails {
  private config: ToolGuardrailConfig;
  private recentCalls = new Map<string, number[]>(); // toolName → timestamps
  private readonly duplicateWindowMs = 5_000;

  constructor(config?: Partial<ToolGuardrailConfig>) {
    this.config = { ...DEFAULT_GUARDRAIL_CONFIG, ...config };
  }

  /**
   * 检查工具调用，返回决策
   */
  check(toolName: string, args: Record<string, unknown>): ToolGuardrailDecision {
    // 检查重复调用（幂等工具在短时间内重复调用可能是 bug）
    if (isIdempotent(toolName)) {
      const now = Date.now();
      const key = `${toolName}:${computeArgsHash(args)}`;
      const timestamps = this.recentCalls.get(key) ?? [];
      const recent = timestamps.filter((t) => now - t < this.duplicateWindowMs);
      if (recent.length > 0 && this.config.warningsEnabled) {
        return { action: "warn", reason: `Duplicate idempotent call to "${toolName}" within ${this.duplicateWindowMs}ms` };
      }
      recent.push(now);
      this.recentCalls.set(key, recent);
    }

    return evaluateToolCall(toolName, args, this.config);
  }

  /** 更新配置 */
  updateConfig(config: Partial<ToolGuardrailConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** 获取当前配置 */
  getConfig(): ToolGuardrailConfig {
    return this.config;
  }

  /** 清理过期的重复调用记录 */
  cleanup(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.recentCalls) {
      const recent = timestamps.filter((t) => now - t < this.duplicateWindowMs);
      if (recent.length === 0) {
        this.recentCalls.delete(key);
      } else {
        this.recentCalls.set(key, recent);
      }
    }
  }
}
