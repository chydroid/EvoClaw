/**
 * Path Security — 路径安全工具
 *
 * 借鉴 hermes-agent 的 path_security.py 设计：
 * - validateWithinDir：确保路径在指定目录内，防 .. 穿越
 * - hasTraversalComponent：快速检测路径遍历组件
 * - sanitizePath：规范化路径并移除危险组件
 */

import * as path from "path";

/**
 * 快速检测路径是否包含遍历组件（..）
 */
export function hasTraversalComponent(inputPath: string): boolean {
  const parts = inputPath.split(/[/\\]/);
  return parts.some((p) => p === "..");
}

/**
 * 验证路径是否在指定基础目录内。
 * 使用 resolve + relative_to 确保路径不会逃逸。
 *
 * @param basePath 基础目录（必须存在）
 * @param targetPath 要验证的目标路径
 * @throws Error 如果路径逃逸出基础目录
 */
export function validateWithinDir(basePath: string, targetPath: string): string {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(resolvedBase, targetPath);

  // 计算 relative 路径，如果以 .. 开头则说明逃逸
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Path traversal detected: "${targetPath}" resolves outside of "${basePath}" (relative: "${relative}")`
    );
  }

  return resolvedTarget;
}

/**
 * 安全地拼接路径，确保结果在基础目录内。
 * 如果路径逃逸，返回 null 而非抛错。
 */
export function safeJoin(basePath: string, ...segments: string[]): string | null {
  const target = path.join(basePath, ...segments);
  try {
    return validateWithinDir(basePath, target);
  } catch {
    return null;
  }
}

/**
 * 检测路径中是否包含 null 字节（防止 null byte injection）
 */
export function hasNullByte(inputPath: string): boolean {
  return inputPath.includes("\0");
}

/**
 * 综合路径安全检查
 * @returns 规范化后的安全路径，或 null（不安全）
 */
export function sanitizePath(basePath: string, inputPath: string): string | null {
  // null 字节检测
  if (hasNullByte(inputPath)) return null;

  // 遍历组件检测
  if (hasTraversalComponent(inputPath)) {
    // 尝试 resolve，看是否在基础目录内
    try {
      return validateWithinDir(basePath, inputPath);
    } catch {
      return null;
    }
  }

  // 正常路径
  return path.resolve(basePath, inputPath);
}

/**
 * 检查路径是否为符号链接（潜在安全风险）
 */
export function isSymlinkSync(filePath: string): boolean {
  try {
    const fs = require("fs");
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}
