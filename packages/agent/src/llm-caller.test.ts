import { describe, it, expect, beforeEach, vi } from "vitest";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { isProviderSafetyRejection, nativeFetch, ProviderHealthTracker, buildOpenAITools, validateToolParams, lookupCachedToolResult, NO_RESULT_CACHE_TOOLS, parseStreamingResponse, tryCallLLM, callLLMOnce } from "./llm-caller";
import { getProviderSkipList, resetProviderSkipList } from "./provider-skip-list";
import { FAILED_TURN_NOTICE } from "./turn-failure-copy";
import type { LLMCallerDeps } from "./llm-caller";

// ProviderSkipList 单例默认持久化到仓库 data/provider-skip-list.json（进程 cwd 相对）。
// 测试中 401 失败会把条目写进该文件（TTL 5 分钟），残留条目会让后续运行/并行
// 工作进程直接跳过同名 provider（sessionId 跨运行固定）→ 兜底盖码退化成
// unclassified。两道隔离：
//   ① 指向临时文件（isolateSkipList）——不写仓库 data/，也不读历史残留；
//   ② sessionId 每轮唯一（RUN_TAG）——任何来源的残留条目都匹配不上。
function isolateSkipList(): void {
  resetProviderSkipList();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-skiplist-"));
  getProviderSkipList({ filePath: path.join(tmpDir, "provider-skip-list.json") });
}

/** 每轮运行唯一的 tag：sessionId 带上它，杜绝跨运行的 skip list 残留命中。 */
const RUN_TAG = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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

