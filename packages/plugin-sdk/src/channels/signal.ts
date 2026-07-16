/**
 * Signal 频道扩展样板。
 *
 * 对标 OpenClaw extensions/signal。
 * Signal 是端到端加密的即时通讯应用，通过 signal-cli REST API 接入。
 *
 * 环境变量:
 *   - SIGNAL_PHONE_NUMBER: Signal 注册的手机号（如 +8613800138000）
 *   - SIGNAL_CLI_API_BASE: signal-cli-rest-api 基地址（默认 http://localhost:8080）
 *
 * 本样板展示 defineChannel() 的用法，仅实现核心 send/onMessage/healthCheck。
 * 完整实现需要 signal-cli-rest-api 后端服务。
 */
import { defineChannel } from "../channel-runtime.js";
import type {
  ChannelMessage,
  ChannelSendOptions,
  ChannelCapabilities,
} from "../channel.js";
import type { ChannelRuntime, ChannelRuntimeContext } from "../channel-runtime.js";

const SIGNAL_CAPABILITIES: ChannelCapabilities = {
  text: true,
  image: true,
  video: false,
  audio: true,
  document: true,
  reactions: true,
  threads: false,
  groups: true,
  interactive: false,
  maxMessageLength: 9_999,
  maxFileSize: 100 * 1024 * 1024, // 100 MB
};

interface SignalConfig {
  phoneNumber: string;
  apiBase: string;
}

function resolveConfig(ctx: ChannelRuntimeContext): SignalConfig {
  const phoneNumber =
    (ctx.config.phoneNumber as string) ||
    process.env.SIGNAL_PHONE_NUMBER ||
    "";
  const apiBase =
    (ctx.config.apiBase as string) ||
    process.env.SIGNAL_CLI_API_BASE ||
    "http://localhost:8080";
  return { phoneNumber, apiBase };
}

export const SIGNAL_CHANNEL_EXPORT = defineChannel({
  channelId: "signal",
  capabilities: SIGNAL_CAPABILITIES,
  create: (ctx: ChannelRuntimeContext): ChannelRuntime => {
    const cfg = resolveConfig(ctx);

    if (!cfg.phoneNumber) {
      ctx.logger.warn(
        "signal: SIGNAL_PHONE_NUMBER not set — channel disabled",
      );
    }

    return {
      capabilities: SIGNAL_CAPABILITIES,

      async connect(): Promise<void> {
        if (!cfg.phoneNumber) return;
        ctx.logger.info(
          `signal: connecting (phone=${cfg.phoneNumber}, api=${cfg.apiBase})`,
        );
        // 实际实现会调用 signal-cli-rest-api 的 /v1/register/:number 流程
        // 此处仅为样板占位
      },

      async disconnect(): Promise<void> {
        ctx.logger.info("signal: disconnecting");
      },

      // gateway 注入 send API，onMessage 由 monitor 调用
      // 此处不实现 monitor，仅保留接口
      onMessage(msg: ChannelMessage): void {
        ctx.logger.debug(
          `signal: inbound message from ${msg.from}: ${msg.text.slice(0, 50)}`,
        );
      },

      async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
        if (!cfg.phoneNumber) {
          return {
            healthy: false,
            detail: "SIGNAL_PHONE_NUMBER not configured",
          };
        }
        try {
          // 检查 signal-cli-rest-api 健康
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5_000);
          try {
            const resp = await fetch(`${cfg.apiBase}/v1/about`, {
              signal: controller.signal,
            });
            return {
              healthy: resp.ok,
              detail: resp.ok ? "ok" : `HTTP ${resp.status}`,
            };
          } finally {
            clearTimeout(timer);
          }
        } catch (err) {
          return {
            healthy: false,
            detail: err instanceof Error ? err.message : String(err),
          };
        }
      },
    };
  },
});

export const SIGNAL_CAPABILITIES_EXPORT = SIGNAL_CAPABILITIES;
export default SIGNAL_CHANNEL_EXPORT;
