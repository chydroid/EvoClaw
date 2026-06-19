// Email handling for AgentModelExecutor
// Extracted from agent-model-executor.ts for modularity

import type { ServiceRegistry } from "@evoclaw/core";
import type { ToolDefinition } from "./types";

/** Common early-return result shape used by pre-LLM handlers */
export interface EarlyReturnResult {
  reply: string;
  tokensUsed: number;
  duration: number;
  permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>;
  toolsExecuted: boolean;
}

/** Dependencies needed by email handler functions */
export interface EmailHandlerDeps {
  registeredTools: Map<string, { definition: ToolDefinition; handler: (params: Record<string, unknown>) => Promise<unknown> }>;
  registry: ServiceRegistry;
}

/**
 * Detect email credentials in user input and auto-configure email account
 * Supported patterns:
 * - "xxx@163.com 密码是：xxxxx"
 * - "xxx@gmail.com password: xxxxx"
 * - "邮箱地址: xxx@xxx.com, 密码: xxxxx"
 * - "邮箱账号xxx@163.com 授权码：xxxxx"
 */
export async function detectAndConfigureEmailAccount(
  deps: EmailHandlerDeps,
  message: string,
): Promise<EarlyReturnResult | null> {
  // Don't detect in search results or context messages
  if (message.includes("[系统") || message.includes("已为你搜索")) {
    return null;
  }

  const originalMsg = message;
  const lowerMsg = message.toLowerCase().trim();

  // Fix common typos in email domain
  let fixedMsg = lowerMsg
    .replace(/@163\.oom\b/gi, "@163.com")
    .replace(/@qq\.com\.+/gi, "@qq.com")
    .replace(/@gmail\.com\.+/gi, "@gmail.com")
    .replace(/\.oom\b/gi, ".com");

  let email: string | null = null;
  let password: string | null = null;
  let matched = false;

  // Pattern 1: Chinese format with "邮箱账号" or "邮箱地址"
  // Example: "邮箱账号chydroid@163.com 授权码：DCq4QHXN46bMPCc9"
  const accountPrefixPattern = /(?:邮箱账号|邮箱地址|账号)(?:[:：]\s*)?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
  const accountPrefixMatch = originalMsg.match(accountPrefixPattern);

  // Pattern 2: Direct email with auth code
  // Example: "chydroid@163.com 授权码：DCq4QHXN46bMPCc9"
  const authCodePattern = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s*(?:授权码|密码|password)[:：]\s*([a-zA-Z0-9]{10,})/i;
  const authCodeMatch = fixedMsg.match(authCodePattern);

  // Pattern 3: Key-value format
  // Example: "邮箱: xxx@xxx.com, 授权码: xxxxx"
  const kvPattern = /(?:邮箱(?:地址)?|email)\s*[:：]\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})[^a-zA-Z0-9]*?(?:授权码|密码|password)\s*[:：]\s*([a-zA-Z0-9]{6,})/i;
  const kvMatch = originalMsg.match(kvPattern);

  // Pattern 4: Simple format "email password"
  // Example: "test@163.com MyPassword123"
  const simplePattern = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s+([a-zA-Z0-9!@#$%]{6,32})(?:\s|$)/i;
  const simpleMatch = fixedMsg.match(simplePattern);

  // Extract email and password
  if (authCodeMatch) {
    email = authCodeMatch[1];
    password = authCodeMatch[2];
    matched = true;
  } else if (kvMatch) {
    email = kvMatch[1];
    password = kvMatch[2];
    matched = true;
  } else if (simpleMatch) {
    email = simpleMatch[1];
    password = simpleMatch[2];
    matched = true;
  }

  if (!matched || !email || !password) {
    return null;
  }

  // Detect email provider from message
  const detectProvider = (msg: string): string => {
    if (msg.includes("163") || /@163\.com$/i.test(msg)) return "163";
    if (msg.includes("qq") || /@qq\.com$/i.test(msg)) return "qq";
    if (msg.includes("126") || /@126\.com$/i.test(msg)) return "126";
    if (msg.includes("gmail") || /@gmail\.com$/i.test(msg)) return "gmail";
    if (msg.includes("outlook") || /@outlook\.(com|org)$/i.test(msg)) return "outlook";
    if (msg.includes("189") || /@189\.cn$/i.test(msg)) return "189";
    if (msg.includes("yahoo") || /@yahoo\.(com|cn)$/i.test(msg)) return "yahoo";
    return "163"; // Default to 163 for Chinese email
  };

  process.stdout.write(`[EmailHandler] Detected email account configuration: ${email.replace(/(.{2}).*(@.*)/, "$1****$2")}, password length: ${password.length}`);

  const provider = detectProvider(message);
  const displayName = email.split("@")[0];

  // Check if email_add_account tool is registered
  if (!deps.registeredTools.has("email_add_account")) {
    return {
      reply: `检测到您提供了邮箱账号：${email}\n\n但系统尚未注册邮箱功能。请联系管理员配置邮箱功能。`,
      tokensUsed: 0,
      duration: 0,
      permissionRequests: [],
      toolsExecuted: false,
    };
  }

  // Use TaskClassifier to verify this is an email operation
  const taskClassifier = deps.registry?.resolveService<{
    classify(task: string): { primaryCategory: string; confidence: number };
  }>("taskClassifier");

  if (taskClassifier) {
    try {
      const result = taskClassifier.classify(message);
      // If the primary category is not email_handling, we might have false positive
      // But since we detected email credentials, we should still proceed
      process.stdout.write(`[EmailHandler] Email config intent classification: ${result.primaryCategory} (confidence: ${result.confidence})`);
    } catch (classifyErr) {
      process.stderr.write(`[EmailHandler] Email intent classification failed: ${classifyErr instanceof Error ? classifyErr.message : String(classifyErr)}`);
    }
  }

  // Try to add the email account
  try {
    const emailTool = deps.registeredTools.get("email_add_account")!;
    const result = await emailTool.handler({
      email,
      password,
      provider,
      displayName,
    });

    const resultObj = typeof result === "object" && result !== null ? result as Record<string, unknown> : null;

    if (resultObj?.success) {
      return {
        reply: `✅ 邮箱账号配置成功！\n\n📧 已添加邮箱：${email}\n🏢 邮箱类型：${provider}\n👤 显示名称：${displayName}\n\n现在您可以使用"帮我整理邮件"来整理您的邮箱了！`,
        tokensUsed: 0,
        duration: 0,
        permissionRequests: [],
        toolsExecuted: false,
      };
    } else if (resultObj?.requiresPermission) {
      // Permission is needed, return with pending permission request
      return {
        reply: `检测到您提供了邮箱账号，正在请求授权添加...\n\n📧 邮箱：${email}\n🏢 类型：${provider}`,
        tokensUsed: 0,
        duration: 0,
        permissionRequests: [{
          id: (resultObj.requestId as string) || (resultObj.id as string) || "email-config",
          operation: "email_add_account",
          description: `添加邮箱账号: ${email}`,
          target: email,
        }],
        toolsExecuted: false,
      };
    } else {
      return {
        reply: `⚠️ 邮箱账号配置遇到问题：${resultObj?.error || "未知错误"}\n\n请检查邮箱地址和密码是否正确。`,
        tokensUsed: 0,
        duration: 0,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }
  } catch (err) {
    return {
      reply: `❌ 邮箱账号配置失败：${err instanceof Error ? err.message : String(err)}`,
      tokensUsed: 0,
      duration: 0,
      permissionRequests: [],
      toolsExecuted: false,
    };
  }
}

/**
 * Handle email inbox operations: list emails, summarize, analyze
 * This is called when the task classifier detects email_handling intent
 */
export async function handleEmailOperation(
  deps: EmailHandlerDeps,
  message: string,
): Promise<EarlyReturnResult | null> {
  const lowerMsg = message.toLowerCase();

  // Check if this is an email operation
  const emailKeywords = [
    "整理邮件", "整理邮箱", "查看邮件", "读取邮件", "邮件摘要",
    "统计邮件", "生成邮件报告", "邮件报告", "收件箱", "未读邮件",
    "批量处理邮件", "清理邮箱", "整理所有邮件"
  ];

  const sendEmailKeywords = ["发邮件", "发送邮件", "发信", "写信", "发一封", "发e-mail", "发email", "寄信", "寄邮件"];
  const isSendEmailOp = sendEmailKeywords.some(kw => lowerMsg.includes(kw)) && /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(message);
  const isEmailOp = emailKeywords.some(kw => lowerMsg.includes(kw)) || isSendEmailOp;

  if (!isEmailOp) {
    return null;
  }

  // ── Send email branch ──
  if (isSendEmailOp) {
    if (!deps.registeredTools.has("email_send")) {
      return {
        reply: `检测到您想发送邮件，但系统尚未配置邮箱发送功能。\n\n请先提供您的邮箱账号信息，例如：\n📧 邮箱账号：yourname@163.com\n🔑 授权码：您的授权码`,
        tokensUsed: 0,
        duration: 0,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }

    // Extract recipient email
    const emailMatch = message.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    if (!emailMatch) {
      return {
        reply: `请提供收件人邮箱地址，例如：\n给 156231056@qq.com 发邮件，内容是我最近很忙`,
        tokensUsed: 0,
        duration: 0,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }
    const toEmail = emailMatch[1];

    // Extract subject / body from message
    // Patterns:
    // "给 xxx 发邮件，内容是 ..."
    // "发邮件给 xxx，告诉他 ..."
    // "给 xxx 发邮件，主题是 ...，内容是 ..."
    let subject = "";
    let body = "";

    const contentPatterns = [
      /(?:内容|正文|body)[:：]\s*(.+)/i,
      /(?:告诉他|告诉她|说|写|内容)(?:[:：])?\s*(.+)/i,
      /(?:发邮件|发信|写信).*?(?:[,，])\s*(.+)/i,
    ];

    for (const pattern of contentPatterns) {
      const m = message.match(pattern);
      if (m && m[1]) {
        body = m[1].trim();
        break;
      }
    }

    // Clean up noise after extraction: strip leading "是", "想" etc.
    if (body) {
      body = body.replace(/^(是|想|说)[，,。.]?\s*/i, "").trim();
    }

    const subjectPatterns = [
      /(?:主题|标题|subject)[:：]\s*(.+?)(?:[,，]|内容|正文|body)/i,
      /(?:主题|标题|subject)[:：]\s*(.+)/i,
    ];

    for (const pattern of subjectPatterns) {
      const m = message.match(pattern);
      if (m && m[1]) {
        subject = m[1].trim();
        break;
      }
    }

    // If no explicit subject, generate one from body
    if (!subject && body) {
      subject = body.slice(0, 30) + (body.length > 30 ? "..." : "");
    }

    // If still no body, use the whole message after the email as body
    if (!body) {
      const afterEmail = message.slice(message.indexOf(toEmail) + toEmail.length);
      body = afterEmail.replace(/^(\s*[,，]\s*|\s*)/, "").replace(/^(发邮件|发信|写信|，|,)/, "").trim();
    }

    if (!body) {
      return {
        reply: `请提供邮件内容，例如：\n给 ${toEmail} 发邮件，内容是我最近很忙，一直在写EvoClaw`,
        tokensUsed: 0,
        duration: 0,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }

    // Get first available account
    let accountsResult: unknown;
    try {
      const accountsTool = deps.registeredTools.get("email_list_accounts")!;
      accountsResult = await accountsTool.handler({});
    } catch (err) {
      return {
        reply: `❌ 获取邮箱账号失败：${err instanceof Error ? err.message : String(err)}`,
        tokensUsed: 0,
        duration: 0,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }

    const accountsData = accountsResult as { success: boolean; accounts?: Array<{ id: string; email: string }> };
    if (!accountsData?.success || !accountsData.accounts?.length) {
      return {
        reply: `📭 您还没有配置任何邮箱账号，无法发送邮件。\n\n请先提供邮箱信息，例如：\n📧 邮箱账号：yourname@163.com\n🔑 授权码：您的授权码`,
        tokensUsed: 0,
        duration: 0,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }

    const accountId = accountsData.accounts[0].id;

    // Call email_send tool
    try {
      const sendTool = deps.registeredTools.get("email_send")!;
      const sendResult = await sendTool.handler({
        accountId,
        to: toEmail,
        subject: subject || "无主题",
        body,
      });
      const sendData = sendResult as { success: boolean; messageId?: string; accepted?: string[]; error?: string };
      if (sendData?.success) {
        return {
          reply: `✅ 邮件发送成功！\n\n📧 收件人：${toEmail}\n📌 主题：${subject || "无主题"}\n📝 内容：${body}\n\n邮件已通过 ${accountsData.accounts[0].email} 发送。`,
          tokensUsed: 0,
          duration: 0,
          permissionRequests: [],
          toolsExecuted: false,
        };
      } else {
        return {
          reply: `❌ 邮件发送失败：${sendData?.error || "未知错误"}\n\n请检查邮箱配置和网络连接。`,
          tokensUsed: 0,
          duration: 0,
          permissionRequests: [],
          toolsExecuted: false,
        };
      }
    } catch (err) {
      return {
        reply: `❌ 邮件发送失败：${err instanceof Error ? err.message : String(err)}`,
        tokensUsed: 0,
        duration: 0,
        permissionRequests: [],
        toolsExecuted: false,
      };
    }
  }

  // Check if email tools are available
  if (!deps.registeredTools.has("email_list_accounts")) {
    return {
      reply: `检测到您想进行邮件操作，但系统尚未配置邮箱功能。\n\n请先提供您的邮箱账号信息，例如：\n📧 邮箱账号：yourname@163.com\n🔑 授权码：您的授权码`,
      tokensUsed: 0,
      duration: 0,
      permissionRequests: [],
      toolsExecuted: false,
    };
  }

  // List accounts first
  let accountsResult: unknown;
  try {
    const accountsTool = deps.registeredTools.get("email_list_accounts")!;
    accountsResult = await accountsTool.handler({});
  } catch (err) {
    return {
      reply: `❌ 获取邮箱账号列表失败：${err instanceof Error ? err.message : String(err)}`,
      tokensUsed: 0,
      duration: 0,
      permissionRequests: [],
      toolsExecuted: false,
    };
  }

  const accountsData = accountsResult as { success: boolean; accounts?: unknown[] };
  if (!accountsData?.success || !accountsData.accounts?.length) {
    return {
      reply: `📭 您还没有配置任何邮箱账号。\n\n请先提供邮箱信息，例如：\n📧 邮箱账号：yourname@163.com\n🔑 授权码：您的授权码`,
      tokensUsed: 0,
      duration: 0,
      permissionRequests: [],
      toolsExecuted: false,
    };
  }

  // Get inbox summary
  if (!deps.registeredTools.has("email_get_inbox_summary")) {
    return {
      reply: `⚠️ 邮箱功能未完整配置，无法读取收件箱。请联系管理员。`,
      tokensUsed: 0,
      duration: 0,
      permissionRequests: [],
      toolsExecuted: false,
    };
  }

  let summaryResult: unknown;
  try {
    const summaryTool = deps.registeredTools.get("email_get_inbox_summary")!;
    summaryResult = await summaryTool.handler({});
  } catch (err) {
    return {
      reply: `❌ 获取收件箱摘要失败：${err instanceof Error ? err.message : String(err)}`,
      tokensUsed: 0,
      duration: 0,
      permissionRequests: [],
      toolsExecuted: false,
    };
  }

  const summaryData = summaryResult as { success: boolean; summary?: { total: number; unread: number; categories: Record<string, number> }; error?: string };
  if (!summaryData?.success) {
    return {
      reply: `❌ 无法获取邮箱摘要：${summaryData?.error || "未知错误"}\n\n可能是邮箱账号配置有误或网络连接问题。`,
      tokensUsed: 0,
      duration: 0,
      permissionRequests: [],
      toolsExecuted: false,
    };
  }

  const { total, unread, categories } = summaryData.summary!;

  // List recent emails
  let emails: unknown[] = [];
  if (deps.registeredTools.has("email_list_inbox")) {
    try {
      const inboxTool = deps.registeredTools.get("email_list_inbox")!;
      const inboxResult = await inboxTool.handler({ limit: 20 });
      const inboxData = inboxResult as { success: boolean; emails?: unknown[] };
      if (inboxData?.success && inboxData.emails) {
        emails = inboxData.emails;
      }
    } catch (inboxErr) {
      process.stderr.write(`[EmailHandler] Failed to get email inbox: ${inboxErr instanceof Error ? inboxErr.message : String(inboxErr)}`);
    }
  }

  // Generate report
  const now = new Date();
  const reportTime = now.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  let report = `📬 邮箱整理报告\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  report += `📅 生成时间：${reportTime}\n\n`;
  report += `📊 收件箱概览：\n`;
  report += `• 总邮件数：${total} 封\n`;
  report += `• 未读邮件：${unread} 封\n\n`;

  report += `📁 邮件分类统计：\n`;
  for (const [category, count] of Object.entries(categories)) {
    if (count > 0) {
      report += `• ${category}：${count} 封\n`;
    }
  }

  if (emails.length > 0) {
    report += `\n📋 最近邮件：\n`;
    for (let i = 0; i < Math.min(emails.length, 10); i++) {
      const email = emails[i] as { subject: string; from: string; date: Date; snippet: string };
      const date = email.date instanceof Date ? email.date.toLocaleDateString("zh-CN") : new Date(email.date).toLocaleDateString("zh-CN");
      report += `\n${i + 1}. ${email.subject || "(无主题)"}\n`;
      report += `   📤 发件人：${email.from || "未知"}\n`;
      report += `   📅 日期：${date}\n`;
      if (email.snippet) {
        report += `   📝 预览：${email.snippet.substring(0, 100)}...\n`;
      }
    }
  }

  report += `\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
  report += `✅ 邮件整理完成！`;

  return {
    reply: report,
    tokensUsed: 0,
    duration: 0,
    permissionRequests: [],
    toolsExecuted: false,
  };
}