describe("P0-5 applyAnthropicCacheControl — volatile 区域前 history 尾部断点", () => {
  // P0-5 布局：[sys_frozen, ...history, skills?, tail?, user]
  // 断点 2-4 落在 volatile 区域（skills/tail/user）之前的最后 3 条非 system 消息。
  const layoutMsgs = () => [
    { role: "system", content: "SYS_FROZEN" },
    { role: "user", content: "h1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "h2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "h3" },
    { role: "system", content: "SKILLS_SECTION" },
    { role: "system", content: "DYNAMIC_TAIL" },
    { role: "user", content: "current-question" },
  ];

  it("断点 2-4 落在 history 尾部（h3/a2/h2），不落在 volatile 区域", () => {
    const r = applyAnthropicCacheControl(layoutMsgs());
    // system 断点
    expect(r[0].cache_control).toEqual({ type: "ephemeral" });
    // history 尾部（索引 4=a2, 5=h3, 3=h2）挂断点
    expect(r[5].cache_control).toEqual({ type: "ephemeral" }); // h3
    expect(r[4].cache_control).toEqual({ type: "ephemeral" }); // a2
    expect(r[3].cache_control).toEqual({ type: "ephemeral" }); // h2
    // volatile 区域（skills=6, tail=7, user=8）不带断点
    expect(r[6].cache_control).toBeUndefined();
    expect(r[7].cache_control).toBeUndefined();
    expect(r[8].cache_control).toBeUndefined();
  });

  it("末尾 user 消息永不挂断点（逐轮必变）", () => {
    const r = applyAnthropicCacheControl(layoutMsgs());
    expect(r[r.length - 1].cache_control).toBeUndefined();
  });

  it("无 skills/tail 时断点顺延给 history 尾部（排除末尾 user）", () => {
    const msgs = [
      { role: "system", content: "SYS" },
      { role: "user", content: "h1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q" },
    ];
    const r = applyAnthropicCacheControl(msgs);
    expect(r[0].cache_control).toEqual({ type: "ephemeral" });
    // 非 system 消息：h1(1), a1(2), q(3)。排除最后一条（q）→ h1, a1 挂断点
    expect(r[1].cache_control).toEqual({ type: "ephemeral" });
    expect(r[2].cache_control).toEqual({ type: "ephemeral" });
    expect(r[3].cache_control).toBeUndefined();
  });

  it("断点总数 ≤ 4（Anthropic 限制）", () => {
    const r = applyAnthropicCacheControl(layoutMsgs());
    const marked = r.filter((m) => m.cache_control).length;
    expect(marked).toBeLessThanOrEqual(4);
  });

  it("history 短于 3 条时槽位顺延给 skills/tail（会话内稳定）", () => {
    const msgs = [
      { role: "system", content: "SYS" },
      { role: "user", content: "q" },
      { role: "system", content: "SKILLS" },
      { role: "system", content: "TAIL" },
    ];
    const r = applyAnthropicCacheControl(msgs);
    expect(r[0].cache_control).toEqual({ type: "ephemeral" });
    // 非 system：q(1)。排除最后一条（q）→ 无剩余 → skills/tail 不带断点
    expect(r[1].cache_control).toBeUndefined();
    expect(r[2].cache_control).toBeUndefined();
    expect(r[3].cache_control).toBeUndefined();
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
      sessionId: `p2-1-test-${RUN_TAG}`,
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
      sessionId: `overload-ladder-test-${RUN_TAG}`,
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
  beforeEach(() => isolateSkipList());
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
      sessionId: `deterministic-empty-null-test-${RUN_TAG}`,
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
      sessionId: `deterministic-empty-success-test-${RUN_TAG}`,
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
      sessionId: `deterministic-empty-mixed-test-${RUN_TAG}`,
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
  // ★ ProviderSkipList：401 失败会把 (session, providerId) 写进持久化文件，
  // 残留条目（TTL 5 分钟）会让下一次运行的相同固定 id 直接被 skip →
  // lastFailureEvidence 为 null → 盖码 unclassified。指向临时文件隔离。
  beforeEach(() => isolateSkipList());
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
      sessionId: `finalizer-silent-stop-test-${RUN_TAG}`,
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
      sessionId: `finalizer-failed-write-test-${RUN_TAG}`,
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
      sessionId: `turn-failure-stamp-test-${RUN_TAG}`,
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
      sessionId: `turn-failure-rate-limit-test-${RUN_TAG}`,
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

// ═══════════════════════════════════════════════════════════
// Anthropic 原生 Messages API（2026-10-26）
// 此前 Anthropic provider 走 OpenAI 兼容的 /v1/chat/completions，
// 官方端点并不支持该路径（一律 404/400），provider 实际不可用。
// 现改为原生 POST /v1/messages：system 顶层字段、tool_use/tool_result
// content blocks、tools 用 input_schema、SSE 事件为 message_start /
// content_block_* / message_delta / message_stop。
// 测试用本地 http server 捕获真实请求体/响应，覆盖请求格式、
// 非流式/流式响应解析、工具往返（tool_use → tool_result → 文本）。
// ═══════════════════════════════════════════════════════════
describe("llm-caller > Anthropic 原生 Messages API", () => {
  // 最小 deps：callLLMOnce 只需要 recordProviderSuccess/Failure + registry
  function minimalDeps(overrides: Partial<LLMCallerDeps> = {}): LLMCallerDeps {
    return {
      registry: undefined,
      recordProviderSuccess: vi.fn(),
      recordProviderFailure: vi.fn(),
      ...overrides,
    } as unknown as LLMCallerDeps;
  }

  function anthropicProvider(port: number, baseURL?: string) {
    return {
      name: "claude",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "sk-ant-test",
      baseURL: baseURL ?? `http://127.0.0.1:${port}`,
      id: "anthropic-1",
      enabled: true,
      order: 0,
      timeout: 5000,
      maxTokens: 4096,
      temperature: 0.3,
    } as unknown as LLMCallerDeps["providers"][number];
  }

  // 启动本地 server，返回 capture 工具
  function captureServer(
    responder: (req: http.IncomingMessage, res: http.ServerResponse, raw: string) => void,
  ): { server: http.Server; captured: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>; port: number; close: () => void } {
    const captured: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        captured.push({ url: req.url || "", headers: req.headers, body: JSON.parse(raw || "{}") });
        responder(req, res, raw);
      });
    });
    server.listen(0);
    const port = (server.address() as { port: number }).port;
    return { server, captured, port, close: () => server.close() };
  }

  it("请求格式：端点 /v1/messages、system 顶层字段、tools/tool_choice 转换、cache_control 落在 content blocks", async () => {
    const { server, captured, port, close } = captureServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 2 },
      }));
    });
    await new Promise<void>((r) => server.on("listening", r));

    const result = await callLLMOnce(
      anthropicProvider(port),
      [
        { role: "system", content: "SYS-PROMPT" },
        { role: "user", content: "你好" },
      ],
      [{ type: "function", function: { name: "shell_exec", description: "run a command", parameters: { type: "object", properties: {} } } }],
      "auto",
      undefined,
      minimalDeps(),
    );
    close();

    expect(result).not.toBeNull();
    // 端点：/v1/messages（baseURL 无 /v1 时自动补）
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("/v1/messages");
    // 认证头：Anthropic 原生格式
    expect(captured[0].headers["x-api-key"]).toBe("sk-ant-test");
    expect(captured[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(captured[0].headers.authorization).toBeUndefined();

    const body = captured[0].body;
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.max_tokens).toBe(4096);
    expect(body.temperature).toBe(0.3);
    expect(body.stream).toBe(false);

    // system 提到顶层（content blocks 数组），且首条 system 带 cache_control 断点
    expect(Array.isArray(body.system)).toBe(true);
    const sysBlocks = body.system as Array<Record<string, unknown>>;
    expect(sysBlocks[0]).toMatchObject({ type: "text", text: "SYS-PROMPT" });
    expect(sysBlocks[0].cache_control).toEqual({ type: "ephemeral" });

    // messages 不含 system 角色
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs.every((m) => m.role !== "system")).toBe(true);
    expect(msgs[0].role).toBe("user");
    // cache_control 从 message 对象移到 content block 上（Anthropic 断点语义）。
    // ★ P0-5 策略更新：末尾 user 消息逐轮必变，永不挂断点（断点 2-4 只挂
    // volatile 区域之前的 history 尾部）。本用例无 history，仅 system 断点生效。
    expect(msgs[0].cache_control).toBeUndefined();
    const userBlocks = msgs[0].content as Array<Record<string, unknown>>;
    expect(userBlocks[0]).toMatchObject({ type: "text", text: "你好" });
    expect(userBlocks[0].cache_control).toBeUndefined();

    // tools：input_schema 而非 function.parameters
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ name: "shell_exec", description: "run a command" });
    expect(tools[0].input_schema).toBeDefined();
    expect(tools[0].function).toBeUndefined();
    // tool_choice：{type:"auto"} 对象
    expect(body.tool_choice).toEqual({ type: "auto" });

    // 响应解析：content text → content；usage input+output → total/prompt
    expect(result!.message.content).toBe("ok");
    expect(result!.tokensUsed).toBe(12);
    expect(result!.promptTokens).toBe(10);
  });

  it("请求格式：baseURL 已含 /v1 或 OpenAI 兼容路径时端点归一化为 /v1/messages", async () => {
    const { server, captured, port, close } = captureServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ content: [{ type: "text", text: "x" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    await new Promise<void>((r) => server.on("listening", r));

    // baseURL 带 /v1 后缀
    await callLLMOnce(
      anthropicProvider(port, `http://127.0.0.1:${port}/v1`),
      [{ role: "user", content: "q" }],
      [],
      "auto",
      undefined,
      minimalDeps(),
    );
    // baseURL 是 OpenAI 兼容路径（/v1/chat/completions）
    await callLLMOnce(
      anthropicProvider(port, `http://127.0.0.1:${port}/v1/chat/completions`),
      [{ role: "user", content: "q" }],
      [],
      "auto",
      undefined,
      minimalDeps(),
    );
    close();

    expect(captured[0].url).toBe("/v1/messages");
    expect(captured[1].url).toBe("/v1/messages");
  });

  it("非流式响应：tool_use content block → 通用 tool_calls", async () => {
    const { server, port, close } = captureServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        content: [
          { type: "text", text: "让我执行：" },
          { type: "tool_use", id: "toolu_123", name: "shell_exec", input: { command: "ls" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 30, output_tokens: 12, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 },
      }));
    });
    await new Promise<void>((r) => server.on("listening", r));

    const result = await callLLMOnce(
      anthropicProvider(port),
      [{ role: "user", content: "列目录" }],
      [],
      "auto",
      undefined,
      minimalDeps(),
    );
    close();

    expect(result).not.toBeNull();
    expect(result!.message.content).toBe("让我执行：");
    expect(result!.message.tool_calls).toHaveLength(1);
    expect(result!.message.tool_calls?.[0]).toMatchObject({
      id: "toolu_123",
      type: "function",
      function: { name: "shell_exec", arguments: JSON.stringify({ command: "ls" }) },
    });
    // usage：total = input + output；cache 字段透传（normalizeUsage 识别）
    expect(result!.tokensUsed).toBe(42);
    expect(result!.promptTokens).toBe(30);
    expect(result!.usageDetails).toMatchObject({
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
    });
  });

  it("流式响应：Anthropic SSE 事件解析（文本增量 + 工具调用分片 + usage）", async () => {
    const events = [
      { type: "message_start", message: { id: "msg_1", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_s1", name: "shell_exec", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command"' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ':"ls"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 25 } },
      { type: "message_stop" },
    ];
    const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    const { server, port, close } = captureServer((_req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.end(sse);
    });
    await new Promise<void>((r) => server.on("listening", r));

    const onProgress = vi.fn();
    const result = await callLLMOnce(
      anthropicProvider(port),
      [{ role: "user", content: "hello" }],
      [],
      "auto",
      onProgress,
      minimalDeps(),
    );
    close();

    expect(result).not.toBeNull();
    // 文本增量拼接
    expect(result!.message.content).toBe("Hello world");
    // 工具调用：id/name 来自 content_block_start，参数由 input_json_delta 累积
    expect(result!.message.tool_calls).toHaveLength(1);
    expect(result!.message.tool_calls?.[0]).toMatchObject({
      id: "toolu_s1",
      type: "function",
      function: { name: "shell_exec", arguments: '{"command":"ls"}' },
    });
    // usage：message_start 的 input + message_delta 的累计 output
    expect(result!.promptTokens).toBe(100);
    expect(result!.tokensUsed).toBe(125);
    expect(result!.usageDetails).toMatchObject({
      input_tokens: 100,
      output_tokens: 25,
      cache_read_input_tokens: 80,
    });
    // token 事件下发（流式可见性）
    const tokenEvents = onProgress.mock.calls.filter((c) => (c[0] as { type?: string }).type === "token");
    expect(tokenEvents.length).toBeGreaterThan(0);
  });

  it("工具往返：tool_use → tool_result → 最终文本（第二次请求体校验）", async () => {
    let call = 0;
    const { server, captured, port, close } = captureServer((_req, res) => {
      call++;
      if (call === 1) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          content: [{ type: "tool_use", id: "toolu_rt", name: "echo_tool", input: { msg: "hi" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        }));
      } else {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 3 },
        }));
      }
    });
    await new Promise<void>((r) => server.on("listening", r));

    const dep = minimalDeps({
      conversationHistory: new Map(),
      pendingOperations: new Map(),
      toolResultCache: new Map(),
      registeredTools: new Map([
        ["echo_tool", {
          definition: { name: "echo_tool", description: "echo back", parameters: {} },
          handler: async () => "echo-result",
        }],
      ]),
      buildSkillsPromptForRun: async () => "",
      getEventLedger: () => null,
      config: { maxTokens: 4096 } as LLMCallerDeps["config"],
      persona: { name: "t", style: "s", formatConstraints: "" } as LLMCallerDeps["persona"],
      maxHistoryLength: 200,
      sessionDataDir: "/tmp",
    });

    const res = await tryCallLLM(dep, {
      message: "echo hi",
      systemPrompt: "SYS",
      installedSkills: [],
      providers: [anthropicProvider(port)],
      startTime: Date.now(),
      sessionId: `anthropic-rt-${RUN_TAG}`,
      pendingPermissions: [],
    });
    close();

    expect(res).not.toBeNull();
    expect(res!.reply).toBe("done");
    expect(res!.toolsExecuted).toBe(true);
    expect(captured).toHaveLength(2);

    // 第二次请求体：assistant 消息含 tool_use block；user 消息含 tool_result block
    const msgs = captured[1].body.messages as Array<Record<string, unknown>>;
    const assistantWithToolUse = msgs.find((m) =>
      m.role === "assistant" &&
      Array.isArray(m.content) &&
      (m.content as Array<Record<string, unknown>>).some((b) => b.type === "tool_use"),
    );
    expect(assistantWithToolUse).toBeDefined();
    expect((assistantWithToolUse!.content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "tool_use",
      id: "toolu_rt",
      name: "echo_tool",
      input: { msg: "hi" },
    });
    const toolResultMsg = msgs.find((m) =>
      m.role === "user" &&
      Array.isArray(m.content) &&
      (m.content as Array<Record<string, unknown>>).some((b) => b.type === "tool_result"),
    );
    expect(toolResultMsg).toBeDefined();
    expect((toolResultMsg!.content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_rt",
      content: "echo-result",
    });
  });

  it("OpenAI 兼容路径不受 Anthropic 分支影响（回归）", async () => {
    const { server, captured, port, close } = captureServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "openai-ok" }, finish_reason: "stop" }],
        usage: { total_tokens: 7, prompt_tokens: 5 },
      }));
    });
    await new Promise<void>((r) => server.on("listening", r));

    const result = await callLLMOnce(
      { ...anthropicProvider(port), provider: "openai", name: "openai-test", baseURL: `http://127.0.0.1:${port}/v1` } as unknown as LLMCallerDeps["providers"][number],
      [{ role: "user", content: "q" }],
      [],
      "auto",
      undefined,
      minimalDeps(),
    );
    close();

    expect(result!.message.content).toBe("openai-ok");
    expect(captured[0].url).toBe("/v1/chat/completions");
    expect(captured[0].headers.authorization).toBe("Bearer sk-ant-test");
  });
});

