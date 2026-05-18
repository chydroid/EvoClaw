import { ServiceRegistry, EventBus } from "@evoclaw/core";
import * as nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { simpleParser, type ParsedMail } from "mailparser";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

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

const ENCRYPTION_KEY = Buffer.from(process.env.ECOCLAW_EMAIL_KEY || "evoclaw-email-key-32-bytes-here!", "utf-8").subarray(0, 32);

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
    const id = `acct-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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

    const attachments = (options.attachments || []).map((att) => ({
      filename: att.filename,
      path: att.path,
      content: att.content,
      contentType: att.contentType,
    }));

    const info = await transporter.sendMail({
      from: `"${account.displayName}" <${account.email}>`,
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
      subject: parsed.subject || "(No Subject)",
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
    } catch {}
  }

  private async saveAccounts(): Promise<void> {
    try {
      const filePath = path.join(this.dataDir, "accounts.json");
      const data = [...this.accounts.values()];
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch {}
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}