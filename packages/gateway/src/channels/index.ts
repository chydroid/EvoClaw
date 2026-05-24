/**
 * Channel Adapters — concrete implementations for messaging platforms.
 */

export { TelegramAdapter } from "./telegram.js";
export type { TelegramConfig } from "./telegram.js";

export { DiscordAdapter } from "./discord.js";
export type { DiscordConfig } from "./discord.js";

export { SlackAdapter } from "./slack.js";
export type { SlackConfig } from "./slack.js";

export { WhatsAppAdapter } from "./whatsapp.js";
export type { WhatsAppConfig } from "./whatsapp.js";

export { FeishuAdapter } from "./feishu.js";
export type { FeishuConfig } from "./feishu.js";

export { WeChatAdapter } from "./wechat.js";
export type { WeChatConfig } from "./wechat.js";

export { QQAdapter } from "./qq.js";
export type { QQConfig } from "./qq.js";

export { MatrixAdapter } from "./matrix.js";
export type { MatrixConfig } from "./matrix.js";