// ═══════════════════════════════════════════════════════════
// P0-5 缓存稳定性回归：tc="none"（nudge 收尾）时 tools 段必须保持稳定
//
// 背景：曾用「tc="none" 时传空 tools 数组」强制禁用工具调用——理由是部分
// OpenAI 兼容网关在不设 tool_choice 时按规范回退默认 "auto"，模型照常输出
// tool_calls（agnes-3.0-flash 实测）。但 tools 是请求体的固定段，逐轮在
// 「有/无」之间翻转会让前缀缓存在 tools 段处分叉；而 nudge 在 2 次成功
// 工具调用后即触发，等于**每个编码轮都翻转一次**，缓存命中率在收尾阶段
// 骤降（这正是「命中率上不去」的主因之一）。
//
// 修复：tools 始终下发 + 显式 tool_choice:"none"（网关真正收到禁用指令，
// 请求体字节稳定）；个别网关若仍无视 tool_choice，由 toolCallsNoneRefusals
// 兜底拒绝执行——语义与「置空 tools」等价，但不再击穿缓存。
// ═══════════════════════════════════════════════════════════
describe("llm-caller > tc=none 时 tools 段保持稳定（P0-5 缓存回归）", () => {
  function captureServer(
    responder: (req: http.IncomingMessage, res: http.ServerResponse, raw: string) => void,
  ): { server: http.Server; captured: Array<Record<string, unknown>>; port: number; close: () => void } {
    const captured: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        captured.push(JSON.parse(raw || "{}"));
        responder(req, res, raw);
      });
    });
    server.listen(0);
    const port = (server.address() as { port: number }).port;
    return { server, captured, port, close: () => server.close() };
  }

  function openAIProvider(port: number) {
    return {
      name: "local", provider: "openai", model: "m",
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: "sk-test",
      enabled: true, order: 0, timeout: 5000, maxTokens: 4096, temperature: 0.3,
    } as unknown as LLMCallerDeps["providers"][number];
  }

  function minimalDeps(overrides: Partial<LLMCallerDeps> = {}): LLMCallerDeps {
    return {
      config: { maxTokens: 4096 } as LLMCallerDeps["config"],
      providers: [],
      persona: { name: "t", style: "s", formatConstraints: "" } as LLMCallerDeps["persona"],
      registeredTools: new Map(),
      conversationHistory: new Map(),
      maxHistoryLength: 200,
      providerStats: new Map(),
      pluginManager: null,
      registry: { resolveService: () => null } as unknown as LLMCallerDeps["registry"],
      sessionManager: null,
      pendingOperations: new Map(),
      toolResultCache: new Map(),
      sessionDataDir: "/tmp",
      sessionPersistenceEnabled: false,
      autoCompactionEnabled: false,
      compactionTokenThreshold: 0,
      compactionManager: null,
      lifecycleManager: null,
      memoryHub: null,
      recordProviderSuccess: () => {},
      recordProviderFailure: () => {},
      getEventLedger: () => null,
      ...overrides,
    } as unknown as LLMCallerDeps;
  }

  const TOOLS = [
    { type: "function", function: { name: "shell_exec", description: "run a command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } } },
    { type: "function", function: { name: "file_read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  ];

  const okReply = (content: string) => JSON.stringify({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { total_tokens: 10, prompt_tokens: 8 },
  });

  const toolCallReply = (id: string, name: string, args: Record<string, unknown>) => JSON.stringify({
    choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
    usage: { total_tokens: 10, prompt_tokens: 8 },
  });

  it("callLLMOnce：toolChoice='none' 时仍下发完整 tools 数组 + 显式 tool_choice='none'", async () => {
    const { server, captured, port, close } = captureServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(okReply("done"));
    });
    await new Promise<void>((r) => server.on("listening", r));

    const result = await callLLMOnce(openAIProvider(port), [{ role: "user", content: "q" }], TOOLS, "none", undefined, minimalDeps());
    close();

    expect(result).not.toBeNull();
    const body = captured[0];
    // 回归核心：tools 段不得因 toolChoice="none" 被摘掉（摘掉 = 逐轮翻转击穿缓存）
    expect(body.tools).toEqual(TOOLS);
    // 且必须显式下发 "none"——不设时网关按规范回退 "auto"，模型继续调工具
    expect(body.tool_choice).toBe("none");
  });

  it("callLLMOnce：toolChoice='auto' 时行为不变（tools + tool_choice:'auto'）", async () => {
    const { server, captured, port, close } = captureServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(okReply("done"));
    });
    await new Promise<void>((r) => server.on("listening", r));

    const result = await callLLMOnce(openAIProvider(port), [{ role: "user", content: "q" }], TOOLS, "auto", undefined, minimalDeps());
    close();

    expect(result).not.toBeNull();
    expect(captured[0].tools).toEqual(TOOLS);
    expect(captured[0].tool_choice).toBe("auto");
  });

  it("tryCallLLM：网关无视 tool_choice=none 时拒绝执行工具并回灌拒绝结果", async () => {
    // 轮次剧本：
    //   round0/round1 → 返回工具调用（成功执行 → successfulToolCalls=2）
    //   round2         → tc 变 "none"，网关**无视**该指令仍返回 tool_calls → 必须被拒绝
    //   round3         → 返回文本收尾
    // 注意：每轮工具参数必须互不相同——工具结果缓存以 args 为键，参数相同会
    //   命中缓存而跳过 handler（本回归曾因此误判为「工具未执行」）。
    let call = 0;
    const handler = vi.fn(async () => ({ ok: true }));
    const { server, captured, port, close } = captureServer((_req, res) => {
      call++;
      res.setHeader("Content-Type", "application/json");
      if (call === 1) {
        res.end(toolCallReply("tc-1", "my_test_tool", { cmd: "echo first" }));
      } else if (call === 2) {
        res.end(toolCallReply("tc-2", "my_test_tool", { cmd: "echo second" }));
      } else if (call === 3) {
        res.end(toolCallReply("tc-3", "my_test_tool", { cmd: "echo should-not-run" }));
      } else {
        res.end(okReply("FINAL"));
      }
    });
    await new Promise<void>((r) => server.on("listening", r));

    // 自定义工具名不在任何 TOOL_GROUP 内 → buildOpenAITools 无条件下发
    const registeredTools = new Map([
      ["my_test_tool", {
        definition: { name: "my_test_tool", description: "test tool", parameters: { cmd: { type: "string", description: "command to run" } } },
        handler,
      }],
    ]);
    const dep = minimalDeps({ registeredTools });
    const res = await tryCallLLM(dep, {
      message: "跑个命令",
      systemPrompt: "SYS",
      installedSkills: [],
      providers: [openAIProvider(port)],
      startTime: Date.now(),
      sessionId: `p0-5-tc-none-${RUN_TAG}`,
      pendingPermissions: [],
    });
    close();

    // 前两轮工具调用被真正执行（handler 收到的是带 _signal 的 args，只断言 cmd）
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls.map((c) => (c[0] as { cmd?: string }).cmd)).toEqual(["echo first", "echo second"]);

    // tc 序列：前两轮 auto，第三轮起 nudge 生效
    expect(captured.map((b) => b.tool_choice)).toEqual(["auto", "auto", "none", "none"]);

    // tc="none" 的轮次：tools 段仍必须下发（缓存稳定性核心断言）
    expect(Array.isArray(captured[2].tools)).toBe(true);
    expect((captured[2].tools as unknown[]).length).toBeGreaterThan(0);
    expect(captured[2].tool_choice).toBe("none");

    // 被拒绝的那次调用不得触达 handler，且拒绝结果已回灌给模型
    // （tool 角色 + 拒绝说明），保证下一轮请求格式合法（无人应答的 tool_calls 会被网关 400）
    const lastMsgs = captured[3].messages as Array<{ role: string; content: unknown }>;
    const refusal = lastMsgs.filter((m) => m.role === "tool").pop();
    expect(refusal).toBeDefined();
    expect(String(refusal!.content)).toContain("tool_choice=none");
    expect(String(refusal!.content)).toContain("已拒绝执行");

    expect(res?.reply).toBe("FINAL");
  });
});

