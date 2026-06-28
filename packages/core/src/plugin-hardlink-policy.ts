/**
 * 插件 hardlink 策略与起源索引（对齐 openclaw-main 的 src/plugins/hardlink-policy.ts）。
 *
 * 设计动机：
 * - hardlink 可以让一个文件"看似"位于插件根目录下，实际却与外部文件共享 inode
 * - 这会绕过插件根边界检查，让外部代码以插件身份被加载
 * - 因此对非 bundled 来源（managed/workspace/marketplace）默认拒绝 hardlink
 *
 * 例外：
 * - bundled：随产品发布，可信
 * - Nix store：OPENCLAW_NIX_MODE 下，/nix/store 是不可变包存储，hardlink 是正常布局
 */

import fs from "fs";
import path from "path";

/** 插件来源标签，决定 hardlink 策略。 */
export type PluginOrigin = "bundled" | "managed" | "workspace" | "marketplace";

/** 单个文件的 inode 信息（用于 hardlink 检测）。 */
export interface FileInodeInfo {
  path: string;
  inode: number;
  dev: number;
  nlink: number;
  size: number;
}

/** Hardlink 检测结果。 */
export interface HardlinkCheckResult {
  /** 是否拒绝该文件（hardlink 且来源不允许） */
  rejected: boolean;
  /** 拒绝原因 */
  reason?: string;
  /** 检测到的 hardlink 信息（如果有） */
  inodeInfo?: FileInodeInfo;
}

/** 起源索引条目：记录每个插件文件的来源信息。 */
export interface ProvenanceEntry {
  /** 文件相对路径（相对于插件根） */
  relativePath: string;
  /** 绝对路径 */
  absolutePath: string;
  /** 插件来源 */
  origin: PluginOrigin;
  /** 插件名 */
  pluginName: string;
  /** inode 信息 */
  inode: FileInodeInfo;
  /** 首次记录时间 */
  recordedAt: string;
  /** sha256 摘要（可选，用于完整性校验） */
  sha256?: string;
}

const NIX_STORE_ROOT = "/nix/store";

/**
 * 判定插件根目录是否位于不可变 Nix store 内。
 * 仅在 Unix 环境下有意义，Windows 直接返回 false。
 */
export function isNixStorePluginRoot(rootDir: string): boolean {
  if (process.platform === "win32") return false;
  try {
    const real = fs.realpathSync(rootDir);
    return real === NIX_STORE_ROOT || real.startsWith(`${NIX_STORE_ROOT}/`);
  } catch {
    return false;
  }
}

/**
 * 判定是否处于 Nix 模式（环境变量 OPENCLAW_NIX_MODE=1 或 OPENCLAW_NIX_MODE=true）。
 */
export function resolveIsNixMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.OPENCLAW_NIX_MODE;
  return v === "1" || v === "true" || v === "TRUE";
}

/**
 * 判定是否应该拒绝该插件根目录下的 hardlink 文件。
 *
 * 规则：
 * - bundled 来源：允许（随产品发布，可信）
 * - Nix store 路径 + Nix 模式：允许（不可变包存储）
 * - 其他来源（managed/workspace/marketplace）：拒绝
 */
