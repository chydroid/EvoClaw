/**
 * Startup Security Audit — 启动时安全审计。
 *
 * 对齐 hermes-agent 的 security_audit_startup.py：
 * - 在服务启动时自动检查常见安全配置问题
 * - 使用 _AUDIT_RAN sentinel 防止重复执行
 *
 * 检查项：
 * 1. root 用户运行警告
 * 2. gateway 绑定 0.0.0.0 但无 JWT_SECRET 或使用默认值
 * 3. Docker 容器环境检测（data 目录可能在 overlay 上）
 */

import fs from "fs";
import path from "path";

/** 安全警告严重程度 */
export type SecurityWarningSeverity = "warning" | "error";

/** 启动安全警告 */
export interface SecurityWarning {
  /** 规则 ID */
  rule: string;
  /** 严重程度 */
  severity: SecurityWarningSeverity;
  /** 警告消息 */
  message: string;
  /** 修复建议 */
  suggestion?: string;
}

/** 启动审计选项 */
export interface StartupAuditOptions {
  /** 网关监听地址 */
  gatewayHost?: string;
  /** JWT 密钥（若未提供则读取 process.env.JWT_SECRET） */
  jwtSecret?: string;
  /** 数据目录路径 */
  dataDir?: string;
}

/** 已知的默认 JWT_SECRET 值（不应在生产使用） */
const DEFAULT_JWT_SECRETS = new Set([
  "",
  "default",
  "change-me",
  "change-me-please",
  "secret",
  "your-secret-key",
  "jwt-secret",
  "test",
]);

/** Sentinel：防止审计重复执行 */
let _AUDIT_RAN = false;

/**
 * 执行启动时安全审计。
 * 使用 _AUDIT_RAN sentinel 确保审计仅运行一次；
 * 如需重跑（如测试），调用 resetAuditSentinel()。
 *
 * @returns SecurityWarning[] 警告列表（空数组表示无问题或已运行过）
 */
export function runStartupSecurityAudit(options?: StartupAuditOptions): SecurityWarning[] {
  if (_AUDIT_RAN) return [];
  _AUDIT_RAN = true;

  const warnings: SecurityWarning[] = [];

  // 检查 1：root 用户运行
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    warnings.push({
      rule: "startup-root-user",
      severity: "warning",
      message: "进程以 root 用户运行 (uid=0)",
      suggestion: "使用非 root 用户运行以提升安全性",
    });
  }

  // 检查 2：gateway 绑定 0.0.0.0 但无 JWT_SECRET 或为默认值
  const gatewayHost = options?.gatewayHost ?? process.env.EvoClaw_HOST;
  if (gatewayHost === "0.0.0.0") {
    const jwtSecret = options?.jwtSecret ?? process.env.JWT_SECRET ?? "";
    if (!jwtSecret || DEFAULT_JWT_SECRETS.has(jwtSecret)) {
      warnings.push({
        rule: "startup-gateway-public-no-secret",
        severity: "error",
        message: "网关绑定到 0.0.0.0 但未设置 JWT_SECRET 或使用默认值",
        suggestion: "设置强 JWT_SECRET 环境变量，或绑定到 127.0.0.1",
      });
    }
  }

  // 检查 3：Docker 容器环境检测
  try {
    if (fs.existsSync("/.dockerenv")) {
      const dataDir = options?.dataDir ?? path.join(process.cwd(), "data");
      const onOverlay = checkOverlayMount();
      warnings.push({
        rule: "startup-docker-env",
        severity: "warning",
        message: `运行在 Docker 容器中；数据目录 ${dataDir}${onOverlay ? " 位于 overlay 文件系统上" : ""}`,
        suggestion: "使用 named volume 挂载持久化数据，避免容器重启后数据丢失",
      });
    }
  } catch {
    // best-effort：检测失败不阻断启动
  }

  return warnings;
}

/** 重置审计 sentinel（仅用于测试） */
export function resetAuditSentinel(): void {
  _AUDIT_RAN = false;
}

/** 检查 /proc/mounts 中是否存在 overlay 挂载（仅 Linux 有效） */
function checkOverlayMount(): boolean {
  try {
    const mounts = fs.readFileSync("/proc/mounts", "utf8");
    return mounts.split("\n").some((line) => line.split(/\s+/)[2] === "overlay");
  } catch {
    return false;
  }
}
