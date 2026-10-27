import type { AgentModelExecutor } from "@evoclaw/agent";
import type { PermissionManager } from "@evoclaw/security";
import type { EmailClient } from "@evoclaw/email";
import type { EmailAccount, ParsedEmail } from "@evoclaw/email";

export function registerEmailTools(
  executor: AgentModelExecutor,
  emailClient: EmailClient,
  permissionManager: PermissionManager
): void {
  async function handleEmailAddAccount(params: Record<string, unknown>): Promise<unknown> {
    const email = String(params.email || "");
    const password = String(params.password || "");
    const provider = String(params.provider || "custom") as EmailAccount["provider"];
    const displayName = String(params.displayName || "");
    if (!email || !password) {
      return { success: false, error: "email and password are required" };
    }
    const perm = permissionManager.requestPermission("email_add_account", email, { provider }, "tool");
    if (perm.status === "denied") {
      return { success: false, error: "Permission denied to add email account" };
    }
    if (perm.status === "pending") {
      return {
        success: false,
        requiresPermission: true,
        requestId: perm.id,
        operation: "email_add_account",
        description: "添加邮箱账户",
        target: email,
        error: "Awaiting approval to add email account",
      };
    }
    const account = emailClient.addAccount(email, password, provider, displayName);
    return { success: true, accountId: account.id, email, provider };
  }

  async function handleEmailSend(params: Record<string, unknown>): Promise<unknown> {
    const accountId = String(params.accountId || "");
    const to = String(params.to || "");
    const subject = String(params.subject || "");
    const body = String(params.body || "");
    const html = String(params.html || "");
    // 必填字段校验
    if (!accountId) return { success: false, error: "accountId is required" };
    if (!to) return { success: false, error: "Recipient (to) is required" };
    if (!subject) return { success: false, error: "Subject is required" };
    if (!body && !html) return { success: false, error: "Body or html is required" };
    // 邮箱格式校验：防止畸形地址导致 SMTP 头注入
    const emails = to.split(",").map((s) => s.trim()).filter(Boolean);
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const email of emails) {
      if (!emailRegex.test(email) || /[\r\n]/.test(email)) {
        return { success: false, error: `Invalid email address: ${email}` };
      }
    }
    try {
      const result = await emailClient.sendEmail({
        accountId,
        to: emails,
        subject,
        body,
        html: html || undefined,
      });
      return { success: true, messageId: result.messageId, accepted: result.accepted };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function handleEmailAnalyze(params: Record<string, unknown>): Promise<unknown> {
    let rawEmails: string[] = [];
    try {
      rawEmails = JSON.parse(String(params.rawEmails || "[]"));
    } catch {
      return { success: false, error: "rawEmails must be a valid JSON array of email strings" };
    }
    if (rawEmails.length > 100) {
      return { success: false, error: "rawEmails array too large, maximum 100 items" };
    }
    const parsed: ParsedEmail[] = [];
    for (const raw of rawEmails) {
      try {
        parsed.push(await emailClient.parseRawEmail(raw));
      } catch (parseErr) {
        console.warn(`[Email] Failed to parse email: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
      }
    }
    const analysis = emailClient.analyzeEmails(parsed);
    return {
      success: true,
      totalEmails: analysis.totalEmails,
      categories: analysis.categories,
      topSenders: (analysis.senders || []).slice(0, 5),
      topKeywords: (analysis.keywords || []).slice(0, 10),
      actionItems: analysis.actionItems,
    };
  }

  async function handleEmailSummarize(params: Record<string, unknown>): Promise<unknown> {
    const rawEmail = String(params.rawEmail || "");
    const parsed = await emailClient.parseRawEmail(rawEmail);
    const summary = emailClient.summarizeEmail(parsed);
    return {
      success: true,
      from: summary.from,
      subject: summary.subject,
      date: summary.date,
      snippet: summary.snippet,
      categories: summary.categories,
      priority: summary.priority,
      hasAttachments: summary.hasAttachments,
    };
  }

  async function handleEmailListAccounts(): Promise<unknown> {
    const accounts = emailClient.listAccounts();
    return { success: true, accounts };
  }

  async function handleEmailListInbox(params: Record<string, unknown>): Promise<unknown> {
    const accountId = String(params.accountId || "");
    const limitRaw = Number(params.limit);
    const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50, 500));
    const unreadOnly = Boolean(params.unreadOnly || false);
    const sinceRaw = params.since ? String(params.since) : "";
    const since = sinceRaw ? new Date(sinceRaw) : undefined;
    if (since && isNaN(since.getTime())) {
      return { success: false, error: `Invalid since date: ${sinceRaw}` };
    }

    const accounts = emailClient.listAccounts();
    if (accounts.length === 0) {
      return { success: false, error: "No email accounts configured" };
    }

    // If accountId specified, try that first; otherwise try all accounts until one succeeds
    const accountIdsToTry = accountId
      ? [accountId]
      : accounts.map(a => a.id);

    let lastError = "";
    for (const targetId of accountIdsToTry) {
      try {
        const emails = await emailClient.listEmails({
          accountId: targetId,
          limit,
          unreadOnly,
          since,
        });
        // 为每封邮件附加分类，供上层生成"重点关注"列表使用
        const enriched = emails.map((e) => ({
          ...e,
          categories: emailClient.classifyEmail(e.subject, e.subject + " " + (e.from || "")),
        }));
        return { success: true, emails: enriched, account: accounts.find(a => a.id === targetId) };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error(`[Server] email_list_inbox failed for account ${targetId}: ${lastError}`);
        // Try next account
      }
    }

    return { success: false, error: `All accounts failed. Last error: ${lastError}` };
  }

  async function handleEmailGetEmail(params: Record<string, unknown>): Promise<unknown> {
    const uid = String(params.uid || "");
    if (!uid) return { success: false, error: "uid is required" };
    const accountId = String(params.accountId || "");
    const accounts = emailClient.listAccounts();
    if (accounts.length === 0) return { success: false, error: "No email accounts configured" };
    const targetId = accountId || accounts[0].id;
    try {
      const parsed = await emailClient.getEmail(targetId, uid);
      return { success: true, uid, email: parsed };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function handleEmailInboxSummary(params: Record<string, unknown>): Promise<unknown> {
    const accountId = String(params.accountId || "");
    const sinceRaw = params.since ? String(params.since) : "";
    const since = sinceRaw ? new Date(sinceRaw) : undefined;
    if (since && isNaN(since.getTime())) {
      return { success: false, error: `Invalid since date: ${sinceRaw}` };
    }

    const accounts = emailClient.listAccounts();
    if (accounts.length === 0) {
      return { success: false, error: "No email accounts configured" };
    }

    // If accountId specified, try that first; otherwise try all accounts until one succeeds
    const accountIdsToTry = accountId
      ? [accountId]
      : accounts.map(a => a.id);

    let lastError = "";
    for (const targetId of accountIdsToTry) {
      try {
        const summary = await emailClient.getInboxSummary(targetId, { since });
        // fetchError 存在时仍返回 success:true，但携带错误原因，交由上层如实告知用户
        return { success: true, summary, account: accounts.find(a => a.id === targetId), fetchError: summary.fetchError };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error(`[Server] email_get_inbox_summary failed for account ${targetId}: ${lastError}`);
        // Try next account
      }
    }

    return { success: false, error: `All accounts failed. Last error: ${lastError}` };
  }

  executor.registerTool(
    "email",
    {
      name: "email",
      description:
        "复合邮箱工具（composite email tool），通过 action 参数选择具体操作。" +
        "Choose the action matching the user's request; default action is send. " +
        "actions: " +
        "send（默认，发送邮件，必填 accountId/to/subject，body 与 html 至少一个；to 逗号分隔多收件人，会做邮箱格式校验防 SMTP 头注入）； " +
        "add_account（添加/配置/注册邮箱账户，IMAP 收信 + SMTP 发信；当用户说「添加邮箱」「配置邮箱账户」「注册邮件账号」「把我的 163/QQ/Gmail 邮箱接进来」时调用——系统提供该能力，不要告诉用户没有添加接口；password 传邮箱授权码而非登录密码，163/QQ 等需先在网页端开启 IMAP/SMTP 生成授权码；添加成功后应调 list_accounts 回读确认）； " +
        "list_accounts（列出已配置的邮箱账户）； " +
        "list_inbox（列出收件箱邮件，可按 accountId/limit/unreadOnly/since 过滤；IMPORTANT: 仅返回信封元数据 uid/subject/from/date/size/categories，不含正文，要做内容分析必须先调 get_email 取正文）； " +
        "get_email（按 uid 读取单封邮件完整正文；列表接口不返回正文，必须先调它取正文才能做内容分析）； " +
        "analyze（分析一批原始邮件，rawEmails 为 JSON 数组字符串，最多 100 条，返回分类报告：totalEmails/categories/topSenders/topKeywords/actionItems）； " +
        "summarize（解析单封原始邮件 rawEmail 并生成摘要：from/subject/date/snippet/categories/priority/hasAttachments）； " +
        "inbox_summary（获取收件箱统计摘要，可按 accountId/since 过滤；accountId 缺省时尝试所有账户直到成功一个）。",
      parameters: {
        action: {
          type: "string",
          description: "要执行的邮箱操作。action to perform: send (default) / add_account / list_accounts / list_inbox / get_email / analyze / summarize / inbox_summary",
          enum: ["send", "add_account", "list_accounts", "list_inbox", "get_email", "analyze", "summarize", "inbox_summary"],
        },
        email: { type: "string", description: "Email address（add_account 用）" },
        password: { type: "string", description: "邮箱授权码（app-specific password），非登录密码（add_account 用）" },
        provider: { type: "string", description: "Email provider: gmail, qq, 163, outlook, or custom（add_account 用）" },
        displayName: { type: "string", description: "Display name for outgoing emails（add_account 用）" },
        accountId: { type: "string", description: "Email account ID（send / list_inbox / get_email / inbox_summary 用，缺省时用第一个可用账户）" },
        to: { type: "string", description: "Recipient email(s), comma-separated（send 用）" },
        subject: { type: "string", description: "Email subject（send 用）" },
        body: { type: "string", description: "Plain text email body（send 用）" },
        html: { type: "string", description: "HTML email body (optional)（send 用）" },
        rawEmails: { type: "string", description: "JSON array of raw email content strings（analyze 用，最多 100 条）" },
        rawEmail: { type: "string", description: "Raw email content（summarize 用）" },
        uid: { type: "string", description: "Email uid, as returned by list_inbox（get_email 用）" },
        limit: { type: "number", description: "Maximum number of emails to fetch (default: 50, max 500)（list_inbox 用）" },
        unreadOnly: { type: "boolean", description: "Only show unread emails (default: false)（list_inbox 用）" },
        since: { type: "string", description: "Only return emails on or after this ISO date (e.g. 2026-09-06)（list_inbox / inbox_summary 用）" },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "send");
      if (action === "add_account") return await handleEmailAddAccount(params);
      if (action === "send") return await handleEmailSend(params);
      if (action === "list_accounts") return await handleEmailListAccounts();
      if (action === "list_inbox") return await handleEmailListInbox(params);
      if (action === "get_email") return await handleEmailGetEmail(params);
      if (action === "analyze") return await handleEmailAnalyze(params);
      if (action === "summarize") return await handleEmailSummarize(params);
      if (action === "inbox_summary") return await handleEmailInboxSummary(params);
      return { success: false, error: `未知 email action: ${action}（仅支持 send / add_account / list_accounts / list_inbox / get_email / analyze / summarize / inbox_summary）` };
    }
  );
}