describe("P0-5 buildOpenAITools — 领域工具分组瘦身 + 输出分档（缓存前缀稳定）", () => {
  const mk = (names: string[]) =>
    new Map(names.map((n) => [n, { definition: { name: n, description: `desc of ${n}`, parameters: {} }, handler: async () => ({}) }]));

  // 取真实注册集的一批：core + 刻意常驻的编码基座 + 各分组代表（含创建类）
  const REG = mk([
    // core
    "web_search", "web_fetch", "file_read", "file_create", "file_modify",
    "file_list", "file_delete", "shell_exec", "sequential_thinking",
    // ★ 刻意保留常驻的 12 个编码基座工具
    "apply_patch", "apply_rename", "batch_execute", "code_search", "codebase_search",
    "find_references", "execute_code", "lint", "run_tests", "verify_project",
    "todo_list", "plan_rename",
    // browser / email
    "browser_navigate", "browser_check", "browser_wait",
    "email_send", "email_add_account", "email_list_inbox", "email_list_accounts",
    // P0-5 收进分组的领域工具
    "git_status", "git_diff", "git_commit",
    "kanban_list_tasks", "kanban_add_task", "kanban_create_board",
    "vision_analyze", "vision_find_elements",
    "computer_mouse_click", "computer_key_press",
    "checkpoint_save", "checkpoint_restore",
    "workflow_execute", "grounded_research", "dlq_retry_batch",
    "music_search", "memory_stats", "skill_create", "skill_uninstall",
  ]);
  const evalFn = (fn: () => boolean) => fn();

  const run = (msg: string | undefined, base?: Set<string> | null) => {
    const out: { activeTools?: Set<string> } = {};
    const names = buildOpenAITools(REG, msg, evalFn, base, out).map((t) => t.function.name as string);
    return { names, active: out.activeTools };
  };

  /** 常驻编码基座：任何措辞（哪怕完全无关）都必须在手 */
  const ALWAYS_ON = [
    "apply_patch", "apply_rename", "batch_execute", "code_search", "codebase_search",
    "find_references", "execute_code", "lint", "run_tests", "verify_project",
    "todo_list", "plan_rename",
  ];
  /** 领域工具：关键词不命中时必须被裁掉（这正是本次瘦身的目标） */
  const DOMAIN_GATED = [
    "email_list_inbox", "email_list_accounts",
    "git_status", "git_diff", "git_commit",
    "kanban_list_tasks", "vision_analyze", "vision_find_elements",
    "computer_mouse_click", "computer_key_press",
    "checkpoint_save", "checkpoint_restore",
    "workflow_execute", "grounded_research", "dlq_retry_batch",
    "music_search", "memory_stats", "skill_uninstall",
  ];

  it("无关消息：常驻编码基座全在，领域工具全裁", () => {
    const { names } = run("今天天气怎么样");
    for (const n of ALWAYS_ON) expect(names).toContain(n);
    for (const n of DOMAIN_GATED) expect(names).not.toContain(n);
  });

  it("创建类工具（白名单）即使所属组未激活也恒定下发", () => {
    const { names } = run("今天天气怎么样");
    expect(names).toContain("kanban_create_board");
    expect(names).toContain("kanban_add_task");
    expect(names).toContain("email_add_account");
    expect(names).toContain("skill_create");
  });

  it("关键词命中即下发对应组的全部工具", () => {
    const git = run("帮我看看这个仓库的改动并提交").names;
    expect(git).toContain("git_status");
    expect(git).toContain("git_diff");
    expect(git).toContain("git_commit");

    const mail = run("帮我收一下邮件").names;
    expect(mail).toContain("email_list_inbox");
    expect(mail).toContain("email_list_accounts");
    expect(mail).toContain("email_send");

    const shot = run("帮我分析这张截图").names;
    expect(shot).toContain("vision_analyze");
    expect(shot).toContain("vision_find_elements");

    const web = run("打开网页看看").names;
    expect(web).toContain("browser_navigate");
    expect(web).toContain("browser_check");
    expect(web).toContain("browser_wait");
  });

  it("新激活的组排在数组末尾 → 前缀只增不改（缓存不失配）", () => {
    const r1 = run("帮我看看这个仓库的改动");
    expect(r1.names).toContain("git_status");

    // turn2 激活 email 组：git 工具位置必须原封不动，email 工具只能追加在末尾
    const r2 = run("顺便帮我收下邮件", r1.active!);
    expect(r2.names).toContain("email_list_inbox");
    expect(r2.names.slice(0, r1.names.length)).toEqual(r1.names);
    expect(r2.names.indexOf("email_list_inbox")).toBeGreaterThan(r2.names.indexOf("git_status"));
  });

  it("同轮激活多个组：按组声明序排列，稳态后字节恒定", () => {
    const r1 = run("帮我看看这个仓库的改动");
    const r2 = run("顺便帮我分析这张截图并收下邮件", r1.active!);
    expect(r2.names).toContain("vision_analyze");
    expect(r2.names).toContain("email_list_inbox");
    // 声明序：email 在 vision 之前
    expect(r2.names.indexOf("email_list_inbox")).toBeLessThan(r2.names.indexOf("vision_analyze"));
    // 但 git 组声明在 email/vision **之后**、却**先**被激活 → 必须仍排在它们前面：
    // 组位次按「首次激活序」（baseTools 插入序）而非「组声明序」。
    // 若按声明序排，git 会在下一轮「转为已激活」时插到中间 → 缓存全量失配。
    expect(r2.names.indexOf("git_status")).toBeLessThan(r2.names.indexOf("email_list_inbox"));
    expect(r2.names.indexOf("git_status")).toBeLessThan(r2.names.indexOf("vision_analyze"));

    const r3 = run("再随便说点什么", r2.active!);
    expect(r3.names).toEqual(r2.names);
  });

  it("message === undefined（/health 计数路径）仍全量下发", () => {
    const { names } = run(undefined);
    for (const n of DOMAIN_GATED) expect(names).toContain(n);
    for (const n of ALWAYS_ON) expect(names).toContain(n);
  });
});

