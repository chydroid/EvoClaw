/**
 * Extension Registry — 扩展发现与加载机制。
 *
 * 对标 OpenClaw 通过 `package.json` 的 `openclaw.extensions` 字段发现 130+
 * 扩展的机制。EvoClaw 用 `evoclaw.extensions` 字段（也兼容 `openclaw.extensions`
 * 以便复用 OpenClaw 生态）。
 *
 * 工作流：
 *   1. 启动时扫描 workspace 依赖图（或指定目录列表）
 *   2. 读取每个包的 package.json，提取 `evoclaw.extensions`（或 openclaw.extensions）
 *      字段，得到扩展入口路径列表
 *   3. 动态 `import()` 每个入口，期望默认导出为 PluginEntry（来自 plugin-sdk）
 *   4. 按 manifest.kind 分发到对应注册表（channel/provider/tool）
 *
 * 安全：
 *   - 仅扫描 node_modules 中已安装的包或 workspace 包，不执行任意路径
 *   - 扩展加载失败不阻断启动（warn + skip），与 OpenClaw 行为一致
 *   - 加载顺序按 manifest.id 确定性排序（"Prompt cache is sacred"）
 */
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ────────────────────────────────────────────────────────────

/** 已发现的扩展声明。 */
export interface DiscoveredExtension {
  /** 包名（package.json 的 name 字段） */
  packageName: string;
  /** 包版本 */
  packageVersion: string;
  /** 包根目录绝对路径 */
  packageDir: string;
  /** 扩展入口相对于 packageDir 的路径 */
  entryPath: string;
  /** 来源字段名：evoclaw.extensions 或 openclaw.extensions */
  sourceField: "evoclaw.extensions" | "openclaw.extensions";
}

/** 扩展加载结果。 */
export interface LoadedExtension {
  discovery: DiscoveredExtension;
  /** 入口模块的默认导出（应为 PluginEntry 形状） */
  entry: unknown;
  /** 加载耗时（ms） */
  loadedInMs: number;
}

/** 加载失败的扩展。 */
export interface FailedExtension {
  discovery: DiscoveredExtension;
  error: Error;
}

/** 扩展种类（从默认导出推断）。 */
export type ExtensionKind = "channel" | "provider" | "tool" | "plugin" | "unknown";

// ── Discovery ────────────────────────────────────────────────────────

/**
 * 从单个 package.json 提取扩展声明。
 *
 * 兼容 `evoclaw.extensions`（EvoClaw 原生）与 `openclaw.extensions`
 * （生态兼容）。两个字段可同时存在，合并去重。
 *
 * @returns 扩展声明列表（可能为空数组）
 */
export function extractExtensionsFromPackageJson(
  pkgJson: unknown,
  packageDir: string,
  packageName: string,
  packageVersion: string,
): DiscoveredExtension[] {
  if (!pkgJson || typeof pkgJson !== "object") return [];
  const pkg = pkgJson as Record<string, unknown>;
  const evoclawField = pkg["evoclaw"];
  const openclawField = pkg["openclaw"];
  const result: DiscoveredExtension[] = [];

  for (const [field, label] of [
    ["evoclaw.extensions", evoclawField],
    ["openclaw.extensions", openclawField],
  ] as const) {
    if (!label || typeof label !== "object") continue;
    const extensions = (label as Record<string, unknown>)["extensions"];
    if (!Array.isArray(extensions)) continue;
    for (const entry of extensions) {
      if (typeof entry !== "string") continue;
      // 去重：同 packageDir + entryPath 只保留一条（优先 evoclaw.extensions）
      const exists = result.some(
        (e) => e.entryPath === entry && e.packageDir === packageDir,
      );
      if (exists) continue;
      result.push({
        packageName,
        packageVersion,
        packageDir,
        entryPath: entry,
        sourceField: field,
      });
    }
  }
  return result;
}

/**
 * 扫描目录列表下的所有包，发现扩展声明。
 *
 * @param roots 要扫描的根目录列表（如 node_modules、packages/、extensions/）
 * @param logger 可选 logger，用于报告扫描过程中的错误
 */
