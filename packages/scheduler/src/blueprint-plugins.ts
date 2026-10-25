/**
 * blueprint-plugins — 插件蓝图注册（对标 hermes-agent cron/blueprint_plugins.py）
 *
 * 插件可以通过编程方式注册自动化蓝图，这些蓝图会以 `<plugin>:<key>` 命名空间
 * 出现在蓝图目录中，供用户浏览和创建定时任务。
 *
 * 关键设计（对标 hermes）：
 *   - build_plugin_blueprint：验证插件蓝图输入，命名空间化 key
 *   - list_plugin_blueprints：从插件管理器读取所有插件注册的蓝图
 *   - 插件注册的蓝图与内置蓝图合并，内置优先（同名时内置胜出）
 *   - 插件蓝图 key 格式：`<plugin_name>:<blueprint_key>`
 */

import type { AutomationBlueprint, BlueprintSlot } from "./blueprint-catalog";

// ── 类型 ──────────────────────────────────────────────

/** 插件蓝图注册接口——插件实现此接口以注册蓝图 */
export interface PluginBlueprintRegistry {
  /** 插件名称（用于命名空间） */
  pluginName: string;
  /** 插件版本 */
  pluginVersion?: string;
  /** 插件注册的蓝图列表 */
  blueprints: AutomationBlueprint[];
}

/** 插件管理器接口（duck-typing，避免硬依赖） */
export interface PluginManagerLike {
  /** 获取已注册的插件列表 */
  listPlugins?(): Array<{ name: string; version?: string }>;
  /** 获取插件的蓝图注册表 */
  getPluginBlueprints?(pluginName: string): AutomationBlueprint[] | undefined;
}

/** 插件蓝图注册错误 */
export class PluginBlueprintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginBlueprintError";
  }
}

// ── 核心函数 ──────────────────────────────────────────

/**
 * 验证插件蓝图输入并命名空间化 key。
 *
 * @param pluginName 插件名称
 * @param blueprint 原始蓝图（key 不含命名空间）
 * @returns 命名空间化后的蓝图
 * @throws PluginBlueprintError 当输入无效时
 */
export function buildPluginBlueprint(
  pluginName: string,
  blueprint: AutomationBlueprint,
): AutomationBlueprint {
  // 验证插件名称
  if (!pluginName || pluginName.trim() === "") {
    throw new PluginBlueprintError("插件名称不能为空");
  }
  if (!/^[a-z][a-z0-9-]*$/i.test(pluginName)) {
    throw new PluginBlueprintError(`插件名称格式无效: "${pluginName}"（只允许字母、数字和连字符）`);
  }

  // 验证蓝图 key
  if (!blueprint.key || blueprint.key.trim() === "") {
    throw new PluginBlueprintError("蓝图 key 不能为空");
  }
  if (!/^[a-z][a-z0-9-]*$/i.test(blueprint.key)) {
    throw new PluginBlueprintError(`蓝图 key 格式无效: "${blueprint.key}"（只允许字母、数字和连字符）`);
  }

  // 验证必填字段
  if (!blueprint.title || blueprint.title.trim() === "") {
    throw new PluginBlueprintError(`蓝图 "${blueprint.key}" 的 title 不能为空`);
  }
  if (!blueprint.scheduleTemplate || blueprint.scheduleTemplate.trim() === "") {
    throw new PluginBlueprintError(`蓝图 "${blueprint.key}" 的 scheduleTemplate 不能为空`);
  }
  if (!blueprint.promptTemplate || blueprint.promptTemplate.trim() === "") {
    throw new PluginBlueprintError(`蓝图 "${blueprint.key}" 的 promptTemplate 不能为空`);
  }

  // 验证 slot 定义
  for (const slot of blueprint.slots) {
    if (!slot.name || slot.name.trim() === "") {
      throw new PluginBlueprintError(`蓝图 "${blueprint.key}" 的 slot 缺少 name`);
    }
    if (!slot.label || slot.label.trim() === "") {
      throw new PluginBlueprintError(`蓝图 "${blueprint.key}" 的 slot "${slot.name}" 缺少 label`);
    }
  }

  // 命名空间化 key：`<plugin>:<key>`
  const namespacedKey = `${pluginName}:${blueprint.key}`;

  return {
    ...blueprint,
    key: namespacedKey,
    title: `[${pluginName}] ${blueprint.title}`,
    category: blueprint.category || `plugin-${pluginName}`,
    tags: [...(blueprint.tags ?? []), `plugin:${pluginName}`],
  };
}