describe("llm-caller > prompt cache 命中率指标（P0-5：网关未上报缓存字段时不得记 0%）", () => {
  function captureServer(
    responder: (req: http.IncomingMessage, res: http.ServerResponse, raw: string) => void,
  ): { server: http.Server; captured: Array<Record<string, unknown>>; port: number; close: () => void } {
    const captured: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        captured.push(JSON.parse(raw || "{}"));
        responder(req, res, raw);
      });
    });
    server.listen(0);
    const port = (server.address() as { port: number }).port;
    return { server, captured, port, close: () => server.close() };
  }

  const openAIProvider = (port: number) =>
    ({
      name: "local", provider: "openai", model: "m",
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: "sk-test", enabled: true, order: 0, timeout: 5000,
      maxTokens: 4096, temperature: 0.3,
    }) as unknown as LLMCallerDeps["providers"][number];

  const replyWithUsage = (usage: Record<string, unknown>) => JSON.stringify({
    choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
    usage,
  });

  /** 记录 recordLLMCacheHit 调用的假 observability 服务 */
  const fakeObservability = () => {
    const calls: Array<{ provider: string; model: string; hit: number; miss: number }> = [];
    return {
      calls,
      service: {
        recordLLMCacheHit: (provider: string, model: string, hit: number, miss: number) => {
          calls.push({ provider, model, hit, miss });
        },
      },
    };
  };

  async function runOnce(port: number, obs: ReturnType<typeof fakeObservability>) {
    const dep: LLMCallerDeps = {
      config: { maxTokens: 4096 } as LLMCallerDeps["config"],
      providers: [openAIProvider(port)],
      persona: { name: "t", style: "s", formatConstraints: "" } as LLMCallerDeps["persona"],
      registeredTools: new Map(),
      conversationHistory: new Map(),
      maxHistoryLength: 200,
      providerStats: new Map(),
      pluginManager: null,
      registry: {
        resolveService: (name: string) => (name === "observability" ? obs.service : null),
      } as unknown as LLMCallerDeps["registry"],
      sessionManager: null,
      pendingOperations: new Map(),
      toolResultCache: new Map(),
      sessionDataDir: "/tmp",
      sessionPersistenceEnabled: false,
      autoCompactionEnabled: false,
      compactionTokenThreshold: 0,
      compactionManager: null,
      lifecycleManager: null,
      memoryHub: null,
      recordProviderSuccess: () => {},
      recordProviderFailure: () => {},
      getEventLedger: () => null,
    } as unknown as LLMCallerDeps;

    return tryCallLLM(dep, {
      message: "q",
      systemPrompt: "SYS",
      installedSkills: [],
      providers: [openAIProvider(port)],
      startTime: Date.now(),
      sessionId: `cache-metric-${RUN_TAG}`,
      pendingPermissions: [],
    });
  }

  it("网关回传 prompt_tokens_details.cached_tokens → 指标按真值发射", async () => {
    const { server, port, close } = captureServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(replyWithUsage({ total_tokens: 8, prompt_tokens: 8, prompt_tokens_details: { cached_tokens: 6 } }));
    });
    await new Promise<void>((r) => server.on("listening", r));

    const obs = fakeObservability();
    await runOnce(port, obs);
    close();

    expect(obs.calls).toHaveLength(1);
    expect(obs.calls[0]).toMatchObject({ hit: 6, miss: 2 });
  });

  it("网关完全不回传缓存字段 → 不发指标（不得把「未上报」记成「0 命中」）", async () => {
    const { server, port, close } = captureServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      // 典型「不上报缓存」的 OpenAI 兼容 usage：只有 token 总数
      res.end(replyWithUsage({ total_tokens: 8, prompt_tokens: 8, completion_tokens: 0 }));
    });
    await new Promise<void>((r) => server.on("listening", r));

    const obs = fakeObservability();
    await runOnce(port, obs);
    close();

    expect(obs.calls).toHaveLength(0);
  });

  it("网关回传 cached_tokens:0（会话首轮冷启动）→ 必须按 0 命中计入分母", async () => {
    // 旧实现用 `canon.cacheReadTokens || undefined` 把真实的 0 塌成 undefined →
    // 指标不发 → 命中率分母只含命中轮次 → 命中率虚高到接近 100%。
    // 真实数据佐证：data/token-usage/records.json 4273 条里从未出现显式 0。
    const { server, port, close } = captureServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(replyWithUsage({ total_tokens: 8, prompt_tokens: 8, prompt_tokens_details: { cached_tokens: 0 } }));
    });
    await new Promise<void>((r) => server.on("listening", r));

    const obs = fakeObservability();
    await runOnce(port, obs);
    close();

    expect(obs.calls).toHaveLength(1);
    expect(obs.calls[0]).toMatchObject({ hit: 0, miss: 8 });
  });
});