export function discoverExtensions(
  roots: ReadonlyArray<string>,
  logger?: { warn(msg: string): void },
): DiscoveredExtension[] {
  const discovered: DiscoveredExtension[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      logger?.warn(`[extension-registry] failed to read ${root}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const entry of entries) {
      // 每个条目可能是一个包目录（普通包）或 scope 目录（@scope/pkg）
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith("@")) {
          // scope 目录：再下一层
          let scopeEntries: fs.Dirent[];
          try {
            scopeEntries = fs.readdirSync(entryPath, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const sub of scopeEntries) {
            if (!sub.isDirectory()) continue;
            const pkgDir = path.join(entryPath, sub.name);
            const pkgName = `${entry.name}/${sub.name}`;
            scanPackage(pkgDir, pkgName, discovered, seen, logger);
          }
        } else {
          // 普通包目录
          scanPackage(entryPath, entry.name, discovered, seen, logger);
        }
      }
    }
  }

  // 确定性排序：按 packageName（"Prompt cache is sacred"，避免扩展加载顺序不稳定）
  discovered.sort((a, b) => {
    if (a.packageName !== b.packageName) return a.packageName < b.packageName ? -1 : 1;
    return a.entryPath < b.entryPath ? -1 : a.entryPath > b.entryPath ? 1 : 0;
  });
  return discovered;
}

function scanPackage(
  pkgDir: string,
  fallbackName: string,
  out: DiscoveredExtension[],
  seen: Set<string>,
  logger?: { warn(msg: string): void },
): void {
  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) return;
  let pkgJson: unknown;
  try {
    pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  } catch (err) {
    logger?.warn(`[extension-registry] invalid package.json at ${pkgDir}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!pkgJson || typeof pkgJson !== "object") return;
  const name = (pkgJson as { name?: string }).name ?? fallbackName;
  const version = (pkgJson as { version?: string }).version ?? "0.0.0";
  const exts = extractExtensionsFromPackageJson(pkgJson, pkgDir, name, version);
  for (const ext of exts) {
    const key = `${ext.packageDir}::${ext.entryPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ext);
  }
}

// ── Loading ──────────────────────────────────────────────────────────

/**
 * 动态加载扩展入口模块。
 *
 * @param discovery 已发现的扩展声明
 * @returns 加载结果（含默认导出与耗时）
 * @throws 当入口模块不存在或导入失败时
 */
export async function loadExtension(discovery: DiscoveredExtension): Promise<LoadedExtension> {
  const start = Date.now();
  const fullPath = path.resolve(discovery.packageDir, discovery.entryPath);
  // URL 形式以兼容 ESM import（Windows 也要 file:// 前缀）
  const fileUrl = "file:///" + fullPath.replace(/\\/g, "/");
  const mod = await import(fileUrl);
  const entry = mod?.default ?? mod;
  return {
    discovery,
    entry,
    loadedInMs: Date.now() - start,
  };
}

/**
 * 批量加载扩展，失败的扩展不中断流程。
 *
 * @param discoveries 已发现的扩展声明列表
 * @param logger 可选 logger
 * @returns 成功与失败的扩展列表
 */
export async function loadExtensions(
  discoveries: ReadonlyArray<DiscoveredExtension>,
  logger?: { warn(msg: string): void },
): Promise<{ loaded: LoadedExtension[]; failed: FailedExtension[] }> {
  const loaded: LoadedExtension[] = [];
  const failed: FailedExtension[] = [];
  for (const discovery of discoveries) {
    try {
      const result = await loadExtension(discovery);
      loaded.push(result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger?.warn(`[extension-registry] failed to load ${discovery.packageName}/${discovery.entryPath}: ${error.message}`);
      failed.push({ discovery, error });
    }
  }
  return { loaded, failed };
}

// ── Classification ────────────────────────────────────────────────────

/**
 * 从已加载的扩展入口推断扩展种类。
 *
 * 规则：
 *   - entry.entry.channel 存在 → "channel"
 *   - entry.entry.provider 存在 → "provider"
 *   - entry.entry.tools 非空数组 → "tool"
 *   - entry.entry.manifest 存在 → "plugin"
 *   - 否则 → "unknown"
 */
export function classifyExtension(entry: unknown): ExtensionKind {
  if (!entry || typeof entry !== "object") return "unknown";
  const e = entry as Record<string, unknown>;
  if (e["channel"] !== undefined) return "channel";
  if (e["provider"] !== undefined) return "provider";
  if (Array.isArray(e["tools"]) && e["tools"].length > 0) return "tool";
  if (e["manifest"] !== undefined) return "plugin";
  return "unknown";
}
