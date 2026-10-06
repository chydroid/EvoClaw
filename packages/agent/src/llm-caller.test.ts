import { describe, it, expect, beforeEach } from "vitest";
import * as http from "http";
import { isProviderSafetyRejection, nativeFetch, ProviderHealthTracker, buildOpenAITools } from "./llm-caller";

// ═══════════════════════════════════════════════════════════
// 测试套件：LLM Caller 安全过滤拒绝检测
// 覆盖：Mimo 等远程提供商返回的纯文本拒绝信息
// ═══════════════════════════════════════════════════════════

describe("llm-caller > isProviderSafetyRejection", () => {
  // TC-001: 精确匹配 Mimo 高风险拒绝文案
  it("TC-001: 应识别 Mimo 高风险拒绝文案", () => {
    expect(
      isProviderSafetyRejection(
        "The request was rejected because it was considered high risk",
      ),
    ).toBe(true);
  });

  // TC-002: 大小写不敏感
  it("TC-002: 大小写不敏感", () => {
    expect(
      isProviderSafetyRejection(
        "the request was rejected because it was considered high risk",
      ),
    ).toBe(true);
    expect(
      isProviderSafetyRejection(
        "THE REQUEST WAS REJECTED BECAUSE IT WAS CONSIDERED HIGH RISK",
      ),
    ).toBe(true);
  });

  // TC-003: 部分匹配
  it("TC-003: 应识别包含核心短语的拒绝文案", () => {
    expect(isProviderSafetyRejection("This request was considered high risk.")).toBe(true);
    expect(isProviderSafetyRejection("rejected due to safety concerns")).toBe(true);
    expect(isProviderSafetyRejection("content filter triggered")).toBe(true);
    expect(isProviderSafetyRejection("Your input was blocked by the filter")).toBe(true);
    expect(isProviderSafetyRejection("request was blocked")).toBe(true);
  });

  // TC-004: 非拒绝文案不应误伤
  it("TC-004: 正常回复不应被识别为安全拒绝", () => {
    expect(isProviderSafetyRejection("信阳市平桥区明天日出 05:20，日落 19:35。")).toBe(false);
    expect(isProviderSafetyRejection("这是一个高风险投资，请谨慎。")).toBe(false);
    expect(isProviderSafetyRejection("")).toBe(false);
  });

  // TC-005: 空值处理
  it("TC-005: 空值/未定义值应返回 false", () => {
    expect(isProviderSafetyRejection(null)).toBe(false);
    expect(isProviderSafetyRejection(undefined)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 测试套件：nativeFetch 超时控制
// ═══════════════════════════════════════════════════════════

describe("llm-caller > nativeFetch", () => {
  it("应在指定超时时间内中断慢响应请求", async () => {
    const server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end("ok");
      }, 500);
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      await expect(
        nativeFetch(`http://127.0.0.1:${port}/slow`, { timeout: 100 })
      ).rejects.toThrow(/timeout|aborted/i);
    } finally {
      server.close();
    }
  });

  it("正常响应不应被短超时误杀", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("pong");
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const res = await nativeFetch(`http://127.0.0.1:${port}/fast`, { timeout: 2000 });
      expect(res.ok).toBe(true);
      expect(await res.text()).toBe("pong");
    } finally {
      server.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 测试套件：ProviderHealthTracker 熔断与健康度评估
// ═══════════════════════════════════════════════════════════

describe("llm-caller > ProviderHealthTracker", () => {
  let tracker: ProviderHealthTracker;

  beforeEach(() => {
    tracker = new ProviderHealthTracker(2, 1000);
  });

  it("连续成功应重置失败计数", () => {
    tracker.recordFailure("p1");
    tracker.recordSuccess("p1");
    tracker.recordFailure("p1");
    expect(tracker.isTripped("p1")).toBe(false);
    tracker.recordFailure("p1");
    expect(tracker.isTripped("p1")).toBe(true);
  });

  it("熔断冷却后应恢复可用", async () => {
    tracker.recordFailure("p1");
    tracker.recordFailure("p1");
    expect(tracker.isTripped("p1")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(tracker.isTripped("p1")).toBe(false);
  });

  it("应正确统计成功率与平均响应时间", () => {
    tracker.recordSuccess("p1", 100);
    tracker.recordSuccess("p1", 200);
    tracker.recordFailure("p1");

    const snap = tracker.getSnapshot("p1");
    expect(snap.totalSuccesses).toBe(2);
    expect(snap.totalFailures).toBe(1);
    expect(snap.consecutiveFailures).toBe(1);
    expect(snap.averageResponseMs).toBe(150);
    expect(snap.tripped).toBe(false);
  });

  it("reset 应清空指定 provider 状态", () => {
    tracker.recordFailure("p1");
    tracker.recordFailure("p1");
    tracker.reset("p1");
    expect(tracker.isTripped("p1")).toBe(false);
    expect(tracker.getSnapshot("p1").totalFailures).toBe(0);
  });
});

// ─── 回归：工具下发裁剪不得吃掉「创建/添加」类能力 ───
// 事故：「添加邮箱账户」因 email 组关键词缺「邮箱」而未激活该组，
// email_add_account 被静默裁剪，模型遂称「系统没有添加接口」。
describe("buildOpenAITools — 关键词激活不得吃掉创建类能力（回归）", () => {
  const mk = (names: string[]) =>
    new Map(names.map((n) => [n, { definition: { name: n, description: "d", parameters: {} }, handler: async () => ({}) }]));

  const REG = mk([
    "web_search", "web_fetch", "file_read", "file_create", "file_modify",
    "file_list", "file_delete", "shell_exec", "sequential_thinking",
    "skill_execute", "skill_install",
    "email_add_account", "email_send", "email_analyze", "email_summarize",
    "email_list_accounts", "email_list_inbox", "email_get_inbox_summary",
    "scheduler_create", "scheduler_list",
    "kanban_create_board", "kanban_add_task",
  ]);
  const sent = (msg?: string) =>
    buildOpenAITools(REG, msg, (fn) => fn()).map((t) => t.function.name as string);

  it("★ 说「添加邮箱账户」时 email_add_account 必须下发", () => {
    expect(sent("帮我添加邮箱账户 chydroid@163.com")).toContain("email_add_account");
  });

  it("★ 各种中文措辞下 email_add_account 都不丢失", () => {
    for (const msg of ["添加邮箱", "配置邮箱", "注册个邮箱", "把我的邮箱接进来",
                       "添加邮箱账号", "设置邮箱", "163邮箱", "imap 收信"]) {
      expect(sent(msg), `消息「${msg}」下发了 email_add_account`).toContain("email_add_account");
    }
  });

  it("★ 完全无关的消息也不会裁掉创建类工具（白名单兜底）", () => {
    const names = sent("今天天气怎么样");
    expect(names).toContain("email_add_account");
    expect(names).toContain("scheduler_create");
    expect(names).toContain("kanban_create_board");
    expect(names).toContain("kanban_add_task");
  });

  it("未激活的组内非创建类工具仍可被裁剪（保留裁剪省 token 的能力）", () => {
    // email_send 在 email 组且非创建类：无关消息下应被裁剪
    expect(sent("今天天气怎么样")).not.toContain("email_send");
  });

  it("命中关键词时整组恢复下发", () => {
    const names = sent("发邮件给张三");
    expect(names).toContain("email_send");
    expect(names).toContain("email_add_account");
  });

  it("checkFn 返回 false 的工具仍然不下发（白名单不覆盖可用性门禁）", () => {
    const reg = mk(["email_add_account", "web_search"]);
    reg.get("email_add_account")!.checkFn = () => false;
    const names = buildOpenAITools(reg, "添加邮箱", (fn) => fn()).map((t) => t.function.name as string);
    expect(names).not.toContain("email_add_account");
  });
});
