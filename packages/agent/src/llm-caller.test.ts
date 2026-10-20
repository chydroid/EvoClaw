import { describe, it, expect, beforeEach, vi } from "vitest";
import * as http from "http";
import { isProviderSafetyRejection, nativeFetch, ProviderHealthTracker, buildOpenAITools, validateToolParams, lookupCachedToolResult, NO_RESULT_CACHE_TOOLS, parseStreamingResponse, tryCallLLM } from "./llm-caller";
import { resetProviderSkipList } from "./provider-skip-list";
import { FAILED_TURN_NOTICE } from "./turn-failure-copy";
import type { LLMCallerDeps } from "./llm-caller";

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

// ═══════════════════════════════════════════════════════════
// 流式 usage 捕获回归（P1-1，会话审计 2026-10-17）：
// OpenAI 原生流式末块携带 usage 时 `choices` 为空（`{"choices":[],
// "usage":{...}}`），旧 guard `if (!choice?.delta) continue` 在该块上
// 直接跳过 → usage/prompt/finish_reason 永远读不到，provider 侧缓存
// 命中真值链路（3d3588b）在原生 OpenAI 流式路径上失效。修复后在
// guard 之前读取 usage。
// ═══════════════════════════════════════════════════════════
describe("llm-caller > parseStreamingResponse 流式 usage 捕获（P1-1）", () => {
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

  // 构造一条「末块 choices 为空、只带 usage」的流，断言末块 usage 被捕获
  function makeStreamWithTrailingUsage() {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [
      encoder.encode(sse({ choices: [{ delta: { content: "Hi" } }] })),
      encoder.encode(sse({ choices: [{ delta: { content: " there" }, finish_reason: "stop" }] })),
      // OpenAI 原生流式约定：include_usage 末块 choices 为空
      encoder.encode(sse({ choices: [], usage: { total_tokens: 42, prompt_tokens: 30, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 50 } } })),
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); },
    });
    return stream as unknown as NodeJS.ReadableStream & ReadableStream<Uint8Array>;
  }

  function fakeDeps() {
    return {
      registry: undefined,
      recordProviderFailure: vi.fn(),
      recordProviderSuccess: vi.fn(),
    } as unknown as LLMCallerDeps;
  }

  it("末块 choices 为空时 usage/prompt/finish 仍被捕获", async () => {
    const provider = {
      name: "openai", model: "gpt-4o", baseURL: "https://api.openai.com/v1",
      provider: "openai", id: "p1",
    } as unknown as Parameters<typeof parseStreamingResponse>[1];
    const body = makeStreamWithTrailingUsage();
    const response = {
      ok: true, status: 200, statusText: "OK",
      body,
      text: async () => "", json: async () => ({}),
    } as unknown as Parameters<typeof parseStreamingResponse>[0];
    const onProgress = vi.fn();
    const result = await parseStreamingResponse(response, provider, Date.now(), onProgress, fakeDeps());
    expect(result).not.toBeNull();
    expect(result!.promptTokens).toBe(30);
    expect(result!.tokensUsed).toBe(42); // 取流末块 usage.total_tokens，而非 ceil(len/4) 估算
    expect(result!.usageDetails).toMatchObject({ prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 50 } });
  });
});

