import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { EventBus } from "@evoclaw/core";
import { AgentModelExecutor } from "@evoclaw/agent";

const WEIXIN_API_BASE = "https://ilinkai.weixin.qq.com/";
const PLUGIN_VERSION = "2.4.4";

interface WeixinAccount {
  token: string;
  baseUrl: string;
  cdnBaseUrl?: string;
  userId?: string;
  savedAt: string;
}

interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  text_item?: { text?: string };
  image_item?: {
    media?: { encrypt_query_param?: string; aes_key?: string; encrypt_type?: number; full_url?: string };
    thumb_media?: Record<string, unknown>;
    aeskey?: string;
    url?: string;
    mid_size?: number;
    thumb_size?: number;
    hd_size?: number;
  };
  voice_item?: { text?: string; media?: Record<string, unknown>; encode_type?: number; playtime?: number };
  file_item?: Record<string, unknown>;
  video_item?: {
    media?: { encrypt_query_param?: string; aes_key?: string; encrypt_type?: number; full_url?: string };
    video_size?: number;
    play_length?: number;
    thumb_media?: { encrypt_query_param?: string; aes_key?: string; encrypt_type?: number; full_url?: string };
    thumb_size?: number;
    thumb_height?: number;
    thumb_width?: number;
  };
}

interface WeixinUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  sync_buf?: string;
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

/**
 * 生成随机 X-WECHAT-UIN 头
 */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

/**
 * 编码客户端版本号
 */
