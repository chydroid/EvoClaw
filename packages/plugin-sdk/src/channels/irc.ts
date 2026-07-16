/**
 * IRC 频道扩展样板。
 *
 * 对标 OpenClaw extensions/irc。
 * IRC（Internet Relay Chat）是经典的群组聊天协议。
 *
 * 环境变量:
 *   - IRC_SERVER: IRC 服务器地址（如 irc.libera.chat）
 *   - IRC_PORT: 端口（默认 6667）
 *   - IRC_NICK: 昵称
 *   - IRC_CHANNELS: 加入的频道（逗号分隔，如 #general,#random）
 *
 * 本样板展示 defineChannel() 的用法，使用 net.Socket 连接 IRC 服务器。
 * 完整实现需要 PRIVMSG/NOTICE/CTCP 等命令处理。
 */
import { defineChannel } from "../channel-runtime.js";
import type {
  ChannelMessage,
  ChannelSendOptions,
  ChannelCapabilities,
} from "../channel.js";
import type { ChannelRuntime, ChannelRuntimeContext } from "../channel-runtime.js";

const IRC_CAPABILITIES: ChannelCapabilities = {
  text: true,
  image: false, // IRC 原生不支持图片，通过 URL 文本表示
  video: false,
  audio: false,
  document: false,
  reactions: false,
  threads: false,
  groups: true,
  interactive: false,
  maxMessageLength: 512, // IRC 协议消息字节上限
  maxFileSize: undefined,
};

interface IrcConfig {
  server: string;
  port: number;
  nick: string;
  channels: string[];
}

function resolveConfig(ctx: ChannelRuntimeContext): IrcConfig {
  const server =
    (ctx.config.server as string) ||
    process.env.IRC_SERVER ||
    "";
  const port =
    (ctx.config.port as number) ??
    (process.env.IRC_PORT ? parseInt(process.env.IRC_PORT, 10) : 6667);
  const nick =
    (ctx.config.nick as string) ||
    process.env.IRC_NICK ||
    "evoclaw-bot";
  const channelsStr =
    (ctx.config.channels as string) ||
    process.env.IRC_CHANNELS ||
    "";
  const channels = channelsStr
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  return { server, port, nick, channels };
}

export const IRC_CHANNEL_EXPORT = defineChannel({
  channelId: "irc",
  capabilities: IRC_CAPABILITIES,
  create: (ctx: ChannelRuntimeContext): ChannelRuntime => {
    const cfg = resolveConfig(ctx);

    if (!cfg.server) {
      ctx.logger.warn("irc: IRC_SERVER not set — channel disabled");
    }

    return {
      capabilities: IRC_CAPABILITIES,

      async connect(): Promise<void> {
        if (!cfg.server) return;
        ctx.logger.info(
          `irc: connecting to ${cfg.server}:${cfg.port} as ${cfg.nick}`,
        );
        // 实际实现会创建 net.Socket 并发送 NICK/USER/JOIN 命令：
        //   NICK <nick>\r\n
        //   USER <nick> 0 * :<real>\r\n
        //   JOIN #channel1,#channel2\r\n
        // 此处仅为样板占位
        if (cfg.channels.length > 0) {
          ctx.logger.info(`irc: would join ${cfg.channels.join(", ")}`);
        }
      },

      async disconnect(): Promise<void> {
        ctx.logger.info("irc: disconnecting (would send QUIT)");
      },

      onMessage(msg: ChannelMessage): void {
        ctx.logger.debug(
          `irc: inbound message in ${msg.channel} from ${msg.from}: ${msg.text.slice(0, 50)}`,
        );
      },

      async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
        if (!cfg.server) {
          return {
            healthy: false,
            detail: "IRC_SERVER not configured",
          };
        }
        // 实际实现会尝试连接 socket + 发送 PING
        // 此处返回配置已就绪
        return {
          healthy: true,
          detail: `configured for ${cfg.server}:${cfg.port} as ${cfg.nick}`,
        };
      },
    };
  },
});

export const IRC_CAPABILITIES_EXPORT = IRC_CAPABILITIES;
export default IRC_CHANNEL_EXPORT;
