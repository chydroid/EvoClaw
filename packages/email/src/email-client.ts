import { ServiceRegistry, EventBus, atomicWriteFileSync } from "@evoclaw/core";
import * as nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { simpleParser, type ParsedMail } from "mailparser";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { ImapFlow } from "imapflow";

export interface InboxOptions {
  accountId: string;
  folder?: string;
  limit?: number;
  unreadOnly?: boolean;
  since?: Date;
}

export interface EmailListItem {
  uid: string;
  subject: string;
  from: string;
  to: string;
  date: Date;
  size: number;
  flags: string[];
  hasAttachments: boolean;
  snippet: string;
}

export interface EmailAccount {
  id: string;
  provider: "gmail" | "qq" | "163" | "outlook" | "custom";
  email: string;
  displayName: string;
  smtpHost?: string;
  smtpPort?: number;
  imapHost?: string;
  imapPort?: number;
  useTLS: boolean;
  encryptedPassword: string;
  iv: string;
  createdAt: Date;
}

export interface SendOptions {
  accountId: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  body: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    path?: string;
    content?: string | Buffer;
    contentType?: string;
  }>;
}

export interface EmailSummary {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: Date;
  snippet: string;
  hasAttachments: boolean;
  categories: string[];
  priority: "high" | "normal" | "low";
}

export interface ParsedEmail {
  id: string;
  from: { name: string; address: string }[];
  to: { name: string; address: string }[];
  subject: string;
  date: Date;
  text: string;
  html: string | null;
  attachments: Array<{
    filename: string;
    contentType: string;
    size: number;
  }>;
  headers: Record<string, string | string[]>;
}

export interface AnalysisResult {
  totalEmails: number;
  unreadCount: number;
  categories: Record<string, number>;
  senders: Array<{ address: string; name: string; count: number }>;
  dateRange: { from: Date; to: Date };
  keywords: Array<{ word: string; count: number }>;
  actionItems: string[];
}

const PROVIDER_DEFAULTS: Record<string, { smtpHost: string; smtpPort: number; imapHost: string; imapPort: number }> = {
  gmail: { smtpHost: "smtp.gmail.com", smtpPort: 587, imapHost: "imap.gmail.com", imapPort: 993 },
  qq: { smtpHost: "smtp.qq.com", smtpPort: 587, imapHost: "imap.qq.com", imapPort: 993 },
  "163": { smtpHost: "smtp.163.com", smtpPort: 465, imapHost: "imap.163.com", imapPort: 993 },
  outlook: { smtpHost: "smtp-mail.outlook.com", smtpPort: 587, imapHost: "outlook.office365.com", imapPort: 993 },
  custom: { smtpHost: "", smtpPort: 587, imapHost: "", imapPort: 993 },
};

// 延迟计算加密密钥：避免模块加载时 dotenv 未就绪导致密钥为空
function getEncryptionKey(): Buffer {
  const raw = process.env.EvoClaw_EMAIL_KEY || "";
  return Buffer.from(raw, "utf-8").subarray(0, 32);
}

