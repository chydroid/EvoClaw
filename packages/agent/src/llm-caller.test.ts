import { describe, it, expect, beforeEach } from "vitest";
import * as http from "http";
import { isProviderSafetyRejection, nativeFetch, ProviderHealthTracker, buildOpenAITools, validateToolParams, lookupCachedToolResult, NO_RESULT_CACHE_TOOLS } from "./llm-caller";

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

// ═══════════════════════════════════════════════════════════
// validateToolParams / buildOpenAITools — "Optional" 描述参数
// 不得进入 required 列表（回归：eval15 t13，shell_exec 的
// timeout/sandbox 描述含 "Optional" 却仍被当成必填，
// LLM 反复触发 "Missing required parameter" 空转 6+ 轮）
// ═══════════════════════════════════════════════════════════
describe("llm-caller > Optional 参数不进 required", () => {
  const SHELL_PARAMS = {
    command: { type: "string", description: "The shell command to execute." },
    cwd: { type: "string", description: "Optional working directory (default: workspace)" },
    timeout: { type: "string", description: "Optional timeout in seconds (default: 120, max: 1200)." },
    sandbox: { type: "boolean", description: "Optional. When true, execute via LocalSandboxBackend." },
  };
  const def = { definition: { name: "shell_exec", description: "Execute a shell command", parameters: SHELL_PARAMS }, handler: async () => ({}) };

  it("validateToolParams：缺省 Optional 参数不再报 Missing required", () => {
    const err = validateToolParams("shell_exec", { command: "ls" }, def.definition);
    expect(err).toBeNull();
  });

  it("validateToolParams：缺省必填参数仍报错", () => {
    const err = validateToolParams("shell_exec", {}, def.definition);
    expect(err).toMatch(/Missing required parameter "command"/);
  });

  it("buildOpenAITools：Optional 参数不进 required 列表，必填仍在", () => {
    const reg = new Map([["shell_exec", def]]);
    const out = buildOpenAITools(reg, "跑个命令", (fn) => fn());
    const fn = out.find((t) => t.function.name === "shell_exec")!;
    const required = (fn.function.parameters as { required: string[] }).required;
    expect(required).toContain("command");
    expect(required).not.toContain("cwd");
    expect(required).not.toContain("timeout");
    expect(required).not.toContain("sandbox");
  });

  it("显式 required:true 的描述不被 Optional 正则误放（必填标注优先）", () => {
    const p = { x: { type: "string", description: "Required field", required: true } };
    const reg = new Map([["t", { definition: { name: "t", description: "d", parameters: p }, handler: async () => ({}) }]]);
    const out = buildOpenAITools(reg, "m", (fn) => fn());
    const fn = out.find((t) => t.function.name === "t")!;
    expect((fn.function.parameters as { required: string[] }).required).toContain("x");
    expect(validateToolParams("t", {}, reg.get("t")!.definition)).toMatch(/Missing required parameter "x"/);
  });
});

// ═══════════════════════════════════════════════════════════
// 工具结果缓存豁免（回归：eval15 t01，shell_exec 修复后重跑
// 命中修复前的旧输出，误判「修复无效」空转 5+ 轮）
// ═══════════════════════════════════════════════════════════
describe("lookupCachedToolResult — 副作用工具豁免", () => {
  const cache = new Map([
    ["shell_exec:{\"command\":\"node x.js add 3 4\"}", { result: '{"success":true,"output":"7"}', timestamp: Date.now() }],
    ["file_read:{\"path\":\"x.js\"}", { result: "abc", timestamp: Date.now() }],
  ]);

  it("NO_RESULT_CACHE_TOOLS 覆盖命令执行类工具", () => {
    for (const t of ["shell_exec", "execute_code", "run_python", "run_node"]) {
      expect(NO_RESULT_CACHE_TOOLS.has(t)).toBe(true);
    }
  });

  it("NO_RESULT_CACHE_TOOLS 覆盖浏览器工具（页面状态是活对象，结果非 args 纯函数）", () => {
    // 评测事故（2026-10-15 browser-eval b05/b07）：browser_navigate 命中结果缓存
    // → 导航被跳过 → js_eval/get_text 作用在旧页面上。
    for (const t of ["browser_navigate", "browser_get_text", "browser_js_eval", "browser_tabs", "browser_screenshot"]) {
      expect(NO_RESULT_CACHE_TOOLS.has(t)).toBe(true);
    }
    const r = lookupCachedToolResult(
      new Map([["browser_navigate:{\"url\":\"https://x/\"}", { result: "{}", timestamp: Date.now() }]]),
      "browser_navigate",
      { url: "https://x/" },
      300_000
    );
    expect(r).toBeNull();
  });

  it("shell_exec 即使缓存命中也不复用（结果非 args 纯函数）", () => {
    const r = lookupCachedToolResult(cache, "shell_exec", { command: "node x.js add 3 4" }, 300_000);
    expect(r).toBeNull();
  });

  it("读类工具（file_read）缓存行为不变", () => {
    const r = lookupCachedToolResult(cache, "file_read", { path: "x.js" }, 300_000);
    expect(r).toBe("abc");
  });
});

