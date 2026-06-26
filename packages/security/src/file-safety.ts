/**
 * File Safety — 文件写入安全护栏
 *
 * 借鉴 hermes-agent agent/file_safety.py 设计：
 * - 写入拒绝路径列表（~/.ssh/authorized_keys、.env、auth.json 等敏感文件）
 * - 写入拒绝前缀（~/.ssh、~/.aws、~/.gnupg、~/.kube 等敏感目录）
 * - 读取阻止（credential stores）
 * - 设备文件阻止（/dev/zero、/dev/random 等）
 *
 * 这些检查在文件写入/读取工具执行前进行，防止 agent 意外或恶意
 * 修改敏感文件（如注入 SSH authorized_keys、窃取 .env 中的密钥）。
 */

import * as path from "path";
import * as os from "os";

// ── Write Denylist ────────────────────────────────────────

/**
 * 写入拒绝路径列表 — 这些文件绝不应被 agent 修改。
 *
 * 借鉴 hermes-agent agent/file_safety.py build_write_denied_paths：
 *   - SSH authorized_keys（防注入公钥实现持久化后门）
 *   - .env / .env.local（防修改环境变量注入恶意配置）
 *   - auth.json / .credentials.json（防窃取/覆盖 OAuth token）
 *   - .gitconfig（防修改 git 配置注入恶意 hook）
 *   - shell 配置文件（防修改 .bashrc/.zshrc 注入恶意命令）
 */
const WRITE_DENIED_BASENAMES: ReadonlySet<string> = new Set([
  // SSH
  "authorized_keys",
  "authorized_keys2",
  "id_rsa",
  "id_ecdsa",
  "id_ed25519",
  "id_dsa",
  "known_hosts",
  // 环境/凭据
  ".env",
  ".env.local",
  ".env.production",
  ".env.staging",
  ".env.development",
  "auth.json",
  ".credentials.json",
  "credentials.json",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  // Git
  ".gitconfig",
  ".git/config",
  // Shell 配置（防注入恶意命令）
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".bash_logout",
  // Cloud 凭据
  ".aws/credentials",
  ".aws/config",
  ".kube/config",
  ".docker/config.json",
  ".gnupg/secring.gpg",
  ".gnupg/private-keys-v1.d",
]);

/**
 * 写入拒绝前缀 — 这些目录下的所有文件都不应被 agent 修改。
 *
 * 借鉴 hermes-agent agent/file_safety.py build_write_denied_prefixes。
 */
const WRITE_DENIED_DIR_NAMES: ReadonlySet<string> = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".config/gcloud",
  ".config/code",
  ".claude",
  ".hermes",
  ".evoclaw",
]);

/**
 * 读取阻止路径 — 这些文件不应被 agent 读取（含密钥）。
 */
const READ_BLOCKED_BASENAMES: ReadonlySet<string> = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.staging",
  ".env.development",
  "auth.json",
  ".credentials.json",
  "credentials.json",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".aws/credentials",
  ".kube/config",
  ".gnupg/secring.gpg",
]);

/**
 * 设备文件路径 — 读取这些文件可能消耗资源或泄露信息。
 *
 * 借鉴 hermes-agent tools/file_tools.py _BLOCKED_DEVICE_PATHS。
 */
const BLOCKED_DEVICE_PATHS: ReadonlySet<string> = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/null",
  "/dev/full",
  "/dev/tcp",
  "/dev/udp",
]);

// ── Helpers ───────────────────────────────────────────────

/** 获取用户 home 目录 */
function getHome(): string {
  return os.homedir();
}

/** 规范化路径并展开 ~ */
function resolvePath(filePath: string): string {
  if (filePath.startsWith("~/") || filePath === "~") {
    return path.resolve(getHome(), filePath.slice(2));
  }
  return path.resolve(filePath);
}

/** 获取相对于 home 的相对路径（用于匹配） */
function getRelativeToHome(filePath: string): string {
  const resolved = resolvePath(filePath);
  const home = getHome();
  const rel = path.relative(home, resolved);
  return rel;
}

