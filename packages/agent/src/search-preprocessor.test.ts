import { describe, it, expect, vi } from "vitest";
import { preprocessSearch } from "./search-preprocessor";
import type { ToolDefinition } from "./types";

// ═══════════════════════════════════════════════════════════
// 测试套件：SearchPreprocessor 天文/时刻查询
// 覆盖：日出日落等天文时刻查询应走本地 Open-Meteo 计算快速通道，
//       不再由搜索预处理触发网页搜索。
//
// ★ 复合工具改造：页面抓取工具由 fetch_node_page 合并进 web_fetch
//   （action=fetch / stealth / json）。预处理器按 `registeredTools.has("web_fetch")`
//   探测抓取能力，因此本文件的桩工具名必须同步改名，否则预抓取分支根本不会触发。
// ═══════════════════════════════════════════════════════════

function makeRegistry(taskClassifier?: {
  classify(task: string): { primaryCategory: string; confidence: number; intentSimilarity?: Record<string, number> };
  needsWebSearch(task: string): { needed: boolean; confidence: number; reason: string };
}) {
  return {
    resolveService: <T>(name: string): T | undefined => {
      if (name === "taskClassifier") return taskClassifier as unknown as T;
      return undefined;
    },
  } as any;
}

function makeTools() {
  const results = [
    { title: "信阳平桥区日出日落时间", url: "https://example.com/sun", snippet: "日出 05:20，日落 19:35" },
  ];
  return new Map([
    [
      "web_search",
      {
        definition: { name: "web_search", description: "搜索网页", parameters: { type: "object", properties: {} } } as ToolDefinition,
        handler: vi.fn(async () => ({ results })),
      },
    ],
    [
      "web_fetch",
      {
        definition: { name: "web_fetch", description: "抓取网页", parameters: { type: "object", properties: {} } } as ToolDefinition,
        handler: vi.fn(async () => ({ content: "日出 05:20，日落 19:35" })),
      },
    ],
  ]);
}

describe("search-preprocessor > 工程任务误触发检索（v25 Task 2/6/7 回归）", () => {
  const noSearch = {
    classify: () => ({ primaryCategory: "unknown", confidence: 0 }),
    needsWebSearch: () => ({ needed: false, confidence: 0, reason: "" }),
  };

  it("本地工程交付任务（零依赖/冻结夹具）即使分类器要求联网也跳过", async () => {
    const registry = makeRegistry({
      classify: () => ({ primaryCategory: "coding", confidence: 0.9 }),
      needsWebSearch: () => ({ needed: true, confidence: 0.95, reason: "宽松判定" }),
    });
    const tools = makeTools();
    const { shouldSearch, newsContext } = await preprocessSearch(
      { registry, registeredTools: tools },
      "在 /home/chy/EvoClaw/data/workspace/v25-t2/ 交付零依赖 Python 电子表格公式引擎（仅标准库）。冻结夹具 sheet.json，禁止修改夹具。条件支持数值比较。",
    );
    expect(shouldSearch).toBe(false);
    expect(newsContext).toBe("");
    expect(tools.get("web_search")!.handler).not.toHaveBeenCalled();
  });

  it("正文出现「分析」「比较」不再单独触发检索", async () => {
    const tools = makeTools();
    for (const msg of [
      "容器镜像层去重分析 + 拉取计划工具（Node，零依赖）",
      "对比两个 JSON 文件并输出差异摘要，比较各字段",
      "分析这段代码并做性能优化",
    ]) {
      const { shouldSearch } = await preprocessSearch(
        { registry: makeRegistry(noSearch), registeredTools: tools },
        msg,
      );
      expect(shouldSearch, msg).toBe(false);
    }
    expect(tools.get("web_search")!.handler).not.toHaveBeenCalled();
  });

  it("真实资讯检索仍触发：主题 + 时效请求", async () => {
    for (const msg of ["帮我搜索本周 AI 新闻并整理", "整理最近的热点新闻", "查一下今天科技资讯"]) {
      const tools = makeTools();
      const { shouldSearch } = await preprocessSearch(
        { registry: makeRegistry(noSearch), registeredTools: tools },
        msg,
      );
      expect(shouldSearch, msg).toBe(true);
      expect(tools.get("web_search")!.handler).toHaveBeenCalled();
    }
  });

  it("工程任务里显式写「搜索/最新/调研」仍放行检索", async () => {
    const tools = makeTools();
    const { shouldSearch } = await preprocessSearch(
      { registry: makeRegistry(noSearch), registeredTools: tools },
      "调研最新的零依赖 Python 表格库并推荐",
    );
    expect(shouldSearch).toBe(true);
  });
});