export class EmailClient {
  private accounts: Map<string, EmailAccount> = new Map();
  private transporters: Map<string, Transporter> = new Map();
  private dataDir: string;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus,
    options?: { dataDir?: string }
  ) {
    this.dataDir = options?.dataDir || path.join(process.cwd(), "data", "email");
  }

  async initialize(): Promise<void> {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    await this.loadAccounts();
  }

  addAccount(email: string, password: string, provider: EmailAccount["provider"] = "custom", displayName?: string): EmailAccount {
    const ENCRYPTION_KEY = getEncryptionKey();
    if (ENCRYPTION_KEY.length < 32) {
      throw new Error("Cannot add email account: EvoClaw_EMAIL_KEY environment variable must be set (32+ bytes) for credential encryption");
    }
    // 校验 displayName，防止 SMTP 头注入（引号 / 换行可破坏 RFC 5322 编码）
    if (displayName && /["\r\n]/.test(displayName)) {
      throw new Error("Invalid displayName: must not contain double quotes or newline characters");
    }
    const id = `acct-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(password, "utf-8", "hex");
    encrypted += cipher.final("hex");

    const defaults = PROVIDER_DEFAULTS[provider];
    const account: EmailAccount = {
      id,
      provider,
      email,
      displayName: displayName || email.split("@")[0],
      smtpHost: defaults.smtpHost,
      smtpPort: defaults.smtpPort,
      imapHost: defaults.imapHost,
      imapPort: defaults.imapPort,
      useTLS: true,
      encryptedPassword: encrypted,
      iv: iv.toString("hex"),
      createdAt: new Date(),
    };

    this.accounts.set(id, account);
    this.saveAccounts();

    this.eventBus.publish(
      "email.account_added",
      { accountId: id, email, provider },
      "email-client"
    );

    return account;
  }

  removeAccount(accountId: string): boolean {
    this.transporters.get(accountId)?.close();
    this.transporters.delete(accountId);
    const removed = this.accounts.delete(accountId);
    if (removed) this.saveAccounts();
    return removed;
  }

  getAccount(accountId: string): EmailAccount | undefined {
    return this.accounts.get(accountId);
  }

  listAccounts(): EmailAccount[] {
    return [...this.accounts.values()].map((a) => ({
      ...a,
      encryptedPassword: "***",
      iv: "***",
    }));
  }

  private decryptPassword(account: EmailAccount): string {
    const ENCRYPTION_KEY = getEncryptionKey();
    // 安全：ENCRYPTION_KEY 不足 32 字节时 createDecipheriv 会抛 ERR_OSSL_EVP_WRONG_FINAL_BLOCK_LENGTH 或静默失败，
    // 在此提前抛出明确错误，避免误诊为数据损坏
    if (ENCRYPTION_KEY.length < 32) {
      throw new Error("Cannot decrypt email password: EvoClaw_EMAIL_KEY environment variable must be set (32+ bytes) for credential decryption");
    }
    const iv = Buffer.from(account.iv, "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(account.encryptedPassword, "hex", "utf-8");
    decrypted += decipher.final("utf-8");
    return decrypted;
  }

  private getTransporter(accountId: string): Transporter {
    let transporter = this.transporters.get(accountId);
    if (transporter) return transporter;

    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`Account not found: ${accountId}`);

    const password = this.decryptPassword(account);

    transporter = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.smtpPort === 465,
      auth: {
        user: account.email,
        pass: password,
      },
      // 超时保护：此前无任何超时，SMTP 服务器无响应时 sendMail 会永久挂起
      connectionTimeout: 30_000, // 30s 连接超时
      greetingTimeout: 15_000,   // 15s greeting 超时
      socketTimeout: 60_000,     // 60s socket 空闲超时
    });

    this.transporters.set(accountId, transporter);
    return transporter;
  }

  async sendEmail(options: SendOptions): Promise<{
    messageId: string;
    accepted: string[];
    rejected: string[];
  }> {
    const account = this.accounts.get(options.accountId);
    if (!account) throw new Error(`Account not found: ${options.accountId}`);

    const transporter = this.getTransporter(options.accountId);

    // 安全：CRLF 注入防护。与 displayName 校验一致，防止 subject 中
    // 的 \r\n 被注入额外的 SMTP 头（如 Bcc: attacker@evil.com）。
    if (options.subject && /[\r\n]/.test(options.subject)) {
      throw new Error("Email subject contains invalid CRLF characters (potential header injection)");
    }

    const attachments = (options.attachments || []).map((att) => ({
      filename: att.filename,
      path: att.path,
      content: att.content,
      contentType: att.contentType,
    }));

    const info = await transporter.sendMail({
      from: { name: account.displayName, address: account.email },
      to: Array.isArray(options.to) ? options.to.join(", ") : options.to,
      cc: options.cc ? (Array.isArray(options.cc) ? options.cc.join(", ") : options.cc) : undefined,
      bcc: options.bcc ? (Array.isArray(options.bcc) ? options.bcc.join(", ") : options.bcc) : undefined,
      subject: options.subject,
      text: options.body,
      html: options.html || options.body.replace(/\n/g, "<br>"),
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    this.eventBus.publish(
      "email.sent",
      {
        accountId: options.accountId,
        messageId: info.messageId,
        to: options.to,
        subject: options.subject,
      },
      "email-client"
    );

    return {
      messageId: info.messageId,
      accepted: info.accepted as string[],
      rejected: (info.rejected as string[]) || [],
    };
  }

  async sendReport(
    accountId: string,
    to: string | string[],
    subject: string,
    reportHtml: string,
    attachments?: SendOptions["attachments"]
  ): Promise<{ messageId: string; accepted: string[]; rejected: string[] }> {
    return this.sendEmail({
      accountId,
      to,
      subject,
      body: reportHtml.replace(/<[^>]*>/g, ""),
      html: reportHtml,
      attachments,
    });
  }

  async parseRawEmail(rawContent: string): Promise<ParsedEmail> {
    const parsed = await simpleParser(rawContent);

    const fromAddr = Array.isArray(parsed.from) ? parsed.from[0] : parsed.from;
    const from = (fromAddr?.value || []).map((addr: { name?: string; address?: string }) => ({
      name: addr.name || "",
      address: addr.address || "",
    }));

    const toAddr = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
    const to = (toAddr?.value || []).map((addr: { name?: string; address?: string }) => ({
      name: addr.name || "",
      address: addr.address || "",
    }));

    const headers: Record<string, string | string[]> = {};
    const headerEntries = parsed.headers as Map<string, unknown> | undefined;
    if (headerEntries?.entries) {
      for (const [k, v] of headerEntries.entries()) {
        headers[k] = String(v);
      }
    }

    return {
      id: parsed.messageId || `email-${Date.now()}`,
      from,
      to,
      subject: parsed.subject || "(无主题)",
      date: parsed.date || new Date(),
      text: parsed.text || "",
      html: parsed.html || null,
      attachments: (parsed.attachments || []).map((att: { filename?: string; contentType: string; size: number }) => ({
        filename: att.filename || "attachment",
        contentType: att.contentType,
        size: att.size,
      })),
      headers,
    };
  }

  summarizeEmail(parsed: ParsedEmail): EmailSummary {
    const text = parsed.text || "";
    const snippet = text.substring(0, 200).replace(/\s+/g, " ").trim();
    const categories = this.classifyEmail(parsed.subject, text);
    const priority = this.detectPriority(parsed.subject, text);

    return {
      id: parsed.id,
      from: parsed.from.map((f) => f.name || f.address).join(", "),
      to: parsed.to.map((t) => t.name || t.address).join(", "),
      subject: parsed.subject,
      date: parsed.date,
      snippet: snippet + (text.length > 200 ? "..." : ""),
      hasAttachments: parsed.attachments.length > 0,
      categories,
      priority,
    };
  }

  private classifyEmail(subject: string, body: string): string[] {
    const categories: string[] = [];
    const combined = (subject + " " + body).toLowerCase();

    const patterns: Record<string, RegExp[]> = {
      "工作/商务": [/meeting|会议/, /report|报告/, /project|项目/, /deadline|截止/, /proposal|提案/],
      "账单/财务": [/invoice|发票/, /payment|付款/, /receipt|收据/, /bill|账单/, /subscription|订阅/],
      "社交/通知": [/notification|通知/, /reminder|提醒/, /invitation|邀请/, /update|更新/],
      "营销/推广": [/promo|优惠/, /discount|折扣/, /offer|特价/, /sale|促销/, /unsubscribe|退订/],
      "安全/账户": [/security|安全/, /verify|验证/, /password|密码/, /login|登录/, /2fa/],
      "个人": [/personal|个人/, /family|家庭/, /friend|朋友/],
    };

    for (const [cat, pats] of Object.entries(patterns)) {
      if (pats.some((p) => p.test(combined))) {
        categories.push(cat);
      }
    }

    if (categories.length === 0) categories.push("其他");
    return categories;
  }

  private detectPriority(subject: string, body: string): EmailSummary["priority"] {
    const combined = (subject + " " + body).toLowerCase();
    if (/urgent|紧急|asap|立即|马上|立刻|deadline|截止/.test(combined)) return "high";
    if (/important|重要|please review|请查收|请确认/.test(combined)) return "normal";
    return "low";
  }

  analyzeEmails(emails: ParsedEmail[]): AnalysisResult {
    const analysis: AnalysisResult = {
      totalEmails: emails.length,
      unreadCount: 0,
      categories: {},
      senders: [],
      dateRange: { from: new Date(), to: new Date(0) },
      keywords: [],
      actionItems: [],
    };

    const senderMap = new Map<string, { name: string; count: number }>();
    const wordCount: Record<string, number> = {};
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "can", "shall", "to", "of", "in", "for",
      "on", "with", "at", "by", "from", "as", "into", "through", "during",
      "before", "after", "above", "below", "between", "and", "but", "or",
      "nor", "not", "so", "yet", "both", "either", "neither", "each",
      "every", "all", "any", "few", "more", "most", "other", "some",
      "such", "only", "own", "same", "this", "that", "these", "those",
      "it", "its", "he", "she", "they", "them", "we", "you", "me", "him",
      "her", "us", "我", "的", "了", "是", "在", "不", "和", "也", "就",
      "都", "而", "及", "与", "这", "那", "你", "他", "她", "它", "们",
    ]);

    const actionPatterns = [
      /please\s+\w+/gi,
      /请\w+/g,
      /need\s+to\s+\w+/gi,
      /需要\w+/g,
      /(?:must|should|have to)\s+\w+/gi,
      /必须\w+/g,
      /(?:reply|respond|回复|答复)\s*(?:by|before|在|之前)/gi,
    ];

    for (const email of emails) {
      for (const addr of email.from) {
        const key = addr.address.toLowerCase();
        const existing = senderMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          senderMap.set(key, { name: addr.name, count: 1 });
        }
      }

      if (email.date < analysis.dateRange.from) {
        analysis.dateRange.from = email.date;
      }
      if (email.date > analysis.dateRange.to) {
        analysis.dateRange.to = email.date;
      }

      const categories = this.classifyEmail(email.subject, email.text);
      for (const cat of categories) {
        analysis.categories[cat] = (analysis.categories[cat] || 0) + 1;
      }

      const words = email.text
        .toLowerCase()
        .split(/[\s,.;:!?()\[\]{}"'<>]+/)
        .filter((w) => w.length > 3 && !stopWords.has(w));

      for (const word of words) {
        wordCount[word] = (wordCount[word] || 0) + 1;
      }

      // 防止 wordCount 在处理大量邮件时无限增长导致内存峰值过高：
      // 超过 5000 个 key 时移除低频词（count <= 1）
      if (Object.keys(wordCount).length > 5000) {
        for (const [w, c] of Object.entries(wordCount)) {
          if (c <= 1) delete wordCount[w];
        }
      }

      for (const pattern of actionPatterns) {
        const matches = email.text.match(pattern);
        if (matches) {
          analysis.actionItems.push(...matches);
        }
      }
    }

    analysis.senders = [...senderMap.entries()]
      .map(([address, info]) => ({ address, name: info.name, count: info.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    analysis.keywords = Object.entries(wordCount)
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);

    analysis.actionItems = [...new Set(analysis.actionItems)].slice(0, 20);

    return analysis;
  }

  private async loadAccounts(): Promise<void> {
    try {
      const filePath = path.join(this.dataDir, "accounts.json");
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw) as EmailAccount[];
        for (const acct of data) {
          this.accounts.set(acct.id, {
            ...acct,
            createdAt: new Date(acct.createdAt),
          });
        }
      }
    } catch (err) {
      process.stderr.write("[EmailClient] Failed to load accounts:" + " " + err + "\n");
    }
  }

  private async saveAccounts(): Promise<void> {
    try {
      const filePath = path.join(this.dataDir, "accounts.json");
      const data = [...this.accounts.values()];
      atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      process.stderr.write("[EmailClient] Failed to save accounts:" + " " + err + "\n");
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  /**
   * Connect to email account via IMAP and list emails
   */
  async listEmails(options: InboxOptions): Promise<EmailListItem[]> {
    const account = this.accounts.get(options.accountId);
    if (!account) throw new Error(`Account not found: ${options.accountId}`);
    if (!account.imapHost || !account.imapPort) {
      throw new Error(`IMAP not configured for account ${options.accountId}`);
    }

    const password = this.decryptPassword(account);
    const emails: EmailListItem[] = [];

    let client: ImapFlow | null = null;
    try {
      client = new ImapFlow({
        host: account.imapHost,
        port: account.imapPort,
        secure: account.imapPort === 993,
        auth: {
          user: account.email,
          pass: password,
        },
        logger: false,
      });

      await client.connect();
      await client.mailboxOpen(options.folder || "INBOX");

      const limit = options.limit || 50;

      const status = await client.status(options.folder || "INBOX", { messages: true });
      const total = status.messages ?? 0;
      const start = Math.max(1, total - limit + 1);
      // 空邮箱：total=0 时跳过 fetch，避免某些 IMAP 服务器对非法范围报错
      if (total === 0) return [];
      let fetched = 0;
      for await (const message of client.fetch(`${start}:*`, {
        envelope: true,
        flags: true,
        size: true,
        uid: true,
      })) {
        const envelope = message.envelope;
        if (!envelope) continue;

        const fromAddr = envelope.from?.[0];
        const toAddr = envelope.to?.[0];
        const flags = message.flags;
        // 已知限制：\Attachment 不是标准 IMAP 系统标志，服务器不会自动设置，
        // 因此 hasAttachments 永远为 false。准确判断附件需要拉取 BODYSTRUCTURE
        // 并递归检查 disposition 为 attachment 的 MIME 部分，此处暂不实现。
        const hasAttachments = flags instanceof Set ? flags.has("\\Attachment") : false;
        const flagsArray = flags instanceof Set ? Array.from(flags) : [];

        emails.unshift({
          uid: String(message.uid),
          subject: envelope.subject || "(无主题)",
          from: fromAddr ? `${fromAddr.name || ""} <${fromAddr.address}>`.trim() : "",
          to: toAddr ? `${toAddr.name || ""} <${toAddr.address}>`.trim() : "",
          date: envelope.date ? new Date(envelope.date) : new Date(),
          size: message.size || 0,
          flags: flagsArray,
          hasAttachments,
          snippet: "(请查看完整邮件以获取预览)",
        });

        fetched++;
        if (fetched >= limit) break;
      }
    } catch (err) {
      process.stderr.write(`[EmailClient] Failed to list emails: ${err}\n`);
      throw new Error(`无法连接邮箱: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (client) {
        try { await client.logout(); } catch { /* best-effort */ }
      }
    }

    return emails;
  }

  /**
   * Fetch full email content by UID
   */
  async getEmail(accountId: string, uid: string): Promise<ParsedEmail> {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`Account not found: ${accountId}`);
    if (!account.imapHost || !account.imapPort) {
      throw new Error(`IMAP not configured for account ${accountId}`);
    }

    const password = this.decryptPassword(account);

    const client = new ImapFlow({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapPort === 993,
      auth: {
        user: account.email,
        pass: password,
      },
      logger: false,
    });

    let loggedOut = false;
    try {
      await client.connect();
      await client.mailboxOpen("INBOX");

      const lock = await client.getMailboxLock("INBOX");
      let rawContent = "";

      try {
        const msg = await client.fetchOne(uid, { envelope: true, source: true });
        if (msg && msg.source) {
          if (Buffer.isBuffer(msg.source)) {
            rawContent = msg.source.toString("utf-8");
          } else {
            rawContent = msg.source as string;
          }
        }
      } finally {
        lock.release();
      }

      await client.logout();
      loggedOut = true;

      if (!rawContent) {
        throw new Error("无法获取邮件内容");
      }

      return this.parseRawEmail(rawContent);
    } catch (err) {
      // 防止重复 logout：仅当 try 块内未成功 logout 时才在 catch 中清理
      if (!loggedOut) {
        await client.logout().catch(() => {});
      }
      throw err;
    }
  }

  /**
   * Get inbox summary with statistics
   */
  async getInboxSummary(accountId: string): Promise<{
    total: number;
    unread: number;
    recent: EmailListItem[];
    categories: Record<string, number>;
  }> {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`Account not found: ${accountId}`);

    const categories: Record<string, number> = {
      "工作/商务": 0,
      "账单/财务": 0,
      "社交/通知": 0,
      "营销/推广": 0,
      "安全/账户": 0,
      "其他": 0,
    };

    let total = 0;
    let unread = 0;
    let recent: EmailListItem[] = [];
    let client: ImapFlow | null = null;

    try {
      if (account.imapHost && account.imapPort) {
        const password = this.decryptPassword(account);
        client = new ImapFlow({
          host: account.imapHost,
          port: account.imapPort,
          secure: account.imapPort === 993,
          auth: {
            user: account.email,
            pass: password,
          },
          logger: false,
        });

        await client.connect();
        const mailbox = await client.mailboxOpen("INBOX");

        // Get actual total from mailbox
        total = mailbox && 'exists' in mailbox ? mailbox.exists : 0;

        await client.logout();
        client = null;

        // Fetch recent emails
        recent = await this.listEmails({ accountId, limit: 20 });

        // Count unread from flags
        unread = recent.filter(e => !e.flags.includes("\\Seen")).length;
      } else {
        // Fall back if no IMAP configured
        total = 0;
        unread = 0;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[EmailClient] Failed to get full inbox summary for ${account.email}: ${errMsg}\n`);
      // 出错时尝试获取邮件作为备用方案
      try {
        recent = await this.listEmails({ accountId, limit: 20 });
        total = recent.length;
        unread = recent.filter(e => !e.flags.includes("\\Seen")).length;
      } catch (err2) {
        const err2Msg = err2 instanceof Error ? err2.message : String(err2);
        process.stderr.write(`[EmailClient] Fallback listEmails also failed: ${err2Msg}\n`);
        total = 0;
        unread = 0;
        recent = [];
      }
    } finally {
      // 确保 IMAP 连接在任何错误路径下都被关闭，防止 TCP socket 与登录会话泄漏
      if (client) {
        try {
          await client.logout();
        } catch {
          try { await client.close(); } catch { /* ignore */ }
        }
      }
    }

    // Classify emails — snippet 是占位符，使用 subject + from 提供分类依据
    for (const email of recent) {
      const cats = this.classifyEmail(email.subject, email.subject + " " + (email.from || ""));
      for (const cat of cats) {
        if (categories[cat] !== undefined) {
          categories[cat]++;
        } else {
          categories["其他"]++;
        }
      }
    }

    return { total, unread, recent, categories };
  }

  /** 关闭所有 SMTP transporter，释放连接资源 */
  dispose(): void {
    for (const transporter of this.transporters.values()) {
      try {
        transporter.close();
      } catch {
        // best-effort
      }
    }
    this.transporters.clear();
    process.stdout.write("[EmailClient] All SMTP transporters closed\n");
  }
}
