/**
 * Channel Runtime — 频道插件运行时上下文与注册辅助。
 *
 * 对标 OpenClaw `@openclaw/plugin-sdk/channel-runtime`。
 *
 * 频道插件通过 `defineChannel()` 工厂创建，并在加载时收到一个
 * `ChannelRuntimeContext`，从中可以访问 logger、service locator、配置、
 * 发送消息的 API 等。
 */
import type { PluginLogger, ServiceLocator } from "./types.js";
import type {
  ChannelMessage,
  ChannelSendOptions,
  ChannelCapabilities,
} from "./channel.js";

// ── Runtime Context ──────────────────────────────────────────────────

/** 频道插件加载时收到的运行时上下文。 */
export interface ChannelRuntimeContext {
  /** 频道 ID（如 "telegram"、"discord"） */
  readonly channelId: string;
  /** 插件 logger，已绑定频道前缀 */
  readonly logger: PluginLogger;
  /** 服务定位器（可访问 EventBus、ConfigManager 等） */
  readonly services: ServiceLocator;
  /** 频道配置（已合并默认值与用户配置） */
  readonly config: Readonly<Record<string, unknown>>;
  /** 发送消息的 API（由 gateway 注入） */
  readonly send: (opts: ChannelSendOptions) => Promise<{ id: string }>;
}

// ── Registration ─────────────────────────────────────────────────────

/** 频道插件工厂签名。 */
export type ChannelPluginFactory = (ctx: ChannelRuntimeContext) => ChannelRuntime | Promise<ChannelRuntime>;

/** 已加载的频道运行时句柄。 */
export interface ChannelRuntime {
  /** 频道能力声明 */
  readonly capabilities: ChannelCapabilities;
  /** 接收来自平台的消息（由 gateway 转发） */
  onMessage?(msg: ChannelMessage): void;
  /** 连接生命周期 */
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  /** 健康检查 */
  healthCheck?(): Promise<{ healthy: boolean; detail?: string }>;
}

/**
 * 频道插件定义工厂。对标 OpenClaw `defineChannel`。
 *
 * @example
 *   export default defineChannel({
 *     channelId: "telegram",
 *     capabilities: { text: true, image: true, /* ... * / },
 *     async create(ctx) {
 *       ctx.logger.info("telegram channel loaded");
 *       return {
 *         capabilities: ctx.capabilities,
 *         async connect() { /* ... * / },
 *         onMessage(msg) { /* ... * / },
 *       };
 *     },
 *   });
 */
export function defineChannel(spec: {
  channelId: string;
  capabilities: ChannelCapabilities;
  create: ChannelPluginFactory;
}): { kind: "channel"; channelId: string; create: ChannelPluginFactory; capabilities: ChannelCapabilities } {
  return {
    kind: "channel",
    channelId: spec.channelId,
    create: spec.create,
    capabilities: spec.capabilities,
  };
}

// ── Re-exports ──────────────────────────────────────────────────────

export type { ChannelMessage, ChannelSendOptions, ChannelCapabilities, ChannelConfig } from "./channel.js";