// ═══════════════════════════════════════════════════════════
// P2-1 回归（会话审计 2026-10-17）：CE 分支下当前 user 消息只应出现
// **一次**——ContextEngine 已在 assembleContext 末尾追加 currentTask，
// llm-caller 旧逻辑再 push 一条，导致请求里出现两条连续 user 消息。
// 修复：CE 分支不再二次 push（纯文本把 CE 追加的 currentTask 替换为
// 传入 message 的增强版；多模态把末条 user 换成 parts 版）。
// 测试用本地 http server 捕获真实请求体直接断言。
// ═══════════════════════════════════════════════════════════
describe("llm-caller > CE 分支 user 消息去重（P2-1）", () => {
  function ceResult(currentTask: string) {
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: "SYS" },
      { role: "user", content: "old-user" },
      { role: "assistant", content: "old-ai" },
      { role: "user", content: currentTask },
    ];
    return { messages, tokenEstimate: 10, truncated: false, warnings: [], frozenContent: "SYS" } as unknown as LLMCallerDeps["contextEngineResult"];
  }

  function minimalDeps(overrides: Partial<LLMCallerDeps>): LLMCallerDeps {
    return {
      registry: { resolveService: () => null } as unknown as LLMCallerDeps["registry"],
      conversationHistory: new Map(),
      pendingOperations: new Map(),
      toolResultCache: new Map(),
      registeredTools: new Map(),
      buildSkillsPromptForRun: async () => "",
      recordProviderSuccess: () => {},
      recordProviderFailure: () => {},
      getEventLedger: () => null,
      providers: [],
      config: { maxTokens: 4096 } as LLMCallerDeps["config"],
      persona: { name: "t", style: "s", formatConstraints: "" } as LLMCallerDeps["persona"],
      sessionManager: null,
      pluginManager: null,
      maxHistoryLength: 200,
      sessionDataDir: "/tmp",
      sessionPersistenceEnabled: false,
      autoCompactionEnabled: false,
      compactionTokenThreshold: 0,
      compactionManager: null,
      lifecycleManager: null,
      memoryHub: null,
      ...overrides,
    };
  }

  it("CE 纯文本分支：请求体里当前 user 消息只有一条（且为传入 message 增强版）", async () => {
    // 本地 server 捕获请求体，回一个最小 OpenAI 非流式补全
    const captured: Array<{ role: string; content: unknown }> = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw);
        captured.push(...(body.messages as Array<{ role: string; content: unknown }>));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
          usage: { total_tokens: 5, prompt_tokens: 3 },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const dep = minimalDeps({
      contextEngineResult: ceResult("CURRENT_TASK_RAW"),
      providers: [
        { name: "p1", provider: "openai", model: "m", baseURL: `http://127.0.0.1:${port}/v1`, enabled: true, order: 0, timeout: 5000 } as unknown as LLMCallerDeps["providers"][number],
      ],
    });
    const res = await tryCallLLM(dep, {
      message: "ENHANCED_FINAL_MESSAGE",
      systemPrompt: "SYS",
      installedSkills: [],
      providers: dep.providers!,
      startTime: Date.now(),
      sessionId: "p2-1-test",
      pendingPermissions: [],
    });
    server.close();

    expect(res).not.toBeNull();
    const userMsgs = captured.filter((m) => m.role === "user");
    // 「old-user」（history）+ 当前 user 一条；**不是**两条当前 user
    expect(userMsgs).toHaveLength(2);
    expect(userMsgs[0].content).toBe("old-user");
    // CE 追加的 currentTask 被替换为 llm-caller 传入的 message（增强版）
    expect(userMsgs[1].content).toBe("ENHANCED_FINAL_MESSAGE");
    expect(JSON.stringify(captured)).not.toContain("CURRENT_TASK_RAW");
  });
});