// ═══════════════════════════════════════════════════════════
// 工具参数 JSON 字符串自动解析（回归：实例任务 worktemp.zip，
// docx_create 的 paragraphs/tables 被模型以 JSON 字符串下发，
// 旧校验直接报 "expected array, got string" 导致成品无法生成）
// ═══════════════════════════════════════════════════════════
describe("validateToolParams — array/object 参数的 JSON 字符串自动解析", () => {
  const DOCX_PARAMS = {
    path: { type: "string", description: "Relative file path to create", required: true },
    paragraphs: {
      type: "array",
      description: "Optional. List of paragraphs.",
      items: { type: "object" },
    },
    meta: { type: "object", description: "Optional. Metadata object." },
  };
  const def = { definition: { name: "docx_create", description: "d", parameters: DOCX_PARAMS }, handler: async () => ({}) };

  it("array 参数收到合法 JSON 数组字符串时自动解析为真数组", () => {
    const args = {
      path: "a.docx",
      paragraphs: '[{"text":"标题","heading":true},{"text":"正文"}]',
    };
    expect(validateToolParams("docx_create", args, def.definition)).toBeNull();
    expect(Array.isArray(args.paragraphs)).toBe(true);
    expect((args.paragraphs as unknown[]).length).toBe(2);
  });

  it("object 参数收到合法 JSON 对象字符串时自动解析", () => {
    const args = { path: "a.docx", meta: '{"a":1}' };
    expect(validateToolParams("docx_create", args, def.definition)).toBeNull();
    expect((args.meta as Record<string, unknown>).a).toBe(1);
  });

  it("非法 JSON 字符串仍报类型错误（不得静默吞掉真错）", () => {
    const err = validateToolParams(
      "docx_create",
      { path: "a.docx", paragraphs: "not json" },
      def.definition
    );
    expect(err).toMatch(/wrong type: expected array, got string/);
  });

  it("JSON 字符串但形态不符（object 期望却给到 array）仍报类型错误", () => {
    const err = validateToolParams(
      "docx_create",
      { path: "a.docx", meta: "[1,2]" },
      def.definition
    );
    expect(err).toMatch(/wrong type: expected object, got string/);
  });

  it("本来就是真数组/真对象时行为不变", () => {
    expect(
      validateToolParams("docx_create", { path: "a.docx", paragraphs: ["x"] }, def.definition)
    ).toBeNull();
    expect(
      validateToolParams("docx_create", { path: "a.docx", meta: { a: 1 } }, def.definition)
    ).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// P0-2/P0-3 缓存前缀稳定性（2026-10-16）
// 不变量：同一会话稳态下 tools JSON 逐轮字节恒定；
// Anthropic 断点拆到 system 稳定段末尾，易变尾不进缓存块。
// ═══════════════════════════════════════════════════════════
import { applyAnthropicCacheControl } from "./prompt-cache";

describe("P0-2 buildOpenAITools — 会话级单调并集（tools JSON 字节稳定）", () => {
  const mk = (names: string[]) =>
    new Map(names.map((n) => [n, { definition: { name: n, description: "d", parameters: {} }, handler: async () => ({}) }]));
  const REG = mk([
    "web_search", "web_fetch", "file_read", "file_create",
    "email_send", "email_add_account", "scheduler_create",
    "kanban_add_task", "skill_execute", "skill_install", "shell_exec",
  ]);
  const evalFn = (fn: () => boolean) => fn();

  it("turn2/turn3 的 tools JSON 与 turn1 完全相同（话题切换不再漂移）", () => {
    const out1: { activeTools?: Set<string> } = {};
    const tools1 = JSON.stringify(buildOpenAITools(REG, "帮我发邮件给张三", evalFn, undefined, out1));
    const base = out1.activeTools!;

    const out2: { activeTools?: Set<string> } = {};
    const tools2 = JSON.stringify(buildOpenAITools(REG, "今天天气怎么样", evalFn, base, out2));
    const out3: { activeTools?: Set<string> } = {};
    const tools3 = JSON.stringify(buildOpenAITools(REG, "再查一下日程", evalFn, out2.activeTools, out3));

    expect(tools2).toBe(tools1); // 话题换了，但并集种子保留 email 组
    expect(tools3).toBe(tools1);
  });

  it("并集只增不减：新话题激活的组在后续轮保留（单调性）", () => {
    const out1: { activeTools?: Set<string> } = {};
    buildOpenAITools(REG, "帮我发邮件给张三", evalFn, undefined, out1);
    const out2: { activeTools?: Set<string> } = {};
    const tools2 = JSON.stringify(buildOpenAITools(REG, "帮我建个日程", evalFn, out1.activeTools, out2));
    const out3: { activeTools?: Set<string> } = {};
    const tools3 = JSON.stringify(buildOpenAITools(REG, "完全无关的消息", evalFn, out2.activeTools, out3));
    expect(tools3).toBe(tools2); // 稳态后字节恒定
    const names3 = JSON.parse(tools3).map((t: { function: { name: string } }) => t.function.name);
    expect(names3).toContain("email_send");       // email 组不丢
    expect(names3).toContain("scheduler_create"); // scheduler 组保留
  });

  it("fresh session（base 为空）行为与旧语义一致", () => {
    const out: { activeTools?: Set<string> } = {};
    const names = JSON.parse(
      JSON.stringify(buildOpenAITools(REG, "今天天气怎么样", evalFn, undefined, out))
    ).map((t: { function: { name: string } }) => t.function.name);
    // 无关消息：非创建类 email_send 被裁剪（旧行为）
    expect(names).not.toContain("email_send");
    // 创建类工具白名单兜底保留
    expect(names).toContain("email_add_account");
  });

  it("message === undefined（/health 计数路径）仍全量下发", () => {
    const names = JSON.parse(JSON.stringify(buildOpenAITools(REG, undefined, evalFn)))
      .map((t: { function: { name: string } }) => t.function.name);
    expect(names).toContain("email_send");
    expect(names).toContain("scheduler_create");
  });
});

describe("P1-4 applyAnthropicCacheControl — 稳定段拆分断点", () => {
  const msgs = () => [
    { role: "system", content: "STABLE_BODY" + "VVVVVVVV" },
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "q2" },
  ];

  it("缺省（无 stableLength）：旧行为——整条 system 1 断点 + 尾部 3 断点", () => {
    const r = applyAnthropicCacheControl(msgs());
    expect(r).toHaveLength(4);
    expect(r[0].cache_control).toEqual({ type: "ephemeral" });
    const marked = r.filter((m) => m.cache_control).length;
    expect(marked).toBeLessThanOrEqual(4);
  });

  it("stableLength=9：system 拆成稳定段(前9字符)+尾(其余)，断点只在稳定段", () => {
    const r = applyAnthropicCacheControl(msgs(), 9);
    expect(r).toHaveLength(5);
    // "STABLE_BODYVVVVVVV".slice(0,9) === "STABLE_BO"；易变尾 = "DYVVVVVVVV"
    expect(r[0]).toMatchObject({ role: "system", content: "STABLE_BO", cache_control: { type: "ephemeral" } });
    expect(r[1]).toMatchObject({ role: "system", content: "DYVVVVVVVV" });
    expect(r[1].cache_control).toBeUndefined(); // 易变尾不带断点
    const marked = r.filter((m) => m.cache_control).length;
    expect(marked).toBeLessThanOrEqual(4);
  });

  it("stableLength 越界（>= 全文长度）不拆分，保持旧行为", () => {
    const r = applyAnthropicCacheControl(msgs(), 999);
    expect(r).toHaveLength(4);
    expect(r[0].content).toBe("STABLE_BODYVVVVVVVV");
    expect(r[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("拆分后输入数组不被原地修改（纯函数）", () => {
    const m = msgs();
    applyAnthropicCacheControl(m, 9);
    expect(m).toHaveLength(4);
    expect(m[0].content).toBe("STABLE_BODYVVVVVVVV");
  });
});
