/**
 * 配置 JSON Schema 合并管线（对齐 openclaw-main 的 src/config/schema.ts）。
 *
 * 设计动机：
 * - 基础配置由 core 维护
 * - 插件、渠道、技能各自声明自己的配置 schema
 * - 启动时需要把所有 schema 合并到 base，供 UI 展示与校验
 *
 * 安全要点：
 * - schema 大小上限（256KB 单个 / 2MB 总计 / 256 项）
 * - 嵌套深度上限（防止恶意 schema 嵌套导致栈溢出）
 * - 同名属性冲突时记录冲突，保留 base（防止插件覆盖核心配置）
 * - SHA256 cache key 用于增量合并
 */

import crypto from "crypto";

/** JSON Schema 片段（最小子集，足够合并使用）。 */
export interface JsonSchemaFragment {
  /** 属性名 */
  name: string;
  /** JSON Schema 定义 */
  schema: {
    type?: string;
    description?: string;
    default?: unknown;
    enum?: unknown[];
    items?: JsonSchemaFragment["schema"];
    properties?: Record<string, JsonSchemaFragment["schema"]>;
    [key: string]: unknown;
  };
  /** 来源（plugin name / channel name 等） */
  source: string;
  /** 是否敏感（UI 需要掩码） */
  sensitive?: boolean;
  /** 是否派生属性（不可被插件覆盖） */
  derived?: boolean;
}

/** 合并冲突记录。 */
export interface SchemaMergeConflict {
  /** 属性路径 */
  path: string;
  /** 基础来源 */
  baseSource: string;
  /** 冲突来源 */
  conflictingSource: string;
  /** 冲突原因 */
  reason: string;
}

/** Schema 合并结果。 */
export interface SchemaMergeResult {
  /** 合并后的 schema */
  merged: Record<string, JsonSchemaFragment>;
  /** 合并冲突列表 */
  conflicts: SchemaMergeConflict[];
  /** 总字节数 */
  totalBytes: number;
  /** SHA256 cache key */
  cacheKey: string;
  /** 是否被截断（超出大小或项数） */
  truncated: boolean;
}

/** 合并配置。 */
export interface SchemaMergeConfig {
  /** 单个 schema 最大字节数（默认 256KB） */
  maxFragmentBytes?: number;
  /** 总 schema 最大字节数（默认 2MB） */
  maxTotalBytes?: number;
  /** 最大属性项数（默认 256） */
  maxItems?: number;
  /** 最大嵌套深度（默认 10） */
  maxDepth?: number;
}

const DEFAULT_MAX_FRAGMENT_BYTES = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ITEMS = 256;
const DEFAULT_MAX_DEPTH = 10;

/**
 * 配置 Schema 合并器。
 *
 * 使用方式：
 * ```ts
 * const merger = new ConfigSchemaMerger();
 * merger.addFragment("base", "http.port", { type: "number", default: 27788 });
 * merger.addFragment("plugin:foo", "foo.enabled", { type: "boolean", default: false });
 * const result = merger.merge();
 * ```
 */
export class ConfigSchemaMerger {
  private fragments: JsonSchemaFragment[] = [];
  private config: Required<SchemaMergeConfig>;

  constructor(config: SchemaMergeConfig = {}) {
    this.config = {
      maxFragmentBytes: config.maxFragmentBytes ?? DEFAULT_MAX_FRAGMENT_BYTES,
      maxTotalBytes: config.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      maxItems: config.maxItems ?? DEFAULT_MAX_ITEMS,
      maxDepth: config.maxDepth ?? DEFAULT_MAX_DEPTH,
    };
  }

