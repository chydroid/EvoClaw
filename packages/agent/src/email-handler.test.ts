import { describe, it, expect, vi } from "vitest";
import { handleEmailOperation, type EmailHandlerDeps } from "./email-handler";
import type { ToolDefinition } from "./types";

const definition: ToolDefinition = {
  name: "email",
  description: "email tool",
  parameters: {},
};

function buildDeps(handler: (args: Record<string, unknown>) => Promise<unknown>): EmailHandlerDeps {
  return {
    registeredTools: new Map([
      ["email", { definition, handler }],
    ]),
    registry: {} as never,
  };
}

function fakeEmailBackend() {
  const calls: Array<Record<string, unknown>> = [];
  const handler = vi.fn(async (args: Record<string, unknown>) => {
    calls.push(args);
    switch (args.action) {
      case "list_accounts":
        return {
          success: true,
          accounts: [
            { id: "acc-163", email: "chydroid@163.com" },
            { id: "acc-other", email: "other@example.com" },
          ],
        };
      case "inbox_summary":
        return {
          success: true,
          summary: {
            total: 3,
            unread: 2,
            totalAll: 10,
            categories: { "安全/账户": 1, "账单/财务": 1 },
          },
        };
      case "list_inbox":
        return {
          success: true,
          emails: [
            {
              subject: "【紧急】请确认登录异常",
              from: "security@example.com",
              date: new Date().toISOString(),
              snippet: "检测到新设备登录",
              flags: [],
              categories: ["安全/账户"],
            },
            {
              subject: "本月账单",
              from: "billing@example.com",
              date: new Date().toISOString(),
              snippet: "账单已出",
              flags: ["\\Seen"],
              categories: ["账单/财务"],
            },
          ],
        };
      case "send":
        return { success: true, messageId: "mid-1" };
      default:
        return { success: false, error: `unexpected action: ${String(args.action)}` };
    }
  });
  return { handler, calls };
}

describe("handleEmailOperation — 自然语言收件箱整理", () => {
  it("★ 2026-11-16 事故原话应触发确定性收件箱整理，而不是落到 LLM", async () => {
    const { handler, calls } = fakeEmailBackend();
    const deps = buildDeps(handler);
    const result = await handleEmailOperation(
      deps,
      "检查我现在的邮箱chydroid@163.com内容并整理提示我重要信息",
    );

    expect(result).not.toBeNull();
    expect(result?.toolsExecuted).toBe(true);
    // 必须点名用户指定的账号，不能静默改读其它账号
    const summaryCall = calls.find((c) => c.action === "inbox_summary");
    const inboxCall = calls.find((c) => c.action === "list_inbox");
    expect(summaryCall?.accountId).toBe("acc-163");
    expect(inboxCall?.accountId).toBe("acc-163");
    // 报告必须包含账号、概览与重点关注邮件
    expect(result?.reply).toContain("chydroid@163.com");
    expect(result?.reply).toContain("邮件数：3 封");
    expect(result?.reply).toContain("未读：2 封");
    expect(result?.reply).toContain("需要重点关注的邮件");
    expect(result?.reply).toContain("【紧急】请确认登录异常");
  });

  it.each([
    "帮我看看邮件",
    "查看一下收件箱",
    "整理所有邮件并汇总重要信息",
    "列出未读邮件",
  ])("自然说法「%s」应命中邮件处理路径", async (message) => {
    const { handler, calls } = fakeEmailBackend();
    const result = await handleEmailOperation(buildDeps(handler), message);
    expect(result).not.toBeNull();
    expect(calls.some((c) => c.action === "inbox_summary")).toBe(true);
  });

  it("添加/配置邮箱账号意图不应被收件箱路径拦截", async () => {
    for (const message of [
      "添加邮箱账号 chydroid@163.com 授权码 abc",
      "检查邮箱配置是否正确",
      "检查邮件服务器配置",
    ]) {
      const { handler, calls } = fakeEmailBackend();
      const result = await handleEmailOperation(buildDeps(handler), message);
      expect(result, `不应拦截：「${message}」`).toBeNull();
      expect(calls).toHaveLength(0);
    }
  });

  it("粘贴长邮件正文让我总结时不应误判成收件箱操作", async () => {
    const { handler, calls } = fakeEmailBackend();
    const message = `帮我总结一下这封邮件的要点：${"这是一段很长的邮件正文。".repeat(40)}`;
    expect(message.length).toBeGreaterThan(300);
    const result = await handleEmailOperation(buildDeps(handler), message);
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("用户点名一个未配置的邮箱时如实告知，不改读其它账号", async () => {
    const { handler, calls } = fakeEmailBackend();
    const result = await handleEmailOperation(buildDeps(handler), "检查我现在的邮箱nobody@example.com内容");
    expect(result?.reply).toContain("未找到邮箱账号 nobody@example.com");
    expect(calls.map((c) => c.action)).toEqual(["list_accounts"]);
  });
});
