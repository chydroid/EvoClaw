/**
 * 总体安全等级（Overall Security Level）
 *
 * 把分散在多处、彼此独立的三套安全机制——文件访问边界、shell 命令风险分级、
 * 高危操作人工审批——统一到**一个可切换的策略**上，让用户用一个开关就能整体
 * 收紧或放松权限，而不必逐项去改白名单与风险表。
 *
 * ## 三档定义
 *
 * | 等级 | 沙箱内 | 沙箱外 | 危险命令 | 高危操作审批 |
 * |---|---|---|---|---|
 * | `strict` 严格安全 | 全部允许 | **禁止**（读写都拦） | critical 及以上**硬拦** | 需要 |
 * | `normal` 一般安全 | 全部允许 | 读一般文件允许 / **写需确认** | critical 及以上需审批 | 需要 |
 * | `risky` 一定风险 | 全部允许 | 全部允许 | 仅命令注入类硬拦 | **不需要** |
 *
 * ## 不变式（任何等级都不可放宽）
 *
 * 1. 命令注入特征（换行 / 反引号 / `$(...)` 替换）**永远硬拦**，不接受人工审批——
 *    那是攻击信号，不是合法的高危操作。见 `shell-command-risk` 的 INJECTION_RULES。
 * 2. 路径词法越界与符号链接逃逸检测始终生效，安全等级只决定"越界后是拒绝还是确认"。
 */

import type { ShellRiskAssessment, ShellRiskLevel } from "./shell-command-risk";

/** 安全等级标识 */
export type SecurityLevel = "strict" | "normal" | "risky";

/** 文件访问裁决结果 */
export type FileAccessDecision = "allow" | "confirm" | "deny";

/** 安全策略 */
export interface SecurityPolicy {
  level: SecurityLevel;
  /** 界面展示名 */
  label: string;
  /** 一句话说明 */
  summary: string;
  /** 沙箱（工作区）内 */
  sandbox: { read: FileAccessDecision; write: FileAccessDecision };
  /** 沙箱外 */
  outsideSandbox: { read: FileAccessDecision; write: FileAccessDecision };
  shell: {
    /**
     * 达到该风险等级即**硬拦**（不接受人工审批）。
     * 注意 `blocked`（命令注入）在此之上，任何等级都拦。
     */
    blockAtOrAbove: Extract<ShellRiskLevel, "caution" | "critical"> | null;
    /** 达到该风险等级即需人工审批；`null` 表示无需审批 */
    approveAtOrAbove: Extract<ShellRiskLevel, "caution" | "critical"> | null;
  };
  /** 高危工具操作（file_delete / email_send / git_push 等）是否需要审批 */
  approveRiskyOperations: boolean;
}

const POLICIES: Record<SecurityLevel, SecurityPolicy> = {
  strict: {
    level: "strict",
    label: "严格安全",
    summary: "仅沙箱内文件操作，禁止访问沙箱外文件，危险操作一律禁止",
    sandbox: { read: "allow", write: "allow" },
    outsideSandbox: { read: "deny", write: "deny" },
    shell: { blockAtOrAbove: "critical", approveAtOrAbove: "caution" },
    approveRiskyOperations: true,
  },
  normal: {
    level: "normal",
    label: "一般安全",
    summary: "沙箱内全部权限；沙箱外可读一般文件，写入需用户确认；危险操作需审批",
    sandbox: { read: "allow", write: "allow" },
    outsideSandbox: { read: "allow", write: "confirm" },
    shell: { blockAtOrAbove: null, approveAtOrAbove: "critical" },
    approveRiskyOperations: true,
  },
  risky: {
    level: "risky",
    label: "一定风险",
    summary: "允许访问与操作所有文件；除格式化磁盘等极端危险命令外，无需用户审批",
    sandbox: { read: "allow", write: "allow" },
    outsideSandbox: { read: "allow", write: "allow" },
    // 仅命令注入类（blocked）硬拦；格式化磁盘等已归入 blocked/critical 的硬拦集合
    shell: { blockAtOrAbove: null, approveAtOrAbove: null },
    approveRiskyOperations: false,
  },
};

/** 全部合法等级 */
export const SECURITY_LEVELS: SecurityLevel[] = ["strict", "normal", "risky"];

/** 默认等级 */
export const DEFAULT_SECURITY_LEVEL: SecurityLevel = "normal";

