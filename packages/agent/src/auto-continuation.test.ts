import { describe, it, expect } from "vitest";
import {
  detectPrematureStop,
  buildContinuationDirective,
  isPlaceholderOnlyReply,
  shouldGrantFinalRoundContinuation,
} from "./auto-continuation";

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
      "✅ 添加邮箱 chydroid@163.com 完成，email 的 list_accounts 已核验到该账户。",
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

describe("占位符回复 — 2026-11-16 邮箱任务事故", () => {
  it("整条回复只有「[工具结果]」→ placeholder_reply", () => {
    expect(detectPrematureStop("[工具结果]")).toBe("placeholder_reply");
    expect(detectPrematureStop("【工具结果】")).toBe("placeholder_reply");
    expect(detectPrematureStop("工具执行结果")).toBe("placeholder_reply");
    expect(detectPrematureStop("[tool result]")).toBe("placeholder_reply");
  });

  it("isPlaceholderOnlyReply 只认整条占位符，不误伤正文引用", () => {
    expect(isPlaceholderOnlyReply("[工具结果]")).toBe(true);
    expect(isPlaceholderOnlyReply("工具已执行完毕，结果如下：共 3 封未读邮件")).toBe(false);
    expect(isPlaceholderOnlyReply("[工具结果]\n错误：未找到邮箱账户")).toBe(false);
  });

  it("占位符续跑指令要求真正执行并禁止再次输出占位符", () => {
    const d = buildContinuationDirective({
      kind: "placeholder_reply",
      userMessage: "检查我现在的邮箱 chydroid@163.com 内容并整理提示我重要信息",
    });
    expect(d).toContain("占位符");
    expect(d).toContain("任务并未完成");
    expect(d).toContain("绝对禁止只输出");
    expect(d).toContain("chydroid@163.com");
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
      // 原 email_analyze 已合并为 email 的 analyze action
      emptyResultTools: [{ name: "email", field: "totalEmails=0（email action=analyze）" }],
    });
    expect(d).toContain("email");
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

describe("detectPrematureStop — 2026-10-07 12:16 会话新增话术（回归）", () => {
  // 真实事故：模型在 file_write(action=create) 被拦、node -e 报错后收尾时说了这些话，
  // 上一版规则全部漏掉，于是它"轻易停止"了任务。
  it("★「告诉我一声就动手」应判定为停顿", () => {
    expect(detectPrematureStop("你告诉我一声我就动手 🧬")).toBe("ask_user_to_continue");
  });

  it("★「或者我也可以继续」应判定为停顿", () => {
    expect(detectPrematureStop("或者，如果你希望我先尝试另一种方式，我也可以继续")).toBe("ask_user_permission");
  });

  it("★「请在弹窗中批准…我立刻开工」应判定为停顿", () => {
    expect(
      detectPrematureStop("请在弹窗中批准文件创建请求，我立刻开工。", { toolCallsThisRound: false }),
    ).toBe("promise_future_action");
  });

  it("如实汇报失败原因 + 继续汇报其它结果时不误判", () => {
    expect(
      detectPrematureStop(
        "node -e 因引号转义失败，我已改用脚本文件重跑。共读取 14 个文件，其中 12 个是 docx。",
        { toolCallsThisRound: false },
      ),
    ).toBeNull();
  });
});

describe("detectPrematureStop — 不得把「劝用户继续」当成停顿（反向回归）", () => {
  it("★「你可以继续」是正常的收尾话术，不判为停顿", () => {
    expect(detectPrematureStop("脚本已修复并跑通，你可以继续下一步了。")).toBeNull();
  });

  it("★「请告诉我是否继续」是征询，仍判为停顿", () => {
    expect(detectPrematureStop("请告诉我是否继续处理剩下的文件")).not.toBeNull();
  });
});

describe("detectPrematureStop — 序数承诺（v4 Task 7 回归）", () => {
  it("★「接下来是第三个文件」应判定为停顿", () => {
    expect(
      detectPrematureStop(
        "已创建完成。在 /tmp/v4-monitor/ 目录下，已生成 monitor.sh 和 notify.sh。接下来是第三个文件（systemd service）以及部署验证说明。",
        { toolCallsThisRound: false },
      ),
    ).toBe("promise_future_action");
  });

  it("本轮已调用工具时不判为停顿（过程叙述）", () => {
    expect(
      detectPrematureStop("已创建完成。接下来是第三个文件（systemd service）。", {
        toolCallsThisRound: true,
      }),
    ).toBeNull();
  });
});

describe("detectPrematureStop — 进度报告式收尾（v28 Task 1/4 回归）", () => {
  const T1_REPLY =
    "主人，先汇报当前进度（还在进行中，还没到最后一步）：\n" +
    "**还没做**\n- README.md、真实运行 CLI 生成 report.json\n" +
    "我先把剩下的全部跑完再给你最终汇报。";

  const T4_REPLY =
    "**尚未执行**：\n- CLI 生成 report.json\n- 顶层 part 数量尚未向主人汇报\n" +
    "**下一步**：修正 test_multipart.py 中 3/4/5 用例的 body 构造。";

  it("★ T1：『还在进行中 / 还没做 / 先把剩下的跑完再汇报』→ 自动续跑", () => {
    expect(detectPrematureStop(T1_REPLY, { toolCallsThisRound: false }))
      .toBe("promise_future_action");
  });

  it("★ T4：『尚未执行 / 尚未向主人汇报 / 下一步：修正』→ 自动续跑", () => {
    expect(detectPrematureStop(T4_REPLY, { toolCallsThisRound: false }))
      .toBe("promise_future_action");
  });

  it("本轮确实执行了工具时视为过程叙述，不续跑", () => {
    expect(detectPrematureStop(T4_REPLY, { toolCallsThisRound: true })).toBeNull();
  });

  it("『尚未发现异常 / 下一步建议』这类结论与建议不误判", () => {
    expect(
      detectPrematureStop("尚未发现异常，全部 12 项测试通过。下一步建议：拆分部署。", {
        toolCallsThisRound: false,
      }),
    ).toBeNull();
  });
});

describe("shouldGrantFinalRoundContinuation — 末轮一次性续跑宽限（v28 Task 7）", () => {
  const base = {
    atFinalRound: true,
    premature: "promise_future_action" as const,
    alreadyGranted: false,
    autoContinueCount: 0,
    maxAutoContinue: 3,
    tokensUsed: 1_000,
    tokenBudget: 100_000,
  };

  it("末轮 + 检测到停顿 + 未用过 + 预算充足 → 授予", () => {
    expect(shouldGrantFinalRoundContinuation(base)).toBe(true);
  });

  it("非末轮不授予（常规续跑门负责）", () => {
    expect(shouldGrantFinalRoundContinuation({ ...base, atFinalRound: false })).toBe(false);
  });

  it("没有检测到停顿不授予", () => {
    expect(shouldGrantFinalRoundContinuation({ ...base, premature: null })).toBe(false);
  });

  it("已授予过（每 turn 一次）不重复授予", () => {
    expect(shouldGrantFinalRoundContinuation({ ...base, alreadyGranted: true })).toBe(false);
  });

  it("自动续跑次数已用尽不授予", () => {
    expect(shouldGrantFinalRoundContinuation({ ...base, autoContinueCount: 3 })).toBe(false);
  });

  it("token 用量达到预算 90% 不授予", () => {
    expect(shouldGrantFinalRoundContinuation({ ...base, tokensUsed: 90_000 })).toBe(false);
    expect(shouldGrantFinalRoundContinuation({ ...base, tokensUsed: 89_999 })).toBe(true);
  });

  it("预算为 0（未知）不授予", () => {
    expect(shouldGrantFinalRoundContinuation({ ...base, tokenBudget: 0 })).toBe(false);
  });
});
