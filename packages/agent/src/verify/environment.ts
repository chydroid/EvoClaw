/**
 * verify/environment — 用户可编辑的验证 manifest。
 *
 * 对标 hermes-agent agent/verify/environment.py：
 *   manifest 位于 `<project>/.evoclaw/environment.json`，是用户可编辑的 source of truth。
 *   存在且有效时优先于静态检测；损坏/缺失时降级到 detectRecipe()。
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { detectRecipe, recipeToDict, recipeFromDict, type Recipe } from "./recipes";

const MANIFEST_VERSION = 1;
const MANIFEST_RELPATH = path.join(".evoclaw", "environment.json");

export function manifestPath(root: string): string {
  return path.join(root, MANIFEST_RELPATH);
}

/**
 * 加载已保存的配方；任何读取/解析/形状问题返回 null，降级到新鲜检测。
 */
export function loadManifest(root: string): Recipe | null {
  try {
    const filePath = manifestPath(root);
    const text = fs.readFileSync(filePath, "utf8");
    // 去 BOM（Node utf8 不自动去除）
    const raw = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    // 支持 {version, recipe} 包装和裸配方两种形状
    const inner = obj.recipe ?? obj;
    return recipeFromDict(inner);
  } catch {
    return null;
  }
}

/**
 * 持久化配方到 manifest 文件（原子写入）。
 */
export function saveManifest(root: string, recipe: Recipe): string {
  const filePath = manifestPath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = JSON.stringify({
    version: MANIFEST_VERSION,
    recipe: recipeToDict(recipe),
    updatedAt: new Date().toISOString(),
  }, null, 2);
  // 原子写入
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, payload, "utf-8");
  fs.renameSync(tmp, filePath);
  return filePath;
}

/**
 * 获取配方：优先 manifest，降级到静态检测。
 */
export function getRecipe(root: string): Recipe | null {
  return loadManifest(root) ?? detectRecipe(root);
}