  /**
   * 添加一个 schema 片段。
   * 若片段超过单片段大小上限，拒绝并返回 false。
   */
  addFragment(fragment: JsonSchemaFragment): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(fragment.schema), "utf8");
    if (bytes > this.config.maxFragmentBytes) {
      process.stderr.write(
        `[ConfigSchemaMerger] Fragment "${fragment.name}" from "${fragment.source}" too large: ${bytes} bytes (max ${this.config.maxFragmentBytes})\n`
      );
      return false;
    }
    // 嵌套深度检查
    const depth = this.measureDepth(fragment.schema);
    if (depth > this.config.maxDepth) {
      process.stderr.write(
        `[ConfigSchemaMerger] Fragment "${fragment.name}" from "${fragment.source}" too deep: ${depth} (max ${this.config.maxDepth})\n`
      );
      return false;
    }
    this.fragments.push(fragment);
    return true;
  }

  /** 批量添加片段。 */
  addFragments(fragments: JsonSchemaFragment[]): number {
    let added = 0;
    for (const f of fragments) {
      if (this.addFragment(f)) added++;
    }
    return added;
  }

  /**
   * 合并所有片段。
   *
   * 规则：
   * - 同名属性冲突：保留先添加的（base 优先），记录冲突
   * - 派生属性：不可被覆盖，任何冲突都保留 base
   * - 超出总大小或项数：截断并标记 truncated
   */
  merge(): SchemaMergeResult {
    const merged = new Map<string, JsonSchemaFragment>();
    const conflicts: SchemaMergeConflict[] = [];
    let totalBytes = 0;
    let truncated = false;

    for (const fragment of this.fragments) {
      // 检查总项数
      if (merged.size >= this.config.maxItems) {
        truncated = true;
        break;
      }
      // 检查总字节数
      const fragBytes = Buffer.byteLength(JSON.stringify(fragment.schema), "utf8");
      if (totalBytes + fragBytes > this.config.maxTotalBytes) {
        truncated = true;
        break;
      }

      const existing = merged.get(fragment.name);
      if (existing) {
        // 冲突：保留 base，记录冲突
        const isBaseDerived = existing.derived === true;
        conflicts.push({
          path: fragment.name,
          baseSource: existing.source,
          conflictingSource: fragment.source,
          reason: isBaseDerived
            ? `Property "${fragment.name}" is derived and cannot be overridden`
            : `Property "${fragment.name}" already defined by "${existing.source}"`,
        });
        // 派生属性或 base 优先：保留 existing
        continue;
      }

      merged.set(fragment.name, fragment);
      totalBytes += fragBytes;
    }

    // 计算 cache key（基于所有片段的 sha256）
    const cacheKey = crypto
      .createHash("sha256")
      .update(JSON.stringify(this.fragments.map((f) => ({ name: f.name, source: f.source, schema: f.schema }))))
      .digest("hex");

    return {
      merged: Object.fromEntries(merged),
      conflicts,
      totalBytes,
      cacheKey,
      truncated,
    };
  }

  /** 测量 schema 嵌套深度。 */
  private measureDepth(schema: JsonSchemaFragment["schema"], currentDepth = 0): number {
    if (currentDepth > this.config.maxDepth) return currentDepth;
    if (!schema || typeof schema !== "object") return currentDepth;
    let maxChildDepth = currentDepth;
    // properties
    if (schema.properties && typeof schema.properties === "object") {
      for (const child of Object.values(schema.properties)) {
        const d = this.measureDepth(child as JsonSchemaFragment["schema"], currentDepth + 1);
        if (d > maxChildDepth) maxChildDepth = d;
      }
    }
    // items
    if (schema.items && typeof schema.items === "object") {
      const d = this.measureDepth(schema.items as JsonSchemaFragment["schema"], currentDepth + 1);
      if (d > maxChildDepth) maxChildDepth = d;
    }
    return maxChildDepth;
  }

  /** 清空所有片段。 */
  clear(): void {
    this.fragments = [];
  }

  /** 获取已添加的片段数。 */
  size(): number {
    return this.fragments.length;
  }

  /** 获取配置（用于审计）。 */
  getConfig(): Required<SchemaMergeConfig> {
    return { ...this.config };
  }
}

/**
 * 为 UI 生成配置 schema 的提示（hints）。
 * 对齐 openclaw-main 的 UI hints + sensitive hints + derived tags。
 */
export interface ConfigPropertyHint {
  /** 属性路径 */
  path: string;
  /** UI 标签 */
  label?: string;
  /** UI 描述 */
  description?: string;
  /** 是否敏感（密码框 + 掩码） */
  sensitive?: boolean;
  /** 是否派生（只读） */
  derived?: boolean;
  /** 通配符匹配（如 "channels.*.token"） */
  wildcard?: string;
  /** 枚举选项 */
  enum?: Array<{ value: unknown; label: string }>;
  /** 重新加载提示 */
  reloadRequired?: boolean;
}

/**
 * 生成 UI 提示集合。
 * 合并 base schema 与各片段的提示，支持通配符匹配。
 */
export function generateUiHints(
  fragments: JsonSchemaFragment[],
  additionalHints: ConfigPropertyHint[] = [],
): ConfigPropertyHint[] {
  const hints: ConfigPropertyHint[] = [];
  // 从 schema 片段提取提示
  for (const f of fragments) {
    hints.push({
      path: f.name,
      description: f.schema.description,
      sensitive: f.sensitive,
      derived: f.derived,
    });
  }
  // 追加额外提示
  hints.push(...additionalHints);
  return hints;
}

/**
 * 通配符匹配（用于 UI hints 的 wildcard）。
 * 支持 "channels.*.token" 匹配 "channels.feishu.token"。
 */
export function matchWildcard(pattern: string, path: string): boolean {
  const patternParts = pattern.split(".");
  const pathParts = path.split(".");
  if (patternParts.length !== pathParts.length) return false;
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === "*") continue;
    if (patternParts[i] !== pathParts[i]) return false;
  }
  return true;
}
