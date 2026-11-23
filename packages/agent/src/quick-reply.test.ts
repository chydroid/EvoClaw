import { describe, it, expect, vi, beforeEach } from "vitest";
import { tryAstronomyReply, hasActionIntent } from "./quick-reply";

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