// ═══════════════════════════════════════════════════════════
// 过载自动恢复阶梯（2026-10-18，借鉴 hermes turn_recovery.py auto-recovery）：
// provider 瞬时过载（429/5xx/超时）时不立即 failover，而是原地
// jittered backoff 等待后重试（Retry-After 契约优先），阶梯耗尽才
// 退回旧行为（短退避 + failover 到下一个 provider）。
// 本回归验证「阶梯实际生效」：provider1 持续 429 时，请求体应被
// 重复发起（远多于 3 次），最终 failover 到 provider2 成功。
// ═══════════════════════════════════════════════════════════
describe("llm-caller > 过载自动恢复阶梯（原地重试）", () => {
  function providerConfig(port: number, name: string) {
    return {
      name, provider: "openai", model: "m",
      baseURL: `http://127.0.0.1:${port}/v1`,
      enabled: true, order: 0, timeout: 5000,
    } as unknown as LLMCallerDeps["providers"][number];
  }

  it("429 限流时原地重试 5 个周期，耗尽后 failover 到下一个 provider", async () => {
    let p1Calls = 0;
    let p2Calls = 0;
    const p1 = http.createServer((_req, res) => {
      p1Calls++;
      // 持续 429；Retry-After: 1 让阶梯等待仅 1s（测试提速）
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: "rate limited, retry after 1 second" } }));
    });
    await new Promise<void>((r) => p1.listen(0, r));
    const port1 = (p1.address() as { port: number }).port;

    const p2 = http.createServer((_req, res) => {
      p2Calls++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok-from-p2" }, finish_reason: "stop" }],
        usage: { total_tokens: 1, prompt_tokens: 1 },
      }));
    });
    await new Promise<void>((r) => p2.listen(0, r));
    const port2 = (p2.address() as { port: number }).port;

    // 复用 P2-1 夹具里的 minimalDeps 思路（同文件定义不可达 → 本地重建最小 deps）
    const dep = {
      registry: { resolveService: () => null } as unknown as LLMCallerDeps["registry"],
      conversationHistory: new Map(),
      pendingOperations: new Map(),
      toolResultCache: new Map(),
      registeredTools: new Map(),
      buildSkillsPromptForRun: async () => "",
      recordProviderSuccess: () => {},
      recordProviderFailure: () => {},
      getEventLedger: () => null,
      config: { maxTokens: 4096 } as LLMCallerDeps["config"],
      persona: { name: "t", style: "s", formatConstraints: "" } as LLMCallerDeps["persona"],
      sessionManager: null,
      pluginManager: null,
      maxHistoryLength: 200,
      sessionDataDir: "/tmp",
      sessionPersistenceEnabled: false,
      autoCompactionEnabled: false,
      compactionTokenThreshold: 0,
      compactionManager: null,
      lifecycleManager: null,
      memoryHub: null,
      providers: [providerConfig(port1, "p1"), providerConfig(port2, "p2")],
    } as unknown as LLMCallerDeps;

    const res = await tryCallLLM(dep, {
      message: "hi",
      systemPrompt: "SYS",
      installedSkills: [],
      providers: [providerConfig(port1, "p1"), providerConfig(port2, "p2")],
      startTime: Date.now(),
      sessionId: "overload-ladder-test",
      pendingPermissions: [],
    });
    p1.close();
    p2.close();

    expect(res).not.toBeNull();
    expect(res!.reply).toContain("ok-from-p2");
    // 关键断言：p1 被原地重试（5 个阶梯周期 + 3 次阶梯耗尽后的短退避重试）
    // 远多于旧行为的「3 连败即 failover」。若阶梯被移除，p1Calls 会 == 3。
    expect(p1Calls).toBeGreaterThanOrEqual(5);
    expect(p2Calls).toBe(1);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════
