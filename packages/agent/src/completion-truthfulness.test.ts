import { describe, it, expect } from "vitest";
import {
  claimsCompletion,
  hasActionIntent,
  reconcileCompletionTruthfulness,
  type PendingPermission,
} from "./completion-truthfulness";

const pendingEmail: PendingPermission[] = [
  {
    id: "req-1",
    operation: "email_add_account",
    description: "添加邮箱账户",
    target: "demo@example.com",
  },
];

describe("claimsCompletion", () => {
  it("识别中文完成声明", () => {
    expect(claimsCompletion("✅ 添加邮箱 demo@example.com 完成")).toBe(true);
    expect(claimsCompletion("已经配置好了")).toBe(true);
    expect(claimsCompletion("发送成功")).toBe(true);
    expect(claimsCompletion("搞定了")).toBe(true);
  });

  it("识别英文完成声明", () => {
    expect(claimsCompletion("The account has been added.")).toBe(true);
    expect(claimsCompletion("successfully created")).toBe(true);
    expect(claimsCompletion("All done.")).toBe(true);
  });

  it("不把询问/承诺句式误判为完成声明", () => {
    expect(claimsCompletion("需要我帮你添加邮箱吗？")).toBe(false);
    expect(claimsCompletion("我可以帮你完成这个配置")).toBe(false);
    expect(claimsCompletion("")).toBe(false);
  });
});

describe("hasActionIntent", () => {
  it("识别中文执行类意图", () => {
    expect(hasActionIntent("添加邮箱 demo@example.com")).toBe(true);
    expect(hasActionIntent("帮我把这个文件删掉")).toBe(true);
    expect(hasActionIntent("安装一下依赖")).toBe(true);
  });

  it("识别英文执行类意图", () => {
    expect(hasActionIntent("please add an email account")).toBe(true);
    expect(hasActionIntent("delete the old config")).toBe(true);
  });

  it("纯问答不算执行类意图", () => {
    expect(hasActionIntent("163 邮箱的 IMAP 服务器地址是什么？")).toBe(false);
    expect(hasActionIntent("")).toBe(false);
  });
});

describe("reconcileCompletionTruthfulness", () => {
  it("复现原始缺陷：无工具执行却声称完成 → 触发更正", () => {
    const r = reconcileCompletionTruthfulness({
      finalReply: "✅ 添加邮箱 demo@example.com 完成",
      pendingPermissions: [],
      toolsExecuted: false,
      lastUserMessage: "添加邮箱 demo@example.com，授权码：xxxx",
    });
    expect(r.needsCorrection).toBe(true);
    expect(r.reason).toBe("no_tool_executed");
    expect(r.notice).toContain("没有实际执行任何工具");
  });

  it("操作仍在等待审批却声称完成 → 触发更正并列出未决操作", () => {
    const r = reconcileCompletionTruthfulness({
      finalReply: "邮箱账户已经添加成功了",
      pendingPermissions: pendingEmail,
      toolsExecuted: true,
      lastUserMessage: "添加邮箱",
    });
    expect(r.needsCorrection).toBe(true);
    expect(r.reason).toBe("pending_permissions");
    expect(r.notice).toContain("email_add_account");
    expect(r.notice).toContain("demo@example.com");
    expect(r.notice).toContain("等待你的审批");
  });

  it("未决审批优先于「无工具执行」判定（即使 toolsExecuted=true）", () => {
    const r = reconcileCompletionTruthfulness({
      finalReply: "已经配置完成",
      pendingPermissions: pendingEmail,
      toolsExecuted: true,
      lastUserMessage: "添加邮箱",
    });
    expect(r.reason).toBe("pending_permissions");
  });

  it("如实报告等待审批（未声称完成）→ 不干预", () => {
    const r = reconcileCompletionTruthfulness({
      finalReply: "添加邮箱的操作已提交，正在等待你的审批，审批通过后我立刻继续。",
      pendingPermissions: pendingEmail,
      toolsExecuted: true,
      lastUserMessage: "添加邮箱",
    });
    expect(r.needsCorrection).toBe(false);
    expect(r.notice).toBeUndefined();
  });

  it("真实执行成功并如实汇报 → 不干预", () => {
    const r = reconcileCompletionTruthfulness({
      finalReply: "已添加邮箱 demo@example.com，accountId=acct-123，回读确认账户已存在。",
      pendingPermissions: [],
      toolsExecuted: true,
      lastUserMessage: "添加邮箱",
    });
    expect(r.needsCorrection).toBe(false);
  });

  it("普通问答/闲聊回复 → 不干预（快速路径）", () => {
    const r = reconcileCompletionTruthfulness({
      finalReply: "163 邮箱的 IMAP 服务器是 imap.163.com，端口 993。",
      pendingPermissions: [],
      toolsExecuted: false,
      lastUserMessage: "163 邮箱的 IMAP 服务器地址是什么？",
    });
    expect(r.needsCorrection).toBe(false);
  });

  it("无完成声明时永远不干预，即使存在未决审批", () => {
    const r = reconcileCompletionTruthfulness({
      finalReply: "我需要你提供授权码才能继续。",
      pendingPermissions: pendingEmail,
      toolsExecuted: false,
      lastUserMessage: "添加邮箱",
    });
    expect(r.needsCorrection).toBe(false);
  });

  it("空回复不报错", () => {
    const r = reconcileCompletionTruthfulness({ finalReply: "" });
    expect(r.needsCorrection).toBe(false);
  });
});
