/**
 * Channel 扩展样板 barrel。
 *
 * 对标 OpenClaw extensions/ 目录下的 channel 插件。
 *
 * 每个文件都是一个独立的频道扩展样板，演示 defineChannel() 的用法：
 *   - signal: Signal 端到端加密通讯
 *   - irc: IRC 经典群组聊天协议
 *
 * 使用方式（任选其一）：
 *   1. 直接导入：`import signalChannel from "@evoclaw/plugin-sdk/channels/signal"`
 *   2. 通过扩展发现：在 package.json 中声明 "evoclaw.extensions"
 */
export { default as signalChannel } from "./signal.js";
export { default as ircChannel } from "./irc.js";
