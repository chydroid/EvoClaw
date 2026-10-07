import { describe, it, expect } from "vitest";
import { detectPrematureStop, buildContinuationDirective } from "./auto-continuation";

describe("detectPrematureStop — 识别「该继续却停下来问人」", () => {
  // 真实事故话术（来自 2026-10-07 的会话记录）
  const REAL_CASES: Array<[string, string]> = [
    ["你回个 A 或 B，我就继续 🧬", "ask_user_to_continue"],
    ["下一步怎么走，主人你定：\n• A（推荐）：我马上用授权码跑一次 IMAP 登录", "ask_user_to_continue"],
    ["请回复继续，我就开工", "ask_user_to_continue"],
    ["需要你确认一件事（很关键）：chydroid@163.com 是否已开启 IMAP？", "ask_user_to_continue"],
  ];

  it.each(REAL_CASES)("★ 真实事故话术「%s」应判定为停顿", (reply, kind) => {
    expect(detectPrematureStop(reply)).toBe(kind);
  });

  it("★ 承诺后续动作且本轮没有工具调用 → 判定为停顿", () => {
    expect(detectPrematureStop("接下来我将拉取收件箱并汇总", { toolCallsThisRound: false }))
      .toBe("promise_future_action");
    expect(detectPrematureStop("我马上用 imaplib 直连拉取", { toolCallsThisRound: false }))
      .toBe("promise_future_action");
  });

  it("★ 承诺后续动作但本轮确实调用了工具 → 不算停顿（正常的进度叙述）", () => {
    expect(detectPrematureStop("接下来我将核对返回结果", { toolCallsThisRound: true })).toBeNull();
  });

  it("★ 以问句把决定权交还用户 → 判定为停顿", () => {
    expect(detectPrematureStop("要不要我帮你继续拉取收件箱？")).toBe("ask_user_permission");
    expect(detectPrematureStop("需要我帮你配置吗？")).toBe("ask_user_permission");
    expect(detectPrematureStop("我可以继续吗？")).toBe("ask_user_permission");
  });

  it("正常完成汇报不误判（含「已完成」「核实如下」等）", () => {
    for (const ok of [
      "✅ 添加邮箱 chydroid@163.com 完成，email_list_accounts 已核验到该账户。",
      "已拉取到 12 封邮件，主题列表如下：…",
      "抱歉，163 邮箱未开启 IMAP，我无法连接。请在 163 网页端开启后再试。",
      "命令执行失败：python -c 在 Windows 下引号转义会报错。我已改用脚本文件重跑，结果如下：…",
    ]) {
      expect(detectPrematureStop(ok), `不应误判：「${ok}」`).toBeNull();
    }
  });

  it("空回复 / 空白不判为停顿", () => {
    expect(detectPrematureStop("")).toBeNull();
    expect(detectPrematureStop("   \n  ")).toBeNull();
  });

  it("「请在审批通过后让我重新确认结果」不误判（审批属正常停顿）", () => {
    expect(detectPrematureStop("⚠️ 更正：以下操作仍在等待你的审批，请在审批通过后让我重新确认结果。")).toBeNull();
  });
});

describe("buildContinuationDirective — 续跑指令", () => {
  it("★ 必须明确要求「立即继续、不要询问用户」", () => {
    const d = buildContinuationDirective({ kind: "ask_user_to_continue", userMessage: "添加邮箱账户" });
    expect(d).toContain("立即继续执行");
    expect(d).toContain("不要再询问用户");
    expect(d).toContain("添加邮箱账户");
  });

  it("★ 工具失败时给出「换一种方式重试」的可执行指引", () => {
    const d = buildContinuationDirective({
      kind: "needs_correction",
      failedTools: [{ name: "shell_exec", error: "exit code 1" }],
    });
    expect(d).toContain("shell_exec");
    expect(d).toContain("exit code 1");
    expect(d).toContain("换一种方式重试");
  });

  it("★ 空结果时要求先排查原因，不得凭空补数据", () => {
    const d = buildContinuationDirective({
      kind: "needs_correction",
      emptyResultTools: [{ name: "email_analyze", field: "totalEmails=0" }],
    });
    expect(d).toContain("email_analyze");
    expect(d).toContain("空/零结果");
    expect(d).toContain("不要凭空补数据");
  });

  it("带入 completion-truthfulness 的更正说明", () => {
    const d = buildContinuationDirective({
      kind: "needs_correction",
      correction: "\n\n---\n⚠️ **更正**：上面的「已完成」并不成立。",
    });
    expect(d).toContain("系统对账发现的问题");
    expect(d).toContain("更正");
  });

  it("★ 保留合法的「停下询问」例外（缺凭据 / 需审批）", () => {
    const d = buildContinuationDirective({ kind: "ask_user_to_continue" });
    expect(d).toContain("确实缺少你无法自行获取的必要信息");
    expect(d).toContain("需要人工审批");
  });

  it("指令结尾要求直接执行、不要复述", () => {
    expect(buildContinuationDirective({ kind: "promise_future_action" })).toContain("不要复述本指令");
  });
});