// 空响应确定性短路（2026-10-18，借鉴 hermes empty_response_guard）：
// 同一 provider 连续 2 次零输出（无 message / 空 content）即判「对本上下文
// 确定性无输出」，跳过第 3 次盲重试直接 failover。回归断言 p1 恰好 2 次
// 调用——旧行为（MAX_CONSECUTIVE_ERRORS=3）会发起 3 次才 break。
// ═══════════════════════════════════════════════════════════
describe("llm-caller > 空响应确定性短路（deterministic empty failover）", () => {
  // ★ 跨测试隔离（两组进程级共享状态）：
  // 1. ProviderHealthTracker（熔断器）：「2 连败即熔断 120s」会把后续测试的
  //    同名 provider 直接跳过 → provider 名必须唯一。
  // 2. ProviderSkipList（持久化到 data/provider-skip-list.json）：401 会把
  //    provider.id 写进 skip list（TTL 5 分钟，磁盘跨进程存活）→ 每个测试
  //    前 resetProviderSkipList()，且 runTag 让本轮 provider id 全唯一。
  const runTag = Date.now();
  beforeEach(() => resetProviderSkipList());
  function emptyDeps(port1: number, port2: number, name1: string, name2: string) {
    const provider1 = { id: name1, name: name1, provider: "openai", model: "m", baseURL: `http://127.0.0.1:${port1}/v1`, enabled: true, order: 0, timeout: 5000 } as unknown as LLMCallerDeps["providers"][number];
    const provider2 = { id: name2, name: name2, provider: "openai", model: "m", baseURL: `http://127.0.0.1:${port2}/v1`, enabled: true, order: 0, timeout: 5000 } as unknown as LLMCallerDeps["providers"][number];
    return {
      dep: {
        registry: { resolveService: () => null } as unknown as LLMCallerDeps["registry"],
        conversationHistory: new Map(),
        pendingOperations: new Map(),
        toolResultCache: new Map(),
        // 测试工具：echo_ping 返回非空 results → 工具执行路径正常产出，
        // 让「空成功 + 工具调用交替」的混合证据路径可被验证。
        registeredTools: new Map([
          [
            "echo_ping",
            {
              definition: { name: "echo_ping", description: "test echo tool", parameters: {} },
              handler: async () => JSON.stringify({ results: [{ content: "pong" }], success: true }),
            },
          ],
          // fail_tool 抛错 → 进入 failedTools，用于验证「失败写入脚注」
          [
            "fail_tool",
            {
              definition: { name: "fail_tool", description: "test failing tool", parameters: {} },
              handler: async () => {
                throw new Error("boom");
              },
            },
          ],
        ]),
        buildSkillsPromptForRun: async () => "",
        recordProviderSuccess: () => {},
        recordProviderFailure: () => {},
        getEventLedger: () => null,
        config: { maxTokens: 4096 } as LLMCallerDeps["config"],
        persona: { name: "t", style: "s", formatConstraints: "" } as LLMCallerDeps["persona"],
        sessionManager: null,
        pluginManager: null,
        maxHistoryLength: 200,
        sessionDataDir: "/tmp",
        sessionPersistenceEnabled: false,
        autoCompactionEnabled: false,
        compactionTokenThreshold: 0,
        compactionManager: null,
        lifecycleManager: null,
        memoryHub: null,
        providers: [provider1, provider2],
      } as unknown as LLMCallerDeps,
      provider1,
      provider2,
    };
  }

  it("连续 2 次空 message 即 failover（p1 恰好 2 次，第 3 次盲重试被省掉）", async () => {
    let p1Calls = 0;
    let p2Calls = 0;
    // p1：永远返回「无 message」的空响应（choices[0] 存在但 message 缺失）
    const p1 = http.createServer((_req, res) => {
      p1Calls++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        choices: [{ finish_reason: "stop" }],
        usage: { total_tokens: 1 },
      }));
    });
    await new Promise<void>((r) => p1.listen(0, r));
    const port1 = (p1.address() as { port: number }).port;

    const p2 = http.createServer((_req, res) => {
      p2Calls++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok-from-p2" }, finish_reason: "stop" }],
        usage: { total_tokens: 1, prompt_tokens: 1 },
      }));
    });
    await new Promise<void>((r) => p2.listen(0, r));
    const port2 = (p2.address() as { port: number }).port;

    const { dep, provider1, provider2 } = emptyDeps(port1, port2, "p1-null", "p2-null");
    const res = await tryCallLLM(dep, {
      message: "hi",
      systemPrompt: "SYS",
      installedSkills: [],
      providers: [provider1, provider2],
      startTime: Date.now(),
      sessionId: "deterministic-empty-null-test",
      pendingPermissions: [],
    });
    p1.close();
    p2.close();

    expect(res).not.toBeNull();
    expect(res!.reply).toContain("ok-from-p2");
    // 关键断言：p1 恰好 2 次（第 2 次即短路 failover）。
    // 若确定性短路被移除，p1Calls 会 == 3（MAX_CONSECUTIVE_ERRORS 才 break）。
    expect(p1Calls).toBe(2);
    expect(p2Calls).toBe(1);
  });

  it("工具后连续 2 次空成功即 failover（省掉第 3 个盲 nudge 轮）", async () => {
    let p1Calls = 0;
    let p2Calls = 0;
    // p1：第 1 次返回 echo_ping 工具调用（执行成功），之后永远空 content 成功补全。
    // 期望：第 2/3 轮空成功累计到 2 → 确定性短路 break（旧行为第 4 轮 nudge
    // 耗尽才 break，p1Calls 会 == 4）。
    const p1 = http.createServer((_req, res) => {
      p1Calls++;
      res.setHeader("Content-Type", "application/json");
      if (p1Calls === 1) {
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "tc1", type: "function", function: { name: "echo_ping", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { total_tokens: 2, prompt_tokens: 1 },
        }));
      } else {
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
          usage: { total_tokens: 1, prompt_tokens: 1 },
        }));
      }
    });
    await new Promise<void>((r) => p1.listen(0, r));
    const port1 = (p1.address() as { port: number }).port;

    const p2 = http.createServer((_req, res) => {
      p2Calls++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok-from-p2" }, finish_reason: "stop" }],
        usage: { total_tokens: 1, prompt_tokens: 1 },
      }));
    });
    await new Promise<void>((r) => p2.listen(0, r));
    const port2 = (p2.address() as { port: number }).port;

    const { dep, provider1, provider2 } = emptyDeps(port1, port2, "p1-succ", "p2-succ");
    const res = await tryCallLLM(dep, {
      message: "hi",
      systemPrompt: "SYS",
      installedSkills: [],
      providers: [provider1, provider2],
      startTime: Date.now(),
      sessionId: "deterministic-empty-success-test",
      pendingPermissions: [],
    });
    p1.close();
    p2.close();

    expect(res).not.toBeNull();
    expect(res!.reply).toContain("ok-from-p2");
    // 关键断言：p1 恰好 3 次（1 工具轮 + 2 空成功即短路）。
    // 若确定性短路被移除，第 4 轮 nudge 耗尽才 break，p1Calls 会 == 4。
    expect(p1Calls).toBe(3);
    expect(p2Calls).toBe(1);
  });

  it("混合证据 fail-open：空响应与出错交替时确定性计数清零，不提前短路", async () => {
    let p1Calls = 0;
    let p2Calls = 0;
    // p1 交替返回：空 message（null）→ 429 出错（混合证据，计数清零）→ 空 message…
    // 计数永远到不了 2，走旧行为：3 次连续错误才 break（429 先入过载阶梯——
    // 为避免阶梯拖长测试，这里 p1Calls 上限只断言「没有提前短路 failover」：
    // p2 在第 3 个 provider 循环 break 后才接到请求。
    const p1 = http.createServer((_req, res) => {
      p1Calls++;
      if (p1Calls % 2 === 1) {
        // 奇数次：空 message → null
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop" }], usage: { total_tokens: 1 } }));
      } else {
        // 偶数次：非瞬时错误 401（AUTH non-transient 不入阶梯、不 backoff）
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: { message: "invalid api key" } }));
      }
    });
    await new Promise<void>((r) => p1.listen(0, r));
    const port1 = (p1.address() as { port: number }).port;

    const p2 = http.createServer((_req, res) => {
      p2Calls++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok-from-p2" }, finish_reason: "stop" }],
        usage: { total_tokens: 1, prompt_tokens: 1 },
      }));
    });
    await new Promise<void>((r) => p2.listen(0, r));
    const port2 = (p2.address() as { port: number }).port;

    const { dep, provider1, provider2 } = emptyDeps(port1, port2, `p1-mix-${runTag}`, `p2-mix-${runTag}`);
    const res = await tryCallLLM(dep, {
      message: "hi",
      systemPrompt: "SYS",
      installedSkills: [],
      providers: [provider1, provider2],
      startTime: Date.now(),
      sessionId: "deterministic-empty-mixed-test",
      pendingPermissions: [],
    });
    p1.close();
    p2.close();

    expect(res).not.toBeNull();
    // 401 AUTH → shouldSkipProvider 直接 break（跳过 p1 剩余重试）→ p2 兜底
    expect(res!.reply).toContain("ok-from-p2");
    expect(p2Calls).toBe(1);
    // 混合证据未触发确定性短路：空响应计数被 401 清零，failover 由
    // shouldSkipProvider 驱动（p1 至少尝试 2 次：1 次空 + 1 次 401）
    expect(p1Calls).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════
