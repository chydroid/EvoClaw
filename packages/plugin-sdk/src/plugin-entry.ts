/**
 * Plugin Entry — 插件包入口契约。
 *
 * 对标 OpenClaw `@openclaw/plugin-sdk/plugin-entry`。
 *
 * EvoClaw 插件包通过 `package.json` 的 `evoclaw.extensions` 字段声明扩展点：
 *
 * ```json
 * {
 *   "name": "@my-org/telegram-channel",
 *   "evoclaw": {
 *     "extensions": ["./index.ts"]
 *   }
 * }
 * ```
 *
 * 每个扩展入口应默认导出一个 `PluginEntry`（或 channel/provider/tool entry）。
 * EvoClaw 启动时扫描 workspace 包，发现并加载这些扩展。
 */
import type { PluginManifest } from "./types.js";

// ── Entry Types ──────────────────────────────────────────────────────

/** 插件包默认导出契约。 */
export interface PluginEntry {
  /** 插件清单 */
  manifest: PluginManifest;
  /** 可选：频道扩展（若本插件提供频道） */
  channel?: unknown;
  /** 可选：provider 扩展 */
  provider?: unknown;
  /** 可选：tool 扩展列表 */
  tools?: unknown[];
  /** 可选：插件初始化钩子 */
  setup?(services: PluginEntryServices): Promise<void>;
  /** 可选：插件卸载钩子 */
  teardown?(): Promise<void>;
}

/** setup() 收到的服务集合。 */
export interface PluginEntryServices {
  /** 通过名称获取已注册的核心服务 */
  get<T>(name: string): T | undefined;
  /** 注册一个服务供其他插件使用 */
  register<T>(name: string, service: T): void;
  /** 当前插件的 logger（已绑定插件 ID 前缀） */
  logger: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
    debug(msg: string, ...args: unknown[]): void;
  };
}

/**
 * 工厂：声明一个插件入口。
 *
 * @example
 *   export default definePlugin({
 *     manifest: {
 *       id: "@my-org/my-plugin",
 *       name: "My Plugin",
 *       version: "1.0.0",
 *       description: "Does cool stuff",
 *     },
 *     async setup(services) {
 *       services.logger.info("my-plugin loaded");
 *     },
 *   });
 */
export function definePlugin(entry: PluginEntry): PluginEntry {
  return entry;
}