describe("search-preprocessor > astronomy queries", () => {
  // TC-001: 日出日落查询不再触发搜索预处理（改走本地 Open-Meteo 快速通道）
  it("TC-001: 信阳市平桥区日出日落查询不应触发搜索预处理", async () => {
    const registry = makeRegistry({
      classify: () => ({ primaryCategory: "unknown", confidence: 0 }),
      needsWebSearch: () => ({ needed: false, confidence: 0, reason: "" }),
    });
    const tools = makeTools();

    const { shouldSearch, searchReason, newsContext } = await preprocessSearch(
      { registry, registeredTools: tools },
      "告诉我信阳市平桥区明天的日出时间和日落时间",
    );

    expect(shouldSearch).toBe(false);
    expect(searchReason).not.toContain("天文");
    expect(newsContext).toBe("");
    expect(tools.get("web_search")!.handler).not.toHaveBeenCalled();
  });

  // TC-002: 普通问候不触发搜索
  it("TC-002: 普通问候不应触发搜索", async () => {
    const registry = makeRegistry({
      classify: () => ({ primaryCategory: "greeting", confidence: 0.9 }),
      needsWebSearch: () => ({ needed: false, confidence: 0, reason: "" }),
    });
    const tools = makeTools();

    const { shouldSearch, newsContext } = await preprocessSearch(
      { registry, registeredTools: tools },
      "你好",
    );

    expect(shouldSearch).toBe(false);
    expect(newsContext).toBe("");
    expect(tools.get("web_search")!.handler).not.toHaveBeenCalled();
  });

  // TC-003: 英文 sunrise/sunset 不再触发搜索预处理（改走本地 Open-Meteo 快速通道）
  it("TC-003: 英文 sunrise/sunset 查询不应触发搜索预处理", async () => {
    const registry = makeRegistry({
      classify: () => ({ primaryCategory: "unknown", confidence: 0 }),
      needsWebSearch: () => ({ needed: false, confidence: 0, reason: "" }),
    });
    const tools = makeTools();

    const { shouldSearch, searchReason, newsContext } = await preprocessSearch(
      { registry, registeredTools: tools },
      "What is the sunrise and sunset time in Xinyang Pingqiao tomorrow?",
    );

    expect(shouldSearch).toBe(false);
    expect(searchReason).not.toContain("天文");
    expect(newsContext).toBe("");
    expect(tools.get("web_search")!.handler).not.toHaveBeenCalled();
  });

  // TC-004: 真正触发搜索时，页面预抓取必须走合并后的 web_fetch（action=fetch）
  it("TC-004: 搜索后的页面预抓取应调用 web_fetch 的 fetch action", async () => {
    const registry = makeRegistry({
      classify: () => ({ primaryCategory: "unknown", confidence: 0 }),
      needsWebSearch: () => ({ needed: true, confidence: 0.9, reason: "测试触发" }),
    });
    const tools = makeTools();

    await preprocessSearch(
      { registry, registeredTools: tools },
      "帮我查一下 EvoClaw 的最新动态",
    );

    // 旧名字 fetch_node_page 已不存在——若预处理器仍按旧名探测，这里会直接失败
    expect(tools.has("fetch_node_page")).toBe(false);
    const fetchTool = tools.get("web_fetch")!;
    expect(fetchTool.handler).toHaveBeenCalled();
    const call = (fetchTool.handler as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(call.action).toBe("fetch");
    expect(call.url).toBe("https://example.com/sun");
  });

  // TC-005: 未注册 web_fetch 时预抓取优雅跳过（不抛异常、不影响搜索结果）
  it("TC-005: 未注册 web_fetch 时跳过页面预抓取", async () => {
    const registry = makeRegistry({
      classify: () => ({ primaryCategory: "unknown", confidence: 0 }),
      needsWebSearch: () => ({ needed: true, confidence: 0.9, reason: "测试触发" }),
    });
    const tools = makeTools();
    tools.delete("web_fetch");

    const { shouldSearch, newsContext } = await preprocessSearch(
      { registry, registeredTools: tools },
      "帮我查一下 EvoClaw 的最新动态",
    );

    expect(shouldSearch).toBe(true);
    expect(newsContext).toContain("信阳平桥区日出日落时间");
  });
});
