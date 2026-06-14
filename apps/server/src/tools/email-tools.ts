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
      description: "Add an email account for sending/receiving emails",
      parameters: {
        email: { type: "string", description: "Email address" },
        password: { type: "string", description: "Email password or app-specific password" },
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
        return { error: "email and password are required" };
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
      try {
        const result = await emailClient.sendEmail({
          accountId,
          to: to.split(",").map((s) => s.trim()).filter(Boolean),
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
        return { error: "rawEmails must be a valid JSON array of email strings" };
      }
      if (rawEmails.length > 100) {
        return { error: "rawEmails array too large, maximum 100 items" };
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
      description: "List emails from inbox with optional filters",
      parameters: {
        accountId: { type: "string", description: "Email account ID (use first available if not provided)" },
        limit: { type: "number", description: "Maximum number of emails to fetch (default: 50)" },
        unreadOnly: { type: "boolean", description: "Only show unread emails (default: false)" },
      },
    },
    async (params: Record<string, unknown>) => {
      const accountId = String(params.accountId || "");
      const limit = Number(params.limit || 50);
      const unreadOnly = Boolean(params.unreadOnly || false);

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
          });
          return { success: true, emails, account: accounts.find(a => a.id === targetId) };
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
    "email_get_inbox_summary",
    {
      name: "email_get_inbox_summary",
      description: "Get inbox summary and statistics",
      parameters: {
        accountId: { type: "string", description: "Email account ID (use first available if not provided)" },
      },
    },
    async (params: Record<string, unknown>) => {
      const accountId = String(params.accountId || "");

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
          const summary = await emailClient.getInboxSummary(targetId);
          return { success: true, summary, account: accounts.find(a => a.id === targetId) };
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