// 收尾三件套（2026-10-18，借鉴 hermes turn_finalizer）：
//   - 静默停止显式说明：工具跑过但没产出正文时，如实说明而非误导性
//     「所有模型都未能响应」
//   - 失败写入脚注：失败的工具名列进兜底回复
//   - 回复优先 guarded cleanup：persistSessionTurnFn / checkpointStore
//     completeExecution 独立 try/catch，清理失败不得丢掉已组装好的 reply
// ═══════════════════════════════════════════════════════════
describe("llm-caller > 收尾三件套（静默停止显式说明 / 失败写入脚注）", () => {
  // ★ ProviderHealthTracker 熔断器按 provider.name 键控（进程级共享）：
  // 两个兜底测试的 provider 名必须互不重复，否则 2 连败熔断会让第二个
  // 测试的同名 provider 直接被跳过。用独立序号保证唯一。
  let finalizerSeq = 0;
  function finalizerDeps(port1: number, port2: number) {
    finalizerSeq++;
    const tag = `final-${finalizerSeq}`;
    const provider1 = { id: `p1-${tag}`, name: `p1-${tag}`, provider: "openai", model: "m", baseURL: `http://127.0.0.1:${port1}/v1`, enabled: true, order: 0, timeout: 5000 } as unknown as LLMCallerDeps["providers"][number];
    const provider2 = { id: `p2-${tag}`, name: `p2-${tag}`, provider: "openai", model: "m", baseURL: `http://127.0.0.1:${port2}/v1`, enabled: true, order: 0, timeout: 5000 } as unknown as LLMCallerDeps["providers"][number];
    return {
      dep: {
        registry: { resolveService: () => null } as unknown as LLMCallerDeps["registry"],
        conversationHistory: new Map(),
        pendingOperations: new Map(),
        toolResultCache: new Map(),
        registeredTools: new Map([
          [
            "echo_ping",
            {
              definition: { name: "echo_ping", description: "test echo tool", parameters: {} },
              handler: async () => JSON.stringify({ results: [{ content: "pong" }], success: true }),
            },
          ],
          [
            "fail_tool",
            {
              definition: { name: "fail_tool", description: "test failing tool", parameters: {} },
              handler: async () => { throw new Error("boom"); },
            },
          ],
        ]),
        buildSkillsPromptForRun: async () => "",
        recordProviderSuccess: () => {},
        recordProviderFailure: () => {},
        getEventLedger: () => null,
        config: { maxTokens: 4096 } as LLMCallerDeps["config"],
        persona: { name: "t", style: "s", formatConstraints: "" } as LLMCallerDeps["persona"],
        sessionManager: null,
        pluginManager: null,
        maxHistoryLength: 200,
        sessionDataDir: "/tmp",
        sessionPersistenceEnabled: false,
        autoCompactionEnabled: false,
        compactionTokenThreshold: 0,
        compactionManager: null,
        lifecycleManager: null,
        memoryHub: null,
        providers: [provider1, provider2],
      } as unknown as LLMCallerDeps,
      provider1,
      provider2,
    };
  }

  // p1：第 1 次返回工具调用，之后永远返回空 message（连续 2 次即确定性短路 failover）
  function makeEmptyAfterToolServer(p1CallsRef: { v: number }, toolName: string) {
    return http.createServer((_req, res) => {
      p1CallsRef.v++;
      res.setHeader("Content-Type", "application/json");
      if (p1CallsRef.v === 1) {
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "tc1", type: "function", function: { name: toolName, arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { total_tokens: 2, prompt_tokens: 1 },
        }));
      } else {
        // 空 message → null（连续 2 次即确定性短路）
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop" }], usage: { total_tokens: 1 } }));
      }
    });
  }

  it("工具跑过但没产出正文：兜底如实说明「已执行 N 次工具 + 失败工具脚注」", async () => {
    const p1Calls = { v: 0 };
    const p1 = makeEmptyAfterToolServer(p1Calls, "echo_ping");
    await new Promise<void>((r) => p1.listen(0, r));
    const port1 = (p1.address() as { port: number }).port;

    // p2：永远空 message（连续 2 次即确定性短路）
    const p2Calls = { v: 0 };
    const p2 = http.createServer((_req, res) => {
      p2Calls.v++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop" }], usage: { total_tokens: 1 } }));
    });
    await new Promise<void>((r) => p2.listen(0, r));
    const port2 = (p2.address() as { port: number }).port;

    const { dep, provider1, provider2 } = finalizerDeps(port1, port2);
    const res = await tryCallLLM(dep, {
      message: "hi",
      systemPrompt: "SYS",
      installedSkills: [],
      providers: [provider1, provider2],
      startTime: Date.now(),
      sessionId: "finalizer-silent-stop-test",
      pendingPermissions: [],
    });
    p1.close();
    p2.close();

    expect(res).not.toBeNull();
    // ★ 关键断言：工具明明执行过（echo_ping 成功），不得返回误导性的
    // 「所有模型都未能响应」，必须如实说明已执行 1 次工具且无失败。
    expect(res!.reply).toContain("本轮已执行 1 次工具");
    expect(res!.reply).toContain("未能生成最终文字回复");
    expect(res!.reply).toContain("执行已停止");
    expect(res!.reply).toContain("失败的工具：（无）");
    // 不得出现旧的误导性兜底文案
    expect(res!.reply).not.toContain("所有已启用的模型提供商均未能响应");
  });

  it("失败工具名列进兜底回复（失败写入脚注）", async () => {
    const p1Calls = { v: 0 };
    const p1 = makeEmptyAfterToolServer(p1Calls, "fail_tool");
    await new Promise<void>((r) => p1.listen(0, r));
    const port1 = (p1.address() as { port: number }).port;

    const p2Calls = { v: 0 };
    const p2 = http.createServer((_req, res) => {
      p2Calls.v++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop" }], usage: { total_tokens: 1 } }));
    });
    await new Promise<void>((r) => p2.listen(0, r));
    const port2 = (p2.address() as { port: number }).port;

    const { dep, provider1, provider2 } = finalizerDeps(port1, port2);
    const res = await tryCallLLM(dep, {
      message: "hi",
      systemPrompt: "SYS",
      installedSkills: [],
      providers: [provider1, provider2],
      startTime: Date.now(),
      sessionId: "finalizer-failed-write-test",
      pendingPermissions: [],
    });
    p1.close();
    p2.close();

    expect(res).not.toBeNull();
    // fail_tool 抛错 → 进入 failedTools → 兜底回复必须带失败工具名
    expect(res!.reply).toContain("fail_tool");
    expect(res!.reply).toContain("失败的工具：");
    expect(res!.reply).toContain("本轮已执行 0 次工具");
  });

  // ═══════════════════════════════════════════════════════════
  // 终态失败盖码 + 人话文案（hermes turn_failure_copy，第四轮 Top5 #5）：
  // 全 provider 失败且最后错误带 ClassifiedError 时，兜底回复按终态
  // reason 给具体描述 + 下一步指引，结果盖 failure_reason / failure_retryable
  // ═══════════════════════════════════════════════════════════
  it("全 provider 失败 + 最后 401 auth → 盖码 + 非可重试 API Key 指引", async () => {
    let p1Calls = 0;
    let p2Calls = 0;
    const failSeq = `ffail-${finalizerSeq + 100}`; // 熔断器隔离：与前面所有 provider 名不重复
    const p1 = http.createServer((_req, res) => {
      p1Calls++;
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: "invalid api key" } }));
    });
    await new Promise<void>((r) => p1.listen(0, r));
    const port1 = (p1.address() as { port: number }).port;

    const p2 = http.createServer((_req, res) => {
      p2Calls++;
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: "invalid api key" } }));
    });
    await new Promise<void>((r) => p2.listen(0, r));
    const port2 = (p2.address() as { port: number }).port;

    const provider1 = { id: `p1-${failSeq}`, name: `p1-${failSeq}`, provider: "openai", model: "m", baseURL: `http://127.0.0.1:${port1}/v1`, enabled: true, order: 0, timeout: 5000 } as unknown as LLMCallerDeps["providers"][number];
    const provider2 = { id: `p2-${failSeq}`, name: `p2-${failSeq}`, provider: "openai", model: "m", baseURL: `http://127.0.0.1:${port2}/v1`, enabled: true, order: 0, timeout: 5000 } as unknown as LLMCallerDeps["providers"][number];
    const dep = {
      registry: { resolveService: () => null } as unknown as LLMCallerDeps["registry"],
      conversationHistory: new Map(),
      pendingOperations: new Map(),
      toolResultCache: new Map(),
      registeredTools: new Map<string, unknown>(),
      buildSkillsPromptForRun: async () => "",
      recordProviderSuccess: () => {},
      recordProviderFailure: () => {},
      getEventLedger: () => null,
      config: { maxTokens: 4096 } as LLMCallerDeps["config"],
      persona: { name: "t", style: "s", formatConstraints: "" } as LLMCallerDeps["persona"],
      sessionManager: null,
      pluginManager: null,
      maxHistoryLength: 200,
      sessionDataDir: "/tmp",
      sessionPersistenceEnabled: false,
      autoCompactionEnabled: false,
      compactionTokenThreshold: 0,
      compactionManager: null,
      lifecycleManager: null,
      memoryHub: null,
      providers: [provider1, provider2],
    } as unknown as LLMCallerDeps;

    const res = await tryCallLLM(dep, {
      message: "hi",
      systemPrompt: "SYS",
      installedSkills: [],
      providers: [provider1, provider2],
      startTime: Date.now(),
      sessionId: "turn-failure-stamp-test",
      pendingPermissions: [],
    });
    p1.close();
    p2.close();

    expect(res).not.toBeNull();
    // ★ 盖码不变式：终态失败结果必带 failure_reason + failure_retryable
    expect(res!.failureReason).toBe("auth");
    expect(res!.failureRetryable).toBe(false);
    // ★ 人话文案：非可重试 auth 指引（检查 API Key），而非通用三条
    expect(res!.reply).toContain("API Key");
    expect(res!.reply).toContain(FAILED_TURN_NOTICE); // 没跑过工具 → 完全失败边界文案
    // 不得再出现旧的通用误导文案
    expect(res!.reply).not.toContain("所有已启用的模型提供商均未能响应");
  });

  it("全 provider 失败 + 最后 429 限流 → 盖码 retryable=true + 耗尽分句", async () => {
    const failSeq = `ffail2-${finalizerSeq + 200}`;
    const p1 = http.createServer((_req, res) => {
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      // Retry-After: 1 写在消息体（error-classifier 从错误文本解析），阶梯等待仅 1s
      res.end(JSON.stringify({ error: { message: "rate limited, retry after 1 second" } }));
    });
    await new Promise<void>((r) => p1.listen(0, r));
    const port1 = (p1.address() as { port: number }).port;

    const provider1 = { id: `p1-${failSeq}`, name: `p1-${failSeq}`, provider: "openai", model: "m", baseURL: `http://127.0.0.1:${port1}/v1`, enabled: true, order: 0, timeout: 5000 } as unknown as LLMCallerDeps["providers"][number];
    const dep = {
      registry: { resolveService: () => null } as unknown as LLMCallerDeps["registry"],
      conversationHistory: new Map(),
      pendingOperations: new Map(),
      toolResultCache: new Map(),
      registeredTools: new Map<string, unknown>(),
      buildSkillsPromptForRun: async () => "",
      recordProviderSuccess: () => {},
      recordProviderFailure: () => {},
      getEventLedger: () => null,
      config: { maxTokens: 4096 } as LLMCallerDeps["config"],
      persona: { name: "t", style: "s", formatConstraints: "" } as LLMCallerDeps["persona"],
      sessionManager: null,
      pluginManager: null,
      maxHistoryLength: 200,
      sessionDataDir: "/tmp",
      sessionPersistenceEnabled: false,
      autoCompactionEnabled: false,
      compactionTokenThreshold: 0,
      compactionManager: null,
      lifecycleManager: null,
      memoryHub: null,
      providers: [provider1],
    } as unknown as LLMCallerDeps;

    const res = await tryCallLLM(dep, {
      message: "hi",
      systemPrompt: "SYS",
      installedSkills: [],
      providers: [provider1],
      startTime: Date.now(),
      sessionId: "turn-failure-rate-limit-test",
      pendingPermissions: [],
    });
    p1.close();

    expect(res).not.toBeNull();
    // 429 → rate_limit（transient）→ retryable=true
    expect(res!.failureReason).toBe("rate_limit");
    expect(res!.failureRetryable).toBe(true);
    // 耗尽文案按 reason 分句 + 通用「稍后重试」出口（无 Retry-After 头 → 不点名重置时间）
    expect(res!.reply).toContain("被限流");
    expect(res!.reply).toContain("稍后重试");
  });
});