/**
 * 批量构建插件蓝图。
 */
export function buildPluginBlueprints(
  pluginName: string,
  blueprints: AutomationBlueprint[],
): AutomationBlueprint[] {
  return blueprints.map((bp) => buildPluginBlueprint(pluginName, bp));
}

/**
 * 从插件管理器读取所有插件注册的蓝图。
 *
 * @param pluginManager 插件管理器（duck-typed）
 * @returns 所有插件注册的蓝图（已命名空间化）
 */
export function listPluginBlueprints(pluginManager: PluginManagerLike): AutomationBlueprint[] {
  const results: AutomationBlueprint[] = [];

  // 如果插件管理器提供了 getPluginBlueprints 方法，逐个查询
  if (pluginManager.getPluginBlueprints) {
    const plugins = pluginManager.listPlugins?.() ?? [];
    for (const plugin of plugins) {
      try {
        const blueprints = pluginManager.getPluginBlueprints(plugin.name);
        if (blueprints && Array.isArray(blueprints)) {
          for (const bp of blueprints) {
            results.push(buildPluginBlueprint(plugin.name, bp));
          }
        }
      } catch (err) {
        // 单个插件注册失败不影响其他插件
        process.stderr.write(
          `[blueprint-plugins] ⚠ 插件 ${plugin.name} 蓝图注册失败: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
  }

  return results;
}

/**
 * 合并内置蓝图和插件蓝图。
 * 内置蓝图优先（同名时内置胜出，避免插件覆盖核心功能）。
 *
 * @param builtin 内置蓝图列表
 * @param plugin 插件蓝图列表
 * @returns 合并后的蓝图列表（内置在前，插件在后）
 */
export function mergeBlueprints(
  builtin: AutomationBlueprint[],
  plugin: AutomationBlueprint[],
): AutomationBlueprint[] {
  const builtinKeys = new Set(builtin.map((b) => b.key));
  // 过滤掉与内置蓝图 key 冲突的插件蓝图
  const filteredPlugin = plugin.filter((bp) => !builtinKeys.has(bp.key));
  return [...builtin, ...filteredPlugin];
}

/**
 * 验证插件蓝图 slot 定义是否有效。
 * 返回错误列表（空数组表示全部有效）。
 */
export function validateBlueprintSlots(blueprint: AutomationBlueprint): string[] {
  const errors: string[] = [];

  for (const slot of blueprint.slots) {
    // 验证 slot 类型
    const validTypes = ["time", "enum", "text", "weekdays"];
    if (!validTypes.includes(slot.type)) {
      errors.push(`slot "${slot.name}" 的类型 "${slot.type}" 无效（有效类型: ${validTypes.join(", ")}）`);
    }

    // 验证 enum slot 必须有 options
    if (slot.type === "enum" && !slot.options) {
      errors.push(`slot "${slot.name}" 是 enum 类型但缺少 options`);
    }
  }

  // 验证 scheduleTemplate 中的占位符与 slots 匹配
  const slotNames = new Set(blueprint.slots.map((s) => s.name));
  const placeholderMatches = blueprint.scheduleTemplate.matchAll(/\$\{(\w+)(?::[^}]+)?\}/g);
  for (const match of placeholderMatches) {
    const slotName = match[1];
    if (!slotNames.has(slotName)) {
      errors.push(`scheduleTemplate 引用了未定义的 slot: "${slotName}"`);
    }
  }

  return errors;
}

/**
 * 创建插件蓝图注册表。
 * 插件在初始化时调用此函数注册自己的蓝图。
 */
export function createPluginBlueprintRegistry(
  pluginName: string,
  pluginVersion?: string,
): PluginBlueprintRegistry {
  return {
    pluginName,
    pluginVersion,
    blueprints: [],
  };
}

/**
 * 向插件注册表添加蓝图。
 */
export function addBlueprintToRegistry(
  registry: PluginBlueprintRegistry,
  blueprint: AutomationBlueprint,
): AutomationBlueprint {
  const namespaced = buildPluginBlueprint(registry.pluginName, blueprint);
  registry.blueprints.push(namespaced);
  return namespaced;
}