/** 把任意输入规整为合法等级（无法识别时回落到默认） */
export function normalizeSecurityLevel(raw: unknown): SecurityLevel {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "strict" || s === "normal" || s === "risky") return s;
  // 兼容中文标签与常见别名
  if (s === "严格" || s === "严格安全") return "strict";
  if (s === "一定风险" || s === "风险") return "risky";
  return DEFAULT_SECURITY_LEVEL;
}

/** 取某等级的完整策略 */
export function getSecurityPolicy(level: unknown): SecurityPolicy {
  return POLICIES[normalizeSecurityLevel(level)];
}

/** 列出全部策略（供设置页渲染） */
export function listSecurityPolicies(): SecurityPolicy[] {
  return SECURITY_LEVELS.map((l) => POLICIES[l]);
}

/**
 * 运行时生效的策略。
 *
 * 用模块级 holder 而不是把配置逐层透传，是因为策略要被 file-tools / shell 工具 /
 * human-approval 等**彼此独立**的模块读取，透传会把签名撑爆。
 * 启动时由 server 调一次 `setActiveSecurityLevel()` 注入。
 */
let activePolicy: SecurityPolicy = POLICIES[DEFAULT_SECURITY_LEVEL];

/** 设置当前生效的安全等级，返回归一化后的策略 */
export function setActiveSecurityLevel(level: unknown): SecurityPolicy {
  activePolicy = getSecurityPolicy(level);
  return activePolicy;
}

/** 读取当前生效的安全策略 */
export function getActiveSecurityPolicy(): SecurityPolicy {
  return activePolicy;
}

/** 恢复默认等级（测试与配置重置用） */
export function resetActiveSecurityLevel(): void {
  activePolicy = POLICIES[DEFAULT_SECURITY_LEVEL];
}

/** 风险等级排序：blocked(4) > critical(3) > caution(2) > safe(1) */
const RISK_ORDER: Record<ShellRiskLevel, number> = {
  safe: 1,
  caution: 2,
  critical: 3,
  blocked: 4,
};

/** 该风险等级是否 >= 阈值 */
function atOrAbove(level: ShellRiskLevel, threshold: ShellRiskLevel): boolean {
  return RISK_ORDER[level] >= RISK_ORDER[threshold];
}

/**
 * 不可逆操作规则 ID 集合——这些在任何等级下都硬拦。
 *
 * 注意：这只挑选「用户明确点名要保留的极端危险操作」（格式化磁盘等）。
 * 其余 critical 规则（git 破坏性操作、强杀进程等）仍按等级策略处理，
 * 避免在 risky 档把日常开发也一并禁掉。
 */
const IRREVERSIBLE_RULES = new Set<string>([
  "fs_format",          // 格式化磁盘
  "raw_disk_write",     // 直接写磁盘设备
  "overwrite_disk_device", // 覆写磁盘设备文件
  "rm_rf_root",         // 递归强删根目录
  "rm_rf_home",         // 递归强删主目录
  "rm_rf_windows_root", // 递归强删整盘
  "rm_rf_no_preserve",  // --no-preserve-root
]);

/**
 * 裁决 shell 命令。
 * @returns `block` = 硬拦（不接受审批）；`approve` = 需人工审批；`allow` = 放行
 */
export function decideShellCommand(
  policy: SecurityPolicy,
  assessment: ShellRiskAssessment,
): "allow" | "approve" | "block" {
  // 不变式 1：命令注入永远硬拦，任何等级都不放宽
  if (assessment.level === "blocked") return "block";
  // 显式不可逆操作（格式化磁盘、删根目录、关机等）在 risky 档同样硬拦
  if (
    assessment.level === "critical" &&
    IRREVERSIBLE_RULES.has(assessment.rule ?? "")
  ) {
    return "block";
  }
  if (policy.shell.blockAtOrAbove && atOrAbove(assessment.level, policy.shell.blockAtOrAbove)) {
    return "block";
  }
  if (policy.shell.approveAtOrAbove && atOrAbove(assessment.level, policy.shell.approveAtOrAbove)) {
    return "approve";
  }
  return "allow";
}


/**
 * 裁决文件访问。
 *
 * @param insideSandbox 解析后的路径是否位于沙箱（工作区）内
 * @param write 是否是写操作（create/modify/delete）
 */
export function decideFileAccess(
  policy: SecurityPolicy,
  input: { insideSandbox: boolean; write: boolean },
): FileAccessDecision {
  const scope = input.insideSandbox ? policy.sandbox : policy.outsideSandbox;
  return input.write ? scope.write : scope.read;
}