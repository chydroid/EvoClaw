import { describe, it, expect } from "vitest";
import {
  claimsCompletion,
  hasActionIntent,
  reconcileCompletionTruthfulness,
  extractEmptyResult,
  looksLikeDetailedReport,
  extractToolFailure,
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

describe("extractToolFailure — 识别「执行了但失败」的工具返回（回归）", () => {
  it("★ skill_execute 的外层 success:true / 内层 errors 包装必须被识别", () => {
    // 真实事故：调用 skill_execute("email_add_account") 返回该结构，
    // 模型误读为成功并回复「✅ 添加邮箱完成」。
    const raw = {
      success: true,
      result: { skillId: "email_add_account", success: false, output: null, errors: ["Skill not found"] },
    };
    const failure = extractToolFailure("skill_execute", raw);
    expect(failure).toBeTruthy();
    expect(failure).toContain("Skill not found");
  });

  it("识别 { success:false, error } 与 { success:false, errors:[...] }", () => {
    expect(extractToolFailure("t", { success: false, error: "boom" })).toBe("boom");
    expect(extractToolFailure("t", { success: false, errors: ["a", "b"] })).toBe("a; b");
  });

  it("识别 JSON 字符串形态", () => {
    expect(extractToolFailure("t", JSON.stringify({ success: false, error: "x" }))).toBe("x");
  });

  it("成功返回不产生失败证据", () => {
    expect(extractToolFailure("t", { success: true, accountId: "acct-1" })).toBeNull();
    expect(extractToolFailure("t", { success: true })).toBeNull();
  });

  it("★ 等待审批不属于失败（由 pendingPermissions 分支处理）", () => {
    expect(extractToolFailure("t", { success: false, requiresPermission: true, error: "Awaiting approval" })).toBeNull();
    expect(extractToolFailure("t", { success: false, status: "pending", error: "x" })).toBeNull();
  });

  it("null / 非对象 / 非法 JSON 安全返回 null", () => {
    expect(extractToolFailure("t", null)).toBeNull();
    expect(extractToolFailure("t", 42)).toBeNull();
    expect(extractToolFailure("t", "not json")).toBeNull();
  });
});

describe("reconcileCompletionTruthfulness — 工具失败却声称完成（回归）", () => {
  it("★ 完成声明 + 工具失败 → 必须追加更正", () => {
    const v = reconcileCompletionTruthfulness({
      finalReply: "✅ 添加邮箱 chydroid@163.com 完成",
      toolsExecuted: true,
      lastUserMessage: "添加邮箱 chydroid@163.com",
      failedTools: [{ name: "skill_execute", error: "Skill not found" }],
    });
    expect(v.needsCorrection).toBe(true);
    expect(v.reason).toBe("tool_failed");
    expect(v.notice).toContain("skill_execute");
    expect(v.notice).toContain("Skill not found");
  });

  it("工具全部成功时不误报", () => {
    const v = reconcileCompletionTruthfulness({
      finalReply: "✅ 添加邮箱完成",
      toolsExecuted: true,
      lastUserMessage: "添加邮箱",
      failedTools: [],
    });
    expect(v.needsCorrection).toBe(false);
  });

  it("未声称完成时不干预", () => {
    const v = reconcileCompletionTruthfulness({
      finalReply: "我暂时无法完成，需要你先开启 IMAP",
      toolsExecuted: true,
      failedTools: [{ name: "x", error: "y" }],
    });
    expect(v.needsCorrection).toBe(false);
  });

  it("等待审批优先于失败（不重复叠加）", () => {
    const v = reconcileCompletionTruthfulness({
      finalReply: "✅ 已完成",
      toolsExecuted: true,
      failedTools: [{ name: "x", error: "y" }],
      pendingPermissions: [{ id: "r1", operation: "file_modify", description: "d", target: "t" }],
    });
    expect(v.reason).toBe("pending_permissions");
  });
});

describe("extractEmptyResult / looksLikeDetailedReport — 空结果却产出详细报告（回归）", () => {
  it("★ email_analyze 返回 totalEmails=0 必须被判定为空结果", () => {
    // 真实事故：工具返回 0 封，模型却输出「共 30+ 封邮件 + 分类数量表」
    const raw = { success: true, totalEmails: 0, categories: {}, topSenders: [], topKeywords: [], actionItems: [] };
    const e = extractEmptyResult("email_analyze", raw);
    expect(e).toBeTruthy();
    expect(e!.name).toBe("email_analyze");
  });

  it("★ 空结果 + 产出精确数量明细 → 必须在没有完成声明时也触发更正", () => {
    const reply = "## 📊 邮件概览\n\n共拉取到 **30+ 封**邮件（2026-09-07 ~ 2026-10-07）\n\n| 类别 | 数量 |\n|---|---|\n| GitHub CI/CD 通知 | 4 |";
    const v = reconcileCompletionTruthfulness({
      finalReply: reply,
      toolsExecuted: true,
      emptyResultTools: [{ name: "email_analyze", field: "totalEmails=0" }],
    });
    expect(v.needsCorrection).toBe(true);
    expect(v.reason).toBe("empty_but_detailed");
    expect(v.notice).toContain("email_analyze");
  });

  it("空结果但回复如实说明「没有数据」时不干预", () => {
    const v = reconcileCompletionTruthfulness({
      finalReply: "抱歉，工具返回了 0 封邮件，可能账号未配置或时间范围内没有邮件。请先确认配置。",
      emptyResultTools: [{ name: "email_analyze", field: "totalEmails=0" }],
    });
    expect(v.needsCorrection).toBe(false);
  });

  it("有实质数据时不判为空结果", () => {
    expect(extractEmptyResult("t", { success: true, totalEmails: 12, categories: { a: 3 } })).toBeNull();
    expect(extractEmptyResult("t", { success: true, emails: [{ uid: "1" }] })).toBeNull();
  });

  it("失败结果不算空结果（避免两个分支叠加）", () => {
    expect(extractEmptyResult("t", { success: false, error: "boom", totalEmails: 0 })).toBeNull();
  });

  it("空数组与包装形态也能识别", () => {
    expect(extractEmptyResult("t", [])).toBeTruthy();
    expect(extractEmptyResult("t", { success: true, result: { totalEmails: 0 } })).toBeTruthy();
  });

  it("looksLikeDetailedReport 的判定边界", () => {
    expect(looksLikeDetailedReport("共 30+ 封邮件")).toBe(true);
    expect(looksLikeDetailedReport("| GitHub 通知 | 4 |")).toBe(true);
    expect(looksLikeDetailedReport("1. 甲\n2. 乙\n3. 丙")).toBe(true);
    expect(looksLikeDetailedReport("好的，我知道了")).toBe(false);
  });
});
