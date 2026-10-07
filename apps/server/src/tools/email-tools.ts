import type { AgentModelExecutor } from "@evoclaw/agent";
import type { PermissionManager } from "@evoclaw/security";
import type { EmailClient } from "@evoclaw/email";
import type { EmailAccount, ParsedEmail } from "@evoclaw/email";

export function registerEmailTools(
  executor: AgentModelExecutor,
  emailClient: EmailClient,
  permissionManager: PermissionManager
): void {
  executor.registerTool(
    "email_add_account",
    {
      name: "email_add_account",
      description:
        "添加/配置/注册一个邮箱账户（IMAP 收信 + SMTP 发信），用于后续收发邮件。" +
        "当用户说「添加邮箱」「配置邮箱账户」「注册邮件账号」「把我的 163/QQ/Gmail 邮箱接进来」时，" +
        "就调用本工具——系统提供该能力，不要告诉用户没有添加接口。" +
        "password 传邮箱授权码（不是登录密码）；163/QQ 等需在网页端开启 IMAP/SMTP 后生成授权码。" +
        "添加成功后应调用 email_list_accounts 回读确认。",
      parameters: {
        email: { type: "string", description: "Email address" },
        password: { type: "string", description: "邮箱授权码（app-specific password），非登录密码" },
        provider: { type: "string", description: "Email provider: gmail, qq, 163, outlook, or custom" },
        displayName: { type: "string", description: "Display name for outgoing emails" },
      },
    },
    async (params: Record<string, unknown>) => {
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
  );

  executor.registerTool(
    "email_send",
    {
      name: "email_send",
      description: "Send an email via configured account",
      parameters: {
        accountId: { type: "string", description: "Email account ID" },
        to: { type: "string", description: "Recipient email(s), comma-separated" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Plain text email body" },
        html: { type: "string", description: "HTML email body (optional)" },
      },
    },
    async (params: Record<string, unknown>) => {
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
  );

  executor.registerTool(
    "email_analyze",
    {
      name: "email_analyze",
      description: "Analyze a batch of raw emails and produce analysis report",
      parameters: {
        rawEmails: { type: "string", description: "JSON array of raw email content strings" },
      },
    },
    async (params: Record<string, unknown>) => {
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
  );

  executor.registerTool(
    "email_summarize",
    {
      name: "email_summarize",
      description: "Parse a single raw email and produce a summary",
      parameters: {
        rawEmail: { type: "string", description: "Raw email content" },
      },
    },
    async (params: Record<string, unknown>) => {
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
  );

  executor.registerTool(
    "email_list_accounts",
    {
      name: "email_list_accounts",
      description: "List configured email accounts",
      parameters: {},
    },
    async () => {
      const accounts = emailClient.listAccounts();
      return { success: true, accounts };
    }
  );

  executor.registerTool(
    "email_list_inbox",
    {
      name: "email_list_inbox",
      description:
        "List emails from inbox with optional filters. IMPORTANT: this returns envelope metadata ONLY " +
        "(uid/subject/from/date/size/categories) — it does NOT include email body text. " +
        "To analyze actual content you MUST call email_get_email(uid) for each email of interest first. " +
        "仅返回信封元数据（不含正文）；要做内容分析必须先调 email_get_email 取正文。",
      parameters: {
        accountId: { type: "string", description: "Email account ID (use first available if not provided)" },
        limit: { type: "number", description: "Maximum number of emails to fetch (default: 50)" },
        unreadOnly: { type: "boolean", description: "Only show unread emails (default: false)" },
        since: { type: "string", description: "Only return emails on or after this ISO date (e.g. 2026-09-06)" },
      },
    },
    async (params: Record<string, unknown>) => {
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
  );

  executor.registerTool(
    "email_get_email",
    {
      name: "email_get_email",
      description:
        "Read the FULL content (body text) of one email by its uid. " +
        "Use this after email_list_inbox: the list only returns envelope metadata (subject/from/date/size) " +
        "and does NOT contain any body text. 读取单封邮件正文；列表接口不返回正文，必须用它取正文后才能做内容分析。",
      parameters: {
        uid: { type: "string", description: "Email uid, as returned by email_list_inbox" },
        accountId: { type: "string", description: "Email account ID (optional; defaults to the first configured account)" },
      },
    },
    async (params: Record<string, unknown>) => {
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
  );

  executor.registerTool(
    "email_get_inbox_summary",
    {
      name: "email_get_inbox_summary",
      description: "Get inbox summary and statistics",
      parameters: {
        accountId: { type: "string", description: "Email account ID (use first available if not provided)" },
        since: { type: "string", description: "Only count emails on or after this ISO date (e.g. 2026-09-06)" },
      },
    },
    async (params: Record<string, unknown>) => {
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
  );
}