function buildClientVersion(version: string): number {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/**
 * 构建微信 iLink API 请求头
 */
function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(buildClientVersion(PLUGIN_VERSION)),
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

export class WeixinPluginAdapter {
  private eventBus: EventBus;
  private agentExecutor: AgentModelExecutor;
  private runningMonitors: Map<string, { controller: AbortController }> = new Map();

  constructor(eventBus: EventBus, agentExecutor: AgentModelExecutor) {
    this.eventBus = eventBus;
    this.agentExecutor = agentExecutor;
  }

  /**
   * 查找已配置的微信账户
   */
  findConfiguredAccounts(): string[] {
    try {
      const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
      const indexPath = path.join(stateDir, "openclaw-weixin", "accounts.json");

      if (!fs.existsSync(indexPath)) {
        console.log("[Weixin] No accounts index found");
        return [];
      }

      const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      console.log(`[Weixin] Found ${index.length} accounts in index`);
      return index;
    } catch (err) {
      console.error("[Weixin] Failed to find configured accounts:", err);
      return [];
    }
  }

  /**
   * 加载微信账户配置
   */
  loadAccount(accountId: string): WeixinAccount | null {
    if (accountId.includes("..") || accountId.includes("/") || accountId.includes("\\")) {
      console.error(`[Weixin] Invalid accountId (path traversal detected): ${accountId}`);
      return null;
    }
    try {
      const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
      const accountsDir = path.join(stateDir, "openclaw-weixin", "accounts");
      const accountFile = path.join(accountsDir, `${accountId}.json`);

      if (!fs.existsSync(accountFile)) {
        console.log(`[Weixin] Account file not found: ${accountFile}`);
        return null;
      }

      const account = JSON.parse(fs.readFileSync(accountFile, "utf-8"));
      console.log(`[Weixin] Loaded account: ${accountId}`);
      return account;
    } catch (err) {
      console.error(`[Weixin] Failed to load account ${accountId}:`, err);
      return null;
    }
  }

  /**
   * 从微信获取更新（长轮询）
   */
  private async getUpdates(account: WeixinAccount, lastSeq: string, abortSignal?: AbortSignal): Promise<WeixinUpdatesResponse | { expired: true } | null> {
    try {
      const baseUrl = (account.baseUrl || WEIXIN_API_BASE).replace(/\/+$/, "");
      const url = `${baseUrl}/ilink/bot/getupdates`;
      const response = await fetch(url, {
        method: "POST",
        headers: buildHeaders(account.token),
        body: JSON.stringify({
          get_updates_buf: lastSeq,
          base_info: {
            channel_version: PLUGIN_VERSION,
            bot_agent: "EvoClaw",
          },
        }),
        signal: abortSignal,
      });

      if (!response.ok) {
        console.error(`[Weixin] getupdates failed: ${response.status}`);
        return null;
      }

      const data = await response.json() as WeixinUpdatesResponse;

      // 首次请求时打印完整响应结构
      if (!lastSeq) {
        console.log(`[Weixin] First getupdates response keys: ${Object.keys(data).join(", ")}`);
        console.log(`[Weixin] Full first response (truncated): ${JSON.stringify(data).substring(0, 500)}`);
      }

      // 只在有消息、错误或首次时打印日志
      if (data.ret !== 0 && data.ret !== undefined || data.errcode !== undefined || (data.msgs && data.msgs.length > 0) || !lastSeq) {
        console.log(`[Weixin] getupdates response: ret=${data.ret}, errcode=${data.errcode}, msgs=${data.msgs?.length ?? 0}, buf_len=${data.get_updates_buf?.length ?? 0}`);
      }

      // 检查 session 过期
      if (data.errcode === -14) {
        console.warn("[Weixin] Session expired (errcode=-14), need to re-scan QR code");
        return { expired: true as const };
      }

      if (data.ret !== undefined && data.ret !== 0 && data.errcode !== 0) {
        console.error(`[Weixin] getupdates error: ret=${data.ret}, errcode=${data.errcode}, errmsg=${data.errmsg}`);
        return null;
      }

      return data;
    } catch (err: any) {
      if (err?.name === "AbortError") return null;
      console.error("[Weixin] getupdates error:", err);
      return null;
    }
  }

  /**
   * 发送微信消息
   */
  private async sendMessage(account: WeixinAccount, toUserId: string, text: string, contextToken?: string): Promise<boolean> {
    try {
      const baseUrl = (account.baseUrl || WEIXIN_API_BASE).replace(/\/+$/, "");
      const url = `${baseUrl}/ilink/bot/sendmessage`;
      const clientId = `openclaw-weixin-${crypto.randomUUID()}`;
      const runId = crypto.randomUUID();

      const body = {
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: clientId,
          message_type: 2,  // BOT
          message_state: 2, // FINISH
          item_list: [
            {
              type: 1, // TEXT
              text_item: {
                text: text,
              },
            },
          ],
          context_token: contextToken || undefined,
          run_id: runId,
        },
        base_info: {
          channel_version: PLUGIN_VERSION,
          bot_agent: "EvoClaw",
        },
      };

      console.log(`[Weixin] Sending message to ${toUserId}, context_token=${contextToken ? contextToken.substring(0, 20) + "..." : "NONE"}`);

      const response = await fetch(url, {
        method: "POST",
        headers: buildHeaders(account.token),
        body: JSON.stringify(body),
      });

      const respText = await response.text();
      console.log(`[Weixin] sendmessage response: status=${response.status}, body=${respText.substring(0, 200)}`);

      if (!response.ok) {
        console.error(`[Weixin] sendmessage failed: ${response.status} ${respText}`);
        return false;
      }

      return true;
    } catch (err) {
      console.error("[Weixin] sendmessage error:", err);
      return false;
    }
  }

  /**
   * 处理单条消息
   */
  private async processMessage(account: WeixinAccount, message: WeixinMessage): Promise<void> {
    const fromUserId = message.from_user_id;
    if (!fromUserId) {
      console.log("[Weixin] Message missing from_user_id");
      return;
    }

    // 只处理用户发送的消息 (message_type=1)
    if (message.message_type !== undefined && message.message_type !== 1) {
      return;
    }

    // 只处理已完成的消息 (message_state=2)
    if (message.message_state !== undefined && message.message_state !== 2) {
      return;
    }

    // 提取文本内容（支持文本消息和语音转文字）
    let text = "";
    let isVoice = false;
    let hasImage = false;
    let hasVideo = false;
    if (message.item_list) {
      for (const item of message.item_list) {
        // 文本消息
        if (item.type === 1 && item.text_item?.text) {
          text = item.text_item.text;
          break;
        }
        // 语音消息：优先使用微信服务端自动识别的文字
        if (item.type === 3 && item.voice_item?.text) {
          text = item.voice_item.text;
          isVoice = true;
          break;
        }
        // 图片消息
        if (item.type === 2 && item.image_item) {
          hasImage = true;
        }
        // 视频消息
        if (item.type === 5 && item.video_item) {
          hasVideo = true;
        }
      }
    }

    // 下载图片并转为 base64 data URI（用于 Vision）
    let imageAttachment: { name: string; type: string; size: number; data: string } | undefined;
    if (hasImage) {
      for (const item of message.item_list!) {
        if (item.type === 2 && item.image_item) {
          try {
            const imageData = await this.downloadImage(account, item.image_item);
            if (imageData) {
              imageAttachment = {
                name: "image.jpg",
                type: "image/jpeg",
                size: imageData.length,
                data: `data:image/jpeg;base64,${imageData.toString("base64")}`,
              };
              console.log(`[Weixin] Downloaded image (${imageData.length} bytes) for vision`);
            }
          } catch (err) {
            console.error("[Weixin] Failed to download image:", err);
          }
          break;
        }
      }
    }

    // 下载视频缩略图并转为 base64 data URI（用于 Vision）
    if (hasVideo && !imageAttachment) {
      for (const item of message.item_list!) {
        if (item.type === 5 && item.video_item) {
          try {
            const thumbData = await this.downloadVideoThumb(account, item.video_item);
            if (thumbData) {
              const playLength = item.video_item.play_length || 0;
              imageAttachment = {
                name: "video_thumb.jpg",
                type: "image/jpeg",
                size: thumbData.length,
                data: `data:image/jpeg;base64,${thumbData.toString("base64")}`,
              };
              console.log(`[Weixin] Downloaded video thumbnail (${thumbData.length} bytes, play_length=${playLength}s) for vision`);
            }
          } catch (err) {
            console.error("[Weixin] Failed to download video thumbnail:", err);
          }
          break;
        }
      }
    }

    // 图片/视频消息没有文本时，设置默认提示
    if (!text && hasImage) {
      text = imageAttachment ? "请描述这张图片" : "我发了一张图片";
    } else if (!text && hasVideo) {
      const playLength = message.item_list?.find(i => i.type === 5)?.video_item?.play_length;
      const durationStr = playLength ? `，时长${Math.round(playLength / 1000)}秒` : "";
      text = imageAttachment ? `我发了一个视频${durationStr}，请根据截图描述` : `我发了一个视频${durationStr}`;
    }

    if (!text) {
      // 语音消息但没有转文字结果，提示用户
      if (message.item_list?.some(item => item.type === 3)) {
        console.log("[Weixin] Voice message without text transcription, asking user to type");
        await this.sendMessage(
          account,
          fromUserId,
          "抱歉，我暂时无法识别语音消息，请用文字发送。",
          message.context_token
        );
      } else {
        console.log("[Weixin] No text content in message");
      }
      return;
    }

    if (isVoice) {
      console.log(`[Weixin] Voice message from ${fromUserId} (transcribed): ${text}`);
    } else if (hasVideo) {
      console.log(`[Weixin] Video message from ${fromUserId}: ${text}`);
    } else if (hasImage) {
      console.log(`[Weixin] Image message from ${fromUserId}: ${text}`);
    } else {
      console.log(`[Weixin] Received from ${fromUserId}: ${text}`);
    }
    console.log(`[Weixin] Message details: type=${message.message_type}, state=${message.message_state}, context_token=${message.context_token ? message.context_token.substring(0, 30) + "..." : "NONE"}`);

    // 发送"正在输入"提示
    this.sendTyping(account, fromUserId, message.context_token).catch(() => {});
    // 每5秒保活"正在输入"状态
    const typingKeepalive = setInterval(() => {
      this.sendTyping(account, fromUserId, message.context_token).catch(() => {});
    }, 5000);

    try {
      const chatContext: Record<string, unknown> = {
        sessionId: `weixin-${fromUserId}`,
        channel: "weixin",
        peerId: fromUserId,
      };
      if (imageAttachment) {
        chatContext.attachments = [imageAttachment];
      }
      console.log(`[Weixin] Calling agentExecutor.chat() for session weixin-${fromUserId}, message: "${text.slice(0, 80)}"`);
      const result = await this.agentExecutor.chat(text, chatContext);

      clearInterval(typingKeepalive);
      this.sendTypingCancel(account, fromUserId, message.context_token).catch(() => {});

      if (result.reply) {
        const replyText = typeof result.reply === "string" ? result.reply : String(result.reply);
        const isFallback = replyText.includes("所有已启用的模型提供商均未能响应");
        if (isFallback) {
          console.error(`[Weixin] LLM fallback response for ${fromUserId}. tokensUsed=${result.tokensUsed}, duration=${result.duration}ms. Retrying with fresh session...`);
          const retrySessionId = `weixin-${fromUserId}-retry-${Date.now()}`;
          const retryContext: Record<string, unknown> = {
            sessionId: retrySessionId,
            channel: "weixin",
            peerId: fromUserId,
          };
          try {
            const retryResult = await this.agentExecutor.chat(text, retryContext);
            const retryReply = typeof retryResult.reply === "string" ? retryResult.reply : String(retryResult.reply);
            const retryIsFallback = retryReply.includes("所有已启用的模型提供商均未能响应");
            if (!retryIsFallback) {
              console.log(`[Weixin] Retry succeeded for ${fromUserId} with fresh session`);
              await this.sendMessage(account, fromUserId, retryReply, message.context_token);
              return;
            }
            console.error(`[Weixin] Retry also failed for ${fromUserId}. LLM providers may be down.`);
          } catch (retryErr) {
            console.error(`[Weixin] Retry error for ${fromUserId}:`, retryErr);
          }
          await this.sendMessage(account, fromUserId, replyText, message.context_token);
        } else {
          console.log(`[Weixin] Sending reply to ${fromUserId}: ${replyText.substring(0, 80)}...`);
          await this.sendMessage(account, fromUserId, replyText, message.context_token);
        }
      }
    } catch (err) {
      clearInterval(typingKeepalive);
      this.sendTypingCancel(account, fromUserId, message.context_token).catch(() => {});
      console.error("[Weixin] Failed to process message:", err);
      await this.sendMessage(
        account,
        fromUserId,
        "抱歉，处理您的消息时出现了错误。",
        message.context_token
      );
    }
  }

  // typing_ticket 缓存（按用户ID）
  private typingTicketCache = new Map<string, { ticket: string; expiresAt: number }>();

  /**
   * 从微信 CDN 下载并解密图片
   */
  private async downloadImage(
    account: WeixinAccount,
    imageItem: NonNullable<MessageItem["image_item"]>
  ): Promise<Buffer | null> {
    try {
      const media = imageItem.media;
      if (!media) return null;

      // 构建下载 URL
      const fullUrl = media.full_url;
      if (!fullUrl && !media.encrypt_query_param) {
        console.log("[Weixin] Image has no download URL");
        return null;
      }

      // 解析 AES 密钥：优先使用 image_item.aeskey（hex 格式），否则用 media.aes_key（base64）
      let aesKey: Buffer | null = null;
      if (imageItem.aeskey) {
        aesKey = Buffer.from(imageItem.aeskey, "hex");
      } else if (media.aes_key) {
        aesKey = Buffer.from(media.aes_key, "base64");
      }

      // 下载图片
      const cdnBaseUrl = (account.cdnBaseUrl || "https://wxapp.qq.com").replace(/\/+$/, "");
      let downloadUrl: string;
      if (fullUrl) {
        downloadUrl = fullUrl;
      } else if (media.encrypt_query_param) {
        downloadUrl = `${cdnBaseUrl}/cgi-bin/micromsg-bin/getcdndownlinkcgi?${media.encrypt_query_param}`;
      } else {
        return null;
      }

      const response = await fetch(downloadUrl);
      if (!response.ok) {
        console.error(`[Weixin] Image download failed: ${response.status}`);
        return null;
      }

      const encrypted = Buffer.from(await response.arrayBuffer());

      // 解密（AES-128-ECB）
      if (aesKey && aesKey.length === 16) {
        const decipher = crypto.createDecipheriv("aes-128-ecb", aesKey, null);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]);
      }

      // 无密钥则直接返回原始数据（可能是明文）
      return encrypted;
    } catch (err) {
      console.error("[Weixin] downloadImage error:", err);
      return null;
    }
  }

  /**
   * 从微信 CDN 下载并解密视频缩略图
   */
  private async downloadVideoThumb(
    account: WeixinAccount,
    videoItem: NonNullable<MessageItem["video_item"]>
  ): Promise<Buffer | null> {
    try {
      const thumbMedia = videoItem.thumb_media;
      if (!thumbMedia) {
        console.log("[Weixin] Video has no thumbnail media");
        return null;
      }

      const fullUrl = thumbMedia.full_url;
      if (!fullUrl && !thumbMedia.encrypt_query_param) {
        console.log("[Weixin] Video thumbnail has no download URL");
        return null;
      }

      // 解析 AES 密钥
      let aesKey: Buffer | null = null;
      if (thumbMedia.aes_key) {
        const decoded = Buffer.from(thumbMedia.aes_key, "base64");
        if (decoded.length === 16) {
          aesKey = decoded;
        } else if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
          aesKey = Buffer.from(decoded.toString("ascii"), "hex");
        }
      }

      // 下载缩略图
      const cdnBaseUrl = (account.cdnBaseUrl || "https://wxapp.qq.com").replace(/\/+$/, "");
      let downloadUrl: string;
      if (fullUrl) {
        downloadUrl = fullUrl;
      } else if (thumbMedia.encrypt_query_param) {
        downloadUrl = `${cdnBaseUrl}/cgi-bin/micromsg-bin/getcdndownlinkcgi?${thumbMedia.encrypt_query_param}`;
      } else {
        return null;
      }

      const response = await fetch(downloadUrl);
      if (!response.ok) {
        console.error(`[Weixin] Video thumbnail download failed: ${response.status}`);
        return null;
      }

      const encrypted = Buffer.from(await response.arrayBuffer());

      // 解密（AES-128-ECB）
      if (aesKey && aesKey.length === 16) {
        const decipher = crypto.createDecipheriv("aes-128-ecb", aesKey, null);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]);
      }

      return encrypted;
    } catch (err) {
      console.error("[Weixin] downloadVideoThumb error:", err);
      return null;
    }
  }

  /**
   * 获取用户的 typing_ticket（通过 getconfig API）
   */
  private async getTypingTicket(account: WeixinAccount, userId: string, contextToken?: string): Promise<string> {
    const cached = this.typingTicketCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.ticket;
    }

    try {
      const baseUrl = (account.baseUrl || WEIXIN_API_BASE).replace(/\/+$/, "");
      const url = `${baseUrl}/ilink/bot/getconfig`;
      const response = await fetch(url, {
        method: "POST",
        headers: buildHeaders(account.token),
        body: JSON.stringify({
          ilink_user_id: userId,
          context_token: contextToken || undefined,
          base_info: {
            channel_version: PLUGIN_VERSION,
            bot_agent: "EvoClaw",
          },
        }),
      });

      if (response.ok) {
        const data = await response.json() as { ret?: number; typing_ticket?: string };
        if (data.ret === 0 && data.typing_ticket) {
          // 缓存 24 小时
          this.typingTicketCache.set(userId, {
            ticket: data.typing_ticket,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          });
          console.log(`[Weixin] Got typing_ticket for ${userId}`);
          return data.typing_ticket;
        }
      }
    } catch { /* ignore */ }

    return "";
  }

  /**
   * 发送"正在输入"提示
   */
  private async sendTyping(account: WeixinAccount, toUserId: string, contextToken?: string): Promise<void> {
    try {
      const typingTicket = await this.getTypingTicket(account, toUserId, contextToken);
      const baseUrl = (account.baseUrl || WEIXIN_API_BASE).replace(/\/+$/, "");
      const url = `${baseUrl}/ilink/bot/sendtyping`;
      await fetch(url, {
        method: "POST",
        headers: buildHeaders(account.token),
        body: JSON.stringify({
          ilink_user_id: toUserId,
          typing_ticket: typingTicket || undefined,
          status: 1, // TYPING
          base_info: {
            channel_version: PLUGIN_VERSION,
            bot_agent: "EvoClaw",
          },
        }),
      });
    } catch { /* best-effort */ }
  }

  /**
   * 取消"正在输入"提示
   */
  private async sendTypingCancel(account: WeixinAccount, toUserId: string, contextToken?: string): Promise<void> {
    try {
      const typingTicket = await this.getTypingTicket(account, toUserId, contextToken);
      const baseUrl = (account.baseUrl || WEIXIN_API_BASE).replace(/\/+$/, "");
      const url = `${baseUrl}/ilink/bot/sendtyping`;
      await fetch(url, {
        method: "POST",
        headers: buildHeaders(account.token),
        body: JSON.stringify({
          ilink_user_id: toUserId,
          typing_ticket: typingTicket || undefined,
          status: 2, // CANCEL
          base_info: {
            channel_version: PLUGIN_VERSION,
            bot_agent: "EvoClaw",
          },
        }),
      });
    } catch { /* best-effort */ }
  }

  /**
   * 通知微信服务端 bot 已上线
   */
  private async notifyStart(account: WeixinAccount): Promise<void> {
    const baseUrl = (account.baseUrl || WEIXIN_API_BASE).replace(/\/+$/, "");
    const url = `${baseUrl}/ilink/bot/msg/notifystart`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: buildHeaders(account.token),
        body: JSON.stringify({
          base_info: {
            channel_version: PLUGIN_VERSION,
            bot_agent: "EvoClaw",
          },
        }),
      });
      const text = await response.text();
      console.log(`[Weixin] notifyStart response: ${response.status} ${text.substring(0, 100)}`);
    } catch (err) {
      console.warn(`[Weixin] notifyStart error: ${err}`);
    }
  }

  /**
   * 通知微信服务端 bot 已下线
   */
  private async notifyStop(account: WeixinAccount): Promise<void> {
    const baseUrl = (account.baseUrl || WEIXIN_API_BASE).replace(/\/+$/, "");
    const url = `${baseUrl}/ilink/bot/msg/notifystop`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: buildHeaders(account.token),
        body: JSON.stringify({
          base_info: {
            channel_version: PLUGIN_VERSION,
            bot_agent: "EvoClaw",
          },
        }),
      });
      const text = await response.text();
      console.log(`[Weixin] notifyStop response: ${response.status} ${text.substring(0, 100)}`);
    } catch (err) {
      console.warn(`[Weixin] notifyStop error: ${err}`);
    }
  }

  /**
   * 启动微信消息监听
   */
  startMonitor(accountId: string): void {
    if (this.runningMonitors.has(accountId)) {
      console.log(`[Weixin] Monitor already running for ${accountId}`);
      return;
    }

    const account = this.loadAccount(accountId);
    if (!account) {
      console.error(`[Weixin] Cannot start monitor: account ${accountId} not found`);
      return;
    }

    console.log(`[Weixin] Starting monitor for ${accountId}...`);
    const abortController = new AbortController();

    // 通知微信服务端 bot 已上线
    this.notifyStart(account).catch(err => {
      console.warn(`[Weixin] notifyStart failed (ignored): ${err}`);
    });

    // 加载上次的同步位置
    const syncPath = this.getSyncPath(accountId);
    let getUpdatesBuf = "";
    if (fs.existsSync(syncPath)) {
      getUpdatesBuf = fs.readFileSync(syncPath, "utf-8");
    }

    let consecutiveErrors = 0;

    const pollLoop = async () => {
      console.log(`[Weixin] Poll loop started for ${accountId}`);
      while (!abortController.signal.aborted) {
        try {
          const updates = await this.getUpdates(account, getUpdatesBuf, abortController.signal);
          consecutiveErrors = 0;

          // Session 过期，停止监听
          if (updates && "expired" in updates) {
            console.warn(`[Weixin] Session expired for ${accountId}, stopping monitor. Please re-scan QR code.`);
            this.stopMonitor(accountId);
            // 删除过期的账户文件
            this.removeAccount(accountId);
            break;
          }

          if (updates) {
            if (updates.get_updates_buf && updates.get_updates_buf !== "") {
              getUpdatesBuf = updates.get_updates_buf;
              fs.writeFileSync(syncPath, getUpdatesBuf);
            }

            if (updates.msgs && Array.isArray(updates.msgs) && updates.msgs.length > 0) {
              console.log(`[Weixin] Received ${updates.msgs.length} messages`);
              for (const msg of updates.msgs) {
                await this.processMessage(account, msg);
              }
            }
          }
        } catch (err) {
          consecutiveErrors++;
          console.error(`[Weixin] Poll error (${consecutiveErrors}):`, err);

          if (consecutiveErrors >= 3) {
            // 连续3次错误，退避30秒
            console.warn("[Weixin] 3 consecutive errors, backing off 30s...");
            await new Promise(resolve => setTimeout(resolve, 30000));
          } else {
            // 普通错误，2秒后重试
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }
    };

    // 启动轮询
    pollLoop().catch(err => {
      console.error("[Weixin] Monitor loop error:", err);
    });

    this.runningMonitors.set(accountId, {
      controller: abortController,
    });

    console.log(`[Weixin] Monitor started for ${accountId}`);
  }

  /**
   * 获取同步文件路径
   */
  private getSyncPath(accountId: string): string {
    const tmpDir = path.join(os.tmpdir(), "evoclaw-weixin");
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    return path.join(tmpDir, `${accountId}-sync.txt`);
  }

  /**
   * 停止微信消息监听
   */
  stopMonitor(accountId: string): void {
    const monitor = this.runningMonitors.get(accountId);
    if (monitor) {
      monitor.controller.abort();
      this.runningMonitors.delete(accountId);
      // 通知微信服务端 bot 已下线
      const account = this.loadAccount(accountId);
      if (account) {
        this.notifyStop(account).catch(() => {});
      }
      console.log(`[Weixin] Monitor stopped for ${accountId}`);
    }
  }

  /**
   * 启动所有已配置的微信账户监听
   */
  startAllConfiguredMonitors(): void {
    const accounts = this.findConfiguredAccounts();
    console.log(`[Weixin] Starting monitors for ${accounts.length} accounts...`);

    for (const accountId of accounts) {
      try {
        this.startMonitor(accountId);
      } catch (err) {
        console.error(`[Weixin] Failed to start monitor for ${accountId}:`, err);
      }
    }
  }

  /**
   * 停止所有监听
   */
  stopAllMonitors(): void {
    console.log("[Weixin] Stopping all monitors...");
    for (const [accountId, monitor] of this.runningMonitors) {
      monitor.controller.abort();
    }
    this.runningMonitors.clear();
  }

  /**
   * 获取当前运行的监听数量
   */
  getRunningMonitorCount(): number {
    return this.runningMonitors.size;
  }

  /**
   * 删除账户文件和索引
   */
  removeAccount(accountId: string): void {
    try {
      const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
      const accountsDir = path.join(stateDir, "openclaw-weixin", "accounts");
      const accountFile = path.join(accountsDir, `${accountId}.json`);
      if (fs.existsSync(accountFile)) {
        fs.unlinkSync(accountFile);
      }
      // 更新索引
      const indexPath = path.join(stateDir, "openclaw-weixin", "accounts.json");
      if (fs.existsSync(indexPath)) {
        const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
        const newIndex = index.filter((id: string) => id !== accountId);
        fs.writeFileSync(indexPath, JSON.stringify(newIndex, null, 2), "utf-8");
      }
      // 删除 sync 文件
      const syncPath = this.getSyncPath(accountId);
      if (fs.existsSync(syncPath)) {
        fs.unlinkSync(syncPath);
      }
      console.log(`[Weixin] Removed expired account: ${accountId}`);
    } catch (err) {
      console.error(`[Weixin] Failed to remove account ${accountId}:`, err);
    }
  }
}