// ── Public API ────────────────────────────────────────────

export interface FileSafetyResult {
  /** 是否被阻止 */
  blocked: boolean;
  /** 阻止原因 */
  reason?: string;
  /** 阻止类型 */
  type?: "write_denied" | "read_blocked" | "device_blocked";
}

/**
 * 检查文件写入是否应被阻止。
 *
 * @param filePath 要写入的文件路径
 * @returns 阻止结果
 *
 * @example
 * ```ts
 * const result = checkWriteSafety("~/.ssh/authorized_keys");
 * if (result.blocked) throw new Error(`Blocked: ${result.reason}`);
 * ```
 */
export function checkWriteSafety(filePath: string): FileSafetyResult {
  if (!filePath) return { blocked: false };

  const resolved = resolvePath(filePath);
  const basename = path.basename(resolved);
  const relToHome = getRelativeToHome(filePath);

  // 1. 检查设备文件
  if (BLOCKED_DEVICE_PATHS.has(resolved)) {
    return {
      blocked: true,
      reason: `Device file "${basename}" is blocked from writes`,
      type: "device_blocked",
    };
  }

  // 2. 检查写入拒绝 basename
  if (WRITE_DENIED_BASENAMES.has(basename)) {
    return {
      blocked: true,
      reason: `Sensitive file "${basename}" is on the write denylist`,
      type: "write_denied",
    };
  }

  // 3. 检查写入拒绝相对路径（如 .aws/credentials）
  if (WRITE_DENIED_BASENAMES.has(relToHome)) {
    return {
      blocked: true,
      reason: `Sensitive file "${relToHome}" is on the write denylist`,
      type: "write_denied",
    };
  }

  // 4. 检查写入拒绝目录
  const parts = relToHome.split(path.sep);
  for (const dirName of WRITE_DENIED_DIR_NAMES) {
    // 将条目按路径分隔符拆分为段, 检查是否作为连续子序列出现在 parts 中
    // (支持多段条目如 .config/gcloud, 同时兼容单段条目)
    const segs = dirName.split(/[/\\]/);
    if (segs.length === 0) continue;
    let matched = false;
    for (let i = 0; i + segs.length <= parts.length; i++) {
      if (segs.every((seg, j) => parts[i + j] === seg)) {
        matched = true;
        break;
      }
    }
    if (matched) {
      return {
        blocked: true,
        reason: `Path "${filePath}" is inside sensitive directory "${dirName}/"`,
        type: "write_denied",
      };
    }
  }

  return { blocked: false };
}

/**
 * 检查文件读取是否应被阻止。
 *
 * @param filePath 要读取的文件路径
 * @returns 阻止结果
 */
export function checkReadSafety(filePath: string): FileSafetyResult {
  if (!filePath) return { blocked: false };

  const resolved = resolvePath(filePath);
  const basename = path.basename(resolved);
  const relToHome = getRelativeToHome(filePath);

  // 1. 检查设备文件
  if (BLOCKED_DEVICE_PATHS.has(resolved)) {
    return {
      blocked: true,
      reason: `Device file "${basename}" is blocked from reads`,
      type: "device_blocked",
    };
  }

  // 2. 检查读取阻止 basename
  if (READ_BLOCKED_BASENAMES.has(basename)) {
    return {
      blocked: true,
      reason: `Sensitive file "${basename}" is blocked from reads (contains secrets)`,
      type: "read_blocked",
    };
  }

  // 3. 检查读取阻止相对路径
  if (READ_BLOCKED_BASENAMES.has(relToHome)) {
    return {
      blocked: true,
      reason: `Sensitive file "${relToHome}" is blocked from reads (contains secrets)`,
      type: "read_blocked",
    };
  }

  return { blocked: false };
}

/**
 * 综合文件安全检查（读取+写入）。
 */
export function checkFileSafety(
  filePath: string,
  operation: "read" | "write",
): FileSafetyResult {
  return operation === "write"
    ? checkWriteSafety(filePath)
    : checkReadSafety(filePath);
}