export function shouldRejectHardlinkedPluginFiles(params: {
  origin: PluginOrigin;
  rootDir: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (params.origin === "bundled") {
    return false;
  }
  if (resolveIsNixMode(params.env) && isNixStorePluginRoot(params.rootDir)) {
    return false;
  }
  return true;
}

/**
 * 获取文件的 inode 信息。
 * Windows 下 nlink 通常为 1，但仍可用于检测跨设备场景。
 */
export function getFileInodeInfo(filePath: string): FileInodeInfo | null {
  try {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat) return null;
    return {
      path: filePath,
      inode: stat.ino,
      dev: stat.dev,
      nlink: stat.nlink,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

/**
 * 检测单个文件是否为 hardlink（nlink > 1）。
 * 注意：Windows 下 hardlink 检测可能不准确，nlink 通常为 1。
 */
export function isHardlinkedFile(filePath: string): boolean {
  const info = getFileInodeInfo(filePath);
  if (!info) return false;
  return info.nlink > 1;
}

/**
 * 扫描插件根目录下所有文件，检测 hardlink。
 *
 * @param rootDir 插件根目录
 * @param origin 插件来源
 * @param env 环境变量（用于 Nix 模式判定）
 * @returns 被拒绝的文件列表（如果来源不允许 hardlink）
 */
export function scanPluginForHardlinks(params: {
  rootDir: string;
  origin: PluginOrigin;
  env?: NodeJS.ProcessEnv;
}): HardlinkCheckResult[] {
  const { rootDir, origin, env } = params;
  const shouldReject = shouldRejectHardlinkedPluginFiles({ origin, rootDir, env });
  if (!shouldReject) {
    return [];
  }

  const results: HardlinkCheckResult[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 跳过 node_modules 等大目录
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const inodeInfo = getFileInodeInfo(fullPath);
        if (inodeInfo && inodeInfo.nlink > 1) {
          results.push({
            rejected: true,
            reason: `File "${path.relative(rootDir, fullPath)}" has nlink=${inodeInfo.nlink} (hardlink detected, origin=${origin})`,
            inodeInfo,
          });
        }
      }
    }
  };

  walk(rootDir);
  return results;
}

/**
 * 起源索引：记录每个插件文件的 inode 信息，用于后续完整性校验。
 * 当文件被替换为指向外部 inode 的 hardlink 时，可通过对比 inode 检测篡改。
 */
export class PluginProvenanceIndex {
  private entries = new Map<string, ProvenanceEntry>();

  /**
   * 记录插件的所有文件到起源索引。
   *
   * @param pluginName 插件名
   * @param pluginRoot 插件根目录
   * @param origin 插件来源
   * @returns 记录的条目数
   */
  recordPlugin(params: {
    pluginName: string;
    pluginRoot: string;
    origin: PluginOrigin;
    computeHash?: boolean;
  }): number {
    const { pluginName, pluginRoot, origin, computeHash } = params;
    let count = 0;
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          walk(fullPath);
        } else if (entry.isFile()) {
          const inodeInfo = getFileInodeInfo(fullPath);
          if (!inodeInfo) continue;
          const relativePath = path.relative(pluginRoot, fullPath);
          const key = `${pluginName}:${relativePath}`;
          let sha256: string | undefined;
          if (computeHash) {
            try {
              const crypto = require("crypto") as typeof import("crypto");
              const content = fs.readFileSync(fullPath);
              sha256 = crypto.createHash("sha256").update(content).digest("hex");
            } catch {
              // skip hash on read failure
            }
          }
          this.entries.set(key, {
            relativePath,
            absolutePath: fullPath,
            origin,
            pluginName,
            inode: inodeInfo,
            recordedAt: new Date().toISOString(),
            sha256,
          });
          count++;
        }
      }
    };
    walk(pluginRoot);
    return count;
  }

  /**
   * 校验插件文件是否与起源索引一致。
   * 检测项：
   * - 文件是否存在
   * - inode 是否变化（可能被替换为 hardlink）
   * - sha256 是否匹配（如果索引中有记录）
   *
   * @returns 校验失败列表
   */
  verifyPlugin(params: {
    pluginName: string;
    pluginRoot: string;
  }): Array<{ relativePath: string; issue: string }> {
    const { pluginName, pluginRoot } = params;
    const issues: Array<{ relativePath: string; issue: string }> = [];
    const prefix = `${pluginName}:`;
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      const fullPath = path.join(pluginRoot, entry.relativePath);
      const currentInode = getFileInodeInfo(fullPath);
      if (!currentInode) {
        issues.push({ relativePath: entry.relativePath, issue: "File missing" });
        continue;
      }
      if (currentInode.inode !== entry.inode.inode || currentInode.dev !== entry.inode.dev) {
        issues.push({
          relativePath: entry.relativePath,
          issue: `Inode changed: ${entry.inode.inode}-${entry.inode.dev} → ${currentInode.inode}-${currentInode.dev} (possible hardlink replacement)`,
        });
      }
      if (entry.sha256) {
        try {
          const crypto = require("crypto") as typeof import("crypto");
          const content = fs.readFileSync(fullPath);
          const currentHash = crypto.createHash("sha256").update(content).digest("hex");
          if (currentHash !== entry.sha256) {
            issues.push({ relativePath: entry.relativePath, issue: "Content hash mismatch" });
          }
        } catch {
          issues.push({ relativePath: entry.relativePath, issue: "Failed to compute hash" });
        }
      }
    }
    return issues;
  }

  /** 移除插件的所有起源索引条目。 */
  removePlugin(pluginName: string): number {
    const prefix = `${pluginName}:`;
    let removed = 0;
    for (const key of Array.from(this.entries.keys())) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** 获取插件的所有起源索引条目。 */
  getPluginEntries(pluginName: string): ProvenanceEntry[] {
    const prefix = `${pluginName}:`;
    return Array.from(this.entries.values()).filter((e) => e.pluginName === pluginName);
  }

  /** 获取所有插件的起源索引条目数（用于诊断）。 */
  size(): number {
    return this.entries.size;
  }

  /** 清空所有起源索引。 */
  clear(): void {
    this.entries.clear();
  }
}
