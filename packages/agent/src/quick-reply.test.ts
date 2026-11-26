import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  tryAstronomyReply,
  hasActionIntent,
  hasExplicitDirective,
  isQuickReplyEligible,
  tryQuickReply,
  tryQuickReplyExtended,
} from "./quick-reply";

// ═══════════════════════════════════════════════════════════
// 测试套件：天文时刻本地计算快速通道（tryAstronomyReply）
// 覆盖：日出日落查询通过 Open-Meteo API 本地计算，不依赖 LLM/搜索
// ═══════════════════════════════════════════════════════════

// 使用 vi.hoisted 确保 mockResponses 在 vi.mock 工厂执行时已初始化
const { mockResponses } = vi.hoisted(() => ({
  mockResponses: {} as Record<string, unknown>,
}));

vi.mock("https", () => ({
  get: vi.fn((url: string, callback: (res: unknown) => void) => {
    const response = mockResponses[url];
    const res = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === "data") {
          if (response !== undefined) {
            handler(Buffer.from(JSON.stringify(response)));
          }
        } else if (event === "end") {
          handler();
        }
        return res;
      }),
    };
    callback(res);
    return { on: vi.fn() };
  }),
}));

function buildGeoUrl(location: string) {
  return `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=zh&format=json`;
}

function buildForecastUrl(lat: number, lon: number, date: string) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=sunrise,sunset&timezone=auto&start_date=${date}&end_date=${date}`;
}

/**
 * 格式化日期为 YYYY-MM-DD（使用本地时区，与 quick-reply.ts 的 formatAstronomyDate 一致）。
 * 之前使用 toISOString().slice(0,10) 会导致 UTC 与本地时区日期不一致，
 * 在跨时区运行测试时 forecast URL 不匹配。
 */
function formatLocalDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

beforeEach(() => {
  Object.keys(mockResponses).forEach((k) => delete mockResponses[k]);
});

describe("quick-reply > tryAstronomyReply", () => {
  it("中文日出日落查询应返回格式化的日出日落时间", async () => {
    const geoUrl = buildGeoUrl("信阳市平桥区");
    mockResponses[geoUrl] = {
      results: [
        { name: "平桥", latitude: 32.43, longitude: 114.12, admin1: "河南省", country: "中国" },
      ],
    };

    const date = new Date();
    date.setDate(date.getDate() + 1);
    const dateStr = formatLocalDate(date);
    const forecastUrl = buildForecastUrl(32.43, 114.12, dateStr);
    mockResponses[forecastUrl] = {
      daily: {
        time: [dateStr],
        sunrise: [`${dateStr}T05:20:00`],
        sunset: [`${dateStr}T19:35:00`],
      },
    };

    const reply = await tryAstronomyReply("告诉我信阳市平桥区明天的日出时间和日落时间");

    expect(reply).toContain("平桥");
    expect(reply).toContain("日出：05:20");
    expect(reply).toContain("日落：19:35");
  });

  it("英文 sunrise/sunset 查询应返回格式化的日出日落时间", async () => {
    const geoUrl = buildGeoUrl("Xinyang Pingqiao");
    mockResponses[geoUrl] = {
      results: [
        { name: "Pingqiao", latitude: 32.43, longitude: 114.12, admin1: "Henan", country: "China" },
      ],
    };

    const date = new Date();
    date.setDate(date.getDate() + 1);
    const dateStr = formatLocalDate(date);
    const forecastUrl = buildForecastUrl(32.43, 114.12, dateStr);
    mockResponses[forecastUrl] = {
      daily: {
        time: [dateStr],
        sunrise: [`${dateStr}T05:20:00`],
        sunset: [`${dateStr}T19:35:00`],
      },
    };

    const reply = await tryAstronomyReply("What is the sunrise and sunset time in Xinyang Pingqiao tomorrow?");

    expect(reply).toContain("Pingqiao");
    expect(reply).toContain("日出：05:20");
    expect(reply).toContain("日落：19:35");
  });

  it("非天文查询应返回 null", async () => {
    const reply = await tryAstronomyReply("你好");
    expect(reply).toBeNull();
  });

  it("地理编码无结果时应返回 null 并优雅降级", async () => {
    const geoUrl = buildGeoUrl("不存在的地方");
    mockResponses[geoUrl] = { results: [] };

    const reply = await tryAstronomyReply("告诉我不存在的地方明天的日出日落时间");
    expect(reply).toBeNull();
  });

  it("API 异常时应返回 null 并优雅降级", async () => {
    const reply = await tryAstronomyReply("告诉我北京的日出日落时间");
    expect(reply).toBeNull();
  });
});

describe("quick-reply > hasExplicitDirective（用户显式输出指令不得被闲聊劫持）", () => {
  /**
   * 2026-11-26 实证事故：用户发「请只回复两个字：收到」，SemanticQuickReply
   * 余弦相似度判成 capability 闲聊（top1=0.7195 / top2=0.7106，差 0.009），
   * 回了"主人需要啥我就有啥用~ 写代码我能…"，用户的明确指令被静默丢弃。
   */
  it("事故原句必须识别为显式指令", () => {
    expect(hasExplicitDirective("请只回复两个字：收到")).toBe(true);
    expect(hasExplicitDirective("只回复两个字：收到")).toBe(true);
    expect(hasExplicitDirective("只输出 OK")).toBe(true);
  });

  it("常见输出约束均识别", () => {
    const directives = [
      "只回答是或否",
      "回复中只包含数字",
      "不要任何解释",
      "不要废话",
      "原样输出下面这段",
      "按格式返回",
      "必须按照模板填写",
      "以 JSON 格式返回结果",
      "用 json 格式输出",
      "Reply with only the word OK",
      "Answer only yes or no",
      "no explanation needed",
      "respond in 10 words",
    ];
    for (const d of directives) {
      expect(hasExplicitDirective(d), `未识别: ${d}`).toBe(true);
    }
  });

  it("普通闲聊不误判为指令", () => {
    const chats = ["你好", "在吗", "今天怎么样", "谢谢你", "晚安", "哈哈哈", "你在忙吗"];
    for (const c of chats) {
      expect(hasExplicitDirective(c), `误判: ${c}`).toBe(false);
    }
  });
});

describe("quick-reply > isQuickReplyEligible（拿不准一律交给 LLM）", () => {
  it("短闲聊放行", () => {
    expect(isQuickReplyEligible("你好")).toBe(true);
    expect(isQuickReplyEligible("在吗？")).toBe(true);
    expect(isQuickReplyEligible("收到")).toBe(true);
  });

  it("显式指令一律不放行（即使很短）", () => {
    expect(isQuickReplyEligible("只回复两个字：收到")).toBe(false);
    expect(isQuickReplyEligible("只输出OK")).toBe(false);
  });

  it("靠标点凑长的消息不放行（长度按原始消息计）", () => {
    // 归一化后只剩 21 个"啊"，旧实现按归一化长度判 → 可能误中 react 模板
    const padded = "啊，" + "啊，".repeat(19) + "啊";
    expect(isQuickReplyEligible(padded)).toBe(false);
  });

  it("超过 20 字的正常长消息不放行", () => {
    expect(isQuickReplyEligible("请帮我分析一下这个复杂问题到底出在哪里了呢")).toBe(false);
  });
});

describe("quick-reply > 事故回归：显式指令不得被模板回复", () => {
  const deps = {
    persona: { name: "EvoClaw", masterTerm: "主人", title: "助手" },
    registeredTools: new Map(),
    config: { model: "m", provider: "p" },
    providers: [],
    hasBeenGreeted: true,
    workspacePath: "/tmp",
  } as unknown as Parameters<typeof tryQuickReply>[0];

  it("「请只回复两个字：收到」不得命中任何快捷回复", () => {
    expect(tryQuickReply(deps, "请只回复两个字：收到")).toBeNull();
    expect(tryQuickReplyExtended(deps, "请只回复两个字：收到")).toBeNull();
  });

  it("真正的闲聊仍然命中（闸门不能把功能关死）", () => {
    expect(tryQuickReply(deps, "你好")).not.toBeNull();
    expect(tryQuickReply(deps, "在吗")).not.toBeNull();
  });
});

describe("quick-reply > hasActionIntent（问句词不当否决执行意图）", () => {
  it("短问句仍按提问处理", () => {
    expect(hasActionIntent("163 邮箱的 IMAP 服务器地址是什么？")).toBe(false);
    expect(hasActionIntent("如何创建一个文件夹？")).toBe(false);
    expect(hasActionIntent("请问什么是 RAG")).toBe(false);
  });

  it("长工程任务里出现从属问句词不应否决（v27 T8 回归）", () => {
    // 1300 字任务书，验收项写「folded_ast 是否含 var」——旧实现整条判 false，
    // 轮次上限 25→10。任务书含交付/运行意图时必须为 true。
    const task = [
      "你是编译器工程师。在 data/workspace/x/ 交付零依赖 Node 表达式编译器。",
      "必须交付：expr.js、expr.test.js、README.md、report.json。",
      "词法/语法：整数、标识符、函数调用、括号、一元运算、二元运算、三元。",
      "必须真实运行 CLI 并在回复中写明 value、folded_ast 是否含 var，以及 bad_expr 的退出码。",
    ].join("");
    expect(hasActionIntent(task)).toBe(true);
  });

  it("祈使句中的问句词按执行意图处理", () => {
    expect(hasActionIntent("请分析一下这段代码为什么这么慢")).toBe(true);
    expect(hasActionIntent("为什么任务失败了，帮我修复")).toBe(true);
    expect(hasActionIntent("帮我看看配置是否生效并修正")).toBe(true);
  });

  it("工程实现类动词可独立触发意图", () => {
    expect(hasActionIntent("实现一个 LSM 树")).toBe(true);
    expect(hasActionIntent("编写 README 并编译验证")).toBe(true);
    expect(hasActionIntent("交付 report.json")).toBe(true);
  });
});
